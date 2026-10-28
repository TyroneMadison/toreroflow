import { getPrisma } from "@toreroflow/db";
import { ZernioError, type ZernioProvider } from "@toreroflow/publishers";
import type { MergedInsight } from "@toreroflow/contracts";

/**
 * One post's numbers from every source that has them, merged.
 *
 * Sources: Toreroflow's own stored stats (PostMetric), Zernio (live
 * analytics, plus rows it already filled in the store), and the platforms'
 * own APIs (YouTube rows, and any metric an Instagram or TikTok row lists in
 * directMetrics). The same number from two sources collapses to one row; the
 * platform's own API wins, then Zernio, then Toreroflow, and every source
 * that reported it is listed next to the one chosen.
 */

export type InsightSource = MergedInsight["chosenSource"];
export interface Reading {
  source: InsightSource;
  platform: string;
  metric: string;
  value: number;
  /** YYYY-MM-DD the number was measured on. */
  day: string;
}

export const METRICS = ["views", "likes", "comments", "shares", "saves", "reach", "impressions"] as const;
const PRIORITY: Record<InsightSource, number> = { youtube: 3, instagram: 3, tiktok: 3, zernio: 2, toreroflow: 1 };

export function mergeInsights(postId: string, readings: Reading[]): MergedInsight[] {
  const groups = new Map<string, Reading[]>();
  for (const r of readings) {
    if (!Number.isFinite(r.value)) continue;
    const k = `${r.platform}|${r.metric}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: MergedInsight[] = [];
  const totals = new Map<string, { value: number; sources: Set<InsightSource>; best: Reading }>();
  for (const [k, rs] of groups) {
    const [platform, metric] = k.split("|") as [string, string];
    const chosen = rs.reduce((a, b) =>
      PRIORITY[b.source] > PRIORITY[a.source] || (PRIORITY[b.source] === PRIORITY[a.source] && b.day > a.day) ? b : a,
    );
    const sources = [...new Set(rs.map((r) => r.source))];
    out.push({
      dedupeKey: `${postId}|${platform}|${metric}|${chosen.day}`,
      metric,
      value: chosen.value,
      sources,
      chosenSource: chosen.source,
      platform,
      day: chosen.day,
    });
    const t = totals.get(metric) ?? { value: 0, sources: new Set(), best: chosen };
    t.value += chosen.value;
    t.sources.add(chosen.source);
    if (PRIORITY[chosen.source] > PRIORITY[t.best.source]) t.best = chosen;
    totals.set(metric, t);
  }
  // Totals only when the post went to more than one platform.
  const platforms = new Set(out.map((i) => i.platform));
  if (platforms.size > 1)
    for (const [metric, t] of totals)
      out.push({
        dedupeKey: `${postId}|total|${metric}`,
        metric,
        value: t.value,
        sources: [...t.sources],
        chosenSource: t.best.source,
        platform: "total",
      });
  return out.sort((a, b) => (a.platform! + a.metric).localeCompare(b.platform! + b.metric));
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

/** Zernio's per-platform analytics for one of our posts, as readings. */
export function zernioReadings(item: Record<string, unknown>, platformByAccount: Map<string, string>): Reading[] {
  const when = typeof item.lastUpdated === "string" && !Number.isNaN(Date.parse(item.lastUpdated)) ? day(new Date(item.lastUpdated)) : day(new Date());
  const entries = Array.isArray(item.platforms) ? (item.platforms as Record<string, unknown>[]) : [];
  const out: Reading[] = [];
  for (const e of entries) {
    const platform = platformByAccount.get(String(e.accountId)) ?? (typeof e.platform === "string" ? e.platform : null);
    if (!platform) continue;
    const m = (e.analytics ?? {}) as Record<string, unknown>;
    for (const metric of METRICS) {
      const v = num(m[metric] ?? m[`${metric.replace(/s$/, "")}Count`]);
      if (v != null) out.push({ source: "zernio", platform, metric, value: v, day: when });
    }
  }
  return out;
}

export interface InsightsResult {
  insights: MergedInsight[];
  unavailable: { source: InsightSource; reason: string }[];
}

/** Null when the post is not this agency's. */
export async function postInsights(agencyId: string, postId: string, zernio: ZernioProvider | null): Promise<InsightsResult | null> {
  const prisma = getPrisma();
  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null, client: { agencyId } },
    select: {
      id: true,
      targets: {
        select: {
          platform: true,
          socialAccountId: true,
          remotePostId: true,
          remoteUrl: true,
          publishedAt: true,
          socialAccount: { select: { providerAccountId: true } },
          postMetrics: { orderBy: { capturedAt: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!post) return null;
  const readings: Reading[] = [];
  const unavailable: InsightsResult["unavailable"] = [];

  // Toreroflow's own stored stats.
  for (const t of post.targets) {
    const m = t.postMetrics[0];
    if (!m) continue;
    for (const metric of ["views", "likes", "comments", "shares", "saves"] as const) {
      const v = m[metric];
      if (v != null) readings.push({ source: "toreroflow", platform: t.platform, metric, value: v, day: day(m.capturedAt) });
    }
  }

  // Store rows for the same videos: Zernio's copy, or the platform's own API.
  const urls = post.targets.map((t) => t.remoteUrl).filter((u): u is string => !!u);
  if (urls.length) {
    const rows = await prisma.externalVideo.findMany({
      where: { socialAccountId: { in: post.targets.map((t) => t.socialAccountId) }, url: { in: urls } },
    });
    for (const r of rows) {
      const when = day(r.metricsUpdatedAt ?? r.fetchedAt);
      for (const metric of METRICS) {
        const v = r[metric];
        if (v == null) continue;
        const native = r.source === "youtube" || r.directMetrics.includes(metric);
        const source: InsightSource = native && ["youtube", "instagram", "tiktok"].includes(r.platform) ? (r.platform as InsightSource) : "zernio";
        readings.push({ source, platform: r.platform, metric, value: v, day: when });
      }
    }
  }

  // Zernio live. Older plans need the Analytics add-on; without it Zernio
  // answers 402/403 and the source is listed as unavailable, not an error.
  const remote = post.targets.filter((t) => t.remotePostId && t.publishedAt);
  if (!zernio) {
    if (remote.length) unavailable.push({ source: "zernio", reason: "Zernio is not the publishing provider here" });
  } else if (remote.length) {
    const first = Math.min(...remote.map((t) => +t.publishedAt!));
    const from = day(new Date(first - 864e5));
    const to = day(new Date(Math.max(...remote.map((t) => +t.publishedAt!)) + 864e5));
    try {
      const items = await zernio.analytics(300, from, to);
      const ids = new Set(remote.map((t) => t.remotePostId!));
      const accounts = new Map(
        post.targets.filter((t) => t.socialAccount.providerAccountId).map((t) => [t.socialAccount.providerAccountId!, t.platform as string]),
      );
      for (const item of items)
        if (ids.has(String(item.latePostId ?? "")) || ids.has(String(item._id ?? ""))) readings.push(...zernioReadings(item, accounts));
    } catch (e) {
      const status = e instanceof ZernioError ? e.status : 0;
      unavailable.push({
        source: "zernio",
        reason:
          status === 402 || status === 403
            ? "Zernio analytics needs the Analytics add-on on this plan"
            : `Zernio analytics unavailable (${e instanceof Error ? e.message : String(e)})`,
      });
    }
  }
  return { insights: mergeInsights(post.id, readings), unavailable };
}
