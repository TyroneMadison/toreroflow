import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { DM_CHANNEL, secretsMatch, type DmEvent } from "@toreroflow/db";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import { ownedClient } from "./service";

/**
 * Inbox live updates (H1): GET /clients/:id/dm/stream, Server-Sent Events.
 *
 * Whoever saves a DM change (the worker's webhook ingest, a send here, the
 * Zernio list sync) calls publishDmEvent (packages/db/src/dmEvents.ts), which
 * is a Postgres NOTIFY. This process holds ONE dedicated LISTEN connection and
 * fans each event out to the streams of that event's brand. An event is ids
 * only; the Inbox rereads the list and the open thread through the normal
 * routes, so what it shows is always what those routes authorize.
 *
 * EventSource cannot send our Authorization header and the app has no cookie,
 * so the screen first asks POST /clients/:id/dm/stream-ticket (signed in as
 * usual) for a ticket: one brand, one use, 60 seconds, signed with a key of
 * its own so it is never a login token. curl and bots may send the bearer
 * token on the stream itself instead. Viewers may stream: it is a read.
 *
 * While the LISTEN connection is down, open streams are closed and new ones
 * answer 503, so every screen falls back to polling instead of believing it
 * is live. It reconnects with backoff on its own.
 */

export const dmBus = new EventEmitter();
dmBus.setMaxListeners(0);

const HEARTBEAT_MS = 20_000;
const TICKET_MS = 60_000;
/** Streams per signed-in user: a few windows and devices, not a leak. */
const MAX_PER_USER = 6;
/** What EventSource waits before reconnecting after a drop. */
const RETRY_MS = 5000;

/** Checks shorten the heartbeat and bring their own bus. */
export const liveTesting = { heartbeatMs: HEARTBEAT_MS, busOnly: false };

// ---------------------------------------------------------------------------
// LISTEN
// ---------------------------------------------------------------------------

let conn: pg.Client | null = null;
let connecting: Promise<boolean> | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let attempts = 0;

export const liveUp = (): boolean => liveTesting.busOnly || conn !== null;

/** Connects the one LISTEN connection if it is not up. True once it is. */
export async function ensureListening(): Promise<boolean> {
  if (liveUp()) return true;
  if (!env.DATABASE_URL) return false;
  connecting ??= connect().finally(() => (connecting = null));
  return connecting;
}

async function connect(): Promise<boolean> {
  const c = new pg.Client({ connectionString: env.DATABASE_URL, keepAlive: true });
  c.on("notification", (m) => {
    if (m.channel !== DM_CHANNEL || !m.payload) return;
    try {
      dmBus.emit("event", JSON.parse(m.payload) as DmEvent);
    } catch {
      // Not ours, or cut off: nothing to tell anyone.
    }
  });
  const lost = () => {
    if (conn !== c) return;
    conn = null;
    console.warn("[dm-live] LISTEN connection lost, streams closed, reconnecting");
    dmBus.emit("down");
    c.end().catch(() => undefined);
    retry();
  };
  c.on("error", lost);
  c.on("end", lost);
  try {
    await c.connect();
    await c.query(`LISTEN ${DM_CHANNEL}`);
    conn = c;
    attempts = 0;
    return true;
  } catch (e) {
    console.warn("[dm-live] LISTEN failed", e instanceof Error ? e.message : e);
    c.end().catch(() => undefined);
    retry();
    return false;
  }
}

function retry(): void {
  if (retryTimer) return;
  const wait = Math.min(30_000, 1000 * 2 ** attempts++);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void ensureListening();
  }, wait);
  retryTimer.unref();
}

