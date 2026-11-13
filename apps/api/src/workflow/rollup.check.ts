// W4 rollup against fixtures: the pure aggregation, then the route through
// the real auth hook with the database stubbed. Platform numbers win over
// snapshots, counts add, watch time is views-weighted, a missing platform is
// null (never 0), stories and unposted targets are left out.
import assert from "node:assert/strict";
import { buildRollup } from "./rollup";

const row = (r: ReturnType<typeof buildRollup>, metric: string) => r.rows.find((x) => x.metric === metric)!;

// Pure: counts add, a platform with no post is null everywhere.
let r = buildRollup("v1", [
  { platform: "youtube", views: 1000, likes: 50, comments: 5, shares: null, avgWatchSec: 40 },
  { platform: "instagram", views: 3000, likes: 200, comments: 20, shares: 10, avgWatchSec: 20 },
]);
assert.deepEqual(r.rows.map((x) => x.metric), ["views", "likes", "comments", "shares", "avgWatchSeconds"]);
assert.deepEqual(row(r, "views"), { metric: "views", youtube: 1000, instagram: 3000, tiktok: null, total: 4000 });
assert.deepEqual(row(r, "shares"), { metric: "shares", youtube: null, instagram: 10, tiktok: null, total: 10 }, "an unknown count is not a zero");
assert.deepEqual(row(r, "avgWatchSeconds"), { metric: "avgWatchSeconds", youtube: 40, instagram: 20, tiktok: null, total: 25 }, "(40*1000 + 20*3000) / 4000");

// Two targets on one platform add together; no sources at all is all null.
r = buildRollup("v1", [
  { platform: "tiktok", views: 10, likes: 1, comments: 0, shares: 0, avgWatchSec: null },
  { platform: "tiktok", views: 5, likes: null, comments: 0, shares: 0, avgWatchSec: null },
]);
assert.deepEqual(row(r, "views"), { metric: "views", youtube: null, instagram: null, tiktok: 15, total: 15 });
assert.equal(row(r, "comments").tiktok, 0, "a real zero stays zero");
assert.equal(row(r, "avgWatchSeconds").total, null);
assert.ok(buildRollup("v1", []).rows.every((x) => x.youtube === null && x.instagram === null && x.tiktok === null && x.total === null));

// ---- Route, with fixtures ----
const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { rollupRoutes } = await import("../routes/rollup");

const metric = (views: number, likes: number, comments: number, shares: number) => ({ views, likes, comments, shares });
const FIXTURE = {
  assets: [{ id: "vid1", agencyId: "agencyA" }],
  targets: [
    { mediaAssetId: "vid1", status: "posted", platform: "youtube", socialAccountId: "yt", remoteUrl: "https://youtu.be/abc", options: null, postMetrics: [metric(900, 40, 4, 0)] },
    { mediaAssetId: "vid1", status: "posted", platform: "instagram", socialAccountId: "ig", remoteUrl: "https://instagram.com/reel/x", options: null, postMetrics: [metric(2000, 150, 12, 30)] },
    { mediaAssetId: "vid1", status: "posted", platform: "instagram", socialAccountId: "ig", remoteUrl: null, options: { instagram: { story: true } }, postMetrics: [metric(99999, 0, 0, 0)] },
    { mediaAssetId: "vid1", status: "posted", platform: "tiktok", socialAccountId: "tt", remoteUrl: null, options: null, postMetrics: [] },
    { mediaAssetId: "vid1", status: "scheduled", platform: "tiktok", socialAccountId: "tt", remoteUrl: null, options: null, postMetrics: [metric(5, 5, 5, 5)] },
    { mediaAssetId: "vid1", status: "posted", platform: "facebook", socialAccountId: "fb", remoteUrl: null, options: null, postMetrics: [metric(7, 7, 7, 7)] },
    { mediaAssetId: "vid2", status: "posted", platform: "youtube", socialAccountId: "yt", remoteUrl: null, options: null, postMetrics: [metric(1, 1, 1, 1)] },
  ],
  externalVideos: [
    // YouTube's own lifetime numbers, newer and fuller than the snapshot.
    { socialAccountId: "yt", url: "https://youtu.be/abc", views: 1200, likes: 60, comments: 6, shares: 3, avgWatchSec: 45 },
    // Same URL on another account is not this post.
    { socialAccountId: "other", url: "https://instagram.com/reel/x", views: 1, likes: 1, comments: 1, shares: 1, avgWatchSec: 1 },
  ],
};

const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("mediaAsset", {
  findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
    FIXTURE.assets.find((a) => a.id === where.id && a.agencyId === where.client.agencyId) ?? null,
});
stub("postTarget", {
  findMany: async ({ where }: { where: { status: string; platform: { in: string[] }; post: { mediaAssetId: string } } }) =>
    FIXTURE.targets.filter(
      (t) => t.status === where.status && where.platform.in.includes(t.platform) && t.mediaAssetId === where.post.mediaAssetId,
    ),
});
stub("externalVideo", {
  findMany: async ({ where }: { where: { url: { in: string[] } } }) => FIXTURE.externalVideos.filter((e) => where.url.in.includes(e.url)),
});
stub("botIdentity", { findUnique: async () => null });

const app = Fastify();
await app.register(jwt, { secret: "rollup-check" });
await app.register(rollupRoutes);
const get = (url: string, extra: object = {}) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${app.jwt.sign({ sub: "u1", agencyId: "agencyA", ...extra })}` } });

const res = await get("/rollup/vid1");
assert.equal(res.statusCode, 200, res.body);
const body = res.json();
assert.equal(body.videoId, "vid1");
assert.deepEqual(body.rows, [
  { metric: "views", youtube: 1200, instagram: 2000, tiktok: null, total: 3200 },
  { metric: "likes", youtube: 60, instagram: 150, tiktok: null, total: 210 },
  { metric: "comments", youtube: 6, instagram: 12, tiktok: null, total: 18 },
  { metric: "shares", youtube: 3, instagram: 30, tiktok: null, total: 33 },
  { metric: "avgWatchSeconds", youtube: 45, instagram: null, tiktok: null, total: 45 },
]);

assert.equal((await get("/rollup/nope")).statusCode, 404);
assert.equal(
  (await app.inject({ method: "GET", url: "/rollup/vid1", headers: { authorization: `Bearer ${app.jwt.sign({ sub: "u1", agencyId: "agencyB" })}` } })).statusCode,
  404,
  "another agency's video",
);
assert.equal((await get("/rollup/vid1", { role: "bot", bot: "nova" })).statusCode, 403, "other bots keep their scope");
assert.equal((await get("/rollup/vid1", { role: "bot", bot: "polly" })).statusCode, 200);

await app.close();
console.log("rollup.check: all checks passed");
