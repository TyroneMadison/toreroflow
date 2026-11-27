import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { FastifyInstance } from "fastify";
import {
  dmContactBulkSchema,
  dmContactPatchSchema,
  dmReplySchema,
  dmThreadPatchSchema,
  DM_STAGES,
  DM_STATUSES,
  dmAiSettingsOf,
  replyWindow,
  type DmContactRow,
} from "@toreroflow/core";
import { encryptSecret, enqueue, getPrisma, Prisma, verifyFileLink } from "@toreroflow/db";
import {
  igAuthUrl,
  igExchangeCode,
  igMarkSeen,
  igMe,
  igMessage,
  igSend,
  igSubscribe,
  InstagramError,
  partsFromApi,
  previewOf,
  pullMedia,
  ZernioError,
  type IgAppCreds,
} from "@toreroflow/publishers";
import { actingUserId } from "../auth/actingUser";
import { dmWriteGuard } from "../dm/guard";
import { draftView } from "./dmAi";
import {
  accountToken,
  contactView,
  dmSocialAccounts,
  mediaLink,
  nativeConfigured,
  nativeMessageView,
  originOf,
  ownedClient,
  setContactTags,
  syncZernioThreads,
  threadInclude,
  threadView,
  transportOf,
  zernio,
  zernioHint,
  zernioMessageView,
} from "../dm/service";
import { env, missingMetaConfig } from "../env";
import { fileLink } from "../files/link";
import { signState, STATE_TTL_MS, verifyState } from "../oauth/state";
import { requireAuth } from "../plugins/requireAuth";
import { esc } from "../signatures/page";
import { resultPage } from "./oauth";

/**
 * DMs (F2): status, the Instagram connect, the unified inbox and contacts.
 *
 * Everything under requireAuth and dmWriteGuard: anyone signed in reads,
 * only an operator sends or changes. The two routes a browser reaches without
 * our token (the Instagram OAuth callback and the media proxy) are in
 * publicDmRoutes below, each with its own proof.
 */

const IG_CALLBACK_PATH = "/oauth/instagram/callback";

function igCreds(): IgAppCreds | null {
  if (!nativeConfigured()) return null;
  return {
    appId: env.META_IG_APP_ID,
    appSecret: env.META_IG_APP_SECRET,
    redirectUri: `${env.OAUTH_REDIRECT_BASE}${IG_CALLBACK_PATH}`,
  };
}

const NOT_CONFIGURED = {
  error: "Instagram DMs through Torerone's Meta app are not set up on this server yet. The inbox keeps working through Zernio.",
  reason: "instagram_not_configured",
} as const;

const PAGE = 30;

/** What their first message was, for the details pane's "Came from". */
function cameFrom(attachments: Prisma.JsonValue): string {
  const types = (Array.isArray(attachments) ? attachments : []).map((p) => (p as { type?: string } | null)?.type);
  if (types.includes("story_reply")) return "Story reply";
  if (types.includes("story_mention")) return "Story mention";
  return "Direct message";
}

/** Images Instagram takes in a DM, by what the browser says they are. */
const DM_IMAGE: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif" };
/** Instagram's own cap for an image in a DM. */
const DM_IMAGE_MAX = 8 * 1024 * 1024;

