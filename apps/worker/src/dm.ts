import { decryptSecret, encryptSecret, getPrisma, Prisma, type DmAccount } from "@toreroflow/db";
import { DM_WINDOW_MS } from "@toreroflow/core";
import {
  igConversations,
  igProfile,
  igRefreshToken,
  InstagramError,
  parseComments,
  parseWebhook,
  partsFromApi,
  previewOf,
  type IgEvent,
} from "@toreroflow/publishers";
import { handleMessage, onTokenRefused, pruneRuns, runCommentAutomations, type InboundMessage } from "./automations";

/**
 * Native Instagram DMs, the worker half (F2): webhook deliveries into threads
 * and messages, the missed-DM sync, and the token refresh.
 *
 * Every path writes through ingest(), so a message the webhook brought, the
 * sync found and our own send recorded are the same row (unique per thread
 * and platform message id) however many of them see it, in whatever order.
 * Ported from fewchat (MIT, Copyright (c) 2026 Jason Cooperson).
 */

const prisma = getPrisma();

type MessageEvent = Extract<IgEvent, { kind: "message" }>;

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** A token for an account, or null when there is none to use. */
function tokenOf(account: Pick<DmAccount, "accessTokenEnc" | "status">): string | null {
  if (!account.accessTokenEnc || account.status !== "active") return null;
  try {
    return decryptSecret(account.accessTokenEnc);
  } catch {
    return null;
  }
}

