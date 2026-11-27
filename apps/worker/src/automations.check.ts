// DM automations (F4), the worker half, on an in-memory Prisma with the
// Instagram Graph API faked: a signed comment webhook through
// processWebhookEvent, dark launch (no send without a live native account and
// a live automation), idempotency, once per contact, the 7 day and 24h rules,
// the kill switch, a paused thread, the hourly budget and the drain, retries,
// dry run, the follower gate, test codes and DM keyword / welcome triggers.
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.PUBLIC_API_URL = "https://api.example.test";

const { encryptSecret, getPrisma, Prisma } = await import("@toreroflow/db");
const { templateConfig } = await import("@toreroflow/core");
const { env } = await import("./env");
const { drainAutomations, handleComment, handleMessage } = await import("./automations");
const { processWebhookEvent } = await import("./dm");

type Row = Record<string, any>;
const db = { accounts: [] as Row[], automations: [] as Row[], runs: [] as Row[], threads: [] as Row[], contacts: [] as Row[], events: [] as Row[] };
let n = 0;
const id = (p: string) => `${p}${++n}`;
const dup = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "check" });

/** Enough of Prisma's where for these queries: equality, null, in, not, gt/gte/lt/lte. */
function match(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const v = row[k];
    if (cond === null || cond === Prisma.DbNull) {
      if (v != null) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(v instanceof Date) || v.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (typeof cond !== "object") {
      if (v !== cond) return false;
      continue;
    }
    if ("in" in cond && !cond.in.includes(v)) return false;
    if ("not" in cond) {
      const not = cond.not;
      if (not === null || not === Prisma.DbNull ? v == null : typeof not === "object" && !(not instanceof Date) ? match(row, { [k]: not }) : v === not) return false;
    }
    if ("gt" in cond && !(v != null && v > cond.gt)) return false;
    if ("gte" in cond && !(v != null && v >= cond.gte)) return false;
    if ("lt" in cond && !(v != null && v < cond.lt)) return false;
    if ("lte" in cond && !(v != null && v <= cond.lte)) return false;
  }
  return true;
}
const apply = (row: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (v === Prisma.JsonNull || v === Prisma.DbNull) row[k] = null;
    else if (v !== undefined) row[k] = v;
  }
  row.updatedAt = new Date();
  return row;
};

const prisma = getPrisma() as unknown as Record<string, unknown>;
const fake = (name: string, value: object) => Object.defineProperty(prisma, name, { value, configurable: true });
fake("dmAccount", {
  findFirst: async ({ where }: Row) => db.accounts.find((a) => match(a, where)) ?? null,
  update: async ({ where, data }: Row) => apply(db.accounts.find((a) => a.id === where.id)!, data),
});
fake("dmAutomation", {
  findMany: async ({ where }: Row) => db.automations.filter((a) => match(a, where)).sort((x, y) => x.createdAt - y.createdAt),
  findFirst: async ({ where }: Row) => db.automations.find((a) => match(a, where)) ?? null,
  update: async ({ where, data }: Row) => apply(db.automations.find((a) => a.id === where.id)!, data),
});
const withRels = (r: Row) => ({ ...r, dmAccount: db.accounts.find((a) => a.id === r.dmAccountId), automation: db.automations.find((a) => a.id === r.automationId) ?? null });
fake("dmAutomationRun", {
  create: async ({ data }: Row) => {
    if (db.runs.some((r) => r.dmAccountId === data.dmAccountId && r.eventKey === data.eventKey)) throw dup();
    const row = { id: id("run"), attempts: 0, clicks: 0, sentAt: null, test: false, createdAt: new Date(), updatedAt: new Date(), ...data };
    db.runs.push(row);
    return row;
  },
  update: async ({ where, data }: Row) => apply(db.runs.find((r) => r.id === where.id)!, data),
  updateMany: async ({ where, data }: Row) => {
    const hit = db.runs.filter((r) => match(r, where));
    hit.forEach((r) => apply(r, data));
    return { count: hit.length };
  },
  count: async ({ where }: Row) => db.runs.filter((r) => match(r, where)).length,
  findFirst: async ({ where }: Row) => db.runs.find((r) => match(r, where)) ?? null,
  findMany: async ({ where, take }: Row) =>
    db.runs.filter((r) => match(r, where)).sort((a, b) => a.eventAt - b.eventAt).slice(0, take ?? 1000).map(withRels),
  deleteMany: async ({ where }: Row) => {
    const before = db.runs.length;
    db.runs = db.runs.filter((r) => !match(r, where));
    return { count: before - db.runs.length };
  },
});
fake("dmThread", {
  findFirst: async ({ where }: Row) =>
    db.threads.find((t) => t.dmAccountId === where.dmAccountId && db.contacts.find((c) => c.id === t.contactId)?.externalId === where.contact.externalId) ?? null,
});
fake("dmContact", { findFirst: async ({ where }: Row) => db.contacts.find((c) => match(c, where)) ?? null });
fake("dmWebhookEvent", {
  findUnique: async ({ where }: Row) => db.events.find((e) => e.id === where.id) ?? null,
  update: async ({ where, data }: Row) => apply(db.events.find((e) => e.id === where.id)!, data),
});

