import type { Platform } from "@toreroflow/core";

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

export interface TargetOptionsInput {
  platform: Platform;
  /** MediaAsset.format: "short_form" | "long_form" | null. */
  format: string | null;
  /** Public URL of the uploaded cover image, when one was chosen. */
  coverUrl: string | null;
  instagram?: InstagramScheduleOptions | null;
  youtube?: YouTubeScheduleOptions | null;
  youtubeTitle?: string | null;
}

export interface BuiltPostExtras {
  /** Goes inside this target's platforms[] entry. */
  platformSpecificData?: Record<string, unknown>;
  /** Goes at the top level of the request body (TikTok's shape). */
  tiktokSettings?: Record<string, unknown>;
  /** Goes on the mediaItems[] entry (YouTube long-form only). */
  mediaThumbnail?: string;
}

/**
 * Maps a target's chosen options onto Zernio's exact request fields.
 *
 * Every Instagram video is declared a reel explicitly. YouTube Shorts never
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

    const psd: Record<string, unknown> = { contentType: "reels" };
    if (input.coverUrl) psd.instagramThumbnail = input.coverUrl;
    const ig = input.instagram;
    if (ig) {
      if (ig.trial) {
        psd.trialParams = { graduationStrategy: ig.graduationStrategy ?? "MANUAL" };
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
    out.platformSpecificData = psd;
    return out;
  }

  if (input.platform === "tiktok") {
    if (input.coverUrl) {
      out.tiktokSettings = { video_cover_image_url: input.coverUrl };
    }
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
