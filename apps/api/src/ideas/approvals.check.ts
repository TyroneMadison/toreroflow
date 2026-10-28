// Approval links: signed tokens that cannot be forged or stretched, expiry,
// revoke, the public approve and comment flows, rate limit, and the operator
// routes through the real auth hook (Polly in, other bots out).
import assert from "node:assert/strict";

delete process.env.BOT_FULL_ACCESS;
const { getPrisma } = await import("@toreroflow/db");
const { ApprovalLinkSchema, PublicApprovalSchema } = await import("@toreroflow/contracts");
const { approvalToken, approvalLinkRoutes, publicApprovalRoutes } = await import("../routes/approvals");
const { testApp } = await import("./testApp");

// ---- tokens ----
const exp = new Date("2026-11-01T00:00:00Z");
const t = approvalToken("link1", exp, "s1");
assert.ok(ApprovalLinkSchema.shape.token.safeParse(t).success, "long enough for the contract");
assert.equal(approvalToken("link1", exp, "s1"), t, "deterministic, so it is never stored");
assert.notEqual(approvalToken("link1", new Date(exp.getTime() + 1), "s1"), t, "the expiry is signed");
assert.notEqual(approvalToken("link1", exp, "s2"), t);

// ---- in-memory database ----
const assets = [
  { id: "v2", kind: "video", agencyId: "A", originalName: "m3-walkaround-v2.mp4", storageKey: "caleb/v2/source.mp4", durationSec: 30 },
  { id: "c1", kind: "carousel", agencyId: "A", originalName: "c", storageKey: "c", durationSec: null },
];
const links: Record<string, any>[] = [];
const comments: Record<string, any>[] = [];
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
const assetOf = (l: Record<string, any>) => assets.find((a) => a.id === l.mediaAssetId)!;
const { mockRateLimits } = await import("./testApp");
const buckets = await mockRateLimits();
mock("mediaAsset", {
  findFirst: async ({ where }: { where: { id: string; kind: string; client: { agencyId: string } } }) =>
    assets.find((a) => a.id === where.id && a.kind === where.kind && a.agencyId === where.client.agencyId) ?? null,
});
mock("approvalLink", {
  create: async ({ data }: { data: object }) => {
    const l = { id: `link${links.length + 1}`, status: "pending", revokedAt: null, createdAt: new Date(Date.now() + links.length), ...data };
    links.push(l);
    return l;
  },
  findMany: async ({ where }: { where: { mediaAsset: { client: { agencyId: string } }; mediaAssetId?: string } }) =>
    links
      .filter((l) => assetOf(l).agencyId === where.mediaAsset.client.agencyId && (!where.mediaAssetId || l.mediaAssetId === where.mediaAssetId))
      .reverse(),
  findFirst: async ({ where }: { where: { id: string; mediaAsset: { client: { agencyId: string } } } }) =>
    links.find((l) => l.id === where.id && assetOf(l).agencyId === where.mediaAsset.client.agencyId) ?? null,
  findUnique: async ({ where }: { where: { id: string } }) => {
    const l = links.find((x) => x.id === where.id);
    return l ? { ...l, mediaAsset: assetOf(l) } : null;
  },
  findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
    const l = links.find((x) => x.id === where.id)!;
    const mine = comments.filter((c) => c.linkId === l.id).sort((a, b) => (a.atMs ?? -1) - (b.atMs ?? -1));
    return { ...l, mediaAsset: assetOf(l), comments: mine };
  },
  update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(links.find((l) => l.id === where.id)!, data),
});
mock("approvalComment", {
  create: async ({ data }: { data: object }) => {
    const c = { id: `cm${comments.length + 1}`, createdAt: new Date(), ...data };
    comments.push(c);
    return c;
  },
});

const ops = await testApp(approvalLinkRoutes);
const pub = await testApp(publicApprovalRoutes);
const visit = (token: string, ip = "5.5.5.5") => pub.app.inject({ method: "GET", url: `/a/${token}`, remoteAddress: ip });

// Operator makes a link; other bots cannot; carousels and other agencies' videos are refused.
let res = await ops.app.inject({ method: "POST", url: "/approval-links", headers: ops.nova, payload: { versionId: "v2", expiresInHours: 72 } });
assert.equal(res.statusCode, 403);
res = await ops.app.inject({ method: "POST", url: "/approval-links", headers: ops.otherAgency, payload: { versionId: "v2", expiresInHours: 72 } });
assert.equal(res.statusCode, 404);
res = await ops.app.inject({ method: "POST", url: "/approval-links", headers: ops.operator, payload: { versionId: "c1", expiresInHours: 72 } });
assert.equal(res.statusCode, 404, "approval is for video versions");
res = await ops.app.inject({ method: "POST", url: "/approval-links", headers: ops.operator, payload: { versionId: "v2", expiresInHours: 24 * 31 } });
assert.equal(res.statusCode, 400, "30 days at most");
res = await ops.app.inject({ method: "POST", url: "/approval-links", headers: ops.polly, payload: { versionId: "v2", expiresInHours: 72 } });
assert.equal(res.statusCode, 201, res.body);
const link = ApprovalLinkSchema.parse(res.json());
assert.equal(res.json().url, `/a/${link.token}`);
assert.ok(Math.abs(Date.parse(link.expiresAt) - Date.now() - 72 * 3600_000) < 5000);
assert.equal(links[0]!.createdById, "bot:polly");
assert.equal("token" in links[0]!, false, "the token is not stored");

