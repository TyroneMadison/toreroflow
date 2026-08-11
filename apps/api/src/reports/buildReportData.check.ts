/*
 * The client-facing arithmetic.
 *
 * Everything checked here renders on a page a paying client reads, so a wrong
 * number is not a bug they report, it is a number they believe. The two
 * properties this file exists to hold are that a metric a platform never
 * measured is absent rather than zero, and that a metric one platform reports
 * never absorbs a value from a platform it is suppressed for.
 */
import assert from "node:assert/strict";
import { buildReportData, fmtWatchTotal, lastRefreshed, measured, platformRows } from "./buildReportData";
import type { ReportPost } from "./buildReportData";

/** A post with everything defaulted, so each case states only what it is about. */
function post(over: Partial<ReportPost> = {}): ReportPost {
  return {
    mediaType: "video",
    title: "A video",
    publishedAt: "2026-08-05T12:00:00.000Z",
    views: 1000,
    likes: 10,
    comments: 2,
    shares: 1,
    saves: 0,
    reach: 0,
    avgWatchSec: null,
    durationSec: null,
    platforms: ["instagram"],
    byPlatform: [],
    ...over,
  };
}

/** One byPlatform entry with everything absent unless stated. */
function entry(platform: string, over: Partial<ReportPost["byPlatform"][number]> = {}) {
  return {
    platform,
    views: 0,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    reach: null,
    impressions: null,
    clicks: null,
    avgWatchSec: null,
    totalWatchSec: null,
    ...over,
  };
}

/* ---- fmtWatchTotal, both boundaries ---- */

assert.equal(fmtWatchTotal(9), "9s", "under a minute is seconds alone");
assert.equal(fmtWatchTotal(59), "59s", "the last second before the minute boundary");
assert.equal(fmtWatchTotal(60), "1m 00s", "exactly a minute rolls over, padded");
assert.equal(fmtWatchTotal(1652), "27m 32s");
assert.equal(fmtWatchTotal(3599), "59m 59s", "the last second before the hour boundary");
assert.equal(fmtWatchTotal(3600), "1h 00m", "exactly an hour rolls over, padded");
assert.equal(fmtWatchTotal(7830), "2h 10m");
assert.equal(fmtWatchTotal(0), "0s", "a caller that got this far already decided it was real");

/* ---- measured: absent beats zero ---- */

assert.equal(measured("clicks", ["facebook"], 7), "7", "facebook reports clicks");
assert.equal(measured("clicks", ["instagram"], 7), null, "instagram's clicks field is always zero");
assert.equal(measured("saves", ["instagram"], 0), "0", "a post that genuinely earned no saves says so");
assert.equal(measured("clicks", ["facebook"], 0), "0", "a post nobody clicked genuinely got no clicks");
assert.equal(
  measured("reach", ["instagram"], 0),
  null,
  "a post with views did not reach nobody, so a zero reach is uncomputed and absent",
);
assert.equal(measured("reach", ["instagram"], 4200), "4,200", "a real reach still renders");
assert.equal(measured("reach", ["instagram"], null), null, "nothing measured means nothing shown");

/* ---- the whole report, over the case that shipped wrong ---- */

/*
 * CRITICAL. One video cross-posted to Instagram and Facebook. Instagram sends
 * impressions on 275 of 279 posts and the value mirrors its views, which is why
 * the matrix suppresses it. Reading the post-level aggregate because Facebook
 * is somewhere on the list printed 12,900 Impressions beside 12,400 Views, and
 * it looks plausible enough to ship. Only Facebook's 900 was ever measured.
 *
 * ReportPost no longer carries that 12,900 at all: the post-level impressions,
 * clicks and totalWatchSec fields are gone, so the wrong number cannot be
 * reached from here even by mistake. The byPlatform entries below are the whole
 * input, and 900 is the only impressions figure in them.
 */
const cross = post({
  title: "Cross-posted",
  views: 12_400,
  reach: 11_650,
  platforms: ["instagram", "facebook"],
  byPlatform: [
    entry("instagram", {
      views: 12_000,
      impressions: 12_000,
      reach: 11_400,
      saves: 61,
      totalWatchSec: 1652,
    }),
    entry("facebook", { views: 400, impressions: 900, reach: 250, clicks: 7 }),
  ],
});

const built = buildReportData({
  clientName: "A client",
  businessName: "Torerone",
  accounts: [],
  posts: [cross],
  periodStart: new Date("2026-08-01T00:00:00.000Z"),
  periodEnd: new Date("2026-08-31T23:59:59.000Z"),
});
const videos = built.videos as Array<Record<string, unknown>>;
assert.equal(videos.length, 1, "the period has one video");
assert.equal(
  videos[0]!.impressions,
  "900",
  "only facebook's impressions count; instagram's mirror of views must never be folded in",
);
// 11,400 + 250, compacted by fmt above 10,000.
assert.equal(videos[0]!.reach, "11.7K", "both platforms report reach, so both count");
assert.equal(videos[0]!.saves, "61", "saves come from instagram alone");
assert.equal(videos[0]!.clicks, "7", "clicks come from facebook alone");
assert.equal(
  videos[0]!.totalWatch,
  "27m 32s",
  "watch time is totalled off byPlatform like the other four, not read off a post aggregate",
);

/*
 * IMPORTANT 4. MergedPost.reach is a non-nullable number defaulted to 0, so a
 * post the platform reported no reach for arrives as a zero rather than an
 * absence. Instagram misses it on roughly 4 posts a client-year, and "Reach 0"
 * on a paid report reads as an audience of nobody.
 */
