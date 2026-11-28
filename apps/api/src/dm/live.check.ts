// Inbox live updates (H1): the stream ticket, GET /clients/:id/dm/stream
// through a real listening server (auth, brand scope, viewers, heartbeat,
// delivery, no cross-brand leak, the per-user cap, closing when LISTEN drops),
// the request log redaction, and, when DATABASE_URL points at a Postgres, the
// real path: publishDmEvent's NOTIFY through the LISTEN connection to a stream.
import assert from "node:assert/strict";

process.env.JWT_SECRET = "live-check-secret";
const REAL_DB = process.env.LIVE_CHECK_DATABASE_URL ?? "";
// Before Prisma is built, so publishDmEvent's NOTIFY goes to that database.
if (REAL_DB) process.env.DATABASE_URL = REAL_DB;

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma, publishDmEvent, setDmNotify } = await import("@toreroflow/db");
const { env } = await import("../env");
const { redactUrl } = await import("../logRedact");
const live = await import("./live");
const { dmBus, dmLiveRoutes, liveTesting, openStreams, redeemTicket, signTicket } = live;

type Row = Record<string, any>;
const CLIENTS = [
  { id: "c1", agencyId: "A", providerProfileId: null },
  { id: "c2", agencyId: "B", providerProfileId: null },
  { id: "c3", agencyId: "A", providerProfileId: null },
];
const prisma = getPrisma() as unknown as Record<string, unknown>;
const fake = (name: string, value: object) => Object.defineProperty(prisma, name, { value, configurable: true });
fake("client", {
  findFirst: async ({ where }: Row) => CLIENTS.find((c) => c.id === where.id && c.agencyId === where.agencyId) ?? null,
});
fake("botIdentity", { findUnique: async () => null });

const app = Fastify();
await app.register(jwt, { secret: env.JWT_SECRET });
await app.register(dmLiveRoutes);
// A route behind the normal login check, to prove a ticket is not a login.
const { requireAuth } = await import("../plugins/requireAuth");
app.get("/whoami", { onRequest: requireAuth }, async (r) => ({ sub: r.user.sub }));
const base = await app.listen({ host: "127.0.0.1", port: 0 });

const owner = app.jwt.sign({ sub: "u1", agencyId: "A" });
const viewer = app.jwt.sign({ sub: "v1", agencyId: "A", role: "viewer" });
const stranger = app.jwt.sign({ sub: "s1", agencyId: "B" });
const H = (t: string) => ({ authorization: `Bearer ${t}` });

/** An open stream: everything it has said so far, and a wait for more. */
async function open(path: string, headers: Record<string, string> = {}) {
  const ctl = new AbortController();
  const res = await fetch(base + path, { headers, signal: ctl.signal });
  let text = "";
  let ended = false;
  const reader = res.body!.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    } catch {
      // aborted
    }
    ended = true;
  })();
  const until = async (ok: () => boolean, what: string, ms = 3000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; got: ${JSON.stringify(text)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return {
    res,
    text: () => text,
    ended: () => ended,
    until,
    close: async () => (ctl.abort(), await pump),
  };
}
const ticketFor = async (clientId: string, token: string) => {
  const r = await app.inject({ method: "POST", url: `/clients/${clientId}/dm/stream-ticket`, headers: H(token) });
  return { status: r.statusCode, ticket: (r.json() as { ticket?: string }).ticket ?? "" };
};
const drain = async () => {
  for (let i = 0; i < 100 && openStreams(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(openStreams(), 0, "every stream cleaned up after it closed");
};

// ---------------------------------------------------------------------------
// 1. Tickets
// ---------------------------------------------------------------------------
{
  const t = signTicket({ u: "u1", a: "A", c: "c1" });
  assert.equal(redeemTicket(t)?.c, "c1");
  assert.equal(redeemTicket(t), null, "one use");
  assert.equal(redeemTicket(signTicket({ u: "u1", a: "A", c: "c1" }, Date.now() - 61_000)), null, "60 seconds");
  const [body, sig] = signTicket({ u: "u1", a: "A", c: "c1" }).split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), c: "c3" })).toString("base64url");
  assert.equal(redeemTicket(`${forged}.${sig}`), null, "a ticket cannot be pointed at another brand");
  assert.equal(redeemTicket(owner), null, "a login token is not a ticket");
  const login = await app.inject({ method: "GET", url: "/whoami", headers: H(signTicket({ u: "u1", a: "A", c: "c1" })) });
  assert.equal(login.statusCode, 401, "a ticket is not a login token");

  assert.equal((await ticketFor("c1", owner)).status, 200);
  assert.equal((await ticketFor("c1", viewer)).status, 200, "viewers may stream: it is a read");
  assert.equal((await ticketFor("c1", stranger)).status, 403, "another agency's brand");
  const anon = await app.inject({ method: "POST", url: "/clients/c1/dm/stream-ticket" });
  assert.equal(anon.statusCode, 401);
}

