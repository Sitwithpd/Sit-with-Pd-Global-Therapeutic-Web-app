import { describe, expect, it } from 'vitest';
import { applyRounding, ceilToStep, roundingFor, stepFor } from '../../src/services/pricing/rounding';

describe('stepFor', () => {
  it('scales the step with magnitude', () => {
    const gbp = roundingFor('GBP');
    expect(stepFor(500n, gbp)).toBe(50n); // £5.00 -> 50p steps
    expect(stepFor(5_000n, gbp)).toBe(100n); // £50 -> £1 steps
    expect(stepFor(50_000n, gbp)).toBe(500n); // £500 -> £5 steps
    expect(stepFor(500_000n, gbp)).toBe(1_000n); // £5000 -> £10 steps
  });

  it('uses coarse steps for NGN', () => {
    const ngn = roundingFor('NGN');
    expect(stepFor(500_000n, ngn)).toBe(50_000n);
    expect(stepFor(5_000_000n, ngn)).toBe(100_000n);
  });

  it('falls back to one major unit for unconfigured currencies', () => {
    expect(stepFor(1_000n, roundingFor('ZAR'))).toBe(100n);
    expect(stepFor(1_000n, roundingFor('JPY'))).toBe(1n);
  });
});

describe('ceilToStep', () => {
  it('always rounds up', () => {
    expect(ceilToStep(10_033n, 100n)).toBe(10_100n);
    expect(ceilToStep(10_001n, 100n)).toBe(10_100n);
    expect(ceilToStep(10_100n, 100n)).toBe(10_100n);
  });
});

describe('applyRounding', () => {
  it('never returns less than the raw amount', () => {
    for (const currency of ['GBP', 'USD', 'EUR', 'NGN', 'JPY']) {
      for (let raw = 1n; raw < 2_000n; raw += 7n) {
        expect(applyRounding(raw, currency)).toBeGreaterThanOrEqual(raw);
      }
    }
  });

  it('lands on a charm ending when there is room', () => {
    // $103.35 sits in the $5-step band: ceil to $105, charm to $104.99.
    expect(applyRounding(10_335n, 'USD')).toBe(10_499n);
    // $42.10 sits in the $1-step band: ceil to $43, charm to $42.99.
    expect(applyRounding(4_210n, 'USD')).toBe(4_299n);
  });

  it('does not charm NGN', () => {
    const rounded = applyRounding(154_603n, 'NGN');
    expect(rounded).toBe(200_000n);
    expect(rounded % 50_000n).toBe(0n);
  });

  it('leaves zero alone rather than rounding it up to a step', () => {
    expect(applyRounding(0n, 'USD')).toBe(0n);
    expect(applyRounding(0n, 'NGN')).toBe(0n);
  });

  it('is idempotent on an already-rounded value', () => {
    const once = applyRounding(10_335n, 'USD');
    expect(applyRounding(once, 'USD')).toBe(once);
  });

  it('handles tier boundaries without dropping below raw', () => {
    for (const boundary of [999n, 1_000n, 1_001n, 9_999n, 10_000n, 10_001n, 99_999n, 100_000n]) {
      expect(applyRounding(boundary, 'GBP')).toBeGreaterThanOrEqual(boundary);
    }
  });
});
