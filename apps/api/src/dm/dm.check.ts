// DMs (F2) through the real auth hook and routes, Prisma and every outside
// API faked: dark launch, the webhook HMAC, the role guard on every DM write
// route, the Instagram connect (token stored encrypted), the 24h window, the
// Zernio fallback for the old inbox, the media proxy and its refresh, and the
// DM campaign post-scope check. F3: the Inbox list filters, the Zernio poll
// throttle, the reply photo upload and the contacts bulk edit.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.PUBLISH_PROVIDER = "zernio";
process.env.PUBLISH_PROVIDER_API_KEY = "sk_agency";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.JWT_SECRET = "dm-check-secret";

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { decryptSecret, encryptSecret, getPrisma, setDmNotify } = await import("@toreroflow/db");
// H1: what the routes tell open Inboxes (pg_notify in production).
const notified: Row[] = [];
setDmNotify(async (_channel, payload) => void notified.push(JSON.parse(payload)));
const { env } = await import("../env");
const { signState } = await import("../oauth/state");
const { dmCampaignRoutes } = await import("../routes/dmCampaigns");
const { dmRoutes, publicDmRoutes } = await import("../routes/dm");
const { metaWebhookRoutes } = await import("../routes/metaWebhook");

// Dark launch first: nothing of Meta's is set.
Object.assign(env, { META_IG_APP_ID: "", META_IG_APP_SECRET: "", META_VERIFY_TOKEN: "", META_APP_SECRET: "", OAUTH_REDIRECT_BASE: "", META_IG_HUMAN_AGENT: false });

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Row = Record<string, any>;
const CLIENT = { id: "c1", agencyId: "A", providerProfileId: "prof1" };
const SOCIALS: Row[] = [
  { id: "sa-ig", clientId: "c1", platform: "instagram", handle: "sample.studio", status: "connected", providerAccountId: "z-ig" },
  { id: "sa-fb", clientId: "c1", platform: "facebook", handle: "samplepage", status: "connected", providerAccountId: "z-fb" },
];
const dmAccounts = new Map<string, Row>();
const events: Row[] = [];
const messages: Row[] = [];
const threadUpdates: Row[] = [];
const readAlls: Row[] = [];
let thread: Row;

