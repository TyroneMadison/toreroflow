// AI replies and Metrics (F5), the API half, through the real auth hook and
// routes with Prisma and Claude faked: every write route refuses viewers and
// bots (Polly included); an account with no settings row reads as OFF and
// drafts only; autopilot is refused where the AI cannot send (Messenger,
// Instagram through Zernio); turning it off drops what was queued; the kill
// switch; Try a test message; the per-chat switch; Metrics and the rail summary.
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
process.env.JWT_SECRET = "ai-check-secret";
process.env.ANTHROPIC_API_KEY = "sk-check";

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { env } = await import("../env");
const { dmAiRoutes, setTestWriter } = await import("../routes/dmAi");
Object.assign(env, { ANTHROPIC_API_KEY: "sk-check" });

type Row = Record<string, any>;
let n = 0;
const id = (p: string) => `${p}${++n}`;
const CLIENT = { id: "c1", agencyId: "A", providerProfileId: "prof1" };
const dmIg = { id: "dm-ig", socialAccountId: "sa-ig", transport: "native", status: "active", platform: "instagram" };
const dmZ = { id: "dm-z", socialAccountId: "sa-ig2", transport: "zernio", status: "active", platform: "instagram" };
const SOCIALS: Row[] = [
  { id: "sa-ig", clientId: "c1", platform: "instagram", handle: "sample.handle", status: "connected", providerAccountId: "z-ig", dmAccount: dmIg },
  { id: "sa-ig2", clientId: "c1", platform: "instagram", handle: "sample.studio", status: "connected", providerAccountId: "z-ig2", dmAccount: dmZ },
  { id: "sa-fb", clientId: "c1", platform: "facebook", handle: "samplepage", status: "connected", providerAccountId: "z-fb", dmAccount: null },
];
let settings: Row[] = [];
let drafts: Row[] = [];
const kill: { row: Row | null } = { row: null };
const thread: Row = {
  id: "t1",
  dmAccountId: "dm-ig",
  contactId: "ct1",
  source: "native",
  status: "open",
  unread: 0,
  pausedAt: null,
  aiOff: false,
  aiHandoffAt: new Date(),
  aiHandoffReason: "Asked about price",
  aiPausedUntil: null,
  lastMessageAt: new Date(),
  lastPreview: "How much?",
  lastDirection: "in",
  lastInboundAt: new Date(Date.now() - 3600_000),
  windowEndsAt: new Date(Date.now() + 20 * 3600_000),
  externalId: null,
};
const withRels = (t: Row) => ({
  ...t,
  contact: { id: "ct1", displayName: "Sam", handle: "sam.sample", avatarUrl: null, stage: "engaged", notes: null, optIn: false, lastSeenAt: null, createdAt: new Date(), tags: [] },
  dmAccount: { platform: "instagram", transport: "native", status: "active", socialAccount: { id: "sa-ig", handle: "sample.handle" } },
});

const prisma = getPrisma() as unknown as Record<string, unknown>;
const fake = (name: string, value: object) => Object.defineProperty(prisma, name, { value, configurable: true });
fake("botIdentity", { findUnique: async () => null });
fake("user", { findFirst: async ({ where }: Row) => ({ id: where.id, agencyId: "A", role: "owner" }), findUnique: async () => null });
fake("client", {
  findFirst: async ({ where }: Row) => (where.id === CLIENT.id && where.agencyId === CLIENT.agencyId ? CLIENT : null),
  findUnique: async () => ({ name: "Sample Client", driveSource: null }),
});
fake("socialAccount", { findMany: async ({ where }: Row) => SOCIALS.filter((s) => s.clientId === where.clientId) });
fake("dmAccount", {
  upsert: async ({ create }: Row) => {
    const row = { id: id("dm"), status: "active", ...create };
    SOCIALS.find((s) => s.id === create.socialAccountId)!.dmAccount = row;
    return row;
  },
});
fake("dmAiSettings", {
  findMany: async ({ where }: Row) => settings.filter((s) => (where.dmAccountId ? where.dmAccountId.in.includes(s.dmAccountId) : s.enabled === where.enabled)),
  findUnique: async ({ where }: Row) => settings.find((s) => s.dmAccountId === where.dmAccountId) ?? null,
  upsert: async ({ where, create, update }: Row) => {
    const had = settings.find((s) => s.dmAccountId === where.dmAccountId);
    if (had) return Object.assign(had, update, { updatedAt: new Date() });
    const row = { ...create, updatedAt: new Date() };
    settings.push(row);
    return row;
  },
});
fake("dmAiDraft", {
  groupBy: async () => [],
  findMany: async () => drafts,
  aggregate: async () => ({ _sum: { costCents: drafts.reduce((a, d) => a + (d.costCents ?? 0), 0) } }),
  updateMany: async ({ where, data }: Row) => {
    const hit = drafts.filter((d) => (!where.dmAccountId || d.dmAccountId === where.dmAccountId) && (!where.threadId || d.threadId === where.threadId) && d.status === where.status);
    hit.forEach((d) => Object.assign(d, data));
    return { count: hit.length };
  },
  findFirst: async ({ where }: Row) => drafts.find((d) => d.id === where.id) ?? null,
  update: async ({ where, data }: Row) => Object.assign(drafts.find((d) => d.id === where.id)!, data),
});
fake("dmThread", {
  findMany: async ({ where }: Row) => (where.aiHandoffAt?.not === null && thread.aiHandoffAt ? [withRels(thread)] : []),
  findFirst: async ({ where }: Row) => (where.id === thread.id && where.dmAccount.clientId === "c1" ? withRels(thread) : null),
  update: async ({ data }: Row) => withRels(Object.assign(thread, data)),
  aggregate: async () => ({ _sum: { unread: 3 } }),
});
fake("dmContact", { groupBy: async () => [{ stage: "engaged", _count: { _all: 4 } }], findMany: async () => [], count: async () => 12 });
fake("appSetting", {
  findUnique: async () => kill.row,
  upsert: async ({ create }: Row) => (kill.row = create),
  deleteMany: async () => ((kill.row = null), { count: 1 }),
});
fake("dmMessage", { findMany: async () => [] });
fake("dmAutomationRun", { findMany: async () => [] });
fake("dmAutomation", { findMany: async () => [], count: async () => 2 });
fake("workflow", { count: async () => 3 });
let written: Array<{ system: string; user: string }> = [];
setTestWriter(async (system, user) => {
  written.push({ system, user });
  return { text: JSON.stringify({ action: "reply", bubbles: ["We are open Sundays 9 to 5."], stage: "engaged", note: "", reason: "hours" }), refused: false };
});

