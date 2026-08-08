import type { FastifyInstance } from "fastify";
import { fileLink, fileLinkVersioned } from "../files/link";
import nodePath from "node:path";
import { promises as fsp, createWriteStream } from "node:fs";
import PDFDocument from "pdfkit";
import {
  connectAccountSchema,
  contactSchema,
  createClientSchema,
  isRunning,
  platformSchema,
  PLATFORMS,
  type Platform,
} from "@toreroflow/core";
import { z } from "zod";
import { getPrisma, enqueue } from "@toreroflow/db";
import {
  DryRunPublisher,
  YouTubeProvider,
  ZernioError,
  ZernioProvider,
} from "@toreroflow/publishers";
import {
  syncYouTubeCatalogue,
  type YouTubeSyncResult,
} from "../analytics/youtubeSync";
import { buildMergedPosts } from "../analytics/mergedPosts";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import { withReportPage } from "../reports/onboardHook";
import { ensureReportSlug } from "../reports/slug";

const NOT_FOUND = { error: "client not found" } as const;

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
  format: z.enum(["short_form", "long_form", "carousel"]).optional(),
  target: z.number().int().min(0).max(10_000).nullable().optional(),
  adjustment: z.number().int().min(-10_000).max(10_000).optional(),
  adjustBy: z.number().int().min(-1_000).max(1_000).optional(),
  /** Starts a new pay period for both formats at once. */
  reset: z.boolean().optional(),
});

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  // The model call itself lives on the worker now. All this route needs to
  // know is whether asking for one can possibly work.
  const hasAnthropicKey = Boolean(env.ANTHROPIC_API_KEY);
  const zernio =
    env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY
      ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY)
      : null;
  const youtube = env.YOUTUBE_API_KEY ? new YouTubeProvider(env.YOUTUBE_API_KEY) : null;

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
          include: {
            // Newest snapshot that actually recorded a follower count, so a
            // same-day snapshot written before the follower pull does not
            // mask the real number.
            metricSnapshots: {
              where: { followers: { not: null } },
              orderBy: { capturedAt: "desc" },
              take: 1,
              select: { followers: true },
            },
          },
        },
        _count: { select: { workflows: true } },
      },
    });
    return clients.map((c) => {
      const accounts = c.socialAccounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        handle: a.handle,
        status: a.status,
        connectedAt: a.connectedAt,
        avatarUrl: a.avatarUrl,
        displayName: a.displayName,
        followers: a.metricSnapshots[0]?.followers ?? null,
      }));
      const known = accounts.filter((a) => a.followers != null);
      return {
        id: c.id,
        name: c.name,
        avatarSeed: c.avatarSeed,
        plan: c.plan,
        contactName: c.contactName,
        contactEmail: c.contactEmail,
        contactPhone: c.contactPhone,
        /** What they told us their own accounts are. Not connected accounts. */
        handles: (c.handles ?? null) as Record<string, string> | null,
        monthlyPriceCents: c.monthlyPriceCents,
        billingMode: c.billingMode,
        createdAt: c.createdAt,
        workflowCount: c._count.workflows,
        accounts,
        // Null rather than 0 when nothing is known, so the UI can say so
        // instead of claiming a real zero.
        totalFollowers: known.length
          ? known.reduce((s, a) => s + (a.followers ?? 0), 0)
          : null,
      };
    });
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
    // The report path is claimed here, at onboarding, and never changes for
    // the life of the client.
    const reportSlug = await ensureReportSlug(prisma, client);

    // Their page goes up now too, so the link works the moment it exists
    // rather than only after the first month-end publish. Not awaited: a slow
    // Netlify deploy must not hold up onboarding, and the page can be rebuilt
    // with one button if this run fails.
    void withReportPage(
      (h) => h.publish(client.id),
      (err) => app.log.error({ err, clientId: client.id }, "could not publish the new client's report page"),
    );

    return reply.status(201).send({ ...client, reportSlug });
  });

  /**
   * Who to contact at this client.
   *
   * Every field is optional and independently clearable: an empty string
   * means "I do not have this" and is stored as null, so a blanked phone
   * number does not linger as an empty string that reads as a value.
   */
  app.patch<{
    Params: { id: string };
    Body: { contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null };
  }>("/clients/:id/contact", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);

    const body = contactSchema.parse(request.body);
    const clean = (v: string | null | undefined) =>
      v === undefined ? undefined : v === null || v.trim() === "" ? null : v.trim();

    const updated = await prisma.client.update({
      where: { id: client.id },
      data: {
        ...(body.contactName !== undefined ? { contactName: clean(body.contactName) } : {}),
        ...(body.contactEmail !== undefined ? { contactEmail: clean(body.contactEmail) } : {}),
        ...(body.contactPhone !== undefined ? { contactPhone: clean(body.contactPhone) } : {}),
      },
      select: { contactName: true, contactEmail: true, contactPhone: true },
    });
    return updated;
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

    /*
     * Offboarding reaches the publishing provider too.
     *
     * Removing a client here used to leave their workspace standing at the
     * provider with their Instagram still authorised to it: a standing charge
     * for a client who left, and an access nobody agreed to keep. Every
     * account is disconnected first because connected ones refuse the profile
     * delete, then the workspace itself goes.
     *
     * Best effort, and deliberately before the local delete: if the provider
     * is unreachable the operator's own record still goes, because refusing to
     * offboard a client while a third party is down is the wrong answer. What
     * failed is logged and can be cleared by hand.
     */
    if (zernio) {
      const remoteAccounts = await prisma.socialAccount.findMany({
        where: { clientId: client.id, deletedAt: null, providerAccountId: { not: null } },
        select: { id: true, providerAccountId: true, platform: true },
      });
      for (const account of remoteAccounts) {
        try {
          await zernio.disconnectAccount(account.providerAccountId!);
        } catch (err) {
          app.log.error(
            { err, platform: account.platform },
            "could not disconnect the account at the provider while offboarding",
          );
        }
      }
      if (client.providerProfileId) {
        try {
          await zernio.deleteProfile(client.providerProfileId);
        } catch (err) {
          app.log.error(
            { err, profileId: client.providerProfileId },
            "could not delete the client's workspace at the provider while offboarding",
          );
        }
      }
    }

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

    // Offboarding takes their page off the public web with them. Their
    // numbers should not outlive the relationship, and a page nothing in the
    // app points at any more is exactly the kind of orphan that accumulates.
    // Awaited, unlike the publish on create: leaving a client's report public
    // after they have been removed is worth a couple of seconds.
    if (client.reportSlug) {
      const slug = client.reportSlug;
      await withReportPage(
        (h) => h.unpublish(slug),
        (err) => app.log.error({ err, slug }, "could not remove the offboarded client's report page"),
      );
    }
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
          await enqueue("analytics", {});
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
        quotaCarousel: true,
        quotaResetAt: true,
        adjustShort: true,
        adjustLong: true,
        adjustCarousel: true,
      },
    });
    if (!client) return null;
    const since = client.quotaResetAt ?? new Date(0);
    const inPeriod = { clientId, createdAt: { gte: since } };

    const count = (extra: Record<string, unknown>) =>
      prisma.mediaAsset.count({ where: { ...inPeriod, ...extra } });

    // Videos still being probed have no format yet. They are counted as
    // short-form, which is the common case, and correct themselves within
    // seconds once the duration is known. Every video count carries
    // kind: "video", because a carousel also has a null format and was being
    // quietly counted as an unclassified short before it had its own bucket.
    const [shortUploads, longUploads, shortRevs, longRevs] = await Promise.all([
      count({ isRevision: false, kind: "video", format: { in: ["short_form"] } }),
      count({ isRevision: false, kind: "video", format: "long_form" }),
      count({ isRevision: true, kind: "video", format: { in: ["short_form"] } }),
      count({ isRevision: true, kind: "video", format: "long_form" }),
    ]);
    const [unclassifiedUploads, unclassifiedRevs] = await Promise.all([
      count({ isRevision: false, kind: "video", format: null }),
      count({ isRevision: true, kind: "video", format: null }),
    ]);
    const [carouselUploads, carouselRevs] = await Promise.all([
      count({ isRevision: false, kind: "carousel" }),
      count({ isRevision: true, kind: "carousel" }),
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
      carousel: section(
        client.quotaCarousel,
        client.adjustCarousel,
        carouselUploads,
        carouselRevs,
      ),
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
      select: { id: true, adjustShort: true, adjustLong: true, adjustCarousel: true },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);

    const fmt = body.format === "long_form" ? "long" : body.format === "carousel" ? "carousel" : "short";
    const targetKey = { short: "quotaShort", long: "quotaLong", carousel: "quotaCarousel" }[fmt];
    const adjustKey = { short: "adjustShort", long: "adjustLong", carousel: "adjustCarousel" }[fmt];
    const currentAdjust = { short: client.adjustShort, long: client.adjustLong, carousel: client.adjustCarousel }[fmt];

    const data: Record<string, number | null | Date> = {};
    // Clearing a target stops tracking that format, so its correction goes
    // with it rather than lingering for the next time it is switched on.
    if (body.target !== undefined) {
      data[targetKey] = body.target;
      if (body.target === null) data[adjustKey] = 0;
    }
    if (body.adjustment !== undefined) data[adjustKey] = body.adjustment;
    if (body.adjustBy !== undefined) {
      const base = (data[adjustKey] as number | undefined) ?? currentAdjust;
      const before = await quotaView(client.id);
      const uploads = before ? before[fmt].uploads : 0;
      // Never let the correction push the count below zero: without this the
      // adjustment keeps sinking while the displayed total sits at 0, and
      // clicking plus appears to do nothing until the debt is repaid.
      data[adjustKey] = Math.max(-uploads, base + body.adjustBy);
    }
    // A new period restarts every format and drops their corrections.
    if (body.reset) {
      data.quotaResetAt = new Date();
      data.adjustShort = 0;
      data.adjustLong = 0;
      data.adjustCarousel = 0;
    }

    await prisma.client.update({ where: { id: client.id }, data });
    return await quotaView(client.id);
  });

  /**
   * Pull whole YouTube catalogues for a client's connected channels, then
   * drop the cached posts so the next read sees them.
   *
   * The sync itself lives in ../analytics/youtubeSync because the report
   * refresh needs exactly the same pull: a report reads these rows through
   * buildMergedPosts, so its numbers are only as current as this.
   */
  const syncYouTubeForClient = async (
    clientId: string,
    accounts: Array<{ id: string; handle: string }>,
  ): Promise<YouTubeSyncResult[]> => {
    const results = await syncYouTubeCatalogue(
      { prisma, youtube, logError: (err, msg) => app.log.error({ err }, msg) },
      accounts,
    );
    postsCache.delete(clientId);
    return results;
  };

  /**
   * Pull a client's whole YouTube catalogue straight from YouTube.
   *
   * The publishing provider only keeps a recent window, so all-time
   * rankings need the platform itself. Rows are upserted, which also
   * refreshes view counts on later syncs.
   */
  app.post<{ Params: { id: string } }>(
    "/clients/:id/external/youtube/sync",
    async (request, reply) => {
      if (!youtube) {
        return reply.status(503).send({
          error: "YOUTUBE_API_KEY is not set; add it to .env to read lifetime YouTube history",
        });
      }
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        include: {
          socialAccounts: { where: { deletedAt: null, platform: "youtube" } },
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);
      if (!client.socialAccounts.length) {
        return reply.status(400).send({ error: "no YouTube account connected for this client" });
      }

      const results = await syncYouTubeForClient(client.id, client.socialAccounts);
      return { results };
    },
  );

  /**
   * The client's stored YouTube catalogue, for the schedule modal's
   * related-video picker. Reads the rolling store only; no live call, so
   * it is fast and works offline from YouTube.
   */
  app.get<{ Params: { id: string } }>(
    "/clients/:id/external/youtube/videos",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        select: { id: true },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);
      const videos = await prisma.externalVideo.findMany({
        where: {
          platform: "youtube",
          socialAccount: { clientId: client.id, deletedAt: null },
        },
        select: {
          platformVideoId: true,
          title: true,
          thumbnailUrl: true,
          url: true,
          publishedAt: true,
          views: true,
        },
        orderBy: { publishedAt: "desc" },
      });
      return { videos };
    },
  );

  /**
   * The channel's public playlists for the schedule modal dropdown. An
   * unconfigured provider, a missing account, or a failed fetch degrades
   * to an empty list, because scheduling must never depend on this.
   */
  app.get<{ Params: { id: string } }>(
    "/clients/:id/external/youtube/playlists",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        include: {
          socialAccounts: { where: { deletedAt: null, platform: "youtube" } },
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);
      const handle = client.socialAccounts[0]?.handle;
      if (!youtube || !handle) return { playlists: [] };
      try {
        return { playlists: await youtube.listPlaylists(handle) };
      } catch (error) {
        request.log.error({ err: error }, "youtube playlists fetch failed");
        return { playlists: [] };
      }
    },
  );

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
        include: {
          socialAccounts: { where: { deletedAt: null, platform: "youtube" } },
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      // Clearing the cache is what makes the next posts fetch hit the
      // provider live, so newest uploads and view counts are current
      // immediately. The queued ingest refreshes follower snapshots and
      // per-day history right behind it.
      postsCache.delete(client.id);
      await enqueue("analytics", {});

      // Lifetime YouTube counts move too, so refresh them in the same
      // action rather than leaving a stale catalogue behind a fresh window.
      const youtubeResults = await syncYouTubeForClient(client.id, client.socialAccounts);

      return {
        ok: true,
        refreshedAt: new Date().toISOString(),
        youtube: youtubeResults,
      };
    },
  );

  /**
   * Live per-post analytics for the Analytics screen: every provider post
   * (including pre-existing platform content) belonging to this client's
   * profile, with title, thumbnail, publish date, and metrics. Cached
   * briefly so brand switches don't hammer the provider. The merge lives
   * in buildMergedPosts, shared with the client reports, so the screen
   * and a PDF can never disagree.
   */
  app.get<{ Params: { id: string } }>(
    "/clients/:id/analytics/posts",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        select: { id: true },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      const cached = postsCache.get(client.id);
      if (cached && Date.now() - cached.at < POSTS_TTL_MS) return { posts: cached.posts };

      const posts = await buildMergedPosts(
        { prisma: prisma as never, zernio, log: request.log },
        client.id,
        request.user.agencyId,
      );
      if (!posts) return reply.status(404).send(NOT_FOUND);

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

    return reply.status(201).send({ url: fileLink(relPath) });
  });

  /** The stored row in the shape the app reads. */
  const insightView = (row: {
    status: string;
    suggestions: unknown;
    storageKey: string | null;
    error: string | null;
    requestedAt: Date;
    completedAt: Date | null;
  }) => ({
    status: row.status,
    suggestions: (row.suggestions ?? null) as
      | Array<{ title: string; detail: string; category: string }>
      | null,
    // The file name is fixed so regenerating overwrites in place, which means
    // a viewer would happily show the previous plan from cache. The stamp
    // changes every run, so it never can.
    url: row.storageKey
      ? fileLinkVersioned(row.storageKey, row.completedAt?.getTime() ?? row.requestedAt.getTime())
      : null,
    error: row.error,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt,
  });

  /**
   * Start a "what to do next" run.
   *
   * The model call and the PDF render happen on the worker's `insights`
   * queue, so this returns as soon as the row is marked running: the
   * operator asked not to be held at the screen while it thinks.
   *
   * The key check stays here rather than moving to the worker, because a
   * missing key can be answered instantly and the message is the fix.
   */
  app.post<{ Params: { id: string } }>(
    "/clients/:id/suggestions",
    async (request, reply) => {
      if (!hasAnthropicKey) {
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
        select: { id: true },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      // A second press while one is in flight returns the run already going.
      // Without this an impatient double click bills a second model call and
      // races the first one's write.
      const existing = await prisma.clientInsight.findUnique({
        where: { clientId: client.id },
      });
      if (existing && isRunning(existing.status)) {
        return reply.status(202).send(insightView(existing));
      }

      const row = await prisma.clientInsight.upsert({
        where: { clientId: client.id },
        create: { clientId: client.id, status: "running" },
        update: {
          status: "running",
          error: null,
          requestedAt: new Date(),
          completedAt: null,
        },
      });

      // Keyed on the client, so a second press while one is still queued is
      // dropped, which is the same guard one layer down.
      await enqueue("insights", { clientId: client.id }, { key: client.id });

      return reply.status(202).send(insightView(row));
    },
  );

  /** The current run, or null when this client has never generated one. */
  app.get<{ Params: { id: string } }>(
    "/clients/:id/suggestions",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: {
          id: request.params.id,
          agencyId: request.user.agencyId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      const row = await prisma.clientInsight.findUnique({
        where: { clientId: client.id },
      });
      return row ? insightView(row) : null;
    },
  );
}