export async function dmRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  app.addHook("onRequest", dmWriteGuard);

  /** Which transport is active, per account, and what is missing. Names only, never values. */
  app.get<{ Querystring: { clientId?: string } }>("/dm/status", async (request, reply) => {
    const missing = missingMetaConfig();
    const [lastWebhook, lastBad] = await Promise.all([
      prisma.dmWebhookEvent.findFirst({ where: { signatureOk: true }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
      prisma.dmWebhookEvent.findFirst({ where: { signatureOk: false }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
    ]);
    let accounts: unknown[] = [];
    if (request.query.clientId) {
      const client = await ownedClient(request.query.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "client not found" });
      accounts = (await dmSocialAccounts(client.id)).map((s) => {
        const transport = transportOf(s);
        const dm = s.dmAccount;
        return {
          accountId: s.id,
          platform: s.platform,
          handle: s.handle,
          transport,
          /** native: active | revoked | error. zernio: whether Zernio can read it. */
          state:
            transport === "native"
              ? (dm?.status ?? "active")
              : s.providerAccountId && client.providerProfileId && zernio()
                ? "zernio"
                : "unavailable",
          error: dm?.error ?? null,
          tokenExpiresAt: dm?.tokenExpiresAt?.toISOString() ?? null,
          lastSyncAt: dm?.lastSyncAt?.toISOString() ?? null,
          /** Instagram can move to our own Meta app; Messenger stays on Zernio, reply only. */
          canConnect: s.platform === "instagram" && missing.length === 0,
          replyOnly: s.platform === "facebook",
        };
      });
    }
    return {
      native: {
        configured: missing.length === 0,
        missing,
        humanAgent: env.META_IG_HUMAN_AGENT,
        lastWebhookAt: lastWebhook?.receivedAt.toISOString() ?? null,
        lastBadSignatureAt: lastBad?.receivedAt.toISOString() ?? null,
      },
      zernio: { configured: zernio() !== null },
      accounts,
    };
  });

  /**
   * The consent link for one Instagram account, handed back rather than
   * redirected to: the client usually signs in, not the operator.
   */
  app.post<{ Params: { accountId: string } }>("/oauth/instagram/start/:accountId", async (request, reply) => {
    const creds = igCreds();
    if (!creds) return reply.status(503).send({ ...NOT_CONFIGURED, missing: missingMetaConfig() });
    const account = await prisma.socialAccount.findFirst({
      where: { id: request.params.accountId, deletedAt: null, client: { agencyId: request.user.agencyId, deletedAt: null } },
      select: { id: true, platform: true, handle: true },
    });
    if (!account) return reply.status(404).send({ error: "not found" });
    if (account.platform !== "instagram") {
      return reply.status(400).send({ error: "Only Instagram accounts connect through Torerone's Meta app. Messenger stays on Zernio." });
    }
    const state = signState({ agencyId: request.user.agencyId, socialAccountId: account.id }, env.JWT_SECRET);
    return {
      authUrl: igAuthUrl(creds, state),
      handle: account.handle,
      expiresInDays: Math.round(STATE_TTL_MS / (24 * 60 * 60 * 1000)),
    };
  });

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  app.get<{
    Params: { id: string };
    Querystring: {
      status?: string;
      stage?: string;
      tag?: string;
      search?: string;
      accountId?: string;
      /** instagram | facebook: the channel, across all of that platform's accounts. */
      platform?: string;
      /** 1: only paused threads; 0: only threads automations may answer. */
      paused?: string;
      /** 1: only threads with unread messages. */
      unread?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/clients/:id/dm/threads", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const q = request.query;
    const socials = (await dmSocialAccounts(client.id)).filter(
      (s) => (!q.accountId || s.id === q.accountId) && (!q.platform || s.platform === q.platform),
    );
    if (q.accountId && !socials.length) return reply.status(404).send({ error: "account not found" });
    const warnings = await syncZernioThreads(client, socials);

    const scope: Prisma.DmThreadWhereInput = {
      dmAccount: { clientId: client.id, socialAccountId: { in: socials.map((s) => s.id) } },
    };
    const contact: Prisma.DmContactWhereInput = {};
    if (q.stage && (DM_STAGES as readonly string[]).includes(q.stage)) contact.stage = q.stage;
    if (q.tag) contact.tags = { some: { tag: { name: q.tag } } };
    if (q.search?.trim()) {
      const s = q.search.trim().replace(/^@/, "");
      contact.OR = [
        { displayName: { contains: s, mode: "insensitive" } },
        { handle: { contains: s, mode: "insensitive" } },
      ];
    }
    const where: Prisma.DmThreadWhereInput = {
      ...scope,
      ...(Object.keys(contact).length ? { contact } : {}),
      ...(q.status && (DM_STATUSES as readonly string[]).includes(q.status) ? { status: q.status } : {}),
      ...(q.paused === "1" ? { pausedAt: { not: null } } : q.paused === "0" ? { pausedAt: null } : {}),
      ...(q.unread === "1" ? { unread: { gt: 0 } } : {}),
    };
    const limit = Math.min(Math.max(Number(q.limit) || PAGE, 1), 100);
    const rows = await prisma.dmThread.findMany({
      where,
      include: threadInclude,
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const groups = await prisma.dmThread.groupBy({
      by: ["status"],
      where: { ...scope, ...(Object.keys(contact).length ? { contact } : {}) },
      _count: { _all: true },
      _sum: { unread: true },
    });
    const counts = { all: 0, open: 0, waiting: 0, done: 0, unread: 0, paused: 0 };
    for (const g of groups) {
      counts.all += g._count._all;
      if (g.status in counts) counts[g.status as "open" | "waiting" | "done"] += g._count._all;
      counts.unread += g._sum.unread ?? 0;
    }
    counts.paused = await prisma.dmThread.count({
      where: { ...scope, ...(Object.keys(contact).length ? { contact } : {}), pausedAt: { not: null } },
    });
    const page = rows.slice(0, limit);
    return {
      threads: page.map(threadView),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      counts,
      warnings,
    };
  });

  /** A thread the caller's agency owns, with what sending needs. */
  const ownedThread = (threadId: string, clientId: string, agencyId: string) =>
    prisma.dmThread.findFirst({
      where: { id: threadId, dmAccount: { clientId, client: { agencyId, deletedAt: null } } },
      include: {
        ...threadInclude,
        dmAccount: {
          include: { socialAccount: { select: { id: true, handle: true, providerAccountId: true } }, client: { select: { providerProfileId: true } } },
        },
      },
    });

  /**
   * The thread's AI side (F5): whether AI replies are on for its account, the
   * draft waiting in the composer (or what became of a draft someone just
   * asked for), and the AI's latest note about the person.
   */
  async function aiOfThread(threadId: string, dmAccountId: string) {
    const recent = new Date(Date.now() - 2 * 60_000);
    const [settings, draft, noted] = await Promise.all([
      prisma.dmAiSettings.findUnique({ where: { dmAccountId } }),
      prisma.dmAiDraft.findFirst({
        where: {
          threadId,
          OR: [
            { status: { in: ["draft", "queued"] } },
            { status: "writing", createdAt: { gt: recent } },
            { origin: "request", status: { in: ["failed", "handoff", "skipped"] }, updatedAt: { gt: recent } },
          ],
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.dmAiDraft.findFirst({ where: { threadId, note: { not: null } }, orderBy: { createdAt: "desc" }, select: { note: true } }),
    ]);
    const s = dmAiSettingsOf(settings as unknown as Record<string, unknown> | null);
    return { enabled: s.enabled, mode: s.mode, draft: draft ? draftView(draft) : null, note: noted?.note ?? null };
  }

  /**
   * A reply by the team (F5): the AI draft it came from counts as sent (as is
   * or edited), any other waiting draft is dropped, and with "Pause when your
   * team replies" on the AI waits in this chat for the hours set.
   */
  async function teamReplied(t: { id: string; dmAccountId: string }, text: string | null, draftId: string | undefined, userId: string | null, now: Date) {
    if (draftId) {
      const d = await prisma.dmAiDraft.findFirst({ where: { id: draftId, threadId: t.id, status: { in: ["draft", "queued"] } } });
      if (d) {
        const same = (text ?? "").trim() === d.bubbles.join("\n").trim();
        await prisma.dmAiDraft.update({ where: { id: d.id }, data: { status: "sent", sentHow: same ? "as_is" : "edited", sentAt: now, sentByUserId: userId, sendAt: null } });
        if (d.stage && (DM_STAGES as readonly string[]).includes(d.stage)) {
          await prisma.dmContact.updateMany({ where: { threads: { some: { id: t.id } } }, data: { stage: d.stage } });
        }
      }
    }
    await prisma.dmAiDraft.updateMany({ where: { threadId: t.id, status: { in: ["draft", "queued"] } }, data: { status: "discarded", reason: "The team replied", sendAt: null } });
    const s = dmAiSettingsOf((await prisma.dmAiSettings.findUnique({ where: { dmAccountId: t.dmAccountId } })) as unknown as Record<string, unknown> | null);
    if (s.enabled && s.pauseOnTeamReply) {
      // 0 hours: until someone presses "Let the AI answer again".
      const until = s.resumeAfterHours ? new Date(now.getTime() + s.resumeAfterHours * 3600_000) : new Date(Date.UTC(9999, 0, 1));
      await prisma.dmThread.update({ where: { id: t.id }, data: { aiPausedUntil: until } });
    }
  }

  app.get<{ Params: { id: string; threadId: string }; Querystring: { before?: string } }>(
    "/clients/:id/dm/threads/:threadId",
    async (request, reply) => {
      const t = await ownedThread(request.params.threadId, request.params.id, request.user.agencyId);
      if (!t) return reply.status(404).send({ error: "thread not found" });
      const origin = originOf(request);
      const firstSeenAt = t.contact.createdAt.toISOString();
      const ai = await aiOfThread(t.id, t.dmAccountId);
      if (t.source === "native") {
        const [rows, count, first] = await Promise.all([
          prisma.dmMessage.findMany({
            where: { threadId: t.id },
            orderBy: [{ sentAt: "desc" }, { id: "desc" }],
            take: 51,
            ...(request.query.before ? { cursor: { id: request.query.before }, skip: 1 } : {}),
          }),
          prisma.dmMessage.count({ where: { threadId: t.id } }),
          prisma.dmMessage.findFirst({ where: { threadId: t.id, direction: "in" }, orderBy: { sentAt: "asc" }, select: { attachments: true } }),
        ]);
        const page = rows.slice(0, 50);
        return {
          thread: threadView(t),
          messages: page.reverse().map((m) => nativeMessageView(origin, m)),
          nextCursor: rows.length > 50 ? page[0]!.id : null,
          activity: { messages: count, firstSeenAt, cameFrom: first ? cameFrom(first.attachments) : null },
          ai,
        };
      }
      const z = zernio();
      const providerAccountId = t.dmAccount.socialAccount.providerAccountId;
      if (!z || !t.externalId || !providerAccountId) {
        return reply.status(502).send({ error: "Zernio cannot read this conversation right now." });
      }
      try {
        const messages = await z.conversationMessages(t.externalId, providerAccountId);
        return {
          thread: threadView(t),
          messages: messages.map((m) => zernioMessageView(origin, t.dmAccount.socialAccount.id, t.externalId!, m)),
          nextCursor: null,
          activity: { messages: messages.length, firstSeenAt, cameFrom: null },
          ai,
        };
      } catch (e) {
        if (e instanceof ZernioError) return reply.status(502).send({ error: `Zernio: ${e.message}` });
        throw e;
      }
    },
  );

  /**
   * Reply in an existing thread. There is no "new conversation" route, for
   * either platform: Messenger through Zernio is reply-only, and Instagram
   * only lets a business answer someone who wrote first.
   */
  app.post<{ Params: { id: string; threadId: string } }>("/clients/:id/dm/threads/:threadId/reply", async (request, reply) => {
    const body = dmReplySchema.parse(request.body ?? {});
    const t = await ownedThread(request.params.threadId, request.params.id, request.user.agencyId);
    if (!t) return reply.status(404).send({ error: "thread not found" });
    const userId = await actingUserId(request);
    const now = new Date();

    if (t.source !== "native") {
      if (body.media) {
        return reply.status(400).send({ error: "Photos and files need the Instagram connection through Torerone's Meta app. Zernio threads take text only.", reason: "media_needs_native" });
      }
      const z = zernio();
      const providerAccountId = t.dmAccount.socialAccount.providerAccountId;
      if (!z || !t.externalId || !providerAccountId) return reply.status(502).send({ error: "Zernio cannot reach this conversation right now." });
      try {
        await z.sendMessage(t.externalId, { accountId: providerAccountId, message: body.text! });
      } catch (e) {
        if (e instanceof ZernioError) return reply.status(502).send({ error: `Zernio: ${e.message}` });
        throw e;
      }
      await prisma.dmThread.update({
        where: { id: t.id },
        data: { lastMessageAt: now, lastPreview: body.text!.slice(0, 200), lastDirection: "out", unread: 0, readAt: now },
      });
      await teamReplied(t, body.text ?? null, body.draftId, userId, now);
      return { ok: true, messages: [] };
    }

    const token = accountToken(t.dmAccount);
    if (!token) {
      return reply.status(409).send({ error: `Instagram stopped accepting replies for @${t.dmAccount.socialAccount.handle}. Reconnect the account first.`, reason: "reconnect" });
    }
    const window = replyWindow(t.lastInboundAt, now, env.META_IG_HUMAN_AGENT);
    if (!window.open) {
      return reply.status(409).send({
        error:
          window.reason === "never_messaged"
            ? "They have not messaged this account, so Instagram does not allow a reply yet."
            : `The reply window closed ${window.endsAt ? `on ${window.endsAt.toUTCString()}` : ""}. Instagram only accepts a reply within 24 hours of their last message${env.META_IG_HUMAN_AGENT ? " (7 days for a person answering)" : ""}.`.replace(" .", "."),
        reason: "window_closed",
        windowEndsAt: window.endsAt?.toISOString() ?? null,
      });
    }

    type Out = { text: string | null; media: typeof body.media | null };
    const record = (externalId: string, out: Out, status: "sent" | "failed", error: string | null) =>
      prisma.dmMessage.upsert({
        where: { threadId_externalId: { threadId: t.id, externalId } },
        create: {
          threadId: t.id,
          externalId,
          direction: "out",
          text: out.text,
          attachments: out.media ? [{ type: out.media.type, url: out.media.url }] : Prisma.JsonNull,
          replyToExternalId: out.text ? (body.replyTo ?? null) : null,
          status,
          error,
          sentByUserId: userId,
          sentAt: now,
        },
        // The echo got here first: keep its row, note who sent it.
        update: { sentByUserId: userId },
      });

    // Text and media are two messages on Instagram, so two rows: text first, as typed.
    const outs: Out[] = [
      ...(body.text ? [{ text: body.text, media: null }] : []),
      ...(body.media ? [{ text: null, media: body.media }] : []),
    ];
    const saved = [];
    try {
      const recipientId = t.contact.externalId;
      for (const out of outs) {
        const mid = await igSend(token, {
          recipientId,
          ...(out.text ? { text: out.text, replyTo: body.replyTo } : { media: out.media! }),
          tag: window.tag,
        });
        saved.push(await record(mid, out, "sent", null));
      }
      await prisma.dmThread.update({
        where: { id: t.id },
        data: {
          lastMessageAt: now,
          lastPreview: previewOf(body.text, body.media ? [{ type: body.media.type === "file" ? "file" : body.media.type }] : []),
          lastDirection: "out",
          unread: 0,
          readAt: now,
        },
      });
      await teamReplied(t, body.text ?? null, body.draftId, userId, now);
      const origin = originOf(request);
      return { ok: true, messages: saved.map((m) => nativeMessageView(origin, m)) };
    } catch (e) {
      if (!(e instanceof InstagramError)) throw e;
      // Kept as a failed bubble so the thread shows what did not go, and why.
      await record(`failed:${randomUUID()}`, outs[saved.length]!, "failed", e.message);
      if (e.tokenInvalid) {
        await prisma.dmAccount.update({ where: { id: t.dmAccountId }, data: { status: "revoked", error: e.message } });
        return reply.status(409).send({ error: `Instagram refused the token for @${t.dmAccount.socialAccount.handle}. Reconnect the account.`, reason: "reconnect" });
      }
      if (e.windowClosed) return reply.status(409).send({ error: e.message, reason: "window_closed" });
      return reply.status(502).send({ error: e.message, reason: "instagram_error" });
    }
  });

  /**
   * A photo for a reply. Instagram fetches the image itself, so it goes into
   * storage and comes back as a signed public link, which the reply then sends
   * as its media. Operators only, like every other write here (dmWriteGuard).
   */
  app.post<{ Params: { id: string } }>("/clients/:id/dm/upload", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const file = await request.file({ limits: { fileSize: DM_IMAGE_MAX + 1 } }).catch(() => undefined);
    if (!file) return reply.status(400).send({ error: "no file uploaded" });
    const ext = DM_IMAGE[file.mimetype];
    if (!ext) {
      file.file.resume();
      return reply.status(400).send({ error: "Instagram takes a JPG, PNG or GIF in a DM." });
    }
    const storageKey = `${client.id}/dm/${randomUUID()}.${ext}`;
    const full = path.join(env.STORAGE_DIR, storageKey);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await pipeline(file.file, createWriteStream(full));
    if (file.file.truncated) {
      await fs.rm(full, { force: true });
      return reply.status(413).send({ error: "Instagram takes images up to 8 MB in a DM." });
    }
    return reply.status(201).send({ url: originOf(request) + fileLink(storageKey), type: "image" as const });
  });

  app.post<{ Params: { id: string; threadId: string } }>("/clients/:id/dm/threads/:threadId/read", async (request, reply) => {
    const t = await ownedThread(request.params.threadId, request.params.id, request.user.agencyId);
    if (!t) return reply.status(404).send({ error: "thread not found" });
    await prisma.dmThread.update({ where: { id: t.id }, data: { unread: 0, readAt: new Date() } });
    const token = t.source === "native" ? accountToken(t.dmAccount) : null;
    // Their "Seen" is a courtesy: a failure here is not worth failing the click.
    if (token) await igMarkSeen(token, t.contact.externalId).catch(() => undefined);
    return { ok: true };
  });

  app.patch<{ Params: { id: string; threadId: string } }>("/clients/:id/dm/threads/:threadId", async (request, reply) => {
    const body = dmThreadPatchSchema.parse(request.body ?? {});
    const t = await ownedThread(request.params.threadId, request.params.id, request.user.agencyId);
    if (!t) return reply.status(404).send({ error: "thread not found" });
    if (body.status) await prisma.dmThread.update({ where: { id: t.id }, data: { status: body.status } });
    if (body.stage !== undefined || body.notes !== undefined) {
      await prisma.dmContact.update({
        where: { id: t.contactId },
        data: { ...(body.stage ? { stage: body.stage } : {}), ...(body.notes !== undefined ? { notes: body.notes } : {}) },
      });
    }
    if (body.tags) await setContactTags(t.dmAccount.clientId, t.contactId, body.tags);
    const fresh = await prisma.dmThread.findUniqueOrThrow({ where: { id: t.id }, include: threadInclude });
    return { thread: threadView(fresh) };
  });

  for (const [path, pausedAt] of [["pause", () => new Date()], ["resume", () => null]] as const) {
    app.post<{ Params: { id: string; threadId: string } }>(`/clients/:id/dm/threads/:threadId/${path}`, async (request, reply) => {
      const t = await ownedThread(request.params.threadId, request.params.id, request.user.agencyId);
      if (!t) return reply.status(404).send({ error: "thread not found" });
      const fresh = await prisma.dmThread.update({ where: { id: t.id }, data: { pausedAt: pausedAt() }, include: threadInclude });
      return { thread: threadView(fresh) };
    });
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  const contactInclude = {
    tags: { include: { tag: { select: { name: true } } } },
    dmAccount: { select: { platform: true, socialAccount: { select: { id: true, handle: true } } } },
    threads: {
      select: { id: true, lastPreview: true, lastMessageAt: true, lastDirection: true, unread: true, windowEndsAt: true, source: true },
      take: 1,
    },
  } satisfies Prisma.DmContactInclude;
  const contactRow = (c: Prisma.DmContactGetPayload<{ include: typeof contactInclude }>): DmContactRow => {
    const t = c.threads[0];
    return {
      ...contactView(c),
      platform: c.dmAccount.platform === "facebook" ? "facebook" : "instagram",
      accountId: c.dmAccount.socialAccount.id,
      accountHandle: c.dmAccount.socialAccount.handle,
      threadId: t?.id ?? null,
      firstSeenAt: c.createdAt.toISOString(),
      lastPreview: t?.lastPreview ?? null,
      lastMessageAt: t?.lastMessageAt?.toISOString() ?? null,
      lastDirection: t?.lastDirection === "in" || t?.lastDirection === "out" ? t.lastDirection : null,
      unread: t?.unread ?? 0,
      windowEndsAt: t?.source === "native" ? (t.windowEndsAt?.toISOString() ?? null) : null,
    };
  };

  /** Sort orders the Contacts filter offers. Last message is the default. */
  const CONTACT_SORT = {
    last: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    first: [{ createdAt: "desc" }, { id: "desc" }],
    name: [{ displayName: { sort: "asc", nulls: "last" } }, { handle: { sort: "asc", nulls: "last" } }, { id: "asc" }],
  } satisfies Record<string, Prisma.DmContactOrderByWithRelationInput[]>;

  app.get<{
    Params: { id: string };
    Querystring: {
      search?: string;
      tag?: string;
      stage?: string;
      accountId?: string;
      platform?: string;
      unread?: string;
      sort?: string;
      cursor?: string;
    };
  }>(
    "/clients/:id/dm/contacts",
    async (request, reply) => {
      const client = await ownedClient(request.params.id, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "client not found" });
      const q = request.query;
      const base: Prisma.DmContactWhereInput = { dmAccount: { clientId: client.id } };
      // Stage takes one or several (?stage=engaged,qualify), as the phone filter sheet ticks.
      const stages = (q.stage ?? "").split(",").filter((s) => (DM_STAGES as readonly string[]).includes(s));
      const where: Prisma.DmContactWhereInput = {
        dmAccount: {
          clientId: client.id,
          ...(q.accountId ? { socialAccountId: q.accountId } : {}),
          ...(q.platform === "instagram" || q.platform === "facebook" ? { platform: q.platform } : {}),
        },
        ...(stages.length ? { stage: { in: stages } } : {}),
        ...(q.unread === "1" ? { threads: { some: { unread: { gt: 0 } } } } : {}),
        ...(q.tag ? { tags: { some: { tag: { name: q.tag } } } } : {}),
        ...(q.search?.trim()
          ? {
              OR: [
                { displayName: { contains: q.search.trim().replace(/^@/, ""), mode: "insensitive" } },
                { handle: { contains: q.search.trim().replace(/^@/, ""), mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const sort = CONTACT_SORT[(q.sort ?? "last") as keyof typeof CONTACT_SORT] ?? CONTACT_SORT.last;
      const [rows, tags, total, all, unread] = await Promise.all([
        prisma.dmContact.findMany({
          where,
          include: contactInclude,
          orderBy: sort,
          take: 51,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        }),
        prisma.dmTag.findMany({
          where: { clientId: client.id },
          select: { name: true, _count: { select: { contacts: true } } },
          orderBy: { name: "asc" },
        }),
        prisma.dmContact.count({ where }),
        prisma.dmContact.count({ where: base }),
        prisma.dmContact.count({ where: { ...base, threads: { some: { unread: { gt: 0 } } } } }),
      ]);
      const page = rows.slice(0, 50);
      return {
        contacts: page.map(contactRow),
        nextCursor: rows.length > 50 ? page[page.length - 1]!.id : null,
        /** Matching the filters; counts are the whole client, for the All and Unread chips. */
        total,
        counts: { all, unread },
        tags: tags.map((t) => ({ name: t.name, count: t._count.contacts })),
      };
    },
  );

  const ownedContact = (contactId: string, clientId: string, agencyId: string) =>
    prisma.dmContact.findFirst({
      where: { id: contactId, dmAccount: { clientId, client: { agencyId, deletedAt: null } } },
      include: contactInclude,
    });

  app.get<{ Params: { id: string; contactId: string } }>("/clients/:id/dm/contacts/:contactId", async (request, reply) => {
    const c = await ownedContact(request.params.contactId, request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send({ error: "contact not found" });
    return { contact: contactRow(c) };
  });

  /**
   * Select mode: set one stage, add tags and remove tags on many contacts.
   * Every id must be this client's; one stranger fails the whole call, so a
   * crafted list cannot touch another brand's people.
   */
  app.post<{ Params: { id: string } }>("/clients/:id/dm/contacts/bulk", async (request, reply) => {
    const body = dmContactBulkSchema.parse(request.body ?? {});
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const ids = [...new Set(body.ids)];
    const owned = await prisma.dmContact.count({ where: { id: { in: ids }, dmAccount: { clientId: client.id } } });
    if (owned !== ids.length) return reply.status(404).send({ error: "contact not found" });
    // ponytail: three plain writes, no transaction; each is idempotent, so a
    // failure halfway is fixed by pressing the button again.
    if (body.stage) await prisma.dmContact.updateMany({ where: { id: { in: ids } }, data: { stage: body.stage } });
    const add = [...new Set((body.addTags ?? []).map((n) => n.trim()))];
    if (add.length) {
      const tags = await Promise.all(
        add.map((name) => prisma.dmTag.upsert({ where: { clientId_name: { clientId: client.id, name } }, create: { clientId: client.id, name }, update: {} })),
      );
      await prisma.dmContactTag.createMany({
        data: ids.flatMap((contactId) => tags.map((t) => ({ contactId, tagId: t.id }))),
        skipDuplicates: true,
      });
    }
    const remove = (body.removeTags ?? []).map((n) => n.trim());
    if (remove.length) {
      await prisma.dmContactTag.deleteMany({ where: { contactId: { in: ids }, tag: { clientId: client.id, name: { in: remove } } } });
    }
    return { updated: ids.length };
  });

  app.patch<{ Params: { id: string; contactId: string } }>("/clients/:id/dm/contacts/:contactId", async (request, reply) => {
    const body = dmContactPatchSchema.parse(request.body ?? {});
    const c = await ownedContact(request.params.contactId, request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send({ error: "contact not found" });
    const { tags, ...fields } = body;
    if (Object.keys(fields).length) await prisma.dmContact.update({ where: { id: c.id }, data: fields });
    if (tags) await setContactTags(request.params.id, c.id, tags);
    return { contact: contactRow((await ownedContact(c.id, request.params.id, request.user.agencyId))!) };
  });
}

/** Media types the proxy passes as themselves; anything else downloads. */
const SAFE_TYPE = /^(image|video|audio)\/|^application\/pdf$/;

/**
 * The two routes a browser reaches without our bearer token.
 *
 * The OAuth callback authenticates on the signed state, like Google's. The
 * media proxy on the signed link: <img> and <video> cannot send a header, so
 * the link is the permission, scoped to one attachment of one message.
 */
export async function publicDmRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(IG_CALLBACK_PATH, async (request, reply) => {
    const html = (status: number, ok: boolean, heading: string, detail: string) =>
      reply.status(status).type("text/html; charset=utf-8").send(resultPage(ok, esc(heading), esc(detail)));
    const creds = igCreds();
    if (!creds) return html(503, false, "Not connected", "This server is not set up for Instagram DMs yet.");
    if (request.query.error) {
      return html(400, false, "Not connected", "The authorization was cancelled, so nothing was changed. You can close this page.");
    }
    const verdict = verifyState(request.query.state, env.JWT_SECRET);
    if (!verdict.ok) {
      return html(400, false, "Not connected", verdict.reason === "expired" ? "That link has expired. Ask for a fresh one and try again." : "That link is not valid. Ask for a fresh one and try again.");
    }
    const code = typeof request.query.code === "string" ? request.query.code : "";
    if (!code) return html(400, false, "Not connected", "Instagram sent no authorization back.");
    const account = await prisma.socialAccount.findFirst({
      where: {
        id: verdict.state.socialAccountId,
        deletedAt: null,
        platform: "instagram",
        client: { agencyId: verdict.state.agencyId, deletedAt: null },
      },
      select: { id: true, handle: true, clientId: true, platformConnection: { select: { id: true } } },
    });
    if (!account) return html(404, false, "Not connected", "That account no longer exists in the app.");

    try {
      const grant = await igExchangeCode(creds, code);
      const me = await igMe(grant.token);
      // The likeliest mistake: signed in to Instagram as a different account.
      const norm = (h: string | null) => (h ?? "").replace(/^@/, "").trim().toLowerCase();
      if (me.username && account.handle && norm(me.username) !== norm(account.handle)) {
        return html(409, false, "Wrong account", `You signed in as @${me.username}, but this link is for @${norm(account.handle)}. Sign in to Instagram as @${norm(account.handle)} and open the link again.`);
      }
      const taken = await prisma.dmAccount.findFirst({
        where: { platform: "instagram", externalId: me.userId, NOT: { socialAccountId: account.id } },
        select: { id: true },
      });
      if (taken) return html(409, false, "Already connected", `@${me.username ?? norm(account.handle)} is already connected under another brand in Toreroflow.`);

      let subscribeError: string | null = null;
      await igSubscribe(grant.token).catch((e: unknown) => {
        subscribeError = `Webhook subscription failed: ${e instanceof Error ? e.message : String(e)}`;
      });
      const row = {
        clientId: account.clientId,
        platform: "instagram" as const,
        transport: "native",
        externalId: me.userId,
        username: me.username,
        platformConnectionId: account.platformConnection?.id ?? null,
        accessTokenEnc: encryptSecret(grant.token),
        tokenExpiresAt: grant.expiresAt,
        tokenRefreshedAt: new Date(),
        scopes: grant.scopes,
        status: "active",
        error: subscribeError,
        lastSyncAt: null,
      };
      await prisma.dmAccount.upsert({ where: { socialAccountId: account.id }, create: { socialAccountId: account.id, ...row }, update: row });
      // Recent conversations in the inbox now, not after the next 5-minute tick.
      await enqueue("dm", { kind: "sync" }, { key: "sync" }).catch(() => undefined);
      return html(200, true, "Connected", `@${me.username ?? norm(account.handle)} is connected. Its Instagram DMs now come straight into Toreroflow. You can close this page.`);
    } catch (error) {
      request.log.error({ err: error instanceof Error ? error.message : error }, "instagram oauth callback failed");
      const detail = error instanceof InstagramError ? error.message : "Something went wrong finishing the connection. Try the link again.";
      return html(502, false, "Not connected", detail);
    }
  });

  /**
   * GET /dm/media/<key>?e=&s= streams one attachment from Meta's CDN.
   *
   * n/<messageId>/<i>: a native message. Its stored URL first; when Meta has
   * expired it, the message is read again and the fresh URLs are saved.
   * z/<socialAccountId>/<conversationId>/<messageId>/<i>: a Zernio message.
   * The URL from the thread read first; past that, Zernio's attachment
   * refresh. Nothing is stored, per Meta's Platform Terms.
   */
  app.get("/dm/media/*", async (request, reply) => {
    const key = decodeURIComponent(request.url.slice("/dm/media/".length).split("?")[0] ?? "");
    const verdict = verifyFileLink(key, request.query as { e?: unknown; s?: unknown }, env.JWT_SECRET);
    if (verdict === "expired") return reply.status(410).send({ error: "this link has expired, open the thread again" });
    if (verdict !== "ok") return reply.status(404).send({ error: "not found" });
    const range = typeof request.headers.range === "string" ? request.headers.range : undefined;
    const seg = key.split("/");
    const i = Number(seg[seg.length - 1]);
    let res: Response | null = null;

    if (seg[0] === "n" && seg.length === 3) {
      const m = await prisma.dmMessage.findUnique({
        where: { id: seg[1] },
        include: { thread: { select: { dmAccount: { select: { accessTokenEnc: true, status: true } } } } },
      });
      if (!m || m.unsentAt) return reply.status(404).send({ error: "not found" });
      const parts = (Array.isArray(m.attachments) ? m.attachments : []) as Array<{ url?: string | null }>;
      res = await pullMedia(parts[i]?.url, range);
      const token = res ? null : accountToken(m.thread.dmAccount);
      if (!res && token && !m.externalId.startsWith("failed:")) {
        try {
          const fresh = partsFromApi(await igMessage(token, m.externalId));
          if (fresh.length) {
            await prisma.dmMessage.update({ where: { id: m.id }, data: { attachments: fresh as unknown as Prisma.InputJsonValue } });
            res = await pullMedia(fresh[i]?.url, range);
          }
        } catch (e) {
          request.log.warn({ err: e instanceof Error ? e.message : e }, "dm media refresh failed");
        }
      }
    } else if (seg[0] === "z" && seg.length === 5) {
      const [, socialAccountId, conversationId, messageId] = seg as [string, string, string, string];
      res = await pullMedia(zernioHint(key), range);
      const z = zernio();
      if (!res && z) {
        const social = await prisma.socialAccount.findUnique({ where: { id: socialAccountId }, select: { providerAccountId: true } });
        if (social?.providerAccountId) {
          const url = await z.attachmentUrl(conversationId, messageId, i, social.providerAccountId).catch(() => null);
          res = await pullMedia(url, range);
        }
      }
    } else {
      return reply.status(404).send({ error: "not found" });
    }

    if (!res || !res.body) {
      return reply.status(404).header("cache-control", "private, max-age=300").send({ error: "media unavailable" });
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    reply
      .status(res.status)
      .header("content-type", SAFE_TYPE.test(type) ? type : "application/octet-stream")
      .header("cache-control", "private, max-age=3600")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("accept-ranges", "bytes");
    for (const h of ["content-length", "content-range"]) {
      const v = res.headers.get(h);
      if (v) reply.header(h, v);
    }
    if (!SAFE_TYPE.test(type)) reply.header("content-disposition", "attachment");
    return reply.send(Readable.fromWeb(res.body as unknown as WebReadableStream));
  });
}

/** For checks: build a proxy link the same way the views do. */
export { mediaLink };
