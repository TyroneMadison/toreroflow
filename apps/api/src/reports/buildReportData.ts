/**
 * Turns real analytics into the JSON the Torerone report template renders.
 *
 * Two honesty rules run through this file:
 *  - A change indicator is only emitted when a genuine prior period exists.
 *    Follower and subscriber counts are point-in-time snapshots that only
 *    began on 2026-07-25, so they are shown without an arrow rather than
 *    compared against nothing.
 *  - Watch time is derived from views multiplied by average watch, because
 *    YouTube's Data API does not report it. Every label says "estimated".
 */

export type Direction = "up" | "down" | "flat";

export interface Delta {
  dir: Direction;
  label: string;
}

export interface ReportPost {
  title: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  avgWatchSec: number | null;
  platforms: string[];
  byPlatform: Array<{ platform: string; views: number }>;
  /** Public link to the video, so the report can point at the real thing. */
  url?: string | null;
  /** Thumbnail URL; inlined as a data URI before publishing. */
  thumbnailUrl?: string | null;
}

export interface ReportAccount {
  platform: string;
  handle: string;
  displayName: string | null;
  followers: number | null;
}

const BRAND: Record<string, string> = {
  instagram: "ig",
  youtube: "yt",
  tiktok: "tiktok",
  facebook: "fb",
  snapchat: "snap",
};

const PLATFORM_NAME: Record<string, string> = {
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
  facebook: "Facebook",
  snapchat: "Snapchat",
};

/** Compact display number: 4.82M, 611.4K, 6,410. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 100_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString("en-US");
}

/** Seconds to m:ss, for average view duration. */
export function fmtDur(sec: number | null): string {
  if (sec == null || sec <= 0) return "-";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Hours, rounded for display. */
function fmtHours(sec: number): string {
  return fmt(Math.round(sec / 3600));
}

/**
 * Percentage change, or null when there is nothing meaningful to compare.
 * A previous value of zero would make any change infinite, so it yields no
 * indicator rather than a misleading one.
 */
export function delta(current: number, previous: number): Delta | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const rounded = Math.round(Math.abs(pct));
  if (rounded === 0) return { dir: "flat", label: "0%" };
  return { dir: pct > 0 ? "up" : "down", label: `${rounded}%` };
}

const inRange = (iso: string, from: Date, to: Date): boolean => {
  const t = new Date(iso).getTime();
  return t >= from.getTime() && t <= to.getTime();
};

const sum = (rows: ReportPost[], pick: (p: ReportPost) => number): number =>
  rows.reduce((acc, p) => acc + (pick(p) || 0), 0);

const engagementOf = (rows: ReportPost[]): number =>
  sum(rows, (p) => p.likes + p.comments + p.shares);

/** views x average watch, in seconds. Only counts posts reporting a watch time. */
function estimatedWatchSec(rows: ReportPost[], fallbackAvg: number | null): number {
  return rows.reduce((acc, p) => {
    const avg = p.avgWatchSec ?? fallbackAvg;
    return acc + (avg && avg > 0 ? p.views * avg : 0);
  }, 0);
}

function monthLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short" });
}

export interface BuildReportInput {
  clientName: string;
  /**
   * Who prepared this, on paper.
   *
   * The registered company where there is one, so the document a client keeps
   * names the entity they are actually paying, and the brand otherwise.
   */
  businessName: string;
  accounts: ReportAccount[];
  /** Every post available, any period; this function does the windowing. */
  posts: ReportPost[];
  periodStart: Date;
  periodEnd: Date;
  /** Action items for the plan section; falls back to derived ones. */
  planItems?: string[];
  generatedAt?: Date;
}

