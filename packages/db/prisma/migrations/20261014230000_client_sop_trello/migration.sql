-- Per-client SOP, deep-link slug and Trello label routing. All nullable or
-- defaulted, so existing rows need no backfill.
ALTER TABLE "Client" ADD COLUMN "slug" TEXT;
ALTER TABLE "Client" ADD COLUMN "sop" TEXT;
ALTER TABLE "Client" ADD COLUMN "sopUpdatedAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "trelloLabels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
