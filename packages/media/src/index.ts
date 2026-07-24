import type { Platform } from "@toreroflow/core";

/**
 * Per-platform encode profiles (spec Section 9). Real ffmpeg reframe/transcode
 * and ASS caption burn-in land in M2; the profile table lives here so the
 * composer and pipeline share one source of truth.
 */
export interface EncodeProfile {
  platform: Platform;
  aspect: "9:16";
  width: number;
  height: number;
  maxDurationSec: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}

export const ENCODE_PROFILES: Record<Platform, EncodeProfile> = {
  instagram: { platform: "instagram", aspect: "9:16", width: 1080, height: 1920, maxDurationSec: 90, videoBitrateKbps: 8000, audioBitrateKbps: 128 },
  tiktok: { platform: "tiktok", aspect: "9:16", width: 1080, height: 1920, maxDurationSec: 600, videoBitrateKbps: 8000, audioBitrateKbps: 128 },
  youtube: { platform: "youtube", aspect: "9:16", width: 1080, height: 1920, maxDurationSec: 60, videoBitrateKbps: 10000, audioBitrateKbps: 128 },
  snapchat: { platform: "snapchat", aspect: "9:16", width: 1080, height: 1920, maxDurationSec: 60, videoBitrateKbps: 8000, audioBitrateKbps: 128 },
};
