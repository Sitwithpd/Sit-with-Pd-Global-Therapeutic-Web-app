import { FxRate, Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import { BASE_CURRENCY } from '../../lib/money';
import {
  FX_DRIFT_THRESHOLD_BPS,
  FX_STALE_THRESHOLD_MS,
} from '../../config/money.config';
import { fetchRate } from './flutterwaveFx.provider';
import { listSupportedCurrencies } from './currency.service';

export interface RateIngestOutcome {
  quoteCurrency: string;
  status: 'written' | 'unchanged' | 'failed';
  rate?: string;
  driftBps?: number;
  error?: string;
}

export async function getCurrentRate(quoteCurrency: string): Promise<FxRate | null> {
  if (quoteCurrency === BASE_CURRENCY) return null;
  return prisma.fxRate.findFirst({
    where: { baseCurrency: BASE_CURRENCY, quoteCurrency, supersededAt: null },
    orderBy: { fetchedAt: 'desc' },
  });
}

export function isStale(rate: Pick<FxRate, 'fetchedAt'>, now = new Date()): boolean {
  return now.getTime() - rate.fetchedAt.getTime() > FX_STALE_THRESHOLD_MS;
}

export function driftBps(previous: Prisma.Decimal, next: number): number {
  const prev = previous.toNumber();
  if (prev === 0) return Number.POSITIVE_INFINITY;
  return Math.abs((next - prev) / prev) * 10_000;
}

/**
 * Supersede-and-insert; FxRate rows are referenced by payments so they are
 * never updated in place.
 */
export async function writeRate(input: {
  quoteCurrency: string;
  rate: number;
  source: string;
  probeAmount?: number;
  fetchedAt?: Date;
}): Promise<FxRate> {
  const fetchedAt = input.fetchedAt ?? new Date();
  return prisma.$transaction(async (tx) => {
    await tx.fxRate.updateMany({
      where: {
        baseCurrency: BASE_CURRENCY,
        quoteCurrency: input.quoteCurrency,
        supersededAt: null,
      },
      data: { supersededAt: fetchedAt },
    });
    return tx.fxRate.create({
      data: {
        baseCurrency: BASE_CURRENCY,
        quoteCurrency: input.quoteCurrency,
        rate: new Prisma.Decimal(input.rate.toFixed(8)),
        source: input.source,
        probeAmount:
          input.probeAmount !== undefined ? new Prisma.Decimal(input.probeAmount) : null,
        fetchedAt,
      },
    });
  });
}

/**
 * A failed lookup leaves the existing rate in place — the staleness guard
 * decides whether it is still usable, rather than a transient API error
 * blowing away a good rate.
 */
export async function ingestRates(): Promise<RateIngestOutcome[]> {
  const currencies = await listSupportedCurrencies();
  const quotes = currencies.filter((c) => c.isEnabled && c.code !== BASE_CURRENCY);

  const outcomes: RateIngestOutcome[] = [];

  for (const currency of quotes) {
    try {
      const fetched = await fetchRate(BASE_CURRENCY, currency.code);
      const current = await getCurrentRate(currency.code);

      if (current) {
        const drift = driftBps(current.rate, fetched.rate);
        if (drift < FX_DRIFT_THRESHOLD_BPS) {
          outcomes.push({
            quoteCurrency: currency.code,
            status: 'unchanged',
            rate: current.rate.toString(),
            driftBps: Math.round(drift),
          });
          continue;
        }
      }

      const written = await writeRate({
        quoteCurrency: currency.code,
        rate: fetched.rate,
        source: fetched.source,
        probeAmount: fetched.probeAmount,
      });
      outcomes.push({
        quoteCurrency: currency.code,
        status: 'written',
        rate: written.rate.toString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[fx] ${currency.code} ingest failed:`, message);
      outcomes.push({ quoteCurrency: currency.code, status: 'failed', error: message });
    }
  }

  return outcomes;
}

export async function listCurrentRates(): Promise<
  Array<{ quoteCurrency: string; rate: string; source: string; fetchedAt: Date; stale: boolean }>
> {
  const rows = await prisma.fxRate.findMany({
    where: { baseCurrency: BASE_CURRENCY, supersededAt: null },
    orderBy: { quoteCurrency: 'asc' },
  });
  return rows.map((r) => ({
    quoteCurrency: r.quoteCurrency,
    rate: r.rate.toString(),
    source: r.source,
    fetchedAt: r.fetchedAt,
    stale: isStale(r),
  }));
}