const prisma = getPrisma() as unknown as Record<string, unknown>;
const fake = (name: string, value: object) => Object.defineProperty(prisma, name, { value, configurable: true });
fake("botIdentity", { findUnique: async () => null });
// u1 is the owner; v1 a viewer whose token predates the role claim; v2 a viewer who logs in.
const bcrypt = (await import("bcryptjs")).default;
const USERS: Row[] = [
  { id: "u1", agencyId: "A", role: "owner", email: "owner@x.test" },
  { id: "v1", agencyId: "A", role: "viewer", email: "old-viewer@x.test" },
  { id: "v2", agencyId: "A", role: "viewer", email: "viewer@x.test", passwordHash: await bcrypt.hash("viewer-pass", 4), agency: { name: "A" } },
];
fake("user", {
  findFirst: async ({ where }: Row) => USERS.find((u) => u.id === where.id && u.agencyId === where.agencyId) ?? null,
  findUnique: async ({ where }: Row) => USERS.find((u) => u.email === where.email || u.id === where.id) ?? null,
});
fake("client", {
  findFirst: async ({ where }: Row) => (where.id === CLIENT.id && where.agencyId === CLIENT.agencyId ? CLIENT : null),
  findUnique: async () => ({ agencyId: "A" }),
});
fake("socialAccount", {
  findFirst: async ({ where }: Row) => {
    const s = SOCIALS.find((x) => x.id === where.id && (!where.platform || x.platform === where.platform) && (!where.clientId || x.clientId === where.clientId));
    const agency = where.client?.agencyId;
    if (!s || (agency && agency !== "A")) return null;
    return { ...s, platformConnection: null };
  },
  findMany: async () => SOCIALS.map((s) => ({ ...s, dmAccount: dmAccounts.get(s.id) ?? null })),
  findUnique: async ({ where }: Row) => SOCIALS.find((s) => s.id === where.id) ?? null,
});
fake("dmAccount", {
  findFirst: async ({ where }: Row) =>
    [...dmAccounts.values()].find((a) => a.externalId === where.externalId && a.socialAccountId !== where.NOT?.socialAccountId) ?? null,
  upsert: async ({ where, create, update }: Row) => {
    const prev = dmAccounts.get(where.socialAccountId);
    const row = prev ? { ...prev, ...update } : { id: `dm-${where.socialAccountId}`, ...create };
    dmAccounts.set(where.socialAccountId, row);
    return row;
  },
  updateMany: async ({ where, data }: Row) => {
    let count = 0;
    for (const [k, a] of dmAccounts) if (a.externalId === where.externalId) (dmAccounts.set(k, { ...a, ...data }), count++);
    return { count };
  },
  deleteMany: async ({ where }: Row) => {
    for (const [k, a] of dmAccounts) if (a.externalId === where.externalId) dmAccounts.delete(k);
    return { count: 1 };
  },
  update: async ({ data }: Row) => data,
});
fake("dmWebhookEvent", {
  create: async ({ data }: Row) => (events.push({ id: `ev${events.length}`, receivedAt: new Date(), ...data }), { id: `ev${events.length - 1}` }),
  findFirst: async ({ where }: Row) => [...events].reverse().find((e) => e.signatureOk === where.signatureOk) ?? null,
});
fake("dmThread", {
  findFirst: async ({ where }: Row) =>
    thread && where.id === thread.id && where.dmAccount.clientId === "c1" && where.dmAccount.client.agencyId === "A" ? thread : null,
  update: async ({ data }: Row) => (threadUpdates.push(data), { ...thread, ...data }),
  updateMany: async (q: Row) => (readAlls.push(q), { count: 3 }),
  // The Zernio sync asks for its mirror rows by externalId; the list asks without.
  findMany: async (q: Row) => (q.where.externalId ? (syncHave ? [syncHave] : []) : (threadQueries.push(q.where), [])),
  groupBy: async () => [],
  count: async () => 0,
  upsert: async (q: Row) => (threadUpserts.push(q), {}),
});
const threadUpserts: Row[] = [];
let syncHave: Row | null = null;
fake("dmMessage", {
  upsert: async ({ create }: Row) => {
    const row = { id: `msg${messages.length}`, reactions: null, unsentAt: null, editedAt: null, transcript: null, ...create };
    messages.push(row);
    return row;
  },
  findUnique: async ({ where }: Row) => messages.find((m) => m.id === where.id) ?? null,
  update: async ({ where, data }: Row) => Object.assign(messages.find((m) => m.id === where.id)!, data),
  // Newest first by sentAt then id, from a cursor row, as Postgres pages them.
  findMany: async (q: Row) => {
    const w = q.where ?? {};
    let rows = messages
      .filter((m) => m.threadId === w.threadId && (!w.sentAt?.gte || m.sentAt >= w.sentAt.gte))
      .sort((a, b) => b.sentAt - a.sentAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    if (q.cursor) {
      const i = rows.findIndex((m) => m.id === q.cursor.id);
      rows = i < 0 ? [] : rows.slice(i + (q.skip ?? 0));
    }
    return rows.slice(0, q.take ?? rows.length);
  },
  count: async ({ where }: Row) => messages.filter((m) => m.threadId === where.threadId).length,
  findFirst: async ({ where }: Row) =>
    messages.filter((m) => m.threadId === where.threadId && (!where.direction || m.direction === where.direction)).sort((a, b) => a.sentAt - b.sentAt)[0] ?? null,
});
fake("dmTag", {
  findMany: async () => [],
  upsert: async ({ create }: Row) => ({ id: `tag-${create.name}`, ...create }),
});
// c1's contacts are ct1 and ct2; anything else belongs to someone else.
const bulkWrites: Row[] = [];
fake("dmContact", {
  findMany: async () => [],
  count: async ({ where }: Row) => (where.id?.in ? where.id.in.filter((id: string) => id === "ct1" || id === "ct2").length : 0),
  updateMany: async (q: Row) => (bulkWrites.push({ op: "stage", ...q }), { count: q.where.id.in.length }),
  upsert: async ({ create }: Row) => ({ id: "ct-z", ...create }),
});
fake("dmContactTag", {
  createMany: async (q: Row) => (bulkWrites.push({ op: "add", ...q }), { count: q.data.length }),
  deleteMany: async (q: Row) => (bulkWrites.push({ op: "remove", ...q }), { count: 1 }),
});
// AI replies (F5): off for these accounts (no row), no drafts.
fake("dmAiSettings", { findUnique: async () => null });
fake("dmAiDraft", { findFirst: async () => null, updateMany: async () => ({ count: 0 }) });
const threadQueries: Row[] = [];

type Call = { url: string; method: string; auth: string; body: string };
const calls: Call[] = [];
const expired = new Set<string>();
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization") ?? "", body: init?.body ? String(init.body) : "" });
  const ok = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (/cdninstagram\.com|fbcdn\.net/.test(url)) {
    if (expired.has(url)) return new Response("expired", { status: 403 });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "Content-Type": "image/jpeg", "Content-Length": "3" } });
  }
  if (url.startsWith("https://api.instagram.com/oauth/access_token")) return ok({ access_token: "SHORT", permissions: ["instagram_business_basic", "instagram_business_manage_messages"] });
  if (url.startsWith("https://graph.instagram.com/access_token")) return ok({ access_token: "IG-LONG-TOKEN", expires_in: 5184000 });
  if (url.includes("/me?fields=user_id")) return ok(meAnswer);
  if (url.includes("/me/subscribed_apps")) return ok({ success: true });
  if (url.endsWith("/me/messages")) return ok({ message_id: `mid.sent${calls.filter((c) => c.url.endsWith("/me/messages")).length}` });
  if (url.includes("/mid.old?fields=")) return ok({ id: "mid.old", attachments: { data: [{ mime_type: "image/jpeg", image_data: { url: "https://scontent.cdninstagram.com/fresh.jpg" } }] } });
  if (url.includes("zernio.com") && url.includes("/attachments/0")) return ok({ url: "https://scontent.cdninstagram.com/zernio-fresh.jpg" });
  if (url.includes("zernio.com") && url.includes("/inbox/conversations/convL/messages")) return zernioLong(new URL(url));
  if (url.includes("zernio.com") && url.includes("/inbox/conversations/conv1/messages")) {
    if (init?.method === "POST") return ok({ success: true });
    return ok({ messages: [{ id: "m1", message: "look", direction: "incoming", createdAt: "2026-11-20T10:00:00Z", attachments: [{ type: "image", url: "https://scontent.cdninstagram.com/z-original.jpg" }] }] });
  }
  if (url.includes("zernio.com") && url.includes("/inbox/conversations?")) {
    return ok({ conversations: [{ id: "conv1", platform: "instagram", accountId: "z-ig", participantId: "p1", participantName: "Jordan", unreadCount: 2, lastMessage: "hi", updatedTime: "2026-11-20T10:00:00Z" }] });
  }
  if (url.includes("zernio.com") && url.includes("/comment-automations")) return ok({ automation: { _id: "auto1", name: "x", platform: "instagram" } }, 201);
  return ok({ error: { message: `unexpected ${url}` } }, 500);
}) as typeof fetch;
let meAnswer: Row = { user_id: "17841400000000001", username: "sample.studio" };

/*
 * A long Zernio thread (G1), oldest first in zMsgs, served three ways:
 * "honors" sortOrder and its cursor (Instagram), "ignores" it (always oldest
 * first, no sortOrderApplied), and "newest-pages" (pages walk newest to
 * oldest, each page oldest first, no sortOrderApplied: Facebook's way). The
 * cursor is an offset into that order.
 */
type ZMode = "honors" | "ignores" | "newest-pages" | "fails";
let zMode: ZMode = "honors";
const zAt = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 3600_000).toISOString();
const zMsg = (i: number) => ({ id: `zm${i}`, message: `z ${i}`, direction: i % 3 ? "incoming" : "outgoing", createdAt: zAt(i), attachments: [] });
const zMsgs: Row[] = Array.from({ length: 120 }, (_, i) => zMsg(i));
function zernioLong(u: URL): Response {
  const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (zMode === "fails") return json({ error: "upstream down" }, 503);
  const limit = Number(u.searchParams.get("limit"));
  const off = Number(u.searchParams.get("cursor") ?? 0);
  const desc = u.searchParams.get("sortOrder") === "desc";
  const order = zMode === "ignores" || (zMode === "honors" && !desc) ? zMsgs : [...zMsgs].reverse();
  const items = order.slice(off, off + limit);
  const next = off + limit < order.length ? String(off + limit) : null;
  return json({
    messages: zMode === "newest-pages" ? [...items].reverse() : items,
    pagination: { hasMore: !!next, nextCursor: next },
    ...(zMode === "honors" ? { sortOrderApplied: desc ? "desc" : "asc" } : {}),
  });
}

// ---------------------------------------------------------------------------
// The app, with every route recorded by the plugin that registered it
// ---------------------------------------------------------------------------

