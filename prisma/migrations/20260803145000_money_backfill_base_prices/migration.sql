-- Converts legacy per-entity prices into GBP minor units, between the expand
-- and contract steps.
--
-- This runs in SQL rather than the backfill script because deploys execute
-- `prisma migrate deploy` for every pending migration in one pass — there is no
-- window to run a script in between, so the contract step would hit NOT NULL
-- against unconverted rows.
--
-- Rates are fixed here on purpose: the value a price converts to must not
-- depend on when the deploy happened to run. They are real rates pulled from
-- Flutterwave at authoring time, and the FX sync replaces them with live ones
-- on first boot. Migration-day rates permanently set the GBP catalogue.
--
-- Every statement is idempotent so a retried deploy is safe.
--
-- NOTE: the x100 below is valid only because GBP/USD/EUR/NGN are all 2-decimal.
-- src/lib/money.ts derives exponents from ICU; plain SQL cannot.

INSERT INTO "supported_currencies" ("code", "isBase", "isEnabled", "marginBps", "createdAt", "updatedAt")
VALUES
  ('GBP', true,  true, 0,   NOW(), NOW()),
  ('USD', false, true, 200, NOW(), NOW()),
  ('EUR', false, true, 200, NOW(), NOW()),
  ('NGN', false, true, 300, NOW(), NOW())
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "fx_rates" ("id", "baseCurrency", "quoteCurrency", "rate", "source", "fetchedAt", "createdAt")
SELECT * FROM (VALUES
  ('fx_seed_usd', 'GBP', 'USD', 1.36772732::decimal(18,8), 'migration', NOW(), NOW()),
  ('fx_seed_eur', 'GBP', 'EUR', 1.18763700::decimal(18,8), 'migration', NOW(), NOW()),
  ('fx_seed_ngn', 'GBP', 'NGN', 1903.44943106::decimal(18,8), 'migration', NOW(), NOW())
) AS seed(id, base, quote, rate, source, fetched, created)
WHERE NOT EXISTS (
  SELECT 1 FROM "fx_rates" f WHERE f."quoteCurrency" = seed.quote AND f."supersededAt" IS NULL
);

-- quote units per 1 GBP; dividing a foreign price by this yields GBP.
CREATE OR REPLACE FUNCTION pg_temp.gbp_minor(amount double precision, currency text)
RETURNS bigint AS $fn$
  SELECT ROUND(
    (amount / CASE upper(currency)
                WHEN 'GBP' THEN 1
                WHEN 'USD' THEN 1.36772732
                WHEN 'EUR' THEN 1.18763700
                WHEN 'NGN' THEN 1903.44943106
                ELSE 1
              END) * 100
  )::bigint;
$fn$ LANGUAGE SQL IMMUTABLE;

-- Guarded on the legacy columns still existing: if the contract step has
-- already run on this database there is nothing left to convert, and the
-- statements below would fail on missing columns rather than no-op.
DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'programs' AND column_name = 'price'
  ) THEN

    UPDATE "programs"
       SET "priceMinor" = pg_temp.gbp_minor("price", "currency"::text)
     WHERE "priceMinor" IS NULL;

    UPDATE "consultation_services"
       SET "priceMinor" = pg_temp.gbp_minor("price", "currency"::text)
     WHERE "priceMinor" IS NULL;

    -- CampTier holds the price but the currency lives on the parent Camp, so
    -- this joins rather than reading a per-row currency like the tables above.
    UPDATE "camp_tiers" t
       SET "priceMinor" = pg_temp.gbp_minor(t."price", c."currency"::text)
      FROM "camps" c
     WHERE c."id" = t."campId"
       AND t."priceMinor" IS NULL;

    -- Historical payments keep the amount actually charged as the presentment
    -- value; the GBP equivalent uses the fixed rate because no historical rate
    -- exists. The `migration` fx source marks those figures as estimates.
    UPDATE "payments" p
       SET "presentmentCurrency"    = COALESCE(p."currency", 'GBP'),
           "presentmentAmountMinor" = ROUND(p."amount" * 100)::bigint,
           "baseCurrency"           = 'GBP',
           "baseAmountMinor"        = pg_temp.gbp_minor(p."amount", COALESCE(p."currency", 'GBP')),
           "marginBps"              = 0,
           "quotedAt"               = p."createdAt",
           "fxRateId"               = f."id",
           "fxRate"                 = f."rate"
      FROM (
        SELECT "id", "quoteCurrency", "rate" FROM "fx_rates" WHERE "supersededAt" IS NULL
      ) f
     WHERE p."presentmentAmountMinor" IS NULL
       AND f."quoteCurrency" = COALESCE(p."currency", 'GBP');

    -- GBP payments have no matching fx row, so they need a second pass.
    UPDATE "payments"
       SET "presentmentCurrency"    = COALESCE("currency", 'GBP'),
           "presentmentAmountMinor" = ROUND("amount" * 100)::bigint,
           "baseCurrency"           = 'GBP',
           "baseAmountMinor"        = ROUND("amount" * 100)::bigint,
           "marginBps"              = 0,
           "quotedAt"               = "createdAt"
     WHERE "presentmentAmountMinor" IS NULL;

  END IF;
END
$backfill$;
