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
  /** video | image | carousel, as the provider reports it. */
  mediaType?: string;
  title: string;
  thumbnailUrl: string | null;
  url: string | null;
  publishedAt: Date;
  views: number;
  likes: number;
  comments: number;
  /**
   * Optional because YouTube reports none of them. The Data API has no save
   * button, no per-video reach and no follows-from-this-video, so a YouTube
   * row genuinely holds zero rather than an unknown. Zernio's entries always
   * set them explicitly.
   */
  shares?: number;
  saves?: number;
  reach?: number;
  follows?: number;
  /** Null when the platform does not report it. Never coerce to 0. */
  impressions?: number | null;
  clicks?: number | null;
  /**
   * Seconds. Converted from the provider's milliseconds in mapProviderEntry,
   * which also turns a reported zero into null: a video with views was not
   * watched for zero seconds by every viewer, so a zero here is a metric the
   * provider never computed. Reach follows the same rule at display time. See
   * ZERO_IS_UNMEASURED in packages/core for the metrics this applies to and,
   * more importantly, the ones it deliberately does not.
   */
  avgWatchSec?: number | null;
  totalWatchSec?: number | null;
  engagementRate?: number | null;
  metricsUpdatedAt?: Date | null;
  /** zernio or youtube. Defaults to zernio at the database. */
  source?: string;
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

