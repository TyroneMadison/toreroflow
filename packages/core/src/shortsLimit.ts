import { SHORT_FORM_MAX_SEC } from "./revisions";

/**
 * Stored on a YouTube Shorts target that is skipped instead of posted.
 *
 * The words are the operator-facing reason. The queue, the calendar, and the
 * failed-post list all print PostTarget.error as it is, so this string is the
 * whole message, not a code that something else translates.
 */
export const YOUTUBE_SHORTS_LIMIT_REASON = "Over 3:00, Shorts limit";

/**
 * True when a measured duration is past the YouTube Shorts cap.
 *
 * 180.0 seconds is allowed. Anything longer is not, including a fraction of a
 * second: the cap is SHORT_FORM_MAX_SEC and the comparison is strict. An
 * unknown duration is not over the cap, because refusing on a guess would
 * block a video that was never measured.
 */
export function exceedsYoutubeShortsLimit(durationSec: number | null | undefined): boolean {
  return durationSec != null && Number.isFinite(durationSec) && durationSec > SHORT_FORM_MAX_SEC;
}

/**
 * The duration to enforce, preferring a fresh probe of the file.
 *
 * Stored metadata is what the upload probe wrote. It is right until the file
 * on disk is not the file that was measured. A readable probe wins; a missing
 * file keeps the stored number; neither measurement means unknown.
 */
export function measuredDurationSec(
  probed: number | null | undefined,
  stored: number | null | undefined,
): number | null {
  for (const n of [probed, stored]) {
    if (n != null && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** "181 seconds (3:01)" or "180.1 seconds (3:00.1)". */
export function formatMeasuredDuration(durationSec: number): string {
  const rounded = Math.round(durationSec * 100) / 100;
  const secondsText = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0$/, "");
  const abs = Math.abs(rounded);
  const m = Math.floor(abs / 60);
  const s = Math.round((abs - m * 60) * 100) / 100;
  const secText = Number.isInteger(s)
    ? String(s).padStart(2, "0")
    : `${String(Math.floor(s)).padStart(2, "0")}.${s.toFixed(2).split(".")[1]!.replace(/0$/, "")}`;
  return `${secondsText} seconds (${m}:${secText})`;
}

/**
 * The sentence under a disabled Shorts control.
 *
 * Names the cap and the measured length, so the operator can see that 3:01
 * is the problem and not a stuck switch.
 */
export function youtubeShortsBlockMessage(durationSec: number): string {
  return `YouTube Shorts stops at 3:00. This video is ${formatMeasuredDuration(durationSec)}.`;
}

/**
 * Why this target must not be posted to YouTube, or null when it may.
 *
 * YouTube Shorts only. A long-form upload uses the same platform and is not
 * a Short, so a 14 minute horizontal video still publishes. Other platforms
 * are not this rule's business. Carousels are images and never Shorts.
 */
export function youtubeShortsPublishBlock(input: {
  platform: string;
  format: string | null | undefined;
  kind?: string | null;
  durationSec: number | null | undefined;
}): string | null {
  if (input.platform !== "youtube") return null;
  if (input.kind === "carousel") return null;
  if (input.format === "long_form") return null;
  if (!exceedsYoutubeShortsLimit(input.durationSec)) return null;
  return YOUTUBE_SHORTS_LIMIT_REASON;
}
