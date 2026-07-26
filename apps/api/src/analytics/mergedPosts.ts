import { decodeEscapes } from "@toreroflow/core";
import type { ZernioProvider } from "@toreroflow/publishers";

/**
 * One place that answers "what videos does this client have, and how did they
 * do".
 *
 * Two sources feed it. The publishing provider reports a rolling recent
 * window across every platform. The platform APIs (currently YouTube) report
 * a full lifetime catalogue with authoritative view counts. Where a video
 * appears in both, the platform's own numbers win and the provider's copy is
 * dropped, so nothing is double counted.
 *
 * The Analytics screen and the client reports both call this, which is what
 * keeps a PDF from disagreeing with what was on screen when it was made.
 */

export interface MergedPost {
  id: string;
  /** "platform:platformPostId", used to dedupe across the two sources. */
  platformKey: string | null;
  title: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  url: string | null;
  platforms: string[];
  views: number;
  likes: number;
  comments: number;
  shares: number;
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
    const platformKey =
      first && typeof first.platformPostId === "string"
        ? `${accountPlatform.get(first.accountId as string) ?? String(first.platform ?? "")}:${first.platformPostId}`
        : null;

    const title =
      typeof p.content === "string" && p.content.trim()
        ? decodeEscapes(p.content.trim())
        : "(untitled)";

    posts.push({
      id,
      platformKey,
      title,
      publishedAt: published.toISOString(),
      thumbnailUrl: typeof p.thumbnailUrl === "string" ? p.thumbnailUrl : null,
      url: typeof p.platformPostUrl === "string" ? p.platformPostUrl : null,
      platforms: [...new Set(byPlatform.map((b) => b.platform))],
      views,
      likes: num(m, "likes", "likeCount") ?? 0,
      comments: num(m, "comments", "commentCount") ?? 0,
      shares: num(m, "shares", "shareCount") ?? 0,
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
    title: string;
    thumbnailUrl: string | null;
    url: string | null;
    publishedAt: Date;
    views: number;
    likes: number;
    comments: number;
    durationSec: number | null;
  }>;

  if (external.length) {
    const seen = new Set(external.map((v) => `${v.platform}:${v.platformVideoId}`));
    const kept = posts.filter((p) => !p.platformKey || !seen.has(p.platformKey));
    posts.length = 0;
    posts.push(
      ...kept,
      ...external.map((v) => ({
        id: `ext:${v.id}`,
        platformKey: `${v.platform}:${v.platformVideoId}`,
        title: v.title,
        publishedAt: v.publishedAt.toISOString(),
        thumbnailUrl: v.thumbnailUrl,
        url: v.url,
        platforms: [v.platform],
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        shares: 0,
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
