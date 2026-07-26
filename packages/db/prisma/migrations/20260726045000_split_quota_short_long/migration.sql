-- CreateEnum
CREATE TYPE "VideoFormat" AS ENUM ('short_form', 'long_form');

-- Videos are classified short or long for quota purposes. Left null until
-- processing measures the duration, or the operator sets it explicitly.
ALTER TABLE "MediaAsset" ADD COLUMN "format" "VideoFormat";

-- Quotas are tracked per format, since a client can owe a mix of both.
ALTER TABLE "Client" ADD COLUMN "quotaShort" INTEGER;
ALTER TABLE "Client" ADD COLUMN "quotaLong" INTEGER;
ALTER TABLE "Client" ADD COLUMN "adjustShort" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Client" ADD COLUMN "adjustLong" INTEGER NOT NULL DEFAULT 0;

-- The previous single quota was short-form work, so carry it across rather
-- than discarding it.
UPDATE "Client"
   SET "quotaShort" = "videoQuota",
       "adjustShort" = "quotaAdjustment";

ALTER TABLE "Client" DROP COLUMN "videoQuota";
ALTER TABLE "Client" DROP COLUMN "quotaAdjustment";
