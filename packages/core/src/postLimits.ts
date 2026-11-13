import { hashtagCount, IG_CAPTION_MAX, IG_HASHTAG_MAX } from "./igLongform";
import type { Platform } from "./types";

/**
 * Caption limits per platform, and the one check the screens and the schedule
 * route both run, so a caption the screen lets through is never refused later
 * and one it blocks is refused by the server too.
 *
 * Sources (Oct 2026): Instagram 2,200 characters, 30 hashtags, 20 mentions
 * (Meta's IG media reference). TikTok through Zernio: 2,200 for a video
 * caption, 4,000 for a photo post's description (docs.zernio.com/platforms/
 * tiktok); neither Zernio nor TikTok publish a hashtag or mention cap, so none
 * is invented here. YouTube descriptions stop at 5,000.
 */
export const IG_MENTION_MAX = 20;
export const TIKTOK_VIDEO_CAPTION_MAX = 2200;
export const TIKTOK_PHOTO_DESCRIPTION_MAX = 4000;
export const TIKTOK_PHOTO_TITLE_MAX = 90;
export const YOUTUBE_DESCRIPTION_MAX = 5000;

export interface CaptionLimits {
  chars: number;
  /** Null when the platform publishes no cap. */
  hashtags: number | null;
  mentions: number | null;
}

/** The caption limits for a platform, or null when it has none we know. */
export function captionLimits(platform: Platform, opts: { photo?: boolean } = {}): CaptionLimits | null {
  if (platform === "instagram") return { chars: IG_CAPTION_MAX, hashtags: IG_HASHTAG_MAX, mentions: IG_MENTION_MAX };
  if (platform === "tiktok") {
    return { chars: opts.photo ? TIKTOK_PHOTO_DESCRIPTION_MAX : TIKTOK_VIDEO_CAPTION_MAX, hashtags: null, mentions: null };
  }
  if (platform === "youtube") return { chars: YOUTUBE_DESCRIPTION_MAX, hashtags: null, mentions: null };
  return null;
}

/** @mentions in a caption. An email address is not a mention. */
export function mentionCount(caption: string): number {
  return (caption.match(/(^|[^\p{L}\p{N}_.@])@[\p{L}\p{N}_.]+/gu) ?? []).length;
}

export interface CaptionCheck {
  chars: number;
  hashtags: number;
  mentions: number;
  limits: CaptionLimits | null;
  /** Why this caption cannot post, in words to act on. Empty means it can. */
  problems: string[];
}

const PLATFORM_NAME: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  snapchat: "Snapchat",
  facebook: "Facebook",
};

export function checkCaption(platform: Platform, caption: string, opts: { photo?: boolean } = {}): CaptionCheck {
  const limits = captionLimits(platform, opts);
  const chars = caption.length;
  const hashtags = hashtagCount(caption);
  const mentions = mentionCount(caption);
  const problems: string[] = [];
  const name = PLATFORM_NAME[platform];
  if (limits) {
    if (chars > limits.chars) {
      problems.push(
        `${chars.toLocaleString("en-US")} characters. ${name} allows ${limits.chars.toLocaleString("en-US")}. Remove ${(chars - limits.chars).toLocaleString("en-US")} to post.`,
      );
    }
    if (limits.hashtags != null && hashtags > limits.hashtags) {
      const over = hashtags - limits.hashtags;
      problems.push(`${hashtags} hashtags. ${name} allows ${limits.hashtags}. Remove ${over} to post.`);
    }
    if (limits.mentions != null && mentions > limits.mentions) {
      const over = mentions - limits.mentions;
      problems.push(`${mentions} mentions. ${name} allows ${limits.mentions}. Remove ${over} to post.`);
    }
  }
  return { chars, hashtags, mentions, limits, problems };
}
