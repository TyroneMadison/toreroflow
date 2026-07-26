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