// Public page: no login.
res = await visit(link.token);
assert.equal(res.statusCode, 200, res.body);
let page = PublicApprovalSchema.parse(res.json());
assert.equal(page.status, "pending");
assert.equal(page.video.name, "m3-walkaround-v2.mp4");
assert.match(page.video.url, /^\/files\/caleb\/v2\/source\.mp4\?e=\d+&s=/);

// Forged or tampered tokens are just "not found".
for (const bad of [`${link.id}.AAAA`, `${link.id}`, `nope.${link.token.split(".")[1]}`, `${link.token}x`]) {
  res = await visit(bad);
  assert.equal(res.statusCode, 404, bad);
}

// Comments pinned to a moment, sorted by time; past the end is refused.
res = await pub.app.inject({ method: "POST", url: `/a/${link.token}/comments`, payload: { atMs: 12_500, body: "Logo is too small here" } });
assert.equal(res.statusCode, 201, res.body);
res = await pub.app.inject({ method: "POST", url: `/a/${link.token}/comments`, payload: { atMs: 3_000, body: "Love the opening" } });
assert.equal(res.statusCode, 201);
res = await pub.app.inject({ method: "POST", url: `/a/${link.token}/comments`, payload: { atMs: 31_000, body: "x" } });
assert.equal(res.statusCode, 400);
res = await pub.app.inject({ method: "POST", url: `/a/${link.token}/comments`, payload: { body: "   " } });
assert.equal(res.statusCode, 400);
page = PublicApprovalSchema.parse((await visit(link.token)).json());
assert.deepEqual(page.comments.map((c) => c.atMs), [3_000, 12_500]);

// Request changes, then approve: stored on the version's link.
res = await pub.app.inject({ method: "POST", url: `/a/${link.token}/decision`, payload: { decision: "changes_requested" } });
assert.equal(res.json().status, "changes_requested");
res = await pub.app.inject({ method: "POST", url: `/a/${link.token}/decision`, payload: { decision: "approved" } });
assert.equal(res.statusCode, 200);
assert.equal(res.json().status, "approved");
assert.ok(links[0]!.decidedAt instanceof Date);
res = await pub.app.inject({ method: "POST", url: `/a/${link.token}/decision`, payload: { decision: "maybe" } });
assert.equal(res.statusCode, 400);

// The operator sees the status.
res = await ops.app.inject({ method: "GET", url: "/approval-links?versionId=v2", headers: ops.operator });
assert.equal(res.json().links[0].status, "approved");

// Expiry: the stored expiry decides, and moving it breaks the signature.
res = await ops.app.inject({ method: "POST", url: "/approval-links", headers: ops.operator, payload: { versionId: "v2", expiresInHours: 1 } });
const short = res.json();
links.find((l) => l.id === short.id)!.expiresAt = new Date(Date.now() - 1000);
res = await visit(short.token);
assert.equal(res.statusCode, 404, "an edited expiry no longer matches the signature");
const expired = links.find((l) => l.id === short.id)!;
res = await visit(approvalToken(expired.id, expired.expiresAt));
assert.equal(res.statusCode, 410);
assert.match(res.json().error, /expired/);

// Revoke.
res = await ops.app.inject({ method: "DELETE", url: `/approval-links/${link.id}`, headers: ops.nova });
assert.equal(res.statusCode, 403);
res = await ops.app.inject({ method: "DELETE", url: `/approval-links/${link.id}`, headers: ops.otherAgency });
assert.equal(res.statusCode, 404);
res = await ops.app.inject({ method: "DELETE", url: `/approval-links/${link.id}`, headers: ops.operator });
assert.deepEqual(res.json(), { ok: true });
res = await visit(link.token);
assert.equal(res.statusCode, 410);
assert.match(res.json().error, /turned off/);
res = await pub.app.inject({ method: "POST", url: `/a/${link.token}/decision`, payload: { decision: "approved" } });
assert.equal(res.statusCode, 410, "a revoked link cannot approve");

// Rate limit: 60 a minute per IP.
for (let i = 0; i < 60; i++) await visit("x.y", "7.7.7.7");
res = await visit(link.token, "7.7.7.7");
assert.equal(res.statusCode, 429);
assert.equal([...buckets].find(([k]) => k.startsWith("approval|7.7.7.7|"))?.[1].count, 61, "counted in the database table");

await ops.app.close();
await pub.app.close();
console.log("approvals.check: ok");
