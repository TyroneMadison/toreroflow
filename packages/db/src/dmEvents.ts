import { getPrisma } from "./index";

/**
 * Inbox live updates (H1): "something changed in this conversation", sent
 * over Postgres NOTIFY so the worker (webhook ingest, automations, AI
 * replies) and the API (sends, reads, the Zernio list sync) reach every open
 * Inbox through the API's one LISTEN connection (apps/api/src/dm/live.ts).
 *
 * Ids and a kind only, never message text: the payload crosses a channel any
 * database role can LISTEN on, and the screen rereads what it shows through
 * the normal, authorized routes anyway.
 */

export const DM_CHANNEL = "dm_events";

export type DmEventKind = "in" | "out" | "reaction" | "edit" | "unsend" | "read" | "thread";

export interface DmEvent {
  clientId: string;
  threadId: string;
  messageId: string | null;
  kind: DmEventKind;
  /** ISO time it happened here. */
  at: string;
}

type Notify = (channel: string, payload: string) => Promise<unknown>;

const pgNotify: Notify = (channel, payload) => getPrisma().$executeRaw`SELECT pg_notify(${channel}, ${payload})`;
let notify: Notify = pgNotify;

/** Checks swap the transport; null puts Postgres back. */
export function setDmNotify(fn: Notify | null): void {
  notify = fn ?? pgNotify;
}

/**
 * Tell open Inboxes. Never throws: a lost event costs one screen a few
 * seconds (it polls when the stream is down, and rereads on reconnect), a
 * thrown one would fail the webhook ingest that already saved the message.
 */
export async function publishDmEvent(e: Omit<DmEvent, "at" | "messageId"> & { messageId?: string | null; at?: Date }): Promise<void> {
  const payload: DmEvent = {
    clientId: e.clientId,
    threadId: e.threadId,
    messageId: e.messageId ?? null,
    kind: e.kind,
    at: (e.at ?? new Date()).toISOString(),
  };
  try {
    await notify(DM_CHANNEL, JSON.stringify(payload));
  } catch (err) {
    console.warn("[dm-live] notify failed", err instanceof Error ? err.message : err);
  }
}
