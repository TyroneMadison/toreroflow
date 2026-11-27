// DM automations (F4), the API half, through the real auth hook and routes
// with Prisma, Zernio and Instagram faked: every write route refuses viewers
// and bots (Polly included), a non-Instagram id never reaches a scope, the post
// picker lists only that Instagram account's posts, publish rules, the
// overlap warning never pauses a Zernio campaign unless asked, Move to native,
// the Zernio engine for unconnected accounts, the kill switch and the tracked
// link redirect.
import assert from "node:assert/strict";

process.env.PUBLISH_PROVIDER = "zernio";
process.env.PUBLISH_PROVIDER_API_KEY = "sk_agency";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
process.env.JWT_SECRET = "automations-check-secret";

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { encryptSecret, getPrisma, Prisma } = await import("@toreroflow/db");
const { env } = await import("../env");
const { dmAutomationRoutes, publicAutomationRoutes } = await import("../routes/dmAutomations");
Object.assign(env, { META_IG_APP_ID: "", META_IG_APP_SECRET: "", META_VERIFY_TOKEN: "", OAUTH_REDIRECT_BASE: "" });

type Row = Record<string, any>;
let n = 0;
const id = (p: string) => `${p}${++n}`;
const CLIENT = { id: "c1", agencyId: "A", providerProfileId: "prof1" };
const SOCIALS: Row[] = [
  { id: "sa-ig", clientId: "c1", platform: "instagram", handle: "sample.handle", status: "connected", providerAccountId: "z-ig", dmAccount: null },
  { id: "sa-ig2", clientId: "c1", platform: "instagram", handle: "sample.studio", status: "connected", providerAccountId: "z-ig2", dmAccount: null },
  { id: "sa-fb", clientId: "c1", platform: "facebook", handle: "samplepage", status: "connected", providerAccountId: "z-fb", dmAccount: null },
  { id: "sa-yt", clientId: "c1", platform: "youtube", handle: "samplechannel", status: "connected", providerAccountId: "z-yt", dmAccount: null },
];
const nativeAccount = (socialAccountId: string) => ({ id: `dm-${socialAccountId}`, socialAccountId, transport: "native", status: "active", accessTokenEnc: encryptSecret("IG-TOKEN"), automationsPausedAt: null });
let automations: Row[] = [];
let runs: Row[] = [];
const videoQueries: Row[] = [];

function match(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined || k === "client") continue;
    const v = row[k];
    if (cond === null) {
      if (v != null) return false;
    } else if (typeof cond !== "object" || cond instanceof Date) {
      if (v !== cond && !(v instanceof Date && cond instanceof Date && +v === +cond)) return false;
    } else {
      if ("not" in cond && (cond.not === null ? v == null : v === cond.not)) return false;
      if ("in" in cond && !cond.in.includes(v)) return false;
      if ("gt" in cond && !(v != null && v > cond.gt)) return false;
    }
  }
  return true;
}
const apply = (row: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (v === Prisma.JsonNull) row[k] = null;
    else if (v !== undefined) row[k] = v;
  }
  row.updatedAt = new Date();
  return row;
};

