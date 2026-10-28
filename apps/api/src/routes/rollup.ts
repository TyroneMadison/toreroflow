import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";
import { WorkflowPlatformSchema } from "@toreroflow/contracts";
import { requireAuth } from "../plugins/requireAuth";
import { buildRollup, type RollupSource } from "../workflow/rollup";

/**
 * W4: GET /rollup/:videoId joins every published post of one source video
 * (a MediaAsset) across YouTube, Instagram and TikTok. Read-only, and separate
 * from the post insights endpoints, which it does not touch.
 *
 * Per target, the platform's own stored numbers (ExternalVideo, matched on
 * the account and the post URL) win, as in mergedPosts; otherwise the latest
 * PostMetric snapshot, which has no watch time. Instagram stories are not the
 * video's post and are left out.
 */
export async function rollupRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.get<{ Params: { videoId: string } }>("/rollup/:videoId", async (request, reply) => {
    const { videoId } = request.params;
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: videoId, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!asset) return reply.status(404).send({ error: "video not found" });

    const targets = await prisma.postTarget.findMany({
      where: {
        status: "posted",
        platform: { in: WorkflowPlatformSchema.options },
        post: { mediaAssetId: videoId, deletedAt: null },
      },
      select: {
        platform: true,
        socialAccountId: true,
        remoteUrl: true,
        options: true,
        postMetrics: { orderBy: { capturedAt: "desc" }, take: 1 },
      },
    });
    const posts = targets.filter((t) => !(t.options as { instagram?: { story?: boolean } } | null)?.instagram?.story);
    const urls = posts.flatMap((t) => (t.remoteUrl ? [t.remoteUrl] : []));
    const externals = urls.length
      ? await prisma.externalVideo.findMany({
          where: { url: { in: urls } },
          select: { socialAccountId: true, url: true, views: true, likes: true, comments: true, shares: true, avgWatchSec: true },
        })
      : [];

    const sources: RollupSource[] = posts.map((t) => {
      const platform = WorkflowPlatformSchema.parse(t.platform);
      const ext = externals.find((e) => e.socialAccountId === t.socialAccountId && e.url === t.remoteUrl);
      if (ext) return { platform, ...ext };
      const m = t.postMetrics[0];
      return {
        platform,
        views: m?.views ?? null,
        likes: m?.likes ?? null,
        comments: m?.comments ?? null,
        shares: m?.shares ?? null,
        avgWatchSec: null,
      };
    });
    return buildRollup(videoId, sources);
  });
}
