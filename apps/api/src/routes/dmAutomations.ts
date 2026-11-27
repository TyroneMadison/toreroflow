import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AUTOMATION_HOURLY_BUDGET,
  configOf,
  DM_CONFIG_KEYS,
  DM_TEMPLATE_INFO,
  dmAutomationCreateSchema,
  dmAutomationPatchSchema,
  dmAutomationPublishSchema,
  fillText,
  isPlatformPostId,
  matchEvent,
  overlapKeywords,
  pickVariant,
  publishProblems,
  templateConfig,
  TEST_CODE_MS,
  type DmAutomationConfig,
  type DmAutomationOverlap,
  type DmAutomationView,
  type DmCampaignRow,
  type DmRunView,
} from "@toreroflow/core";
import { getPrisma, Prisma, type DmAutomation } from "@toreroflow/db";
import { igRecentMedia, ZernioError, type CommentAutomation } from "@toreroflow/publishers";
import { actingUserId } from "../auth/actingUser";
import { dmWriteGuard } from "../dm/guard";
import { accountToken, dmSocialAccounts, nativeConfigured, ownedClient, transportOf, zernio, type DmSocial } from "../dm/service";
import { requireAuth } from "../plugins/requireAuth";

/**
 * DM automations (F4): the Automations list (native automations and the
 * Zernio campaigns beside them), the editor's save, publish and test, the
 * Instagram post picker, recent comments, the per-account kill switch and
 * Move to native. Reads for anyone signed in; every write is an operator's
 * (dmWriteGuard: viewers and bots get 403). The worker does the sending.
 */

const DAY = 24 * 3600_000;
const SPARK_DAYS = 8;

type Row = DmAutomation;

/** The working copy's config, as the columns hold it. */
const columnsConfig = (r: Row): DmAutomationConfig => configOf(r as unknown as Record<string, unknown>);

/** A config as columns to write. */
function toColumns(c: Partial<DmAutomationConfig>): Prisma.DmAutomationUncheckedUpdateInput {
  const out: Record<string, unknown> = {};
  for (const k of DM_CONFIG_KEYS) if (c[k] !== undefined) out[k] = c[k];
  if (c.steps) out.steps = c.steps as unknown as Prisma.InputJsonValue;
  return out as Prisma.DmAutomationUncheckedUpdateInput;
}

const same = (a: DmAutomationConfig, b: DmAutomationConfig) => JSON.stringify(a) === JSON.stringify(b);

function waitingReason(r: Row, s: DmSocial | undefined): string | null {
  if (r.status !== "live") return null;
  if (!s) return "The account is gone";
  if (s.platform === "facebook") return "Messenger automations run at Zernio";
  if (transportOf(s) !== "native") return "Waits for Instagram to connect through Torerone's Meta app";
  if (s.dmAccount?.status !== "active") return "Reconnect Instagram to keep it running";
  if (s.dmAccount.automationsPausedAt) return "Automations are paused for this account";
  return null;
}

function view(r: Row, s: DmSocial | undefined, spark: number[]): DmAutomationView {
  const config = columnsConfig(r);
  const live = r.published ? configOf(r.published as Record<string, unknown>) : null;
  const tracked = !!config.steps[0]?.button && config.trackLinks;
  return {
    id: r.id,
    source: "native",
    name: r.name,
    status: r.status === "live" || r.status === "paused" ? r.status : "draft",
    folder: r.folder,
    socialAccountId: r.socialAccountId,
    accountHandle: s?.handle ?? "",
    platform: s?.platform === "facebook" ? "facebook" : "instagram",
    config,
    hasUnpublished: !!live && !same(live, config),
    publishedAt: r.publishedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    deletedAt: r.deletedAt?.toISOString() ?? null,
    stats: {
      runs: r.runCount,
      sent: r.sentCount,
      failed: r.failedCount,
      clicks: r.clickCount,
      ctr: tracked && r.sentCount > 0 ? r.clickCount / r.sentCount : null,
    },
    spark,
    waiting: waitingReason(r, s),
    testCode: r.testCodeExpiresAt && r.testCodeExpiresAt > new Date() ? r.testCode : null,
    testCodeExpiresAt: r.testCodeExpiresAt && r.testCodeExpiresAt > new Date() ? r.testCodeExpiresAt.toISOString() : null,
    lastTestAt: r.lastTestAt?.toISOString() ?? null,
  };
}

