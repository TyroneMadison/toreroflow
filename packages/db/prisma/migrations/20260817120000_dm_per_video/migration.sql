-- DMs a comment-to-DM campaign sent for one video.
--
-- Nullable, not zero-defaulted, and that is the point. No platform reports DMs
-- per video; the number exists only because a campaign was scoped to that post
-- and counted its own triggers. A video nobody ran a campaign on has no figure
-- at all, which is different from a campaign that ran and got nobody, and only
-- the second of those is a result worth printing on a client's report.
--
-- dmClicks is the tracked-link half: how many of those DMs got their link
-- opened. Also nullable, because link tracking can be turned off per campaign,
-- and a campaign carrying no tracked link never had a denominator.

ALTER TABLE "ExternalVideo" ADD COLUMN "dms" INTEGER;
ALTER TABLE "ExternalVideo" ADD COLUMN "dmClicks" INTEGER;
