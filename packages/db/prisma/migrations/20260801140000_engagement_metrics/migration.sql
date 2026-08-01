-- Saves, shares, reach and follows per video.
--
-- All four already arrive in the provider's analytics payload and were being
-- thrown away. Measured across 499 live posts before adding them: saves are
-- non-zero on 113, shares on 141, reach on 205. follows is zero on every one,
-- so it is stored but nothing displays it until a real value appears.
--
-- Defaulted rather than nullable to match views/likes/comments, which are
-- counted the same way. The honesty problem (a platform with no save button
-- reporting 0) is handled where it belongs, on the screen, which shows saves
-- per platform instead of as one meaningless total.

ALTER TABLE "ExternalVideo" ADD COLUMN "shares"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExternalVideo" ADD COLUMN "saves"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExternalVideo" ADD COLUMN "reach"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExternalVideo" ADD COLUMN "follows" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ExternalVideoMetric" ADD COLUMN "shares"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN "saves"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN "reach"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN "follows" INTEGER NOT NULL DEFAULT 0;