/** Zernio campaigns as list rows, mapped to our accounts. */
function campaignRow(c: CommentAutomation, socials: DmSocial[]): DmCampaignRow {
  const s = socials.find((x) => x.providerAccountId && x.providerAccountId === c.accountId);
  const sent = c.stats.dmsSent;
  return {
    id: c.id,
    source: "zernio",
    name: c.name,
    platform: c.platform,
    trigger: c.trigger,
    socialAccountId: s?.id ?? null,
    accountHandle: s?.handle ?? null,
    isActive: c.isActive,
    keywords: c.keywords,
    matchMode: c.matchMode,
    postId: c.platformPostId,
    postTitle: c.postTitle,
    dmMessage: c.dmMessage,
    stats: {
      runs: c.stats.triggered,
      sent,
      failed: c.stats.dmsFailed,
      clicks: c.stats.linkClicks,
      ctr: c.linkTracking && (c.stats.trackedSends || sent) > 0 ? c.stats.linkClicks / (c.stats.trackedSends || sent) : null,
    },
    canMove: !!s && s.platform === "instagram" && transportOf(s) === "native" && s.dmAccount?.status === "active",
  };
}

const testSchema = z.object({
  kind: z.enum(["comment", "dm", "story_reply", "story_mention", "first_dm"]).default("comment"),
  text: z.string().max(1000).default(""),
  mediaId: z.string().max(40).nullable().optional(),
});

