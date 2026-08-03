import 'dotenv/config';
import { Prisma } from '@prisma/client';
import prisma from '../src/config/prisma';
import { BASE_CURRENCY, parseToMinor } from '../src/lib/money';
import { ingestRates, getCurrentRate, writeRate } from '../src/services/fx/fxRate.service';
import { invalidateCurrencyCache } from '../src/services/fx/currency.service';

const DRY_RUN = process.argv.includes('--dry-run');

const SEED_CURRENCIES = [
  { code: 'GBP', isBase: true, marginBps: 0 },
  { code: 'USD', isBase: false, marginBps: 200 },
  { code: 'EUR', isBase: false, marginBps: 200 },
  { code: 'NGN', isBase: false, marginBps: 300 },
];

/**
 * Manual fallback rates, used only when Flutterwave is unreachable so a schema
 * migration is never blocked on a third party. Override per currency with
 * FALLBACK_RATE_<CODE> (quote units per 1 GBP).
 */
const FALLBACK_RATES: Record<string, number> = {
  USD: 1.27,
  EUR: 1.17,
  NGN: 2000,
};

interface Row {
  id: string;
  price: number | null;
  currency: string | null;
}

const rateCache = new Map<string, number>();

async function rateFor(currency: string): Promise<number> {
  const code = currency.toUpperCase();
  if (code === BASE_CURRENCY) return 1;
  const cached = rateCache.get(code);
  if (cached !== undefined) return cached;

  const row = await getCurrentRate(code);
  if (!row) throw new Error(`No FX rate available for ${code}; cannot convert.`);
  const rate = row.rate.toNumber();
  if (!(rate > 0)) throw new Error(`Non-positive FX rate for ${code}.`);
  rateCache.set(code, rate);
  return rate;
}

/** price is denominated in `currency`; divide by quote-per-GBP to reach GBP. */
async function toBaseMinor(price: number, currency: string): Promise<bigint> {
  const rate = await rateFor(currency);
  const baseMajor = price / rate;
  return parseToMinor(baseMajor.toFixed(2), BASE_CURRENCY);
}

async function seedCurrencies(): Promise<void> {
  for (const c of SEED_CURRENCIES) {
    await prisma.supportedCurrency.upsert({
      where: { code: c.code },
      create: { code: c.code, isBase: c.isBase, isEnabled: true, marginBps: c.marginBps },
      update: {},
    });
  }
  invalidateCurrencyCache();
  console.log(`  seeded ${SEED_CURRENCIES.length} supported currencies`);
}

async function seedRates(): Promise<void> {
  let outcomes: Awaited<ReturnType<typeof ingestRates>> = [];
  try {
    outcomes = await ingestRates();
  } catch (err) {
    console.warn('  live rate ingest threw:', err instanceof Error ? err.message : err);
  }

  for (const outcome of outcomes) {
    console.log(`  ${outcome.quoteCurrency}: ${outcome.status}${outcome.error ? ` (${outcome.error})` : ''}`);
  }

  for (const c of SEED_CURRENCIES) {
    if (c.code === BASE_CURRENCY) continue;
    if (await getCurrentRate(c.code)) continue;

    const envOverride = Number(process.env[`FALLBACK_RATE_${c.code}`]);
    const rate = Number.isFinite(envOverride) && envOverride > 0 ? envOverride : FALLBACK_RATES[c.code];
    if (!rate) throw new Error(`No live or fallback rate for ${c.code}.`);

    await writeRate({ quoteCurrency: c.code, rate, source: 'manual' });
    console.log(`  ${c.code}: seeded fallback rate ${rate}`);
  }
}

async function backfillTable(
  table: string,
  rows: Row[],
  label: string
): Promise<{ converted: number; skipped: number }> {
  let converted = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.price === null || row.currency === null) {
      skipped += 1;
      continue;
    }
    const minor = await toBaseMinor(row.price, row.currency);
    console.log(
      `    ${label} ${row.id}: ${row.price} ${row.currency} -> ${minor} ${BASE_CURRENCY} minor`
    );
    if (!DRY_RUN) {
      await prisma.$executeRawUnsafe(
        `UPDATE "${table}" SET "priceMinor" = $1 WHERE id = $2`,
        minor,
        row.id
      );
    }
    converted += 1;
  }

  return { converted, skipped };
}

