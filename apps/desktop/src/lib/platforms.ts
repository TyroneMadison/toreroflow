import { PLATFORMS, PLATFORM_LABELS, type Platform } from "@toreroflow/core";
import type { PlatformId } from "../components/Pf";

/** Platform → prototype tile id (.pf.ig etc.). */
export const PF_ID: Record<Platform, PlatformId> = {
  instagram: "ig",
  tiktok: "tt",
  youtube: "yt",
  snapchat: "sc",
  facebook: "fb",
};

/** Short-form surface name per platform, matching the prototype copy. */
export const SURFACE_LABEL: Record<Platform, string> = {
  instagram: "Reels",
  tiktok: "TikTok",
  youtube: "Shorts",
  snapchat: "Spotlight",
  facebook: "Facebook",
};

export { PLATFORMS, PLATFORM_LABELS };
export type { Platform };
