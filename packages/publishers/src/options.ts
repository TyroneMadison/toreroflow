import { INSTAGRAM_REEL_MAX_SECONDS, type Platform } from "@toreroflow/core";

/**
 * Options the operator can pick at schedule time for an Instagram target.
 * Field names are ours; the mapping to Zernio's names happens below, in one
 * place, so the wire format can never drift screen by screen.
 */
export interface InstagramScheduleOptions {
  trial?: boolean;
  graduationStrategy?: "MANUAL" | "SS_PERFORMANCE";
  collaborators?: string[];
  audioName?: string;
  /**
   * A track from Instagram's catalog, attached to the reel.
   *
   * Distinct from audioName above, which only relabels the operator's own
   * sound and attaches nothing. Reels and nothing else: Instagram rejects
   * catalog audio on stories, images and carousels at creation, so sending it
   * on one fails the publish rather than being ignored.
   */
  audioId?: string;
  /** Catalog track loudness, 0-100. Instagram defaults to 100. */
  audioVolume?: number;
  /** The video's own sound, 0-100. Zero mutes it under the track. */
  videoVolume?: number;
  shareToFeed?: boolean;
  firstComment?: string;
  aiLabel?: boolean;
  /**
   * Publish this target to Stories rather than as a reel.
   *
   * A story is its own post, not a setting on the reel, so "also share this
   * to my story" is a second Instagram target carrying this flag. Instagram
   * gives stories none of the options below: no collaborators, no trial, no
   * first comment, and the caption is not shown at all.
   */
  story?: boolean;
}

/**
 * Options the operator can pick at schedule time for a YouTube target.
 * relatedVideoUrl is consumed by the schedule route (it becomes a link at
 * the end of the description) and never reaches the wire, so it has no
 * mapping below.
 */
export interface YouTubeScheduleOptions {
  visibility?: "public" | "unlisted" | "private";
  madeForKids?: boolean;
  firstComment?: string;
  categoryId?: string;
  playlistId?: string;
  aiLabel?: boolean;
  relatedVideoUrl?: string;
}

/** Options the operator can pick at schedule time for a TikTok target. */
export interface TikTokScheduleOptions {
  /**
   * Let TikTok attach a recommended track to a photo carousel. TikTok picks
   * the song; no API allows choosing one from their library.
   */
  autoAddMusic?: boolean;
  /**
   * Deliver to the creator's TikTok inbox instead of publishing.
   *
   * The escape from TikTok's app-level daily cap, which counts how many
   * creators post through one publishing tool per day and is shared with every
   * other agency using it. A video sent this way is waiting inside TikTok for
   * the client to tap publish, which is a different bargain from a failed post
   * and a much better one than a video that never went anywhere.
   *
   * Set deliberately by an operator retrying a capped post, never automatically.
   * Whether the inbox route actually sidesteps the cap is documented by third
   * parties and NOT by the provider, so an automatic fallback would be a guess
   * that fails twice and reads as the fallback being broken.
   */
  draft?: boolean;
}

export interface TargetOptionsInput {
  platform: Platform;
  /** MediaAsset.format: "short_form" | "long_form" | null. */
  format: string | null;
  /** Public URL of the uploaded cover image, when one was chosen. */
  coverUrl: string | null;
  /** True when the asset is a set of images rather than a video. */
  carousel?: boolean;
  /** The caption, needed only for TikTok photo posts (see below). */
  caption?: string | null;
  /**
   * Video length in seconds, which decides whether Instagram gets a reel or a
   * feed post. Null or absent is treated as a reel, matching every video the
   * app sent before this existed.
   */
  durationSec?: number | null;
  /**
   * Send this Instagram video as a feed post rather than a reel.
   *
   * Set by the fallback after a reel has actually been refused, so the second
   * attempt takes the road that works. Not a preference: a reel is always tried
   * first because the Reels tab is where the reach is.
   */
  instagramFeedPost?: boolean;
  instagram?: InstagramScheduleOptions | null;
  youtube?: YouTubeScheduleOptions | null;
  tiktok?: TikTokScheduleOptions | null;
  youtubeTitle?: string | null;
  /** A TikTok photo post's own title, 90 chars, distinct from the caption. */
  tiktokTitle?: string | null;
}

export interface BuiltPostExtras {
  /** Goes inside this target's platforms[] entry. */
  platformSpecificData?: Record<string, unknown>;
  /** Goes at the top level of the request body (TikTok's shape). */
  tiktokSettings?: Record<string, unknown>;
  /** Goes on the mediaItems[] entry (YouTube long-form only). */
  mediaThumbnail?: string;
  /**
   * Replaces the request's top-level content field when set. A TikTok photo
   * post reads content as its 90-character title and takes the real caption
   * in tiktokSettings.description, so sending the caption as content would
   * post a truncated caption as the title and no caption at all.
   */
  contentOverride?: string;
}

