-- Per-client caption block and keyword lines. Nullable or defaulted, so
-- existing rows need no backfill.
ALTER TABLE "Client" ADD COLUMN "captionBlock" TEXT;
ALTER TABLE "Client" ADD COLUMN "captionBlockOn" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Client" ADD COLUMN "captionKeywords" JSONB NOT NULL DEFAULT '[]';
