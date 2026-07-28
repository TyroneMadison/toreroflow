import type { PrismaClient } from "@toreroflow/db";
import { upsertExternalVideo } from "@toreroflow/db";
import type { YouTubeProvider } from "@toreroflow/publishers";

/**
 * Pulls a client's whole YouTube catalogue straight from YouTube.
 *
 * The publishing provider only keeps a recent rolling window, so all-time
 * rankings need the platform itself. Rows are upserted, so repeat runs
 * refresh view counts rather than duplicating them. Every write also records
 * the day's numbers through the shared store.
 *
 * Shared by the Analytics refresh and the report refresh: a report reads the
 * same `ExternalVideo` rows through buildMergedPosts, so updating a report's
 * numbers means running exactly this first.
 *
 * Never throws. A channel that fails reports its error and the others still
 * import, because losing one channel should not cost a whole refresh.
 */

export interface YouTubeSyncResult {
  handle: string;
  imported: number;
  channel?: string;
  error?: string;
}

export interface YouTubeSyncDeps {
  prisma: PrismaClient;
  youtube: YouTubeProvider | null;
  logError(error: unknown, message: string): void;
}

export async function syncYouTubeCatalogue(
  deps: YouTubeSyncDeps,
  accounts: Array<{ id: string; handle: string }>,
): Promise<YouTubeSyncResult[]> {
  if (!deps.youtube) return [];
  const results: YouTubeSyncResult[] = [];

  for (const account of accounts) {
    try {
      const { channelTitle, videos } = await deps.youtube.allVideosForChannel(account.handle);
      for (const v of videos) {
        await upsertExternalVideo(deps.prisma, {
          socialAccountId: account.id,
          platform: "youtube",
          platformVideoId: v.platformVideoId,
          title: v.title,
          thumbnailUrl: v.thumbnailUrl,
          url: v.url,
          publishedAt: new Date(v.publishedAt),
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          durationSec: v.durationSec,
        });
      }
      results.push({ handle: account.handle, channel: channelTitle, imported: videos.length });
    } catch (error) {
      deps.logError(error, "youtube sync failed");
      results.push({
        handle: account.handle,
        imported: 0,
        error: error instanceof Error ? error.message : "sync failed",
      });
    }
  }

  return results;
}