/** One message into its contact, thread and row. The new inbound message, for the automations, or null. */
async function ingestMessage(account: DmAccount, ev: MessageEvent, token: string | null, conversationId?: string): Promise<InboundMessage | false | null> {
  let contact = await prisma.dmContact.findUnique({
    where: { dmAccountId_externalId: { dmAccountId: account.id, externalId: ev.contactId } },
  });
  if (!contact) {
    // Name and picture once, on first sight. A failed lookup leaves the IGSID showing, never the message lost.
    const profile = token ? await igProfile(token, ev.contactId) : { username: null, name: null, pic: null };
    try {
      contact = await prisma.dmContact.create({
        data: {
          dmAccountId: account.id,
          externalId: ev.contactId,
          handle: profile.username,
          displayName: profile.name ?? profile.username,
          avatarUrl: profile.pic,
        },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      contact = await prisma.dmContact.findUniqueOrThrow({
        where: { dmAccountId_externalId: { dmAccountId: account.id, externalId: ev.contactId } },
      });
    }
  }

  const thread = await prisma.dmThread.upsert({
    where: { dmAccountId_contactId: { dmAccountId: account.id, contactId: contact.id } },
    create: { dmAccountId: account.id, contactId: contact.id, source: "native", externalId: conversationId ?? null },
    update: conversationId ? { externalId: conversationId } : {},
  });

  const known = await prisma.dmMessage.findUnique({
    where: { threadId_externalId: { threadId: thread.id, externalId: ev.mid } },
    select: { id: true },
  });
  if (known) return false;
  // Their first message ever here: no earlier inbound row (an echo of a private reply does not count).
  const firstMessage =
    ev.direction === "in" && !(await prisma.dmMessage.findFirst({ where: { threadId: thread.id, direction: "in" }, select: { id: true } }));
  try {
    await prisma.dmMessage.create({
      data: {
        threadId: thread.id,
        externalId: ev.mid,
        direction: ev.direction,
        text: ev.text,
        attachments: ev.parts.length ? (ev.parts as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        replyToExternalId: ev.replyTo,
        sentAt: ev.at,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }

  const newest = !thread.lastMessageAt || ev.at >= thread.lastMessageAt;
  const inbound = ev.direction === "in";
  const lastInboundAt = inbound && (!thread.lastInboundAt || ev.at > thread.lastInboundAt) ? ev.at : thread.lastInboundAt;
  await prisma.dmThread.update({
    where: { id: thread.id },
    data: {
      ...(newest
        ? { lastMessageAt: ev.at, lastPreview: previewOf(ev.text, ev.parts), lastDirection: ev.direction }
        : {}),
      lastInboundAt,
      windowEndsAt: lastInboundAt ? new Date(lastInboundAt.getTime() + DM_WINDOW_MS) : null,
      ...(inbound && (!thread.readAt || ev.at > thread.readAt) ? { unread: { increment: 1 } } : {}),
      // A new message from them reopens a conversation someone marked done.
      ...(inbound && thread.status === "done" ? { status: "open" } : {}),
    },
  });
  if (inbound && (!contact.lastSeenAt || ev.at > contact.lastSeenAt)) {
    await prisma.dmContact.update({ where: { id: contact.id }, data: { lastSeenAt: ev.at } });
  }
  return inbound
    ? { mid: ev.mid, contactId: ev.contactId, username: contact.handle, text: ev.text, parts: ev.parts, firstMessage, at: ev.at }
    : null;
}

/** A change to a message we already have. Unknown mids are ignored, as fewchat does. */
async function applyUpdate(account: DmAccount, ev: Exclude<IgEvent, MessageEvent>): Promise<void> {
  const row = await prisma.dmMessage.findFirst({
    where: { externalId: ev.mid, thread: { dmAccountId: account.id } },
    select: { id: true, reactions: true },
  });
  if (!row) return;
  if (ev.kind === "reaction") {
    const reactions = { ...((row.reactions as Record<string, string> | null) ?? {}) };
    if (ev.emoji) reactions[ev.who] = ev.emoji;
    else delete reactions[ev.who];
    await prisma.dmMessage.update({
      where: { id: row.id },
      data: { reactions: Object.keys(reactions).length ? reactions : Prisma.JsonNull },
    });
  } else if (ev.kind === "edit") {
    await prisma.dmMessage.update({ where: { id: row.id }, data: { text: ev.text, editedAt: new Date() } });
  } else {
    // They took it back: what it said and showed goes too (Meta Platform Terms).
    await prisma.dmMessage.update({
      where: { id: row.id },
      data: { text: null, attachments: Prisma.JsonNull, reactions: Prisma.JsonNull, transcript: null, unsentAt: new Date() },
    });
  }
}

/**
 * Events into the database. Accounts that are not connected natively are
 * skipped: Meta delivers for every account subscribed to the app, and an
 * account that disconnected has no business collecting new messages here.
 */
export async function ingest(
  events: IgEvent[],
  opts: { conversationId?: string } = {},
): Promise<{ added: number; inbound: Array<{ account: DmAccount; message: InboundMessage }> }> {
  let added = 0;
  const inbound: Array<{ account: DmAccount; message: InboundMessage }> = [];
  const accounts = new Map<string, DmAccount | null>();
  for (const ev of events) {
    if (!accounts.has(ev.accountId)) {
      accounts.set(
        ev.accountId,
        await prisma.dmAccount.findFirst({
          where: { platform: "instagram", externalId: ev.accountId, transport: "native" },
        }),
      );
    }
    const account = accounts.get(ev.accountId);
    if (!account) continue;
    if (ev.kind === "message") {
      const got = await ingestMessage(account, ev, tokenOf(account), opts.conversationId);
      if (got !== false) added++;
      if (got) inbound.push({ account, message: got });
    } else {
      await applyUpdate(account, ev);
    }
  }
  for (const account of accounts.values()) {
    if (account) await prisma.dmAccount.update({ where: { id: account.id }, data: { lastWebhookAt: new Date() } });
  }
  return { added, inbound };
}

/**
 * The queued half of POST /webhooks/meta: messages into threads, then the
 * automations (F4) for the new inbound messages and the comments. Only the
 * webhook runs automations: the missed-DM sync finds old messages, and
 * answering those late would be a surprise, not a reply.
 */
export async function processWebhookEvent(eventId: string): Promise<void> {
  const row = await prisma.dmWebhookEvent.findUnique({ where: { id: eventId } });
  if (!row || row.processedAt || !row.signatureOk) return;
  try {
    const { inbound } = await ingest(parseWebhook(row.payload));
    for (const { account, message } of inbound) await handleMessage(account, message);
    await runCommentAutomations(parseComments(row.payload));
    await prisma.dmWebhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date(), error: null } });
  } catch (e) {
    await prisma.dmWebhookEvent.update({
      where: { id: eventId },
      data: { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) },
    });
    throw e;
  }
}

const OVERLAP_MS = 2 * 60 * 1000;
const MAX_PAGES = 4;

/**
 * The webhook's safety net: Instagram has gone quiet for half an hour at a
 * time. Re-reads conversations updated since the last sync and records any
 * message not already here. The first run reads the most recent page, so a
 * newly connected account opens on its recent conversations, not an empty
 * inbox. Group chats are left out: Instagram only lets them be read.
 */
export async function syncAccount(account: DmAccount, now = new Date()): Promise<number> {
  const token = tokenOf(account);
  if (!token || !account.externalId) return 0;
  const me = account.externalId;
  const watermark = account.lastSyncAt?.getTime() ?? 0;
  let newest = watermark;
  let added = 0;
  let next: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await igConversations(token, next);
    let reachedOld = false;
    for (const c of res.data) {
      const updated = Date.parse(c.updated_time);
      if (watermark && updated < watermark - OVERLAP_MS) {
        reachedOld = true;
        break;
      }
      newest = Math.max(newest, updated);
      const others = (c.participants?.data ?? []).filter((p) => p.id !== me);
      if (others.length !== 1) continue;
      const other = others[0]!;
      const events: IgEvent[] = (c.messages?.data ?? []).map((m) => ({
        kind: "message",
        accountId: me,
        contactId: other.id,
        direction: m.from?.id === me ? "out" : "in",
        mid: m.id,
        text: m.message?.trim() ? m.message : null,
        parts: partsFromApi(m),
        replyTo: null,
        at: new Date(m.created_time ?? now),
      }));
      added += (await ingest(events.filter((e) => e.kind === "message" && (e.text || e.parts.length)), { conversationId: c.id })).added;
    }
    // First run: one page of recent history is the backfill; older is history.
    if (reachedOld || !res.next || !watermark) break;
    next = res.next;
  }
  await prisma.dmAccount.update({
    where: { id: account.id },
    data: { lastSyncAt: new Date(newest || now.getTime()), error: null },
  });
  return added;
}

/** A token Instagram refused: stop using it, say so where the operator looks. */
export async function markRevoked(account: DmAccount, why: string): Promise<void> {
  await prisma.dmAccount.update({ where: { id: account.id }, data: { status: "revoked", error: why } });
  const client = await prisma.client.findUnique({ where: { id: account.clientId }, select: { agencyId: true } });
  if (!client) return;
  const key = `dm_token_revoked:${account.id}`;
  await prisma.systemAlert.upsert({
    where: { agencyId_key: { agencyId: client.agencyId, key } },
    create: {
      agencyId: client.agencyId,
      key,
      kind: "dm_token",
      severity: "error",
      clientId: account.clientId,
      message: `Instagram stopped accepting replies for @${account.username ?? "this account"}. Reconnect it in Workflows, Inbox.`,
      detail: why.slice(0, 500),
    },
    update: { detail: why.slice(0, 500), lastSeenAt: new Date(), count: { increment: 1 }, dismissedAt: null },
  });
}

/**
 * Deliveries that were stored but never queued (the queue was down when the
 * webhook answered) or whose job gave up. Two days back is plenty: past that
 * the missed-DM sync has the messages anyway.
 */
export async function sweepWebhookEvents(now = new Date()): Promise<void> {
  const stale = await prisma.dmWebhookEvent.findMany({
    where: {
      signatureOk: true,
      processedAt: null,
      receivedAt: { lt: new Date(now.getTime() - 60_000), gt: new Date(now.getTime() - 2 * 24 * 3600_000) },
    },
    orderBy: { receivedAt: "asc" },
    take: 100,
    select: { id: true },
  });
  for (const e of stale) await processWebhookEvent(e.id).catch(() => undefined);
}

export async function syncAll(): Promise<void> {
  await sweepWebhookEvents();
  const accounts = await prisma.dmAccount.findMany({ where: { transport: "native", status: "active" } });
  for (const account of accounts) {
    try {
      const added = await syncAccount(account);
      if (added) console.log(`[dm] sync recorded ${added} missed message(s) for @${account.username ?? account.id}`);
    } catch (e) {
      if (e instanceof InstagramError && e.tokenInvalid) await markRevoked(account, e.message);
      else {
        console.error("[dm] sync failed", account.id, e instanceof Error ? e.message : e);
        await prisma.dmAccount.update({
          where: { id: account.id },
          data: { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) },
        });
      }
    }
  }
}

