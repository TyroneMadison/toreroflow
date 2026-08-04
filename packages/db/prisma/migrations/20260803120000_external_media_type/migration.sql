-- What kind of post a stored row is: video | image | carousel, as the
-- provider reports it. Until now everything ingested was assumed to be a
-- video, which was true of what the boards showed but wrong of the account:
-- the live data already holds an Instagram carousel with 1,308 views that
-- was being counted as a video.
--
-- Existing rows default to video, which is what they were ingested as. The
-- next analytics ingest corrects any that are really carousels, because the
-- upsert now writes the field on every pass.
ALTER TABLE "ExternalVideo" ADD COLUMN "mediaType" TEXT NOT NULL DEFAULT 'video';
