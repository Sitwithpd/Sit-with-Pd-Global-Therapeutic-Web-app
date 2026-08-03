import { Prisma } from '@prisma/client';
import { AppError } from '../../middleware/error.middleware';
import { BASE_CURRENCY, exponentFor, minorToDecimalString, minorToNumber } from '../../lib/money';
import { getCurrentRate, isStale } from '../fx/fxRate.service';
import { getMarginBps } from '../fx/currency.service';
import { applyRounding } from './rounding';

export interface LocalizedPrice {
  amount: number;
  amountMinor: bigint;
  currency: string;
  baseAmountMinor: bigint;
  baseCurrency: string;
  fxRateId: string | null;
  fxRate: Prisma.Decimal | null;
  marginBps: number;
  rateFetchedAt: Date | null;
}

const SCALE = 100_000_000n; // 8dp, matching the Decimal(18,8) column.

function decimalToScaled(value: Prisma.Decimal): bigint {
  const [whole, fraction = ''] = value.toFixed(8).split('.');
  return BigInt(whole + fraction.padEnd(8, '0'));
}

export class StaleRateError extends AppError {
  constructor(currency: string) {
    super(
      `Pricing in ${currency} is temporarily unavailable. Please try again shortly or switch to ${BASE_CURRENCY}.`,
      503
    );
  }
}

/**
 * Converting between currencies with different exponents needs the ratio of
 * their minor-unit scales, otherwise NGN (2dp) -> JPY (0dp) would be off by 100.
 */
function exponentAdjust(from: string, to: string): { mul: bigint; div: bigint } {
  const diff = exponentFor(to) - exponentFor(from);
  return diff >= 0
    ? { mul: BigInt(10) ** BigInt(diff), div: 1n }
    : { mul: 1n, div: BigInt(10) ** BigInt(-diff) };
}

export async function localizePrice(
  baseAmountMinor: bigint,
  currency: string,
  options: { allowStale?: boolean } = {}
): Promise<LocalizedPrice> {
  const target = currency.toUpperCase();

  if (target === BASE_CURRENCY || baseAmountMinor === 0n) {
    return {
      amount: minorToNumber(baseAmountMinor, BASE_CURRENCY),
      amountMinor: baseAmountMinor,
      currency: target === BASE_CURRENCY ? BASE_CURRENCY : target,
      baseAmountMinor,
      baseCurrency: BASE_CURRENCY,
      fxRateId: null,
      fxRate: null,
      marginBps: 0,
      rateFetchedAt: null,
    };
  }

  const rateRow = await getCurrentRate(target);
  if (!rateRow) throw new StaleRateError(target);
  if (!options.allowStale && isStale(rateRow)) throw new StaleRateError(target);

  const marginBps = await getMarginBps(target);
  const { mul, div } = exponentAdjust(BASE_CURRENCY, target);

  const raw =
    (baseAmountMinor * decimalToScaled(rateRow.rate) * BigInt(10_000 + marginBps) * mul) /
    (SCALE * 10_000n * div);

  const amountMinor = applyRounding(raw, target);

  if (amountMinor < raw) {
    throw new AppError('Rounding produced a price below the converted amount.', 500);
  }

  return {
    amount: Number(minorToDecimalString(amountMinor, target)),
    amountMinor,
    currency: target,
    baseAmountMinor,
    baseCurrency: BASE_CURRENCY,
    fxRateId: rateRow.id,
    fxRate: rateRow.rate,
    marginBps,
    rateFetchedAt: rateRow.fetchedAt,
  };
}
