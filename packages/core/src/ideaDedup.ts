/**
 * Is this idea already in the list?
 *
 * The game plan job re-runs every time the operator presses Generate, and the
 * model has no memory of the plan it wrote last time. It reliably produces the
 * same idea again in slightly different words, so comparing the text exactly
 * does not work: "an honest video explaining that you never do paint work" and
 * "an honest video explaining you never do paint work" differ by one word and
 * would both land in the list.
 *
 * The prompt is told not to repeat, which handles most of it. This is the
 * backstop for when it does anyway.
 */

/** Words too common to say anything about whether two ideas are the same. */
const NOISE = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how",
  "in", "is", "it", "its", "of", "on", "or", "that", "the", "then", "this",
  "to", "up", "was", "what", "when", "why", "with", "you", "your", "video",
]);

/** Lowercase, letters and numbers only, noise words dropped. */
export function ideaTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !NOISE.has(w)),
  );
}

/**
 * How much two ideas overlap, 0 to 1 (intersection over union).
 *
 * Two empty ideas are treated as identical rather than as a divide by zero,
 * which keeps a pair of blank strings out of the list instead of letting both
 * through on a NaN comparison.
 */
export function ideaSimilarity(a: string, b: string): number {
  const ta = ideaTokens(a);
  const tb = ideaTokens(b);
  if (!ta.size && !tb.size) return 1;
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Deliberately not 1.0. At 0.8 a reworded restatement of the same idea is
 * caught while two genuinely different ideas about the same subject, which
 * share the niche's vocabulary, still both get through.
 */
export const SAME_IDEA = 0.8;

/** True when `text` says the same thing as something already in `existing`. */
export function isDuplicateIdea(text: string, existing: readonly string[]): boolean {
  return existing.some((e) => ideaSimilarity(text, e) >= SAME_IDEA);
}