/** Refresh when fewer than this many days are left. Daily runs leave a month of retries. */
const REFRESH_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/** Keeps every 60-day token alive. Instagram only refreshes a token at least a day old. */
export async function refreshTokens(now = new Date()): Promise<void> {
  const due = await prisma.dmAccount.findMany({
    where: {
      transport: "native",
      status: "active",
      accessTokenEnc: { not: null },
      OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { lt: new Date(now.getTime() + REFRESH_WITHIN_MS) } }],
    },
  });
  for (const account of due) {
    const token = tokenOf(account);
    if (!token) continue;
    if (account.tokenRefreshedAt && now.getTime() - account.tokenRefreshedAt.getTime() < 24 * 3600_000) continue;
    try {
      const fresh = await igRefreshToken(token);
      await prisma.dmAccount.update({
        where: { id: account.id },
        data: { accessTokenEnc: encryptSecret(fresh.token), tokenExpiresAt: fresh.expiresAt, tokenRefreshedAt: now, error: null },
      });
    } catch (e) {
      if (e instanceof InstagramError && e.tokenInvalid) await markRevoked(account, e.message);
      else console.error("[dm] token refresh failed", account.id, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * Deliveries are kept for a fortnight once processed, and refused ones (no
 * payload) for a week: enough to debug with, not a second copy of everyone's
 * messages.
 */
export async function pruneWebhookEvents(now = new Date()): Promise<void> {
  const day = 24 * 3600_000;
  await prisma.dmWebhookEvent.deleteMany({
    where: {
      OR: [
        { processedAt: { lt: new Date(now.getTime() - 14 * day) } },
        { signatureOk: false, receivedAt: { lt: new Date(now.getTime() - 7 * day) } },
      ],
    },
  });
}

onTokenRefused(markRevoked);

export type DmJob = { kind: "ingest"; eventId: string } | { kind: "sync" } | { kind: "refresh" };

export async function runDmJob(job: DmJob): Promise<void> {
  if (job.kind === "ingest") await processWebhookEvent(job.eventId);
  else if (job.kind === "sync") await syncAll();
  else if (job.kind === "refresh") {
    await refreshTokens();
    await pruneWebhookEvents();
    await pruneRuns();
  }
}
