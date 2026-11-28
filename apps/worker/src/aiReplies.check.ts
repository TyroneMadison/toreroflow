// AI replies (F5), the worker half, on an in-memory Prisma with Claude, the
// Instagram Graph API and Zernio faked: off by default (no draft, no call),
// drafts only never sends, autopilot sends after its delay with typing, and
// every send gate re-checked at send time (kill switch, window, team reply,
// a new message, paused, handoff), handoff rules before the model, Messenger
// never answered unprompted and drafted on request only inside the window,
// one draft per inbound message, the daily cap, a model failure.
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.BUSINESS_TIMEZONE = "UTC";

const { encryptSecret, getPrisma, Prisma, setDmNotify } = await import("@toreroflow/db");
const notified: Array<Record<string, unknown>> = [];
setDmNotify(async (_c, payload) => void notified.push(JSON.parse(payload)));
const { aiTick, draftQuietThreads, draftThread, sendDueDrafts, setAiPause, setAiWriter, setAiZernio, DM_AI_KILL_KEY } = await import("./aiReplies");

type Row = Record<string, any>;
let n = 0;
const id = (p: string) => `${p}${++n}`;
const dup = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "check" });
const db = { accounts: [] as Row[], settings: [] as Row[], threads: [] as Row[], contacts: [] as Row[], messages: [] as Row[], drafts: [] as Row[], runs: [] as Row[], kill: null as Row | null };

const apply = (row: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
  row.updatedAt = new Date();
  return row;
};
const compose = (t: Row) => {
  const a = db.accounts.find((x) => x.id === t.dmAccountId)!;
  const c = db.contacts.find((x) => x.id === t.contactId)!;
  return {
    ...t,
    contact: { ...c, tags: (c.tags ?? []).map((name: string) => ({ tag: { name } })) },
    dmAccount: { ...a, aiSettings: db.settings.find((s) => s.dmAccountId === a.id) ?? null, client: { name: "Sample Client", agencyId: "A", providerProfileId: "prof" }, socialAccount: { handle: a.username, providerAccountId: a.providerAccountId ?? null } },
  };
};
const prisma = getPrisma() as unknown as Record<string, unknown>;
const fake = (name: string, value: object) => Object.defineProperty(prisma, name, { value, configurable: true });
fake("appSetting", { findUnique: async ({ where }: Row) => (where.agencyId_key.key === DM_AI_KILL_KEY && db.kill ? db.kill : null) });
fake("dmThread", {
  findUnique: async ({ where }: Row) => {
    const t = db.threads.find((x) => x.id === where.id);
    return t ? compose(t) : null;
  },
  // The quiet-thread query: the conditions that matter here, applied as Postgres would.
  findMany: async ({ where }: Row) => {
    const now = where.windowEndsAt.gt as Date;
    return db.threads
      .filter((t) => {
        const a = db.accounts.find((x) => x.id === t.dmAccountId)!;
        const s = db.settings.find((x) => x.dmAccountId === a.id);
        return (
          t.source === "native" &&
          t.lastDirection === "in" &&
          t.status !== "done" &&
          !t.pausedAt &&
          !t.aiOff &&
          !t.aiHandoffAt &&
          t.lastInboundAt <= where.lastInboundAt.lte &&
          t.lastInboundAt > where.lastInboundAt.gt &&
          t.windowEndsAt > now &&
          (!t.aiPausedUntil || t.aiPausedUntil <= now) &&
          a.transport === "native" &&
          a.status === "active" &&
          a.platform === "instagram" &&
          s?.enabled === true
        );
      })
      .map((t) => ({ id: t.id }));
  },
  update: async ({ where, data }: Row) => apply(db.threads.find((t) => t.id === where.id)!, data),
});
fake("dmMessage", {
  findMany: async ({ where, take }: Row) =>
    db.messages
      .filter((m) => m.threadId === where.threadId && !m.unsentAt && m.status === "sent")
      .sort((a, b) => b.sentAt - a.sentAt)
      .slice(0, take),
  findFirst: async ({ where }: Row) => db.messages.filter((m) => m.threadId === where.threadId && m.direction === where.direction).sort((a, b) => b.sentAt - a.sentAt)[0] ?? null,
  upsert: async ({ where, create }: Row) => {
    const had = db.messages.find((m) => m.threadId === where.threadId_externalId.threadId && m.externalId === where.threadId_externalId.externalId);
    if (had) return had;
    const row = { id: id("m"), unsentAt: null, attachments: null, ...create };
    db.messages.push(row);
    return row;
  },
});
fake("dmAiDraft", {
  create: async ({ data }: Row) => {
    if (db.drafts.some((d) => d.threadId === data.threadId && d.forExternalId === data.forExternalId)) throw dup();
    const row = { id: id("d"), bubbles: [], note: null, stage: null, reason: null, sendAt: null, sentAt: null, sentHow: null, messageExternalId: null, costCents: 0, createdAt: new Date(), updatedAt: new Date(), ...data };
    db.drafts.push(row);
    return row;
  },
  update: async ({ where, data }: Row) => apply(db.drafts.find((d) => d.id === where.id)!, data),
  updateMany: async ({ where, data }: Row) => {
    const hit = db.drafts.filter((d) => d.id === where.id && d.status === where.status);
    hit.forEach((d) => apply(d, data));
    return { count: hit.length };
  },
  findMany: async ({ where }: Row) => db.drafts.filter((d) => d.status === where.status && d.sendAt && d.sendAt <= where.sendAt.lte).sort((a, b) => a.sendAt - b.sendAt).map((d) => ({ id: d.id })),
  findUniqueOrThrow: async ({ where }: Row) => ({ ...db.drafts.find((d) => d.id === where.id)! }),
  count: async ({ where }: Row) => db.drafts.filter((d) => d.dmAccountId === where.dmAccountId && d.status === "sent" && d.sentHow === "auto" && d.sentAt > where.sentAt.gt).length,
});
fake("dmAutomationRun", { findFirst: async ({ where }: Row) => db.runs.find((r) => r.dmAccountId === where.dmAccountId && r.eventKey === where.eventKey && where.status.in.includes(r.status)) ?? null });
fake("dmContact", { update: async ({ where, data }: Row) => apply(db.contacts.find((c) => c.id === where.id)!, data) });
fake("dmAccount", { update: async ({ where, data }: Row) => apply(db.accounts.find((a) => a.id === where.id)!, data) });
fake("client", { findUnique: async () => ({ agencyId: "A" }) });
fake("systemAlert", { upsert: async () => ({}) });

