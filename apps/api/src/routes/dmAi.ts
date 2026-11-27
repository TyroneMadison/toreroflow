import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  computeDmMetrics,
  DM_AI_DECISION_SCHEMA,
  DM_AI_WAITING_MS,
  DM_METRIC_RANGES,
  DM_STAGES,
  dmAiHandoffMatch,
  dmAiSettingsOf,
  dmAiSettingsPatchSchema,
  dmAiSystemPrompt,
  dmAiTranscript,
  dmMetricsWindow,
  driveRunState,
  readDmAiDecision,
  readDriveSource,
  type DmAiAccountView,
  type DmAiDraftView,
  type DmAiOverview,
  type DmAiQueueRow,
  type DmMetricRange,
  type DmStage,
} from "@toreroflow/core";
import { enqueue, getPrisma, Prisma, type DmAiDraft } from "@toreroflow/db";
import { actingUserId } from "../auth/actingUser";
import { dmWriteGuard } from "../dm/guard";
import { dmSocialAccounts, ownedClient, threadInclude, threadView, transportOf, type DmSocial } from "../dm/service";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

/**
 * AI replies and Metrics (F5).
 *
 * /clients/:id/dm/ai: the AI replies page (settings per account, the Needs
 * you queue, the period's numbers, the never-reply list), the per-account
 * settings, the agency kill switch, Try a test message, a draft on request and
 * the per-chat switch. /clients/:id/dm/metrics: the Metrics page, computed
 * from the Dm* rows (core computeDmMetrics). /clients/:id/dm/summary: the
 * Workflows rail's counts. Reads for anyone signed in; every write is an
 * operator's (dmWriteGuard: viewers and every bot get 403). AI replies are OFF
 * for an account until one of these PUTs turns them on.
 */

/** The agency kill switch for AI sending (the worker reads the same row). */
const KILL_KEY = "dm_ai_kill";
const DAY = 24 * 3600_000;

const toggleSchema = z.object({ off: z.boolean().optional(), resume: z.literal(true).optional() }).strict();
const killSchema = z.object({ stopped: z.boolean() }).strict();
const testSchema = z.object({ accountId: z.string().min(1).max(40), text: z.string().trim().min(1).max(1000) }).strict();

