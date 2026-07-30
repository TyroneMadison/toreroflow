import { z } from "zod";

/**
 * Carousels: the words, and the spreadsheet that turns them into pictures.
 *
 * The app writes the copy and hands over a CSV. Canva's bulk create reads that
 * CSV, one design per row, and fills a template with it. Deliberately not a
 * Canva integration: a file that can be inspected, edited and re-imported
 * outlives any API, and the design template stays where the designer works.
 *
 * Instagram allows at most 10 items in a carousel and gives every item the
 * aspect ratio of the first, so the limit is enforced here rather than
 * discovered at publish time.
 */

/** Instagram's own ceiling. More than this is refused, never silently trimmed. */
export const MAX_CAROUSEL_SLIDES = 10;

export const slideSchema = z.object({
  /** The line that has to stop a thumb. Big text on the design. */
  headline: z.string().min(1).max(120),
  /** The supporting line underneath, if the template has one. */
  body: z.string().max(300).default(""),
});

export const carouselDraftSchema = z.object({
  /** What the carousel is about, in the operator's words. */
  topic: z.string().min(1).max(200),
  slides: z.array(slideSchema).min(1).max(MAX_CAROUSEL_SLIDES),
  /** The Instagram caption. Separate from the slides, which are pictures. */
  caption: z.string().max(2200).default(""),
  hashtags: z.array(z.string().max(60)).max(30).default([]),
});

export type CarouselSlide = z.infer<typeof slideSchema>;
export type CarouselDraft = z.infer<typeof carouselDraftSchema>;

/** One CSV field, quoted only when it has to be. */
function csvField(value: string): string {
  const clean = value.replace(/\r\n/g, "\n");
  if (/[",\n]/.test(clean)) return `"${clean.replace(/"/g, '""')}"`;
  return clean;
}

/**
 * The bulk create sheet: one row per slide, because one row is one design.
 *
 * A carousel of 7 slides is 7 designs, not one design with 7 fields. Getting
 * that backwards produces a single crowded image and no carousel at all.
 *
 * The slide number is included as its own column so a template can print
 * "3/7" without the designer counting, and so the rows can be sorted back into
 * order after a spreadsheet has been through them.
 */
export function toCanvaCsv(draft: {
  topic: string;
  slides: CarouselSlide[];
}): string {
  const header = ["slide", "of", "headline", "body", "topic"];
  const rows = draft.slides.map((s, i) =>
    [
      String(i + 1),
      String(draft.slides.length),
      s.headline,
      s.body ?? "",
      draft.topic,
    ].map(csvField).join(","),
  );
  // A trailing newline: some spreadsheet importers drop the last row without it.
  return [header.join(","), ...rows].join("\r\n") + "\r\n";
}

/**
 * A filename a person can find again.
 *
 * The topic, flattened. Two carousels on the same topic would otherwise
 * overwrite each other in a downloads folder, so the caller adds the date.
 */
export function csvFileName(topic: string, dateIso: string): string {
  const slug =
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "carousel";
  return `${slug}-${dateIso.slice(0, 10)}.csv`;
}

/** The caption as it will be posted: text, then the tags. */
export function carouselCaption(draft: { caption: string; hashtags: string[] }): string {
  const tags = draft.hashtags
    .map((h) => `#${h.replace(/^#+/, "").trim()}`)
    .filter((h) => h.length > 1)
    .join(" ");
  return [draft.caption.trim(), tags].filter(Boolean).join("\n\n");
}
