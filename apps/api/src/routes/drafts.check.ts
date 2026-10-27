// S5 drafts through the real auth hook, database stubbed: PUT saves draft
// fields only (create on a new id, replace while still a draft), overrides
// persist and an absent key resets, and nothing schedules: no queue job, no
// scheduledAt, no status change, the scheduled post next to it untouched.
import assert from "node:assert/strict";

// Any pg-boss call would throw without a database url and fail the request.
delete process.env.DATABASE_URL;

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { draftRoutes } = await import("./drafts");

type Row = Record<string, any>;
const clients = [
  { id: "c1", agencyId: "agencyA", deletedAt: null },
  { id: "c2", agencyId: "agencyB", deletedAt: null },
];
const assets = [
  { id: "vid1", clientId: "c1" },
  { id: "vid9", clientId: "c2" },
];
const accounts = [
  { id: "acc-yt", clientId: "c1", platform: "youtube", connectedAt: new Date(1) },
  { id: "acc-ig", clientId: "c1", platform: "instagram", connectedAt: new Date(1) },
  { id: "acc-tt", clientId: "c1", platform: "tiktok", connectedAt: new Date(1) },
  { id: "acc-b", clientId: "c2", platform: "youtube", connectedAt: new Date(1) },
];
const posts: Row[] = [
  { id: "sched1", clientId: "c1", mediaAssetId: "vid1", createdById: "owner1", status: "scheduled", deletedAt: null, createdAt: new Date(1) },
  { id: "foreign", clientId: "c2", mediaAssetId: "vid9", createdById: "ownerB", status: "draft", deletedAt: null, createdAt: new Date(1) },
];
let seq = 0;
const targets: Row[] = [
  { id: "t-sched", postId: "sched1", platform: "youtube", socialAccountId: "acc-yt", caption: "live", options: {}, overrides: {}, scheduledAt: new Date("2026-11-01T18:00:00Z"), status: "scheduled", createdAt: new Date(seq++) },
];
const scheduledBefore = JSON.stringify(targets);

const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
const withTargets = (p: Row) => ({
  ...structuredClone(p),
  client: { agencyId: clients.find((c) => c.id === p.clientId)!.agencyId },
  targets: structuredClone(targets.filter((t) => t.postId === p.id).sort((a, b) => a.createdAt - b.createdAt)),
});
stub("post", {
  findUnique: async ({ where }: Row) => {
    const p = posts.find((x) => x.id === where.id);
    return p ? withTargets(p) : null;
  },
  create: async ({ data }: Row) => {
    assert.equal(data.status, "draft");
    posts.push({ deletedAt: null, createdAt: new Date(seq++), ...data });
  },
  update: async ({ where, data }: Row) => {
    assert.deepEqual(Object.keys(data).sort(), ["clientId", "mediaAssetId"], "draft fields only, never status");
    Object.assign(posts.find((p) => p.id === where.id)!, data);
  },
});
const writeOk = (data: Row) => {
  assert.equal(data.scheduledAt, null, "a draft never gets a scheduled time");
  assert.equal("status" in data, false, "a draft target's status is never written");
};
stub("postTarget", {
  create: async ({ data }: Row) => {
    writeOk(data);
    targets.push({ id: `t${seq}`, status: "scheduled", createdAt: new Date(seq++), ...data });
  },
  update: async ({ where, data }: Row) => {
    writeOk(data);
    const t = targets.find((x) => x.id === where.id)!;
    assert.equal(posts.find((p) => p.id === t.postId)!.status, "draft");
    Object.assign(t, data);
  },
  deleteMany: async ({ where }: Row) => {
    for (let i = targets.length - 1; i >= 0; i--) {
      const t = targets[i]!;
      if (t.postId === where.postId && !where.platform.notIn.includes(t.platform)) targets.splice(i, 1);
    }
  },
});
stub("$transaction", async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
stub("$executeRaw", () => assert.fail("no raw sql"));
stub("$queryRaw", () => assert.fail("no raw sql"));
stub("client", {
  findFirst: async ({ where }: Row) => clients.find((c) => c.id === where.id && c.agencyId === where.agencyId) ?? null,
});
stub("mediaAsset", {
  findFirst: async ({ where }: Row) => assets.find((a) => a.id === where.id && a.clientId === where.clientId) ?? null,
});
stub("socialAccount", {
  findMany: async ({ where }: Row) =>
    accounts.filter((a) => a.clientId === where.clientId && where.platform.in.includes(a.platform)),
});
stub("user", {
  findFirst: async ({ where }: Row) => (where.agencyId === "agencyA" && (where.id === "owner1" || where.role === "owner") ? { id: "owner1" } : null),
});
stub("botIdentity", { findUnique: async () => null });

const app = Fastify();
await app.register(jwt, { secret: "drafts-check" });
await app.register(draftRoutes);
const token = (extra: object = {}) => app.jwt.sign({ sub: "owner1", agencyId: "agencyA", ...extra });
const req = (method: "GET" | "PUT", url: string, payload?: object, t = token()) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, ...(payload ? { payload } : {}) });

