import { exceedsYoutubeShortsLimit, youtubeShortsBlockMessage } from "@toreroflow/core";
import type { Platform } from "./platforms";
import { imagePostBlocked } from "./postDetails";

/**
 * Why this platform cannot be ticked on the short-form schedule screen, or
 * null when it can.
 *
 * Image posts keep their own reasons. A video over 3:00 cannot be sent to
 * YouTube Shorts; the same video can still go to every other platform, and a
 * long-form upload never reaches this screen.
 */
export function schedulePlatformBlock(
  platform: Platform,
  asset: { kind: string; format: string | null; durationSec: number | null },
): string | null {
  if (asset.kind === "carousel") return imagePostBlocked(platform);
  if (
    platform === "youtube" &&
    asset.format !== "long_form" &&
    exceedsYoutubeShortsLimit(asset.durationSec)
  ) {
    return youtubeShortsBlockMessage(asset.durationSec!);
  }
  return null;
}
