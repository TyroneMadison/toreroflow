/**
 * Which per-post numbers each platform actually reports.
 *
 * This is one question with one answer, and it was being answered in two
 * places: the analytics screen in the desktop app and the client report
 * builder in the API each carried their own copy of the platform list. They
 * were edited in lockstep once and would not have been the next time, and a
 * report quietly disagreeing with the screen it was generated from is the
 * exact failure buildMergedPosts exists to prevent. The data is shared, so the
 * rules about reading it belong with it.
 *
 * The distinction that matters everywhere below: a platform not having a
 * feature, a platform having it but the provider never sending the number, and
 * the number genuinely being zero are three different facts. Only the last one
 * is a result. The other two have to read as absent, or a client is told
 * something about their audience that was never measured.
 */

/** A platform name as it arrives on a merged post. */
export type PlatformName = string;

/**
 * Platforms whose saves actually arrive.
 *
 * Instagram only, and deliberately not TikTok. TikTok has a save button, which
 * is why an earlier version listed it, but having the button and the provider
 * serving the count are different things. Measured 2026-08-07 over one agency's
 * entire history, 1,682 posts:
 *
 *   instagram  584 posts, 430 report a save
 *   tiktok     313 posts,   0 report a save, while 312 report likes and 78 report shares
 *   youtube    744 posts, no save button at all
 *   facebook    41 posts, no save button at all
 *
 * A field absent on every post while its neighbours arrive is not a quiet
 * month. Add a platform here the day a non-zero save turns up for it.
 */
export const SAVES_REPORTED_BY: ReadonlySet<PlatformName> = new Set(["instagram"]);

/** True when at least one of a post's platforms reports saves. */
export function reportsSaves(platforms: readonly PlatformName[]): boolean {
  return platforms.some((p) => SAVES_REPORTED_BY.has(p));
}

/**
 * True when saves are worth showing at all for this set of posts.
 *
 * Nothing in the set is on a save-reporting platform, so a total would be a
 * sum of unmeasured zeros. Callers show a dash, or leave the row out.
 */
export function savesMeasurable(
  posts: readonly { platforms: readonly PlatformName[] }[],
): boolean {
  return posts.some((p) => reportsSaves(p.platforms));
}

/**
 * True when followers-gained has ever actually been reported in this set.
 *
 * There is no platform list for this one because there is no platform that
 * serves it. Every post of every platform has carried zero so far, so this is
 * asked of the data rather than declared: the day a real number arrives, every
 * surface that calls this starts showing it without another change.
 */
export function followsMeasurable(posts: readonly { follows: number }[]): boolean {
  return posts.some((p) => p.follows > 0);
}

/**
 * True when any post in this set had a comment-to-DM campaign on it.
 *
 * Asked of the data for the same reason followsMeasurable is, but with the
 * opposite treatment of zero. A DM count of zero IS a measurement: the
 * campaign ran and nobody commented the keyword, which is exactly the kind of
 * thing an agency needs to see. What is not a measurement is the absence of a
 * campaign, and that arrives as null. So this tests for a value at all, not
 * for a value above zero.
 */
export function dmsMeasurable(posts: readonly { dms?: number | null }[]): boolean {
  return posts.some((p) => p.dms != null);
}

/**
 * Every per-post metric the app can display, and which platforms actually
 * serve it.
 *
 * Measured 2026-08-11 against the live provider account: 800 posts, a full
 * year, all four platforms. The counts in the comments are nonzero/present out
 * of that platform's post count, so this is observation rather than what the
 * platforms claim in their documentation.
 *
 * A platform absent from a set means the number never arrives, so a total
 * built from it would be a sum of unmeasured zeros. Callers show nothing
 * rather than a zero. Add a platform the day a real value turns up for it.
 */
export type MetricName =
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "saves"
  | "reach"
  | "impressions"
  | "clicks"
  | "avgWatch"
  | "totalWatch"
  | "follows"
  | "dms";

const ALL = ["facebook", "instagram", "tiktok", "youtube"] as const;