/** For checks: drop the LISTEN connection as a database restart would. */
export function stopListening(): void {
  conn?.emit("end");
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  attempts = 0;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

interface Ticket {
  /** user (token sub) */
  u: string;
  /** agency */
  a: string;
  /** the one brand it streams */
  c: string;
  exp: number;
  n: string;
}

/** Its own key, so a ticket is never a valid login token and a login token never a ticket. */
const ticketKey = () => createHmac("sha256", env.JWT_SECRET).update("dm-stream-ticket:v1").digest();
const mac = (body: string) => createHmac("sha256", ticketKey()).update(body).digest("base64url");

export function signTicket(t: Omit<Ticket, "exp" | "n">, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...t, exp: now + TICKET_MS, n: randomBytes(12).toString("base64url") })).toString("base64url");
  return `${body}.${mac(body)}`;
}

/**
 * Used tickets until they expire: one use each, so a ticket that ends up in
 * a log line or a proxy is already spent.
 * ponytail: per process; the API is one process.
 */
const spent = new Map<string, number>();

export function redeemTicket(raw: unknown, now = Date.now()): Ticket | null {
  if (typeof raw !== "string") return null;
  const [body, sig] = raw.split(".");
  if (!body || !sig || !secretsMatch(sig, mac(body))) return null;
  let t: Ticket;
  try {
    t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Ticket;
  } catch {
    return null;
  }
  if (typeof t.exp !== "number" || t.exp < now || typeof t.n !== "string" || spent.has(t.n)) return null;
  for (const [n, exp] of spent) if (exp < now) spent.delete(n);
  spent.set(t.n, t.exp);
  return t;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const open = new Map<string, number>();
let seq = 0;

const FORBIDDEN = { error: "not your brand" } as const;

export async function dmLiveRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>("/clients/:id/dm/stream-ticket", { onRequest: requireAuth }, async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(403).send(FORBIDDEN);
    return {
      ticket: signTicket({ u: request.user.sub, a: request.user.agencyId, c: client.id }),
      expiresInSeconds: TICKET_MS / 1000,
    };
  });

  app.get<{ Params: { id: string }; Querystring: { ticket?: string } }>("/clients/:id/dm/stream", async (request, reply) => {
    let user: string;
    let agencyId: string;
    if (request.query.ticket !== undefined) {
      const t = redeemTicket(request.query.ticket);
      if (!t) return reply.status(401).send({ error: "this stream ticket is not valid or has expired", reason: "ticket" });
      if (t.c !== request.params.id) return reply.status(403).send(FORBIDDEN);
      user = t.u;
      agencyId = t.a;
    } else {
      await requireAuth(request, reply);
      if (reply.sent) return reply;
      user = request.user.sub;
      agencyId = request.user.agencyId;
    }
    const client = await ownedClient(request.params.id, agencyId);
    if (!client) return reply.status(403).send(FORBIDDEN);
    if ((open.get(user) ?? 0) >= MAX_PER_USER) {
      return reply.status(429).send({ error: "too many open Inbox streams for this sign-in", reason: "too_many_streams" });
    }
    if (!(await ensureListening())) {
      return reply.status(503).send({ error: "live updates are unavailable right now, the Inbox polls instead", reason: "live_unavailable" });
    }

    // Ours from here: Fastify neither buffers nor compresses this response.
    reply.hijack();
    const res = reply.raw;
    open.set(user, (open.get(user) ?? 0) + 1);
    res.writeHead(200, {
      // CORS and anything else the hooks already set (the web app is another origin).
      ...(reply.getHeaders() as Record<string, string | number | string[]>),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    res.write(`retry: ${RETRY_MS}\n\n`);
    res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    const onEvent = (e: DmEvent) => {
      if (e.clientId === client.id) res.write(`id: ${++seq}\nevent: dm\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const beat = setInterval(() => res.write(`: hb\n\n`), liveTesting.heartbeatMs);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      dmBus.off("event", onEvent);
      dmBus.off("down", end);
      const left = (open.get(user) ?? 1) - 1;
      if (left > 0) open.set(user, left);
      else open.delete(user);
    };
    const end = () => (close(), res.end());
    dmBus.on("event", onEvent);
    dmBus.on("down", end);
    request.raw.on("close", close);
    res.on("close", close);
  });
}

/** For checks: how many streams are open right now. */
export const openStreams = (): number => [...open.values()].reduce((a, b) => a + b, 0);