/** The provider's "2026-08-10 21:16:37" to a Date, or null. Guards against values that already carry a zone marker. */
export function providerDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  // The zone test is anchored as a whole. Written as `/[Zz]|[+-]\d\d:?\d\d$/`
  // the anchor binds only to the offset alternative, so any string with a z
  // anywhere in it counted as zone-marked and lost its UTC assumption.
  const d = new Date(v.replace(" ", "T") + (/([Zz]|[+-]\d\d:?\d\d)$/.test(v) ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Milliseconds to seconds, or null. The one place this conversion happens.
 *
 * Absent or zero milliseconds both yield null. A provider reporting zero
 * average watch time on a video with views means the metric is uncomputed,
 * not measured. Storing null prevents client reports from claiming zero
 * retention on a viewed video, which would be worse than showing nothing.
 * Unlike clicks or saves (which can genuinely be zero), watch time on a
 * viewed video cannot truly be zero.
 */
function msToSec(ms: number | null): number | null {
  return ms != null && ms > 0 ? ms / 1000 : null;
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

  /**
   * One metric for this platform entry: its own figure when it reports one,
   * otherwise the post total shared evenly across the entries attributed to
   * the post. Every metric follows the same rule, so a cross-post's sibling
   * rows always add back up to the post's own numbers.
   */
  const metric = (...names: string[]): number => {
    const own = num(em, ...names);
    if (own !== null) return own;
    const whole = num(pm, ...names) ?? 0;
    return entryCount <= 1 ? whole : Math.round(whole / entryCount);
  };

  return {
    socialAccountId: account.socialAccountId,
    platform: account.platform,
    platformVideoId,
    mediaType: typeof post.mediaType === "string" && post.mediaType ? post.mediaType : "video",
    title:
      typeof post.content === "string" && post.content.trim()
        ? decodeEscapes(post.content.trim())
        : "(untitled)",
    thumbnailUrl: typeof post.thumbnailUrl === "string" ? post.thumbnailUrl : null,
    url: typeof post.platformPostUrl === "string" ? post.platformPostUrl : null,
    publishedAt,
    views: metric("views", "impressions", "plays"),
    likes: metric("likes", "likeCount"),
    comments: metric("comments", "commentCount"),
    shares: metric("shares", "shareCount"),
    saves: metric("saves", "saved", "savedCount"),
    reach: metric("reach"),
    follows: metric("follows", "followsCount", "followers_gained"),
    impressions: num(em, "impressions"),
    clicks: num(em, "clicks"),
    avgWatchSec: msToSec(num(em, "igReelsAvgWatchTime")),
    totalWatchSec: msToSec(num(em, "igReelsVideoViewTotalTime")),
    engagementRate: num(em, "engagementRate"),
    metricsUpdatedAt: providerDate(em.lastUpdated ?? pm.lastUpdated),
    source: "zernio",
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
  const data = {
    ...rest,
    mediaType: row.mediaType ?? "video",
    shares: row.shares ?? 0,
    saves: row.saves ?? 0,
    reach: row.reach ?? 0,
    follows: row.follows ?? 0,
    // The nullable set passes through untouched. No ?? 0 here, ever: that
    // would turn "this platform does not report it" into "it was zero".
    impressions: row.impressions ?? null,
    clicks: row.clicks ?? null,
    avgWatchSec: row.avgWatchSec ?? null,
    totalWatchSec: row.totalWatchSec ?? null,
    engagementRate: row.engagementRate ?? null,
    metricsUpdatedAt: row.metricsUpdatedAt ?? null,
    source: row.source ?? "zernio",
    fetchedAt: now,
  };
  const video = await prisma.externalVideo.upsert({
    where: { socialAccountId_platformVideoId: { socialAccountId, platformVideoId } },
    create: { socialAccountId, platformVideoId, ...data },
    update: data,
  });

  const capturedOn = utcDay(now);
  // ExternalVideoMetric has no source column: a day row is a measurement, and
  // which pipe delivered it is a property of the video, not of the day.
  const metrics = {
    views: data.views,
    likes: data.likes,
    comments: data.comments,
    shares: data.shares,
    saves: data.saves,
    reach: data.reach,
    follows: data.follows,
    impressions: data.impressions,
    clicks: data.clicks,
    avgWatchSec: data.avgWatchSec,
    totalWatchSec: data.totalWatchSec,
    engagementRate: data.engagementRate,
    metricsUpdatedAt: data.metricsUpdatedAt,
  };
  await prisma.externalVideoMetric.upsert({
    where: { externalVideoId_capturedOn: { externalVideoId: video.id, capturedOn } },
    create: { externalVideoId: video.id, capturedOn, ...metrics },
    update: metrics,
  });
}

/**
 * Fields a direct platform API can fill in on a row that already exists.
 *
 * Every one is optional and an absent key means "this source said nothing",
 * which is different from null. Null is a value here: it is how a source says
 * a metric it does report was not measured for this video.
 */
export interface PlatformMetricFields {
  shares?: number;
  saves?: number;
  reach?: number;
  follows?: number;
  impressions?: number | null;
  clicks?: number | null;
  avgWatchSec?: number | null;
  totalWatchSec?: number | null;
}

/**
 * Lay a direct platform API's numbers over a row another source created.
 *
 * The precedence rule from docs/platform-capability-map.md, in code: the
 * platform's own API wins for any field it reports, and every field it says
 * nothing about is left exactly as the other source wrote it. That is why this
 * exists rather than another call to upsertExternalVideo, which writes a whole
 * row: passing it a partial row would blank the title, the thumbnail, the URL
 * and the duration that the catalogue sync is the only source for.
 *
 * It never creates. A video the catalogue sync has not seen is skipped, because
 * a report entry carries an id and some numbers and nothing that could make a
 * row anyone would want to look at. Returns false in that case, so a caller can
 * count what it missed instead of assuming it landed.
 *
 * The day's metric row is rewritten from the merged result rather than from the
 * overrides, keeping the invariant that a day row is a snapshot of the video row
 * as it stood that day, whichever source last touched it.
 */
export async function applyPlatformMetrics(
  prisma: PrismaClient,
  key: { socialAccountId: string; platformVideoId: string },
  fields: PlatformMetricFields,
  now = new Date(),
): Promise<boolean> {
  const existing = await prisma.externalVideo.findUnique({
    where: {
      socialAccountId_platformVideoId: {
        socialAccountId: key.socialAccountId,
        platformVideoId: key.platformVideoId,
      },
    },
    select: { id: true, directMetrics: true },
  });
  if (!existing) return false;

  /*
   * Record which metrics this source actually filled, on this row.
   *
   * The names are the MetricName vocabulary the display rules speak, not the
   * column names, because the only consumer is the question "does this row
   * report metric X". avgWatchSec becomes avgWatch for that reason.
   *
   * Unioned with whatever is already there rather than replaced: a second
   * source filling different fields adds to what a row can report and must not
   * silently retract another source's. A field the platform did not return for
   * this video is absent from `fields` and so never claims to be measured.
   */
  const NAMES: Record<string, string> = {
    shares: "shares",
    saves: "saves",
    reach: "reach",
    follows: "follows",
    impressions: "impressions",
    clicks: "clicks",
    avgWatchSec: "avgWatch",
    totalWatchSec: "totalWatch",
  };
  const claimed = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => NAMES[k])
    .filter((n): n is string => Boolean(n));

  const directMetrics = [...new Set([...existing.directMetrics, ...claimed])].sort();

  const video = await prisma.externalVideo.update({
    where: { id: existing.id },
    data: { ...fields, directMetrics, metricsUpdatedAt: now },
  });

  await prisma.externalVideoMetric.upsert({
    where: {
      externalVideoId_capturedOn: { externalVideoId: video.id, capturedOn: utcDay(now) },
    },
    create: {
      externalVideoId: video.id,
      capturedOn: utcDay(now),
      views: video.views,
      likes: video.likes,
      comments: video.comments,
      shares: video.shares,
      saves: video.saves,
      reach: video.reach,
      follows: video.follows,
      impressions: video.impressions,
      clicks: video.clicks,
      avgWatchSec: video.avgWatchSec,
      totalWatchSec: video.totalWatchSec,
      engagementRate: video.engagementRate,
      metricsUpdatedAt: video.metricsUpdatedAt,
    },
    update: {
      shares: video.shares,
      saves: video.saves,
      reach: video.reach,
      follows: video.follows,
      impressions: video.impressions,
      clicks: video.clicks,
      avgWatchSec: video.avgWatchSec,
      totalWatchSec: video.totalWatchSec,
      metricsUpdatedAt: video.metricsUpdatedAt,
    },
  });
  return true;
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
