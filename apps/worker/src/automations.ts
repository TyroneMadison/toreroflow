import { decryptSecret, getPrisma, Prisma, type DmAccount, type DmAutomation, type DmAutomationRun } from "@toreroflow/db";
import {
  AUTOMATION_HOURLY_BUDGET,
  canStillSend,
  configOf,
  fillText,
  pickAutomation,
  pickVariant,
  RETRYABLE_SEND,
  type DmAutomationConfig,
  type DmTriggerEvent,
} from "@toreroflow/core";
import {
  igAutomationSend,
  igCommentReply,
  igFollowsBusiness,
  igRecentMedia,
  InstagramError,
  type IgComment,
  type IgPart,
} from "@toreroflow/publishers";
import { env } from "./env";

/**
 * DM automations, the worker half (F4): comments and DMs from the webhook
 * matched against the live automations, then the private reply or DM, the
 * public reply, and a run row saying what happened.
 *
 * Nothing sends unless the account is connected natively (our Meta app, an
 * active token) and the automation is live with a published version. The
 * per-account kill switch stops everything on that account. Every event is
 * claimed by a run row unique per account and event first, so a redelivered
 * webhook, a retry and the drain never send twice. Meta's rules: one private
 * reply per comment within 7 days; a DM answer only inside the 24h window; no
 * HUMAN_AGENT tag (that is for a person). DM_AUTOMATIONS_DRY_RUN=1 runs the
 * matcher and records what would have gone out without calling Instagram.
 * Ported from fewchat's comments.ts and flows.ts (MIT, Copyright (c) 2026
 * Jason Cooperson).
 */

const prisma = getPrisma();
const HOUR = 3600_000;
/** How long a claimed event is ours before the drain may pick it up: a lease, so the two never race. */
const LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 12;
/** What followers-only sends someone who does not follow yet. */
const FOLLOW_FIRST = "Follow us first, then comment again and the link comes straight to you.";

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

function tokenOf(a: Pick<DmAccount, "accessTokenEnc" | "status" | "transport">): string | null {
  if (a.transport !== "native" || a.status !== "active" || !a.accessTokenEnc) return null;
  try {
    return decryptSecret(a.accessTokenEnc);
  } catch {
    return null;
  }
}

type Live = DmAutomation & { config: DmAutomationConfig };

/** The account's live automations, each with the version people get. */
async function liveAutomations(account: DmAccount): Promise<Live[]> {
  const rows = await prisma.dmAutomation.findMany({
    where: { socialAccountId: account.socialAccountId, status: "live", deletedAt: null, published: { not: Prisma.DbNull } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ ...r, config: configOf((r.published ?? {}) as Record<string, unknown>) }));
}

/** What a run needs to send, whatever triggered it. */
interface Target {
  kind: "comment" | "message";
  eventKey: string;
  trigger: string;
  contactExternalId: string;
  username: string | null;
  text: string | null;
  mediaId: string | null;
  commentId: string | null;
  eventAt: Date;
}

