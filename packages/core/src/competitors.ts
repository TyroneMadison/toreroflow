import { decodeEscapes } from "./text";

/**
 * What a paid competitor fetch actually said, reduced to the few facts a game
 * plan can be built on.
 *
 * A snapshot is the provider's payload stored verbatim, which for one
 * Instagram account is about 160KB of mostly rendering flags. Handing that to
 * a model is expensive and mostly noise, so this pulls out the only things
 * that matter: what each post got, how long it was, and what it said.
 *
 * Pure and shape-tolerant on purpose. Every field here comes from a stranger's
 * account through a broker over another provider, so a key can be renamed or
 * moved a level without warning, and each re-fetch costs real money. Reading
 * several spellings and searching for the post array rather than demanding one
 * path means a schema change degrades the document instead of emptying it.
 */

export interface CompetitorPost {
  /** The caption as posted, escapes decoded, whitespace collapsed. */
  caption: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  seconds: number | null;
  /** Calendar day, `YYYY-MM-DD`. A post has a day, not an instant. */
  postedAt: string | null;
  /**
   * Pinned to the top of their profile.
   *
   * These arrive first whatever their date, and they are pinned precisely
   * because they did well, so counting them as recent activity makes a busy
   * account look dormant and an average look better than any normal week.
   */
  pinned: boolean;
}

export interface CompetitorDigest {
  platform: string;
  handle: string;
  postCount: number;
  /** Median, not mean: one viral post should not describe a normal week. */
  medianViews: number | null;
  bestViews: number | null;
  typicalSeconds: number | null;
  postsPerWeek: number | null;
  /** Newest first, by day. */
  newestPostedAt: string | null;
  /** The strongest posts by views, biggest first. */
  top: CompetitorPost[];
}

export interface CompetitorSource {
  platform: string;
  handle: string;
  raw: unknown;
}

/** How many of an account's best posts a digest carries. */
const TOP_POSTS = 4;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** First finite number among several field names, dotted paths allowed. */
function num(item: Record<string, unknown>, ...paths: string[]): number | null {
  for (const p of paths) {
    let cursor: unknown = item;
    for (const key of p.split(".")) {
      if (!isRecord(cursor)) {
        cursor = undefined;
        break;
      }
      cursor = cursor[key];
    }
    if (typeof cursor === "number" && Number.isFinite(cursor)) return cursor;
    if (typeof cursor === "string" && cursor !== "" && Number.isFinite(Number(cursor))) {
      return Number(cursor);
    }
  }
  return null;
}

/** First non-empty string among several field names, dotted paths allowed. */
function str(item: Record<string, unknown>, ...paths: string[]): string {
  for (const p of paths) {
    let cursor: unknown = item;
    for (const key of p.split(".")) {
      if (!isRecord(cursor)) {
        cursor = undefined;
        break;
      }
      cursor = cursor[key];
    }
    if (typeof cursor === "string" && cursor.trim()) return cursor;
  }
  return "";
}

/**
 * The list of posts inside a provider payload.
 *
 * Instagram answers `{ items: [...] }` and TikTok `{ aweme_list: [...] }`,
 * either at the top level or under `data`. Rather than pin those four shapes,
 * this walks the payload for the first array whose entries carry something
 * only a post carries. A provider that renames its wrapper still works.
 */
function findPosts(raw: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4) return [];
  if (Array.isArray(raw)) return raw.filter(isRecord).filter(looksLikePost);
  if (!isRecord(raw)) return [];
  // Named wrappers first, so a payload that also carries, say, a list of
  // suggested accounts cannot win the race against the real post list.
  for (const key of ["items", "aweme_list", "posts", "data", "result", "output"]) {
    const found = findPosts(raw[key], depth + 1);
    if (found.length) return found;
  }
  for (const value of Object.values(raw)) {
    const found = findPosts(value, depth + 1);
    if (found.length) return found;
  }
  return [];
}

const POST_MARKERS = [
  "caption",
  "desc",
  "play_count",
  "ig_play_count",
  "like_count",
  "statistics",
  "taken_at",
  "create_time",
];

function looksLikePost(item: Record<string, unknown>): boolean {
  return POST_MARKERS.some((k) => item[k] !== undefined);
}

/** Whitespace collapsed, escapes decoded. Kept whole: hashtags are content. */
function cleanCaption(value: string): string {
  return decodeEscapes(value).replace(/\s+/g, " ").trim();
}

/**
 * The opening of a caption, which is the part that has to earn the watch.
 *
 * Stops at the first hashtag run, because a wall of tags is not a hook, and
 * cuts on a word boundary so a quoted line never ends mid-word.
 */