const prisma = getPrisma() as unknown as Record<string, unknown>;
const fake = (name: string, value: object) => Object.defineProperty(prisma, name, { value, configurable: true });
fake("botIdentity", { findUnique: async () => null });
fake("user", { findFirst: async ({ where }: Row) => ({ id: where.id, agencyId: "A", role: "owner" }), findUnique: async () => null });
fake("client", { findFirst: async ({ where }: Row) => (where.id === CLIENT.id && where.agencyId === CLIENT.agencyId ? CLIENT : null) });
fake("socialAccount", {
  findMany: async ({ where }: Row) => SOCIALS.filter((s) => s.clientId === where.clientId && where.platform.in.includes(s.platform)),
});
const ROW_DEFAULTS = { status: "draft", folder: null, published: null, publishedAt: null, testCode: null, testCodeExpiresAt: null, lastTestAt: null, runCount: 0, sentCount: 0, failedCount: 0, clickCount: 0, lastRunAt: null, deletedAt: null };
fake("dmAutomation", {
  findMany: async ({ where }: Row) => automations.filter((a) => match(a, where)),
  count: async ({ where }: Row) => automations.filter((a) => match(a, where)).length,
  findFirst: async ({ where }: Row) => (where.client && where.client.agencyId !== "A" ? null : (automations.find((a) => match(a, where)) ?? null)),
  create: async ({ data }: Row) => {
    const row = { id: id("au"), ...ROW_DEFAULTS, createdAt: new Date(), updatedAt: new Date(), ...data };
    automations.push(row);
    return row;
  },
  update: async ({ where, data }: Row) => apply(automations.find((a) => a.id === where.id)!, data),
  updateMany: async ({ where, data }: Row) => ({ count: automations.filter((a) => match(a, where)).map((a) => apply(a, data)).length }),
  delete: async ({ where }: Row) => {
    automations = automations.filter((a) => a.id !== where.id);
    return {};
  },
});
fake("dmAutomationRun", {
  findMany: async () => runs.map((r) => ({ ...r, automation: automations.find((a) => a.id === r.automationId) ?? null })),
  count: async () => runs.length,
  // A copy, as Prisma returns: the route reads clicks before its own update.
  findUnique: async ({ where }: Row) => {
    const r = runs.find((x) => x.id === where.id);
    return r ? { ...r } : null;
  },
  update: async ({ where, data }: Row) => apply(runs.find((r) => r.id === where.id)!, data),
});
const accountWrites: Row[] = [];
fake("dmAccount", { upsert: async (q: Row) => (accountWrites.push(q), {}) });
fake("externalVideo", {
  findMany: async (q: Row) => {
    videoQueries.push(q.where);
    // What the database would answer for that where: only this account's Instagram rows.
    const all = [
      { socialAccountId: "sa-ig", platform: "instagram", platformVideoId: "17900000000000011", title: "Spring price list", thumbnailUrl: "https://scontent.cdninstagram.com/a.jpg", url: null, publishedAt: new Date(), mediaType: "video" },
      { socialAccountId: "sa-yt", platform: "youtube", platformVideoId: "dQw4w9WgXcQ", title: "A YouTube video", thumbnailUrl: null, url: null, publishedAt: new Date(), mediaType: "video" },
    ];
    return all.filter((v) => v.socialAccountId === q.where.socialAccountId && v.platform === q.where.platform);
  },
});

// ---- Zernio and Instagram, faked ----
let campaigns: Row[] = [];
const zernioCalls: Array<{ method: string; url: string; body: Row | null }> = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  const ok = (b: object, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (url.includes("zernio.com")) {
    zernioCalls.push({ method, url, body });
    if (url.includes("/comment-automations?profileId=")) return ok({ automations: campaigns });
    if (method === "POST" && url.endsWith("/comment-automations")) {
      const c = { id: id("zc"), isActive: true, platform: "instagram", ...body };
      campaigns.push(c);
      return ok({ automation: c });
    }
    if (method === "PATCH") {
      const c = campaigns.find((x) => url.endsWith(`/comment-automations/${x.id}`))!;
      Object.assign(c, body);
      return ok({ automation: c });
    }
  }
  if (url.startsWith("https://graph.instagram.com/v26.0/me/media?")) {
    return ok({ data: [{ id: "17900000000000021", caption: "New reel", timestamp: new Date().toISOString(), media_type: "VIDEO", media_product_type: "REELS", thumbnail_url: "https://scontent.cdninstagram.com/r.jpg" }, { id: "17900000000000022", media_product_type: "AD" }] });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as typeof fetch;

// ---- the app ----
const app = Fastify();
await app.register(jwt, { secret: env.JWT_SECRET });
const { ZodError } = await import("zod");
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof ZodError ? 400 : 500).send({ error: e instanceof Error ? e.message : "failed" }));
const routes: { method: string; url: string; plugin: string }[] = [];
let plugin = "";
app.addHook("onRoute", (r) => {
  for (const method of [r.method].flat()) routes.push({ method: String(method), url: r.url, plugin });
});
for (const [name, p] of [["automations", dmAutomationRoutes], ["public", publicAutomationRoutes]] as const) {
  plugin = name;
  await app.register(p);
}
await app.ready();
const sign = (claims: Row) => `Bearer ${app.jwt.sign({ sub: "u1", agencyId: "A", ...claims } as never)}`;
const OWNER = sign({});
const VIEWER = sign({ role: "viewer" });
const POLLY = sign({ role: "bot", bot: "polly" });
const call = (method: string, url: string, auth?: string, payload?: unknown) =>
  app.inject({ method: method as "GET", url, payload: payload as string, headers: auth ? { authorization: auth } : {} });