export function buildReportData(input: BuildReportInput): Record<string, unknown> {
  const { clientName, businessName, accounts, posts, periodStart, periodEnd } = input;
  const generatedAt = input.generatedAt ?? new Date();

  const periodMs = periodEnd.getTime() - periodStart.getTime();
  const prevStart = new Date(periodStart.getTime() - periodMs - 1);
  const prevEnd = new Date(periodStart.getTime() - 1);

  const current = posts.filter((p) => inRange(p.publishedAt, periodStart, periodEnd));
  const previous = posts.filter((p) => inRange(p.publishedAt, prevStart, prevEnd));

  const watches = current.map((p) => p.avgWatchSec).filter((x): x is number => x != null && x > 0);
  const avgWatch = watches.length ? watches.reduce((a, b) => a + b, 0) / watches.length : null;
  const prevWatches = previous
    .map((p) => p.avgWatchSec)
    .filter((x): x is number => x != null && x > 0);
  const prevAvgWatch = prevWatches.length
    ? prevWatches.reduce((a, b) => a + b, 0) / prevWatches.length
    : null;

  const views = sum(current, (p) => p.views);
  const prevViews = sum(previous, (p) => p.views);
  const engagement = engagementOf(current);
  const prevEngagement = engagementOf(previous);
  const watchSec = estimatedWatchSec(current, avgWatch);
  const prevWatchSec = estimatedWatchSec(previous, prevAvgWatch);

  const ytAccounts = accounts.filter((a) => a.platform === "youtube");
  const otherAccounts = accounts.filter((a) => a.platform !== "youtube");
  const subscribers = ytAccounts.reduce((s, a) => s + (a.followers ?? 0), 0);
  const followers = otherAccounts.reduce((s, a) => s + (a.followers ?? 0), 0);

  const periodLabel = `${periodStart.toLocaleDateString("en-US", { month: "long", day: "numeric" })} - ${periodEnd.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;

  /* ---- headline KPIs. Only real comparisons get an arrow. ---- */
  const kpis: Array<Record<string, unknown>> = [
    {
      label: "Total Views",
      value: fmt(views),
      hot: true,
      note: "vs last month",
      ...(delta(views, prevViews) ? { delta: delta(views, prevViews) } : {}),
    },
    {
      label: "Total Engagement",
      value: fmt(engagement),
      note: "likes, comments, shares",
      ...(delta(engagement, prevEngagement)
        ? { delta: delta(engagement, prevEngagement) }
        : {}),
    },
    {
      label: "Videos Published",
      value: fmt(current.length),
      note: "this period",
      ...(delta(current.length, previous.length)
        ? { delta: delta(current.length, previous.length) }
        : {}),
    },
    {
      label: "Watch Time (hrs)",
      value: watchSec > 0 ? fmtHours(watchSec) : "-",
      note: "estimated from views",
      ...(watchSec > 0 && delta(watchSec, prevWatchSec)
        ? { delta: delta(watchSec, prevWatchSec) }
        : {}),
    },
    // No delta on the two below: follower history does not reach back a month
    // yet, so a comparison would be invented.
    ...(otherAccounts.length
      ? [{ label: "Followers", value: fmt(followers), note: "current total" }]
      : []),
    ...(ytAccounts.length
      ? [{ label: "Subscribers", value: fmt(subscribers), note: "current total" }]
      : []),
  ];

  /* ---- per-platform sections ---- */
  const platformsPresent = [...new Set(accounts.map((a) => a.platform))];
  const platforms = platformsPresent.map((platform) => {
    const account = accounts.find((a) => a.platform === platform)!;
    const scoped = current
      .filter((p) => p.byPlatform.some((b) => b.platform === platform))
      .map((p) => ({
        ...p,
        views: p.byPlatform.find((b) => b.platform === platform)?.views ?? 0,
      }));
    const prevScoped = previous
      .filter((p) => p.byPlatform.some((b) => b.platform === platform))
      .map((p) => ({
        ...p,
        views: p.byPlatform.find((b) => b.platform === platform)?.views ?? 0,
      }));

    const pViews = sum(scoped, (p) => p.views);
    const pPrevViews = sum(prevScoped, (p) => p.views);
    const pLikes = sum(scoped, (p) => p.likes);
    const pComments = sum(scoped, (p) => p.comments);
    const pShares = sum(scoped, (p) => p.shares);
    const pWatches = scoped
      .map((p) => p.avgWatchSec)
      .filter((x): x is number => x != null && x > 0);
    const pAvgWatch = pWatches.length
      ? pWatches.reduce((a, b) => a + b, 0) / pWatches.length
      : null;
    const engRate = pViews > 0 ? ((pLikes + pComments) / pViews) * 100 : null;
    const top = [...scoped].sort((a, b) => b.views - a.views)[0];

    const metrics: Array<Record<string, unknown>> = [
      { l: "Views", v: fmt(pViews), ...(delta(pViews, pPrevViews) ? { d: delta(pViews, pPrevViews) } : {}) },
      { l: "Likes", v: fmt(pLikes) },
      { l: "Comments", v: fmt(pComments) },
      { l: "Shares", v: fmt(pShares) },
      { l: "Videos", v: fmt(scoped.length) },
      { l: "Engagement", v: engRate != null ? `${engRate.toFixed(1)}%` : "-" },
      { l: "Avg View", v: fmtDur(pAvgWatch) },
      {
        l: platform === "youtube" ? "Subscribers" : "Followers",
        v: fmt(account.followers ?? 0),
      },
    ];

    return {
      brand: BRAND[platform] ?? platform,
      name: PLATFORM_NAME[platform] ?? platform,
      handle: `@${account.handle}`,
      headline: { value: fmt(pViews), label: "Views" },
      metrics,
      ...(top
        ? {
            topPost: {
              tag: "Top Video",
              title: top.title,
              stats: `${fmt(top.views)} views`,
              ...(top.url ? { url: top.url } : {}),
              ...(top.thumbnailUrl ? { thumb: top.thumbnailUrl } : {}),
            },
          }
        : {}),
      share: {
        pct: views > 0 ? Math.round((pViews / views) * 100) : 0,
        label: views > 0 ? `${Math.round((pViews / views) * 100)}% of period views` : "no views yet",
      },
    };
  });

  /* ---- three months of trend, as requested ---- */
  const monthBars: Array<{ cap: string; val: string; pct: number }> = [];
  const monthTotals: number[] = [];
  for (let back = 2; back >= 0; back--) {
    const mStart = new Date(periodStart.getFullYear(), periodStart.getMonth() - back, 1);
    const mEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() - back + 1, 0, 23, 59, 59);
    const mViews = sum(
      posts.filter((p) => inRange(p.publishedAt, mStart, mEnd)),
      (p) => p.views,
    );
    monthTotals.push(mViews);
    monthBars.push({ cap: monthLabel(mStart), val: fmt(mViews), pct: 0 });
  }
  const maxMonth = Math.max(1, ...monthTotals);
  monthBars.forEach((b, i) => {
    b.pct = Math.round((monthTotals[i]! / maxMonth) * 100);
  });

  const engRows = [
    { name: "Likes", value: sum(current, (p) => p.likes), color: "linear-gradient(90deg,#FF8A78,#E5473C)" },
    { name: "Comments", value: sum(current, (p) => p.comments), color: "linear-gradient(90deg,#8b7bff,#4ea8ff)" },
    { name: "Shares", value: sum(current, (p) => p.shares), color: "linear-gradient(90deg,#25f4ee,#1c9c98)" },
  ];
  const maxEng = Math.max(1, ...engRows.map((r) => r.value));

  /* ---- top content across every platform ---- */
  const topContent = [...current]
    .sort((a, b) => b.views - a.views)
    .slice(0, 6)
    .map((p) => {
      const platform = p.platforms[0] ?? "instagram";
      const rate = p.views > 0 ? ((p.likes + p.comments) / p.views) * 100 : 0;
      return {
        brand: BRAND[platform] ?? platform,
        tag: PLATFORM_NAME[platform] ?? platform,
        title: p.title,
        value: fmt(p.views),
        note: rate > 0 ? `${rate.toFixed(1)}% eng` : "",
        // Makes the card a link straight to the video on its platform.
        ...(p.url ? { url: p.url } : {}),
        ...(p.thumbnailUrl ? { thumb: p.thumbnailUrl } : {}),
      };
    });

  /* ---- highlight line ---- */
  const viewsDelta = delta(views, prevViews);
  const best = [...current].sort((a, b) => b.views - a.views)[0];
  const highlightBig = viewsDelta ? `${viewsDelta.dir === "down" ? "-" : "+"}${viewsDelta.label}` : fmt(views);
  const highlightHtml = best
    ? `<b>${fmt(views)} views</b> across ${current.length} video${current.length === 1 ? "" : "s"} this period. The strongest performer pulled <b>${fmt(best.views)} views</b> on its own.`
    : `No videos were published in this period.`;

  const planItems =
    input.planItems && input.planItems.length
      ? input.planItems
      : derivePlanItems(current, platforms, avgWatch);

  return {
    report: {
      tag: "Monthly Performance Report",
      eyebrow: "Proven Results",
      titleTop: "The Numbers",
      titleAccent: "Speak.",
      intro: `A full breakdown of the views, engagement, and growth generated for ${clientName} this period across every platform we run.`,
    },
    meta: [
      { k: "Client", v: clientName },
      { k: "Reporting Period", v: periodLabel },
      { k: "Prepared By", v: businessName },
      {
        k: "Platforms",
        v: `${accounts.length} account${accounts.length === 1 ? "" : "s"} managed`,
      },
    ],
    headline: { eyebrow: "At a glance", title: "Performance Summary", kpis },
    highlight: { big: highlightBig, html: highlightHtml },
    platformsSection: { eyebrow: "Channel by channel", title: "Platform Breakdown" },
    platforms,
    trends: {
      eyebrow: "Direction of travel",
      title: "Trends",
      weekly: {
        title: "Views by month",
        sub: "Last three months",
        bars: monthBars,
      },
      engagement: {
        title: "Engagement mix",
        sub: "This period",
        bars: engRows.map((r) => ({
          name: r.name,
          value: fmt(r.value),
          pct: Math.round((r.value / maxEng) * 100),
          color: r.color,
        })),
      },
    },
    topContent: { eyebrow: "What worked", title: "Top Content", items: topContent },
    plan: { eyebrow: "Next", title: "The Plan", items: planItems },
    footer: {
      contactHtml: `<b>${businessName}</b><br>toreronee@gmail.com · torerone.com<br>Report generated ${generatedAt.toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
      note: "Short form content that performs",
    },
  };
}

