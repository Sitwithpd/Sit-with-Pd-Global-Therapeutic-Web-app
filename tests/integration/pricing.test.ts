import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../../src/config/prisma';
import { BASE_CURRENCY } from '../../src/lib/money';
import { localizePrice, StaleRateError } from '../../src/services/pricing/price.service';
import { invalidateCurrencyCache } from '../../src/services/fx/currency.service';
import { writeRate } from '../../src/services/fx/fxRate.service';

const TEST_QUOTE = 'AUD';

beforeAll(async () => {
  await prisma.supportedCurrency.upsert({
    where: { code: BASE_CURRENCY },
    create: { code: BASE_CURRENCY, isBase: true, isEnabled: true, marginBps: 0 },
    update: {},
  });
  await prisma.supportedCurrency.upsert({
    where: { code: TEST_QUOTE },
    create: { code: TEST_QUOTE, isBase: false, isEnabled: true, marginBps: 0 },
    update: { isEnabled: true, marginBps: 0 },
  });
  invalidateCurrencyCache();
  await writeRate({ quoteCurrency: TEST_QUOTE, rate: 2, source: 'test' });
});

afterAll(async () => {
  await prisma.fxRate.deleteMany({ where: { quoteCurrency: TEST_QUOTE } });
  await prisma.supportedCurrency.deleteMany({ where: { code: TEST_QUOTE } });
  invalidateCurrencyCache();
  await prisma.$disconnect();
});

describe('localizePrice', () => {
  it('short-circuits the base currency without touching a rate', async () => {
    const result = await localizePrice(7900n, BASE_CURRENCY);
    expect(result.amountMinor).toBe(7900n);
    expect(result.currency).toBe(BASE_CURRENCY);
    expect(result.fxRateId).toBeNull();
    expect(result.amount).toBe(79);
  });

  it('converts, then rounds up', async () => {
    // 7900 * 2 = 15800 -> £158 band steps by 500 -> 16000, charm -> 15999.
    const result = await localizePrice(7900n, TEST_QUOTE);
    expect(result.currency).toBe(TEST_QUOTE);
    expect(result.baseAmountMinor).toBe(7900n);
    expect(result.amountMinor).toBeGreaterThanOrEqual(15_800n);
    expect(result.fxRateId).toBeTruthy();
  });

  it('never returns less than the raw conversion', async () => {
    for (const base of [1n, 99n, 100n, 999n, 5_000n, 7_900n, 250_000n]) {
      const result = await localizePrice(base, TEST_QUOTE);
      expect(result.amountMinor).toBeGreaterThanOrEqual(base * 2n);
    }
  });

  it('leaves zero at zero rather than rounding up to a step', async () => {
    const result = await localizePrice(0n, TEST_QUOTE);
    expect(result.amountMinor).toBe(0n);
  });

  it('applies the configured margin on top of the rate', async () => {
    await prisma.supportedCurrency.update({
      where: { code: TEST_QUOTE },
      data: { marginBps: 1_000 },
    });
    invalidateCurrencyCache();

    const result = await localizePrice(10_000n, TEST_QUOTE);
    // 10000 * 2 * 1.10 = 22000 before rounding.
    expect(result.marginBps).toBe(1_000);
    expect(result.amountMinor).toBeGreaterThanOrEqual(22_000n);

    await prisma.supportedCurrency.update({
      where: { code: TEST_QUOTE },
      data: { marginBps: 0 },
    });
    invalidateCurrencyCache();
  });

  it('is deterministic for a fixed rate', async () => {
    const a = await localizePrice(7900n, TEST_QUOTE);
    const b = await localizePrice(7900n, TEST_QUOTE);
    expect(a.amountMinor).toBe(b.amountMinor);
  });

  it('rejects a stale rate at checkout but allows it for display', async () => {
    await prisma.fxRate.updateMany({
      where: { quoteCurrency: TEST_QUOTE, supersededAt: null },
      data: { fetchedAt: new Date(Date.now() - 40 * 60 * 60 * 1000) },
    });

    await expect(localizePrice(7900n, TEST_QUOTE)).rejects.toBeInstanceOf(StaleRateError);

    const display = await localizePrice(7900n, TEST_QUOTE, { allowStale: true });
    expect(display.currency).toBe(TEST_QUOTE);

    await prisma.fxRate.updateMany({
      where: { quoteCurrency: TEST_QUOTE, supersededAt: null },
      data: { fetchedAt: new Date() },
    });
  });

  it('rejects a currency with no rate at all', async () => {
    await expect(localizePrice(7900n, 'JPY')).rejects.toBeInstanceOf(StaleRateError);
  });
});

describe('fx rate history', () => {
  it('supersedes rather than updating, so payment references stay valid', async () => {
    const first = await writeRate({ quoteCurrency: TEST_QUOTE, rate: 3, source: 'test' });
    const second = await writeRate({ quoteCurrency: TEST_QUOTE, rate: 4, source: 'test' });

    const reloadedFirst = await prisma.fxRate.findUnique({ where: { id: first.id } });
    expect(reloadedFirst).not.toBeNull();
    expect(reloadedFirst!.supersededAt).not.toBeNull();
    expect(reloadedFirst!.rate.toNumber()).toBe(3);

    const current = await prisma.fxRate.findMany({
      where: { quoteCurrency: TEST_QUOTE, supersededAt: null },
    });
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(second.id);
  });
});
