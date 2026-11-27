import Anthropic from "@anthropic-ai/sdk";
import { decryptSecret, getPrisma, Prisma, type DmAccount, type DmAiDraft } from "@toreroflow/db";
import {
  costCents,
  DM_AI_DECISION_SCHEMA,
  DM_AI_HISTORY,
  DM_AI_QUIET_MS,
  DM_WINDOW_MS,
  dmAiDelayMs,
  dmAiHandoffMatch,
  dmAiNoDraft,
  dmAiNoSend,
  dmAiSettingsOf,
  dmAiSystemPrompt,
  dmAiTranscript,
  readDmAiDecision,
  type DmAiContext,
  type DmAiLine,
  type DmAiSettings,
} from "@toreroflow/core";
import { igSend, igTyping, InstagramError, previewOf, ZernioProvider } from "@toreroflow/publishers";
import { markRevoked } from "./dm";
import { env } from "./env";

/**
 * AI replies, the worker half (F5): when a native Instagram chat goes quiet,
 * write a reply with Claude from the chat and the account's notes; leave it as
 * a draft for the Inbox composer, or, on an account a person switched to
 * autopilot, send it after the reply delay with the typing dots.
 *
 * OFF until a person turns it on (dmAiSettingsOf of no row is off). Every
 * send re-checks the gates at send time (core dmAiNoSend): the agency kill
 * switch, the 24h window, a paused or handed-off chat, a reply by the team in
 * the meantime, quiet hours and the daily cap. A handoff rule match stops it
 * before any model is asked. Messenger and Instagram read through Zernio are
 * never written for unprompted and never sent by the AI: a person asks for a
 * draft there, and sends it. One draft per inbound message (unique), so a
 * retry or a second tick never writes or sends twice.
 */

const prisma = getPrisma();
const DAY = 24 * 3600_000;
/** The agency kill switch for AI sending, an AppSetting row (value { at, by }). */
export const DM_AI_KILL_KEY = "dm_ai_kill";
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AiWritten {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  refused: boolean;
}
export type AiWriter = (system: string, user: string) => Promise<AiWritten>;

/** The model the repo writes captions and ideas with (SUGGESTIONS_MODEL). */
async function claude(system: string, user: string): Promise<AiWritten> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set, so the AI cannot write replies.");
  const r = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).messages.create({
    model: env.COPY_MODEL,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: DM_AI_DECISION_SCHEMA } },
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = r.content.find((b) => b.type === "text");
  return {
    text: block?.type === "text" ? block.text : "",
    model: r.model,
    inputTokens: r.usage.input_tokens,
    outputTokens: r.usage.output_tokens,
    refused: r.stop_reason === "refusal",
  };
}
let writer: AiWriter = claude;
/** The check swaps the model for a script. */
export const setAiWriter = (w: AiWriter): void => {
  writer = w;
};
/** And the pauses for nothing. */
let pause = sleep;
export const setAiPause = (p: (ms: number) => Promise<void>): void => {
  pause = p;
};

function tokenOf(a: Pick<DmAccount, "accessTokenEnc" | "status" | "transport">): string | null {
  if (a.transport !== "native" || a.status !== "active" || !a.accessTokenEnc) return null;
  try {
    return decryptSecret(a.accessTokenEnc);
  } catch {
    return null;
  }
}

export async function killedAt(agencyId: string): Promise<Date | null> {
  const row = await prisma.appSetting.findUnique({ where: { agencyId_key: { agencyId, key: DM_AI_KILL_KEY } } });
  const at = (row?.value as { at?: string } | null)?.at;
  return at ? new Date(at) : null;
}

const threadInclude = {
  contact: { include: { tags: { include: { tag: { select: { name: true } } } } } },
  dmAccount: {
    include: {
      aiSettings: true,
      client: { select: { name: true, agencyId: true, providerProfileId: true } },
      socialAccount: { select: { handle: true, providerAccountId: true } },
    },
  },
} satisfies Prisma.DmThreadInclude;
type ThreadRow = Prisma.DmThreadGetPayload<{ include: typeof threadInclude }>;

const isFriend = (t: ThreadRow) => t.contact.tags.some((x) => x.tag.name.trim().toLowerCase() === "friend");
const sentToday = (dmAccountId: string, now: Date) =>
  prisma.dmAiDraft.count({ where: { dmAccountId, status: "sent", sentHow: "auto", sentAt: { gt: new Date(now.getTime() - DAY) } } });