export const METRIC_REPORTED_BY: Record<MetricName, ReadonlySet<PlatformName>> = {
  // fb 37/40, ig 275/279, tt 238/238, yt 242/243
  views: new Set(ALL),
  // fb 39/40, ig 279/279, tt 237/238, yt 242/243
  likes: new Set(ALL),
  // fb 17/40, ig 155/279, tt 96/238, yt 154/243
  comments: new Set(ALL),
  // fb 18/40, ig 161/279, tt 57/238. YouTube is 0/243: the provider never
  // sends it, and YouTube's own share count needs the Analytics API.
  shares: new Set(["facebook", "instagram", "tiktok"]),
  // ig 185/279 only. See SAVES_REPORTED_BY above for why TikTok is excluded
  // despite having the button.
  saves: SAVES_REPORTED_BY,
  // fb 40/40, ig 275/279. TikTok and YouTube send nothing.
  reach: new Set(["facebook", "instagram"]),
  /*
   * Facebook only, deliberately, even though Instagram sends it on 275 of 279.
   * Meta deprecated impressions for Instagram media created after 2 July 2024
   * and the value now equals views, so surfacing it there would print the same
   * number twice under two names.
   */
  impressions: new Set(["facebook"]),
  // fb 33/40. Instagram sends the field and it is 0 on all 279.
  clicks: new Set(["facebook"]),
  // ig 274/279, from igReelsAvgWatchTime. Nothing else reports watch time.
  avgWatch: new Set(["instagram"]),
  // ig 274/279, from igReelsVideoViewTotalTime.
  totalWatch: new Set(["instagram"]),
  /*
   * Empty, and that is the finding. Followers gained is 0 on all 800 posts of
   * all four platforms. The provider carries the field and has never populated
   * it. Getting this needs a direct platform integration, see
   * docs/platform-capability-map.md. Callers get false without a special case.
   */
  follows: new Set(),
  /*
   * Empty, and unlike the others it will stay empty forever.
   *
   * No platform reports DMs per video, because a DM is not a property of a
   * video anywhere in Meta's data model. The number exists only where we made
   * it exist: a comment-to-DM campaign scoped to one post counts its own
   * triggers, so the video that campaign points at has a real figure and every
   * other video on the same account has none.
   *
   * That is per row by construction, which is exactly what directMetrics is
   * for. A platform entry here would put "DMs 0" on every video nobody ran a
   * campaign on, and a client reading a zero next to a real number on the
   * video above it would reasonably conclude the second video failed.
   */
  dms: new Set(),
};

/**
 * The metrics where a zero on a post that got views cannot be a result.
 *
 * A Reel with views was not watched for zero seconds by every viewer, and it
 * did not reach nobody. When a provider sends a zero for one of these it has
 * not computed the number, so it is unmeasured and has to render as absent. The
 * rule was already applied to watch time in msToSec and storedWatch; it is the
 * same rule and it belongs here, once, where every surface can ask for it.
 *
 * clicks, saves, comments and shares are deliberately absent. Those can
 * genuinely be zero, and a zero IS the result: roughly 94 Instagram posts a
 * year carry no saves at all, and "Saves 0" is the honest thing to print for
 * them. Only add a metric here when a zero is provably impossible alongside
 * views.
 */
export const ZERO_IS_UNMEASURED: ReadonlySet<MetricName> = new Set<MetricName>([
  "reach",
  /*
   * Impressions are only reported by Facebook here, and an impression is by
   * definition every time the post was put on a screen, so it is greater than
   * or equal to views. A post with 400 views cannot have been shown 0 times.
   * Same quantity, same reasoning as reach beside it.
   */
  "impressions",
  "avgWatch",
  "totalWatch",
]);

/** True when at least one of a post's platforms reports this metric. */
export function reportsMetric(
  metric: MetricName,
  platforms: readonly PlatformName[],
): boolean {
  const reporters = METRIC_REPORTED_BY[metric];
  return platforms.some((p) => reporters.has(p));
}