// ---------------------------------------------------------------------------
// 1. Every write route refuses viewers and bots; reads are open to them
// ---------------------------------------------------------------------------
const writes = routes.filter((r) => r.plugin === "automations" && r.method !== "GET" && r.method !== "HEAD");
for (const expected of [
  "POST /clients/:id/dm/automations",
  "PATCH /clients/:id/dm/automations/:aid",
  "DELETE /clients/:id/dm/automations/:aid",
  "POST /clients/:id/dm/automations/:aid/publish",
  "POST /clients/:id/dm/automations/:aid/status",
  "POST /clients/:id/dm/automations/:aid/duplicate",
  "POST /clients/:id/dm/automations/:aid/restore",
  "POST /clients/:id/dm/automations/:aid/test",
  "POST /clients/:id/dm/automations/:aid/test-code",
  "POST /clients/:id/dm/automations/kill",
  "POST /clients/:id/dm/automations/move",
]) {
  assert.ok(writes.some((r) => `${r.method} ${r.url}` === expected), `${expected} is registered and covered`);
}
for (const r of writes) {
  for (const [who, auth] of [["viewer", VIEWER], ["polly", POLLY]] as const) {
    const out = await call(r.method, r.url.replace(/:\w+/g, "x1"), auth, { socialAccountId: "sa-ig", template: "comment_link" });
    assert.equal(out.statusCode, 403, `${who} ${r.method} ${r.url} must be 403`);
  }
}
assert.equal(automations.length, 0, "nothing was created by a refused caller");
assert.equal((await call("GET", "/clients/c1/dm/automations", VIEWER)).statusCode, 200, "a viewer reads the list");
assert.equal((await call("GET", "/clients/c1/dm/automations")).statusCode, 401);
assert.equal((await call("GET", "/clients/c9/dm/automations", OWNER)).statusCode, 404, "another agency's client");

// ---------------------------------------------------------------------------
// 2. Create, save, and the scope: Instagram ids only
// ---------------------------------------------------------------------------
let res = await call("POST", "/clients/c1/dm/automations", OWNER, { socialAccountId: "sa-ig", template: "comment_link" });
assert.equal(res.statusCode, 201);
const a = res.json().automation;
assert.equal(a.status, "draft");
assert.equal(a.config.trigger, "comment");
assert.equal(a.config.publicReplyOn, true, "the template's public replies");
assert.equal(a.waiting, null, "a draft waits for nothing");
assert.equal((await call("POST", "/clients/c1/dm/automations", OWNER, { socialAccountId: "sa-fb", template: "welcome" })).statusCode, 400, "Messenger answers comments only");
assert.equal((await call("POST", "/clients/c1/dm/automations", OWNER, { socialAccountId: "sa-yt", template: "comment_link" })).statusCode, 404, "a YouTube account is not a DM account");

