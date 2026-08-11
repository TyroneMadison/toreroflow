import assert from "node:assert/strict";
import {
  followsMeasurable,
  metricMeasurable,
  METRIC_REPORTED_BY,
  reportsSaves,
  reportsMetric,
  SAVES_REPORTED_BY,
  savesMeasurable,
  sumReported,
  ZERO_IS_UNMEASURED,
} from "./platformMetrics";

/* ---- the platform list ---- */

assert.ok(SAVES_REPORTED_BY.has("instagram"), "instagram reports saves");
assert.ok(
  !SAVES_REPORTED_BY.has("tiktok"),
  "tiktok has a save button but has never reported the number, see the note in platformMetrics.ts",
);
assert.ok(!SAVES_REPORTED_BY.has("youtube"), "youtube has no save button");
assert.ok(!SAVES_REPORTED_BY.has("facebook"), "facebook has no save button");

/* ---- per post ---- */

assert.ok(reportsSaves(["instagram"]), "an instagram post reports saves");
assert.ok(!reportsSaves(["tiktok"]), "a tiktok post does not");
assert.ok(!reportsSaves([]), "a post on nothing reports nothing");
// Cross-posts are the common case here: one upload fanned out to several
// platforms. One save-reporting platform in the list is enough for the number
// on that post to mean something.
assert.ok(reportsSaves(["tiktok", "instagram"]), "a cross-post including instagram does");
assert.ok(!reportsSaves(["tiktok", "youtube"]), "a cross-post with neither does not");

/* ---- across a set ---- */

const IG = { platforms: ["instagram"], follows: 0 };
const TT = { platforms: ["tiktok"], follows: 0 };
const YT = { platforms: ["youtube"], follows: 0 };

assert.ok(savesMeasurable([TT, IG, YT]), "a mixed period has measurable saves");
assert.ok(!savesMeasurable([TT, YT]), "a tiktok and youtube period does not");
assert.ok(!savesMeasurable([]), "an empty period does not");

/* ---- follows, asked of the data rather than declared ---- */

assert.ok(!followsMeasurable([IG, TT, YT]), "all zero means nobody measured it");
assert.ok(!followsMeasurable([]), "an empty period measures nothing");
assert.ok(
  followsMeasurable([IG, { platforms: ["instagram"], follows: 4 }]),
  "one real number anywhere is enough to start showing it",
);

/*
 * The whole point of this module: the screen and the report have to answer
 * these the same way. Both now call the functions above, so this asserts the
 * property they used to violate by keeping their own copies of the list.
 */
const period = [TT, TT, YT];
assert.equal(
  savesMeasurable(period),
  false,
  "a tiktok-only period is unmeasurable, so the screen dashes it and the report omits the row",
);

/* ---- the full matrix, measured 2026-08-11 over 800 posts ---- */

assert.ok(reportsMetric("views", ["tiktok"]), "every platform reports views");
assert.ok(reportsMetric("shares", ["tiktok"]), "tiktok reports shares, 57 of 238");
assert.ok(
  !reportsMetric("shares", ["youtube"]),
  "youtube shares are 0 of 243 through the provider, so a total would be a sum of unmeasured zeros",
);
assert.ok(!reportsMetric("reach", ["tiktok"]), "tiktok reach is 0 of 238");
assert.ok(reportsMetric("reach", ["facebook"]), "facebook reach is 40 of 40");
assert.ok(reportsMetric("clicks", ["facebook"]), "facebook clicks are 33 of 40");
assert.ok(!reportsMetric("clicks", ["instagram"]), "instagram clicks are 0 of 279");
assert.ok(
  !reportsMetric("impressions", ["instagram"]),
  "instagram impressions arrive but mirror views since Meta deprecated them, so showing both would print one number twice",
);
assert.ok(reportsMetric("impressions", ["facebook"]), "facebook impressions are 40 of 40");
assert.ok(reportsMetric("avgWatch", ["instagram"]), "instagram watch time is 274 of 279");
assert.ok(!reportsMetric("avgWatch", ["youtube"]), "no watch time through the provider");
assert.ok(reportsMetric("totalWatch", ["instagram"]), "instagram total watch is 274 of 279");

// follows is the one metric no platform serves. The set is empty on purpose,
// so every caller answers no without a special case.
assert.equal(METRIC_REPORTED_BY.follows.size, 0, "no platform reports follows");
assert.ok(!reportsMetric("follows", ["instagram", "tiktok", "youtube", "facebook"]), "nowhere");

