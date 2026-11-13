export type VideoFormatValue = "short_form" | "long_form";

/**
 * Boundary between short-form and long-form, in seconds.
 *
 * Three minutes is where the vertical feeds cap out (YouTube Shorts and
 * Instagram Reels both top out around here), so anything longer is being
 * made for a different surface.
 */
export const SHORT_FORM_MAX_SEC = 180;

/** Classify by duration. Unknown duration stays unclassified. */
export function formatFromDuration(
  durationSec: number | null | undefined,
): VideoFormatValue | null {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  return durationSec <= SHORT_FORM_MAX_SEC ? "short_form" : "long_form";
}

/**
 * The format an upload starts with, before anyone flips the toggle. Short-form
 * unless the file is landscape, where duration still decides as it always
 * has: a vertical video is short-form however long it runs, because the
 * toggle, not the clock, sends it to the long-form wizard.
 */
export function defaultFormat(meta: {
  durationSec: number | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
}): VideoFormatValue | null {
  const landscape = (meta.width ?? 0) > (meta.height ?? 0) && (meta.height ?? 0) > 0;
  return landscape ? formatFromDuration(meta.durationSec) : "short_form";
}

/** "short" | "long" | "short_form" | "long_form" -> the stored value; anything else null. */
export function parseVideoFormat(v: unknown): VideoFormatValue | null {
  if (v === "short" || v === "short_form") return "short_form";
  if (v === "long" || v === "long_form") return "long_form";
  return null;
}

/**
 * Trailing tokens that mark a re-export rather than a new video:
 * "Interview v2", "Interview final", "Interview (1)", "Interview revised".
 */
const REVISION_MARKER =
  /(?:^|\s)(?:v\s?\d+|ver\s?\d*|rev(?:ision|ised)?\s?\d*|final\s?\d*|fix(?:ed)?|copy(?:\s?\d+)?|edit(?:ed)?|new|\(\s?\d+\s?\))$/;

/**
 * Collapse a filename to the identity of the video it represents, so a
 * re-edit can be matched to its original. Extension, separators, case, and
 * trailing revision markers are all discarded.
 *
 * Deliberately does NOT strip a bare trailing number: "Episode 2" is a
 * different video from "Episode 3", not a revision of it.
 */
export function assetNameKey(filename: string): string {
  const base = filename
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let key = base;
  for (;;) {
    const next = key.replace(REVISION_MARKER, "").trim();
    if (next === key || next.length === 0) break;
    key = next;
  }
  // Stripping everything means the name was only markers; keep the original.
  return key.length ? key : base;
}

/** True when `candidate` looks like a re-edit of `existing`. */
export function looksLikeRevisionOf(candidate: string, existing: string): boolean {
  const a = assetNameKey(candidate);
  const b = assetNameKey(existing);
  if (!a || !b || a !== b) return false;
  // Identical raw names are a re-upload of the same cut, which still counts
  // as a revision for quota purposes.
  return true;
}