res = await call("PATCH", `/clients/c1/dm/automations/${a.id}`, OWNER, { scope: "posts", postIds: ["dQw4w9WgXcQ"] });
assert.equal(res.statusCode, 400, "a YouTube video id never reaches the scope");
assert.deepEqual(automations[0]!.postIds ?? [], [], "and nothing was saved");
res = await call("PATCH", `/clients/c1/dm/automations/${a.id}`, OWNER, { postIds: ["UCabcdefghijklmnop"] });
assert.equal(res.statusCode, 400, "nor a channel id");
res = await call("PATCH", `/clients/c1/dm/automations/${a.id}`, OWNER, {
  name: "Free guide by comment",
  keywords: ["GUIDE", "FREE"],
  scope: "posts",
  postIds: ["17900000000000011"],
  steps: [{ type: "message", text: "Here is the guide", button: { title: "Open the guide", url: "https://sample.example/guide" } }],
});
assert.equal(res.statusCode, 200);
assert.deepEqual(res.json().automation.config.postIds, ["17900000000000011"]);
assert.deepEqual(res.json().problems, []);

// ---------------------------------------------------------------------------
// 3. The post picker: this Instagram account's posts, never YouTube
// ---------------------------------------------------------------------------
res = await call("GET", "/clients/c1/dm/automations/posts?accountId=sa-ig", OWNER);
assert.equal(res.statusCode, 200);
assert.equal(res.json().source, "catalogue", "not connected natively: the posts the app already has");
assert.deepEqual(videoQueries.at(-1), { socialAccountId: "sa-ig", platform: "instagram" }, "only this Instagram account's rows are read");
assert.deepEqual(res.json().posts.map((p: Row) => p.id), ["17900000000000011"]);
assert.equal((await call("GET", "/clients/c1/dm/automations/posts?accountId=sa-yt", OWNER)).statusCode, 404, "a YouTube account has no posts to pick");
assert.equal((await call("GET", "/clients/c1/dm/automations/posts?accountId=sa-fb", OWNER)).statusCode, 400, "nor Facebook");
SOCIALS[0]!.dmAccount = nativeAccount("sa-ig");
res = await call("GET", "/clients/c1/dm/automations/posts?accountId=sa-ig", OWNER);
assert.equal(res.json().source, "instagram", "connected: live from Instagram");
assert.deepEqual(res.json().posts.map((p: Row) => p.id), ["17900000000000021"], "ads are left out");
assert.equal(res.json().posts[0].reel, true);

// ---------------------------------------------------------------------------
// 4. Publish: problems first; overlapping Zernio campaigns warned, never silently paused
// ---------------------------------------------------------------------------
campaigns = [{ id: "zc-old", name: "Old guide campaign", platform: "instagram", accountId: "z-ig", keywords: ["guide"], isActive: true, dmMessage: "Old", buttons: [], stats: { triggered: 40, dmsSent: 38, linkClicks: 12 }, linkTracking: true, platformPostId: null }];
res = await call("GET", "/clients/c1/dm/automations", OWNER);
assert.deepEqual(res.json().overlaps, [{ automationId: a.id, campaignId: "zc-old", campaignName: "Old guide campaign", keywords: ["GUIDE"] }], "the overlap is reported");
const zc = res.json().campaigns[0];
assert.equal(zc.source, "zernio");
assert.equal(zc.socialAccountId, "sa-ig", "mapped to our account");
assert.equal(zc.canMove, true, "Instagram is native here");
assert.equal(zc.stats.runs, 40);

const b = (await call("POST", "/clients/c1/dm/automations", OWNER, { socialAccountId: "sa-ig", template: "dm_keyword" })).json().automation;
res = await call("POST", `/clients/c1/dm/automations/${b.id}/publish`, OWNER, {});
assert.equal(res.statusCode, 400, "an incomplete automation does not publish");
assert.equal(res.json().reason, "incomplete");
assert.ok(res.json().problems.length >= 2);

const zBefore = zernioCalls.filter((c) => c.method === "PATCH").length;
res = await call("POST", `/clients/c1/dm/automations/${a.id}/publish`, OWNER, {});
assert.equal(res.statusCode, 200);
assert.equal(res.json().automation.status, "live");
assert.equal(automations.find((x) => x.id === a.id)!.published.keywords.join(), "GUIDE,FREE", "the snapshot the worker runs");
assert.equal(zernioCalls.filter((c) => c.method === "PATCH").length, zBefore, "the Zernio campaign was NOT paused without being asked");
assert.equal(campaigns[0]!.isActive, true);

