import { METRIC_REPORTED_BY, type PlatformName } from "./platformMetrics";

/**
 * Where a number on screen came from, when it was pulled, what nobody
 * publishes, and whose report this is.
 *
 * Four questions that every stats surface in the app was answering differently
 * or not at all: the Analytics tab said nothing, the Dashboard said nothing,
 * the report page carried a refresh date and a logo but never named a source,
 * and the Video Breakdown tab had no footer at all because it renders in a
 * separate view.
 *
 * It lives in core rather than in each surface because there are two renderers
 * and they cannot be allowed to drift. The desktop draws React; the client
 * report is a static HTML page built from a template and read months later by
 * someone with no way to ask a question. A client comparing the page they were
 * sent against the screen the operator is looking at has to see the same
 * claims, which is the same argument platformMetrics.ts was extracted for.
 *
 * Nothing here is decoration. The YouTube block in particular is a condition of
 * using the API at all, see PLATFORM_SOURCES.
 */

/** The agency, for surfaces a client may forward to somebody else. */
export const BRAND = {
  name: "Torerone",
  tagline: "Short form content that performs",
  url: "torerone.com",
  href: "https://torerone.com",
} as const;

export interface PlatformSource {
  /** How the platform is named in its own branding. */
  label: string;
  /**
   * Links the platform requires to be shown wherever its data is displayed.
   *
   * Populated for YouTube, where it is not a courtesy: the YouTube API Services
   * Terms require any client showing YouTube API data to link YouTube's Terms
   * of Service and Google's Privacy Policy. The site's legal pages already
   * carry this for the same reason; a stats screen is the other place the data
   * is actually shown, so it needs it too.
   *
   * Empty for the others deliberately. Meta and TikTok require that their data
   * not be misrepresented or passed off as someone else's, which naming the
   * source satisfies, and inventing a legal citation they do not make would be
   * worse than saying nothing.
   */
  requiredLinks: ReadonlyArray<{ label: string; href: string }>;
}

export const PLATFORM_SOURCES: Record<PlatformName, PlatformSource> = {
  instagram: { label: "Instagram", requiredLinks: [] },
  facebook: { label: "Facebook", requiredLinks: [] },
  tiktok: { label: "TikTok", requiredLinks: [] },
  snapchat: { label: "Snapchat", requiredLinks: [] },
  youtube: {
    label: "YouTube",
    requiredLinks: [
      { label: "YouTube Terms of Service", href: "https://www.youtube.com/t/terms" },
      { label: "Google Privacy Policy", href: "https://policies.google.com/privacy" },
    ],
  },
};

/** The platforms actually present, in a stable order, ignoring anything unknown. */
export function knownPlatforms(platforms: readonly PlatformName[]): PlatformName[] {
  const order = ["instagram", "tiktok", "youtube", "facebook", "snapchat"];
  const present = new Set(platforms.filter((p) => p in PLATFORM_SOURCES));
  return order.filter((p) => present.has(p));
}

/** "Instagram, TikTok and YouTube", or "" when there is nothing to name. */
export function sourceNames(platforms: readonly PlatformName[]): string {
  const labels = knownPlatforms(platforms).map((p) => PLATFORM_SOURCES[p]!.label);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Every required link for the platforms on screen, deduplicated.
 *
 * Deduplicated because Instagram and Facebook would otherwise repeat Meta's
 * entries, and a footer that lists the same link twice reads as a bug.
 */
export function requiredLinks(
  platforms: readonly PlatformName[],
): Array<{ label: string; href: string }> {
  const seen = new Set<string>();
  const out: Array<{ label: string; href: string }> = [];
  for (const p of knownPlatforms(platforms)) {
    for (const link of PLATFORM_SOURCES[p]!.requiredLinks) {
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      out.push(link);
    }
  }
  return out;
}

/**
 * Things no platform reports, so a blank space is not read as a zero.
 *
 * Taken from docs/platform-capability-map.md section 6, which exists so these
 * stop being re-litigated. Each entry names the platforms it applies to, so a
 * brand with no TikTok is never told something about TikTok.
 *
 * `metric` ties an entry to the capability matrix where one applies, so an
 * entry cannot outlive the limitation it describes: the check below fails if a
 * note claims a metric is unavailable that METRIC_REPORTED_BY says arrives.
 */
export interface UnmeasuredNote {
  text: string;
  platforms: readonly PlatformName[];
  metric?: keyof typeof METRIC_REPORTED_BY;
}

export const UNMEASURED: readonly UnmeasuredNote[] = [
  {
    text: "Direct messages caused by a video. No platform connects a message to the post that prompted it.",
    platforms: ["instagram", "tiktok", "youtube", "facebook", "snapchat"],
  },
  {
    text: "Followers gained per video. YouTube reports it per video; Instagram reports it for feed posts and stories but not Reels, and TikTok does not offer it.",
    platforms: ["instagram", "tiktok"],
  },
  {
    text: "Second by second retention. Only YouTube measures a curve; everywhere else reports an average at best.",
    platforms: ["instagram", "tiktok", "facebook", "snapchat"],
  },
  {
    text: "Saves. Only Instagram publishes a save count, so it is left out rather than shown as zero elsewhere.",
    platforms: ["tiktok", "youtube", "facebook", "snapchat"],
    metric: "saves",
  },
];

/** The notes that apply to the platforms on screen. */
export function unmeasuredFor(platforms: readonly PlatformName[]): UnmeasuredNote[] {
  const present = new Set(knownPlatforms(platforms));
  return UNMEASURED.filter((note) => note.platforms.some((p) => present.has(p)));
}

/** A date a client can read, in the plain style the reports already use. */
export function refreshedOn(when: Date | null | undefined): string {
  if (!when || Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Everything a stats surface needs, computed once.
 *
 * `sources` is empty when no platform is connected, and every renderer treats
 * that as "draw nothing" rather than "draw an empty box". A brand with no
 * accounts yet should not be shown a provenance panel about no data.
 */
export interface Provenance {
  sources: string;
  platforms: PlatformName[];
  links: Array<{ label: string; href: string }>;
  unmeasured: UnmeasuredNote[];
  refreshed: string;
  brand: typeof BRAND;
}

export function buildProvenance(
  platforms: readonly PlatformName[],
  refreshedAt: Date | null | undefined,
): Provenance {
  return {
    sources: sourceNames(platforms),
    platforms: knownPlatforms(platforms),
    links: requiredLinks(platforms),
    unmeasured: unmeasuredFor(platforms),
    refreshed: refreshedOn(refreshedAt),
    brand: BRAND,
  };
}
