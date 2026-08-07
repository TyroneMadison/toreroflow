/**
 * One grounding block, used by every AI feature.
 *
 * The carousel writer, the insights job, the analyzer, the brainstorm and the
 * script generator all need the same answer to "what do we know about this
 * brand". Before this there was one hand-rolled join in carousels.ts and each
 * new feature was about to grow its own, which is how two features end up
 * disagreeing about what the brand does.
 *
 * The result is plain text for a prompt, not markdown for a reader. Callers
 * paste it under a line of their own ("What we know about this brand:") and
 * skip that line entirely when this returns "", which is why an empty input has
 * to give back nothing at all rather than a page of empty headings.
 */

export interface KnowledgeContextInput {
  notes: { title: string; body: string }[];
  files: { name: string; extractedText: string }[];
  /** Client.nicheProfile, whatever shape the niche form last wrote. */
  nicheProfile?: unknown;
  /** The caller decides what counts as open; everything passed is listed. */
  ideas?: { text: string; status: string }[];
  maxChars?: number;
}

/**
 * Roughly six thousand tokens of grounding.
 *
 * Enough for a brand's notes and a couple of documents, small enough to leave
 * the model room to answer and to keep the cost of every call in the app
 * bounded by something other than how much the client uploaded.
 */
export const DEFAULT_MAX_CHARS = 24000;

/** Cut marker. Deliberately visible so the model knows it is reading a fragment. */
const CUT = " ...";

function trimTo(text: string, cap: number): string {
  const clean = text.trim();
  return clean.length <= cap ? clean : clean.slice(0, cap).trimEnd() + CUT;
}

/**
 * The niche profile is stored as JSON and its shape has changed once already
 * (a plain string, then the form's object). Read both, and read the next one
 * too rather than throwing away grounding because a field was added.
 */
function nicheText(profile: unknown): string {
  if (typeof profile === "string") return profile.trim();
  if (!profile || typeof profile !== "object") return "";
  return Object.entries(profile as Record<string, unknown>)
    .map(([key, value]) => {
      const text = Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value ?? "");
      return text.trim() ? `${key}: ${text.trim()}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function knowledgeContext(input: KnowledgeContextInput): string {
  const maxChars = Math.max(1, Math.floor(input.maxChars ?? DEFAULT_MAX_CHARS));

  // Per source before global. One 400 page PDF should cost the notes a
  // paragraph each, not the whole section, so every body is cut to an eighth of
  // the budget before anything is assembled.
  const perSource = Math.max(1, Math.floor(maxChars / 8));

  const sections: string[] = [];

  const notes = (input.notes ?? [])
    .map((n) => ({ title: (n?.title ?? "").trim(), body: trimTo(n?.body ?? "", perSource) }))
    .filter((n) => n.title || n.body)
    .map((n) => (n.title ? `### ${n.title}\n${n.body}`.trim() : n.body));
  if (notes.length) sections.push(`## Brand knowledge\n${notes.join("\n\n")}`);

  // A file with no extracted text is still processing, or failed, or is an
  // image nobody described. Listing its name teaches the model nothing and
  // invites it to guess at the contents.
  const files = (input.files ?? [])
    .map((f) => ({ name: (f?.name ?? "").trim(), text: trimTo(f?.extractedText ?? "", perSource) }))
    .filter((f) => f.text)
    .map((f) => `### ${f.name || "Untitled file"}\n${f.text}`);
  if (files.length) sections.push(`## Files\n${files.join("\n\n")}`);

  const niche = nicheText(input.nicheProfile);
  if (niche) sections.push(`## Niche\n${niche}`);

  const ideas = (input.ideas ?? [])
    .map((i) => ({ text: (i?.text ?? "").trim(), status: (i?.status ?? "").trim() }))
    .filter((i) => i.text)
    .map((i) => (i.status ? `- ${i.text} (${i.status})` : `- ${i.text}`));
  if (ideas.length) sections.push(`## Open ideas\n${ideas.join("\n")}`);

  if (!sections.length) return "";

  // Global cap, cutting at a section boundary. Sections are dropped from the
  // end rather than picked to fit, so what the model reads is always a prefix
  // of the same list and two calls on the same brand cannot disagree about
  // which half of the knowledge base exists.
  const out: string[] = [];
  let used = 0;
  for (const section of sections) {
    const cost = out.length ? section.length + 2 : section.length;
    if (used + cost > maxChars) break;
    out.push(section);
    used += cost;
  }

  // Nothing fits: the first section alone is over budget, so it gets cut mid
  // text. Better a truncated block than no grounding. The marker is paid for
  // out of the budget so the block is never longer than the caller asked for.
  if (!out.length) return trimTo(sections[0], Math.max(1, maxChars - CUT.length));

  return out.join("\n\n");
}