export function captionLead(caption: string, max = 150): string {
  const beforeTags = caption.split(/\s#\S/)[0] ?? caption;
  const s = beforeTags.trim() || caption.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

/** Seconds from whichever duration field a provider used. */
function durationSeconds(item: Record<string, unknown>): number | null {
  // Instagram reports float seconds under video_duration.
  const secs = num(item, "video_duration");
  if (secs !== null && secs > 0) return Math.round(secs);
  // TikTok reports milliseconds. A short-form video is never under a tenth of
  // a second, so a small number here is a provider that switched to seconds.
  const ms = num(item, "video.duration", "duration", "video_duration_ms");
  if (ms === null || ms <= 0) return null;
  return ms < 100 ? Math.round(ms) : Math.round(ms / 1000);
}

/** The UTC calendar day of a provider timestamp, or null. */
function postedDay(item: Record<string, unknown>): string | null {
  const secs = num(item, "taken_at", "create_time", "createTime", "timestamp");
  if (secs !== null && secs > 1_000_000_000 && secs < 4_000_000_000) {
    return new Date(secs * 1000).toISOString().slice(0, 10);
  }
  // Some payloads carry microseconds instead.
  const micro = num(item, "device_timestamp");
  if (micro !== null && micro > 1_000_000_000_000_000) {
    return new Date(Math.round(micro / 1000)).toISOString().slice(0, 10);
  }
  return null;
}

/** Whether the account has this post pinned to the top of their profile. */
function isPinned(item: Record<string, unknown>): boolean {
  const ids = item.timeline_pinned_user_ids ?? item.clips_tab_pinned_user_ids;
  if (Array.isArray(ids) && ids.length) return true;
  // TikTok marks its pinned posts with is_top.
  return item.is_top === 1 || item.is_top === true || item.is_pinned === true;
}

/** One provider payload to the posts it describes. */
export function normalizeCompetitorPosts(raw: unknown): CompetitorPost[] {
  return findPosts(raw).map((item) => ({
    caption: cleanCaption(str(item, "caption.text", "desc", "title", "caption")),
    views: num(item, "play_count", "ig_play_count", "statistics.play_count", "view_count"),
    likes: num(item, "like_count", "statistics.digg_count", "digg_count"),
    comments: num(item, "comment_count", "statistics.comment_count"),
    seconds: durationSeconds(item),
    postedAt: postedDay(item),
    pinned: isPinned(item),
  }));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * How often they post, from the span the pulled posts cover.
 *
 * Counted over whole days including both ends, because several posts can share
 * a day: measuring gaps between posts instead reports a three-a-day account as
 * posting 28 times a week.
 *
 * Needs at least two distinct days. Everything landing on one day is a backlog
 * upload, not a cadence, and a number invented from it would send a client
 * chasing a schedule nobody keeps.
 */
function postsPerWeek(days: string[]): number | null {
  const times = days.map((d) => Date.parse(d)).filter((t) => Number.isFinite(t));
  if (times.length < 2) return null;
  const spanDays = (Math.max(...times) - Math.min(...times)) / 86_400_000;
  if (spanDays < 1) return null;
  const perWeek = (times.length / (spanDays + 1)) * 7;
  return Math.round(perWeek * 10) / 10;
}

/** One account's snapshot to the facts a plan can lean on, or null if empty. */
export function digestCompetitor(source: CompetitorSource): CompetitorDigest | null {
  const posts = normalizeCompetitorPosts(source.raw);
  if (!posts.length) return null;

  // What a normal week looks like is measured on normal posts. Pinned ones are
  // an account's chosen greatest hits and are years old on a real profile, so
  // they describe neither the typical post nor the current schedule. They stay
  // in `bestViews` and in `top`, where being exceptional is the point.
  const recent = posts.filter((p) => !p.pinned);
  const typical = recent.length ? recent : posts;

  const allViews = posts.map((p) => p.views).filter((v): v is number => v !== null && v >= 0);
  const views = typical.map((p) => p.views).filter((v): v is number => v !== null && v >= 0);
  const seconds = typical.map((p) => p.seconds).filter((s): s is number => s !== null && s > 0);
  const days = typical.map((p) => p.postedAt).filter((d): d is string => d !== null);

  const top = [...posts]
    .filter((p) => p.views !== null || p.caption)
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1))
    .slice(0, TOP_POSTS);

  return {
    platform: source.platform,
    handle: source.handle,
    postCount: posts.length,
    medianViews: median(views),
    bestViews: allViews.length ? Math.max(...allViews) : null,
    typicalSeconds: median(seconds),
    postsPerWeek: postsPerWeek(days),
    newestPostedAt: days.length ? days.slice().sort().at(-1)! : null,
    top,
  };
}

function group(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * The digests as text for the model.
 *
 * Deliberately compact: a snapshot is 160KB of payload and this is the couple
 * of hundred words of it that describe what works. The model is told to build
 * steps on this, so anything that is not evidence is left out.
 */
export function competitorBrief(digests: CompetitorDigest[]): string {
  if (!digests.length) return "";
  return digests
    .map((d) => {
      const facts = [
        `${d.postCount} recent posts`,
        d.medianViews !== null ? `typical post ${group(d.medianViews)} views` : null,
        d.bestViews !== null ? `best ${group(d.bestViews)} views` : null,
        d.typicalSeconds !== null ? `usually ${d.typicalSeconds}s long` : null,
        d.postsPerWeek !== null ? `about ${d.postsPerWeek} posts a week` : null,
      ].filter(Boolean);

      const best = d.top
        .map((p, i) => {
          const bits = [
            p.views !== null ? `${group(p.views)} views` : null,
            p.seconds !== null ? `${p.seconds}s` : null,
            p.likes !== null ? `${group(p.likes)} likes` : null,
            p.comments !== null ? `${group(p.comments)} comments` : null,
          ].filter(Boolean);
          const opening = captionLead(p.caption, 220);
          // Said out loud, because a pinned post is one they chose to show off
          // rather than something that worked this week.
          const tag = p.pinned ? " (pinned to their profile)" : "";
          return `  ${i + 1}. ${bits.join(", ")}${tag}${opening ? ` - opens with: "${opening}"` : " - no caption"}`;
        })
        .join("\n");

      return `@${d.handle} on ${d.platform}: ${facts.join(", ")}.\n${best}`;
    })
    .join("\n\n");
}