async function contextOf(t: ThreadRow, settings: DmAiSettings, now: Date, forExternalId: string | null): Promise<DmAiContext> {
  const a = t.dmAccount;
  const answered = forExternalId
    ? await prisma.dmAutomationRun.findFirst({
        where: { dmAccountId: a.id, eventKey: `message:${forExternalId}`, status: { in: ["sent", "queued", "gated", "dry_run"] } },
        select: { id: true },
      })
    : null;
  return {
    now,
    settings,
    killed: !!(await killedAt(a.client.agencyId)),
    platform: a.platform === "facebook" ? "facebook" : "instagram",
    native: !!tokenOf(a),
    thread: {
      status: t.status,
      pausedAt: t.pausedAt,
      aiOff: t.aiOff,
      aiHandoffAt: t.aiHandoffAt,
      aiPausedUntil: t.aiPausedUntil,
      lastDirection: t.lastDirection,
      lastInboundAt: t.lastInboundAt,
      windowEndsAt: t.windowEndsAt,
    },
    friend: isFriend(t),
    automationAnswered: !!answered,
    sentToday: await sentToday(a.id, now),
    timezone: env.BUSINESS_TIMEZONE,
  };
}

const kindsOf = (attachments: Prisma.JsonValue): string[] =>
  (Array.isArray(attachments) ? attachments : []).map((p) => String((p as { type?: string } | null)?.type ?? "attachment"));

let zernioClient: ZernioProvider | null | undefined;
function zernio(): ZernioProvider | null {
  if (zernioClient === undefined) {
    zernioClient = env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY) : null;
  }
  return zernioClient;
}
/** The check swaps Zernio for a fake. */
export const setAiZernio = (z: ZernioProvider | null): void => {
  zernioClient = z;
};

/** The chat as the model reads it, and the message the reply answers. */
async function chatOf(t: ThreadRow, now: Date): Promise<{ lines: DmAiLine[]; lastIn: { id: string; text: string | null; at: Date } | null } | { error: string }> {
  if (t.source === "native") {
    const rows = await prisma.dmMessage.findMany({
      where: { threadId: t.id, unsentAt: null, status: "sent" },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      take: DM_AI_HISTORY,
    });
    rows.reverse();
    const last = [...rows].reverse().find((m) => m.direction === "in");
    return {
      lines: rows.map((m) => ({ direction: m.direction === "out" ? "out" : "in", text: m.text, kinds: kindsOf(m.attachments) })),
      lastIn: last ? { id: last.externalId, text: last.text, at: last.sentAt } : null,
    };
  }
  // Zernio (Messenger, and Instagram before the Meta app connect): read live, never stored.
  const z = zernio();
  const providerAccountId = t.dmAccount.socialAccount.providerAccountId;
  if (!z || !t.externalId || !providerAccountId) return { error: "Zernio cannot read this conversation right now" };
  const messages = await z.conversationMessages(t.externalId, providerAccountId, DM_AI_HISTORY);
  const sorted = [...messages].sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
  const last = [...sorted].reverse().find((m) => m.direction === "incoming");
  const lastAt = last?.createdAt ? new Date(last.createdAt) : null;
  // Messenger only takes a reply inside the 24h window too: no draft for a closed one.
  if (!last || !lastAt || now.getTime() - lastAt.getTime() >= DM_WINDOW_MS) return { error: "The 24 hour reply window closed" };
  return {
    lines: sorted.map((m) => ({ direction: m.direction === "outgoing" ? "out" : "in", text: m.message || null, kinds: m.attachments.map((x) => x.type ?? "attachment") })),
    lastIn: { id: last.id, text: last.message || null, at: lastAt },
  };
}

/**
 * Writes one reply for a chat. auto: the worker's own, only where
 * dmAiNoDraft allows. request: a person pressed "Draft with AI" in the Inbox
 * (any account with AI replies on, the window open). Returns the draft, or
 * null when nothing was written.
 */