// A cross-post needs one reporting platform for the number to mean something.
assert.ok(reportsMetric("saves", ["tiktok", "instagram"]), "one save-reporting platform is enough");
assert.ok(!reportsMetric("saves", ["tiktok", "youtube"]), "neither reports saves");

/* ---- across a set ---- */

assert.ok(metricMeasurable("reach", [TT, IG]), "a period containing instagram has reach");
assert.ok(!metricMeasurable("reach", [TT, YT]), "a tiktok and youtube period has none");
assert.ok(!metricMeasurable("reach", []), "an empty period measures nothing");

// The old helpers must keep agreeing with the new general one, because both
// are live and a disagreement would put a number on one surface and a dash on
// the other.
assert.equal(reportsMetric("saves", ["instagram"]), reportsSaves(["instagram"]), "agree on ig");
assert.equal(reportsMetric("saves", ["tiktok"]), reportsSaves(["tiktok"]), "agree on tiktok");

/* ---- totalling only over the platforms that report ---- */

/*
 * The exact case that shipped wrong. One video cross-posted to Instagram and
 * Facebook: Instagram sends impressions mirroring its 12,000 views, Facebook
 * sends its own 900. Asking reportsMetric of the post's platform list says yes,
 * because Facebook is on it, and reading the post-level aggregate then prints
 * 12,900 under a heading the client reads as a second real audience number.
 * Only Facebook's 900 was ever an impressions measurement.
 */
const crossPost = [
  { platform: "instagram", impressions: 12_000, reach: 11_400, saves: 61, clicks: 0 },
  { platform: "facebook", impressions: 900, reach: 850, saves: 0, clicks: 7 },
];
assert.equal(
  sumReported("impressions", crossPost, (b) => b.impressions),
  900,
  "an instagram plus facebook post contributes only facebook's impressions, never instagram's mirror of views",
);
assert.equal(
  sumReported("reach", crossPost, (b) => b.reach),
  12_250,
  "both platforms report reach, so both count",
);
assert.equal(
  sumReported("saves", crossPost, (b) => b.saves),
  61,
  "only instagram reports saves, so facebook's structural zero is not summed in",
);
assert.equal(
  sumReported("clicks", crossPost, (b) => b.clicks),
  7,
  "only facebook reports clicks, so instagram's always-zero field is left out",
);

// No reporting platform means there is nothing to total, and null is what
// makes a caller print a dash rather than a zero.
assert.equal(
  sumReported("impressions", [{ platform: "tiktok", impressions: 0 }], (b) => b.impressions),
  null,
  "a tiktok-only post has no impressions to report",
);
assert.equal(sumReported("reach", [], () => 1), null, "no entries at all measures nothing");

// A reporting platform that sent nothing still counts as reporting: the total
// is zero rather than absent, and the zero rule below decides what that means.
assert.equal(
  sumReported("reach", [{ platform: "instagram", reach: null }], (b) => b.reach),
  0,
  "the platform reports reach, it just sent no number for this post",
);

/* ---- a zero that cannot be a result ---- */

/*
 * Instagram reports reach on 275 of 279 posts, so about four posts a client-year
 * arrive with a zero. A post with views did not reach nobody, so that zero is an
 * uncomputed provider metric and has to read as absent. This is the same
 * decision already made for watch time, generalised.
 */
assert.ok(ZERO_IS_UNMEASURED.has("reach"), "a post with views cannot have reached nobody");
assert.ok(ZERO_IS_UNMEASURED.has("avgWatch"), "a viewed video was not watched for zero seconds");
assert.ok(ZERO_IS_UNMEASURED.has("totalWatch"), "same reasoning as avgWatch");

// The other half of the rule, and the more important half: these can genuinely
// be zero, and printing 0 for them is the honest result rather than a lie.
assert.ok(!ZERO_IS_UNMEASURED.has("saves"), "plenty of posts genuinely earn no saves");
assert.ok(!ZERO_IS_UNMEASURED.has("clicks"), "a post with no link in it genuinely gets no clicks");
assert.ok(!ZERO_IS_UNMEASURED.has("comments"), "a quiet post genuinely gets no comments");
assert.ok(!ZERO_IS_UNMEASURED.has("shares"), "nobody sharing it is a real result");

console.log("platformMetrics.check.ts: ok");
