// Native Instagram DMs, the worker half, on an in-memory Prisma: the same
// delivery twice is one message, our own send and its echo are one row,
// reactions, edits and unsends land on the message, the missed-DM sync only
// adds what is missing, and token refresh re-encrypts or marks revoked.
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

const { decryptSecret, encryptSecret, getPrisma, Prisma } = await import("@toreroflow/db");
const { processWebhookEvent, refreshTokens, syncAccount } = await import("./dm");

type Row = Record<string, any>;
const db = { accounts: [] as Row[], contacts: [] as Row[], threads: [] as Row[], messages: [] as Row[], events: [] as Row[], alerts: [] as Row[] };
let n = 0;
const id = (p: string) => `${p}${++n}`;
const dup = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "check" });
const apply = (row: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
    else if (v === Prisma.JsonNull) row[k] = null;
    else if (v !== undefined) row[k] = v;
  }
  return row;
};
const prisma = getPrisma() as unknown as Record<string, unknown>;
const fake = (name: string, value: object) => Object.defineProperty(prisma, name, { value, configurable: true });
fake("dmAccount", {
  findFirst: async ({ where }: Row) => db.accounts.find((a) => a.externalId === where.externalId && a.transport === where.transport) ?? null,
  findMany: async ({ where }: Row) => db.accounts.filter((a) => a.status === where.status && a.transport === where.transport),
  update: async ({ where, data }: Row) => apply(db.accounts.find((a) => a.id === where.id)!, data),
});
fake("dmContact", {
  findUnique: async ({ where }: Row) => {
    const k = where.dmAccountId_externalId;
    return db.contacts.find((c) => c.dmAccountId === k.dmAccountId && c.externalId === k.externalId) ?? null;
  },
  findUniqueOrThrow: async (args: Row) => (await (prisma.dmContact as Row).findUnique(args))!,
  create: async ({ data }: Row) => {
    if (db.contacts.some((c) => c.dmAccountId === data.dmAccountId && c.externalId === data.externalId)) throw dup();
    const row = { id: id("ct"), lastSeenAt: null, ...data };
    db.contacts.push(row);
    return row;
  },
  update: async ({ where, data }: Row) => apply(db.contacts.find((c) => c.id === where.id)!, data),
});
fake("dmThread", {
  upsert: async ({ where, create, update }: Row) => {
    const k = where.dmAccountId_contactId;
    const have = db.threads.find((t) => t.dmAccountId === k.dmAccountId && t.contactId === k.contactId);
    if (have) return apply(have, update);
    const row = { id: id("th"), status: "open", unread: 0, lastMessageAt: null, lastInboundAt: null, readAt: null, ...create };
    db.threads.push(row);
    return row;
  },
  update: async ({ where, data }: Row) => apply(db.threads.find((t) => t.id === where.id)!, data),
});
fake("dmMessage", {
  findUnique: async ({ where }: Row) => {
    const k = where.threadId_externalId;
    return db.messages.find((m) => m.threadId === k.threadId && m.externalId === k.externalId) ?? null;
  },
  create: async ({ data }: Row) => {
    if (db.messages.some((m) => m.threadId === data.threadId && m.externalId === data.externalId)) throw dup();
    const row = { id: id("m"), reactions: null, ...data, attachments: data.attachments === Prisma.JsonNull ? null : data.attachments };
    db.messages.push(row);
    return row;
  },
  findFirst: async ({ where }: Row) =>
    where.threadId
      ? (db.messages.find((m) => m.threadId === where.threadId && m.direction === where.direction) ?? null)
      : (db.messages.find((m) => m.externalId === where.externalId && db.threads.find((t) => t.id === m.threadId)?.dmAccountId === where.thread.dmAccountId) ?? null),
  update: async ({ where, data }: Row) => apply(db.messages.find((m) => m.id === where.id)!, data),
});
fake("dmWebhookEvent", {
  findUnique: async ({ where }: Row) => db.events.find((e) => e.id === where.id) ?? null,
  update: async ({ where, data }: Row) => apply(db.events.find((e) => e.id === where.id)!, data),
});
fake("client", { findUnique: async () => ({ agencyId: "A" }) });
// No automations here (automations.check.ts covers them): every message passes through untouched.
fake("dmAutomation", { findMany: async () => [], findFirst: async () => null });
fake("systemAlert", { upsert: async ({ create }: Row) => (db.alerts.push(create), create) });

