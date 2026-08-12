import assert from "node:assert/strict";
import {
  entryReports,
  metricMeasurableOn,
  reportsMetricOn,
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

/*
 * The three cases the sum has to keep apart. Measured 2026-08-11 over the live
 * provider account, 400 platform entries: every entry carried a full analytics
 * object and no key was ever missing, so the middle case is not happening
 * today. It is pinned anyway, because "never seen in 400 entries" is not
 * "cannot happen", and the cost of it happening is a printed zero on a paying
 * client's card where the real figure was never measured.
 */
assert.equal(
  sumReported("saves", [{ platform: "instagram", saves: 0 }], (b) => b.saves),
  0,
  "a real zero arrives as 0 and still totals, so a post that genuinely earned no saves prints Saves 0",
);
assert.equal(
  sumReported("saves", [{ platform: "instagram", saves: null }], (b) => b.saves),
  null,
  "the platform reports saves and sent none for this post, so nothing was measured and a 0 would be invented",
);
assert.equal(
  sumReported("saves", [{ platform: "tiktok", saves: null }], (b) => b.saves),
  null,
  "no platform on the post reports saves at all, the case that already worked",
);
assert.equal(
  sumReported(
    "reach",
    [
      { platform: "instagram", reach: null },
      { platform: "facebook", reach: 850 },
    ],
    (b) => b.reach,
  ),
  850,
  "one entry supplying nothing does not drag the sum down, the entries that measured something still count",
);

/* ---- a zero that cannot be a result ---- */

/*
 * Instagram reports reach on 275 of 279 posts, so about four posts a client-year
 * arrive with a zero. A post with views did not reach nobody, so that zero is an
 * uncomputed provider metric and has to read as absent. This is the same
 * decision already made for watch time, generalised.
 */
assert.ok(ZERO_IS_UNMEASURED.has("reach"), "a post with views cannot have reached nobody");
assert.ok(
  ZERO_IS_UNMEASURED.has("impressions"),
  "an impression is every time the post hit a screen, so it is at least views: 400 views cannot be 0 impressions",
);
assert.ok(ZERO_IS_UNMEASURED.has("avgWatch"), "a viewed video was not watched for zero seconds");
assert.ok(ZERO_IS_UNMEASURED.has("totalWatch"), "same reasoning as avgWatch");

// The other half of the rule, and the more important half: these can genuinely
// be zero, and printing 0 for them is the honest result rather than a lie.
assert.ok(!ZERO_IS_UNMEASURED.has("saves"), "plenty of posts genuinely earn no saves");
assert.ok(!ZERO_IS_UNMEASURED.has("clicks"), "a post with no link in it genuinely gets no clicks");
assert.ok(!ZERO_IS_UNMEASURED.has("comments"), "a quiet post genuinely gets no comments");
assert.ok(!ZERO_IS_UNMEASURED.has("shares"), "nobody sharing it is a real result");

console.log("platformMetrics.check.ts: ok");

/* ---- row-aware reporting: a directly connected channel ---- */

/*
 * The whole point of directMetrics. METRIC_REPORTED_BY says YouTube reports no
 * shares, no watch time and no follows, and that stays true for every channel
 * nobody has authorized. A channel connected to YouTube's own Analytics API
 * reports all three, and the difference lives on the row.
 */
const ytPlain = { platform: "youtube" };
const ytDirect = {
  platform: "youtube",
  directMetrics: ["shares", "avgWatch", "totalWatch", "follows"],
};

for (const metric of ["shares", "avgWatch", "totalWatch", "follows"] as const) {
  assert.ok(!entryReports(metric, ytPlain), `an unconnected youtube row must not claim ${metric}`);
  assert.ok(entryReports(metric, ytDirect), `a connected youtube row does report ${metric}`);
}

// A connected channel does NOT gain metrics its API never sent.
assert.ok(!entryReports("saves", ytDirect), "youtube has no save button, connected or not");
assert.ok(
  !entryReports("reach", ytDirect),
  "a metric absent from directMetrics stays unreported even on a connected row",
);

// What the platform already reports still works with no directMetrics at all.
assert.ok(entryReports("views", ytPlain), "platform-level truth is unchanged");
assert.ok(entryReports("saves", { platform: "instagram" }), "instagram still reports saves");

/* ---- the failure that would print a fabricated zero ---- */

// Two youtube videos, one connected and one not. The connected one's shares
// must total; the unconnected one must contribute nothing and, alone, print
// nothing at all rather than 0.
assert.equal(
  sumReported("shares", [{ ...ytDirect, shares: 12 }], (e) => e.shares),
  12,
  "a connected channel's shares total",
);
assert.equal(
  sumReported("shares", [{ ...ytPlain, shares: 0 }], (e) => e.shares),
  null,
  "an unconnected youtube row contributes nothing, so the total is absent not zero",
);
assert.equal(
  sumReported("shares", [{ ...ytDirect, shares: 12 }, { ...ytPlain, shares: 0 }], (e) => e.shares),
  12,
  "a mixed post totals only the rows that actually measured it",
);

// follows is the item this was built for: an empty platform set, so it can
// ONLY ever arrive from a directly connected row.
assert.equal(METRIC_REPORTED_BY.follows.size, 0, "still no platform reports follows in general");
assert.equal(
  sumReported("follows", [{ ...ytDirect, follows: 37 }], (e) => e.follows),
  37,
  "subscribers gained arrives once the channel is connected",
);
assert.equal(
  sumReported("follows", [{ platform: "instagram", follows: 0 }], (e) => e.follows),
  null,
  "an instagram reel reports no follows, so it prints nothing rather than 0",
);

/* ---- the set-level helpers ---- */

assert.ok(
  reportsMetricOn("follows", [ytPlain, ytDirect]),
  "one connected row is enough for the metric to be worth showing",
);
assert.ok(!reportsMetricOn("follows", [ytPlain]), "no connected row means nothing to show");
assert.ok(
  metricMeasurableOn("follows", [{ platforms: ["youtube"], byPlatform: [ytDirect] }]),
  "measurable across a set when a row measured it",
);
assert.ok(
  !metricMeasurableOn("follows", [{ platforms: ["youtube"], byPlatform: [ytPlain] }]),
  "not measurable when no row did",
);
// Falls back to the platform answer when a post carries no per-platform rows.
assert.ok(
  metricMeasurableOn("views", [{ platforms: ["youtube"], byPlatform: [] }]),
  "a post with no entries still answers from its platforms",
);

console.log("platformMetrics.check.ts: row-aware checks ok");
