-- AlterTable
-- Programs now carry their own pricing currency (defaults to NGN to match the
-- existing Naira-denominated prices). The PlatformCurrency enum already exists.
ALTER TABLE "programs" ADD COLUMN "currency" "PlatformCurrency" NOT NULL DEFAULT 'NGN';
