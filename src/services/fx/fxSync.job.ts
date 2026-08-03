import { FX_ALERT_AFTER_CONSECUTIVE_FAILURES } from '../../config/money.config';
import { ensurePlatformSettings } from '../platformSettings.service';
import { sendFxSyncFailureEmail } from '../../utils/email.service';
import { ingestRates, RateIngestOutcome } from './fxRate.service';

let consecutiveFailures = 0;

export function getConsecutiveFxFailures(): number {
  return consecutiveFailures;
}

/**
 * A silent staleness guard is an outage nobody notices, so repeated failures
 * escalate to the support inbox.
 */
async function alertIfNeeded(failed: RateIngestOutcome[]): Promise<void> {
  if (consecutiveFailures !== FX_ALERT_AFTER_CONSECUTIVE_FAILURES) return;
  try {
    const settings = await ensurePlatformSettings();
    const to = settings.supportEmail?.trim();
    if (!to) return;
    await sendFxSyncFailureEmail({
      to,
      consecutiveFailures,
      failures: failed.map((f) => ({ currency: f.quoteCurrency, error: f.error ?? 'unknown' })),
    });
  } catch (err) {
    console.error('[fx-sync] alert email failed:', err);
  }
}

export async function runFxSync(): Promise<RateIngestOutcome[]> {
  const outcomes = await ingestRates();
  const failed = outcomes.filter((o) => o.status === 'failed');

  if (failed.length > 0 && failed.length === outcomes.length) {
    consecutiveFailures += 1;
    await alertIfNeeded(failed);
  } else {
    consecutiveFailures = 0;
  }

  const written = outcomes.filter((o) => o.status === 'written').length;
  console.log(
    `[fx-sync] ${written} rate(s) written, ${outcomes.length - written - failed.length} unchanged, ${failed.length} failed`
  );

  return outcomes;
}