/** Claims an event. Null when another delivery already did. */
async function claim(account: DmAccount, t: Target, automationId: string | null, status: string, reason: string | null, test = false): Promise<DmAutomationRun | null> {
  try {
    return await prisma.dmAutomationRun.create({
      data: {
        dmAccountId: account.id,
        automationId,
        eventKey: t.eventKey,
        trigger: t.trigger,
        contactExternalId: t.contactExternalId,
        username: t.username,
        text: t.text?.slice(0, 1000) ?? null,
        mediaId: t.mediaId,
        commentId: t.commentId,
        status,
        reason,
        test,
        eventAt: t.eventAt,
        retryAt: status === "queued" ? new Date(Date.now() + LEASE_MS) : null,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

const finish = (id: string, data: Prisma.DmAutomationRunUpdateInput) => prisma.dmAutomationRun.update({ where: { id }, data });

/** Sent in the last hour on this account: Meta's private reply budget, which fewchat also applies to DMs. */
const sentLastHour = (dmAccountId: string, now: Date) =>
  prisma.dmAutomationRun.count({ where: { dmAccountId, sentAt: { gt: new Date(now.getTime() - HOUR) } } });

/**
 * Whether anything may go out for this run now, and if not, the run's final
 * word. Order matters: the kill switch and the connection first (nothing at
 * all), then the person (paused thread, the window, once each), then the budget.
 */
async function gate(account: DmAccount, a: Live | DmAutomation, cfg: DmAutomationConfig, run: DmAutomationRun, test: boolean, now: Date): Promise<{ status: string; reason: string } | "budget" | null> {
  if (account.automationsPausedAt) return { status: "skipped", reason: "Automations are paused for this account" };
  if (!tokenOf(account)) return { status: "skipped", reason: "Instagram is not connected through Torerone's Meta app" };
  const thread = await prisma.dmThread.findFirst({
    where: { dmAccountId: account.id, contact: { externalId: run.contactExternalId } },
    select: { pausedAt: true },
  });
  if (thread?.pausedAt) return { status: "skipped", reason: "Auto replies are paused in this conversation" };
  if (!canStillSend({ kind: run.commentId ? "comment" : "message", at: run.eventAt }, now)) {
    return { status: "expired", reason: run.commentId ? "Over 7 days old, too late to reply" : "The 24 hour reply window closed" };
  }
  if (!test && cfg.oncePerContact) {
    const before = await prisma.dmAutomationRun.findFirst({
      where: { automationId: a.id, contactExternalId: run.contactExternalId, status: { in: ["sent", "dry_run"] }, test: false, id: { not: run.id } },
      select: { id: true },
    });
    if (before) return { status: "repeat", reason: "Already sent to this person" };
  }
  if ((await sentLastHour(account.id, now)) >= AUTOMATION_HOURLY_BUDGET) return "budget";
  return null;
}

/** The link people tap: ours when tracked, so an open is counted, else theirs. */
function buttonFor(cfg: DmAutomationConfig, runId: string, test: boolean): { title: string; url: string; real: string } | null {
  const b = cfg.steps[0]?.button;
  if (!b) return null;
  const tracked = cfg.trackLinks && !test && env.PUBLIC_API_URL;
  return { title: b.title, url: tracked ? `${env.PUBLIC_API_URL}/dm/l/${runId}` : b.url, real: b.url };
}

/** Counters move for real runs only, never tests or dry runs. */
async function count(automationId: string, field: "sentCount" | "failedCount" | null, now: Date): Promise<void> {
  await prisma.dmAutomation.update({
    where: { id: automationId },
    data: { runCount: { increment: 1 }, ...(field ? { [field]: { increment: 1 } } : {}), lastRunAt: now },
  });
}

let revoke: (account: DmAccount, why: string) => Promise<void> = async () => undefined;
/** dm.ts hands over its revoked-token handling (the alert), so both paths react the same. */
export function onTokenRefused(fn: typeof revoke): void {
  revoke = fn;
}

/**
 * Sends a claimed run: the DM (or private reply), then the public reply.
 * Returns the run's final status.
 */
async function send(account: DmAccount, a: Live | DmAutomation, cfg: DmAutomationConfig, run: DmAutomationRun, test: boolean, now = new Date()): Promise<string> {
  const g = await gate(account, a, cfg, run, test, now);
  if (g === "budget") {
    // Over the hour's budget: wait for room, oldest first (the drain).
    await finish(run.id, { status: "queued", reason: "Hourly limit reached, sends when there is room", retryAt: new Date(now.getTime() + 5 * 60_000) });
    return "queued";
  }
  if (g) {
    await finish(run.id, { status: g.status, reason: g.reason, retryAt: null });
    return g.status;
  }
  const token = tokenOf(account)!;
  const step = cfg.steps[0];
  const who = await prisma.dmContact.findFirst({
    where: { dmAccountId: account.id, externalId: run.contactExternalId },
    select: { displayName: true, handle: true },
  });
  let text = fillText(step?.text ?? "", { name: who?.displayName ?? null, username: run.username ?? who?.handle ?? null });
  let button = buttonFor(cfg, run.id, test);
  let gated = false;
  if (cfg.followersOnly && !test && (await igFollowsBusiness(token, run.contactExternalId)) === false) {
    text = FOLLOW_FIRST;
    button = null;
    gated = true;
  }
  if (!text.trim()) {
    await finish(run.id, { status: "failed", reason: "The automation has no message", retryAt: null });
    return "failed";
  }
  // A test is a plain DM to whoever sent the code; a comment gets its private reply.
  const to = run.commentId && !test ? { commentId: run.commentId } : { recipientId: run.contactExternalId };

  if (env.DM_AUTOMATIONS_DRY_RUN) {
    await finish(run.id, {
      status: "dry_run",
      reason: `Dry run: would send "${text.slice(0, 120)}"${button ? ` with the button ${button.title}` : ""}`,
      linkUrl: button?.real ?? null,
      retryAt: null,
    });
    return "dry_run";
  }

  try {
    const r = await igAutomationSend(token, to, text, button);
    await finish(run.id, {
      status: gated ? "gated" : "sent",
      reason: gated ? "Not following yet, asked to follow first" : r.asText && button ? "Sent with the link as text" : null,
      sentAt: now,
      messageId: r.messageId,
      linkUrl: button?.real ?? null,
      attempts: { increment: 1 },
      retryAt: null,
    });
  } catch (e) {
    const attempts = run.attempts + 1;
    if (e instanceof InstagramError && e.tokenInvalid) await revoke(account, e.message);
    const retry = !(e instanceof InstagramError && e.tokenInvalid) && RETRYABLE_SEND.test(msg(e)) && attempts < MAX_ATTEMPTS;
    // 2, 4, 8 ... minutes, capped at an hour (fewchat).
    const wait = Math.min(HOUR, 2 ** attempts * 60_000);
    await finish(run.id, { status: retry ? "queued" : "failed", reason: msg(e), attempts, retryAt: retry ? new Date(now.getTime() + wait) : null });
    if (!retry && !test) await count(a.id, "failedCount", now);
    return retry ? "queued" : "failed";
  }

  if (test) {
    await prisma.dmAutomation.update({ where: { id: a.id }, data: { lastTestAt: now } });
    return "sent";
  }
  await count(a.id, gated ? null : "sentCount", now);
  // The public reply goes under the comment. Its failure never undoes the DM.
  if (run.commentId && cfg.publicReplyOn && !gated) {
    const reply = pickVariant(cfg.publicReplies);
    if (reply) {
      try {
        await igCommentReply(token, run.commentId, reply);
        await finish(run.id, { publicReplyAt: new Date() });
      } catch (e) {
        await finish(run.id, { reason: `DM sent; the public reply failed: ${msg(e)}`.slice(0, 500) });
      }
    }
  }
  return gated ? "gated" : "sent";
}

/**
 * "Next post or reel": a live automation waiting for the next post locks onto
 * the first one published after it went live, then works like any post
 * automation. A comment on a post already seen before then skips the call.
 */
async function lockNextPost(account: DmAccount, live: Live[], mediaId: string | null): Promise<void> {
  const waiting = live.filter((a) => a.config.trigger === "comment" && a.config.scope === "next" && !a.config.postIds.length);
  const token = tokenOf(account);
  if (!waiting.length || !token) return;
  for (const a of waiting) {
    const since = a.publishedAt ?? a.createdAt;
    if (mediaId) {
      const older = await prisma.dmAutomationRun.findFirst({ where: { dmAccountId: account.id, mediaId, createdAt: { lt: since } }, select: { id: true } });
      if (older) continue;
    }
    const media = await igRecentMedia(token, 10).catch(() => []);
    const first = media.filter((m) => m.at && m.at >= since).sort((x, y) => x.at!.getTime() - y.at!.getTime())[0];
    if (!first) continue;
    const published = { ...a.config, postIds: [first.id] };
    await prisma.dmAutomation.update({
      where: { id: a.id },
      data: { published: published as unknown as Prisma.InputJsonValue, ...(a.scope === "next" && !a.postIds.length ? { postIds: [first.id] } : {}) },
    });
    a.config = published;
  }
}

/** One comment on a native account: logged (most are "ignored"), matched, answered. */
export async function handleComment(account: DmAccount, c: IgComment, now = new Date()): Promise<string> {
  const live = await liveAutomations(account);
  await lockNextPost(account, live, c.mediaId).catch((e) => console.error("[automations] next post lock", msg(e)));
  const ev: DmTriggerEvent = { kind: "comment", text: c.text, mediaId: c.mediaId, at: c.at };
  const pick = pickAutomation(live, ev);
  const t: Target = {
    kind: "comment",
    eventKey: `comment:${c.commentId}`,
    trigger: "comment",
    contactExternalId: c.contactId,
    username: c.username,
    text: c.text,
    mediaId: c.mediaId,
    commentId: c.commentId,
    eventAt: c.at,
  };
  if (!pick) {
    const run = await claim(account, t, null, "ignored", live.length ? "No keyword matched" : "No live automation");
    return run ? "ignored" : "duplicate";
  }
  const run = await claim(account, t, pick.automation.id, "queued", null);
  if (!run) return "duplicate";
  return send(account, pick.automation, pick.automation.config, run, false, now);
}

/** A new inbound DM on a native account (the webhook's, never the sync's backfill). */
export interface InboundMessage {
  mid: string;
  contactId: string;
  username: string | null;
  text: string | null;
  parts: IgPart[];
  firstMessage: boolean;
  at: Date;
}

export async function handleMessage(account: DmAccount, m: InboundMessage, now = new Date()): Promise<string> {
  const t: Target = {
    kind: "message",
    eventKey: `message:${m.mid}`,
    trigger: "dm_keyword",
    contactExternalId: m.contactId,
    username: m.username,
    text: m.text,
    mediaId: null,
    commentId: null,
    eventAt: m.at,
  };
  // A three digit code from the editor's Test it: the working copy, for this person, as often as they like.
  const code = m.text?.trim().match(/^\d{3}$/)?.[0];
  if (code) {
    const a = await prisma.dmAutomation.findFirst({
      where: { socialAccountId: account.socialAccountId, testCode: code, testCodeExpiresAt: { gt: now }, deletedAt: null },
    });
    if (a) {
      const run = await claim(account, { ...t, trigger: "test" }, a.id, "queued", null, true);
      return run ? send(account, a, configOf(a), run, true, now) : "duplicate";
    }
  }
  const ev: DmTriggerEvent = {
    kind: "message",
    text: m.text,
    storyReply: m.parts.some((p) => p.type === "story_reply"),
    storyMention: m.parts.some((p) => p.type === "story_mention"),
    firstMessage: m.firstMessage,
    at: m.at,
  };
  const pick = pickAutomation(await liveAutomations(account), ev);
  if (!pick) return "none";
  const run = await claim(account, { ...t, trigger: pick.via }, pick.automation.id, "queued", null);
  if (!run) return "duplicate";
  return send(account, pick.automation, pick.automation.config, run, false, now);
}

/**
 * Queued runs whose turn came: over the hourly budget, or a retry after a
 * hiccup. Oldest first, at most 40 a tick so a backlog drains steadily.
 * Past the 7 day (comment) or 24h (DM) window they expire.
 */
export async function drainAutomations(now = new Date()): Promise<number> {
  const due = await prisma.dmAutomationRun.findMany({
    where: { status: "queued", retryAt: { lte: now } },
    orderBy: { eventAt: "asc" },
    take: 40,
    include: { dmAccount: true, automation: true },
  });
  for (const run of due) {
    const a = run.automation;
    if (!a || a.deletedAt || (!run.test && a.status !== "live")) {
      await finish(run.id, { status: "skipped", reason: "The automation was turned off", retryAt: null });
      continue;
    }
    // Take the lease, then send; another tick seeing it now skips it.
    const took = await prisma.dmAutomationRun.updateMany({
      where: { id: run.id, status: "queued", retryAt: run.retryAt },
      data: { retryAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (!took.count) continue;
    const cfg = run.test ? configOf(a) : configOf((a.published ?? {}) as Record<string, unknown>);
    await send(run.dmAccount, a, cfg, run, run.test, now).catch((e) => console.error("[automations] drain", run.id, msg(e)));
  }
  return due.length;
}

/** Comments with no automation are kept a month: enough for Recent comments, not a second copy of everyone's. */
export async function pruneRuns(now = new Date()): Promise<void> {
  await prisma.dmAutomationRun.deleteMany({ where: { status: "ignored", createdAt: { lt: new Date(now.getTime() - 30 * 24 * HOUR) } } });
}

/** Every comment in a delivery, for the accounts connected natively. */
export async function runCommentAutomations(comments: IgComment[]): Promise<void> {
  const accounts = new Map<string, DmAccount | null>();
  for (const c of comments) {
    if (!accounts.has(c.accountId)) {
      accounts.set(c.accountId, await prisma.dmAccount.findFirst({ where: { platform: "instagram", externalId: c.accountId, transport: "native" } }));
    }
    const account = accounts.get(c.accountId);
    if (account) await handleComment(account, c);
  }
}