async function main(): Promise<void> {
  console.log(`Money backfill${DRY_RUN ? ' (dry run)' : ''}\n`);

  console.log('1. Supported currencies');
  if (!DRY_RUN) await seedCurrencies();

  console.log('2. FX rates');
  if (!DRY_RUN) await seedRates();

  console.log('3. Programs');
  const programs = await prisma.$queryRaw<Row[]>(
    Prisma.sql`SELECT id, price, currency::text AS currency FROM programs WHERE "priceMinor" IS NULL`
  );
  console.log(`  ${(await backfillTable('programs', programs, 'program')).converted} converted`);

  console.log('4. Consultation services');
  const services = await prisma.$queryRaw<Row[]>(
    Prisma.sql`SELECT id, price, currency::text AS currency FROM consultation_services WHERE "priceMinor" IS NULL`
  );
  console.log(
    `  ${(await backfillTable('consultation_services', services, 'service')).converted} converted`
  );

  // CampTier holds the price but the currency lives on the parent Camp, so this
  // must join rather than assume a per-row currency like the tables above.
  console.log('5. Camp tiers (currency joined from parent camp)');
  const tiers = await prisma.$queryRaw<Row[]>(
    Prisma.sql`
      SELECT t.id, t.price, c.currency::text AS currency
      FROM camp_tiers t
      JOIN camps c ON c.id = t."campId"
      WHERE t."priceMinor" IS NULL
    `
  );
  console.log(`  ${(await backfillTable('camp_tiers', tiers, 'tier')).converted} converted`);

  console.log('6. Payments');
  const payments = await prisma.$queryRaw<Array<Row & { amount: number }>>(
    Prisma.sql`
      SELECT id, amount, amount AS price, currency
      FROM payments
      WHERE "presentmentAmountMinor" IS NULL
    `
  );
  let paymentCount = 0;
  for (const payment of payments) {
    const currency = (payment.currency ?? BASE_CURRENCY).toUpperCase();
    const presentmentMinor = parseToMinor(payment.amount.toFixed(2), currency);
    const baseMinor = await toBaseMinor(payment.amount, currency);
    const rateRow = currency === BASE_CURRENCY ? null : await getCurrentRate(currency);

    if (!DRY_RUN) {
      await prisma.$executeRawUnsafe(
        `UPDATE payments SET
           "presentmentCurrency" = $1,
           "presentmentAmountMinor" = $2,
           "baseCurrency" = $3,
           "baseAmountMinor" = $4,
           "fxRateId" = $5,
           "fxRate" = $6,
           "marginBps" = 0,
           "quotedAt" = "createdAt"
         WHERE id = $7`,
        currency,
        presentmentMinor,
        BASE_CURRENCY,
        baseMinor,
        rateRow?.id ?? null,
        rateRow?.rate ?? null,
        payment.id
      );
    }
    paymentCount += 1;
  }
  console.log(`  ${paymentCount} converted (historical rows use today's rate — see README)`);

  console.log('\n7. Verification');
  const nulls = await prisma.$queryRaw<Array<{ table: string; missing: bigint }>>(
    Prisma.sql`
      SELECT 'programs' AS table, count(*) AS missing FROM programs WHERE "priceMinor" IS NULL
      UNION ALL SELECT 'consultation_services', count(*) FROM consultation_services WHERE "priceMinor" IS NULL
      UNION ALL SELECT 'camp_tiers', count(*) FROM camp_tiers WHERE "priceMinor" IS NULL
      UNION ALL SELECT 'payments', count(*) FROM payments WHERE "presentmentAmountMinor" IS NULL
    `
  );

  let clean = true;
  for (const row of nulls) {
    const missing = Number(row.missing);
    if (missing > 0) clean = false;
    console.log(`  ${row.table}: ${missing} unconverted`);
  }

  if (!clean && !DRY_RUN) {
    throw new Error('Backfill incomplete — do not run the contract migration.');
  }
  console.log(DRY_RUN ? '\nDry run complete; nothing written.' : '\nBackfill complete.');
}

main()
  .catch((err) => {
    console.error('\nBackfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