/**
 * One platform's row on a post, and what its own API filled in directly.
 *
 * `directMetrics` is per row, not per platform, and that distinction is the
 * whole reason it exists. METRIC_REPORTED_BY answers for a platform in general:
 * it says YouTube does not report shares, which was true of every YouTube row
 * in the app until a channel could be connected directly. Now a connected
 * channel reports shares, watch time and subscribers gained while an
 * unconnected channel on the same platform reports none of them, so the
 * platform can no longer answer for the row.
 *
 * Widening METRIC_REPORTED_BY instead would print "Shares 0" and "Subscribers
 * gained 0" on every channel nobody has authorized, which is the fabricated
 * zero this whole module exists to prevent.
 */
export interface MetricEntry {
  platform: PlatformName;
  /** MetricNames this row's own platform API supplied. Absent means none. */
  directMetrics?: readonly string[];
}

/**
 * Whether THIS row reports the metric: either its platform reports it in
 * general, or this particular row was filled from the platform's own API.
 */
export function entryReports(metric: MetricName, entry: MetricEntry): boolean {
  if (METRIC_REPORTED_BY[metric].has(entry.platform)) return true;
  return entry.directMetrics?.includes(metric) ?? false;
}

/**
 * True when any entry on a post reports the metric, row awareness included.
 *
 * The row-aware counterpart to reportsMetric, for callers that hold the
 * per-platform entries rather than only the platform names.
 */
export function reportsMetricOn(
  metric: MetricName,
  entries: readonly MetricEntry[],
): boolean {
  return entries.some((e) => entryReports(metric, e));
}

/**
 * True when a metric is worth showing across a set of posts, row awareness
 * included. The row-aware counterpart to metricMeasurable.
 */
export function metricMeasurableOn(
  metric: MetricName,
  posts: readonly { byPlatform?: readonly MetricEntry[]; platforms: readonly PlatformName[] }[],
): boolean {
  return posts.some((p) =>
    p.byPlatform?.length ? reportsMetricOn(metric, p.byPlatform) : reportsMetric(metric, p.platforms),
  );
}

/**
 * A metric totalled over only the platforms that report it, or null when none
 * of the entries is on a reporting platform.
 *
 * A post-level aggregate cannot be used for this, and that is the whole point
 * of the function. METRIC_REPORTED_BY answers two different questions with one
 * shape. For most metrics an excluded platform sends nothing, so the aggregate
 * happens to be right. For impressions it does not: Instagram sends the number
 * on 275 of 279 posts and is excluded because the value mirrors views, not
 * because it is missing. Asking "does ANY platform on this post report it" and
 * then reading the post total therefore prints Instagram's views inside a
 * Facebook impressions figure on a cross-post, and it looks plausible.
 *
 * The per-platform entries are the only place the honest number exists, so
 * every total is built from them.
 *
 * An entry that supplies no value is skipped rather than counted as a zero.
 * The three cases this keeps apart:
 *  - a genuinely measured zero still totals and still prints, because a real
 *    zero arrives as 0 and not as null
 *  - a metric no platform on the post reports returns null, so the caller
 *    prints nothing rather than a sum of structural zeros
 *  - a metric the platform does report but did not supply for this post also
 *    returns null, instead of a 0 that reads as a measurement
 */
export function sumReported<T extends MetricEntry>(
  metric: MetricName,
  entries: readonly T[],
  pick: (entry: T) => number | null | undefined,
): number | null {
  let total = 0;
  let reported = false;
  for (const entry of entries) {
    // Row-aware: a directly connected channel contributes its own figures even
    // where the platform in general reports nothing.
    if (!entryReports(metric, entry)) continue;
    const value = pick(entry);
    if (value == null) continue;
    reported = true;
    total += value;
  }
  return reported ? total : null;
}

/**
 * True when this metric is worth showing at all across a set of posts.
 *
 * Nothing in the set is on a platform that reports it, so a total would be a
 * sum of unmeasured zeros. Callers show a dash, or leave the row out.
 */
export function metricMeasurable(
  metric: MetricName,
  posts: readonly { platforms: readonly PlatformName[] }[],
): boolean {
  return posts.some((p) => reportsMetric(metric, p.platforms));
}