// ---------------------------------------------------------------------------
// 2. The stream's door: 401, 403, 503
// ---------------------------------------------------------------------------
{
  const anon = await fetch(`${base}/clients/c1/dm/stream`);
  assert.equal(anon.status, 401, "no token, no stream (and no hang)");
  const bad = await fetch(`${base}/clients/c1/dm/stream?ticket=nonsense`);
  assert.equal(bad.status, 401);
  const other = await fetch(`${base}/clients/c2/dm/stream`, { headers: H(owner) });
  assert.equal(other.status, 403, "another agency's brand with a real login");
  const { ticket } = await ticketFor("c1", owner);
  const moved = await fetch(`${base}/clients/c3/dm/stream?ticket=${ticket}`);
  assert.equal(moved.status, 403, "a ticket streams only the brand it was cut for");
  // No database to LISTEN on: the Inbox is told to poll, not left believing it is live.
  const savedUrl = env.DATABASE_URL;
  env.DATABASE_URL = "";
  const down = await fetch(`${base}/clients/c1/dm/stream`, { headers: H(owner) });
  assert.equal(down.status, 503);
  assert.equal(((await down.json()) as { reason: string }).reason, "live_unavailable");
  env.DATABASE_URL = savedUrl;
}

// ---------------------------------------------------------------------------
// 3. A live stream (the in-process bus), ticket and bearer
// ---------------------------------------------------------------------------
liveTesting.busOnly = true;
liveTesting.heartbeatMs = 60;
{
  const { ticket } = await ticketFor("c1", viewer);
  const s = await open(`/clients/c1/dm/stream?ticket=${ticket}`, { origin: "https://app.example.test" });
  assert.equal(s.res.status, 200);
  assert.match(s.res.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(s.res.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(s.res.headers.get("x-accel-buffering"), "no");
  assert.equal(s.res.headers.get("content-encoding"), null, "never compressed");
  await s.until(() => s.text().includes("event: ready"), "ready");
  assert.match(s.text(), /^retry: \d+\n\n/, "tells EventSource how long to wait before reconnecting");
  await s.until(() => (s.text().match(/: hb\n\n/g) ?? []).length >= 2, "two heartbeats");

  const ev = { clientId: "c1", threadId: "t1", messageId: "m1", kind: "in", at: new Date().toISOString() };
  dmBus.emit("event", { ...ev, clientId: "c2", threadId: "t-other" });
  dmBus.emit("event", ev);
  await s.until(() => s.text().includes('"threadId":"t1"'), "its event");
  assert.ok(!s.text().includes("t-other"), "another brand's event never reaches this stream");
  assert.match(s.text(), /id: \d+\nevent: dm\ndata: \{"clientId":"c1","threadId":"t1","messageId":"m1","kind":"in","at":"[^"]+"\}\n\n/);

  // The ticket is spent: a reconnect has to ask for a new one.
  assert.equal((await fetch(`${base}/clients/c1/dm/stream?ticket=${ticket}`)).status, 401, "a used ticket");

  // Bearer works too (curl -N, bots), and the cap holds per user.
  const more = [];
  for (let i = 0; i < 5; i++) more.push(await open(`/clients/c1/dm/stream`, H(viewer)));
  assert.ok(more.every((m) => m.res.status === 200));
  const capped = await fetch(`${base}/clients/c1/dm/stream`, { headers: H(viewer) });
  assert.equal(capped.status, 429, "six streams per sign-in");
  assert.equal((await fetch(`${base}/clients/c1/dm/stream`, { headers: H(owner) })).status === 200, true, "another user is not capped by this one");

  // The LISTEN connection drops: every stream ends, so each Inbox polls and reconnects.
  dmBus.emit("down");
  await s.until(() => s.ended(), "the stream to end on down");
  for (const m of more) await m.until(() => m.ended(), "the stream to end on down");
  await s.close();
  for (const m of more) await m.close();
  await drain();
  assert.equal(dmBus.listenerCount("event"), 0, "no listener left behind");
}

// ---------------------------------------------------------------------------
// 4. Closing from the screen's side cleans up too
// ---------------------------------------------------------------------------
{
  const s = await open(`/clients/c1/dm/stream`, H(owner));
  await s.until(() => s.text().includes("event: ready"), "ready");
  assert.equal(openStreams(), 1);
  await s.close();
  await drain();
}

// ---------------------------------------------------------------------------
// 5. The request log never keeps a credential from a query string
// ---------------------------------------------------------------------------
assert.equal(redactUrl("/clients/c1/dm/stream?ticket=abc.def"), "/clients/c1/dm/stream?ticket=redacted");
assert.equal(redactUrl("/webhooks/meta?hub.mode=subscribe&hub.verify_token=xyz&hub.challenge=1"), "/webhooks/meta?hub.mode=subscribe&hub.verify_token=redacted&hub.challenge=1");
assert.equal(redactUrl("/files/a.pdf?e=1&s=sig"), "/files/a.pdf?e=1&s=redacted");
assert.equal(redactUrl("/clients/c1/dm/threads?limit=30"), "/clients/c1/dm/threads?limit=30");

// ---------------------------------------------------------------------------
// 6. The real path, on a Postgres: NOTIFY from publishDmEvent, through the
//    LISTEN connection, out of the stream. Skipped on CI (no database there).
// ---------------------------------------------------------------------------
liveTesting.busOnly = false;
if (REAL_DB) {
  env.DATABASE_URL = REAL_DB;
  setDmNotify(null);
  const s = await open(`/clients/c1/dm/stream`, H(owner));
  assert.equal(s.res.status, 200, "LISTEN connected");
  await s.until(() => s.text().includes("event: ready"), "ready");
  const sent = Date.now();
  await publishDmEvent({ clientId: "c1", threadId: "t-real", messageId: "m-real", kind: "in" });
  await publishDmEvent({ clientId: "c2", threadId: "t-real-other", kind: "in" });
  await s.until(() => s.text().includes("t-real"), "the NOTIFY to arrive", 5000);
  console.log(`live.check: NOTIFY to stream in ${Date.now() - sent} ms`);
  assert.ok(!s.text().includes("t-real-other"), "no cross-brand leak on the real channel");
  // The database connection drops: the stream ends, then LISTEN comes back on its own.
  live.stopListening();
  await s.until(() => s.ended(), "the stream to end when LISTEN drops");
  await s.close();
  assert.equal(await live.ensureListening(), true, "LISTEN reconnects");
  live.stopListening();
  await getPrisma().$disconnect();
} else {
  console.log("live.check: no LIVE_CHECK_DATABASE_URL, the real NOTIFY/LISTEN round trip is skipped");
}

await app.close();
console.log("live.check: all checks passed");
process.exit(0);
