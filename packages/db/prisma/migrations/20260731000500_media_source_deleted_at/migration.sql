-- The source video is cleared a week after every platform has posted it.
-- The row, the thumbnail and the cover stay; this records when the file went,
-- so the app can explain the missing preview and the sweep skips it next time.
ALTER TABLE "MediaAsset" ADD COLUMN "sourceDeletedAt" TIMESTAMP(3);