export async function dmAutomationRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  app.addHook("onRequest", dmWriteGuard);

  /** Runs per day for the sparklines, oldest first. */
  async function sparks(ids: string[], now = new Date()): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!ids.length) return out;
    const start = new Date(now.getTime() - (SPARK_DAYS - 1) * DAY);
    start.setUTCHours(0, 0, 0, 0);
    const rows = await prisma.dmAutomationRun.findMany({
      where: { automationId: { in: ids }, test: false, status: { in: ["sent", "gated", "failed", "dry_run"] }, createdAt: { gte: start } },
      select: { automationId: true, createdAt: true },
      take: 20000,
    });
    for (const r of rows) {
      const list = out.get(r.automationId!) ?? new Array(SPARK_DAYS).fill(0);
      const i = Math.min(SPARK_DAYS - 1, Math.floor((r.createdAt.getTime() - start.getTime()) / DAY));
      list[i]++;
      out.set(r.automationId!, list);
    }
    return out;
  }

  async function zernioCampaigns(client: { providerProfileId: string | null }, socials: DmSocial[]): Promise<{ rows: DmCampaignRow[]; warning: string | null }> {
    const zz = zernio();
    if (!zz || !client.providerProfileId) return { rows: [], warning: null };
    try {
      return { rows: (await zz.listCommentAutomations(client.providerProfileId)).map((c) => campaignRow(c, socials)), warning: null };
    } catch (e) {
      return { rows: [], warning: `Zernio campaigns could not be read: ${e instanceof Error ? e.message : "request failed"}` };
    }
  }

  function overlapsOf(rows: Row[], campaigns: DmCampaignRow[]): DmAutomationOverlap[] {
    const out: DmAutomationOverlap[] = [];
    for (const r of rows) {
      if (r.deletedAt || r.status === "paused") continue;
      for (const c of campaigns) {
        if (!c.isActive) continue;
        const both = overlapKeywords({ socialAccountId: r.socialAccountId, config: columnsConfig(r) }, c);
        if (both) out.push({ automationId: r.id, campaignId: c.id, campaignName: c.name, keywords: both });
      }
    }
    return out;
  }

  /** The automation, if the caller's agency owns it. */
  const owned = (clientId: string, agencyId: string, id: string) =>
    prisma.dmAutomation.findFirst({ where: { id, clientId, client: { agencyId, deletedAt: null } } });

  async function single(r: Row) {
    const socials = await dmSocialAccounts(r.clientId);
    const spark = (await sparks([r.id])).get(r.id) ?? new Array(SPARK_DAYS).fill(0);
    return view(r, socials.find((s) => s.id === r.socialAccountId), spark);
  }

  app.get<{ Params: { id: string }; Querystring: { trash?: string } }>("/clients/:id/dm/automations", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const socials = await dmSocialAccounts(client.id);
    const trash = request.query.trash === "1";
    const [rows, trashCount] = await Promise.all([
      prisma.dmAutomation.findMany({ where: { clientId: client.id, deletedAt: trash ? { not: null } : null }, orderBy: { createdAt: "asc" } }),
      prisma.dmAutomation.count({ where: { clientId: client.id, deletedAt: { not: null } } }),
    ]);
    const spark = await sparks(rows.map((r) => r.id));
    const { rows: campaigns, warning } = trash ? { rows: [], warning: null } : await zernioCampaigns(client, socials);
    const nativeIds = socials.filter((s) => transportOf(s) === "native" && s.dmAccount).map((s) => s.dmAccount!.id);
    const sentLastHour = nativeIds.length
      ? await prisma.dmAutomationRun.count({ where: { dmAccountId: { in: nativeIds }, sentAt: { gt: new Date(Date.now() - 3600_000) } } })
      : 0;
    return {
      automations: rows.map((r) => view(r, socials.find((s) => s.id === r.socialAccountId), spark.get(r.id) ?? new Array(SPARK_DAYS).fill(0))),
      campaigns,
      overlaps: overlapsOf(rows, campaigns),
      accounts: socials.map((s) => ({
        accountId: s.id,
        platform: s.platform,
        handle: s.handle,
        transport: transportOf(s),
        native: transportOf(s) === "native" && s.dmAccount?.status === "active",
        state: transportOf(s) === "native" ? (s.dmAccount?.status ?? "active") : "zernio",
        paused: !!s.dmAccount?.automationsPausedAt,
      })),
      nativeConfigured: nativeConfigured(),
      zernioConfigured: !!zernio() && !!client.providerProfileId,
      sentLastHour,
      budget: AUTOMATION_HOURLY_BUDGET,
      trashCount,
      warnings: warning ? [warning] : [],
    };
  });

  app.post<{ Params: { id: string } }>("/clients/:id/dm/automations", async (request, reply) => {
    const body = dmAutomationCreateSchema.parse(request.body ?? {});
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const social = (await dmSocialAccounts(client.id)).find((s) => s.id === body.socialAccountId);
    if (!social) return reply.status(404).send({ error: "account not found" });
    const config = templateConfig(body.template);
    if (social.platform === "facebook" && config.trigger !== "comment") {
      return reply.status(400).send({ error: "Messenger automations run at Zernio and answer comments only.", reason: "messenger_comments_only" });
    }
    const row = await prisma.dmAutomation.create({
      data: {
        clientId: client.id,
        socialAccountId: social.id,
        name: body.name ?? DM_TEMPLATE_INFO[body.template].name,
        folder: body.folder ?? null,
        createdById: await actingUserId(request),
        ...(toColumns(config) as object),
        trigger: config.trigger,
      },
    });
    return reply.status(201).send({ automation: await single(row) });
  });

  /** The Instagram posts of one account, for the "Which posts" picker. Instagram only, never YouTube. */
  app.get<{ Params: { id: string }; Querystring: { accountId?: string } }>("/clients/:id/dm/automations/posts", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const social = (await dmSocialAccounts(client.id)).find((s) => s.id === request.query.accountId);
    if (!social) return reply.status(404).send({ error: "account not found" });
    if (social.platform !== "instagram") return reply.status(400).send({ error: "Only Instagram posts can scope an automation.", reason: "instagram_only" });
    const token = social.dmAccount && transportOf(social) === "native" ? accountToken(social.dmAccount) : null;
    if (token) {
      try {
        const media = await igRecentMedia(token, 24);
        return {
          source: "instagram",
          posts: media
            .filter((m) => isPlatformPostId("instagram", m.id))
            .map((m) => ({ id: m.id, caption: m.caption, thumbnail: m.thumbnail, permalink: m.permalink, at: m.at?.toISOString() ?? null, reel: m.productType === "REELS" || m.mediaType === "VIDEO" })),
        };
      } catch (e) {
        request.log.warn({ err: e instanceof Error ? e.message : e }, "instagram media list failed, using the catalogue");
      }
    }
    // The posts the app already knows for this account: ExternalVideo rows of THIS Instagram account only.
    const rows = await prisma.externalVideo.findMany({
      where: { socialAccountId: social.id, platform: "instagram" },
      orderBy: { publishedAt: "desc" },
      take: 24,
      select: { platformVideoId: true, title: true, thumbnailUrl: true, url: true, publishedAt: true, mediaType: true },
    });
    return {
      source: "catalogue",
      posts: rows
        .filter((r) => isPlatformPostId("instagram", r.platformVideoId))
        .map((r) => ({ id: r.platformVideoId, caption: r.title, thumbnail: r.thumbnailUrl, permalink: r.url, at: r.publishedAt.toISOString(), reel: r.mediaType === "video" })),
    };
  });

  /** Recent trigger events: the Recent comments card, or one automation's runs. */
  app.get<{ Params: { id: string }; Querystring: { accountId?: string; trigger?: string; automationId?: string; limit?: string } }>(
    "/clients/:id/dm/automations/runs",
    async (request, reply) => {
      const client = await ownedClient(request.params.id, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "client not found" });
      const q = request.query;
      const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
      const where: Prisma.DmAutomationRunWhereInput = {
        dmAccount: { clientId: client.id, ...(q.accountId ? { socialAccountId: q.accountId } : {}) },
        ...(q.trigger ? { trigger: q.trigger } : {}),
        ...(q.automationId ? { automationId: q.automationId } : {}),
      };
      const [rows, total] = await Promise.all([
        prisma.dmAutomationRun.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, include: { automation: { select: { name: true } } } }),
        prisma.dmAutomationRun.count({ where }),
      ]);
      const runs: DmRunView[] = rows.map((r) => ({
        id: r.id,
        automationId: r.automationId,
        automationName: r.automation?.name ?? null,
        trigger: r.trigger,
        username: r.username,
        text: r.text,
        status: r.status,
        reason: r.reason,
        test: r.test,
        createdAt: r.createdAt.toISOString(),
        sentAt: r.sentAt?.toISOString() ?? null,
      }));
      return { runs, total };
    },
  );

  /** The per-account kill switch: nothing on the account sends while it is on. */
  app.post<{ Params: { id: string } }>("/clients/:id/dm/automations/kill", async (request, reply) => {
    const body = z.object({ accountId: z.string().min(1), paused: z.boolean() }).strict().parse(request.body ?? {});
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const social = (await dmSocialAccounts(client.id)).find((s) => s.id === body.accountId);
    if (!social) return reply.status(404).send({ error: "account not found" });
    const at = body.paused ? new Date() : null;
    await prisma.dmAccount.upsert({
      where: { socialAccountId: social.id },
      create: { clientId: client.id, socialAccountId: social.id, platform: social.platform, transport: "zernio", username: social.handle, automationsPausedAt: at },
      update: { automationsPausedAt: at },
    });
    return { ok: true, paused: body.paused };
  });

  /** Move to native: a Zernio campaign recreated here as a draft, on an account connected through our Meta app. */
  app.post<{ Params: { id: string } }>("/clients/:id/dm/automations/move", async (request, reply) => {
    const body = z.object({ campaignId: z.string().min(1).max(100) }).strict().parse(request.body ?? {});
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const zz = zernio();
    if (!zz || !client.providerProfileId) return reply.status(400).send({ error: "Zernio is not connected for this client." });
    const socials = await dmSocialAccounts(client.id);
    let list: CommentAutomation[];
    try {
      list = await zz.listCommentAutomations(client.providerProfileId);
    } catch (e) {
      if (e instanceof ZernioError) return reply.status(502).send({ error: `Zernio: ${e.message}` });
      throw e;
    }
    const c = list.find((x) => x.id === body.campaignId);
    if (!c) return reply.status(404).send({ error: "campaign not found" });
    const row = campaignRow(c, socials);
    const social = socials.find((s) => s.id === row.socialAccountId);
    if (!social) return reply.status(404).send({ error: "The campaign's account is not in this brand anymore." });
    if (c.platform === "facebook") return reply.status(400).send({ error: "Messenger campaigns stay at Zernio.", reason: "messenger_stays" });
    if (!row.canMove) {
      return reply.status(409).send({ error: `Connect @${social.handle} through Torerone's Meta app first. Until then the campaign keeps running at Zernio.`, reason: "connect_instagram" });
    }
    const button = c.buttons.find((b) => b.type === "url" && b.url);
    const config: DmAutomationConfig = {
      ...templateConfig("blank"),
      trigger: c.trigger === "story_reply" ? "story_reply" : "comment",
      keywords: c.keywords.slice(0, 20),
      matchMode: c.matchMode,
      excludeKeywords: c.excludeKeywords.slice(0, 20),
      scope: c.platformPostId && isPlatformPostId("instagram", c.platformPostId) ? "posts" : "all",
      postIds: c.platformPostId && isPlatformPostId("instagram", c.platformPostId) ? [c.platformPostId] : [],
      steps: [{ type: "message", text: c.dmMessage.slice(0, 1000), button: button ? { title: (button.title ?? "Open").slice(0, 20), url: button.url! } : null }],
      publicReplyOn: !!c.commentReply,
      publicReplies: c.commentReply ? [c.commentReply.slice(0, 300)] : [],
      alsoDmKeyword: c.alsoMatchInDms,
      trackLinks: c.linkTracking,
    };
    const created = await prisma.dmAutomation.create({
      data: {
        clientId: client.id,
        socialAccountId: social.id,
        name: c.name.slice(0, 120),
        createdById: await actingUserId(request),
        ...(toColumns(config) as object),
        trigger: config.trigger,
      },
    });
    return reply.status(201).send({ automation: await single(created), campaignId: c.id });
  });

  app.get<{ Params: { id: string; aid: string } }>("/clients/:id/dm/automations/:aid", async (request, reply) => {
    const r = await owned(request.params.id, request.user.agencyId, request.params.aid);
    if (!r) return reply.status(404).send({ error: "automation not found" });
    const socials = await dmSocialAccounts(r.clientId);
    const client = await ownedClient(r.clientId, request.user.agencyId);
    const { rows: campaigns } = client ? await zernioCampaigns(client, socials) : { rows: [] };
    return { automation: await single(r), overlaps: overlapsOf([r], campaigns), problems: publishProblems(columnsConfig(r)) };
  });

  app.patch<{ Params: { id: string; aid: string } }>("/clients/:id/dm/automations/:aid", async (request, reply) => {
    const body = dmAutomationPatchSchema.parse(request.body ?? {});
    const r = await owned(request.params.id, request.user.agencyId, request.params.aid);
    if (!r || r.deletedAt) return reply.status(404).send({ error: "automation not found" });
    const socials = await dmSocialAccounts(r.clientId);
    const moving = body.socialAccountId && body.socialAccountId !== r.socialAccountId;
    if (moving && r.status !== "draft") {
      return reply.status(409).send({ error: "A published automation stays on its account. Duplicate it, then change the copy.", reason: "account_locked" });
    }
    const social = socials.find((s) => s.id === (moving ? body.socialAccountId : r.socialAccountId));
    if (moving && !social) return reply.status(404).send({ error: "account not found" });
    const trigger = body.trigger ?? r.trigger;
    if (social?.platform === "facebook" && trigger !== "comment") {
      return reply.status(400).send({ error: "Messenger automations run at Zernio and answer comments only.", reason: "messenger_comments_only" });
    }
    const { name, folder, socialAccountId: _account, ...config } = body;
    const updated = await prisma.dmAutomation.update({
      where: { id: r.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(folder !== undefined ? { folder: folder || null } : {}),
        // The picked posts belong to the old account.
        ...(moving ? { socialAccountId: social!.id, postIds: config.postIds ?? [], scope: config.scope ?? (r.scope === "posts" ? "all" : r.scope) } : {}),
        ...toColumns(config),
      },
    });
    return { automation: await single(updated), problems: publishProblems(columnsConfig(updated)) };
  });

  /**
   * Publish: the working copy becomes what people get. Native by default.
   * engine "zernio" (and every Messenger account) turns it into a Zernio
   * campaign instead, for an account not connected through our Meta app yet;
   * the draft here is then removed, the campaign carries on in the list.
   * Overlapping Zernio campaigns are paused only when named in pauseCampaignIds.
   */
  app.post<{ Params: { id: string; aid: string } }>("/clients/:id/dm/automations/:aid/publish", async (request, reply) => {
    const body = dmAutomationPublishSchema.parse(request.body ?? {});
    const r = await owned(request.params.id, request.user.agencyId, request.params.aid);
    if (!r || r.deletedAt) return reply.status(404).send({ error: "automation not found" });
    const client = await ownedClient(r.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const cfg = columnsConfig(r);
    const problems = publishProblems(cfg);
    if (problems.length) return reply.status(400).send({ error: problems.join(" "), problems, reason: "incomplete" });
    const socials = await dmSocialAccounts(r.clientId);
    const social = socials.find((s) => s.id === r.socialAccountId);
    if (!social) return reply.status(404).send({ error: "account not found" });
    const zz = zernio();

    if (social.platform === "facebook" || body.engine === "zernio") {
      const why =
        cfg.trigger !== "comment" ? "Zernio only answers comments."
        : cfg.matchMode === "any" ? "Zernio needs at least one keyword."
        : cfg.scope === "next" ? "Zernio cannot wait for the next post. Pick the post, or Any post."
        : cfg.postIds.length > 1 ? "Zernio takes one post at most."
        : /\{(first_name|username)\}/.test(cfg.steps[0]?.text ?? "") ? "Zernio cannot fill {first_name} or {username}. Take them out of the message."
        : null;
      if (why) return reply.status(400).send({ error: why, reason: "zernio_cannot" });
      if (!zz || !client.providerProfileId || !social.providerAccountId) {
        return reply.status(409).send({ error: "Zernio is not connected for this account.", reason: "zernio_unavailable" });
      }
      const step = cfg.steps[0]!;
      try {
        const campaign = await zz.createCommentAutomation({
          profileId: client.providerProfileId,
          accountId: social.providerAccountId,
          name: r.name,
          dmMessage: step.text.trim(),
          keywords: cfg.keywords,
          matchMode: cfg.matchMode === "any" ? "contains" : cfg.matchMode,
          excludeKeywords: cfg.excludeKeywords,
          ...(cfg.scope === "posts" && cfg.postIds[0] ? { platformPostId: cfg.postIds[0] } : {}),
          ...(step.button ? { buttons: [{ type: "url", title: step.button.title, url: step.button.url }] } : {}),
          ...(cfg.publicReplyOn && cfg.publicReplies[0] ? { commentReply: cfg.publicReplies[0] } : {}),
          alsoMatchInDms: cfg.alsoDmKeyword,
          linkTracking: cfg.trackLinks,
        });
        await prisma.dmAutomation.delete({ where: { id: r.id } });
        return { movedTo: "zernio", campaignId: campaign.id };
      } catch (e) {
        if (e instanceof ZernioError) return reply.status(502).send({ error: `Zernio: ${e.message}` });
        throw e;
      }
    }

    // Pause the overlapping Zernio campaigns the operator named, and only those.
    if (body.pauseCampaignIds?.length) {
      if (!zz || !client.providerProfileId) return reply.status(400).send({ error: "Zernio is not connected for this client." });
      const mine = new Set((await zz.listCommentAutomations(client.providerProfileId)).map((c) => c.id));
      for (const id of body.pauseCampaignIds) {
        if (!mine.has(id)) return reply.status(404).send({ error: "campaign not found" });
        await zz.updateCommentAutomation(id, { isActive: false });
      }
    }
    const updated = await prisma.dmAutomation.update({
      where: { id: r.id },
      data: { status: "live", published: cfg as unknown as Prisma.InputJsonValue, publishedAt: new Date() },
    });
    return { automation: await single(updated) };
  });

  app.post<{ Params: { id: string; aid: string } }>("/clients/:id/dm/automations/:aid/status", async (request, reply) => {
    const body = z.object({ status: z.enum(["live", "paused"]) }).strict().parse(request.body ?? {});
    const r = await owned(request.params.id, request.user.agencyId, request.params.aid);
    if (!r || r.deletedAt) return reply.status(404).send({ error: "automation not found" });
    if (body.status === "live" && !r.published) return reply.status(409).send({ error: "Publish it first.", reason: "not_published" });
    const updated = await prisma.dmAutomation.update({ where: { id: r.id }, data: { status: body.status } });
    return { automation: await single(updated) };
  });

  app.post<{ Params: { id: string; aid: string } }>("/clients/:id/dm/automations/:aid/duplicate", async (request, reply) => {
    const r = await owned(request.params.id, request.user.agencyId, request.params.aid);
    if (!r || r.deletedAt) return reply.status(404).send({ error: "automation not found" });
    const cfg = columnsConfig(r);
    const copy = await prisma.dmAutomation.create({
      data: {
        clientId: r.clientId,
        socialAccountId: r.socialAccountId,
        name: `${r.name} (copy)`.slice(0, 120),
        folder: r.folder,
        createdById: await actingUserId(request),
        ...(toColumns(cfg) as object),
        trigger: cfg.trigger,
      },
    });
    return reply.status(201).send({ automation: await single(copy) });
  });

  /** Delete: to the trash, stopped. Restore brings it back paused (or a draft). */
  app.delete<{ Params: { id: string; aid: string } }>("/clients/:id/dm/automations/:aid", async (request, reply) => {
    const r = await owned(request.params.id, request.user.agencyId, request.params.aid);
    if (!r) return reply.status(404).send({ error: "automation not found" });
    await prisma.dmAutomation.update({ where: { id: r.id }, data: { deletedAt: new Date(), ...(r.status === "live" ? { status: "paused" } : {}) } });
    return { ok: true };
  });

  app.post<{ Params: { id: string; aid: string } }>("/clients/:id/dm/automations/:aid/restore", async (request, reply) => {
    const r = await owned(request.params.id, request.user.agencyId, request.params.aid);
    if (!r) return reply.status(404).send({ error: "automation not found" });
    const updated = await prisma.dmAutomation.update({ where: { id: r.id }, data: { deletedAt: null } });
    return { automation: await single(updated) };
  });

  /** Test it, as a dry run: the matcher on a sample comment or DM, and what would go out. Nothing is sent or saved. */
  app.post<{ Params: { id: string; aid: string } }>("/clients/:id/dm/automations/:aid/test", async (request, reply) => {
    const body = testSchema.parse(request.body ?? {});
    const r = await owned(request.params.id, request.user.agencyId, request.params.aid);
    if (!r) return reply.status(404).send({ error: "automation not found" });
    const cfg = columnsConfig(r);
    const at = new Date();
    const result =
      body.kind === "comment"
        ? matchEvent(cfg, { kind: "comment", text: body.text, mediaId: body.mediaId ?? cfg.postIds[0] ?? null, at })
        : matchEvent(cfg, {
            kind: "message",
            text: body.text,
            storyReply: body.kind === "story_reply",
            storyMention: body.kind === "story_mention",
            firstMessage: body.kind === "first_dm",
            at,
          });
    const step = cfg.steps[0];
    return {
      matched: result.ok,
      keyword: result.ok ? result.keyword : null,
      reason: result.ok ? null : result.reason,
      wouldSend: result.ok
        ? {
            text: fillText(step?.text ?? "", { name: "Maya Rivera", username: "maya.sample" }),
            button: step?.button ?? null,
            privateReply: body.kind === "comment",
            publicReply: body.kind === "comment" && cfg.publicReplyOn ? pickVariant(cfg.publicReplies) : null,
            followersOnly: cfg.followersOnly,
          }
        : null,
      problems: publishProblems(cfg),
    };
  });

  /** A three digit code: whoever DMs it to the account gets the working copy (the worker runs it). */
  app.post<{ Params: { id: string; aid: string } }>("/clients/:id/dm/automations/:aid/test-code", async (request, reply) => {
    const r = await owned(request.params.id, request.user.agencyId, request.params.aid);
    if (!r || r.deletedAt) return reply.status(404).send({ error: "automation not found" });
    const taken = new Set(
      (
        await prisma.dmAutomation.findMany({
          where: { socialAccountId: r.socialAccountId, testCode: { not: null }, testCodeExpiresAt: { gt: new Date() }, id: { not: r.id } },
          select: { testCode: true },
        })
      ).map((x) => x.testCode),
    );
    let code = "";
    for (let i = 0; i < 60 && (!code || taken.has(code)); i++) code = String(100 + Math.floor(Math.random() * 900));
    if (taken.has(code)) return reply.status(503).send({ error: "No free test code right now. Try again in a few minutes." });
    const expiresAt = new Date(Date.now() + TEST_CODE_MS);
    // The unique index is per account; a stale code elsewhere on it is cleared first.
    await prisma.dmAutomation.updateMany({ where: { socialAccountId: r.socialAccountId, testCode: code, id: { not: r.id } }, data: { testCode: null, testCodeExpiresAt: null } });
    await prisma.dmAutomation.update({ where: { id: r.id }, data: { testCode: code, testCodeExpiresAt: expiresAt } });
    const social = (await dmSocialAccounts(r.clientId)).find((s) => s.id === r.socialAccountId);
    const ready = !!social && transportOf(social) === "native" && social.dmAccount?.status === "active";
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      ready,
      note: ready ? null : "This account is not connected through Torerone's Meta app yet, so the code does nothing until it is.",
    };
  });
}

/**
 * GET /dm/l/<run id>: a tracked button link. Counts the open (once per run for
 * the automation's Link opens), then sends the person on. Only ever redirects
 * to the link stored on that run, so it is not an open redirect.
 */
export async function publicAutomationRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.get<{ Params: { runId: string } }>("/dm/l/:runId", async (request, reply) => {
    const run = await prisma.dmAutomationRun.findUnique({
      where: { id: request.params.runId },
      select: { id: true, linkUrl: true, clicks: true, automationId: true, test: true },
    });
    if (!run?.linkUrl || !run.linkUrl.startsWith("https://")) return reply.status(404).type("text/plain").send("This link is not available.");
    await prisma.dmAutomationRun.update({ where: { id: run.id }, data: { clicks: { increment: 1 }, ...(run.clicks === 0 ? { clickedAt: new Date() } : {}) } });
    if (run.clicks === 0 && run.automationId && !run.test) {
      await prisma.dmAutomation.update({ where: { id: run.automationId }, data: { clickCount: { increment: 1 } } }).catch(() => undefined);
    }
    return reply.header("cache-control", "no-store").redirect(run.linkUrl, 302);
  });
}
