import { captionLimits, checkCaption, INSTAGRAM_CAROUSEL_MAX } from "@toreroflow/core";
import type { Platform } from "./platforms";

/** The composer's three post types. */
export const COMPOSER_TYPES = [
  { id: "reel", label: "Reel" },
  { id: "image", label: "Image" },
  { id: "carousel", label: "Carousel" },
] as const;
export type ComposerType = (typeof COMPOSER_TYPES)[number]["id"];

export function parseComposerType(v: string | null | undefined): ComposerType {
  return COMPOSER_TYPES.some((t) => t.id === v) ? (v as ComposerType) : "reel";
}

/** Items a post of this type holds: one image, or up to Instagram's 10. */
export const COMPOSER_MAX: Record<Exclude<ComposerType, "reel">, number> = {
  image: 1,
  carousel: INSTAGRAM_CAROUSEL_MAX,
};

/**
 * Why a platform cannot take an image or carousel post, in plain words, or
 * null when it can. Instagram and TikTok take images here; nothing else does
 * (the schedule route refuses the rest), so they are shown disabled with
 * this sentence rather than hidden.
 */
export function imagePostBlocked(platform: Platform): string | null {
  if (platform === "instagram" || platform === "tiktok") return null;
  if (platform === "youtube") return "YouTube only takes videos, so image posts can't go there.";
  return "Toreroflow posts images to Instagram and TikTok only.";
}

/**
 * Which picked files a set of this type can take, and why the rest cannot.
 * Image posts take one picture; a carousel takes pictures and short clips up
 * to 10 (a reel is its own post and never a carousel item).
 */
export function intake(
  type: Exclude<ComposerType, "reel">,
  have: number,
  files: Array<{ name: string; type: string }>,
): { accepted: number[]; notes: string[] } {
  const max = COMPOSER_MAX[type];
  const accepted: number[] = [];
  const notes: string[] = [];
  files.forEach((f, i) => {
    const image = /^image\/(jpeg|png|webp)$/.test(f.type);
    const video = /^video\/(mp4|quicktime)$/.test(f.type);
    if (!image && !video) notes.push(`${f.name} is not a JPG, PNG, WebP, MP4 or MOV.`);
    else if (video && type === "image") notes.push(`${f.name} is a video. Pick Reel for a video, or Carousel to mix it with pictures.`);
    else if (have + accepted.length >= max) {
      if (!notes.some((n) => n.startsWith("Only")))
        notes.push(type === "image" ? "Only one picture in an image post. Pick Carousel for more." : `Only ${max} items fit in a carousel.`);
    } else accepted.push(i);
  });
  return { accepted, notes };
}

/** Every caption problem across the chosen platforms, each said once. */
export function captionProblems(platforms: Platform[], caption: string, photo: boolean): string[] {
  const out: string[] = [];
  for (const p of platforms) {
    if (p !== "instagram" && p !== "tiktok") continue;
    for (const problem of checkCaption(p, caption, { photo }).problems) {
      if (!out.includes(problem)) out.push(problem);
    }
  }
  return out;
}

/**
 * The limits the counters show: Instagram's when it is chosen (the tightest,
 * and the only one with hashtag and mention caps), else TikTok's.
 */
export function meterLimits(platforms: Platform[], photo: boolean) {
  const p = platforms.includes("instagram") ? "instagram" : platforms.includes("tiktok") ? "tiktok" : null;
  return p ? { platform: p, ...captionLimits(p, { photo })! } : null;
}

/** TikTok privacy levels, in the words TikTok's own app uses. */
export const TIKTOK_PRIVACY = [
  { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
  { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
  { value: "FOLLOWER_OF_CREATOR", label: "Followers" },
  { value: "SELF_ONLY", label: "Only me" },
] as const;

export interface TikTokChoice {
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
}

export const TIKTOK_DEFAULTS: TikTokChoice = {
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: true,
  allowStitch: true,
};

/** True when the operator changed any TikTok setting from the defaults shown. */
export function tkTouched(c: TikTokChoice): boolean {
  return (Object.keys(TIKTOK_DEFAULTS) as Array<keyof TikTokChoice>).some((k) => c[k] !== TIKTOK_DEFAULTS[k]);
}

/** The schedule body's tiktok object. Duet and stitch only on a video. */
export function tiktokBody(c: TikTokChoice, photo: boolean, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    privacyLevel: c.privacyLevel,
    allowComment: c.allowComment,
    ...(photo ? {} : { allowDuet: c.allowDuet, allowStitch: c.allowStitch }),
  };
}

/** Instagram post details for an image or carousel: no reel options. */
export function igPhotoBody(d: { collaborators: string[]; userTags: string[]; locationId: string }) {
  const body: Record<string, unknown> = {};
  if (d.collaborators.length) body.collaborators = d.collaborators.slice(0, 3);
  if (d.userTags.length) body.userTags = d.userTags;
  if (d.locationId.trim()) body.locationId = d.locationId.trim();
  return Object.keys(body).length ? body : undefined;
}

/**
 * Wait for an upload to finish processing so it can be scheduled in the same
 * press. The schedule route refuses anything not ready, so this is the bridge
 * between "uploaded" and "on the calendar". Null when it is still working
 * after the last try: the upload is saved and can be scheduled later.
 */
export async function waitReady<T extends { status: string }>(
  get: () => Promise<T>,
  tries = 90,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const a = await get();
    if (a.status === "ready") return a;
    if (a.status === "failed") throw new Error("the files could not be processed");
    await sleep(2000);
  }
  return null;
}
