/**
 * Strip the tells that make writing look machine made.
 *
 * The prompt asks for none of this, but a prompt is a request, not a
 * guarantee: one run in ten still comes back with an em dash. These
 * documents go to clients under Tyrone's name, so the rule is enforced in
 * code where it cannot be talked out of.
 */

/** Characters replaced with plain equivalents, in the order applied. */
const SUBSTITUTIONS: Array<[RegExp, string]> = [
  // Em and en dashes. Spaced, they were joining clauses, so a comma reads
  // the way a person would have written it. Unspaced between digits or
  // words they were standing in for a range or a join, so a hyphen fits.
  [/\s+[—–]\s+/g, ", "],
  [/[—–]/g, "-"],
  // Arrows of every common shape, including the ASCII ones people type.
  [/\s*(?:[←-⇿⟰-⟿⤀-⥿]|-{1,2}>|<-{1,2}|=>)\s*/g, " to "],
  // Smart quotes and ellipsis, same family of problem.
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/…/g, "..."],
  // Non-breaking and hair spaces read as normal spaces on a printed page.
  [/[   ]/g, " "],
];

/**
 * Plain, sendable prose: no em dashes, no arrows, no smart punctuation.
 *
 * Whitespace is tidied last, because the substitutions above can leave
 * doubles behind (" to " next to an existing space).
 */
export function toPlainText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SUBSTITUTIONS) out = out.replace(pattern, replacement);
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim();
}

/**
 * True when a string still carries anything this module exists to remove.
 *
 * Used by the check, and worth keeping exported: it is the cheapest way for
 * a future caller to assert that something is safe to send.
 */
export function hasMachineTells(value: string): boolean {
  return /[—–‘’“”…←-⇿]|--?>|<--?|=>/.test(value);
}