// An edit after publishing is a draft people do not get yet.
await call("PATCH", `/clients/c1/dm/automations/${a.id}`, OWNER, { keywords: ["GUIDE"] });
res = await call("GET", `/clients/c1/dm/automations/${a.id}`, OWNER);
assert.equal(res.json().automation.hasUnpublished, true);
assert.equal(automations.find((x) => x.id === a.id)!.published.keywords.join(), "GUIDE,FREE", "people still get the live version");
res = await call("POST", `/clients/c1/dm/automations/${a.id}/publish`, OWNER, { pauseCampaignIds: ["zc-old"] });
assert.equal(res.statusCode, 200);
assert.equal(campaigns[0]!.isActive, false, "paused because the operator chose to");
assert.equal((await call("POST", `/clients/c1/dm/automations/${a.id}/publish`, OWNER, { pauseCampaignIds: ["zc-other-brand"] })).statusCode, 404, "only this client's campaigns");

// Status, duplicate, trash and restore.
assert.equal((await call("POST", `/clients/c1/dm/automations/${b.id}/status`, OWNER, { status: "live" })).statusCode, 409, "never published: cannot go live");
assert.equal((await call("POST", `/clients/c1/dm/automations/${a.id}/status`, OWNER, { status: "paused" })).json().automation.status, "paused");
const copy = (await call("POST", `/clients/c1/dm/automations/${a.id}/duplicate`, OWNER)).json().automation;
assert.equal(copy.status, "draft");
assert.equal(copy.name, "Free guide by comment (copy)");
assert.equal((await call("DELETE", `/clients/c1/dm/automations/${copy.id}`, OWNER)).statusCode, 200);
res = await call("GET", "/clients/c1/dm/automations", OWNER);
assert.equal(res.json().trashCount, 1);
assert.ok(!res.json().automations.some((x: Row) => x.id === copy.id), "trashed rows leave the list");
assert.ok((await call("GET", "/clients/c1/dm/automations?trash=1", OWNER)).json().automations.some((x: Row) => x.id === copy.id));
await call("POST", `/clients/c1/dm/automations/${copy.id}/restore`, OWNER);
assert.equal(automations.find((x) => x.id === copy.id)!.deletedAt, null);

// ---------------------------------------------------------------------------
// 5. Dry run test, test code, kill switch
// ---------------------------------------------------------------------------
res = await call("POST", `/clients/c1/dm/automations/${a.id}/test`, OWNER, { kind: "comment", text: "can I get the guide pls" });
assert.equal(res.json().matched, true);
assert.equal(res.json().keyword, "GUIDE");
assert.equal(res.json().wouldSend.privateReply, true);
res = await call("POST", `/clients/c1/dm/automations/${a.id}/test`, OWNER, { kind: "comment", text: "love this" });
assert.equal(res.json().matched, false);
res = await call("POST", `/clients/c1/dm/automations/${a.id}/test-code`, OWNER);
assert.match(res.json().code, /^\d{3}$/);
assert.equal(res.json().ready, true);
assert.equal(automations.find((x) => x.id === a.id)!.testCode, res.json().code);
res = await call("POST", "/clients/c1/dm/automations/kill", OWNER, { accountId: "sa-ig", paused: true });
assert.equal(res.statusCode, 200);
assert.ok(accountWrites.at(-1)!.update.automationsPausedAt instanceof Date, "the kill switch is on the account");
assert.equal((await call("POST", "/clients/c1/dm/automations/kill", OWNER, { accountId: "nope", paused: true })).statusCode, 404);

