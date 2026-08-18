import { decodeEscapes } from "@toreroflow/core";
import type { ZernioProvider } from "@toreroflow/publishers";
import { providerDate } from "@toreroflow/db";

/**
 * One place that answers "what videos does this client have, and how did they
 * do".
 *
 * Two sources feed it. The publishing provider reports a rolling recent
 * window across every platform. The platform APIs (currently YouTube) report
 * a full lifetime catalogue with authoritative view counts. Where a video
 * appears in both, YouTube's own numbers win and the provider's copy is
 * dropped; on every other platform the live provider post wins and the stored
 * copy is dropped, so nothing is double counted either way.
 *
 * The Analytics screen and the client reports both call this, which is what
 * keeps a PDF from disagreeing with what was on screen when it was made.
 */

export interface MergedPost {
  id: string;
  /** "platform:platformPostId", used to dedupe across the two sources. */
  platformKey: string | null;
  /** video | image | carousel. Decides which board a post belongs on. */
  mediaType: string;
  title: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  url: string | null;
  platforms: string[];
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /**
   * Instagram only in practice. YouTube and Facebook have no save button, and
   * TikTok has one the provider has never reported. Both consumers ask
   * reportsSaves() from packages/core rather than reading this as a
   * measurement on its own.
   */
  saves: number;
  reach: number;
  /**
   * Followers gained from this video. The provider carries the field but has
   * only ever sent zero, so a screen must check whether anything is non-zero
   * before presenting it as a measurement.
   */
  follows: number;
  /** Null when no platform on this post reports it. Never 0 as a stand-in. */
  impressions: number | null;
  clicks: number | null;
  /**
   * DMs a comment-to-DM campaign sent for this video, and link opens among
   * them. Null on every video nobody ran a campaign on, which is most of
   * them: no platform reports DMs per post, so this is only ever present
   * where a campaign was scoped to one.
   */
  dms: number | null;
  dmClicks: number | null;
  /** Total seconds watched across all viewers, measured rather than derived. */
  totalWatchSec: number | null;
  /** When the provider last refreshed these figures, ISO, or null. */
  metricsUpdatedAt: string | null;
  avgWatchSec: number | null;
  durationSec: number | null;
  /**
   * One entry per platform this post went to, carrying that platform's own
   * figures rather than just its view count. A cross-posted video can now show
   * what each platform actually did with it, and each entry is filtered
   * through the capability matrix by its consumer.
   */
  byPlatform: Array<{
    platform: string;
    views: number;
    accountId?: string;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;
    reach: number | null;
    impressions: number | null;
    clicks: number | null;
    avgWatchSec: number | null;
    totalWatchSec: number | null;
    /** Followers gained from this post on this platform. */
    follows?: number | null;
    /**
     * MetricNames this row's own platform API filled in directly, so a
     * connected channel can report what its platform does not report in
     * general. See MetricEntry in packages/core.
     */
    directMetrics?: string[];
  }>;
  /** True when the figures came from the platform rather than the provider. */
  lifetime?: boolean;
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

/**
 * Whether a stored ExternalVideo row survives the merge when the provider
 * also returned the same video live. YouTube's stored rows come straight
 * from YouTube's own API and stay authoritative. Every other platform's
 * stored rows are a previous pull of the same provider data, so the live
 * post wins and the store only covers what the live window no longer
 * reaches.
 */
export function keepStoredRow(platform: string, hasLiveMatch: boolean): boolean {
  return platform === "youtube" || !hasLiveMatch;
}

/**
 * A stored watch time, or null when the store has nothing to say.
 *
 * Watch time used to be read only off the live post, so an Instagram video that
 * aged out of the provider's rolling window lost it permanently. The store now
 * captures it, and this covers what the live window no longer reaches: a
 * non-YouTube stored row only survives the merge when there was no live match,
 * so there is never a second source here to prefer.
 *
 * All this does is scrub a non-positive value to null. No video anyone
 * published was watched for zero seconds by every viewer, so a zero is a metric
 * the provider did not compute rather than a measurement. Same rule as msToSec
 * on the write path and ZERO_IS_UNMEASURED in packages/core.
 */
export function storedWatch(stored: number | null): number | null {
  return stored != null && stored > 0 ? stored : null;
}

/**
 * The "platform:platformPostId" identity of one platforms[] entry, or null
 * when the entry has no platform post id to key on.
 */
export function entryPlatformKey(
  entry: Record<string, unknown>,
  accountPlatform: Map<string, string>,
): string | null {
  if (typeof entry.platformPostId !== "string" || !entry.platformPostId) return null;
  const platform =
    accountPlatform.get(entry.accountId as string) ??
    (typeof entry.platform === "string" ? entry.platform : "");
  return `${platform}:${entry.platformPostId}`;
}

interface Deps {
  prisma: {
    client: {
      findFirst(args: unknown): Promise<{
        id: string;
        providerProfileId: string | null;
        socialAccounts: Array<{ id: string; platform: string; providerAccountId: string | null }>;
      } | null>;
    };
    postTarget: { findMany(args: unknown): Promise<unknown[]> };
    externalVideo: { findMany(args: unknown): Promise<unknown[]> };
  };
  zernio: ZernioProvider | null;
  log?: { error(obj: unknown, msg?: string): void };
}

export async function buildMergedPosts(
  deps: Deps,
  clientId: string,
  agencyId: string,
): Promise<MergedPost[] | null> {
  const { prisma, zernio, log } = deps;

  const client = await prisma.client.findFirst({
    where: { id: clientId, agencyId, deletedAt: null },
    include: { socialAccounts: { where: { deletedAt: null } } },
  });
  if (!client) return null;

  /* ---- provider window ---- */
  let raw: Array<Record<string, unknown>> = [];
  if (zernio) {
    try {
      raw = await zernio.analytics(500);
    } catch (error) {
      log?.error({ err: error }, "zernio analytics pull failed");
    }
  }

  const accountPlatform = new Map(
    client.socialAccounts
      .filter((a) => a.providerAccountId)
      .map((a) => [a.providerAccountId as string, a.platform]),
  );
  // Provider account id to the app's own SocialAccount id, so a post entry
  // can say WHICH Facebook it went to, not just that it went to Facebook.
  const accountRowId = new Map(
    client.socialAccounts
      .filter((a) => a.providerAccountId)
      .map((a) => [a.providerAccountId as string, a.id]),
  );

  // Durations only exist for videos produced through the app.
  const targets = (await prisma.postTarget.findMany({
    where: { remotePostId: { not: null }, socialAccount: { clientId: client.id } },
    include: { post: { include: { mediaAsset: true } } },
  })) as Array<{
    remotePostId: string | null;
    post: { mediaAsset: { durationSec: number | null } | null };
  }>;
  const durationByRemoteId = new Map<string, number>();
  for (const t of targets) {
    const d = t.post.mediaAsset?.durationSec;
    if (t.remotePostId && d) durationByRemoteId.set(t.remotePostId, d);
  }

  const posts: MergedPost[] = [];
  const liveKeys = new Set<string>();
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
    for (const e of use) {
      const k = entryPlatformKey(e, accountPlatform);
      if (k) liveKeys.add(k);
    }
    const m = (p.analytics ?? {}) as Record<string, unknown>;
    const views = num(m, "views", "impressions", "plays") ?? 0;

    const byPlatform = use.map((e) => {
      const em = (e.analytics ?? {}) as Record<string, unknown>;
      const entryViews = num(em, "views", "impressions", "plays");
      const platform =
        accountPlatform.get(e.accountId as string) ??
        (typeof e.platform === "string" ? e.platform : "unknown");
      const rowId = accountRowId.get(e.accountId as string);
      const ms = (name: string): number | null => {
        const v = num(em, name);
        return v != null && v > 0 ? v / 1000 : null;
      };
      return {
        platform,
        views: entryViews ?? (use.length === 1 ? views : Math.round(views / use.length)),
        ...(rowId ? { accountId: rowId } : {}),
        likes: num(em, "likes", "likeCount"),
        comments: num(em, "comments", "commentCount"),
        shares: num(em, "shares", "shareCount"),
        saves: num(em, "saves", "saved", "savedCount"),
        reach: num(em, "reach"),
        impressions: num(em, "impressions"),
        clicks: num(em, "clicks"),
        avgWatchSec: ms("igReelsAvgWatchTime"),
        totalWatchSec: ms("igReelsVideoViewTotalTime"),
      };
    });

    // igReelsAvgWatchTime arrives in milliseconds; the others in seconds.
    const watchMs = num(m, "igReelsAvgWatchTime");
    const avgWatchSec =
      watchMs && watchMs > 0 ? watchMs / 1000 : num(m, "avgWatchTime", "averageViewDuration");

    const id = typeof p._id === "string" ? p._id : String(p.id ?? "");
    const first = use[0];
    const platformKey = first ? entryPlatformKey(first, accountPlatform) : null;

    const title =
      typeof p.content === "string" && p.content.trim()
        ? decodeEscapes(p.content.trim())
        : "(untitled)";

    posts.push({
      id,
      platformKey,
      mediaType: typeof p.mediaType === "string" && p.mediaType ? p.mediaType : "video",
      title,
      publishedAt: published.toISOString(),
      thumbnailUrl: typeof p.thumbnailUrl === "string" ? p.thumbnailUrl : null,
      url: typeof p.platformPostUrl === "string" ? p.platformPostUrl : null,
      platforms: [...new Set(byPlatform.map((b) => b.platform))],
      views,
      likes: num(m, "likes", "likeCount") ?? 0,
      comments: num(m, "comments", "commentCount") ?? 0,
      shares: num(m, "shares", "shareCount") ?? 0,
      saves: num(m, "saves", "saved", "savedCount") ?? 0,
      reach: num(m, "reach") ?? 0,
      follows: num(m, "follows", "followsCount", "followers_gained") ?? 0,
      /*
       * Always null on a provider-sourced post, and not a gap.
       *
       * A DM count reaches a video by way of a campaign scoped to it, which
       * syncDmStats writes onto the stored ExternalVideo row. A post read live
       * from the provider's own feed has no campaign attached and no field to
       * read, so it reports nothing rather than a zero that would read as a
       * campaign nobody responded to.
       */
      dms: null,
      dmClicks: null,
      impressions: num(m, "impressions"),
      clicks: num(m, "clicks"),
      totalWatchSec: (() => {
        const t = num(m, "igReelsVideoViewTotalTime");
        return t != null && t > 0 ? t / 1000 : null;
      })(),
      metricsUpdatedAt: (() => {
        const parsed = providerDate(m.lastUpdated);
        return parsed ? parsed.toISOString() : null;
      })(),
      avgWatchSec: avgWatchSec && avgWatchSec > 0 ? avgWatchSec : null,
      durationSec:
        num(m, "duration", "videoDuration", "durationSec", "mediaDuration") ??
        durationByRemoteId.get(id) ??
        null,
      byPlatform,
    });
  }

