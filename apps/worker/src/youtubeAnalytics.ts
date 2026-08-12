import {
  applyPlatformMetrics,
  decryptSecret,
  getPrisma,
  type PlatformMetricFields,
} from "@toreroflow/db";
import {
  accessTokenFrom,
  batches,
  GoogleAuthError,
  toStoreFields,
  videoAnalytics,
} from "@toreroflow/publishers";
import { env } from "./env";

/**
 * Pull what only the channel owner can see, for every directly connected
 * YouTube channel.
 *
 * Runs after the catalogue sync, never instead of it, and the order is not
 * incidental. The Data API sync is what creates a video's row and writes its
 * title, thumbnail, duration and lifetime view count. This lays shares, watch
 * time and subscribers gained on top of rows that already exist, and skips any
 * video it has not seen, so a report can never contain a video that is nothing
 * but four numbers and an id.
 *
 * Never throws. A channel whose client revoked consent records that on its own
 * row and the other channels still sync, because one withdrawn permission
 * should not cost a night's numbers for everybody else.
 */

const prisma = getPrisma();

/** YouTube's own founding, the earliest date the Analytics API will accept. */
const EARLIEST = new Date("2005-02-14T00:00:00.000Z");

export interface YouTubeAnalyticsResult {
  handle: string;
  channel: string | null;
  updated: number;
  /** Videos the report answered for that have no row here yet. */
  unmatched: number;
  error?: string;
}

export async function syncYouTubeAnalytics(): Promise<YouTubeAnalyticsResult[]> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return [];

  const connections = await prisma.platformConnection.findMany({
    where: {
      platform: "youtube",
      status: "active",
      socialAccount: { deletedAt: null, client: { deletedAt: null } },
    },
    include: { socialAccount: { select: { id: true, handle: true } } },
  });
  if (!connections.length) return [];

  const client = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  const results: YouTubeAnalyticsResult[] = [];

  for (const connection of connections) {
    const account = connection.socialAccount;
    try {
      const accessToken = await accessTokenFrom(client, decryptSecret(connection.refreshTokenEnc));

      /*
       * Only this account's own videos are asked about, and the window is only
       * as wide as they need. Both come from rows we already hold: there is no
       * point asking YouTube about a video the store has never heard of, since
       * applyPlatformMetrics would skip it anyway.
       */
      const videos = await prisma.externalVideo.findMany({
        where: { socialAccountId: account.id, platform: "youtube" },
        select: { platformVideoId: true, publishedAt: true },
      });
      if (!videos.length) {
        results.push({ handle: account.handle, channel: connection.externalName, updated: 0, unmatched: 0 });
        continue;
      }

      const earliest = videos.reduce(
        (min, v) => (v.publishedAt < min ? v.publishedAt : min),
        videos[0]!.publishedAt,
      );
      const startDate = earliest < EARLIEST ? EARLIEST : earliest;
      const endDate = new Date();

      let updated = 0;
      let unmatched = 0;
      const now = new Date();
      for (const batch of batches(videos.map((v) => v.platformVideoId))) {
        const report = await videoAnalytics(accessToken, batch, startDate, endDate);
        for (const [platformVideoId, analytics] of report) {
          const fields: PlatformMetricFields = toStoreFields(analytics);
          // Nothing reported for this video is nothing to write. Calling
          // through with an empty object would still stamp metricsUpdatedAt,
          // which would claim a freshness the numbers do not have.
          if (!Object.keys(fields).length) continue;
          const applied = await applyPlatformMetrics(
            prisma,
            { socialAccountId: account.id, platformVideoId },
            fields,
            now,
          );
          if (applied) updated++;
          else unmatched++;
        }
      }

      await prisma.platformConnection.update({
        where: { id: connection.id },
        data: { lastSyncedAt: now, error: null },
      });
      results.push({
        handle: account.handle,
        channel: connection.externalName,
        updated,
        unmatched,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      /*
       * A revoked grant is a different fact from a failed request, and only one
       * of them is fixed by waiting. Marking it revoked stops this channel being
       * retried every night forever, and gives the Settings screen something
       * true to say about why its numbers stopped moving.
       */
      const revoked = error instanceof GoogleAuthError && error.revoked;
      await prisma.platformConnection.update({
        where: { id: connection.id },
        data: {
          status: revoked ? "revoked" : connection.status,
          error: message.slice(0, 500),
        },
      });
      console.error(`[worker] youtube analytics failed for @${account.handle}:`, error);
      results.push({
        handle: account.handle,
        channel: connection.externalName,
        updated: 0,
        unmatched: 0,
        error: message,
      });
    }
  }

  const updated = results.reduce((sum, r) => sum + r.updated, 0);
  console.log(
    `[worker] youtube analytics: ${updated} videos updated across ${results.length} connected channels`,
  );
  return results;
}