/** Data-driven action items, used when nothing better is supplied. */
function derivePlanItems(
  current: ReportPost[],
  platforms: Array<{ name: string; share: { pct: number } }>,
  avgWatch: number | null,
): string[] {
  const items: string[] = [];

  const byHour = new Map<number, { total: number; n: number }>();
  for (const p of current) {
    const h = new Date(p.publishedAt).getHours();
    const cell = byHour.get(h) ?? { total: 0, n: 0 };
    cell.total += p.views;
    cell.n += 1;
    byHour.set(h, cell);
  }
  const bestHour = [...byHour.entries()]
    .filter(([, c]) => c.n >= 2)
    .map(([h, c]) => ({ h, avg: c.total / c.n }))
    .sort((a, b) => b.avg - a.avg)[0];
  if (bestHour) {
    const label = `${bestHour.h % 12 === 0 ? 12 : bestHour.h % 12} ${bestHour.h < 12 ? "AM" : "PM"}`;
    items.push(
      `Posts going out around <b>${label}</b> averaged the most views this period. Weighting the schedule toward that window is the cheapest available gain.`,
    );
  }

  const leader = [...platforms].sort((a, b) => b.share.pct - a.share.pct)[0];
  if (leader && leader.share.pct >= 50) {
    items.push(
      `<b>${leader.name}</b> carried ${leader.share.pct}% of views. Worth deliberately testing whether the same cuts can lift a second platform rather than leaning on one.`,
    );
  }

  if (avgWatch != null && avgWatch > 0) {
    items.push(
      `Average watch time sat at <b>${fmtDur(avgWatch)}</b>. Tightening the first three seconds is where retention is usually won.`,
    );
  }

  const top = [...current].sort((a, b) => b.views - a.views)[0];
  if (top) {
    items.push(
      `The best performer was <b>${top.title}</b>. Producing more in that format is the clearest signal in this month's data.`,
    );
  }

  return items.length ? items : ["No activity this period, so there is nothing to read into yet."];
}