export function draftView(d: DmAiDraft): DmAiDraftView {
  return {
    id: d.id,
    status: d.status,
    origin: d.origin,
    bubbles: d.bubbles,
    note: d.note,
    reason: d.reason,
    sendAt: d.sendAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

/** The model the repo writes captions and ideas with. */
async function writeOnce(system: string, user: string): Promise<{ text: string; refused: boolean }> {
  const r = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).messages.create({
    model: env.SUGGESTIONS_MODEL,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: DM_AI_DECISION_SCHEMA } },
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = r.content.find((b) => b.type === "text");
  return { text: block?.type === "text" ? block.text : "", refused: r.stop_reason === "refusal" };
}
let writer = writeOnce;
/** The check swaps the model. */
export const setTestWriter = (w: typeof writeOnce): void => {
  writer = w;
};

export async function dmAiRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  app.addHook("onRequest", dmWriteGuard);

  const killedAt = async (agencyId: string): Promise<Date | null> => {
    const row = await prisma.appSetting.findUnique({ where: { agencyId_key: { agencyId, key: KILL_KEY } } });
    const at = (row?.value as { at?: string } | null)?.at;
    return at ? new Date(at) : null;
  };

  const canAutopilot = (s: DmSocial) => s.platform === "instagram" && transportOf(s) === "native" && s.dmAccount?.status === "active";

  async function accountViews(socials: DmSocial[], now: Date): Promise<DmAiAccountView[]> {
    const ids = socials.map((s) => s.dmAccount?.id).filter((x): x is string => !!x);
    const [rows, sent] = await Promise.all([
      prisma.dmAiSettings.findMany({ where: { dmAccountId: { in: ids } } }),
      prisma.dmAiDraft.groupBy({ by: ["dmAccountId"], where: { dmAccountId: { in: ids }, status: "sent", sentHow: "auto", sentAt: { gt: new Date(now.getTime() - DAY) } }, _count: { _all: true } }),
    ]);
    return socials.map((s) => {
      const row = rows.find((r) => r.dmAccountId === s.dmAccount?.id) ?? null;
      return {
        accountId: s.id,
        platform: s.platform === "facebook" ? "facebook" : "instagram",
        handle: s.handle,
        transport: transportOf(s),
        canAutopilot: canAutopilot(s),
        settings: dmAiSettingsOf(row as unknown as Record<string, unknown> | null),
        updatedAt: row?.updatedAt.toISOString() ?? null,
        sentToday: sent.find((x) => x.dmAccountId === s.dmAccount?.id)?._count._all ?? 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // The AI replies page
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { range?: string } }>("/clients/:id/dm/ai", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const now = new Date();
    const socials = await dmSocialAccounts(client.id);
    const accounts = await accountViews(socials, now);
    const days = request.query.range === "today" ? 1 : request.query.range === "30" ? 30 : 7;
    const from = new Date(now.getTime() - days * DAY);
    if (days === 1) from.setTime(new Date(now).setUTCHours(0, 0, 0, 0));
    const monthFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const scope = { dmAccount: { clientId: client.id } };

    const [handoffs, waitingNative, waitingZernio, drafts, monthCost, stageGroups, friends, offs, killed] = await Promise.all([
      prisma.dmThread.findMany({ where: { ...scope, aiHandoffAt: { not: null }, status: { not: "done" } }, include: threadInclude, orderBy: { aiHandoffAt: "desc" }, take: 50 }),
      prisma.dmThread.findMany({
        where: { ...scope, source: "native", aiHandoffAt: null, status: { not: "done" }, lastDirection: "in", lastInboundAt: { lt: new Date(now.getTime() - DM_AI_WAITING_MS) }, windowEndsAt: { gt: now } },
        include: threadInclude,
        orderBy: { lastInboundAt: "asc" },
        take: 50,
      }),
      // Zernio threads carry no direction: an unread one past the wait counts as waiting.
      prisma.dmThread.findMany({
        where: { ...scope, source: "zernio", aiHandoffAt: null, status: { not: "done" }, unread: { gt: 0 }, lastMessageAt: { lt: new Date(now.getTime() - DM_AI_WAITING_MS), gt: new Date(now.getTime() - DAY) } },
        include: threadInclude,
        orderBy: { lastMessageAt: "asc" },
        take: 50,
      }),
      prisma.dmAiDraft.findMany({ where: { dmAccount: { clientId: client.id }, createdAt: { gte: from } }, select: { status: true, sentHow: true, costCents: true, threadId: true }, take: 20000 }),
      prisma.dmAiDraft.aggregate({ where: { dmAccount: { clientId: client.id }, createdAt: { gte: monthFrom } }, _sum: { costCents: true } }),
      prisma.dmContact.groupBy({ by: ["stage"], where: { dmAccount: { clientId: client.id } }, _count: { _all: true } }),
      prisma.dmContact.findMany({
        where: { dmAccount: { clientId: client.id }, tags: { some: { tag: { name: { equals: "friend", mode: "insensitive" } } } } },
        select: { id: true, displayName: true, handle: true, notes: true, tags: { select: { tag: { select: { name: true } } } }, dmAccount: { select: { platform: true } }, threads: { select: { id: true }, take: 1 } },
        take: 200,
      }),
      prisma.dmThread.findMany({ where: { ...scope, aiOff: true }, include: threadInclude, take: 200 }),
      killedAt(request.user.agencyId),
    ]);

    const row = (t: (typeof handoffs)[number], why: "waiting" | "handoff"): DmAiQueueRow => {
      const v = threadView(t);
      return {
        threadId: t.id,
        accountId: v.accountId,
        platform: v.platform,
        contact: v.contact,
        why,
        reason: why === "handoff" ? (t.aiHandoffReason ?? "Not sure of the answer") : "No answer yet",
        since: (why === "handoff" ? t.aiHandoffAt : (t.lastInboundAt ?? t.lastMessageAt))?.toISOString() ?? null,
        preview: t.lastPreview,
        paused: !!t.pausedAt,
        aiOff: t.aiOff,
      };
    };
    const waiting = [...waitingNative, ...waitingZernio].map((t) => row(t, "waiting")).sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
    const queue = [...waiting, ...handoffs.map((t) => row(t, "handoff"))];

    const sent = drafts.filter((d) => d.status === "sent");
    const stages = Object.fromEntries(DM_STAGES.map((s) => [s, 0])) as Record<DmStage, number>;
    for (const g of stageGroups) if (g.stage in stages) stages[g.stage as DmStage] = g._count._all;
    const out: DmAiOverview = {
      configured: !!env.ANTHROPIC_API_KEY,
      killedAt: killed?.toISOString() ?? null,
      timezone: env.BUSINESS_TIMEZONE,
      accounts,
      queue,
      counts: { all: queue.length, waiting: waiting.length, handoff: handoffs.length },
      period: { from: from.toISOString(), to: now.toISOString() },
      stats: {
        answered: new Set(sent.filter((d) => d.sentHow === "auto").map((d) => d.threadId)).size,
        handedOff: drafts.filter((d) => d.status === "handoff").length,
        drafts: drafts.filter((d) => ["draft", "queued", "sent", "discarded"].includes(d.status)).length,
        sentAsIs: sent.filter((d) => d.sentHow === "as_is").length,
        edited: sent.filter((d) => d.sentHow === "edited").length,
        autoSent: sent.filter((d) => d.sentHow === "auto").length,
        discarded: drafts.filter((d) => d.status === "discarded").length,
        costCents: drafts.reduce((a, d) => a + d.costCents, 0),
      },
      monthCostCents: monthCost._sum.costCents ?? 0,
      stages,
      never: {
        friends: friends.length,
        off: offs.length,
        list: [
          ...offs.map((t) => ({
            contactId: t.contactId,
            threadId: t.id,
            name: t.contact.displayName ?? t.contact.handle ?? "Someone",
            handle: t.contact.handle,
            platform: (t.dmAccount.platform === "facebook" ? "facebook" : "instagram") as "instagram" | "facebook",
            note: t.contact.notes,
            tags: t.contact.tags.map((x) => x.tag.name),
            via: "off" as const,
          })),
          ...friends.map((c) => ({
            contactId: c.id,
            threadId: c.threads[0]?.id ?? null,
            name: c.displayName ?? c.handle ?? "Someone",
            handle: c.handle,
            platform: (c.dmAccount.platform === "facebook" ? "facebook" : "instagram") as "instagram" | "facebook",
            note: c.notes,
            tags: c.tags.map((x) => x.tag.name),
            via: "friend" as const,
          })),
        ],
      },
    };
    return out;
  });

  /** One account's settings. Autopilot only where the AI can actually send: Instagram through our Meta app. */
  app.put<{ Params: { id: string; accountId: string } }>("/clients/:id/dm/ai/:accountId", async (request, reply) => {
    const patch = dmAiSettingsPatchSchema.parse(request.body ?? {});
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const socials = await dmSocialAccounts(client.id);
    const s = socials.find((x) => x.id === request.params.accountId);
    if (!s) return reply.status(404).send({ error: "account not found" });
    if (patch.mode === "autopilot" && !canAutopilot(s)) {
      return reply.status(400).send({
        error:
          s.platform === "facebook"
            ? "Messenger is reply only through Zernio, so the AI never sends there on its own. It can write drafts for you to send."
            : "Autopilot needs this Instagram account connected through Torerone's Meta app. Until then the AI writes drafts only.",
        reason: "autopilot_needs_native",
      });
    }
    // Messenger and Zernio Instagram get a DM row the first time anything hangs off them.
    const dm =
      s.dmAccount ??
      (await prisma.dmAccount.upsert({
        where: { socialAccountId: s.id },
        create: { clientId: client.id, socialAccountId: s.id, platform: s.platform, transport: "zernio", username: s.handle },
        update: {},
      }));
    const current = dmAiSettingsOf((await prisma.dmAiSettings.findUnique({ where: { dmAccountId: dm.id } })) as unknown as Record<string, unknown> | null);
    const min = patch.replyDelayMinSec ?? current.replyDelayMinSec;
    const max = patch.replyDelayMaxSec ?? current.replyDelayMaxSec;
    if (min > max) return reply.status(400).send({ error: "The shortest wait cannot be longer than the longest." });
    const userId = await actingUserId(request);
    const data = {
      ...patch,
      ...(patch.links ? { links: patch.links as unknown as Prisma.InputJsonValue } : {}),
      ...(patch.lessons ? { lessons: patch.lessons as unknown as Prisma.InputJsonValue } : {}),
      updatedById: userId,
    };
    await prisma.dmAiSettings.upsert({ where: { dmAccountId: dm.id }, create: { dmAccountId: dm.id, ...data }, update: data });
    // Turned off, or back to drafts: nothing already queued goes out on its own.
    if (patch.enabled === false || patch.mode === "drafts") {
      await prisma.dmAiDraft.updateMany({ where: { dmAccountId: dm.id, status: "queued" }, data: { status: "draft", sendAt: null, reason: "Autopilot was turned off: left as a draft" } });
    }
    const fresh = await dmSocialAccounts(client.id);
    return { account: (await accountViews(fresh.filter((x) => x.id === s.id), new Date()))[0] };
  });

  /** The agency's kill switch: no AI reply goes out on its own anywhere while it is on. Drafts keep coming. */
  app.post<{ Params: { id: string } }>("/clients/:id/dm/ai/kill", async (request, reply) => {
    const body = killSchema.parse(request.body ?? {});
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const agencyId = request.user.agencyId;
    if (body.stopped) {
      const value = { at: new Date().toISOString(), by: await actingUserId(request) };
      await prisma.appSetting.upsert({ where: { agencyId_key: { agencyId, key: KILL_KEY } }, create: { agencyId, key: KILL_KEY, value }, update: { value } });
    } else {
      await prisma.appSetting.deleteMany({ where: { agencyId, key: KILL_KEY } });
    }
    return { killedAt: (await killedAt(agencyId))?.toISOString() ?? null };
  });

  /** Try a test message: what the AI would answer, from the account's current settings. Nothing is sent or saved. */
  app.post<{ Params: { id: string } }>("/clients/:id/dm/ai/test", async (request, reply) => {
    const body = testSchema.parse(request.body ?? {});
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const s = (await dmSocialAccounts(client.id)).find((x) => x.id === body.accountId);
    if (!s) return reply.status(404).send({ error: "account not found" });
    if (!env.ANTHROPIC_API_KEY) return reply.status(503).send({ error: "The server has no ANTHROPIC_API_KEY, so the AI cannot write.", reason: "ai_not_configured" });
    const row = s.dmAccount ? await prisma.dmAiSettings.findUnique({ where: { dmAccountId: s.dmAccount.id } }) : null;
    const settings = dmAiSettingsOf(row as unknown as Record<string, unknown> | null);
    const rule = dmAiHandoffMatch(body.text, settings);
    if (rule) return { action: "handoff", bubbles: [], reason: rule.why, rule: true };
    const name = await prisma.client.findUnique({ where: { id: client.id }, select: { name: true } });
    try {
      const w = await writer(
        dmAiSystemPrompt(name?.name ?? "this brand", s.handle, settings, s.platform === "facebook" ? "Messenger" : "Instagram"),
        dmAiTranscript("Test", [{ direction: "in", text: body.text }]),
      );
      if (w.refused) return { action: "handoff", bubbles: [], reason: "The AI declined to answer this", rule: false };
      const d = readDmAiDecision(w.text, settings);
      return { action: d.action, bubbles: d.bubbles, reason: d.reason, note: d.note, rule: false };
    } catch (e) {
      return reply.status(502).send({ error: `The AI could not answer: ${e instanceof Error ? e.message : "request failed"}` });
    }
  });

  const ownedThread = (threadId: string, clientId: string, agencyId: string) =>
    prisma.dmThread.findFirst({ where: { id: threadId, dmAccount: { clientId, client: { agencyId, deletedAt: null } } }, include: threadInclude });

  /** The per-chat switch, and "Let the AI answer again" after a handoff or a pause. */
  app.post<{ Params: { id: string; threadId: string } }>("/clients/:id/dm/threads/:threadId/ai", async (request, reply) => {
    const body = toggleSchema.parse(request.body ?? {});
    const t = await ownedThread(request.params.threadId, request.params.id, request.user.agencyId);
    if (!t) return reply.status(404).send({ error: "thread not found" });
    const data: Prisma.DmThreadUpdateInput = body.resume
      ? { aiOff: false, aiHandoffAt: null, aiHandoffReason: null, aiPausedUntil: null }
      : body.off !== undefined
        ? { aiOff: body.off }
        : {};
    const fresh = await prisma.dmThread.update({ where: { id: t.id }, data, include: threadInclude });
    if (body.off) await prisma.dmAiDraft.updateMany({ where: { threadId: t.id, status: "queued" }, data: { status: "discarded", reason: "AI replies were turned off in this chat" } });
    return { thread: threadView(fresh) };
  });

  /** "Draft with AI": the worker writes it; the Inbox's poll shows it in the composer. Never sent. */
  app.post<{ Params: { id: string; threadId: string } }>("/clients/:id/dm/threads/:threadId/ai-draft", async (request, reply) => {
    const t = await ownedThread(request.params.threadId, request.params.id, request.user.agencyId);
    if (!t) return reply.status(404).send({ error: "thread not found" });
    const row = await prisma.dmAiSettings.findUnique({ where: { dmAccountId: t.dmAccountId } });
    if (!dmAiSettingsOf(row as unknown as Record<string, unknown> | null).enabled) {
      return reply.status(409).send({ error: "AI replies are off for this account. Turn them on in Workflows, AI replies.", reason: "ai_off" });
    }
    if (!env.ANTHROPIC_API_KEY) return reply.status(503).send({ error: "The server has no ANTHROPIC_API_KEY, so the AI cannot write.", reason: "ai_not_configured" });
    await enqueue("dm", { kind: "ai-draft", threadId: t.id, by: await actingUserId(request) });
    return reply.status(202).send({ queued: true });
  });

  app.post<{ Params: { id: string; draftId: string } }>("/clients/:id/dm/ai/drafts/:draftId/discard", async (request, reply) => {
    const d = await prisma.dmAiDraft.findFirst({
      where: { id: request.params.draftId, dmAccount: { clientId: request.params.id, client: { agencyId: request.user.agencyId, deletedAt: null } } },
    });
    if (!d) return reply.status(404).send({ error: "draft not found" });
    if (d.status === "draft" || d.status === "queued") {
      await prisma.dmAiDraft.update({ where: { id: d.id }, data: { status: "discarded", reason: "Discarded by the team", sendAt: null } });
    }
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { range?: string; accounts?: string } }>("/clients/:id/dm/metrics", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const now = new Date();
    const range: DmMetricRange = (DM_METRIC_RANGES as readonly string[]).includes(request.query.range ?? "") ? (request.query.range as DmMetricRange) : "7";
    const socials = await dmSocialAccounts(client.id);
    const pick = (request.query.accounts ?? "").split(",").filter(Boolean);
    const chosen = pick.length ? socials.filter((s) => pick.includes(s.id)) : socials;
    const dmIds = chosen.map((s) => s.dmAccount?.id).filter((x): x is string => !!x);
    const w = dmMetricsWindow(range, now);
    // ponytail: rows capped per query; a daily rollup table if a brand ever outgrows them.
    const CAP = 50000;
    const [messages, zernioThreads, contacts, runs, threads, drafts, automations] = await Promise.all([
      prisma.dmMessage.findMany({
        where: { thread: { dmAccountId: { in: dmIds } }, sentAt: { gte: w.earliest } },
        select: { sentAt: true, direction: true, status: true, threadId: true, attachments: true, thread: { select: { contact: { select: { externalId: true } } } } },
        orderBy: { sentAt: "asc" },
        take: CAP,
      }),
      prisma.dmThread.findMany({ where: { dmAccountId: { in: dmIds }, source: "zernio", lastMessageAt: { gte: w.earliest } }, select: { id: true, lastMessageAt: true }, take: CAP }),
      prisma.dmContact.findMany({ where: { dmAccountId: { in: dmIds }, createdAt: { gte: w.earliest } }, select: { createdAt: true }, take: CAP }),
      prisma.dmAutomationRun.findMany({
        where: { dmAccountId: { in: dmIds }, test: false, createdAt: { gte: w.earliest } },
        select: { createdAt: true, sentAt: true, status: true, trigger: true, automationId: true, contactExternalId: true, clicks: true, reason: true },
        take: CAP,
      }),
      prisma.dmThread.findMany({
        where: { dmAccountId: { in: dmIds }, createdAt: { gte: w.from } },
        select: { id: true, createdAt: true, dmAccount: { select: { platform: true } }, contact: { select: { externalId: true } } },
        take: CAP,
      }),
      prisma.dmAiDraft.findMany({ where: { dmAccountId: { in: dmIds }, createdAt: { gte: w.from } }, select: { createdAt: true, status: true, sentHow: true, costCents: true }, take: CAP }),
      prisma.dmAutomation.findMany({ where: { clientId: client.id }, select: { id: true, name: true, status: true } }),
    ]);
    // A thread's first message says what started it, when it is one we hold.
    const firstIn = new Map<string, string | null>();
    for (const m of messages) {
      if (m.direction !== "in" || firstIn.has(m.threadId)) continue;
      const types = (Array.isArray(m.attachments) ? m.attachments : []).map((p) => (p as { type?: string } | null)?.type);
      firstIn.set(m.threadId, types.includes("story_reply") ? "story_reply" : types.includes("story_mention") ? "story_mention" : "dm");
    }
    const view = computeDmMetrics({
      now,
      range,
      messages: messages.map((m) => ({ at: m.sentAt, dir: m.direction === "out" ? "out" : "in", contact: m.thread.contact.externalId, failed: m.status === "failed" })),
      zernioThreads: zernioThreads.map((t) => ({ id: t.id, at: t.lastMessageAt! })),
      contacts: contacts.map((c) => ({ at: c.createdAt })),
      runs: runs.map((r) => ({ at: r.createdAt, sentAt: r.sentAt, status: r.status, trigger: r.trigger, automationId: r.automationId, contact: r.contactExternalId, clicks: r.clicks, reason: r.reason })),
      threads: threads.map((t) => ({
        createdAt: t.createdAt,
        platform: t.dmAccount.platform === "facebook" ? "facebook" : "instagram",
        contact: t.contact.externalId,
        firstKind: (firstIn.get(t.id) ?? null) as "story_reply" | "story_mention" | "dm" | null,
      })),
      drafts: drafts.map((d) => ({ at: d.createdAt, status: d.status, sentHow: d.sentHow, costCents: d.costCents })),
      automations,
    });
    return {
      ...view,
      accounts: socials.map((s) => ({ accountId: s.id, platform: s.platform === "facebook" ? "facebook" : "instagram", handle: s.handle, transport: transportOf(s), chosen: chosen.includes(s) })),
      partial: chosen.some((s) => transportOf(s) === "zernio"),
    };
  });

  // -------------------------------------------------------------------------
  // The Workflows rail's counts
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/clients/:id/dm/summary", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const scope = { dmAccount: { clientId: client.id } };
    const [unread, live, contacts, ai, drive, rules] = await Promise.all([
      prisma.dmThread.aggregate({ where: scope, _sum: { unread: true } }),
      prisma.dmAutomation.count({ where: { clientId: client.id, status: "live", deletedAt: null } }),
      prisma.dmContact.count({ where: scope }),
      prisma.dmAiSettings.findMany({ where: { enabled: true, dmAccount: { clientId: client.id } }, select: { mode: true } }),
      prisma.client.findUnique({ where: { id: client.id }, select: { driveSource: true } }),
      prisma.workflow.count({ where: { clientId: client.id } }),
    ]);
    const run = driveRunState(readDriveSource(drive?.driveSource));
    return {
      unread: unread._sum.unread ?? 0,
      liveAutomations: live,
      contacts,
      ai: { on: ai.length, autopilot: ai.filter((a) => a.mode === "autopilot").length },
      autoPost: { tone: run.tone, label: run.tone === "off" ? "Off" : run.text.split(".")[0]! },
      fanoutRules: rules,
    };
  });

}
