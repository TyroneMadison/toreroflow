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
  | "follows";

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
export function sumReported<T extends { platform: PlatformName }>(
  metric: MetricName,
  entries: readonly T[],
  pick: (entry: T) => number | null | undefined,
): number | null {
  const reporters = METRIC_REPORTED_BY[metric];
  let total = 0;
  let reported = false;
  for (const entry of entries) {
    if (!reporters.has(entry.platform)) continue;
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
