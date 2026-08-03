import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { driftBps, isStale } from '../../src/services/fx/fxRate.service';
import { FX_STALE_THRESHOLD_MS, FX_DRIFT_THRESHOLD_BPS } from '../../src/config/money.config';

const dec = (v: string) => new Prisma.Decimal(v);

describe('driftBps', () => {
  it('measures relative movement in basis points', () => {
    expect(driftBps(dec('100'), 101)).toBeCloseTo(100, 6);
    expect(driftBps(dec('100'), 99)).toBeCloseTo(100, 6);
    expect(driftBps(dec('100'), 100)).toBe(0);
  });

  it('treats equal up and down moves from the same base identically', () => {
    // Relative to the *previous* rate, so 1.27->1.30 and 1.27->1.24 match.
    expect(driftBps(dec('1.27'), 1.30)).toBeCloseTo(driftBps(dec('1.27'), 1.24), 6);
  });

  it('treats a zero previous rate as infinite drift so a new rate always writes', () => {
    expect(driftBps(dec('0'), 1.27)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('drift threshold gate', () => {
  const fires = (previous: string, next: number) =>
    driftBps(dec(previous), next) >= FX_DRIFT_THRESHOLD_BPS;

  it('ignores movement below the threshold', () => {
    // Default 150bps = 1.5%.
    expect(fires('100', 101.4)).toBe(false);
    expect(fires('100', 98.6)).toBe(false);
  });

  it('writes once movement exceeds it', () => {
    expect(fires('100', 101.6)).toBe(true);
    expect(fires('100', 98.4)).toBe(true);
  });

  it('holds prices steady across a small wobble', () => {
    // The boundary case that would otherwise flip a ceiling-rounded price.
    expect(fires('1903.44', 1907.0)).toBe(false);
  });
});

describe('isStale', () => {
  const at = (msAgo: number) => ({ fetchedAt: new Date(Date.now() - msAgo) });

  it('is false inside the window', () => {
    expect(isStale(at(0))).toBe(false);
    expect(isStale(at(FX_STALE_THRESHOLD_MS - 60_000))).toBe(false);
  });

  it('is true past the window', () => {
    expect(isStale(at(FX_STALE_THRESHOLD_MS + 60_000))).toBe(true);
  });

  it('respects an injected clock', () => {
    const rate = { fetchedAt: new Date('2026-01-01T00:00:00Z') };
    const justInside = new Date(rate.fetchedAt.getTime() + FX_STALE_THRESHOLD_MS - 1);
    const justOutside = new Date(rate.fetchedAt.getTime() + FX_STALE_THRESHOLD_MS + 1);
    expect(isStale(rate, justInside)).toBe(false);
    expect(isStale(rate, justOutside)).toBe(true);
  });
});
