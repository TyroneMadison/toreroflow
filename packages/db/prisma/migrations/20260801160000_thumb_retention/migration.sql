-- Thumbnails and covers sweep a month after posting.
--
-- A separate clock from sourceDeletedAt. The source is 95% of storage and goes
-- at a week; the images are roughly a five-hundredth of a video each and are
-- what every calendar, queue and upload card draws, so they stay far longer.
--
-- Null on every existing row, which is correct: their files are still there.
-- The sweep will pick up any that are already past the window on its next run.
ALTER TABLE "MediaAsset" ADD COLUMN "thumbDeletedAt" TIMESTAMP(3);
