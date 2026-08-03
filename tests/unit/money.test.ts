import { describe, expect, it } from 'vitest';
import {
  allocate,
  exponentFor,
  formatMoney,
  minorToDecimalString,
  minorToNumber,
  normalizeCurrencyCode,
  parseToMinor,
} from '../../src/lib/money';

describe('exponentFor', () => {
  it('derives decimal places from ICU rather than assuming 2', () => {
    expect(exponentFor('GBP')).toBe(2);
    expect(exponentFor('USD')).toBe(2);
    expect(exponentFor('EUR')).toBe(2);
    expect(exponentFor('NGN')).toBe(2);
    expect(exponentFor('JPY')).toBe(0);
    expect(exponentFor('KWD')).toBe(3);
  });

  it('is case insensitive', () => {
    expect(exponentFor('gbp')).toBe(2);
  });

  it('rejects malformed codes', () => {
    expect(() => exponentFor('POUNDS')).toThrow();
    expect(() => exponentFor('')).toThrow();
  });
});

describe('parseToMinor', () => {
  it('avoids the float trap', () => {
    // parseFloat('12.34') * 100 === 1233.9999999999998
    expect(parseToMinor('12.34', 'GBP')).toBe(1234n);
    expect(parseToMinor(12.34, 'GBP')).toBe(1234n);
    expect(parseToMinor('0.07', 'GBP')).toBe(7n);
  });

  it('refuses to silently drop sub-unit precision', () => {
    expect(() => parseToMinor('1.005', 'JPY')).toThrow();
  });

  it('honours the currency exponent', () => {
    expect(parseToMinor('100', 'JPY')).toBe(100n);
    expect(parseToMinor('1.234', 'KWD')).toBe(1234n);
    expect(parseToMinor('79', 'GBP')).toBe(7900n);
  });

  it('accepts trailing zeros beyond the exponent', () => {
    expect(parseToMinor('12.3400', 'GBP')).toBe(1234n);
  });

  it('rejects significant digits beyond the exponent', () => {
    expect(() => parseToMinor('12.345', 'GBP')).toThrow();
  });

  it('handles negatives and rejects junk', () => {
    expect(parseToMinor('-5.50', 'GBP')).toBe(-550n);
    expect(() => parseToMinor('abc', 'GBP')).toThrow();
    expect(() => parseToMinor('1.2.3', 'GBP')).toThrow();
  });
});

describe('minor <-> decimal round trip', () => {
  it('survives both directions', () => {
    for (const [value, currency] of [
      ['12.34', 'GBP'],
      ['0.01', 'USD'],
      ['150000.00', 'NGN'],
      ['1000', 'JPY'],
      ['1.234', 'KWD'],
    ] as const) {
      const minor = parseToMinor(value, currency);
      expect(parseToMinor(minorToDecimalString(minor, currency), currency)).toBe(minor);
    }
  });

  it('pads sub-unit amounts', () => {
    expect(minorToDecimalString(7n, 'GBP')).toBe('0.07');
    expect(minorToDecimalString(0n, 'GBP')).toBe('0.00');
    expect(minorToDecimalString(-550n, 'GBP')).toBe('-5.50');
    expect(minorToDecimalString(100n, 'JPY')).toBe('100');
  });

  it('converts to Number safely', () => {
    expect(minorToNumber(10400n, 'USD')).toBe(104);
    expect(minorToNumber(15000000n, 'NGN')).toBe(150000);
  });
});

describe('formatMoney', () => {
  it('uses the locale symbol', () => {
    expect(formatMoney(7900n, 'GBP')).toContain('79');
    expect(formatMoney(7900n, 'GBP')).toContain('£');
  });
});

describe('normalizeCurrencyCode', () => {
  it('upper-cases and validates', () => {
    expect(normalizeCurrencyCode(' usd ')).toBe('USD');
    expect(() => normalizeCurrencyCode('US')).toThrow();
    expect(() => normalizeCurrencyCode(null)).toThrow();
  });
});

describe('allocate', () => {
  it('always sums back to the original', () => {
    const cases: Array<[bigint, number[]]> = [
      [100n, [1, 1, 1]],
      [10n, [1, 2, 3]],
      [1n, [1, 1]],
      [0n, [1, 1]],
      [9999n, [0.3333, 0.3333, 0.3334]],
    ];
    for (const [total, ratios] of cases) {
      const parts = allocate(total, ratios);
      expect(parts.reduce((s, p) => s + p, 0n)).toBe(total);
      expect(parts).toHaveLength(ratios.length);
    }
  });

  it('splits evenly where it can', () => {
    expect(allocate(100n, [1, 1])).toEqual([50n, 50n]);
  });

  it('handles negatives', () => {
    expect(allocate(-100n, [1, 1]).reduce((s, p) => s + p, 0n)).toBe(-100n);
  });
});
