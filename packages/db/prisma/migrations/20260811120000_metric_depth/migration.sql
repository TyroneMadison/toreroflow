-- The provider has been sending these on every pull and the app has been
-- discarding them. New nullable columns rather than widening the existing
-- ones: an existing metric column defaults to 0 across 1,682 rows, and
-- flipping it to nullable would leave every one of those zeros indistinguishable
-- from a real measurement of zero. New columns start with no history to
-- misrepresent.
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "impressions" INTEGER;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "clicks" INTEGER;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "avgWatchSec" DOUBLE PRECISION;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "totalWatchSec" DOUBLE PRECISION;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "engagementRate" DOUBLE PRECISION;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "metricsUpdatedAt" TIMESTAMP(3);
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'zernio';

-- Existing YouTube rows came from our own catalogue sync, not the provider.
-- Labelling them correctly now means the per-field precedence rule in phase 2
-- has honest data to work from on day one.
UPDATE "ExternalVideo" SET "source" = 'youtube' WHERE "platform" = 'youtube';

-- The daily series carries the same fields, or the history for everything new
-- starts empty and the per-video charts have nothing to draw for months.
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "impressions" INTEGER;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "clicks" INTEGER;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "avgWatchSec" DOUBLE PRECISION;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "totalWatchSec" DOUBLE PRECISION;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "engagementRate" DOUBLE PRECISION;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "metricsUpdatedAt" TIMESTAMP(3);