// ---- Claude, Instagram and Zernio, faked ----
let writes: Array<{ system: string; user: string }> = [];
let answer: Row | Error = { action: "reply", bubbles: ["Hi! We are open 7 AM to 8 PM."], stage: "engaged", note: "Asked about hours", reason: "hours" };
setAiWriter(async (system, user) => {
  writes.push({ system, user });
  if (answer instanceof Error) throw answer;
  return { text: JSON.stringify(answer), model: "claude-check", inputTokens: 1200, outputTokens: 80, refused: false };
});
setAiPause(async () => undefined);
type Call = { url: string; body: Row | null };
let calls: Call[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  calls.push({ url, body });
  if (!url.startsWith("https://graph.instagram.com/")) throw new Error(`unexpected fetch ${url}`);
  const ok = (b: object) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/me/messages")) return ok(body?.sender_action ? { recipient_id: "IGSID" } : { message_id: `mid.ai${calls.length}`, recipient_id: "IGSID" });
  throw new Error(`unexpected Graph call ${url}`);
}) as typeof fetch;
const sends = () => calls.filter((c) => c.body?.message);
const typing = () => calls.filter((c) => c.body?.sender_action === "typing_on");
let zernioMessages: Row[] = [];
setAiZernio({ conversationMessages: async () => zernioMessages } as never);