const zeroed = buildReportData({
  clientName: "A client",
  businessName: "Torerone",
  accounts: [],
  posts: [
    post({
      title: "Reach never arrived",
      platforms: ["instagram", "facebook"],
      byPlatform: [entry("instagram", { views: 900, reach: 0, saves: 0 }), entry("facebook", { views: 100, clicks: 0 })],
    }),
  ],
  periodStart: new Date("2026-08-01T00:00:00.000Z"),
  periodEnd: new Date("2026-08-31T23:59:59.000Z"),
});
const zeroVideo = (zeroed.videos as Array<Record<string, unknown>>)[0]!;
assert.equal(zeroVideo.reach, null, "a zero reach is unmeasured and renders as no pill at all");
assert.equal(zeroVideo.clicks, "0", "a zero clicks is a real result and still prints");
assert.equal(zeroVideo.saves, "0", "a post that genuinely earned no saves still prints Saves 0");
assert.equal(
  zeroVideo.impressions,
  null,
  "facebook reports impressions and supplied none for this post, so the card prints nothing rather than inventing a zero from the absence",
);
assert.equal(
  zeroVideo.totalWatch,
  null,
  "no entry carried watch time, so the card says nothing about how long it was watched",
);

/*
 * The zeros that cannot be results, at the surface a client reads.
 *
 * Impressions count every time the post was put on a screen, so a post with
 * 400 views cannot have 0 of them, the same argument that put reach in the set.
 * Watch time is the same: a video with views was not watched for zero seconds
 * by everyone. Clicks and saves are deliberately outside the rule and their
 * zeros still print.
 */
const impossible = buildReportData({
  clientName: "A client",
  businessName: "Torerone",
  accounts: [],
  posts: [
    post({
      title: "Zeros a provider never computed",
      platforms: ["facebook", "instagram"],
      byPlatform: [
        entry("facebook", { views: 400, impressions: 0, clicks: 0 }),
        entry("instagram", { views: 600, totalWatchSec: 0, saves: 0 }),
      ],
    }),
  ],
  periodStart: new Date("2026-08-01T00:00:00.000Z"),
  periodEnd: new Date("2026-08-31T23:59:59.000Z"),
});
const impossibleVideo = (impossible.videos as Array<Record<string, unknown>>)[0]!;
assert.equal(
  impossibleVideo.impressions,
  null,
  "a post with 400 views was not shown zero times, so a zero impressions is an uncomputed metric",
);
assert.equal(
  impossibleVideo.totalWatch,
  null,
  "a viewed video was not watched for zero seconds, and this is the first consumer that pins it rather than declaring it",
);
assert.equal(impossibleVideo.clicks, "0", "a post with no link genuinely got no clicks");
assert.equal(impossibleVideo.saves, "0", "a post nobody saved genuinely earned no saves");

/* ---- platformRows: each row answers only for its own platform ---- */

const rows = platformRows(cross);
assert.equal(rows.length, 2, "a cross-post gets one row per platform");
const ig = rows.find((r) => r.platform === "Instagram")!;
const fb = rows.find((r) => r.platform === "Facebook")!;
assert.equal(
  ig.stats.some((s) => s.label === "Impressions"),
  false,
  "the instagram row never shows impressions, whatever the post's other platforms report",
);
assert.equal(fb.stats.find((s) => s.label === "Impressions")?.value, "900");
assert.equal(ig.stats.find((s) => s.label === "Saves")?.value, "61");
assert.equal(
  fb.stats.some((s) => s.label === "Saves"),
  false,
  "facebook has no save button, so the row leaves it out rather than printing a zero",
);
assert.equal(
  ig.stats.find((s) => s.label === "Watched")?.value,
  "27m 32s",
  "watch time goes through the same measured() path as the other pills, formatted rather than counted",
);
assert.equal(
  fb.stats.some((s) => s.label === "Watched"),
  false,
  "no platform but instagram reports watch time through the provider",
);
assert.equal(
  platformRows(
    post({
      platforms: ["instagram", "facebook"],
      byPlatform: [
        entry("instagram", { views: 900, totalWatchSec: 0 }),
        entry("facebook", { views: 100 }),
      ],
    }),
  )
    .find((r) => r.platform === "Instagram")!
    .stats.some((s) => s.label === "Watched"),
  false,
  "a zero watch time on a viewed post is uncomputed, so the pill is absent rather than reading 0s",
);
assert.equal(
  platformRows(post({ byPlatform: [entry("instagram", { views: 5 })] })).length,
  0,
  "a single-platform video has no split worth drawing",
);

/* ---- the footer's refresh line ---- */

assert.equal(
  lastRefreshed([
    post({ metricsUpdatedAt: "2026-08-08T09:00:00.000Z" }),
    post({ metricsUpdatedAt: "2026-08-10T21:16:37.000Z" }),
  ]),
  "Figures last refreshed 10 Aug",
  "the most recent refresh across the period, which is the question being asked",
);
assert.equal(lastRefreshed([post()]), null, "no timestamp anywhere means the line is omitted");
assert.equal(lastRefreshed([post({ metricsUpdatedAt: "not-a-date" })]), null, "garbage omits it too");
assert.equal(
  lastRefreshed([post({ metricsUpdatedAt: "not-a-date" }), post({ metricsUpdatedAt: "2026-08-08T09:00:00.000Z" })]),
  "Figures last refreshed 8 Aug",
  "one unparseable timestamp does not suppress the real one beside it",
);
assert.equal(
  ((built.footer as Record<string, unknown>) ?? {}).refreshed,
  undefined,
  "a period whose posts carry no timestamp gets no refreshed line at all",
);

console.log("buildReportData.check.ts: ok");
