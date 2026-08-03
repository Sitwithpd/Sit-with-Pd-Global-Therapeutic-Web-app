-- AlterTable
ALTER TABLE "camp_tiers" ADD COLUMN     "priceMinor" BIGINT;

-- AlterTable
ALTER TABLE "consultation_services" ADD COLUMN     "priceMinor" BIGINT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "baseAmountMinor" BIGINT,
ADD COLUMN     "baseCurrency" TEXT,
ADD COLUMN     "fxRate" DECIMAL(18,8),
ADD COLUMN     "fxRateId" TEXT,
ADD COLUMN     "marginBps" INTEGER,
ADD COLUMN     "presentmentAmountMinor" BIGINT,
ADD COLUMN     "presentmentCurrency" TEXT,
ADD COLUMN     "quotedAt" TIMESTAMP(3),
ADD COLUMN     "settlementCurrency" TEXT;

-- AlterTable
ALTER TABLE "programs" ADD COLUMN     "priceMinor" BIGINT;

-- CreateTable
CREATE TABLE "supported_currencies" (
    "code" TEXT NOT NULL,
    "isBase" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "marginBps" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supported_currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL,
    "quoteCurrency" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "source" TEXT NOT NULL,
    "probeAmount" DECIMAL(18,2),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fx_rates_quoteCurrency_supersededAt_idx" ON "fx_rates"("quoteCurrency", "supersededAt");

-- CreateIndex
CREATE INDEX "fx_rates_quoteCurrency_fetchedAt_idx" ON "fx_rates"("quoteCurrency", "fetchedAt");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_fxRateId_fkey" FOREIGN KEY ("fxRateId") REFERENCES "fx_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
