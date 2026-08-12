-- Which metrics on a row came from the platform's own API rather than the broker.
--
-- Metric availability used to be answered per platform, which stopped being
-- true when a channel could be connected directly: a connected YouTube channel
-- reports shares, watch time and subscribers gained, and an unconnected one on
-- the same platform reports none of them. Answering per platform would print
-- "Shares 0" for every channel nobody has authorized.
--
-- Defaults to empty, so every existing row keeps behaving exactly as it does
-- today and only rows the direct sync has touched start reporting more.

ALTER TABLE "ExternalVideo" ADD COLUMN "directMetrics" TEXT[] DEFAULT ARRAY[]::TEXT[];