  /* ---- platform catalogues, which supersede the provider ---- */
  const external = (await prisma.externalVideo.findMany({
    where: { socialAccount: { clientId: client.id, deletedAt: null } },
    orderBy: { publishedAt: "desc" },
  })) as Array<{
    id: string;
    socialAccountId: string;
    platform: string;
    platformVideoId: string;
    mediaType: string;
    title: string;
    thumbnailUrl: string | null;
    url: string | null;
    publishedAt: Date;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    reach: number;
    follows: number;
    durationSec: number | null;
    impressions: number | null;
    clicks: number | null;
    avgWatchSec: number | null;
    totalWatchSec: number | null;
    dms: number | null;
    dmClicks: number | null;
    metricsUpdatedAt: Date | null;
    /** Which metrics the platform's own API filled on this row. */
    directMetrics: string[];
  }>;

  if (external.length) {
    const keptExternal = external.filter((v) =>
      keepStoredRow(v.platform, liveKeys.has(`${v.platform}:${v.platformVideoId}`)),
    );
    const seen = new Set(keptExternal.map((v) => `${v.platform}:${v.platformVideoId}`));
    const kept = posts.filter((p) => !p.platformKey || !seen.has(p.platformKey));
    posts.length = 0;
    posts.push(
      ...kept,
      ...keptExternal.map((v) => ({
        id: `ext:${v.id}`,
        platformKey: `${v.platform}:${v.platformVideoId}`,
        mediaType: v.mediaType,
        title: v.title,
        publishedAt: v.publishedAt.toISOString(),
        thumbnailUrl: v.thumbnailUrl,
        url: v.url,
        platforms: [v.platform],
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        shares: v.shares,
        saves: v.saves,
        reach: v.reach,
        follows: v.follows,
        avgWatchSec: storedWatch(v.avgWatchSec),
        impressions: v.impressions,
        clicks: v.clicks,
        dms: v.dms,
        dmClicks: v.dmClicks,
        totalWatchSec: storedWatch(v.totalWatchSec),
        metricsUpdatedAt: v.metricsUpdatedAt ? v.metricsUpdatedAt.toISOString() : null,
        durationSec: v.durationSec,
        byPlatform: [
          {
            platform: v.platform,
            views: v.views,
            accountId: v.socialAccountId,
            likes: v.likes,
            comments: v.comments,
            shares: v.shares,
            saves: v.saves,
            reach: v.reach,
            impressions: v.impressions,
            clicks: v.clicks,
            avgWatchSec: storedWatch(v.avgWatchSec),
            totalWatchSec: storedWatch(v.totalWatchSec),
            follows: v.follows,
            dms: v.dms,
            dmClicks: v.dmClicks,
            // What this row's own platform API filled in, so a connected
            // channel reports what the platform does not report in general.
            directMetrics: v.directMetrics,
          },
        ],
        lifetime: true,
      })),
    );
  }

  posts.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return posts;
}