const app = Fastify();
await app.register(jwt, { secret: env.JWT_SECRET });
// The server's own mapping: a validation failure is the caller's 400.
const { ZodError } = await import("zod");
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof ZodError ? 400 : 500).send({ error: e instanceof Error ? e.message : "failed" }));
const routes: { method: string; url: string; plugin: string }[] = [];
let plugin = "";
app.addHook("onRoute", (r) => {
  for (const method of [r.method].flat()) routes.push({ method: String(method), url: r.url, plugin });
});
const { default: multipart } = await import("@fastify/multipart");
await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024 } });
const { authRoutes } = await import("../routes/auth");
for (const [name, p] of [["auth", authRoutes], ["dmCampaigns", dmCampaignRoutes], ["dm", dmRoutes], ["publicDm", publicDmRoutes], ["metaWebhook", metaWebhookRoutes]] as const) {
  plugin = name;
  await app.register(p);
}
await app.ready();

const sign = (claims: Row) => `Bearer ${app.jwt.sign({ sub: "u1", agencyId: "A", ...claims } as never)}`;
const OWNER = sign({});
const VIEWER = sign({ role: "viewer" });
const POLLY = sign({ role: "bot", bot: "polly" });
const NOVA = sign({ role: "bot", bot: "nova" });
// A real viewer login: the token has to say so (it used to carry no role at all).
const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "viewer@x.test", password: "viewer-pass" } });
assert.equal(login.statusCode, 200);
const LOGGED_IN_VIEWER = `Bearer ${login.json().token}`;
assert.equal((app.jwt.decode(login.json().token) as Row).role, "viewer", "login signs the viewer role into the token");
// A viewer token from before that fix: no role claim, the user row decides.
const OLD_VIEWER = `Bearer ${app.jwt.sign({ sub: "v1", agencyId: "A" } as never)}`;
const call = (method: string, url: string, auth?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as "GET", url, payload: payload as string, headers: { ...(auth ? { authorization: auth } : {}), ...headers } });

// ---------------------------------------------------------------------------
// 1. Dark launch
// ---------------------------------------------------------------------------

let res = await call("GET", "/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123");
assert.equal(res.statusCode, 503, "webhook verify is dark");
assert.equal(res.json().reason, "instagram_not_configured");
assert.doesNotMatch(res.body, /META_|123/, "the public answer names no setting and echoes nothing");
assert.equal((await call("POST", "/webhooks/meta", undefined, "{}", { "content-type": "application/json" })).statusCode, 503);
assert.equal((await call("POST", "/webhooks/meta/deauthorize", undefined, "signed_request=x", { "content-type": "application/x-www-form-urlencoded" })).statusCode, 503);
res = await call("POST", "/oauth/instagram/start/sa-ig", OWNER);
assert.equal(res.statusCode, 503, "connect is dark");
assert.ok(res.json().missing.includes("META_IG_APP_ID"), "the operator is told which names are missing");
assert.equal((await call("GET", "/oauth/instagram/callback?code=x&state=y")).statusCode, 503);
assert.equal((await call("GET", "/dm/status")).statusCode, 401, "status needs a session");
res = await call("GET", "/dm/status?clientId=c1", VIEWER);
assert.equal(res.statusCode, 200, "a viewer reads status");
const status = res.json();
assert.equal(status.native.configured, false);
assert.deepEqual(status.native.missing, ["META_IG_APP_ID", "META_IG_APP_SECRET", "META_VERIFY_TOKEN", "OAUTH_REDIRECT_BASE"]);
assert.equal(status.zernio.configured, true);
assert.deepEqual(status.accounts.map((a: Row) => [a.handle, a.transport, a.state, a.canConnect, a.replyOnly]), [
  ["sample.studio", "zernio", "zernio", false, false],
  ["samplepage", "zernio", "zernio", false, true],
]);

// ---------------------------------------------------------------------------
// 2. Every DM write route refuses viewers and bots (Polly included)
// ---------------------------------------------------------------------------

const writes = routes.filter((r) => (r.plugin === "dm" || r.plugin === "dmCampaigns") && r.method !== "GET" && r.method !== "HEAD");
for (const expected of [
  "POST /clients/:id/dm/threads/:threadId/reply",
  "POST /clients/:id/dm/threads/:threadId/read",
  "POST /clients/:id/dm/threads/read-all",
  "PATCH /clients/:id/dm/threads/:threadId",
  "POST /clients/:id/dm/threads/:threadId/pause",
  "POST /clients/:id/dm/threads/:threadId/resume",
  "PATCH /clients/:id/dm/contacts/:contactId",
  "POST /clients/:id/dm/contacts/bulk",
  "POST /clients/:id/dm/upload",
  "POST /oauth/instagram/start/:accountId",
  "POST /clients/:id/dm-campaigns",
  "PATCH /clients/:id/dm-campaigns/:campaignId",
  "DELETE /clients/:id/dm-campaigns/:campaignId",
  "POST /clients/:id/inbox/:conversationId/reply",
]) {
  assert.ok(writes.some((r) => `${r.method} ${r.url}` === expected), `${expected} is registered and covered`);
}
const before = calls.length;
// F7: viewers may mark read (and only that); bots still may not.
const { VIEWER_MAY } = await import("./guard");
assert.deepEqual([...VIEWER_MAY].sort(), ["/clients/:id/dm/threads/:threadId/read", "/clients/:id/dm/threads/read-all"], "marking read is the only viewer write");
for (const r of writes) {
  const url = r.url.replace(/:\w+/g, "x1");
  for (const [who, auth] of [["viewer", VIEWER], ["logged-in viewer", LOGGED_IN_VIEWER], ["pre-F2 viewer token", OLD_VIEWER], ["polly", POLLY], ["nova", NOVA]] as const) {
    const out = await call(r.method, url, auth, { text: "hi", message: "hi", accountId: "sa-ig" });
    if (VIEWER_MAY.has(r.url) && who.includes("viewer")) assert.equal(out.statusCode, 404, `${who} ${r.method} ${r.url} passes the guard, and finds no brand x1`);
    else assert.equal(out.statusCode, 403, `${who} ${r.method} ${r.url} must be 403`);
  }
}
assert.equal(calls.length, before, "a refused write never reached Meta or Zernio");
// A viewer cannot mint a bot token (a "polly" token would be full access).
assert.equal((await call("POST", "/auth/bot-token", LOGGED_IN_VIEWER, { name: "polly" })).statusCode, 403, "viewers cannot mint tokens");
assert.equal((await call("POST", "/auth/bot-token", OLD_VIEWER, { name: "polly" })).statusCode, 403, "nor with a pre-F2 token");
// Reads stay open to viewers and Polly.
assert.equal((await call("GET", "/clients/c1/dm/contacts", VIEWER)).statusCode, 200, "viewer reads contacts");
assert.equal((await call("GET", "/clients/c1/dm/contacts", POLLY)).statusCode, 200, "Polly reads contacts");
assert.equal((await call("GET", "/clients/c1/dm/contacts", NOVA)).statusCode, 403, "other bots keep the whitelist");

