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
          platform: true,
          remoteUrl: true,
          publishedAt: true,
          post: { select: { mediaAssetId: true, mediaAsset: { select: { draftCopy: true, originalName: true } } } },
          postMetrics: { orderBy: { capturedAt: "desc" }, take: 1, select: { views: true, capturedAt: true } },
        },
      }),
    ]);

    const posts: PublishedPost[] = targets.map((t) => ({
      platform: t.platform,
      title: draftName(t.post.mediaAsset?.draftCopy) || t.post.mediaAsset?.originalName || "Untitled video",
      url: t.remoteUrl,
      publishedAt: t.publishedAt?.toISOString() ?? null,
      views: t.postMetrics[0]?.views ?? null,
    }));
    const lastCounted = targets
      .map((t) => t.postMetrics[0]?.capturedAt)
      .filter((d): d is Date => d != null)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      joinedAt: joinedAt.toISOString(),
      days: Math.max(0, Math.floor((Date.now() - joinedAt.getTime()) / 86_400_000)),
      published: {
        posts: targets.length,
        videos: new Set(targets.map((t) => t.post.mediaAssetId).filter(Boolean)).size,
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
