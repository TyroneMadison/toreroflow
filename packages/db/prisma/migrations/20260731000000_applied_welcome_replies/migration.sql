-- Which welcome replies have already been applied, so a check never applies the
-- same one twice. Since an answer wins, re-applying would silently revert a
-- detail the operator had corrected by hand.
ALTER TABLE "Client" ADD COLUMN "welcomeRepliesApplied" TEXT[] DEFAULT ARRAY[]::TEXT[];
