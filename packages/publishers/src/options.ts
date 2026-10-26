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
  /** A long-form reel (up to 15 minutes) from the long-form screen. */
  longform?: boolean;
  /** Instagram's own cover frame, in ms, overriding the shared cover. */
  thumbOffsetMs?: number;
  /** A Facebook Page id with location data. */
  locationId?: string;
  /** Usernames tagged in the reel. */
  userTags?: string[];
  /** Read by the worker, which makes the 9:16 copy; nothing goes on the wire. */
  crop916?: boolean;
}

/** Options the operator can pick at schedule time for a YouTube target. */
export interface YouTubeScheduleOptions {
  visibility?: "public" | "unlisted" | "private";
  madeForKids?: boolean;
  firstComment?: string;
  categoryId?: string;
  playlistId?: string;
  aiLabel?: boolean;
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
  /** One of the account's privacy options from TikTok's creator info. */
  privacyLevel?: string;
  allowComment?: boolean;
  /** Video only. */
  allowDuet?: boolean;
  /** Video only. */
  allowStitch?: boolean;
}

export interface TargetOptionsInput {
  platform: Platform;
  /** MediaAsset.format: "short_form" | "long_form" | null. */
  format: string | null;
  /** Public URL of the uploaded cover image, when one was chosen. */
  coverUrl: string | null;
  /**
   * The picked frame's offset when the cover is a frame of the video rather
   * than an uploaded image. A long-form reel sends this as thumbOffset, which
   * stays right on a cropped Instagram copy where the 16:9 frame image would not.
   */
  coverOffsetMs?: number | null;
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
    if (input.carousel) {
      /*
       * Post details a carousel (or a single image) does take: collaborators,
       * a location for the whole post, and people tagged on the first item.
       * A photo tag needs a spot on the picture or Instagram skips it, so it
       * goes in the middle. Nothing reel-shaped (trial, audio, feed toggle).
       */
      const ig = input.instagram;
      const psd: Record<string, unknown> = {};
      const collaborators = (ig?.collaborators ?? []).map((c) => c.trim()).filter(Boolean).slice(0, 3);
      if (collaborators.length) psd.collaborators = collaborators;
      if (ig?.locationId) psd.locationId = ig.locationId;
      const tags = (ig?.userTags ?? []).map((u) => u.trim().replace(/^@/, "")).filter(Boolean);
      if (tags.length) psd.userTags = tags.map((username) => ({ username, x: 0.5, y: 0.5, mediaIndex: 0 }));
      if (Object.keys(psd).length) out.platformSpecificData = psd;
      return out;
    }

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
    /*
     * The long-form screen's reels (up to 15 minutes) declare no contentType
     * either: the provider makes a reel of a video by default, and "reels"
     * is the declaration that held a 106 second video at the old limit. They
     * are reels all the same, so trials and audio stay on offer.
     */
    const ig = input.instagram;
    const lf = ig?.longform === true;
    const longForm =
      input.instagramFeedPost === true ||
      (!lf && input.durationSec != null && input.durationSec > INSTAGRAM_REEL_MAX_SECONDS);
    const psd: Record<string, unknown> = longForm || lf ? {} : { contentType: "reels" };
    // Long-form: a frame goes as an offset into the video Instagram actually
    // gets (it may be a 9:16 crop), an uploaded image as the image.
    const frameMs = lf ? (ig?.thumbOffsetMs ?? input.coverOffsetMs ?? null) : null;
    if (frameMs != null) psd.thumbOffset = frameMs;
    else if (input.coverUrl) psd.instagramThumbnail = input.coverUrl;
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
      if (ig.locationId) psd.locationId = ig.locationId;
      const tags = (ig.userTags ?? []).map((u) => u.trim().replace(/^@/, "")).filter(Boolean);
      if (tags.length) psd.userTags = tags.map((username) => ({ username }));
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
    // Who can see it and how people can respond: TikTok's own post settings.
    // Duet and stitch are video features, so a photo post never carries them.
    const tk = input.tiktok;
    const audience: Record<string, unknown> = {};
    if (tk?.privacyLevel) audience.privacy_level = tk.privacyLevel;
    if (tk?.allowComment !== undefined) audience.allow_comment = tk.allowComment;
    if (!input.carousel) {
      if (tk?.allowDuet !== undefined) audience.allow_duet = tk.allowDuet;
      if (tk?.allowStitch !== undefined) audience.allow_stitch = tk.allowStitch;
    }

    if (input.carousel) {
      out.tiktokSettings = {
        media_type: "photo",
        content_preview_confirmed: true,
        express_consent_given: true,
        ...(input.tiktok?.autoAddMusic ? { auto_add_music: true } : {}),
        ...(input.caption ? { description: input.caption } : {}),
        ...audience,
      };
      if (input.tiktokTitle) out.contentOverride = input.tiktokTitle;
      return out;
    }

    const settings: Record<string, unknown> = { ...audience };
    // An uploaded image wins; otherwise a picked frame goes as its offset.
    if (input.coverUrl) settings.video_cover_image_url = input.coverUrl;
    else if (input.coverOffsetMs != null) settings.video_cover_timestamp_ms = input.coverOffsetMs;
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

/** One target's share of a provider post. */
export interface PostPart {
  platform: Platform;
  accountId: string;
  caption: string;
  /** The video this platform gets: the original, or an Instagram copy. */
  mediaUrl: string;
  extras: BuiltPostExtras;
}

/**
 * Several targets as ONE provider post: the long-form "Both" case, YouTube and
 * Instagram in a single POST /posts.
 *
 * The first part (YouTube, sorted first) owns the shared content, media and
 * thumbnail. Every other part carries its own text as customContent and its
 * own video as customMedia, always, so the YouTube thumbnail on the shared
 * item never leaks onto Instagram and an Instagram copy never reaches YouTube.
 */
export function combinePostParts(parts: PostPart[]): {
  content: string;
  mediaUrl: string;
  mediaThumbnail?: string;
  targets: Array<{
    platform: Platform;
    accountId: string;
    platformSpecificData?: Record<string, unknown>;
    customContent?: string;
    customMedia?: Array<{ url: string; type: "video" }>;
  }>;
} {
  const sorted = [...parts].sort((a, b) => Number(b.platform === "youtube") - Number(a.platform === "youtube"));
  const lead = sorted[0]!;
  return {
    content: lead.caption,
    mediaUrl: lead.mediaUrl,
    ...(lead.extras.mediaThumbnail ? { mediaThumbnail: lead.extras.mediaThumbnail } : {}),
    targets: sorted.map((p, i) => ({
      platform: p.platform,
      accountId: p.accountId,
      ...(p.extras.platformSpecificData ? { platformSpecificData: p.extras.platformSpecificData } : {}),
      ...(i === 0 ? {} : { customContent: p.caption, customMedia: [{ url: p.mediaUrl, type: "video" as const }] }),
    })),
  };
}
