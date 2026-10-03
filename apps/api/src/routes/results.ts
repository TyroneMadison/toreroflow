import type { FastifyInstance } from "fastify";
import { followerChange, viewTotals, type PublishedPost } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { requireAuth } from "../plugins/requireAuth";
import { draftName } from "./posts";

/**
 * Results since a client joined: the agency's own case study, per client.
 *
 * Reads local tables only. Views come from the platform counts the nightly
 * sync records against each post the app published; followers come from the
 * daily snapshots. Both are already stored, which is why this needs no new
 * tracking and works back to the day each client was added.
 */
export async function resultsRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.get<{ Params: { id: string } }>("/clients/:id/results", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
      select: {
        createdAt: true,
        socialAccounts: {
          // Reminder accounts post by email and have no audience to count.
          where: { deletedAt: null, status: "connected", NOT: { tokensEncrypted: "reminder" } },
          select: { id: true, platform: true, handle: true },
        },
      },
    });
    if (!client) return reply.status(404).send({ error: "client not found" });
    const joinedAt = client.createdAt;

    const [snapshots, targets] = await Promise.all([
      prisma.metricSnapshot.findMany({
        where: {
          socialAccountId: { in: client.socialAccounts.map((a) => a.id) },
          followers: { not: null },
        },
        select: { socialAccountId: true, capturedAt: true, followers: true },
      }),
      prisma.postTarget.findMany({
        where: { status: "posted", post: { clientId: request.params.id, deletedAt: null } },
        select: {
          id: true,
          platform: true,
          remoteUrl: true,
          publishedAt: true,
          post: {
            select: {
              mediaAssetId: true,
              mediaAsset: { select: { kind: true, draftCopy: true, originalName: true } },
            },
          },
        },
      }),
    ]);

    // The latest real count per post, one row each. A nested take would load
    // every day's row for every post and trim them in memory.
    const ids = targets.map((t) => t.id);
    const latestRows = ids.length
      ? await prisma.$queryRaw<Array<{ postTargetId: string; views: number; capturedAt: Date }>>`
          SELECT DISTINCT ON ("postTargetId") "postTargetId", views, "capturedAt"
          FROM "PostMetric"
          WHERE "postTargetId" = ANY(${ids}) AND views IS NOT NULL
          ORDER BY "postTargetId", "capturedAt" DESC`
      : [];
    const latest = new Map(latestRows.map((r) => [r.postTargetId, r]));

    /*
     * Posts the provider stopped reporting on. When an account is reconnected
     * at the provider, the posts published under the old connection drop out
     * of its analytics, but the stored catalogue still holds their last count
     * under the same link. Matched on the exact link, so a post is only ever
     * credited with its own views.
     */
    const unreported = targets.filter((t) => !latest.has(t.id) && t.remoteUrl);
    const stored = unreported.length
      ? await prisma.externalVideo.findMany({
          where: {
            url: { in: unreported.map((t) => t.remoteUrl!) },
            socialAccount: { clientId: request.params.id },
          },
          select: { url: true, views: true },
        })
      : [];
    const storedViews = new Map<string, number>();
    for (const v of stored) {
      if (v.url) storedViews.set(v.url, Math.max(storedViews.get(v.url) ?? 0, v.views));
    }

    const posts: PublishedPost[] = targets.map((t) => ({
      platform: t.platform,
      title: draftName(t.post.mediaAsset?.draftCopy) || t.post.mediaAsset?.originalName || "Untitled video",
      url: t.remoteUrl,
      publishedAt: t.publishedAt?.toISOString() ?? null,
      views: latest.get(t.id)?.views ?? (t.remoteUrl ? storedViews.get(t.remoteUrl) : undefined) ?? null,
    }));
    const lastCounted = latestRows
      .map((r) => r.capturedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const kinds = new Map(
      targets.filter((t) => t.post.mediaAssetId).map((t) => [t.post.mediaAssetId, t.post.mediaAsset?.kind]),
    );
    const carousels = [...kinds.values()].filter((k) => k === "carousel").length;

    return {
      joinedAt: joinedAt.toISOString(),
      days: Math.max(0, Math.floor((Date.now() - joinedAt.getTime()) / 86_400_000)),
      published: {
        posts: targets.length,
        videos: kinds.size - carousels,
        carousels,
      },
      views: viewTotals(posts),
      viewsCountedAt: lastCounted?.toISOString() ?? null,
      accounts: client.socialAccounts.map((a) => ({
        platform: a.platform,
        handle: a.handle,
        followers: followerChange(
          snapshots.filter((s) => s.socialAccountId === a.id),
          joinedAt,
        ),
      })),
    };
  });
}
