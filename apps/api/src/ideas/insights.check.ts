// Merged insights: the same number from two sources collapses to one row,
// the platform's own API wins, then Zernio, then Toreroflow, every source is
// attributed, and Zernio without the Analytics add-on is reported as
// unavailable rather than failing the request. All fixtures, no network.
import assert from "node:assert/strict";

process.env.PUBLISH_PROVIDER = "zernio";
process.env.PUBLISH_PROVIDER_API_KEY = "sk_test";
delete process.env.BOT_FULL_ACCESS;
const { getPrisma } = await import("@toreroflow/db");
const { MergedInsightSchema, InsightsResponseSchema } = await import("@toreroflow/contracts");
const { mergeInsights, zernioReadings } = await import("./insights");
const { insightsRoutes } = await import("../routes/insights");
const { testApp } = await import("./testApp");

// ---- pure merge ----
const merged = mergeInsights("p1", [
  { source: "toreroflow", platform: "youtube", metric: "views", value: 100, day: "2026-10-20" },
  { source: "zernio", platform: "youtube", metric: "views", value: 120, day: "2026-10-21" },
  { source: "youtube", platform: "youtube", metric: "views", value: 130, day: "2026-10-19" },
  { source: "toreroflow", platform: "instagram", metric: "views", value: 50, day: "2026-10-20" },
  { source: "toreroflow", platform: "instagram", metric: "views", value: 40, day: "2026-10-10" },
  { source: "zernio", platform: "instagram", metric: "likes", value: 7, day: "2026-10-21" },
  { source: "zernio", platform: "instagram", metric: "likes", value: Number.NaN, day: "2026-10-22" },
]);
for (const m of merged) MergedInsightSchema.parse(m);
const row = (platform: string, metric: string) => merged.find((m) => m.platform === platform && m.metric === metric)!;
assert.equal(row("youtube", "views").value, 130, "the platform's own API wins");
assert.equal(row("youtube", "views").chosenSource, "youtube");
assert.deepEqual(row("youtube", "views").sources.sort(), ["toreroflow", "youtube", "zernio"]);
assert.equal(row("instagram", "views").value, 50, "same source twice: the newest");
assert.deepEqual(row("instagram", "views").sources, ["toreroflow"]);
assert.equal(row("instagram", "likes").value, 7, "a non-number is dropped");
assert.equal(row("total", "views").value, 180);
assert.deepEqual(row("total", "views").sources.sort(), ["toreroflow", "youtube"]);
assert.equal(new Set(merged.map((m) => m.dedupeKey)).size, merged.length, "one row per number");
assert.equal(mergeInsights("p", [{ source: "toreroflow", platform: "tiktok", metric: "views", value: 1, day: "2026-10-01" }]).length, 1, "no total for one platform");

assert.deepEqual(
  zernioReadings({ lastUpdated: "2026-10-21T08:00:00Z", platforms: [{ accountId: "z-ig", analytics: { views: 90, likeCount: 4 } }, { accountId: "z-x", analytics: { views: 1 } }] }, new Map([["z-ig", "instagram"]])),
  [
    { source: "zernio", platform: "instagram", metric: "views", value: 90, day: "2026-10-21" },
    { source: "zernio", platform: "instagram", metric: "likes", value: 4, day: "2026-10-21" },
  ],
  "an entry for an account that is not on the post, and with no platform, is ignored",
);