// ---- Instagram, faked ----
type Call = { url: string; method: string; body: Row | null; auth: string };
let calls: Call[] = [];
let follows: boolean | null = true;
const failNext: Array<{ status: number; code: number; message: string }> = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  calls.push({ url, method, body, auth: new Headers(init?.headers).get("authorization") ?? "" });
  const ok = (b: object, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (!url.startsWith("https://graph.instagram.com/")) throw new Error(`unexpected fetch ${url}`);
  if (url.endsWith("/me/messages") && method === "POST") {
    const f = failNext.shift();
    if (f) return ok({ error: { message: f.message, code: f.code } }, f.status);
    return ok({ message_id: `mid.auto${calls.length}`, recipient_id: "IGSID-1" });
  }
  if (url.includes("/replies?")) return ok({ id: `reply${calls.length}` });
  if (url.includes("fields=is_user_follow_business")) return ok(follows === null ? {} : { is_user_follow_business: follows });
  if (url.includes("/me/media?")) return ok({ data: [{ id: "17900000000000077", timestamp: new Date(Date.now() - 60_000).toISOString(), media_product_type: "REELS" }] });
  throw new Error(`unexpected Graph call ${method} ${url}`);
}) as typeof fetch;
const sends = () => calls.filter((c) => c.url.endsWith("/me/messages"));
const publicReplies = () => calls.filter((c) => c.url.includes("/replies?"));

// ---- fixtures ----
const now = () => new Date();
const ACCOUNT = { id: "dm1", socialAccountId: "sa1", platform: "instagram", externalId: "1784100000000001", transport: "native", status: "active", accessTokenEnc: encryptSecret("IG-TOKEN"), automationsPausedAt: null };
db.accounts.push({ ...ACCOUNT });
// The in-memory row stands in for Prisma's DmAccount.
const account = () => db.accounts[0] as never;

function automation(patch: Row = {}, cfgPatch: Row = {}): Row {
  const cfg = {
    ...templateConfig("comment_link"),
    keywords: ["GUIDE"],
    steps: [{ type: "message", text: "Hi {first_name}, here is the guide", button: { title: "Open the guide", url: "https://sample.example/guide" } }],
    ...cfgPatch,
  };
  const row = {
    id: id("au"),
    clientId: "c1",
    socialAccountId: "sa1",
    name: "Free guide",
    status: "live",
    ...cfg,
    published: cfg,
    publishedAt: new Date(Date.now() - 3600_000),
    deletedAt: null,
    testCode: null,
    testCodeExpiresAt: null,
    runCount: 0,
    sentCount: 0,
    failedCount: 0,
    clickCount: 0,
    createdAt: new Date(Date.now() - 1000 * (100 - n)),
    ...patch,
  };
  db.automations.push(row);
  return row;
}
const comment = (commentId: string, text: string, o: Row = {}) => ({
  accountId: ACCOUNT.externalId,
  commentId,
  contactId: "IGSID-1",
  username: "jordan.sample",
  mediaId: "17900000000000001",
  text,
  at: now(),
  ...o,
});
const runOf = (key: string) => db.runs.find((r) => r.eventKey === key)!;
const reset = () => {
  calls = [];
  db.runs = [];
  db.automations = [];
  db.threads = [];
  db.contacts = [];
  db.accounts = [{ ...ACCOUNT }];
  follows = true;
  env.DM_AUTOMATIONS_DRY_RUN = false;
};

