-- Additive only: per-target publish options and the chosen cover.
ALTER TABLE "MediaAsset" ADD COLUMN "coverOffsetMs" INTEGER;
ALTER TABLE "MediaAsset" ADD COLUMN "coverKey" TEXT;
ALTER TABLE "PostTarget" ADD COLUMN "options" JSONB;