// ---- the route, on fixtures ----
const POST = {
  id: "post1",
  targets: [
    {
      platform: "instagram",
      socialAccountId: "sa-ig",
      remotePostId: "late1",
      remoteUrl: "https://instagram.com/reel/abc",
      publishedAt: new Date("2026-10-15T15:00:00Z"),
      socialAccount: { providerAccountId: "z-ig" },
      postMetrics: [{ capturedAt: new Date("2026-10-18T00:00:00Z"), views: 800, likes: 30, comments: null, shares: null, saves: null }],
    },
    {
      platform: "youtube",
      socialAccountId: "sa-yt",
      remotePostId: "late1",
      remoteUrl: "https://youtube.com/shorts/xyz",
      publishedAt: new Date("2026-10-15T15:00:00Z"),
      socialAccount: { providerAccountId: "z-yt" },
      postMetrics: [],
    },
  ],
};
const prisma = getPrisma();
Object.defineProperty(prisma, "post", {
  value: { findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) => (where.id === POST.id && where.client.agencyId === "A" ? POST : null) },
});
Object.defineProperty(prisma, "externalVideo", {
  value: {
    findMany: async () => [
      { platform: "youtube", source: "youtube", directMetrics: [], metricsUpdatedAt: new Date("2026-10-20T00:00:00Z"), fetchedAt: new Date(), views: 1500, likes: 60, comments: 5, shares: 0, saves: 0, reach: 0, impressions: null },
      { platform: "instagram", source: "zernio", directMetrics: ["reach"], metricsUpdatedAt: new Date("2026-10-19T00:00:00Z"), fetchedAt: new Date(), views: 850, likes: 31, comments: 2, shares: 1, saves: 3, reach: 600, impressions: null },
    ],
  },
});

let zernioStatus = 200;
const zernioCalls: string[] = [];
globalThis.fetch = (async (url: string) => {
  zernioCalls.push(url);
  if (zernioStatus !== 200) return new Response(JSON.stringify({ error: "Analytics add-on required" }), { status: zernioStatus });
  return new Response(
    JSON.stringify({
      analytics: [
        { _id: "zz", latePostId: "late1", lastUpdated: "2026-10-21T00:00:00Z", platforms: [{ accountId: "z-ig", analytics: { views: 900, likes: 33 } }] },
        { _id: "other", latePostId: "nope", platforms: [{ accountId: "z-ig", analytics: { views: 5 } }] },
      ],
      pagination: { pages: 1 },
    }),
    { status: 200 },
  );
}) as typeof fetch;

const { app, operator, polly, nova, otherAgency } = await testApp(insightsRoutes);
let res = await app.inject({ method: "GET", url: "/insights/post1", headers: polly });
assert.equal(res.statusCode, 200, res.body);
let body = InsightsResponseSchema.parse(res.json());
const get = (platform: string, metric: string) => body.insights.find((m) => m.platform === platform && m.metric === metric)!;
assert.match(zernioCalls[0]!, /fromDate=2026-10-14&toDate=2026-10-16/);
assert.equal(get("instagram", "views").value, 900, "Zernio live beats the stored copy (newer) and Toreroflow");
assert.deepEqual(get("instagram", "views").sources.sort(), ["toreroflow", "zernio"]);
assert.equal(get("instagram", "reach").chosenSource, "instagram", "a metric the platform API filled is the platform's");
assert.equal(get("youtube", "views").value, 1500);
assert.equal(get("youtube", "views").chosenSource, "youtube");
assert.equal(get("total", "views").value, 2400);
assert.deepEqual(body.unavailable, []);

// No Analytics add-on: still 200, Zernio listed as unavailable, the rest stands.
zernioStatus = 402;
res = await app.inject({ method: "GET", url: "/insights/post1", headers: operator });
assert.equal(res.statusCode, 200, res.body);
body = InsightsResponseSchema.parse(res.json());
assert.deepEqual(body.unavailable, [{ source: "zernio", reason: "Zernio analytics needs the Analytics add-on on this plan" }]);
assert.equal(get("instagram", "views").value, 850, "falls back to the stored copy");
zernioStatus = 500;
res = await app.inject({ method: "GET", url: "/insights/post1", headers: operator });
assert.match(res.json().unavailable[0].reason, /^Zernio analytics unavailable/);

res = await app.inject({ method: "GET", url: "/insights/post1", headers: otherAgency });
assert.equal(res.statusCode, 404);
res = await app.inject({ method: "GET", url: "/insights/post1", headers: nova });
assert.equal(res.statusCode, 403);

await app.close();
console.log("insights.check: ok");