// ---------------------------------------------------------------------------
// 3. The webhook, configured
// ---------------------------------------------------------------------------

Object.assign(env, { META_IG_APP_ID: "123456", META_IG_APP_SECRET: "ig-app-secret", META_VERIFY_TOKEN: "verify-xyz", OAUTH_REDIRECT_BASE: "https://api.test" });

res = await call("GET", "/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=777");
assert.equal(res.statusCode, 403, "wrong verify token");
assert.doesNotMatch(res.body, /777/, "the challenge is not echoed to a wrong token");
res = await call("GET", "/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-xyz&hub.challenge=777");
assert.equal(res.statusCode, 200);
assert.equal(res.body, "777");

// The raw bytes are signed: an escaped heart and a literal one are different bodies.
const body = '{"object":"instagram","entry":[{"id":"17841400000000001","messaging":[{"sender":{"id":"999"},"recipient":{"id":"17841400000000001"},"timestamp":1764240000000,"message":{"mid":"mid.1","text":"\\u2764 hi"}}]}]}';
const hub = (b: string, secret: string) => `sha256=${createHmac("sha256", secret).update(b).digest("hex")}`;
const post = (b: string, sig?: string) =>
  call("POST", "/webhooks/meta", undefined, b, { "content-type": "application/json", ...(sig ? { "x-hub-signature-256": sig } : {}) });
res = await post(body, hub(body, "ig-app-secret"));
assert.equal(res.statusCode, 200, "a valid delivery is accepted (enqueue failing is survivable)");
assert.equal(events.at(-1)!.signatureOk, true);
assert.equal(events.at(-1)!.object, "instagram");
assert.equal((events.at(-1)!.payload as Row).entry[0].messaging[0].message.text, "❤ hi");
res = await post(body.replace("hi", "hj"), hub(body, "ig-app-secret"));
assert.equal(res.statusCode, 403, "tampered body");
assert.equal(events.at(-1)!.signatureOk, false);
assert.equal(events.at(-1)!.payload, undefined, "a refused body is not stored");
assert.equal((await post(body)).statusCode, 403, "missing signature");
assert.equal((await post(body, "sha256=00")).statusCode, 403, "short signature");
assert.equal((await post(body, hub(body, "meta-app-secret"))).statusCode, 403, "the other app's secret is not accepted unless configured");
env.META_APP_SECRET = "meta-app-secret";
assert.equal((await post(body, hub(body, "meta-app-secret"))).statusCode, 200, "META_APP_SECRET is the second signing key");
env.META_APP_SECRET = "";
res = await call("GET", "/dm/status", OWNER);
assert.ok(res.json().native.lastBadSignatureAt, "a wrong secret shows up on status");