// ---------------------------------------------------------------------------
// 1. A signed comment webhook, stored by the API, through the worker
// ---------------------------------------------------------------------------
const a1 = automation();
db.contacts.push({ id: "ct1", dmAccountId: "dm1", externalId: "IGSID-1", displayName: "Jordan Sample", handle: "jordan.sample" });
db.events.push({
  id: "ev1",
  signatureOk: true,
  processedAt: null,
  payload: {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT.externalId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          { field: "comments", value: { id: "c-100", text: "GUIDE please!", from: { id: "IGSID-1", username: "jordan.sample" }, media: { id: "17900000000000001" } } },
          // Our own public reply comes back as a comment: never a trigger.
          { field: "comments", value: { id: "c-101", text: "Sent! Check your DMs", from: { id: ACCOUNT.externalId, username: "sample.handle" }, media: { id: "17900000000000001" } } },
          { field: "live_comments", value: { id: "c-102", text: "love this", from: { id: "IGSID-2", username: "jamie.sample" }, media: { id: "17900000000000001" } } },
        ],
      },
    ],
  },
});
await processWebhookEvent("ev1");
const r100 = runOf("comment:c-100");
assert.equal(r100.status, "sent", "the keyword comment got its DM");
assert.equal(sends().length, 1, "one private reply");
const sent = sends()[0]!;
assert.deepEqual(sent.body!.recipient, { comment_id: "c-100" }, "a private reply goes to the comment");
assert.equal(sent.auth, "Bearer IG-TOKEN", "the token goes in the header");
assert.ok(!sent.url.includes("access_token"), "never in the URL");
assert.equal(sent.body!.messaging_type, undefined, "no HUMAN_AGENT or other tag on an automation");
const tpl = sent.body!.message.attachment.payload;
assert.equal(tpl.template_type, "button");
assert.equal(tpl.text, "Hi Jordan, here is the guide", "{first_name} filled from the contact");
assert.equal(tpl.buttons[0].url, `https://api.example.test/dm/l/${r100.id}`, "a tracked link goes through our redirect");
assert.equal(r100.linkUrl, "https://sample.example/guide", "the real link is kept for the redirect");
assert.equal(publicReplies().length, 1, "the public reply went under the comment");
assert.ok(["Sent! Check your DMs", "Just sent it to your inbox", "Done, look in your DMs"].includes(new URL(publicReplies()[0]!.url).searchParams.get("message")!), "one of the variants");
assert.ok(publicReplies()[0]!.url.includes("/c-100/replies?"), "under that comment");
assert.equal(db.runs.some((r) => r.eventKey === "comment:c-101"), false, "the account's own comment is skipped");
assert.equal(runOf("comment:c-102").status, "ignored", "a comment with no keyword is logged as ignored");
assert.equal(db.events[0]!.processedAt instanceof Date, true);
assert.equal(a1.runCount, 1);
assert.equal(a1.sentCount, 1);

// Idempotent: the same delivery again sends nothing.
db.events[0]!.processedAt = null;
await processWebhookEvent("ev1");
assert.equal(sends().length, 1, "a redelivered webhook never sends twice");
assert.equal(db.runs.filter((r) => r.eventKey === "comment:c-100").length, 1);

// Once per contact: the same person, a new comment.
assert.equal(await handleComment(account(), comment("c-103", "guide again")), "repeat");
assert.equal(sends().length, 1, "once per person");
assert.equal(runOf("comment:c-103").reason, "Already sent to this person");

// ---------------------------------------------------------------------------
// 2. Dark launch: nothing sends without a live native account and a live automation
// ---------------------------------------------------------------------------
reset();
automation({ status: "draft", published: null });
assert.equal(await handleComment(account(), comment("c-200", "GUIDE")), "ignored", "a draft never answers");
automation({ status: "paused" });
assert.equal(await handleComment(account(), comment("c-201", "GUIDE")), "ignored", "nor does a paused one");
automation({ deletedAt: new Date() });
assert.equal(await handleComment(account(), comment("c-202", "GUIDE")), "ignored", "nor one in the trash");
assert.equal(sends().length, 0);

