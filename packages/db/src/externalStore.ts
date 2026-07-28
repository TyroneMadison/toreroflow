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
 * to YouTube. Field picks mirror the merge in mergedPosts.ts so a stored
 * number can never differ from what the screen computed live.
 */
export function mapProviderEntry(
  post: Record<string, unknown>,
  entry: Record<string, unknown>,
  account: { socialAccountId: string; platform: Platform },
): ExternalVideoRow | null {
  if (account.platform === "youtube") return null;

  const platformVideoId =
    typeof entry.platformPostId === "string" && entry.platformPostId ? entry.platformPostId : null;
  if (!platformVideoId) return null;

  const publishedAt = new Date(String(post.publishedAt ?? post.scheduledFor ?? ""));
  if (Number.isNaN(publishedAt.getTime())) return null;

  const em = (entry.analytics ?? {}) as Record<string, unknown>;
  const pm = (post.analytics ?? {}) as Record<string, unknown>;
  const pick = (...names: string[]) => num(em, ...names) ?? num(pm, ...names);

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
    views: pick("views", "impressions", "plays") ?? 0,
    likes: pick("likes", "likeCount") ?? 0,
    comments: pick("comments", "commentCount") ?? 0,
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
  for (const post of posts) {
    const entries = Array.isArray(post.platforms)
      ? (post.platforms as Array<Record<string, unknown>>)
      : [];
    for (const entry of entries) {
      const accountId = typeof entry.accountId === "string" ? entry.accountId : null;
      const account = accountId ? accountsByProviderId.get(accountId) : undefined;
      if (!account) continue;
      const row = mapProviderEntry(post, entry, account);
      if (!row) continue;
      await upsertExternalVideo(prisma, row);
      written++;
    }
  }
  return written;
}