const signedRequest = (payload: object, secret: string) => {
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${createHmac("sha256", secret).update(p).digest("base64url")}.${p}`;
};
dmAccounts.set("sa-old", { id: "dm-old", socialAccountId: "sa-old", externalId: "178000", transport: "native", status: "active", accessTokenEnc: "x" });
res = await call("POST", "/webhooks/meta/deauthorize", undefined, `signed_request=${signedRequest({ user_id: "178000" }, "wrong")}`, { "content-type": "application/x-www-form-urlencoded" });
assert.equal(res.statusCode, 403, "a forged deauthorize is refused");
res = await call("POST", "/webhooks/meta/deauthorize", undefined, `signed_request=${signedRequest({ user_id: "178000" }, "ig-app-secret")}`, { "content-type": "application/x-www-form-urlencoded" });
assert.equal(res.statusCode, 200);
assert.equal(dmAccounts.get("sa-old")!.status, "revoked");
assert.equal(dmAccounts.get("sa-old")!.accessTokenEnc, null, "the dead token is dropped");
res = await call("POST", "/webhooks/meta/data-deletion", undefined, `signed_request=${signedRequest({ user_id: "178000" }, "ig-app-secret")}`, { "content-type": "application/x-www-form-urlencoded" });
assert.equal(res.statusCode, 200);
assert.ok(res.json().confirmation_code && res.json().url.startsWith("https://api.test/"));
assert.equal(dmAccounts.has("sa-old"), false, "data deletion removes the account's DM data");

// ---------------------------------------------------------------------------
// 4. Connect Instagram
// ---------------------------------------------------------------------------

assert.equal((await call("POST", "/oauth/instagram/start/sa-ig", VIEWER)).statusCode, 403, "viewers cannot start a connect");
res = await call("POST", "/oauth/instagram/start/sa-ig", OWNER);
assert.equal(res.statusCode, 200);
const auth = new URL(res.json().authUrl);
assert.equal(auth.host, "www.instagram.com");
assert.equal(auth.searchParams.get("client_id"), "123456");
assert.equal(auth.searchParams.get("redirect_uri"), "https://api.test/oauth/instagram/callback");
assert.equal(auth.searchParams.get("scope"), "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments");
assert.equal((await call("POST", "/oauth/instagram/start/sa-fb", OWNER)).statusCode, 400, "Messenger does not connect natively");

const state = signState({ agencyId: "A", socialAccountId: "sa-ig" }, env.JWT_SECRET);
assert.equal((await call("GET", `/oauth/instagram/callback?code=c&state=${state}x`)).statusCode, 400, "a forged state is refused");
meAnswer = { user_id: "17841400000000001", username: "<b>other</b>" };
res = await call("GET", `/oauth/instagram/callback?code=c&state=${state}`);
assert.equal(res.statusCode, 409, "the wrong Instagram account is named, not bound");
assert.match(res.body, /&lt;b&gt;other&lt;\/b&gt;/, "Instagram's text is escaped into the page");
assert.equal(dmAccounts.has("sa-ig"), false);
meAnswer = { user_id: "17841400000000001", username: "sample.studio" };
const sinceConnect = calls.length;
res = await call("GET", `/oauth/instagram/callback?code=c&state=${state}`);
assert.equal(res.statusCode, 200, res.body);
assert.match(res.body, /Connected/);
const connected = dmAccounts.get("sa-ig")!;
assert.equal(connected.transport, "native");
assert.equal(connected.externalId, "17841400000000001");
assert.notEqual(connected.accessTokenEnc, "IG-LONG-TOKEN", "never stored in the clear");
assert.doesNotMatch(connected.accessTokenEnc, /IG-LONG-TOKEN/);
assert.equal(decryptSecret(connected.accessTokenEnc), "IG-LONG-TOKEN", "the stored token round-trips");
assert.ok(connected.tokenExpiresAt.getTime() > Date.now() + 59 * 86400_000, "a 60-day token");
for (const c of calls.slice(sinceConnect).filter((c) => c.url.includes("graph.instagram.com/v26.0"))) {
  assert.doesNotMatch(c.url, /IG-LONG-TOKEN/, `the token rides in the header, not ${c.url}`);
  assert.equal(c.auth, "Bearer IG-LONG-TOKEN");
}
assert.ok(calls.slice(sinceConnect).some((c) => c.url.includes("/me/subscribed_apps") && c.method === "POST"), "the account is subscribed to the webhook");
res = await call("GET", "/dm/status?clientId=c1", OWNER);
assert.equal(res.json().accounts[0].transport, "native", "status follows the connect");
assert.equal(res.json().accounts[0].canConnect, true);

// ---------------------------------------------------------------------------
// 5. Replies and the 24h window
// ---------------------------------------------------------------------------

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const nativeThread = (lastInboundAt: Date | null): Row => ({
  id: "t1",
  dmAccountId: "dm-sa-ig",
  contactId: "ct1",
  source: "native",
  externalId: null,
  status: "open",
  unread: 1,
  pausedAt: null,
  lastMessageAt: lastInboundAt,
  lastPreview: "hi",
  lastDirection: "in",
  lastInboundAt,
  windowEndsAt: null,
  contact: { id: "ct1", externalId: "999", displayName: "Jordan", handle: "jordan.sample", avatarUrl: null, stage: "new", notes: null, optIn: false, lastSeenAt: null, tags: [] },
  dmAccount: {
    clientId: "c1",
    platform: "instagram",
    transport: "native",
    status: "active",
    accessTokenEnc: encryptSecret("IG-LONG-TOKEN"),
    socialAccount: { id: "sa-ig", handle: "sample.studio", providerAccountId: "z-ig" },
    client: { providerProfileId: "prof1" },
  },
});
const sends = () => calls.filter((c) => c.url.endsWith("/me/messages")).length;

thread = nativeThread(hoursAgo(25));
let sent = sends();
res = await call("POST", "/clients/c1/dm/threads/t1/reply", OWNER, { text: "Thanks for writing" });
assert.equal(res.statusCode, 409, "outside 24h");
assert.equal(res.json().reason, "window_closed");
assert.equal(sends(), sent, "nothing was sent to Meta");
thread = nativeThread(null);
assert.equal((await call("POST", "/clients/c1/dm/threads/t1/reply", OWNER, { text: "hi" })).json().reason, "window_closed", "never messaged");
assert.equal((await call("POST", "/clients/c1/dm/threads/t1/reply", OWNER, {})).statusCode, 400, "an empty reply is refused");

thread = nativeThread(hoursAgo(1));
assert.equal((await call("POST", "/clients/c1/dm/threads/t1/reply", VIEWER, { text: "hi" })).statusCode, 403, "the viewer send bug is closed");
assert.equal(sends(), sent);
res = await call("POST", "/clients/c1/dm/threads/t1/reply", OWNER, { text: "Thanks for writing", media: { type: "image", url: "https://files.test/a.jpg" } });
assert.equal(res.statusCode, 200, res.body);
assert.equal(sends(), sent + 2, "text and image are two Instagram messages");
assert.deepEqual(res.json().messages.map((m: Row) => [m.text, m.attachments.length]), [["Thanks for writing", 0], [null, 1]]);
const lastSend = JSON.parse(calls.filter((c) => c.url.endsWith("/me/messages")).at(-1)!.body);
assert.deepEqual(lastSend.recipient, { id: "999" });
assert.equal(lastSend.messaging_type, undefined, "inside the window: a plain reply");
assert.equal(messages.at(-1)!.sentByUserId, "u1", "who pressed Send is kept");
assert.deepEqual(
  [notified.at(-1)!.kind, notified.at(-1)!.threadId, notified.at(-1)!.clientId, notified.at(-1)!.messageId],
  ["out", "t1", "c1", messages.at(-1)!.id],
  "a send tells the other open Inboxes",
);

env.META_IG_HUMAN_AGENT = true;
thread = nativeThread(hoursAgo(30));
res = await call("POST", "/clients/c1/dm/threads/t1/reply", OWNER, { text: "Following up" });
assert.equal(res.statusCode, 200, "day 2 with the human agent feature");
const tagged = JSON.parse(calls.filter((c) => c.url.endsWith("/me/messages")).at(-1)!.body);
assert.equal(tagged.tag, "HUMAN_AGENT");
assert.equal(tagged.messaging_type, "MESSAGE_TAG");
env.META_IG_HUMAN_AGENT = false;

// A revoked token never reaches Meta.
thread = nativeThread(hoursAgo(1));
thread.dmAccount.status = "revoked";
sent = sends();
assert.equal((await call("POST", "/clients/c1/dm/threads/t1/reply", OWNER, { text: "hi" })).json().reason, "reconnect");
assert.equal(sends(), sent);

// ---------------------------------------------------------------------------
// 6. The media proxy: a native attachment Meta expired is read again
// ---------------------------------------------------------------------------

thread = nativeThread(hoursAgo(1));
messages.push({ id: "old1", externalId: "mid.old", direction: "in", unsentAt: null, attachments: [{ type: "image", url: "https://scontent.cdninstagram.com/old.jpg" }], thread: { dmAccount: { accessTokenEnc: encryptSecret("IG-LONG-TOKEN"), status: "active" } } });
expired.add("https://scontent.cdninstagram.com/old.jpg");
const { mediaLink } = await import("../routes/dm");
const nativeLink = new URL(mediaLink("http://localhost:80", "n/old1/0"));
res = await call("GET", nativeLink.pathname + nativeLink.search);
assert.equal(res.statusCode, 200, "refreshed and served");
assert.equal(res.headers["content-type"], "image/jpeg");
assert.equal(messages.find((m) => m.id === "old1")!.attachments[0].url, "https://scontent.cdninstagram.com/fresh.jpg", "the fresh URL is saved");
assert.equal((await call("GET", nativeLink.pathname + nativeLink.search.replace(/s=[^&]+/, "s=forged"))).statusCode, 404, "a forged link is not served");
assert.equal((await call("GET", "/dm/media/n/old1/0")).statusCode, 404, "an unsigned link is not served");

// ---------------------------------------------------------------------------
// 7. The Zernio fallback still serves the old inbox, with refreshable images
// ---------------------------------------------------------------------------

res = await call("GET", "/clients/c1/inbox?accountId=sa-ig", VIEWER);
assert.equal(res.statusCode, 200, "the old inbox list still works");
assert.equal(res.json().conversations[0].id, "conv1");
res = await call("GET", "/clients/c1/inbox/conv1?accountId=sa-ig", VIEWER);
assert.equal(res.statusCode, 200);
const att = res.json().messages[0].attachments[0];
assert.equal(att.type, "image");
assert.match(att.url, /^http:\/\/localhost:80\/dm\/media\/z\/sa-ig\/conv1\/m1\/0\?e=\d+&s=/, "absolute proxy link, old desktop builds draw it too");
const zLink = new URL(att.url);
res = await call("GET", zLink.pathname + zLink.search);
assert.equal(res.statusCode, 200, "fresh image through the hint");
assert.ok(calls.at(-1)!.url.endsWith("z-original.jpg"));
expired.add("https://scontent.cdninstagram.com/z-original.jpg");
res = await call("GET", zLink.pathname + zLink.search);
assert.equal(res.statusCode, 200, "expired image refreshed through Zernio");
assert.ok(calls.some((c) => c.url.includes("/attachments/0?accountId=z-ig")), "Zernio's attachment refresh is finally called");
assert.equal((await call("POST", "/clients/c1/inbox/conv1/reply", VIEWER, { accountId: "sa-ig", message: "hi" })).statusCode, 403);
assert.equal((await call("POST", "/clients/c1/inbox/conv1/reply", OWNER, { accountId: "sa-ig", message: "hi" })).statusCode, 200, "the operator still replies");

// ---------------------------------------------------------------------------
// 8. DM campaign post scope: YouTube ids are refused
// ---------------------------------------------------------------------------

const campaign = { accountId: "sa-ig", name: "Guide", dmMessage: "Here it is", keywords: ["guide"] };
res = await call("POST", "/clients/c1/dm-campaigns", OWNER, { ...campaign, platformPostId: "dQw4w9WgXcQ" });
assert.equal(res.statusCode, 400);
assert.equal(res.json().reason, "bad_post_scope");
res = await call("POST", "/clients/c1/dm-campaigns", OWNER, { ...campaign, platformPostId: "17895695668004550" });
assert.equal(res.statusCode, 201, res.body);

// ---------------------------------------------------------------------------
// 9. F3: Inbox filters, the Zernio poll throttle, photo upload, contacts bulk
// ---------------------------------------------------------------------------

const zernioLists = () => calls.filter((c) => c.url.includes("zernio.com") && c.url.includes("/inbox/conversations?")).length;
const { resetZernioSync } = await import("./service");
resetZernioSync();
let lists = zernioLists();
res = await call("GET", "/clients/c1/dm/threads?platform=facebook&paused=1&unread=1&status=waiting", VIEWER);
assert.equal(res.statusCode, 200, res.body);
const listWhere = threadQueries.at(-1)!;
assert.deepEqual(listWhere.dmAccount.socialAccountId.in, ["sa-fb"], "platform picks that channel's accounts");
assert.deepEqual(listWhere.pausedAt, { not: null }, "paused=1");
assert.deepEqual(listWhere.unread, { gt: 0 }, "unread=1");
assert.equal(listWhere.status, "waiting");
assert.equal(typeof res.json().counts.paused, "number", "the Paused tab has a count");
assert.equal(zernioLists(), lists + 1, "the first poll reads Zernio");
await call("GET", "/clients/c1/dm/threads?platform=facebook", VIEWER);
await call("GET", "/clients/c1/dm/threads?platform=facebook&paused=0", VIEWER);
assert.equal(zernioLists(), lists + 1, "4-second polls inside 15 seconds read the mirror, not Zernio");
assert.deepEqual(threadQueries.at(-1)!.pausedAt, null, "paused=0");

// A photo for a reply: stored, and handed back as a signed public link Instagram can fetch.
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
env.STORAGE_DIR = mkdtempSync(`${tmpdir()}/dm-upload-`);
const form = (type: string, name: string, bytes: Buffer) => {
  const b = "----dmcheck";
  const crlf = String.fromCharCode(13, 10);
  const payload = Buffer.concat([
    Buffer.from(`--${b}${crlf}Content-Disposition: form-data; name="file"; filename="${name}"${crlf}Content-Type: ${type}${crlf}${crlf}`),
    bytes,
    Buffer.from(`${crlf}--${b}--${crlf}`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${b}` } };
};
const png = form("image/png", "a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
res = await app.inject({ method: "POST", url: "/clients/c1/dm/upload", headers: { authorization: OWNER, ...png.headers }, payload: png.payload });
assert.equal(res.statusCode, 201, res.body);
assert.match(res.json().url, /^http:\/\/localhost:80\/files\/c1\/dm\/[0-9a-f-]+\.png\?e=\d+&s=/, "absolute signed link");
const txt = form("text/plain", "a.txt", Buffer.from("hi"));
res = await app.inject({ method: "POST", url: "/clients/c1/dm/upload", headers: { authorization: OWNER, ...txt.headers }, payload: txt.payload });
assert.equal(res.statusCode, 400, "only images Instagram takes");
res = await app.inject({ method: "POST", url: "/clients/c1/dm/upload", headers: { authorization: VIEWER, ...png.headers }, payload: png.payload });
assert.equal(res.statusCode, 403, "a viewer cannot upload");

// Contacts select mode.
res = await call("POST", "/clients/c1/dm/contacts/bulk", OWNER, { ids: ["ct1", "ct9"], stage: "won" });
assert.equal(res.statusCode, 404, "one contact of another brand fails the whole call");
assert.equal(bulkWrites.length, 0, "and changes nothing");
assert.equal((await call("POST", "/clients/c1/dm/contacts/bulk", OWNER, { ids: ["ct1"] })).statusCode, 400, "nothing to change");
res = await call("POST", "/clients/c1/dm/contacts/bulk", OWNER, { ids: ["ct1", "ct2", "ct1"], stage: "won", addTags: ["vip"], removeTags: ["lead"] });
assert.equal(res.statusCode, 200, res.body);
assert.equal(res.json().updated, 2);
assert.deepEqual(bulkWrites.map((w) => w.op), ["stage", "add", "remove"]);
assert.deepEqual(bulkWrites[1]!.data, [{ contactId: "ct1", tagId: "tag-vip" }, { contactId: "ct2", tagId: "tag-vip" }]);
assert.deepEqual(bulkWrites[2]!.where.tag, { clientId: "c1", name: { in: ["lead"] } }, "only this client's tag is removed");
assert.equal((await call("POST", "/clients/c1/dm/contacts/bulk", POLLY, { ids: ["ct1"], stage: "won" })).statusCode, 403, "Polly reads, never edits");

// ---------------------------------------------------------------------------
// 10. F7: mark one read (opening it) and mark all as read
// ---------------------------------------------------------------------------

const seens = () => calls.filter((c) => c.url.endsWith("/me/messages") && c.body.includes("mark_seen")).length;
thread = nativeThread(hoursAgo(1));
let seen = seens();
threadUpdates.length = 0;
res = await call("POST", "/clients/c1/dm/threads/t1/read", OWNER);
assert.equal(res.statusCode, 200, res.body);
assert.equal(threadUpdates.at(-1)!.unread, 0, "the operator's open clears the count");
assert.ok(threadUpdates.at(-1)!.readAt instanceof Date, "and stamps readAt, so Zernio's count cannot bring it back");
assert.equal(seens(), seen + 1, "the operator's read sends Instagram's Seen");
assert.deepEqual([notified.at(-1)!.kind, notified.at(-1)!.threadId], ["read", "t1"], "a read clears the dot on the other devices too");
for (const [who, auth] of [["viewer", VIEWER], ["logged-in viewer", LOGGED_IN_VIEWER], ["pre-F2 viewer token", OLD_VIEWER]] as const) {
  threadUpdates.length = 0;
  seen = seens();
  res = await call("POST", "/clients/c1/dm/threads/t1/read", auth);
  assert.equal(res.statusCode, 200, `${who} marks a thread read: ${res.body}`);
  assert.equal(threadUpdates.at(-1)!.unread, 0, `${who}'s read is saved`);
  assert.equal(seens(), seen, `${who}'s read sends Instagram nothing`);
}
assert.equal((await call("POST", "/clients/c1/dm/threads/t9/read", VIEWER)).statusCode, 404, "a thread the viewer cannot see is not marked");
assert.equal((await call("POST", "/clients/c2/dm/threads/t1/read", VIEWER)).statusCode, 404, "nor through another brand's id");
assert.equal((await call("POST", "/clients/c1/dm/threads/t1/read")).statusCode, 401, "mark read needs a session");
assert.equal((await call("POST", "/clients/c1/dm/threads/t1/read", POLLY)).statusCode, 403, "bots still only read");

const sentBefore = sends();
for (const [who, auth] of [["owner", OWNER], ["viewer", VIEWER], ["logged-in viewer", LOGGED_IN_VIEWER], ["pre-F2 viewer token", OLD_VIEWER]] as const) {
  readAlls.length = 0;
  res = await call("POST", "/clients/c1/dm/threads/read-all", auth);
  assert.equal(res.statusCode, 200, `${who} marks all as read: ${res.body}`);
  assert.deepEqual(res.json(), { ok: true, updated: 3 });
  assert.equal(readAlls.length, 1, "one write");
  assert.deepEqual(readAlls[0]!.where, { dmAccount: { clientId: "c1" }, unread: { gt: 0 } }, "every unread conversation of this brand, and only this brand");
  assert.equal(readAlls[0]!.data.unread, 0);
  assert.ok(readAlls[0]!.data.readAt instanceof Date, "readAt keeps Zernio's count from undoing it");
}
assert.equal(sends(), sentBefore, "mark all sends nothing to Instagram, not even Seen");
assert.deepEqual([notified.at(-1)!.kind, notified.at(-1)!.threadId, notified.at(-1)!.clientId], ["read", "*", "c1"], "mark all is one event for the brand");
assert.ok(!JSON.stringify(notified).includes("Thanks for writing"), "no message text on the channel");
readAlls.length = 0;
assert.equal((await call("POST", "/clients/c2/dm/threads/read-all", VIEWER)).statusCode, 404, "a viewer cannot mark another agency's brand");
assert.equal((await call("POST", "/clients/c2/dm/threads/read-all", OWNER)).statusCode, 404, "nor can its owner");
assert.equal(readAlls.length, 0, "and nothing was written");
assert.equal((await call("POST", "/clients/c1/dm/threads/read-all")).statusCode, 401, "mark all needs a session");
for (const auth of [POLLY, NOVA]) assert.equal((await call("POST", "/clients/c1/dm/threads/read-all", auth)).statusCode, 403, "bots still only read");
// Marking read opens nothing else to viewers: a send is still 403.
for (const auth of [VIEWER, LOGGED_IN_VIEWER, OLD_VIEWER]) {
  assert.equal((await call("POST", "/clients/c1/dm/threads/t1/reply", auth, { text: "hi" })).statusCode, 403, "a viewer still cannot send");
}
assert.equal(sends(), sentBefore, "no viewer send reached Instagram");

// ---------------------------------------------------------------------------
// 11. G1: a long thread opens on its newest messages, pages back, counts true
// ---------------------------------------------------------------------------

const { resetZernioCounts } = await import("./service");
const contactRow = { ...nativeThread(null).contact, createdAt: new Date("2026-09-01T00:00:00Z") };
const ids = (r: { json(): Row }) => r.json().messages.map((m: Row) => m.externalId);
const range = (from: number, to: number, p = "zm") => Array.from({ length: to - from + 1 }, (_, i) => `${p}${from + i}`);

// Native: 120 stored messages, two of them at the same second (the id breaks the tie).
thread = { ...nativeThread(hoursAgo(1)), id: "tN", contact: contactRow };
const nAt = (i: number) => new Date(Date.UTC(2026, 9, 1) + Math.min(i, 118) * 60_000);
for (let i = 0; i < 120; i++) {
  messages.push({ id: `n${String(i).padStart(3, "0")}`, threadId: "tN", externalId: `mid.n${i}`, direction: i % 2 ? "in" : "out", text: `n ${i}`, attachments: null, replyToExternalId: null, reactions: null, unsentAt: null, editedAt: null, transcript: null, status: "sent", error: null, sentAt: nAt(i) });
}
const nIds = (from: number, to: number) => range(from, to, "mid.n");
res = await call("GET", "/clients/c1/dm/threads/tN", VIEWER);
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(ids(res), nIds(70, 119), "native: the newest 50, oldest first, the newest last");
assert.deepEqual(res.json().activity, { messages: 120, messagesExact: true, firstSeenAt: "2026-09-01T00:00:00.000Z", cameFrom: "Direct message" }, "native: the true count");
res = await call("GET", `/clients/c1/dm/threads/tN?before=${res.json().nextCursor}`, VIEWER);
assert.deepEqual(ids(res), nIds(20, 69), "native: ?before is the 50 before");
res = await call("GET", `/clients/c1/dm/threads/tN?before=${res.json().nextCursor}`, VIEWER);
assert.deepEqual(ids(res), nIds(0, 19), "native: then the first 20");
assert.equal(res.json().nextCursor, null, "and nothing before the first message");

// Zernio that honors sortOrder: 50 newest, Zernio's cursor back, a true count walked once.
const zThread = (lastDirection: string | null): Row => ({
  ...nativeThread(hoursAgo(1)),
  id: "tL",
  source: "zernio",
  externalId: "convL",
  lastDirection,
  lastMessageAt: new Date(zAt(119)),
  contact: contactRow,
  dmAccount: { ...nativeThread(null).dmAccount, transport: "zernio" },
});
const zCalls = () => calls.filter((c) => c.url.includes("/inbox/conversations/convL/messages")).length;
thread = zThread("in");
resetZernioCounts();
let zc = zCalls();
res = await call("GET", "/clients/c1/dm/threads/tL", VIEWER);
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(ids(res), range(70, 119), "zernio: the newest 50, oldest first");
assert.match(calls.filter((c) => c.url.includes("convL")).at(zc - zCalls())!.url, /sortOrder=desc/, "asked newest first");
assert.deepEqual([res.json().activity.messages, res.json().activity.messagesExact], [120, true], "zernio: the true count, not the page size");
assert.equal(zCalls(), zc + 3, "one page, then a two-page count walk");
zc = zCalls();
res = await call("GET", "/clients/c1/dm/threads/tL", VIEWER);
assert.equal(zCalls(), zc + 1, "the next read (a poll) reuses the count");
assert.equal(res.json().activity.messages, 120);
const z1 = res.json().nextCursor as string;
assert.match(z1, /^z:/, "an opaque cursor for older");
res = await call("GET", `/clients/c1/dm/threads/tL?before=${encodeURIComponent(z1)}`, VIEWER);
assert.deepEqual(ids(res), range(20, 69), "zernio: ?before is the 50 before");
res = await call("GET", `/clients/c1/dm/threads/tL?before=${encodeURIComponent(res.json().nextCursor)}`, VIEWER);
assert.deepEqual(ids(res), range(0, 19), "zernio: then the first 20");
assert.equal(res.json().nextCursor, null);
// A new message: on the page at once, the count grows by one page read, not a walk.
zMsgs.push(zMsg(120));
zc = zCalls();
res = await call("GET", "/clients/c1/dm/threads/tL", VIEWER);
assert.equal(ids(res).at(-1), "zm120", "the new message is last");
assert.equal(res.json().activity.messages, 121);
assert.equal(zCalls(), zc + 2, "page plus one count page that stops at the known newest");

// Zernio that ignores sortOrder (always oldest first): walked to the end, the tail kept, offset cursors.
for (const mode of ["ignores", "newest-pages"] as const) {
  zMode = mode;
  resetZernioCounts();
  res = await call("GET", "/clients/c1/dm/threads/tL", VIEWER);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(ids(res), range(71, 120), `${mode}: still the newest 50, oldest first`);
  assert.deepEqual([res.json().activity.messages, res.json().activity.messagesExact], [121, true], `${mode}: counted by the walk`);
  assert.equal(res.json().nextCursor, "w:71");
  res = await call("GET", "/clients/c1/dm/threads/tL?before=w%3A71", VIEWER);
  assert.deepEqual(ids(res), range(21, 70), `${mode}: older page`);
  res = await call("GET", `/clients/c1/dm/threads/tL?before=${encodeURIComponent(res.json().nextCursor)}`, VIEWER);
  assert.deepEqual(ids(res), range(0, 20), `${mode}: the start`);
  assert.equal(res.json().nextCursor, null);
}
zMode = "honors";

// The live case (Elina): a Zernio thread on an account moved to Torerone's Meta
// app. The webhook stored the newest messages here; Zernio has some of them.
const stored = (externalId: string, direction: string, text: string, sentAt: string) =>
  messages.push({ id: `s-${externalId}`, threadId: "tL", externalId, direction, text, attachments: null, replyToExternalId: null, reactions: null, unsentAt: null, editedAt: null, transcript: null, status: "sent", error: null, sentAt: new Date(sentAt) });
stored("zm120", "out", "z 120", zAt(120)); // the same Instagram message id
stored("mid.fuzzy", "in", "z 119", new Date(Date.parse(zAt(119)) + 3000).toISOString()); // same words, 3 seconds off
stored("mid.new", "out", "this is a message from my app", new Date(Date.parse(zAt(120)) + 60_000).toISOString());
thread = zThread("in");
threadUpdates.length = 0;
resetZernioCounts();
res = await call("GET", "/clients/c1/dm/threads/tL", VIEWER);
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(ids(res).slice(-3), ["zm119", "zm120", "mid.new"], "stored messages Zernio lacks are added once, in time order");
assert.equal(res.json().messages.at(-1).text, "this is a message from my app", "the newest message is last");
assert.equal(ids(res).length, 51, "no duplicate of zm119 or zm120");
assert.equal(res.json().activity.messages, 122, "the count includes it");
assert.equal(threadUpdates.at(-1)?.lastDirection, "out", "the row learns who wrote last");
assert.equal(res.json().thread.lastDirection, "out");
// Zernio down: the stored messages still draw rather than an error.
zMode = "fails";
res = await call("GET", "/clients/c1/dm/threads/tL", VIEWER);
assert.equal(res.statusCode, 200, "falls back to the stored messages");
assert.deepEqual(ids(res), ["mid.fuzzy", "zm120", "mid.new"]);
assert.equal(res.json().activity.messagesExact, true);
assert.equal((await call("GET", `/clients/c1/dm/threads/tL?before=${encodeURIComponent(z1)}`, VIEWER)).statusCode, 502, "an older Zernio page cannot fall back");
for (const m of [...messages]) if (m.threadId === "tL") messages.splice(messages.indexOf(m), 1);
assert.equal((await call("GET", "/clients/c1/dm/threads/tL", VIEWER)).statusCode, 502, "nothing stored: Zernio's error");
zMode = "honors";
assert.equal((await call("GET", "/clients/c1/dm/threads/tL")).statusCode, 401, "the thread needs a session");

// The list sync now writes who wrote last.
resetZernioSync();
threadUpserts.length = 0;
await call("GET", "/clients/c1/dm/threads?accountId=sa-fb", VIEWER);
assert.equal(threadUpserts.at(-1)?.create.lastDirection, "in", "a new mirror row with unread words is theirs");
resetZernioSync();
threadUpdates.length = 0;
syncHave = { id: "tz", externalId: "conv1", contactId: "ct-z", status: "open", unread: 2, readAt: null, lastPreview: "hi", lastDirection: "out", lastMessageAt: new Date("2026-11-19T10:00:00Z"), contact: { avatarUrl: null, displayName: "Jordan" } };
await call("GET", "/clients/c1/dm/threads?accountId=sa-fb", VIEWER);
assert.equal(threadUpdates.at(-1)?.lastDirection, "out", "our own reply (same words) keeps its You:");
resetZernioSync();
syncHave = { ...syncHave, lastPreview: "something we sent earlier" };
await call("GET", "/clients/c1/dm/threads?accountId=sa-fb", VIEWER);
assert.equal(threadUpdates.at(-1)?.lastDirection, "in", "new words with unread are theirs, never You:");
syncHave = null;

await app.close();
console.log("dm.check: all checks passed");
