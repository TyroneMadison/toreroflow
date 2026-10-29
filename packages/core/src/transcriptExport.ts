import { chunksFor, editedWords, type CaptionChunk } from "./captionChunks";
import type { CaptionSettings, EditDoc } from "./editDoc";
import { edlFromDoc, outputWords } from "./edl";
import type { Word } from "./autoCut";

/** Seconds to SRT time, HH:MM:SS,mmm. */
export function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms % 1000, 3)}`;
}

/**
 * The burned-in caption pages as SRT, same chunks and break overrides as the
 * ASS, so a platform's own captions match the video word for word.
 */
export function toSrt(chunks: CaptionChunk[], cap?: Pick<CaptionSettings, "breaks">): string {
  const overrides = new Map((cap?.breaks ?? []).map((b) => [b.chunkIndex, b.text]));
  return chunks
    .map((c, k) => `${k + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${overrides.get(k) ?? c.text}\n`)
    .join("\n");
}

/** Plain transcript of the edit: words in play order, a paragraph per long pause. */
export function toTxt(words: Word[], paragraphGap = 1.5): string {
  let out = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i > 0) out += w.start - words[i - 1].end >= paragraphGap ? "\n\n" : " ";
    out += w.word.trim();
  }
  return out ? out + "\n" : "";
}

/**
 * SRT and TXT for an edit, built exactly like the render's captions: word
 * edits, then the cut's output times, then the same chunk packing.
 * ponytail: plain text only; caption case and emojis stay in the burn-in.
 */
export function transcriptFromDoc(
  doc: EditDoc,
  durations: Record<string, number>,
  rawWords: Record<string, Word[]>,
): { srt: string; txt: string } {
  const edl = edlFromDoc(doc, durations);
  const byAsset: Record<string, Word[]> = {};
  for (const [id, w] of Object.entries(rawWords)) byAsset[id] = editedWords(w, doc.wordEdits[id] ?? {});
  const words = outputWords(edl, byAsset);
  const st = doc.captions.style;
  return { srt: toSrt(chunksFor(words, st.wordsPerLine, st.lines), doc.captions), txt: toTxt(words) };
}
