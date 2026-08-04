import { decodeEscapes } from "@toreroflow/core";
import type { ZernioProvider } from "@toreroflow/publishers";

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
  /** Instagram and TikTok only; every other platform has no save button. */
  saves: number;
  reach: number;
  /**
   * Followers gained from this video. The provider carries the field but has
   * only ever sent zero, so a screen must check whether anything is non-zero
   * before presenting it as a measurement.
   */
  follows: number;
  avgWatchSec: number | null;
  durationSec: number | null;
  byPlatform: Array<{ platform: string; views: number }>;
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
      return {
        platform,
        views: entryViews ?? (use.length === 1 ? views : Math.round(views / use.length)),
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
        avgWatchSec: null,
        durationSec: v.durationSec,
        byPlatform: [{ platform: v.platform, views: v.views }],
        lifetime: true,
      })),
    );
  }

  posts.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return posts;
}
