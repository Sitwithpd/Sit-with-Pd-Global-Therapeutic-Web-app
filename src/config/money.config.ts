function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Flutterwave publishes transfer rates 3-4x daily; tighter than ~8h false-positives. */
export const FX_STALE_THRESHOLD_MS = intFromEnv('FX_STALE_THRESHOLD_HOURS', 12) * 60 * 60 * 1000;

/**
 * A new rate row is only written when it moves more than this. Ceiling rounding
 * flips at step boundaries, so without a floor on ingest a 0.2% wobble would
 * change advertised prices.
 */
export const FX_DRIFT_THRESHOLD_BPS = intFromEnv('FX_DRIFT_THRESHOLD_BPS', 150);

export const FX_SYNC_INTERVAL_MS = intFromEnv('FX_SYNC_INTERVAL_MINUTES', 120) * 60 * 1000;

/** Transfer rates can be amount-tiered; probe at a representative sale size. */
export const FX_PROBE_AMOUNT = intFromEnv('FX_PROBE_AMOUNT', 100);

export const FX_ALERT_AFTER_CONSECUTIVE_FAILURES = intFromEnv('FX_ALERT_AFTER_FAILURES', 3);
