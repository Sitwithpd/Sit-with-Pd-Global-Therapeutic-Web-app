import { AppError } from '../middleware/error.middleware';

export const BASE_CURRENCY = 'GBP';

export interface Money {
  minor: bigint;
  currency: string;
}

/**
 * ICU knows the decimal places for every ISO 4217 code, so there is no table to
 * maintain: GBP/USD/EUR/NGN -> 2, JPY -> 0, KWD -> 3.
 */
const exponentCache = new Map<string, number>();

export function exponentFor(currency: string): number {
  const code = normalizeCurrencyCode(currency);
  const cached = exponentCache.get(code);
  if (cached !== undefined) return cached;

  let exponent: number;
  try {
    exponent =
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency: code,
      }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new AppError(`Unknown currency code: ${currency}`, 400);
  }
  exponentCache.set(code, exponent);
  return exponent;
}

export function normalizeCurrencyCode(currency: unknown): string {
  const code = String(currency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new AppError('currency must be a 3-letter ISO 4217 code.', 400);
  }
  return code;
}

/**
 * Parses via string manipulation. `parseFloat('12.34') * 100` is
 * 1233.9999999999998, which silently loses a penny on some inputs.
 */
export function parseToMinor(input: string | number, currency: string): bigint {
  const exponent = exponentFor(currency);
  const raw = typeof input === 'number' ? decimalStringFromNumber(input) : String(input).trim();

  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new AppError(`Invalid amount: ${input}`, 400);
  }

  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');

  if (fraction.length > exponent) {
    const excess = fraction.slice(exponent);
    if (/[^0]/.test(excess)) {
      throw new AppError(
        `${currency} supports ${exponent} decimal place(s); received ${input}.`,
        400
      );
    }
  }

  const padded = fraction.padEnd(exponent, '0').slice(0, exponent);
  const minor = BigInt(whole + padded);
  return negative ? -minor : minor;
}

function decimalStringFromNumber(value: number): string {
  if (!Number.isFinite(value)) throw new AppError(`Invalid amount: ${value}`, 400);
  // toFixed(10) then trim avoids exponential notation for small/large values.
  return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

export function minorToDecimalString(minor: bigint, currency: string): string {
  const exponent = exponentFor(currency);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** Number is safe here: 2^53 minor units is ~£90 trillion. */
export function minorToNumber(minor: bigint, currency: string): number {
  return Number(minorToDecimalString(minor, currency));
}

export function formatMoney(minor: bigint, currency: string, locale = 'en-GB'): string {
  const code = normalizeCurrencyCode(currency);
  return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(
    minorToNumber(minor, code)
  );
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (normalizeCurrencyCode(a.currency) !== normalizeCurrencyCode(b.currency)) {
    throw new AppError(`Currency mismatch: ${a.currency} vs ${b.currency}.`, 500);
  }
}

/**
 * Largest-remainder split so the parts always sum back to `minor` exactly.
 * Naive per-part rounding loses or invents units.
 */
export function allocate(minor: bigint, ratios: number[]): bigint[] {
  if (ratios.length === 0) return [];
  if (ratios.some((r) => r < 0)) throw new AppError('Allocation ratios must be non-negative.', 500);

  const total = ratios.reduce((sum, r) => sum + r, 0);
  if (total <= 0) throw new AppError('Allocation ratios must sum to more than zero.', 500);

  const scale = 1_000_000;
  const scaledRatios = ratios.map((r) => BigInt(Math.round((r / total) * scale)));
  const scaledTotal = scaledRatios.reduce((sum, r) => sum + r, 0n);

  const shares = scaledRatios.map((r) => (minor * r) / scaledTotal);
  let remainder = minor - shares.reduce((sum, s) => sum + s, 0n);

  const order = scaledRatios
    .map((r, index) => ({ index, remainder: (minor * r) % scaledTotal }))
    .sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : 0));

  const step = remainder < 0n ? -1n : 1n;
  for (let i = 0; remainder !== 0n; i += 1) {
    shares[order[i % order.length].index] += step;
    remainder -= step;
  }

  return shares;
}
