import { PLATFORM_MAX_UPLOAD_BYTES } from "./schemas";

/**
 * Instagram long-form: a reel up to 15 minutes, sent through the provider.
 *
 * The limits are the provider's Reels limits (15 minutes, 300MB) plus
 * Instagram's own 1920 pixel width cap. One function decides, and both the
 * long-form screen and the schedule route call it, so the warning the
 * operator reads and the refusal the server sends can never disagree.
 */
export const IG_LONGFORM_MIN_SECONDS = 3;
export const IG_LONGFORM_MAX_SECONDS = 15 * 60;
export const IG_LONGFORM_MAX_BYTES = PLATFORM_MAX_UPLOAD_BYTES.instagram!;
export const IG_LONGFORM_MAX_WIDTH = 1920;
export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAG_MAX = 30;

export interface IgLongformInput {
  durationSec: number | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
  /** File size on disk; null when it could not be read. */
  bytes: number | null | undefined;
  /** The operator asked for a 9:16 crop of a wider video. */
  crop916?: boolean;
}

export interface IgLongformFit {
  /** Reasons Instagram cannot take this at all. Non-empty refuses the schedule. */
  blocks: string[];
  /** Things worth saying that do not stop the post. */
  warnings: string[];
  /** Toreroflow must make an Instagram copy (smaller, narrower, or cropped). */
  needsCopy: boolean;
  /** Already 9:16, within rounding. */
  is916: boolean;
}

const mb = (n: number): string =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;

export function instagramLongformFit(input: IgLongformInput): IgLongformFit {
  const blocks: string[] = [];
  const warnings: string[] = [];
  const dur = input.durationSec ?? null;
  const w = input.width ?? 0;
  const h = input.height ?? 0;
  const is916 = w > 0 && h > 0 && Math.abs(w / h - 9 / 16) < 0.01;

  if (dur != null && dur > IG_LONGFORM_MAX_SECONDS) {
    blocks.push(
      `Instagram reels stop at 15 minutes and this video is ${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, "0")}. Trim it, or post it to YouTube only.`,
    );
  }
  if (dur != null && dur < IG_LONGFORM_MIN_SECONDS) {
    blocks.push(`Instagram needs at least ${IG_LONGFORM_MIN_SECONDS} seconds of video.`);
  }

  const tooBig = input.bytes != null && input.bytes > IG_LONGFORM_MAX_BYTES;
  const tooWide = w > IG_LONGFORM_MAX_WIDTH && !input.crop916;
  if (tooBig) {
    warnings.push(
      `Instagram needs a smaller file. This is ${mb(input.bytes!)} and Instagram allows ${mb(IG_LONGFORM_MAX_BYTES)}. Toreroflow will make a 1080p copy for Instagram. YouTube gets the original.`,
    );
  } else if (tooWide) {
    warnings.push(
      `Instagram takes at most ${IG_LONGFORM_MAX_WIDTH} pixels wide and this is ${w}. Toreroflow will make a 1080p copy for Instagram. YouTube gets the original.`,
    );
  }
  if (w > 0 && h > 0 && !is916 && !input.crop916) {
    warnings.push(
      w > h
        ? "Wide video on Instagram. It will show with bars. Want a 9:16 crop instead?"
        : "Not 9:16. Instagram shows reels best at 9:16.",
    );
  }

  return {
    blocks,
    warnings,
    needsCopy: tooBig || tooWide || (Boolean(input.crop916) && !is916),
    is916,
  };
}

/**
 * Video bitrate, in kbit/s, that lands an Instagram copy of this length under
 * the size cap with room to spare.
 *
 * Aims at 90% of the cap minus 128k of audio, never above 8 Mbit/s (plenty
 * for 1080p) and never below 500k. A 15 minute copy gets about 2.4 Mbit/s.
 * ponytail: single-pass ABR can overshoot slightly; the 10% margin covers it,
 * switch to two-pass if a copy ever lands over the cap.
 */
export function instagramCopyKbps(durationSec: number, maxBytes = IG_LONGFORM_MAX_BYTES): number {
  const totalKbps = (maxBytes * 8 * 0.9) / 1000 / Math.max(durationSec, 1);
  return Math.round(Math.min(8000, Math.max(500, totalKbps - 128)));
}

/** Hashtags in a caption, the way Instagram counts them. */
export function hashtagCount(caption: string): number {
  return (caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}
