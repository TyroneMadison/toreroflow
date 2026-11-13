-- Calendar: per-brand "Pause uploads". Null means publishing normally.
ALTER TABLE "Client" ADD COLUMN "pausedAt" TIMESTAMP(3);
