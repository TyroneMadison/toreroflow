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