reset();
automation();
db.accounts[0]!.accessTokenEnc = null;
assert.equal(await handleComment(account(), comment("c-210", "GUIDE")), "skipped", "no token: no send");
assert.match(runOf("comment:c-210").reason, /not connected/);
db.accounts[0]!.accessTokenEnc = ACCOUNT.accessTokenEnc;
db.accounts[0]!.status = "revoked";
assert.equal(await handleComment(account(), comment("c-211", "GUIDE")), "skipped", "a revoked account sends nothing");
db.accounts[0]!.status = "active";
db.accounts[0]!.transport = "zernio";
assert.equal(await handleComment(account(), comment("c-212", "GUIDE")), "skipped", "a Zernio account is not ours to send from");
assert.equal(sends().length, 0, "dark launch: zero sends");

// ---------------------------------------------------------------------------
// 3. Windows, kill switch, paused thread, follower gate, dry run
// ---------------------------------------------------------------------------
reset();
automation();
const old = new Date(Date.now() - 8 * 24 * 3600_000);
assert.equal(await handleComment(account(), comment("c-300", "GUIDE", { at: old })), "expired", "a private reply is 7 days at most");
assert.equal(await handleComment(account(), comment("c-301", "GUIDE", { contactId: "IGSID-3", at: new Date(Date.now() - 6 * 24 * 3600_000) })), "sent", "6 days is fine");

db.accounts[0]!.automationsPausedAt = new Date();
assert.equal(await handleComment(account(), comment("c-302", "GUIDE", { contactId: "IGSID-4" })), "skipped", "the kill switch stops everything");
assert.match(runOf("comment:c-302").reason, /paused for this account/);
db.accounts[0]!.automationsPausedAt = null;

db.contacts.push({ id: "ct5", dmAccountId: "dm1", externalId: "IGSID-5", displayName: "Riley", handle: "riley" });
db.threads.push({ id: "th5", dmAccountId: "dm1", contactId: "ct5", pausedAt: new Date() });
assert.equal(await handleComment(account(), comment("c-303", "GUIDE", { contactId: "IGSID-5" })), "skipped", "a paused conversation is left alone");

reset();
automation({}, { followersOnly: true });
follows = false;
assert.equal(await handleComment(account(), comment("c-310", "GUIDE")), "gated", "not a follower: asked to follow");
assert.match(String(sends()[0]!.body!.message.text), /Follow us first/);
assert.equal(publicReplies().length, 0, "no public reply on a gated run");
follows = true;
assert.equal(await handleComment(account(), comment("c-311", "GUIDE")), "sent", "a gated run does not use up once per person");