const body = {
  brandId: "c1",
  videoId: "vid1",
  caption: "Four angles, one weekend.",
  title: "M3 weekend",
  postAt: "2026-11-02T18:00:00.000Z",
  targets: [
    { platform: "youtube", overrides: {} },
    { platform: "instagram", overrides: { caption: "ig only", postAt: "2026-11-02T20:00:00.000Z" } },
  ],
};

// Create on a new id, then read it back.
let res = await req("PUT", "/drafts/d1", body);
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json(), { id: "d1", ...body });
assert.equal(posts.find((p) => p.id === "d1")!.status, "draft");
assert.deepEqual(targets.filter((t) => t.postId === "d1").map((t) => t.socialAccountId), ["acc-yt", "acc-ig"]);
res = await req("GET", "/drafts/d1");
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json(), { id: "d1", ...body });

// Replace: the IG caption override resets by omission, TikTok joins, YouTube leaves, title cleared.
const ig = targets.find((t) => t.postId === "d1" && t.platform === "instagram")!.id;
const { title: _t, ...noTitle } = body;
const next = {
  ...noTitle,
  caption: "New caption",
  targets: [
    { platform: "instagram", overrides: { postAt: "2026-11-02T20:00:00.000Z" } },
    { platform: "tiktok", overrides: { cover: "frame:1200" } },
  ],
};
res = await req("PUT", "/drafts/d1", next);
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json(), { id: "d1", ...next });
assert.equal("caption" in targets.find((t) => t.id === ig)!.overrides, false, "reset = key absent");
assert.equal(targets.find((t) => t.id === ig)!.id, ig, "the same target row is updated");
assert.deepEqual(targets.filter((t) => t.postId === "d1").map((t) => t.platform), ["instagram", "tiktok"]);

// No scheduling side effects anywhere.
assert.equal(posts.find((p) => p.id === "d1")!.status, "draft");
assert.ok(targets.filter((t) => t.postId === "d1").every((t) => t.scheduledAt === null));
assert.equal(JSON.stringify(targets.filter((t) => t.postId === "sched1")), scheduledBefore, "the scheduled post is untouched");

// Refusals.
assert.equal((await req("PUT", "/drafts/sched1", body)).statusCode, 409, "already scheduled");
posts.push({ id: "pub1", clientId: "c1", mediaAssetId: "vid1", createdById: "owner1", status: "posted", deletedAt: null, createdAt: new Date(1) });
assert.equal((await req("PUT", "/drafts/pub1", body)).statusCode, 409, "already published");
assert.equal((await req("GET", "/drafts/foreign")).statusCode, 404, "another agency's draft");
assert.equal((await req("PUT", "/drafts/foreign", body)).statusCode, 404, "another agency's draft");
assert.equal((await req("GET", "/drafts/nope")).statusCode, 404);
assert.equal((await req("PUT", "/drafts/d2", { ...body, brandId: "c2" })).statusCode, 404, "another agency's brand");
assert.equal((await req("PUT", "/drafts/d2", { ...body, brandId: "ghost" })).statusCode, 404, "unknown brand");
assert.equal((await req("PUT", "/drafts/d2", { ...body, videoId: "vid9" })).statusCode, 404, "video of another brand");
assert.equal((await req("PUT", "/drafts/d2", { ...body, caption: 5 })).statusCode, 400);
assert.equal((await req("PUT", "/drafts/d2", { ...body, postAt: "tomorrow" })).statusCode, 400);
assert.equal((await req("PUT", "/drafts/d2", { ...body, targets: [{ platform: "snapchat", overrides: {} }] })).statusCode, 400);
assert.equal((await req("PUT", "/drafts/d2", { ...body, targets: [{ platform: "tiktok", overrides: { caption: undefined, color: "red" } }] })).statusCode, 400);
assert.equal((await req("PUT", "/drafts/d2", { ...body, targets: [] })).statusCode, 400);
assert.equal((await req("PUT", "/drafts/d2", { ...body, targets: [body.targets[0], body.targets[0]] })).statusCode, 400);
assert.equal(posts.some((p) => p.id === "d2"), false, "nothing refused is saved");

// Who: Polly has full access, other bots keep their scope, viewers read only.
assert.equal((await req("GET", "/drafts/d1", undefined, token({ role: "bot", bot: "polly", sub: "deploy-script" }))).statusCode, 200);
res = await req("PUT", "/drafts/d3", body, token({ role: "bot", bot: "polly", sub: "deploy-script" }));
assert.equal(res.statusCode, 200, res.body);
assert.equal(posts.find((p) => p.id === "d3")!.createdById, "owner1", "a bot acts as the agency owner");
assert.equal((await req("GET", "/drafts/d1", undefined, token({ role: "bot", bot: "nova" }))).statusCode, 403);
assert.equal((await req("PUT", "/drafts/d4", body, token({ role: "bot", bot: "nova" }))).statusCode, 403);
assert.equal((await req("GET", "/drafts/d1", undefined, token({ role: "viewer" }))).statusCode, 200);
assert.equal((await req("PUT", "/drafts/d1", body, token({ role: "viewer" }))).statusCode, 403);
assert.equal(posts.some((p) => p.id === "d4"), false);

await app.close();
console.log("drafts.check: all checks passed");
