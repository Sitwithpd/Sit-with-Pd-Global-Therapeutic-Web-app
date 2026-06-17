-- Camp.currency: align with PlatformCurrency enum (was free-form TEXT, default 'USD').
ALTER TABLE "camps" ALTER COLUMN "currency" DROP DEFAULT;
ALTER TABLE "camps" ALTER COLUMN "currency" TYPE "PlatformCurrency" USING ("currency"::text::"PlatformCurrency");
ALTER TABLE "camps" ALTER COLUMN "currency" SET DEFAULT 'USD';

-- ConsultationService: per-service pricing currency (defaults to NGN).
ALTER TABLE "consultation_services" ADD COLUMN "currency" "PlatformCurrency" NOT NULL DEFAULT 'NGN';