// ---------------------------------------------------------------------------
// 6. Move to native, and the Zernio engine for accounts not connected
// ---------------------------------------------------------------------------
campaigns.push({ id: "zc-studio", name: "Studio price", platform: "instagram", accountId: "z-ig2", keywords: ["PRICE"], isActive: true, dmMessage: "Prices", buttons: [{ type: "url", title: "See prices", url: "https://sample.example/p" }], commentReply: "Sent!", stats: {}, platformPostId: "17900000000000031" });
res = await call("POST", "/clients/c1/dm/automations/move", OWNER, { campaignId: "zc-studio" });
assert.equal(res.statusCode, 409, "Move to native needs Instagram connected natively");
assert.equal(res.json().reason, "connect_instagram");
SOCIALS[1]!.dmAccount = nativeAccount("sa-ig2");
res = await call("POST", "/clients/c1/dm/automations/move", OWNER, { campaignId: "zc-studio" });
assert.equal(res.statusCode, 201);
const moved = res.json().automation;
assert.equal(moved.status, "draft", "moved as a draft, to check and publish");
assert.deepEqual(moved.config.keywords, ["PRICE"]);
assert.deepEqual(moved.config.postIds, ["17900000000000031"]);
assert.equal(moved.config.steps[0].button.url, "https://sample.example/p");
assert.deepEqual(moved.config.publicReplies, ["Sent!"]);
assert.equal(campaigns.find((c) => c.id === "zc-studio")!.isActive, true, "the Zernio campaign keeps running until the operator pauses it");

SOCIALS[1]!.dmAccount = null;
const z1 = (await call("POST", "/clients/c1/dm/automations", OWNER, { socialAccountId: "sa-ig2", template: "comment_link" })).json().automation;
await call("PATCH", `/clients/c1/dm/automations/${z1.id}`, OWNER, { keywords: ["INFO"], steps: [{ type: "message", text: "Info here", button: null }] });
res = await call("POST", `/clients/c1/dm/automations/${z1.id}/publish`, OWNER, { engine: "zernio" });
assert.equal(res.statusCode, 200);
assert.equal(res.json().movedTo, "zernio");
const created = zernioCalls.find((c) => c.method === "POST")!;
assert.equal(created.body!.accountId, "z-ig2", "Zernio's account id");
assert.deepEqual(created.body!.keywords, ["INFO"]);
assert.equal(created.body!.commentReply, "Sent! Check your DMs");
assert.ok(!automations.some((x) => x.id === z1.id), "the draft became the Zernio campaign");
const z2 = (await call("POST", "/clients/c1/dm/automations", OWNER, { socialAccountId: "sa-ig2", template: "comment_link" })).json().automation;
await call("PATCH", `/clients/c1/dm/automations/${z2.id}`, OWNER, { keywords: ["X"], steps: [{ type: "message", text: "Hi {first_name}", button: null }] });
assert.equal((await call("POST", `/clients/c1/dm/automations/${z2.id}/publish`, OWNER, { engine: "zernio" })).json().reason, "zernio_cannot", "Zernio cannot fill variables");

// ---------------------------------------------------------------------------
// 7. The tracked link: counted once per person, only to the stored link
// ---------------------------------------------------------------------------
runs = [{ id: "run1", linkUrl: "https://sample.example/guide", clicks: 0, automationId: a.id, test: false }];
const clicksBefore = automations.find((x) => x.id === a.id)!.clickCount;
res = await call("GET", "/dm/l/run1");
assert.equal(res.statusCode, 302);
assert.equal(res.headers.location, "https://sample.example/guide");
await call("GET", "/dm/l/run1");
assert.equal(runs[0]!.clicks, 2);
assert.equal(automations.find((x) => x.id === a.id)!.clickCount, clicksBefore + 1, "a link open counts once per person");
assert.equal((await call("GET", "/dm/l/nope")).statusCode, 404);
runs.push({ id: "run2", linkUrl: "javascript:alert(1)", clicks: 0, automationId: null, test: false });
assert.equal((await call("GET", "/dm/l/run2")).statusCode, 404, "never anything but https");

await app.close();
console.log("automations.check (api): all checks passed");
