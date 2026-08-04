/**
 * What a carousel can hold, and where it can go.
 *
 * The numbers come from the publishing provider's platform docs and they are
 * not symmetrical, which is the whole reason this file exists:
 *
 *  - Instagram takes up to 10 items and may mix images with MP4/MOV video.
 *    The Instagram app itself allows 20, but Meta has never opened that to
 *    third parties; 10 is the API ceiling for everyone, not a provider quirk.
 *  - TikTok photo posts take up to 35 items and are images only. A video in
 *    the set rules TikTok out entirely.
 *
 * So the builder needs a live answer to "given what is in the tray right now,
 * which platforms can still take it, and why not the others". Pure so those
 * rules can be pinned without a browser.
 */

export const INSTAGRAM_CAROUSEL_MAX = 10;
export const TIKTOK_CAROUSEL_MAX = 35;
/** The most any platform takes, which is what the tray itself allows. */
export const CAROUSEL_ABSOLUTE_MAX = TIKTOK_CAROUSEL_MAX;

export const CAROUSEL_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const CAROUSEL_VIDEO_TYPES = ["video/mp4", "video/quicktime"] as const;

export interface CarouselItemInfo {
  /** image | video, decided by mime type at intake. */
  kind: "image" | "video";
}

export interface PlatformVerdict {
  eligible: boolean;
  /** Why not, in words an operator acts on. Empty when eligible. */
  reason: string;
}

export interface CarouselVerdict {
  instagram: PlatformVerdict;
  tiktok: PlatformVerdict;
  /** Neither platform can take the set as it stands. */
  unpostable: boolean;
}

/**
 * Which platforms can take this set of items.
 *
 * WebP is accepted at intake because TikTok takes it, and flagged for
 * Instagram at schedule time rather than here: the server converts slides
 * anyway, so by the time Instagram sees the file it is a JPEG. Only the two
 * structural rules live here, because they are the ones no conversion fixes:
 * the count and the presence of video.
 */
export function carouselVerdict(items: CarouselItemInfo[]): CarouselVerdict {
  const count = items.length;
  const videos = items.filter((i) => i.kind === "video").length;

  const instagram: PlatformVerdict =
    count > INSTAGRAM_CAROUSEL_MAX
      ? {
          eligible: false,
          reason: `Instagram's API stops at ${INSTAGRAM_CAROUSEL_MAX} items (the app's 20 was never opened to any API). Remove ${count - INSTAGRAM_CAROUSEL_MAX} or post it to TikTok alone.`,
        }
      : { eligible: true, reason: "" };

  const tiktok: PlatformVerdict =
    videos > 0
      ? {
          eligible: false,
          reason: `TikTok photo posts are images only, and this set holds ${videos === 1 ? "a video" : `${videos} videos`}. Remove ${videos === 1 ? "it" : "them"} or post it to Instagram alone.`,
        }
      : count > TIKTOK_CAROUSEL_MAX
        ? {
            eligible: false,
            reason: `TikTok stops at ${TIKTOK_CAROUSEL_MAX} images.`,
          }
        : { eligible: true, reason: "" };

  return {
    instagram,
    tiktok,
    unpostable: count > 0 && !instagram.eligible && !tiktok.eligible,
  };
}

/**
 * The output size every slide is normalised to, from the first item's crop.
 *
 * Width is fixed at 1080, which is what both platforms serve, and the height
 * follows the ratio. Bounded to the platforms' extremes so a degenerate crop
 * cannot produce a strip a platform rejects: nothing wider than Instagram's
 * 1.91:1 landscape, nothing taller than TikTok's 9:16. Heights round to even
 * numbers because H.264 refuses odd dimensions and the videos in the set go
 * through the same geometry.
 */
export function carouselTargetSize(ratio: number): { width: number; height: number } {
  const MIN_RATIO = 9 / 16; // tallest either platform takes
  const MAX_RATIO = 1.91; // widest Instagram takes
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const width = 1080;
  const height = Math.round(width / clamped / 2) * 2;
  return { width, height };
}