// ---- the app ----
const app = Fastify();
await app.register(jwt, { secret: env.JWT_SECRET });
const { ZodError } = await import("zod");
app.setErrorHandler((e, _req, reply) => reply.status(e instanceof ZodError ? 400 : 500).send({ error: e instanceof Error ? e.message : "failed" }));
const routes: { method: string; url: string }[] = [];
app.addHook("onRoute", (r) => {
  for (const method of [r.method].flat()) routes.push({ method: String(method), url: r.url });
});
await app.register(dmAiRoutes);
await app.ready();
const sign = (claims: Row) => `Bearer ${app.jwt.sign({ sub: "u1", agencyId: "A", ...claims } as never)}`;
const OWNER = sign({});
const VIEWER = sign({ role: "viewer" });
const POLLY = sign({ role: "bot", bot: "polly" });
const call = (method: string, url: string, auth?: string, payload?: unknown) =>
  app.inject({ method: method as "GET", url, payload: payload as string, headers: auth ? { authorization: auth } : {} });

// 1. Every write refuses viewers and bots, Polly included; reads are open.
const writes = routes.filter((r) => r.method !== "GET" && r.method !== "HEAD");
for (const expected of [
  "PUT /clients/:id/dm/ai/:accountId",
  "POST /clients/:id/dm/ai/kill",
  "POST /clients/:id/dm/ai/test",
  "POST /clients/:id/dm/threads/:threadId/ai",
  "POST /clients/:id/dm/threads/:threadId/ai-draft",
  "POST /clients/:id/dm/ai/drafts/:draftId/discard",
]) {
  assert.ok(writes.some((r) => `${r.method} ${r.url}` === expected), `${expected} is registered and covered`);
}
for (const r of writes) {
  for (const [who, auth] of [["viewer", VIEWER], ["polly", POLLY]] as const) {
    const out = await call(r.method, r.url.replace(":id", "c1").replace(/:\w+/g, "sa-ig"), auth, { enabled: true, stopped: true, off: true, accountId: "sa-ig", text: "hi" });
    assert.equal(out.statusCode, 403, `${who} ${r.method} ${r.url} must be 403`);
  }
}
assert.equal(settings.length, 0, "nothing was saved by a refused caller");
assert.equal(kill.row, null);
assert.equal((await call("GET", "/clients/c1/dm/ai", VIEWER)).statusCode, 200, "a viewer reads the page");
assert.equal((await call("GET", "/clients/c1/dm/ai")).statusCode, 401);
assert.equal((await call("GET", "/clients/c9/dm/ai", OWNER)).statusCode, 404, "another agency's client");

// 2. A new account is OFF and drafts only until a person turns it on.
let res = await call("GET", "/clients/c1/dm/ai", OWNER);
const page = res.json();
assert.equal(page.accounts.length, 3);
for (const a of page.accounts) {
  assert.equal(a.settings.enabled, false, `${a.handle} is off by default`);
  assert.equal(a.settings.mode, "drafts");
}
assert.deepEqual(page.accounts.map((a: Row) => a.canAutopilot), [true, false, false], "only Instagram through our Meta app can send on its own");
assert.equal(page.queue[0].why, "handoff");
assert.equal(page.queue[0].reason, "Asked about price");
assert.equal(page.killedAt, null);