/** 0-100, rounded. A volume outside the range is refused by Instagram. */
function clampVolume(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Maps a target's chosen options onto Zernio's exact request fields.
 *
 * An Instagram video is declared a reel only when it is short enough to be
 * one; longer videos go as feed posts, which is the difference between
 * publishing and failing. YouTube Shorts never
 * get a thumbnail because YouTube's API refuses them; long-form does. TikTok
 * covers ride the provider's top-level settings object, which is safe here
 * because the worker publishes exactly one target per request.
 */
export function buildPostExtras(input: TargetOptionsInput): BuiltPostExtras {
  const out: BuiltPostExtras = {};

  if (input.platform === "instagram") {
    // A story carries nothing else. Instagram does not show its caption and
    // offers it none of the reel options, so sending them would be noise the
    // provider has to reject rather than something the operator chose.
    if (input.instagram?.story) {
      out.platformSpecificData = { contentType: "story" };
      return out;
    }

    /*
     * A carousel is a plain media list to Instagram: no contentType (the
     * multiple items are the declaration), no reel options, no thumbnail (the
     * first image is the cover by definition). Declaring it a reel here was a
     * latent bug: every Instagram target used to get contentType "reels"
     * unconditionally, and a carousel publish had never actually run.
     */
    if (input.carousel) return out;

    /*
     * A reel, unless the video is too long to be one.
     *
     * Declaring contentType "reels" is what pins Instagram to its 90 second
     * limit. Omitting it sends the video as a feed post, which Instagram takes
     * up to an hour of. This is the whole reason a 106 second video could not
     * be published for three days: the app called everything a reel, so the
     * reel limit read as Instagram's limit.
     *
     * Under the limit the reel is still the right call, and deliberately so:
     * only 5 to 90 seconds at 9:16 is eligible for the Reels tab, which is
     * where the reach is. Longer videos trade that placement for existing at
     * all.
     */
    const longForm =
      input.instagramFeedPost === true ||
      (input.durationSec != null && input.durationSec > INSTAGRAM_REEL_MAX_SECONDS);
    const psd: Record<string, unknown> = longForm ? {} : { contentType: "reels" };
    if (input.coverUrl) psd.instagramThumbnail = input.coverUrl;
    const ig = input.instagram;
    if (ig) {
      // Trials are a Reels feature. Sending them on a feed post is asking the
      // provider to reject the whole thing over an option nobody can use here.
      if (ig.trial && !longForm) {
        psd.trialParams = { graduationStrategy: ig.graduationStrategy ?? "MANUAL" };
      }
      /*
       * Catalog audio, on reels only, for the same reason as trials above and
       * with a sharper edge: Instagram refuses it on a feed post at creation,
       * so a reel that falls back after being refused would fail its second
       * attempt too, on a different error, and the fallback would look broken
       * rather than the audio.
       */
      if (ig.audioId && !longForm) {
        psd.audioConfiguration = {
          audioId: ig.audioId,
          ...(ig.audioVolume !== undefined ? { audioVolume: clampVolume(ig.audioVolume) } : {}),
          ...(ig.videoVolume !== undefined ? { videoVolume: clampVolume(ig.videoVolume) } : {}),
        };
      }
      const collaborators = (ig.collaborators ?? [])
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (collaborators.length) psd.collaborators = collaborators;
      if (ig.audioName) psd.audioName = ig.audioName;
      if (ig.shareToFeed !== undefined) psd.shareToFeed = ig.shareToFeed;
      if (ig.firstComment) psd.firstComment = ig.firstComment;
      if (ig.aiLabel) psd.isAiGenerated = true;
    }
    // An empty object is not a declaration. A long-form video with no options
    // sends nothing, exactly like a carousel, rather than an empty bag the
    // provider has to interpret.
    if (Object.keys(psd).length) out.platformSpecificData = psd;
    return out;
  }

  if (input.platform === "tiktok") {
    /*
     * A TikTok carousel is a photo post, which is its own shape end to end:
     * media_type declares it, the two consent flags are required on every
     * photo post, content becomes the 90-character title, and the caption
     * moves into description. auto_add_music is the whole music story; TikTok
     * picks the track and no API allows choosing one.
     */
    if (input.carousel) {
      out.tiktokSettings = {
        media_type: "photo",
        content_preview_confirmed: true,
        express_consent_given: true,
        ...(input.tiktok?.autoAddMusic ? { auto_add_music: true } : {}),
        ...(input.caption ? { description: input.caption } : {}),
      };
      if (input.tiktokTitle) out.contentOverride = input.tiktokTitle;
      return out;
    }

    const settings: Record<string, unknown> = {};
    if (input.coverUrl) settings.video_cover_image_url = input.coverUrl;
    if (input.tiktok?.draft) settings.draft = true;
    if (Object.keys(settings).length) out.tiktokSettings = settings;
    return out;
  }

  if (input.platform === "youtube") {
    const psd: Record<string, unknown> = {};
    if (input.youtubeTitle) psd.title = input.youtubeTitle;
    const yt = input.youtube;
    if (yt) {
      if (yt.visibility) psd.visibility = yt.visibility;
      if (yt.madeForKids) psd.madeForKids = true;
      // Kids videos have comments permanently disabled, so a pinned first
      // comment cannot exist on one; drop it rather than send a request
      // YouTube must reject.
      if (yt.firstComment && !yt.madeForKids) psd.firstComment = yt.firstComment;
      if (yt.categoryId) psd.categoryId = yt.categoryId;
      if (yt.playlistId) psd.playlistId = yt.playlistId;
      if (yt.aiLabel) psd.containsSyntheticMedia = true;
    }
    if (Object.keys(psd).length) out.platformSpecificData = psd;
    if (input.coverUrl && input.format === "long_form") {
      out.mediaThumbnail = input.coverUrl;
    }
    return out;
  }

  return out;
}
