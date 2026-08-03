import { exponentFor, normalizeCurrencyCode } from '../../lib/money';

export interface RoundingTier {
  /** Applies while the amount is below this, in minor units. */
  belowMinor: bigint;
  stepMinor: bigint;
}

export interface CurrencyRounding {
  tiers: RoundingTier[];
  /** Subtracted after stepping, e.g. 1 -> x.99. Never below the raw amount. */
  charmMinor: bigint;
}

const DEFAULT_DECIMAL: CurrencyRounding = {
  tiers: [
    { belowMinor: 1_000n, stepMinor: 50n },
    { belowMinor: 10_000n, stepMinor: 100n },
    { belowMinor: 100_000n, stepMinor: 500n },
    { belowMinor: -1n, stepMinor: 1_000n },
  ],
  charmMinor: 1n,
};

export const ROUNDING: Record<string, CurrencyRounding> = {
  GBP: DEFAULT_DECIMAL,
  USD: DEFAULT_DECIMAL,
  EUR: DEFAULT_DECIMAL,
  NGN: {
    tiers: [
      { belowMinor: 1_000_000n, stepMinor: 50_000n },
      { belowMinor: -1n, stepMinor: 100_000n },
    ],
    // ".99" reads as noise in Naira.
    charmMinor: 0n,
  },
};

export function roundingFor(currency: string): CurrencyRounding {
  const code = normalizeCurrencyCode(currency);
  if (ROUNDING[code]) return ROUNDING[code];
  const exponent = exponentFor(code);
  const unit = BigInt(10) ** BigInt(exponent);
  return {
    tiers: [{ belowMinor: -1n, stepMinor: unit }],
    charmMinor: 0n,
  };
}

export function stepFor(amountMinor: bigint, rounding: CurrencyRounding): bigint {
  for (const tier of rounding.tiers) {
    if (tier.belowMinor < 0n || amountMinor < tier.belowMinor) return tier.stepMinor;
  }
  return rounding.tiers[rounding.tiers.length - 1].stepMinor;
}

export function ceilToStep(amountMinor: bigint, stepMinor: bigint): bigint {
  if (stepMinor <= 1n) return amountMinor;
  const remainder = amountMinor % stepMinor;
  return remainder === 0n ? amountMinor : amountMinor + (stepMinor - remainder);
}

/**
 * Always rounds up. Rounding down would systematically undercharge against the
 * GBP base and leak margin on every sale.
 */
export function applyRounding(rawMinor: bigint, currency: string): bigint {
  if (rawMinor <= 0n) return rawMinor;

  const rounding = roundingFor(currency);
  const step = stepFor(rawMinor, rounding);
  const stepped = ceilToStep(rawMinor, step);

  if (rounding.charmMinor > 0n && rounding.charmMinor < step) {
    const charmed = stepped - rounding.charmMinor;
    if (charmed >= rawMinor) return charmed;
  }

  return stepped;
}