// 3. Autopilot only where the AI can send.
res = await call("PUT", "/clients/c1/dm/ai/sa-fb", OWNER, { enabled: true, mode: "autopilot" });
assert.equal(res.statusCode, 400);
assert.equal(res.json().reason, "autopilot_needs_native");
res = await call("PUT", "/clients/c1/dm/ai/sa-ig2", OWNER, { enabled: true, mode: "autopilot" });
assert.equal(res.statusCode, 400, "Instagram through Zernio stays drafts only");
res = await call("PUT", "/clients/c1/dm/ai/sa-fb", OWNER, { enabled: true });
assert.equal(res.statusCode, 200, "Messenger may write drafts");
assert.ok(SOCIALS[2]!.dmAccount, "a DM row was made for it");
res = await call("PUT", "/clients/c1/dm/ai/sa-ig", OWNER, { enabled: true, mode: "autopilot", replyDelayMinSec: 20, replyDelayMaxSec: 90 });
assert.equal(res.statusCode, 200);
assert.equal(res.json().account.settings.mode, "autopilot");
assert.equal(res.json().account.settings.enabled, true);
assert.equal((await call("PUT", "/clients/c1/dm/ai/sa-ig", OWNER, { replyDelayMaxSec: 900 })).statusCode, 400, "the wait is capped at 5 minutes");
assert.equal((await call("PUT", "/clients/c1/dm/ai/sa-ig", OWNER, { replyDelayMinSec: 120 })).statusCode, 400, "min above the saved max");
// Back to drafts: what was queued stays a draft for a person.
drafts = [{ id: "d1", dmAccountId: "dm-ig", threadId: "t1", status: "queued", sendAt: new Date(), costCents: 3 }];
res = await call("PUT", "/clients/c1/dm/ai/sa-ig", OWNER, { mode: "drafts" });
assert.equal(res.statusCode, 200);
assert.equal(drafts[0]!.status, "draft");
assert.equal(drafts[0]!.sendAt, null);

// 4. The kill switch.
res = await call("POST", "/clients/c1/dm/ai/kill", OWNER, { stopped: true });
assert.ok(res.json().killedAt);
assert.ok((await call("GET", "/clients/c1/dm/ai", OWNER)).json().killedAt);
res = await call("POST", "/clients/c1/dm/ai/kill", OWNER, { stopped: false });
assert.equal(res.json().killedAt, null);

// 5. Try a test message: a handoff rule never asks the model; otherwise the reply comes back, unsent.
res = await call("POST", "/clients/c1/dm/ai/test", OWNER, { accountId: "sa-ig", text: "Can I get a refund?" });
assert.equal(res.json().action, "handoff");
assert.equal(res.json().rule, true);
assert.equal(written.length, 0);
res = await call("POST", "/clients/c1/dm/ai/test", OWNER, { accountId: "sa-ig", text: "Are you open on Sundays?" });
assert.deepEqual(res.json().bubbles, ["We are open Sundays 9 to 5."]);
assert.match(written[0]!.system, /assistant for Sample Client/);

// 6. The per-chat switch and Let the AI answer again.
res = await call("POST", "/clients/c1/dm/threads/t1/ai", OWNER, { off: true });
assert.equal(res.json().thread.ai.off, true);
res = await call("POST", "/clients/c1/dm/threads/t1/ai", OWNER, { resume: true });
assert.deepEqual(res.json().thread.ai, { off: false, handoffAt: null, handoffReason: null, pausedUntil: null });
assert.equal((await call("POST", "/clients/c1/dm/threads/t9/ai", OWNER, { off: true })).statusCode, 404);
// A draft on request needs AI replies on for the account.
settings.find((s) => s.dmAccountId === "dm-ig")!.enabled = false;
res = await call("POST", "/clients/c1/dm/threads/t1/ai-draft", OWNER);
assert.equal(res.statusCode, 409);
assert.equal(res.json().reason, "ai_off");
// Discard.
drafts = [{ id: "d2", dmAccountId: "dm-ig", threadId: "t1", status: "draft" }];
assert.equal((await call("POST", "/clients/c1/dm/ai/drafts/d2/discard", OWNER)).statusCode, 200);
assert.equal(drafts[0]!.status, "discarded");

// 7. Metrics and the rail summary.
res = await call("GET", "/clients/c1/dm/metrics?range=30", VIEWER);
assert.equal(res.statusCode, 200);
const m = res.json();
assert.equal(m.range, "30");
assert.equal(m.empty, true, "no rows, the empty state");
assert.equal(m.chart.days, 30);
assert.equal(m.accounts.length, 3);
assert.equal(m.partial, true, "Zernio accounts make the message counts partial");
assert.equal((await call("GET", "/clients/c1/dm/metrics?range=bogus", OWNER)).json().range, "7", "an unknown range reads as 7 days");
res = await call("GET", "/clients/c1/dm/summary", VIEWER);
assert.deepEqual(res.json(), { unread: 3, liveAutomations: 2, contacts: 12, ai: { on: 1, autopilot: 0 }, autoPost: { tone: "off", label: "Off" }, fanoutRules: 3 });

await app.close();
console.log("ai.check: ok");
