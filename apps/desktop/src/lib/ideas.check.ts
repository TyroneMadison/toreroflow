/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * The pure logic behind the ideas screens.
 */
import {
  assetQuery,
  brandCaptionPatch,
  modelsFor,
  sunraProblem,
  bestTime,
  compact,
  etDayHour,
  expiryLabel,
  fmtClock,
  googleFontsHref,
  insightTable,
  linkState,
  logoBox,
  maxSlides,
  monthLabel,
  nextRunLabel,
  pickWeight,
  previousMonth,
  publicLink,
  recentMonths,
  repurposeProgress,
  slotLabel,
  stepStatus,
} from "./ideas";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  got      ${a}`);
}

// Time in ET, across the DST change.
eq(etDayHour("2026-10-29T22:00:00Z"), { day: 3, hour: 18 }, "Thu 6 PM EDT");
eq(etDayHour("2026-11-05T23:00:00Z"), { day: 3, hour: 18 }, "Thu 6 PM EST, after the clocks go back");
eq(etDayHour("2026-11-02T04:30:00Z"), { day: 6, hour: 23 }, "late Sunday ET is still Sunday");
eq(fmtClock(320_000), "0:05:20", "a moment in a video");
eq(fmtClock(3_725_000), "1:02:05", "past an hour");

// Approval links.
const now = new Date("2026-10-26T16:00:00Z");
eq(expiryLabel(168, now), "In 7 days (Nov 2)", "the expiry option names its date");
eq(expiryLabel(24, now), "In 1 day (Oct 27)", "one day is singular");
eq(linkState({ status: "approved", expiresAt: "2026-10-27T00:00:00Z", revokedAt: null }, now), "approved", "a live answer stands");
eq(linkState({ status: "approved", expiresAt: "2026-10-25T00:00:00Z", revokedAt: null }, now), "expired", "expiry wins");
eq(linkState({ status: "pending", expiresAt: "2026-10-30T00:00:00Z", revokedAt: "2026-10-26T00:00:00Z" }, now), "revoked", "revoke wins");
eq(publicLink("https://app.torerone.com/", "/a/abc.def"), "https://app.torerone.com/a/abc.def", "one slash between base and path");

// Brand kit.
eq(
  googleFontsHref([{ family: "Archivo Black", weights: [400] }, { family: "Inter", weights: [700, 400, 400] }]),
  "https://fonts.googleapis.com/css2?family=Archivo+Black:wght@400&family=Inter:wght@400;700&display=swap",
  "one CSS link, weights sorted and unique",
);
eq(googleFontsHref([]), null, "no fonts, no link");
eq([pickWeight([200, 500, 900], "headline"), pickWeight([200, 500, 900], "body"), pickWeight([], "body")], [900, 500, 400], "weights per role");
eq(logoBox(1080, 1920, 400, 200), { x: 821, y: 1769, w: 216, h: 108 }, "logo bottom right, a fifth of the short side");

// Monthly report.
eq(previousMonth(new Date("2026-11-01T03:00:00Z")), "2026-09", "Oct 31 at 11 PM ET is still October, so September ended");
eq(previousMonth(new Date("2026-11-01T05:00:00Z")), "2026-10", "Nov 1 ET: October just ended");
eq(previousMonth(new Date("2027-01-15T12:00:00Z")), "2026-12", "January looks back to December");
eq(recentMonths(3, new Date("2027-02-10T12:00:00Z")), ["2027-01", "2026-12", "2026-11"], "months back across the year");
eq(monthLabel("2026-10"), "October 2026", "month label");
eq(nextRunLabel(new Date("2026-12-20T12:00:00Z")), "Jan 1", "the next run after December");
eq([compact(212_000), compact(1_140), compact(950), compact(1_400_000)], ["212K", "1.1K", "950", "1.4M"], "compact numbers");

// Best time to post.
const thu6 = (week: number, views: number) => ({ publishedAt: new Date(Date.UTC(2026, 9, 29 - week * 7, 22)).toISOString(), views });
const tue9a = (week: number, views: number) => ({ publishedAt: new Date(Date.UTC(2026, 9, 27 - week * 7, 13)).toISOString(), views });
const posts = [
  ...[0, 1, 2, 3, 4, 5].map((w) => thu6(w, 3000)),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((w) => tue9a(w, 1000)),
  { publishedAt: "2026-10-24T16:00:00Z", views: 9_000 }, // one lucky Saturday
  { publishedAt: "2026-05-01T16:00:00Z", views: 1_000_000 }, // outside 90 days
];
const bt = bestTime(posts, new Date("2026-10-30T12:00:00Z"));
eq(bt.count, 15, "only the last 90 days count");
eq(bt.enough, false, "under 20 posts is not enough");
eq(bt.slots.map((s) => [s.day, s.band, s.posts]), [[3, 18, 6]], "a one-post cell never tops the list, and below-average cells are not suggested");
eq(bt.grid[5]![4], 9_000, "the lucky Saturday still shows on the heatmap");
eq(bt.slots[0]!.uplift, Math.round((3000 / ((6 * 3000 + 8 * 1000 + 9_000) / 15) - 1) * 100), "uplift against the average post");
eq(bestTime([...Array(20)].map((_, i) => thu6(i % 12, 10)), new Date("2026-10-30T12:00:00Z")).enough, true, "20 posts is enough");
eq(slotLabel({ day: 3, band: 18 }), "Thu 6 to 9 PM ET", "slot label");
eq(slotLabel({ day: 1, band: 9 }), "Tue 9 AM to 12 PM ET", "a band across noon names both halves");

// Merged insights table.
const t = insightTable([
  { metric: "views", platform: "instagram", value: 1 },
  { metric: "views", platform: "total", value: 3 },
  { metric: "views", platform: "tiktok", value: 2 },
  { metric: "likes", value: 4 },
]);
eq(t.map((r) => [r.metric, Object.keys(r.cells)]), [["views", ["instagram", "total", "tiktok"]], ["likes", ["total"]]], "one row per metric");

// Asset filters.
eq(assetQuery({ brandId: "", type: "", sharing: "all" }), "/assets", "no filters");
eq(assetQuery({ brandId: "caleb", type: "logo", sharing: "brand" }), "/assets?brandId=caleb&type=logo&sharing=brand", "every filter");

// Sunra.
eq([maxSlides("instagram"), maxSlides("tiktok")], [10, 20], "slide caps per platform");
const ms = [
  { id: "a", supportedAspectRatios: ["4:5", "1:1"] },
  { id: "b", supportedAspectRatios: ["9:16"] },
  { id: "c", supportedAspectRatios: [] },
];
eq(modelsFor(ms, "instagram").map((m) => m.id), ["a", "c"], "Instagram shows 4:5 models and the ones Sunra did not describe");
eq(modelsFor(ms, "tiktok").map((m) => m.id), ["b", "c"], "TikTok shows 9:16 models");
eq(sunraProblem(503, "x").notConnected, true, "503 is not connected");
eq(sunraProblem(400, "Unknown Sunra image model: z").newPrice, true, "a 400 needs a new price");
eq(sunraProblem(502, "timeout").text.includes("Nothing was charged"), true, "a 502 says nothing was charged");
eq(sunraProblem(410, "this quote has expired").newPrice, true, "an expired quote needs a new price");
eq(sunraProblem(null, "offline").text, "offline", "no status passes the message through");

// Editor: Apply brand kit.
const fonts = ["Anton", "Montserrat"];
eq(
  brandCaptionPatch({ fonts: [{ family: "Archivo Black", weights: [400] }, { family: "Montserrat", weights: [700] }], colors: ["#111111", "#c8102e", "#F5F5F5"] }, fonts),
  { accentColor: "#C8102E", font: "Montserrat" },
  "the accent skips near-black, the font is the first one the export can draw",
);
eq(brandCaptionPatch({ fonts: [{ family: "Inter", weights: [400] }], colors: ["#000000", "#FFFFFF"] }, fonts), {}, "nothing usable changes nothing");

// Repurpose.
const job = { step: "cut", state: "running" } as const;
eq(["transcribe", "find_moments", "cut", "captions"].map((s) => stepStatus(job, s as "cut")), ["done", "done", "running", "todo"], "steps around the current one");
eq(stepStatus({ step: "cut", state: "failed" }, "cut"), "failed", "a failed step shows failed");
eq(stepStatus({ step: "done", state: "done" }, "review"), "done", "a done job is done everywhere");
eq(repurposeProgress(job), 2.5 / 6, "progress counts a running step as half");
eq(repurposeProgress({ step: "transcribe", state: "queued" }), 0, "nothing started");

console.log("ideas: all checks passed");