// ---- fixtures ----
const T0 = new Date("2026-11-27T15:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
db.accounts.push(
  { id: "ig", socialAccountId: "sa-ig", platform: "instagram", transport: "native", status: "active", accessTokenEnc: encryptSecret("IG-TOKEN"), username: "sample.handle", clientId: "c1" },
  { id: "fb", socialAccountId: "sa-fb", platform: "facebook", transport: "zernio", status: "active", accessTokenEnc: null, username: "samplepage", providerAccountId: "z-fb", clientId: "c1" },
);
function chat(text: string, patch: Row = {}, account = "ig"): Row {
  const c = { id: id("c"), externalId: id("IGSID-"), displayName: "Alex", handle: "alex.sample", stage: "new", tags: [] as string[] };
  db.contacts.push(c);
  const inboundAt = at(-120);
  const t = {
    id: id("t"),
    dmAccountId: account,
    contactId: c.id,
    source: account === "ig" ? "native" : "zernio",
    externalId: account === "ig" ? null : "conv-1",
    status: "open",
    pausedAt: null,
    aiOff: false,
    aiHandoffAt: null,
    aiHandoffReason: null,
    aiPausedUntil: null,
    lastDirection: "in",
    lastInboundAt: inboundAt,
    windowEndsAt: new Date(inboundAt.getTime() + 24 * 3600_000),
    ...patch,
  };
  db.threads.push(t);
  if (account === "ig") db.messages.push({ id: id("m"), threadId: t.id, externalId: id("mid.in"), direction: "in", text, status: "sent", sentAt: inboundAt, unsentAt: null, attachments: null });
  return t;
}
const settings = (patch: Row) => {
  db.settings = db.settings.filter((s) => s.dmAccountId !== (patch.dmAccountId ?? "ig"));
  db.settings.push({ dmAccountId: "ig", ...patch });
};
const reset = () => {
  for (const k of ["threads", "contacts", "messages", "drafts", "runs", "settings"] as const) db[k] = [];
  db.kill = null;
  calls = [];
  writes = [];
  answer = { action: "reply", bubbles: ["Hi! We are open 7 AM to 8 PM."], stage: "engaged", note: "Asked about hours", reason: "hours" };
};

// 1. OFF by default: no settings row, nothing is written or called.
reset();
chat("Are you open on Sundays?");
await aiTick(T0);
assert.equal(db.drafts.length, 0, "no draft without a person turning it on");
assert.equal(writes.length + calls.length, 0, "no model or Instagram call");
// A row that is there but off: the same.
settings({ enabled: false, mode: "autopilot" });
await aiTick(T0);
assert.equal(db.drafts.length, 0);

// 2. Drafts only: written, left for a person, never sent.
reset();
settings({ enabled: true });
const t2 = chat("Are you open on Sundays?");
await aiTick(T0);
assert.equal(db.drafts.length, 1);
assert.equal(db.drafts[0]!.status, "draft");
assert.deepEqual(db.drafts[0]!.bubbles, ["Hi! We are open 7 AM to 8 PM."]);
assert.ok(db.drafts[0]!.costCents > 0, "the spend is metered");
assert.match(writes[0]!.system, /assistant for Sample Client/);
assert.match(writes[0]!.user, /THEM: Are you open on Sundays\?/);
await aiTick(at(3600));
assert.equal(sends().length, 0, "drafts only never sends");
// Idempotent: the same message is never written for twice.
await draftQuietThreads(at(10));
assert.equal(db.drafts.filter((d) => d.threadId === t2.id).length, 1);
assert.equal(writes.length, 1);

// 3. Autopilot: queued behind the delay, sent with typing, the chat updated.
reset();
settings({ enabled: true, mode: "autopilot", replyDelayMinSec: 30, replyDelayMaxSec: 30 });
const t3 = chat("What time do you open?");
await aiTick(T0);
assert.equal(db.drafts[0]!.status, "queued");
assert.equal(+db.drafts[0]!.sendAt, +at(30));
await sendDueDrafts(at(10));
assert.equal(sends().length, 0, "not before the delay");
await sendDueDrafts(at(31));
assert.equal(sends().length, 1);
assert.equal(typing().length, 1, "the typing dots first");
assert.equal(db.drafts[0]!.status, "sent");
assert.equal(db.drafts[0]!.sentHow, "auto");
assert.equal(t3.lastDirection, "out");
assert.ok(notified.some((e) => e.threadId === t3.id && e.kind === "out"), "an AI send tells the open Inboxes");
assert.equal(db.contacts.find((c) => c.id === t3.contactId)!.stage, "engaged", "the stage it chose");
assert.ok(db.messages.some((m) => m.threadId === t3.id && m.direction === "out" && m.text === "Hi! We are open 7 AM to 8 PM."));
await sendDueDrafts(at(120));
assert.equal(sends().length, 1, "sent once");

// 4. Gates at send time.
const queued = (patch: Row = {}, text = "What time do you open?") => {
  const t = chat(text, patch);
  return t;
};
// the kill switch: kept as a draft for a person
reset();
settings({ enabled: true, mode: "autopilot", replyDelayMinSec: 0, replyDelayMaxSec: 0 });
queued();
await draftQuietThreads(T0);
db.kill = { value: { at: T0.toISOString(), by: "u1" } };
await sendDueDrafts(at(1));
assert.equal(sends().length, 0, "the kill switch stops it");
assert.equal(db.drafts[0]!.status, "draft");
// the window closed while it waited
reset();
settings({ enabled: true, mode: "autopilot", replyDelayMinSec: 0, replyDelayMaxSec: 0 });
const tw = queued();
await draftQuietThreads(T0);
tw.windowEndsAt = at(60);
await sendDueDrafts(at(1));
assert.equal(sends().length, 0, "never when the window is closing");
assert.equal(db.drafts[0]!.status, "skipped");
// the team replied in the meantime
reset();
settings({ enabled: true, mode: "autopilot", replyDelayMinSec: 0, replyDelayMaxSec: 0 });
const tt = queued();
await draftQuietThreads(T0);
tt.lastDirection = "out";
await sendDueDrafts(at(1));
assert.equal(sends().length, 0);
assert.equal(db.drafts[0]!.status, "skipped");
// they wrote again: stale, discarded
reset();
settings({ enabled: true, mode: "autopilot", replyDelayMinSec: 0, replyDelayMaxSec: 0 });
const tn = queued();
await draftQuietThreads(T0);
db.messages.push({ id: id("m"), threadId: tn.id, externalId: "mid.newer", direction: "in", text: "also, parking?", status: "sent", sentAt: at(0), unsentAt: null, attachments: null });
await sendDueDrafts(at(1));
assert.equal(sends().length, 0);
assert.equal(db.drafts[0]!.status, "discarded");
// paused while it waited
reset();
settings({ enabled: true, mode: "autopilot", replyDelayMinSec: 0, replyDelayMaxSec: 0 });
const tp = queued();
await draftQuietThreads(T0);
tp.pausedAt = T0;
await sendDueDrafts(at(1));
assert.equal(sends().length, 0);
// the daily cap: kept as a draft
reset();
settings({ enabled: true, mode: "autopilot", replyDelayMinSec: 0, replyDelayMaxSec: 0, dailyCap: 1 });
db.drafts.push({ id: "old", dmAccountId: "ig", threadId: "x", forExternalId: "x", status: "sent", sentHow: "auto", sentAt: at(-60) });
queued();
await draftQuietThreads(T0);
await sendDueDrafts(at(1));
assert.equal(sends().length, 0);
assert.equal(db.drafts.find((d) => d.id !== "old")!.status, "draft");

// 5. Never written for at all.
reset();
settings({ enabled: true, mode: "autopilot" });
chat("hi", { pausedAt: T0 });
chat("hi", { aiOff: true });
chat("hi", { aiHandoffAt: T0 });
chat("hi", { aiPausedUntil: at(3600) });
chat("hi", { lastDirection: "out" });
chat("hi", { windowEndsAt: at(-1) });
chat("hi", { lastInboundAt: at(-10), windowEndsAt: at(3600) });
const friend = chat("hi");
db.contacts.find((c) => c.id === friend.contactId)!.tags = ["Friend"];
const auto = chat("GUIDE");
db.runs.push({ dmAccountId: "ig", eventKey: `message:${db.messages.find((m) => m.threadId === auto.id)!.externalId}`, status: "sent" });
await aiTick(T0);
assert.equal(db.drafts.length, 0, "paused, off, handed off, team pause, they spoke last, window, still typing, friend, automation answered");
assert.equal(writes.length, 0);

// 6. Handoff rules before the model, and the model's own handoff and stop.
reset();
settings({ enabled: true, mode: "autopilot" });
const th = chat("How much is a class for a group of 6?");
await aiTick(T0);
assert.equal(writes.length, 0, "a rule match never reaches the model");
assert.equal(db.drafts[0]!.status, "handoff");
assert.equal(th.aiHandoffReason, "Asked about price");
assert.ok(th.aiHandoffAt);
answer = { action: "handoff", bubbles: [], stage: "engaged", note: "", reason: "Not sure about mats" };
const tm = chat("Can I bring my own mat?");
await aiTick(T0);
assert.equal(db.drafts.find((d) => d.threadId === tm.id)!.status, "handoff");
assert.equal(tm.aiHandoffReason, "Not sure about mats");
answer = { action: "stop", bubbles: [], stage: "won", note: "", reason: "they said thanks" };
const ts = chat("thanks!");
await aiTick(T0);
assert.equal(db.drafts.find((d) => d.threadId === ts.id)!.status, "skipped");
assert.equal(sends().length, 0);
// a model failure is a failed row, never a send
answer = new Error("overloaded");
const tf = chat("Where are you?");
await aiTick(T0);
assert.equal(db.drafts.find((d) => d.threadId === tf.id)!.status, "failed");

// 7. Messenger: never unprompted, a draft on request inside the window only.
reset();
settings({ enabled: true, mode: "autopilot", dmAccountId: "fb" });
const tfb = chat("Hi! Are you open on Sundays?", {}, "fb");
await aiTick(T0);
assert.equal(db.drafts.length, 0, "Messenger is never written for on its own");
zernioMessages = [{ id: "zm1", message: "Hi! Are you open on Sundays?", direction: "incoming", createdAt: at(-300).toISOString(), attachments: [] }];
const r = await draftThread(tfb.id, "request", T0, "u1");
assert.equal(r?.status, "draft", "a person asked: a draft, never queued");
await sendDueDrafts(at(3600));
assert.equal(sends().length, 0);
zernioMessages = [{ id: "zm2", message: "old", direction: "incoming", createdAt: at(-25 * 3600).toISOString(), attachments: [] }];
const closed = await draftThread(tfb.id, "request", at(5), "u1");
assert.equal(closed?.status, "failed");
assert.match(closed!.reason ?? "", /window closed/);
// and a request on an account with AI replies off writes nothing
db.settings = [];
assert.equal(await draftThread(tfb.id, "request", at(9), "u1"), null);

console.log("aiReplies.check: ok");
