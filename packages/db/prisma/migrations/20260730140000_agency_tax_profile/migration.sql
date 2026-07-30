-- What the tax estimate needs beyond the figures already in Financials:
-- which state taxes the profit, which brackets apply, and what other income
-- decides the bracket the profit lands in.
ALTER TABLE "Agency" ADD COLUMN "taxState" TEXT;
ALTER TABLE "Agency" ADD COLUMN "filingStatus" TEXT DEFAULT 'single';
ALTER TABLE "Agency" ADD COLUMN "otherIncomeCents" INTEGER;
-- A table of state rates goes stale every January, so the operator can correct it.
ALTER TABLE "Agency" ADD COLUMN "stateTaxRatePct" DOUBLE PRECISION;