reset();
env.DM_AUTOMATIONS_DRY_RUN = true;
automation();
assert.equal(await handleComment(account(), comment("c-320", "GUIDE")), "dry_run");
assert.equal(sends().length + publicReplies().length, 0, "dry run: matched and recorded, nothing sent");
assert.match(runOf("comment:c-320").reason, /would send "Hi Jordan|would send "Hi jordan|would send "Hi there|would send/);

// ---------------------------------------------------------------------------
// 4. Budget, drain, retries
// ---------------------------------------------------------------------------
reset();
const a4 = automation();
for (let i = 0; i < 700; i++) db.runs.push({ id: `old${i}`, dmAccountId: "dm1", eventKey: `x${i}`, status: "sent", sentAt: new Date(Date.now() - 10 * 60_000), eventAt: new Date(), test: false, contactExternalId: `p${i}` });
assert.equal(await handleComment(account(), comment("c-400", "GUIDE", { contactId: "IGSID-40" })), "queued", "over the hourly budget: queued");
assert.equal(sends().length, 0);
assert.equal(await drainAutomations(), 0, "not due yet");
db.runs = db.runs.filter((r) => !r.id.startsWith("old"));
runOf("comment:c-400").retryAt = new Date(Date.now() - 1000);
assert.equal(await drainAutomations(), 1);
assert.equal(runOf("comment:c-400").status, "sent", "sent once there is room");

failNext.push({ status: 429, code: 4, message: "Application request limit reached" });
assert.equal(await handleComment(account(), comment("c-401", "GUIDE", { contactId: "IGSID-41" })), "queued", "a rate limit is retried");
assert.ok(runOf("comment:c-401").retryAt > new Date(), "with a backoff");
// Refused as a template, then as text too (the fallback): fails for good.
failNext.push({ status: 400, code: 10, message: "This person cannot receive messages from this account" });
failNext.push({ status: 400, code: 10, message: "This person cannot receive messages from this account" });
assert.equal(await handleComment(account(), comment("c-402", "GUIDE", { contactId: "IGSID-42" })), "failed", "a refusal fails for good");
assert.equal(a4.failedCount, 1);
a4.status = "paused";
runOf("comment:c-401").retryAt = new Date(Date.now() - 1000);
await drainAutomations();
assert.equal(runOf("comment:c-401").status, "skipped", "a queued run of an automation turned off is dropped");

// ---------------------------------------------------------------------------
// 5. DMs: keyword, welcome, story reply, the 24h rule, test codes
// ---------------------------------------------------------------------------
reset();
const book = automation({ name: "Booking" }, { trigger: "dm_keyword", keywords: ["BOOK"], publicReplyOn: false, steps: [{ type: "message", text: "Book here", button: null }] });
const welcome = automation({ name: "Welcome" }, { trigger: "welcome", matchMode: "any", keywords: [], steps: [{ type: "message", text: "Hi {first_name}!", button: null }] });
const dmMsg = (mid: string, text: string | null, o: Row = {}) => ({ mid, contactId: "IGSID-9", username: "maya.sample", text, parts: [], firstMessage: false, at: now(), ...o });
assert.equal(await handleMessage(account(), dmMsg("m1", "can I book a call?", { firstMessage: true })), "sent", "a keyword beats the welcome");
assert.deepEqual(sends()[0]!.body!.recipient, { id: "IGSID-9" }, "a DM answer goes to the person");
assert.equal(sends()[0]!.body!.message.text, "Book here");
assert.equal(runOf("message:m1").automationId, book.id);
assert.equal(await handleMessage(account(), dmMsg("m2", "hello", { contactId: "IGSID-10", firstMessage: true })), "sent");
assert.equal(runOf("message:m2").automationId, welcome.id, "the welcome when nothing else matched");
assert.equal(await handleMessage(account(), dmMsg("m3", "hello again", { contactId: "IGSID-10" })), "none", "only on the first message");
assert.equal(await handleMessage(account(), dmMsg("m1", "can I book a call?", { firstMessage: true })), "duplicate", "the same message twice: once");

// A queued DM answer past 24h expires instead of sending late.
const late = await handleMessage(account(), dmMsg("m4", "book", { contactId: "IGSID-11", at: new Date(Date.now() - 25 * 3600_000) }));
assert.equal(late, "expired", "a DM older than the 24h window is never answered");

// Test code: the working copy for whoever sends it, every time, never counted.
book.testCode = "482";
book.testCodeExpiresAt = new Date(Date.now() + 60_000);
book.steps = [{ type: "message", text: "Unpublished draft text", button: null }];
const before = book.runCount;
assert.equal(await handleMessage(account(), dmMsg("m5", "482", { contactId: "IGSID-12" })), "sent");
assert.equal(sends().at(-1)!.body!.message.text, "Unpublished draft text", "a test sends the working copy");
assert.equal(runOf("message:m5").test, true);
assert.equal(book.runCount, before, "tests are not counted");
book.testCodeExpiresAt = new Date(Date.now() - 1);
assert.equal(await handleMessage(account(), dmMsg("m6", "482", { contactId: "IGSID-13" })), "none", "an expired code does nothing");

// Story replies and mentions.
reset();
automation({}, { trigger: "story_reply", matchMode: "any", keywords: [], steps: [{ type: "message", text: "Thanks!", button: null }] });
assert.equal(await handleMessage(account(), dmMsg("m7", "fire", { parts: [{ type: "story_reply" }] })), "sent");
assert.equal(await handleMessage(account(), dmMsg("m8", null, { contactId: "IGSID-20", parts: [{ type: "story_mention" }] })), "none", "no mention automation, no reply");

// Next post: locks onto the first post after it went live.
reset();
const nextA = automation({}, { scope: "next", postIds: [] });
assert.equal(await handleComment(account(), comment("c-500", "GUIDE", { mediaId: "17900000000000077" })), "sent", "locked onto the new reel");
assert.deepEqual(nextA.published.postIds, ["17900000000000077"]);
assert.equal(await handleComment(account(), comment("c-501", "GUIDE", { contactId: "IGSID-51", mediaId: "17900000000000001" })), "ignored", "other posts no longer match");

console.log("automations.check (worker): all checks passed");
