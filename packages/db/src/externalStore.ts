import type { Platform, PrismaClient } from "@prisma/client";
import { decodeEscapes } from "@toreroflow/core";

/**
 * The one write path into the rolling store.
 *
 * Zernio only serves about a year of history and told us outright to keep
 * our own copy, so every provider-discovered post lands in ExternalVideo
 * (add or update, never delete) and every write also records that day's
 * numbers in ExternalVideoMetric: one row per video per UTC day, the
 * series future views-over-time charts and the site counter draw from.
 *
 * YouTube rows arrive here too, but through upsertExternalVideo directly
 * from the YouTube catalogue sync. mapProviderEntry refuses youtube on
 * purpose: Zernio's YouTube copy is capped and staler than the Data API,
 * and letting both write the same key would have them fight.
 */

export interface ExternalVideoRow {
  socialAccountId: string;
  platform: Platform;
  platformVideoId: string;
  title: string;
  thumbnailUrl: string | null;
  url: string | null;
  publishedAt: Date;
  views: number;
  likes: number;
  comments: number;
  durationSec: number | null;
}

/** First numeric value among several possible provider field names. */
function num(item: Record<string, unknown>, ...names: string[]): number | null {
  for (const n of names) {
    const v = item[n];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** The UTC calendar day a timestamp falls on, at midnight UTC. */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * One Zernio analytics post entry to one store row, or null when the
 * entry cannot be keyed (no platformPostId), cannot be dated, or belongs
 * to YouTube. Every metric on a store row is the per-platform value: the
 * entry's own number when it reports one, otherwise an even split of the
 * post total across the `entryCount` platform entries attributed to the
 * post, exactly like the screen's byPlatform math. For a single-entry
 * post that equals the screen's top-line numbers; for a cross-post the
 * sibling rows sum to them. Duration is post-level only, there is no
 * per-platform duration to prefer.
 */
export function mapProviderEntry(
  post: Record<string, unknown>,
  entry: Record<string, unknown>,
  account: { socialAccountId: string; platform: Platform },
  entryCount = 1,
): ExternalVideoRow | null {
  if (account.platform === "youtube") return null;

  const platformVideoId =
    typeof entry.platformPostId === "string" && entry.platformPostId ? entry.platformPostId : null;
  if (!platformVideoId) return null;

  const publishedAt = new Date(String(post.publishedAt ?? post.scheduledFor ?? ""));
  if (Number.isNaN(publishedAt.getTime())) return null;

  const em = (entry.analytics ?? {}) as Record<string, unknown>;
  const pm = (post.analytics ?? {}) as Record<string, unknown>;
  const entryViews = num(em, "views", "impressions", "plays");
  const postViews = num(pm, "views", "impressions", "plays") ?? 0;
  const entryLikes = num(em, "likes", "likeCount");
  const postLikes = num(pm, "likes", "likeCount") ?? 0;
  const entryComments = num(em, "comments", "commentCount");
  const postComments = num(pm, "comments", "commentCount") ?? 0;

  return {
    socialAccountId: account.socialAccountId,
    platform: account.platform,
    platformVideoId,
    title:
      typeof post.content === "string" && post.content.trim()
        ? decodeEscapes(post.content.trim())
        : "(untitled)",
    thumbnailUrl: typeof post.thumbnailUrl === "string" ? post.thumbnailUrl : null,
    url: typeof post.platformPostUrl === "string" ? post.platformPostUrl : null,
    publishedAt,
    views: entryViews ?? (entryCount <= 1 ? postViews : Math.round(postViews / entryCount)),
    likes: entryLikes ?? (entryCount <= 1 ? postLikes : Math.round(postLikes / entryCount)),
    comments:
      entryComments ?? (entryCount <= 1 ? postComments : Math.round(postComments / entryCount)),
    durationSec: num(pm, "duration", "videoDuration", "durationSec", "mediaDuration"),
  };
}

/**
 * Upsert one store row and its metric row for `now`'s UTC day. A second
 * run the same day overwrites the day's numbers instead of duplicating,
 * which is what makes boot catch-up plus the daily job plus manual
 * refreshes safe to stack.
 */
export async function upsertExternalVideo(
  prisma: PrismaClient,
  row: ExternalVideoRow,
  now = new Date(),
): Promise<void> {
  const { socialAccountId, platformVideoId, ...rest } = row;
  const data = { ...rest, fetchedAt: now };
  const video = await prisma.externalVideo.upsert({
    where: { socialAccountId_platformVideoId: { socialAccountId, platformVideoId } },
    create: { socialAccountId, platformVideoId, ...data },
    update: data,
  });

  const capturedOn = utcDay(now);
  const metrics = { views: row.views, likes: row.likes, comments: row.comments };
  await prisma.externalVideoMetric.upsert({
    where: { externalVideoId_capturedOn: { externalVideoId: video.id, capturedOn } },
    create: { externalVideoId: video.id, capturedOn, ...metrics },
    update: metrics,
  });
}

/**
 * Persist every mappable entry of a provider analytics pull. Entries whose
 * accountId is not one of ours are skipped, so one global pull can be
 * attributed across every connected account in a single pass. Returns the
 * number of rows written.
 */
export async function persistProviderPosts(
  prisma: PrismaClient,
  posts: Array<Record<string, unknown>>,
  accountsByProviderId: Map<string, { socialAccountId: string; platform: Platform }>,
): Promise<number> {
  let written = 0;
  const now = new Date();
  // ponytail: serial per-row upserts, batch with createMany/transactions if ingest volume ever hurts
  for (const post of posts) {
    const entries = Array.isArray(post.platforms)
      ? (post.platforms as Array<Record<string, unknown>>)
      : [];
    // Denominator mirrors the screen, which counts youtube entries in its
    // split too; only entries with one of our accounts get resolved here.
    const resolved = entries.filter(
      (e) => typeof e.accountId === "string" && accountsByProviderId.has(e.accountId as string),
    );
    for (const entry of resolved) {
      const account = accountsByProviderId.get(entry.accountId as string);
      if (!account) continue;
      const row = mapProviderEntry(post, entry, account, resolved.length);
      if (!row) continue;
      await upsertExternalVideo(prisma, row, now);
      written++;
    }
  }
  return written;
}
