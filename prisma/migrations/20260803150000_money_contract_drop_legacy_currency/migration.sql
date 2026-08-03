-- Contract step. Run ONLY after scripts/backfillMoney.ts reports zero
-- unconverted rows: every DROP below is irreversible.

-- Renames, not drop+add: Prisma's generated diff would have destroyed every
-- provider reference and then failed adding a NOT NULL column to a live table.
ALTER TABLE "payments" RENAME COLUMN "paystackRef" TO "providerRef";
ALTER TABLE "payments" RENAME COLUMN "paystackResponse" TO "providerResponse";
ALTER INDEX "payments_paystackRef_key" RENAME TO "payments_providerRef_key";

-- Legacy price columns, superseded by minor units in the base currency.
ALTER TABLE "programs" DROP COLUMN "price", DROP COLUMN "currency";
ALTER TABLE "consultation_services" DROP COLUMN "price", DROP COLUMN "currency";
ALTER TABLE "camp_tiers" DROP COLUMN "price";
ALTER TABLE "camps" DROP COLUMN "price", DROP COLUMN "currency";
ALTER TABLE "platform_settings" DROP COLUMN "currency";
ALTER TABLE "payments" DROP COLUMN "amount", DROP COLUMN "currency";

ALTER TABLE "programs" ALTER COLUMN "priceMinor" SET NOT NULL;
ALTER TABLE "consultation_services" ALTER COLUMN "priceMinor" SET NOT NULL;
ALTER TABLE "camp_tiers" ALTER COLUMN "priceMinor" SET NOT NULL;

ALTER TABLE "payments"
  ALTER COLUMN "provider" SET DEFAULT 'FLUTTERWAVE',
  ALTER COLUMN "presentmentCurrency" SET NOT NULL,
  ALTER COLUMN "presentmentAmountMinor" SET NOT NULL,
  ALTER COLUMN "baseCurrency" SET NOT NULL,
  ALTER COLUMN "baseCurrency" SET DEFAULT 'GBP',
  ALTER COLUMN "baseAmountMinor" SET NOT NULL,
  ALTER COLUMN "marginBps" SET NOT NULL,
  ALTER COLUMN "marginBps" SET DEFAULT 0,
  ALTER COLUMN "quotedAt" SET NOT NULL,
  ALTER COLUMN "quotedAt" SET DEFAULT CURRENT_TIMESTAMP;

DROP TYPE "PlatformCurrency";
