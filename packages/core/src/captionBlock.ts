/**
 * A client's standing caption text, composed onto every post.
 *
 * Final caption = original caption, then the matching keyword line (if any),
 * then the caption block, each on the very next line. No blank line and no
 * divider between parts; line breaks inside the block are kept exactly.
 * YouTube's title is never touched here: only captions and descriptions.
 */
import { z } from "zod";

export const captionKeywordSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  line: z.string().trim().min(1).max(500),
});
export type CaptionKeyword = z.infer<typeof captionKeywordSchema>;

export const captionBlockSettingsSchema = z.object({
  captionBlock: z.string().max(3000).nullable().optional(),
  captionBlockOn: z.boolean().optional(),
  captionKeywords: z.array(captionKeywordSchema).max(30).optional(),
});

export interface CaptionBlockSettings {
  captionBlock?: string | null;
  captionBlockOn?: boolean;
  captionKeywords?: unknown;
}

export interface ComposeInput {
  caption: string;
  /** Video title / name and Trello card title, used only for keyword matching. */
  title?: string;
  cardName?: string;
  /** Per-post switch. False skips the block and keyword line. */
  useBlock?: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parsed keyword lines; anything malformed is dropped rather than thrown. */
export function readCaptionKeywords(value: unknown): CaptionKeyword[] {
  const r = z.array(captionKeywordSchema).safeParse(value ?? []);
  return r.success ? r.data : [];
}

/** First keyword line whose keyword appears (whole word, any case). */
export function keywordLineFor(keywords: CaptionKeyword[], haystacks: string[]): string | null {
  const text = haystacks.filter(Boolean).join("\n");
  for (const k of keywords) {
    if (k.keywords.some((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}($|[^\\p{L}\\p{N}])`, "iu").test(text))) {
      return k.line;
    }
  }
  return null;
}

/** Normalises CRLF to LF and strips only leading/trailing blank space. */
function clean(block: string | null | undefined): string {
  return (block ?? "").replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "");
}

export function composeCaption(input: ComposeInput, settings: CaptionBlockSettings): string {
  const original = input.caption.replace(/\s+$/, "");
  if (input.useBlock === false || settings.captionBlockOn === false) return original;
  if (original.includes(clean(settings.captionBlock) || "\u0000")) return original; // already composed
  const line = keywordLineFor(readCaptionKeywords(settings.captionKeywords), [
    input.title ?? "",
    input.cardName ?? "",
    input.caption,
  ]);
  const parts = [original, line, clean(settings.captionBlock)].filter((p): p is string => !!p);
  return parts.join("\n");
}