let conversations: Row = { data: [] };
let refreshAnswer: Row = { access_token: "IG-REFRESHED", expires_in: 5184000 };
const urls: string[] = [];
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  urls.push(url);
  const ok = (b: object, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (url.includes("/999?fields=name,username,profile_pic")) return ok({ username: "jordan.sample", name: "Jordan", profile_pic: "https://scontent.cdninstagram.com/p.jpg" });
  if (url.includes("/me/conversations")) return ok(conversations);
  if (url.includes("refresh_access_token")) return ok(refreshAnswer, refreshAnswer.error ? 400 : 200);
  return ok({ error: { message: "not stubbed" } }, 500);
}) as typeof fetch;

const ME = "17841400000000001";
db.accounts.push({ id: "acc1", clientId: "c1", platform: "instagram", transport: "native", status: "active", externalId: ME, username: "sample.studio", accessTokenEnc: encryptSecret("IG-TOKEN"), lastSyncAt: null });

const deliver = async (messaging: Row[], account = ME) => {
  const e = { id: id("ev"), signatureOk: true, processedAt: null, payload: { object: "instagram", entry: [{ id: account, time: 1, messaging }] } };
  db.events.push(e);
  await processWebhookEvent(e.id);
  return e;
};
const T0 = Date.parse("2026-11-27T10:00:00Z");
const inbound = (mid: string, message: Row, at = T0) => ({ sender: { id: "999" }, recipient: { id: ME }, timestamp: at, message: { mid, ...message } });

// 1. An inbound message: contact (with profile), thread, row, window.
let ev = await deliver([inbound("mid.1", { text: "Do you still have the guide?" })]);
assert.ok(ev.processedAt, "processed");
assert.equal(db.messages.length, 1);
assert.equal(db.contacts[0]!.handle, "jordan.sample", "profile read once on first sight");
const t = db.threads[0]!;
assert.equal(t.unread, 1);
assert.equal(t.lastDirection, "in");
assert.equal(t.lastInboundAt.getTime(), T0);
assert.equal(t.windowEndsAt.getTime(), T0 + 24 * 3600_000, "the 24h window starts at their message");

// 2. The same delivery again (Meta retries): still one message, still one unread.
await deliver([inbound("mid.1", { text: "Do you still have the guide?" })]);
assert.equal(db.messages.length, 1, "idempotent on the platform message id");
assert.equal(t.unread, 1);

// 3. Our reply, recorded by the API at send time, then its echo: one row.
db.messages.push({ id: "sent1", threadId: t.id, externalId: "mid.out1", direction: "out", text: "Here it is", sentByUserId: "u1", reactions: null });
await deliver([{ sender: { id: ME }, recipient: { id: "999" }, timestamp: T0 + 60_000, message: { mid: "mid.out1", text: "Here it is", is_echo: true } }]);
assert.equal(db.messages.filter((m) => m.externalId === "mid.out1").length, 1, "send and echo are one row");
// An echo typed in the Instagram app is ours too, and does not count as unread.
await deliver([{ sender: { id: ME }, recipient: { id: "999" }, timestamp: T0 + 120_000, message: { mid: "mid.out2", text: "From my phone", is_echo: true } }]);
const phone = db.messages.find((m) => m.externalId === "mid.out2")!;
assert.equal(phone.direction, "out");
assert.equal(phone.sentByUserId, undefined);
assert.equal(t.unread, 1, "echoes are not unread");
assert.equal(t.lastPreview, "From my phone");

// 4. Reactions, edits, unsends.
await deliver([{ sender: { id: "999" }, recipient: { id: ME }, timestamp: T0, reaction: { mid: "mid.out1", action: "react", emoji: "❤" } }]);
assert.deepEqual(db.messages.find((m) => m.externalId === "mid.out1")!.reactions, { contact: "❤️" }, "a bare heart gets the emoji selector");
await deliver([{ sender: { id: "999" }, recipient: { id: ME }, timestamp: T0, reaction: { mid: "mid.out1", action: "unreact" } }]);
assert.equal(db.messages.find((m) => m.externalId === "mid.out1")!.reactions, null);
await deliver([{ sender: { id: "999" }, recipient: { id: ME }, timestamp: T0, message_edit: { mid: "mid.1", text: "Do you have the guide?" } }]);
const first = db.messages.find((m) => m.externalId === "mid.1")!;
assert.equal(first.text, "Do you have the guide?");
assert.ok(first.editedAt);
await deliver([inbound("mid.1", { is_deleted: true })]);
assert.equal(first.text, null, "an unsent message keeps nothing it said");
assert.ok(first.unsentAt);

