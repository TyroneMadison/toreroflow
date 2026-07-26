import type { FastifyInstance } from "fastify";
import nodePath from "node:path";
import { promises as fsp, createWriteStream } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import PDFDocument from "pdfkit";
import {
  connectAccountSchema,
  createClientSchema,
  platformSchema,
  PLATFORMS,
  type Platform,
} from "@toreroflow/core";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { DryRunPublisher, ZernioError, ZernioProvider } from "@toreroflow/publishers";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

const NOT_FOUND = { error: "client not found" } as const;

/** First numeric value among several possible provider field names. */
function num(item: Record<string, unknown>, ...names: string[]): number | null {
  for (const n of names) {
    const v = item[n];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Initials for the avatar tile, e.g. "Halo Fitness" -> "HF". */
function avatarSeed(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

const quotaSchema = z.object({
  /** Which format the target/adjustment applies to; ignored when resetting. */
  format: z.enum(["short_form", "long_form"]).optional(),
  target: z.number().int().min(0).max(10_000).nullable().optional(),
  adjustment: z.number().int().min(-10_000).max(10_000).optional(),
  adjustBy: z.number().int().min(-1_000).max(1_000).optional(),
  /** Starts a new pay period for both formats at once. */
  reset: z.boolean().optional(),
});

const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          category: {
            type: "string",
            enum: ["content", "timing", "platform", "growth", "setup"],
          },
        },
        required: ["title", "detail", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions"],
  additionalProperties: false,
} as const;

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const anthropic = env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    : null;
  const zernio =
    env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY
      ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY)
      : null;
  const analyticsQueue = new Queue("analytics", {
    connection: new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }),
  });

  /** Zernio profile backing this client, created on first use. */
  const ensureProviderProfile = async (client: {
    id: string;
    name: string;
    providerProfileId: string | null;
  }): Promise<string> => {
    if (client.providerProfileId) return client.providerProfileId;
    const profileId = await zernio!.createProfile(client.name);
    await prisma.client.update({
      where: { id: client.id },
      data: { providerProfileId: profileId },
    });
    return profileId;
  };

  app.addHook("onRequest", requireAuth);

  app.get("/clients", async (request) => {
    const clients = await prisma.client.findMany({
      where: { agencyId: request.user.agencyId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: {
        socialAccounts: {
          where: { deletedAt: null },
          orderBy: { platform: "asc" },
        },
        _count: { select: { workflows: true } },
      },
    });
    return clients.map((c) => ({
      id: c.id,
      name: c.name,
      avatarSeed: c.avatarSeed,
      plan: c.plan,
      createdAt: c.createdAt,
      workflowCount: c._count.workflows,
      accounts: c.socialAccounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        handle: a.handle,
        status: a.status,
        connectedAt: a.connectedAt,
        avatarUrl: a.avatarUrl,
        displayName: a.displayName,
      })),
    }));
  });

  app.post("/clients", async (request, reply) => {
    const body = createClientSchema.parse(request.body);
    const client = await prisma.client.create({
      data: {
        agencyId: request.user.agencyId,
        name: body.name,
        plan: body.plan ?? "Starter plan",
        avatarSeed: avatarSeed(body.name),
      },
    });
    return reply.status(201).send(client);
  });

  app.delete<{ Params: { id: string } }>("/clients/:id", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: {
        id: request.params.id,
        agencyId: request.user.agencyId,
        deletedAt: null,
      },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);

    // Soft delete; tokens are purged immediately (spec Section 15: provide a
    // way to disconnect an account and delete its tokens).
    const now = new Date();
    await prisma.$transaction([
      prisma.socialAccount.updateMany({
        where: { clientId: client.id },
        data: { deletedAt: now, tokensEncrypted: null, status: "error" },
      }),
      prisma.client.update({
        where: { id: client.id },
        data: { deletedAt: now },
      }),
    ]);
    return { ok: true };
  });

  /**
   * Connect a platform account for a client. With PUBLISH_PROVIDER=dryrun this
   * simulates the provider OAuth round-trip instantly; when a real provider is
   * configured (M1 decision), the same adapter interface performs real OAuth.
   */
  app.post<{ Params: { id: string; platform: string } }>(
    "/clients/:id/accounts/:platform",
    async (request, reply) => {
      const platform = platformSchema.parse(request.params.platform);
      const body = connectAccountSchema.parse(request.body ?? {});

      const client = await prisma.client.findFirst({
        where: {
          id: request.params.id,
          agencyId: request.user.agencyId,
          deletedAt: null,
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      // Real provider: hand back the hosted OAuth URL. The operator finishes
      // authorization in the browser, then the app imports via /accounts/sync.
      if (zernio) {
        try {
          const profileId = await ensureProviderProfile(client);
          const authUrl = await zernio.connectUrl(platform, profileId);
          return reply.send({ authUrl, platform });
        } catch (error) {
          if (error instanceof ZernioError) {
            return reply.status(502).send({ error: `Zernio: ${error.message}` });
          }
          throw error;
        }
      }

      const publisher = new DryRunPublisher(platform);
      const init = await publisher.handleCallback({ state: client.id });
      const handle = body.handle ?? init.handle;

      const existing = await prisma.socialAccount.findFirst({
        where: { clientId: client.id, platform, deletedAt: null },
      });
      const account = existing
        ? await prisma.socialAccount.update({
            where: { id: existing.id },
            data: {
              handle,
              status: "connected",
              tokensEncrypted: init.tokensEncrypted,
              providerAccountId: init.providerAccountId,
              connectedAt: new Date(),
            },
          })
        : await prisma.socialAccount.create({
            data: {
              clientId: client.id,
              platform,
              handle,
              status: "connected",
              tokensEncrypted: init.tokensEncrypted,
              providerAccountId: init.providerAccountId,
              scopes: init.scopes,
            },
          });

      return reply.status(existing ? 200 : 201).send({
        id: account.id,
        platform: account.platform,
        handle: account.handle,
        status: account.status,
        connectedAt: account.connectedAt,
      });
    },
  );

  /** Import accounts the operator connected on the provider's hosted page. */
  app.post<{ Params: { id: string } }>(
    "/clients/:id/accounts/sync",
    async (request, reply) => {
      if (!zernio) {
        return reply.status(400).send({ error: "no publishing provider configured" });
      }
      const client = await prisma.client.findFirst({
        where: {
          id: request.params.id,
          agencyId: request.user.agencyId,
          deletedAt: null,
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      try {
        const profileId = await ensureProviderProfile(client);
        const remote = await zernio.accountsForProfile(profileId);
        const valid = remote.filter((a) =>
          (PLATFORMS as readonly string[]).includes(a.platform),
        );
        for (const a of valid) {
          const platform = a.platform as Platform;
          const profileData = a.metadata?.profileData;
          const handle =
            profileData?.username ?? a.username ?? a.displayName ?? a.name ?? a.platform;
          const avatarUrl = profileData?.profilePicture ?? null;
          const displayName = a.displayName ?? profileData?.displayName ?? null;
          const existing = await prisma.socialAccount.findFirst({
            where: { clientId: client.id, platform, deletedAt: null },
          });
          const account = existing
            ? await prisma.socialAccount.update({
                where: { id: existing.id },
                data: {
                  handle,
                  status: "connected",
                  providerAccountId: a._id,
                  avatarUrl,
                  displayName,
                  connectedAt: new Date(),
                },
              })
            : await prisma.socialAccount.create({
                data: {
                  clientId: client.id,
                  platform,
                  handle,
                  status: "connected",
                  providerAccountId: a._id,
                  avatarUrl,
                  displayName,
                  // Tokens stay with the provider; this marks custody, not a secret.
                  tokensEncrypted: "provider:zernio",
                },
              });
          // Followers are known right now; seed today's snapshot immediately.
          if (typeof a.followersCount === "number") {
            const dayStart = new Date();
            dayStart.setHours(0, 0, 0, 0);
            const snap = await prisma.metricSnapshot.findFirst({
              where: { socialAccountId: account.id, capturedAt: { gte: dayStart } },
            });
            if (snap) {
              await prisma.metricSnapshot.update({
                where: { id: snap.id },
                data: { followers: a.followersCount },
              });
            } else {
              await prisma.metricSnapshot.create({
                data: {
                  socialAccountId: account.id,
                  capturedAt: new Date(),
                  followers: a.followersCount,
                },
              });
            }
          }
        }
        // Backfill history from the provider's already-synced posts right away.
        if (valid.length) {
          await analyticsQueue.add(
            "ingest",
            {},
            { removeOnComplete: true, removeOnFail: true },
          );
        }
        return { imported: valid.length };
      } catch (error) {
        if (error instanceof ZernioError) {
          return reply.status(502).send({ error: `Zernio: ${error.message}` });
        }
        throw error;
      }
    },
  );

  /** Disconnect: purge tokens and soft-delete the account row. */
  app.delete<{ Params: { id: string } }>("/accounts/:id", async (request, reply) => {
    const account = await prisma.socialAccount.findFirst({
      where: {
        id: request.params.id,
        deletedAt: null,
        client: { agencyId: request.user.agencyId },
      },
    });
    if (!account) return reply.status(404).send({ error: "account not found" });

    await prisma.socialAccount.update({
      where: { id: account.id },
      data: { deletedAt: new Date(), tokensEncrypted: null, status: "error" },
    });
    return { ok: true };
  });

  /**
   * Snapshots are daily activity buckets (views/likes/comments attributed to
   * the day content was published), so a window's totals are simple sums.
   */
  const buildAnalytics = async (clientId: string, agencyId: string, days = 30) => {
    const client = await prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
      include: {
        socialAccounts: {
          where: { deletedAt: null },
          include: {
            metricSnapshots: { orderBy: { capturedAt: "desc" }, take: 220 },
          },
        },
      },
    });
    if (!client) return null;

    const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rawOf = (s: { raw: unknown }) =>
      (s.raw as { likes?: number; comments?: number; shares?: number } | null) ?? {};

    const accounts = client.socialAccounts.map((a) => {
      const inWindow = a.metricSnapshots.filter((s) => s.capturedAt >= windowStart);
      const latest = a.metricSnapshots[0] ?? null;
      const sum = (pick: (s: (typeof inWindow)[number]) => number | null | undefined) =>
        inWindow.reduce((acc, s) => acc + (pick(s) ?? 0), 0);
      const watches = inWindow
        .map((s) => s.avgWatchSec)
        .filter((x): x is number => x != null && x > 0);
      return {
        id: a.id,
        platform: a.platform,
        handle: a.handle,
        status: a.status,
        avatarUrl: a.avatarUrl,
        displayName: a.displayName,
        window: {
          views: sum((s) => s.views),
          reach: sum((s) => s.reach),
          likes: sum((s) => rawOf(s).likes),
          comments: sum((s) => rawOf(s).comments),
          shares: sum((s) => rawOf(s).shares),
          avgWatchSec: watches.length
            ? watches.reduce((s, x) => s + x, 0) / watches.length
            : null,
        },
        latest: latest
          ? {
              capturedAt: latest.capturedAt,
              views: latest.views,
              reach: latest.reach,
              followers: latest.followers,
              engagementRate: latest.engagementRate,
              avgWatchSec: latest.avgWatchSec,
            }
          : null,
        followers:
          a.metricSnapshots.find((s) => s.followers != null)?.followers ?? null,
        history: [...inWindow].reverse().map((s) => ({
          capturedAt: s.capturedAt,
          views: s.views,
          reach: s.reach,
          followers: s.followers,
        })),
      };
    });

    const views = accounts.reduce((s, a) => s + a.window.views, 0);
    const likes = accounts.reduce((s, a) => s + a.window.likes, 0);
    const comments = accounts.reduce((s, a) => s + a.window.comments, 0);
    const shares = accounts.reduce((s, a) => s + a.window.shares, 0);
    const watches = accounts
      .map((a) => a.window.avgWatchSec)
      .filter((x): x is number => x != null);

    const totals = {
      views,
      reach: accounts.reduce((s, a) => s + a.window.reach, 0),
      followers: accounts.reduce((s, a) => s + (a.followers ?? 0), 0),
      engagementRate: views > 0 ? ((likes + comments) / views) * 100 : null,
      avgWatchSec: watches.length
        ? watches.reduce((s, x) => s + x, 0) / watches.length
        : null,
      likes,
      comments,
      shares,
    };

    return {
      client: { id: client.id, name: client.name, plan: client.plan },
      days,
      accounts,
      totals,
      hasData: accounts.some((a) => a.history.length > 0 || a.latest !== null),
    };
  };

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    "/clients/:id/analytics",
    async (request, reply) => {
      const days = Math.min(200, Math.max(1, Number(request.query.days) || 30));
      const data = await buildAnalytics(request.params.id, request.user.agencyId, days);
      if (!data) return reply.status(404).send(NOT_FOUND);
      return data;
    },
  );

  /**
   * Video quota for the current pay period.
   *
   * The delivered count is derived, not stored: non-revision uploads since
   * the period start, plus a manual adjustment. That way deleting a video
   * corrects the number automatically, and "reset" is just moving the date.
   */
  const quotaView = async (clientId: string) => {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: {
        quotaShort: true,
        quotaLong: true,
        quotaResetAt: true,
        adjustShort: true,
        adjustLong: true,
      },
    });
    if (!client) return null;
    const since = client.quotaResetAt ?? new Date(0);
    const inPeriod = { clientId, createdAt: { gte: since } };

    const count = (extra: Record<string, unknown>) =>
      prisma.mediaAsset.count({ where: { ...inPeriod, ...extra } });

    // Videos still being probed have no format yet. They are counted as
    // short-form, which is the common case, and correct themselves within
    // seconds once the duration is known.
    const [shortUploads, longUploads, shortRevs, longRevs] = await Promise.all([
      count({ isRevision: false, format: { in: ["short_form"] } }),
      count({ isRevision: false, format: "long_form" }),
      count({ isRevision: true, format: { in: ["short_form"] } }),
      count({ isRevision: true, format: "long_form" }),
    ]);
    const [unclassifiedUploads, unclassifiedRevs] = await Promise.all([
      count({ isRevision: false, format: null }),
      count({ isRevision: true, format: null }),
    ]);

    const section = (
      target: number | null,
      adjustment: number,
      uploads: number,
      revisions: number,
    ) => ({
      target,
      adjustment,
      uploads,
      revisions,
      delivered: Math.max(0, uploads + adjustment),
    });

    return {
      periodStart: client.quotaResetAt,
      unclassified: unclassifiedUploads + unclassifiedRevs,
      short: section(
        client.quotaShort,
        client.adjustShort,
        shortUploads + unclassifiedUploads,
        shortRevs + unclassifiedRevs,
      ),
      long: section(client.quotaLong, client.adjustLong, longUploads, longRevs),
    };
  };

  app.get<{ Params: { id: string } }>("/clients/:id/quota", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);
    return await quotaView(client.id);
  });

  app.patch<{
    Params: { id: string };
    Body: { target?: number | null; adjustment?: number; adjustBy?: number; reset?: boolean };
  }>("/clients/:id/quota", async (request, reply) => {
    const body = quotaSchema.parse(request.body ?? {});
    const client = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true, adjustShort: true, adjustLong: true },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);

    const long = body.format === "long_form";
    const targetKey = long ? "quotaLong" : "quotaShort";
    const adjustKey = long ? "adjustLong" : "adjustShort";
    const currentAdjust = long ? client.adjustLong : client.adjustShort;

    const data: Record<string, number | null | Date> = {};
    if (body.target !== undefined) data[targetKey] = body.target;
    if (body.adjustment !== undefined) data[adjustKey] = body.adjustment;
    if (body.adjustBy !== undefined) {
      const base = (data[adjustKey] as number | undefined) ?? currentAdjust;
      data[adjustKey] = base + body.adjustBy;
    }
    // A new period restarts both formats and drops their corrections.
    if (body.reset) {
      data.quotaResetAt = new Date();
      data.adjustShort = 0;
      data.adjustLong = 0;
    }

    await prisma.client.update({ where: { id: client.id }, data });
    return await quotaView(client.id);
  });

  /** Provider post list per client, cached briefly across brand switches. */
  const postsCache = new Map<string, { at: number; posts: unknown[] }>();
  const POSTS_TTL_MS = 5 * 60 * 1000;

  /**
   * Force-refresh everything for one client: drop the cached post list and
   * run a provider ingest now rather than waiting for the daily job, so the
   * newest uploads and numbers show up on demand.
   */
  app.post<{ Params: { id: string } }>(
    "/clients/:id/analytics/refresh",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      // Clearing the cache is what makes the next posts fetch hit the
      // provider live, so newest uploads and view counts are current
      // immediately. The queued ingest refreshes follower snapshots and
      // per-day history right behind it.
      postsCache.delete(client.id);
      await analyticsQueue.add(
        "ingest",
        {},
        { removeOnComplete: true, removeOnFail: true },
      );
      return { ok: true, refreshedAt: new Date().toISOString() };
    },
  );

  /**
   * Live per-post analytics for the Analytics screen: every provider post
   * (including pre-existing platform content) belonging to this client's
   * profile, with title, thumbnail, publish date, and metrics. Cached
   * briefly so brand switches don't hammer the provider.
   */
  app.get<{ Params: { id: string } }>(
    "/clients/:id/analytics/posts",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        include: { socialAccounts: { where: { deletedAt: null } } },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);
      if (!zernio) return { posts: [] };

      const cached = postsCache.get(client.id);
      if (cached && Date.now() - cached.at < POSTS_TTL_MS) return { posts: cached.posts };

      let raw: Array<Record<string, unknown>>;
      try {
        raw = await zernio.analytics(500);
      } catch (error) {
        request.log.error({ err: error }, "zernio analytics pull failed");
        return { posts: [] };
      }

      const accountPlatform = new Map(
        client.socialAccounts
          .filter((a) => a.providerAccountId)
          .map((a) => [a.providerAccountId as string, a.platform as string]),
      );

      // Durations exist only for videos we produced ourselves.
      const targets = await prisma.postTarget.findMany({
        where: { remotePostId: { not: null }, socialAccount: { clientId: client.id } },
        include: { post: { include: { mediaAsset: true } } },
      });
      const durationByRemoteId = new Map<string, number>();
      for (const t of targets) {
        const d = t.post.mediaAsset?.durationSec;
        if (t.remotePostId && d) durationByRemoteId.set(t.remotePostId, d);
      }

      const posts: unknown[] = [];
      for (const p of raw) {
        const entries = Array.isArray(p.platforms)
          ? (p.platforms as Array<Record<string, unknown>>)
          : [];
        const mine = entries.filter(
          (e) => typeof e.accountId === "string" && accountPlatform.has(e.accountId),
        );
        const profileMatch =
          typeof p.profileId === "string" && p.profileId === client.providerProfileId;
        if (!profileMatch && mine.length === 0) continue;

        const published = new Date(String(p.publishedAt ?? p.scheduledFor ?? ""));
        if (Number.isNaN(published.getTime())) continue;

        const use = mine.length ? mine : entries;
        const m = (p.analytics ?? {}) as Record<string, unknown>;
        const views = num(m, "views", "impressions", "plays") ?? 0;

        // Per-platform attribution: the entry's own analytics when present,
        // else the whole post's on a single-platform post, else an even split.
        const byPlatform = use.map((e) => {
          const em = (e.analytics ?? {}) as Record<string, unknown>;
          const entryViews = num(em, "views", "impressions", "plays");
          const platform =
            accountPlatform.get(e.accountId as string) ??
            (typeof e.platform === "string" ? e.platform : "unknown");
          return {
            platform,
            views:
              entryViews ?? (use.length === 1 ? views : Math.round(views / use.length)),
          };
        });

        // igReelsAvgWatchTime arrives in milliseconds; the others in seconds.
        const watchMs = num(m, "igReelsAvgWatchTime");
        const avgWatchSec =
          watchMs && watchMs > 0
            ? watchMs / 1000
            : num(m, "avgWatchTime", "averageViewDuration");

        const id = typeof p._id === "string" ? p._id : String(p.id ?? "");
        posts.push({
          id,
          title:
            typeof p.content === "string" && p.content.trim() ? p.content.trim() : "(untitled)",
          publishedAt: published.toISOString(),
          thumbnailUrl: typeof p.thumbnailUrl === "string" ? p.thumbnailUrl : null,
          url: typeof p.platformPostUrl === "string" ? p.platformPostUrl : null,
          platforms: [...new Set(byPlatform.map((b) => b.platform))],
          views,
          likes: num(m, "likes", "likeCount") ?? 0,
          comments: num(m, "comments", "commentCount") ?? 0,
          shares: num(m, "shares", "shareCount") ?? 0,
          avgWatchSec: avgWatchSec && avgWatchSec > 0 ? avgWatchSec : null,
          durationSec:
            num(m, "duration", "videoDuration", "durationSec", "mediaDuration") ??
            durationByRemoteId.get(id) ??
            null,
          byPlatform,
        });
      }
      posts.sort((a, b) =>
        (a as { publishedAt: string }).publishedAt < (b as { publishedAt: string }).publishedAt
          ? 1
          : -1,
      );
      postsCache.set(client.id, { at: Date.now(), posts });
      return { posts };
    },
  );

  /** Branded PDF report written to storage; the app opens it externally. */
  app.post<{ Params: { id: string } }>("/clients/:id/report", async (request, reply) => {
    const data = await buildAnalytics(request.params.id, request.user.agencyId);
    if (!data) return reply.status(404).send(NOT_FOUND);

    const stamp = new Date().toISOString().slice(0, 10);
    const relPath = `${data.client.id}/reports/toreroflow-report-${stamp}.pdf`;
    const absPath = nodePath.join(env.STORAGE_DIR, relPath);
    await fsp.mkdir(nodePath.dirname(absPath), { recursive: true });

    const fmt = (n: number | null): string =>
      n == null
        ? "-"
        : n >= 1_000_000
          ? `${(n / 1_000_000).toFixed(2)}M`
          : n >= 1_000
            ? `${(n / 1_000).toFixed(1)}K`
            : `${Math.round(n * 10) / 10}`;

    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({ size: "LETTER", margin: 48 });
      const out = createWriteStream(absPath);
      out.on("finish", () => resolve());
      out.on("error", reject);
      doc.pipe(out);

      const violet = "#8b7bff";
      const ink = "#1b1c33";
      const soft = "#6b6e8f";
      const logo = nodePath.join(env.REPO_ROOT, "design", "app-icon-1024.png");
      try {
        doc.image(logo, 48, 44, { width: 44 });
      } catch {
        // logo missing: header text still renders
      }
      doc.fillColor(violet).fontSize(22).font("Helvetica-Bold").text("Toreroflow", 104, 48);
      doc.fillColor(soft).fontSize(10).font("Helvetica").text("by Torerone", 104, 74);
      doc
        .fillColor(ink)
        .fontSize(17)
        .font("Helvetica-Bold")
        .text(`${data.client.name} performance report`, 48, 116);
      doc
        .fillColor(soft)
        .fontSize(10)
        .font("Helvetica")
        .text(
          `Generated ${new Date().toLocaleDateString([], { dateStyle: "long" })} · last 30 days`,
          48,
          138,
        );

      const kpis: Array<[string, string]> = [
        ["Views", fmt(data.totals.views)],
        ["Reach", fmt(data.totals.reach)],
        ["Followers", fmt(data.totals.followers)],
        [
          "Engagement",
          data.totals.engagementRate == null
            ? "-"
            : `${data.totals.engagementRate.toFixed(1)}%`,
        ],
        [
          "Avg watch",
          data.totals.avgWatchSec == null ? "-" : `${data.totals.avgWatchSec.toFixed(1)}s`,
        ],
        ["Likes", fmt(data.totals.likes)],
      ];
      const boxW = 82;
      kpis.forEach(([label, value], i) => {
        const x = 48 + i * (boxW + 8);
        doc.roundedRect(x, 168, boxW, 56, 8).fillAndStroke("#f3f2fc", "#e2e0f5");
        doc.fillColor(soft).fontSize(8).font("Helvetica").text(label.toUpperCase(), x, 178, {
          width: boxW,
          align: "center",
        });
        doc.fillColor(ink).fontSize(15).font("Helvetica-Bold").text(value, x, 192, {
          width: boxW,
          align: "center",
        });
      });

      let y = 258;
      doc.fillColor(ink).fontSize(13).font("Helvetica-Bold").text("Connected platforms", 48, y);
      y += 22;
      doc.fillColor(soft).fontSize(9).font("Helvetica");
      doc.text("PLATFORM", 48, y);
      doc.text("HANDLE", 170, y);
      doc.text("VIEWS", 330, y, { width: 60, align: "right" });
      doc.text("REACH", 400, y, { width: 60, align: "right" });
      doc.text("FOLLOWERS", 470, y, { width: 80, align: "right" });
      y += 14;
      doc.moveTo(48, y).lineTo(564, y).strokeColor("#e2e0f5").stroke();
      y += 8;
      for (const a of data.accounts) {
        doc.fillColor(ink).fontSize(10).font("Helvetica-Bold").text(
          a.platform[0]!.toUpperCase() + a.platform.slice(1),
          48,
          y,
        );
        doc.fillColor(soft).font("Helvetica").text(`@${a.handle}`, 170, y);
        doc.fillColor(ink).text(fmt(a.latest?.views ?? null), 330, y, { width: 60, align: "right" });
        doc.text(fmt(a.latest?.reach ?? null), 400, y, { width: 60, align: "right" });
        doc.text(fmt(a.latest?.followers ?? null), 470, y, { width: 80, align: "right" });
        y += 20;
      }
      if (!data.hasData) {
        y += 10;
        doc
          .fillColor(soft)
          .fontSize(10)
          .text(
            "Metrics ingestion has just been enabled; numbers appear after the first daily pull.",
            48,
            y,
          );
      }

      doc
        .fontSize(8)
        .fillColor(soft)
        .text("Toreroflow · automated social publishing & analytics", 48, 730);
      doc.end();
    });

    return reply.status(201).send({ url: `/files/${relPath}` });
  });

  /**
   * AI growth suggestions for a client. Uses the operator's ANTHROPIC_API_KEY;
   * without one the endpoint explains how to enable it instead of failing
   * silently. Daily metric ingestion arrives in M5 - until then suggestions
   * lean on the client profile and connection state.
   */
  app.post<{ Params: { id: string } }>(
    "/clients/:id/suggestions",
    async (request, reply) => {
      if (!anthropic) {
        return reply.status(503).send({
          error: "suggestions unavailable",
          detail:
            "Set ANTHROPIC_API_KEY in the repo root .env and restart the API to enable AI suggestions.",
        });
      }

      const client = await prisma.client.findFirst({
        where: {
          id: request.params.id,
          agencyId: request.user.agencyId,
          deletedAt: null,
        },
        include: {
          socialAccounts: {
            where: { deletedAt: null },
            include: {
              metricSnapshots: { orderBy: { capturedAt: "desc" }, take: 14 },
            },
          },
          workflows: true,
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      const accountSummary = client.socialAccounts.length
        ? client.socialAccounts
            .map((a) => {
              const latest = a.metricSnapshots[0];
              const metrics = latest
                ? `views=${latest.views ?? "?"} reach=${latest.reach ?? "?"} followers=${latest.followers ?? "?"} engagement=${latest.engagementRate ?? "?"}% avgWatch=${latest.avgWatchSec ?? "?"}s (captured ${latest.capturedAt.toISOString()})`
                : "no metrics captured yet";
              return `- ${a.platform} @${a.handle} [${a.status}]: ${metrics}`;
            })
            .join("\n")
        : "- no platforms connected yet";

      const response = await anthropic.messages.create({
        model: env.SUGGESTIONS_MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: SUGGESTIONS_SCHEMA },
        },
        system:
          "You are a short-form video growth strategist for a social media agency. " +
          "Give specific, actionable suggestions to improve a client's social analytics. " +
          "When there is no metrics history yet, focus on the highest-leverage setup and " +
          "early-growth moves for their connected platforms. 4 to 6 suggestions, each " +
          "concrete enough to act on this week. No fluff.",
        messages: [
          {
            role: "user",
            content:
              `Client: ${client.name} (plan: ${client.plan ?? "unknown"})\n` +
              `Connected accounts:\n${accountSummary}\n` +
              `Repost workflows configured: ${client.workflows.length}\n` +
              `Agency context: short-form video (Reels/TikTok/Shorts/Spotlight), operator manages posting and analytics via Toreroflow.`,
          },
        ],
      });

      if (response.stop_reason === "refusal") {
        return reply.status(502).send({ error: "model declined the request" });
      }
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") {
        return reply.status(502).send({ error: "empty model response" });
      }
      const parsed = JSON.parse(text.text) as {
        suggestions: Array<{ title: string; detail: string; category: string }>;
      };
      return { clientId: client.id, suggestions: parsed.suggestions };
    },
  );
}
