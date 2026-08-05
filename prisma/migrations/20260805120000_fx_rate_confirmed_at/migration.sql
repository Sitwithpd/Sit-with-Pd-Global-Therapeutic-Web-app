-- Freshness is checked against the newest confirmation, not the first sighting.
--
-- ingestRates deliberately does not rewrite a rate whose drift is below the
-- threshold, so `fetchedAt` stayed at the value the rate was first seen with.
-- The staleness guard reads that column, so a stable rate aged out of the
-- window and blocked non-base checkout while the sync was successfully
-- confirming it every cycle.
--
-- `fetchedAt` still means "when this rate was obtained" and stays immutable —
-- payment rows cite it. `confirmedAt` is the only column the sync may touch.

ALTER TABLE "fx_rates" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);

-- Existing rows have only ever been confirmed at the moment they were written.
UPDATE "fx_rates" SET "confirmedAt" = "fetchedAt" WHERE "confirmedAt" IS NULL;