// 5. Rich parts: story reply, the share/ig_post double, a voice note.
await deliver([
  inbound("mid.story", { text: "love this", reply_to: { story: { url: "https://scontent.cdninstagram.com/s.mp4", id: "st1" } } }, T0 + 3 * 60_000),
  inbound("mid.post", { attachments: [{ type: "share", payload: { ig_post_media_id: "1789", url: "https://x.fbcdn.net/a" } }, { type: "ig_post", payload: { ig_post_media_id: "1789", url: "https://x.fbcdn.net/a", title: "Post" } }] }, T0 + 4 * 60_000),
  inbound("mid.voice", { attachments: [{ type: "audio", payload: { url: "https://cdn.fbsbx.com/v.mp4" } }] }, T0 + 5 * 60_000),
]);
assert.deepEqual(db.messages.find((m) => m.externalId === "mid.story")!.attachments.map((p: Row) => p.type), ["story_reply"]);
assert.deepEqual(db.messages.find((m) => m.externalId === "mid.post")!.attachments.map((p: Row) => p.type), ["post"], "one post, not two");
assert.deepEqual(db.messages.find((m) => m.externalId === "mid.voice")!.attachments.map((p: Row) => p.type), ["audio"]);
assert.equal(t.lastPreview, "Voice note");
assert.equal(t.unread, 4);

// 6. An account that is not connected here: ignored, not an error.
const before = db.messages.length;
await deliver([{ sender: { id: "555" }, recipient: { id: "178999" }, timestamp: T0, message: { mid: "mid.x", text: "hi" } }], "178999");
assert.equal(db.messages.length, before);

// 7. The missed-DM sync adds only what is missing, skips group chats, sets the watermark.
conversations = {
  data: [
    {
      id: "conv-a",
      updated_time: new Date(T0 + 10 * 60_000).toISOString(),
      participants: { data: [{ id: ME }, { id: "999" }] },
      messages: { data: [
        { id: "mid.voice", created_time: new Date(T0 + 5 * 60_000).toISOString(), from: { id: "999" }, attachments: { data: [{ mime_type: "audio/mp4", video_data: { url: "https://cdn.fbsbx.com/v.mp4" } }] } },
        { id: "mid.missed", created_time: new Date(T0 + 10 * 60_000).toISOString(), from: { id: "999" }, message: "Hello? Still there?" },
      ] },
    },
    { id: "conv-group", updated_time: new Date(T0 + 9 * 60_000).toISOString(), participants: { data: [{ id: ME }, { id: "1" }, { id: "2" }] }, messages: { data: [{ id: "mid.g", created_time: new Date(T0).toISOString(), from: { id: "1" }, message: "group" }] } },
  ],
};
const added = await syncAccount(db.accounts[0] as never, new Date(T0 + 11 * 60_000));
assert.equal(added, 1, "only the missed message");
assert.ok(db.messages.some((m) => m.externalId === "mid.missed"));
assert.ok(!db.messages.some((m) => m.externalId === "mid.g"), "group chats are left alone");
assert.equal(t.externalId, "conv-a", "the conversation id is learned");
assert.equal(db.accounts[0]!.lastSyncAt.getTime(), T0 + 10 * 60_000);
assert.ok(urls.filter((u) => u.includes("/me/conversations")).every((u) => !u.includes("IG-TOKEN")), "the token is never in a URL");

// 8. Token refresh: re-encrypted on success, revoked and raised on code 190.
db.accounts[0]!.tokenExpiresAt = new Date(Date.now() + 10 * 86400_000);
await refreshTokens();
assert.equal(decryptSecret(db.accounts[0]!.accessTokenEnc), "IG-REFRESHED");
assert.ok(db.accounts[0]!.tokenExpiresAt.getTime() > Date.now() + 59 * 86400_000);
refreshAnswer = { error: { message: "Error validating access token", code: 190 } };
db.accounts[0]!.tokenRefreshedAt = new Date(Date.now() - 2 * 86400_000);
await refreshTokens();
assert.equal(db.accounts[0]!.status, "revoked");
assert.equal(db.alerts[0]!.kind, "dm_token");
assert.match(db.alerts[0]!.message, /Reconnect/);

console.log("dm.check (worker): all checks passed");