export async function draftThread(threadId: string, origin: "auto" | "request", now = new Date(), by: string | null = null): Promise<DmAiDraft | null> {
  const t = await prisma.dmThread.findUnique({ where: { id: threadId }, include: threadInclude });
  if (!t) return null;
  const settings = dmAiSettingsOf(t.dmAccount.aiSettings as unknown as Record<string, unknown> | null);
  if (!settings.enabled) return null;

  let chat: Awaited<ReturnType<typeof chatOf>>;
  try {
    chat = await chatOf(t, now);
  } catch (e) {
    chat = { error: `Could not read the chat: ${msg(e)}` };
  }
  const lastId = "error" in chat ? null : (chat.lastIn?.id ?? null);
  if (origin === "auto") {
    if (!lastId) return null;
    if (dmAiNoDraft(await contextOf(t, settings, now, lastId))) return null;
  }
  // One row per inbound message claims the work; a person's request is its own row.
  const forExternalId = origin === "request" ? `${lastId ?? "none"}#request:${now.getTime()}` : lastId!;
  let draft: DmAiDraft;
  try {
    draft = await prisma.dmAiDraft.create({
      data: { dmAccountId: t.dmAccountId, threadId: t.id, forExternalId, status: "writing", origin, sentByUserId: origin === "request" ? by : null },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
  const finish = (data: Prisma.DmAiDraftUpdateInput) => prisma.dmAiDraft.update({ where: { id: draft.id }, data });

  if ("error" in chat) return finish({ status: "failed", reason: chat.error });
  if (!chat.lastIn) return finish({ status: "failed", reason: "They have not written yet, so there is nothing to answer" });
  if (origin === "request" && t.source === "native" && (!t.windowEndsAt || t.windowEndsAt <= now)) {
    return finish({ status: "failed", reason: "The 24 hour reply window closed" });
  }

  // A handoff rule: the team takes it, before the model sees a word.
  const rule = origin === "auto" ? dmAiHandoffMatch(chat.lastIn.text, settings) : null;
  if (rule) {
    await prisma.dmThread.update({ where: { id: t.id }, data: { aiHandoffAt: now, aiHandoffReason: rule.why } });
    return finish({ status: "handoff", reason: rule.why });
  }

  const channel = t.dmAccount.platform === "facebook" ? "Messenger" : "Instagram";
  const system = dmAiSystemPrompt(t.dmAccount.client.name, t.dmAccount.socialAccount.handle, settings, channel);
  const user = dmAiTranscript(t.contact.displayName ?? t.contact.handle, chat.lines);
  let w: AiWritten;
  try {
    w = await writer(system, user);
  } catch (e) {
    return finish({ status: "failed", reason: msg(e) });
  }
  const spend = { model: w.model, inputTokens: w.inputTokens, outputTokens: w.outputTokens, costCents: costCents(w.inputTokens, w.outputTokens) };
  const d = w.refused
    ? { action: "handoff" as const, bubbles: [], stage: t.contact.stage as never, note: "", reason: "The AI declined to answer this chat" }
    : readDmAiDecision(w.text, settings);

  if (d.action === "stop") return finish({ ...spend, status: "skipped", note: d.note || null, stage: d.stage, reason: d.reason ? `No reply needed: ${d.reason}` : "No reply needed" });
  if (d.action === "handoff") {
    if (origin === "auto") await prisma.dmThread.update({ where: { id: t.id }, data: { aiHandoffAt: now, aiHandoffReason: d.reason.slice(0, 120) } });
    return finish({ ...spend, status: "handoff", note: d.note || null, stage: d.stage, reason: d.reason });
  }
  // A reply. Autopilot queues it behind the delay; everything else waits for a person.
  const autopilot = origin === "auto" && settings.mode === "autopilot";
  return finish({
    ...spend,
    status: autopilot ? "queued" : "draft",
    bubbles: d.bubbles,
    note: d.note || null,
    stage: d.stage,
    reason: d.reason || null,
    sendAt: autopilot ? new Date(now.getTime() + dmAiDelayMs(settings)) : null,
  });
}

/** Autopilot replies whose delay has passed: re-checked now, then sent with the typing dots. */
export async function sendDueDrafts(now = new Date()): Promise<number> {
  const due = await prisma.dmAiDraft.findMany({ where: { status: "queued", sendAt: { lte: now } }, orderBy: { sendAt: "asc" }, take: 20, select: { id: true } });
  let sent = 0;
  for (const { id } of due) {
    // The lease: another tick seeing it now skips it.
    const took = await prisma.dmAiDraft.updateMany({ where: { id, status: "queued" }, data: { status: "sending" } });
    if (!took.count) continue;
    const d = await prisma.dmAiDraft.findUniqueOrThrow({ where: { id } });
    const t = await prisma.dmThread.findUnique({ where: { id: d.threadId }, include: threadInclude });
    if (!t) continue;
    const settings = dmAiSettingsOf(t.dmAccount.aiSettings as unknown as Record<string, unknown> | null);
    const finish = (data: Prisma.DmAiDraftUpdateInput) => prisma.dmAiDraft.update({ where: { id }, data });
    // They wrote again while it waited: this answer is stale; the next tick writes a fresh one.
    const newest = await prisma.dmMessage.findFirst({ where: { threadId: t.id, direction: "in" }, orderBy: [{ sentAt: "desc" }, { id: "desc" }], select: { externalId: true } });
    if (newest && newest.externalId !== d.forExternalId) {
      await finish({ status: "discarded", reason: "They wrote again before it went out" });
      continue;
    }
    const block = dmAiNoSend(await contextOf(t, settings, now, null));
    if (block) {
      await finish({ status: block.keep === "draft" ? "draft" : "skipped", reason: block.reason, sendAt: null });
      continue;
    }
    const token = tokenOf(t.dmAccount)!;
    const recipientId = t.contact.externalId;
    const mids: string[] = [];
    try {
      for (const [k, text] of d.bubbles.entries()) {
        if (settings.typing) {
          await igTyping(token, recipientId).catch(() => undefined);
          // About as long as a person takes to type it, at most 4 seconds a bubble.
          await pause(Math.min(4000, 600 + text.length * 35));
        } else if (k) await pause(800);
        const mid = await igSend(token, { recipientId, text });
        mids.push(mid);
        const at = new Date();
        await prisma.dmMessage.upsert({
          where: { threadId_externalId: { threadId: t.id, externalId: mid } },
          create: { threadId: t.id, externalId: mid, direction: "out", text, status: "sent", sentAt: at },
          update: {},
        });
      }
    } catch (e) {
      if (e instanceof InstagramError && e.tokenInvalid) await markRevoked(t.dmAccount, e.message);
      const windowClosed = e instanceof InstagramError && e.windowClosed;
      await finish({
        status: mids.length ? "sent" : windowClosed ? "skipped" : "failed",
        sentHow: mids.length ? "auto" : null,
        sentAt: mids.length ? now : null,
        messageExternalId: mids[0] ?? null,
        reason: `${mids.length ? `Sent ${mids.length} of ${d.bubbles.length}: ` : ""}${msg(e)}`,
      });
      continue;
    }
    const last = d.bubbles[d.bubbles.length - 1] ?? "";
    await prisma.dmThread.update({
      where: { id: t.id },
      data: { lastMessageAt: new Date(), lastPreview: previewOf(last, []), lastDirection: "out" },
    });
    if (d.stage && d.stage !== t.contact.stage) await prisma.dmContact.update({ where: { id: t.contactId }, data: { stage: d.stage } });
    await finish({ status: "sent", sentHow: "auto", sentAt: now, messageExternalId: mids[0] ?? null, reason: null });
    sent++;
  }
  return sent;
}

/** Native Instagram chats that went quiet on accounts with AI replies on. */
export async function draftQuietThreads(now = new Date()): Promise<number> {
  const threads = await prisma.dmThread.findMany({
    where: {
      source: "native",
      lastDirection: "in",
      status: { not: "done" },
      pausedAt: null,
      aiOff: false,
      aiHandoffAt: null,
      lastInboundAt: { lte: new Date(now.getTime() - DM_AI_QUIET_MS), gt: new Date(now.getTime() - DM_WINDOW_MS) },
      windowEndsAt: { gt: now },
      OR: [{ aiPausedUntil: null }, { aiPausedUntil: { lte: now } }],
      dmAccount: { transport: "native", status: "active", platform: "instagram", aiSettings: { is: { enabled: true } } },
    },
    orderBy: { lastInboundAt: "asc" },
    take: 25,
    select: { id: true },
  });
  let n = 0;
  for (const t of threads) {
    try {
      if (await draftThread(t.id, "auto", now)) n++;
    } catch (e) {
      console.error("[ai] draft", t.id, msg(e));
    }
  }
  return n;
}

/** One beat: send what is due first (it is older), then write for chats that went quiet. */
export async function aiTick(now = new Date()): Promise<void> {
  await sendDueDrafts(now);
  await draftQuietThreads(now);
}
