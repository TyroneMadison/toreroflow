-- Carousels join the quota alongside short and long form.
--
-- Same shape as the video pair: a nullable target (null means not tracked,
-- which is different from a target of zero) and a manual adjustment applied
-- on top of the counted uploads. Counted by kind rather than duration,
-- because a set of images has no duration to classify it by.
ALTER TABLE "Client" ADD COLUMN "quotaCarousel" INTEGER;
ALTER TABLE "Client" ADD COLUMN "adjustCarousel" INTEGER NOT NULL DEFAULT 0;
