import http from "node:http";
import https from "node:https";
import { WINDOW_THRESHOLD_SEC, pickLanguage, transcribeWindows, type LanguageSource } from "@toreroflow/core";
import type { TranscriptSegment } from "@toreroflow/media";
import { env } from "./env";

/**
 * Per request. A whole-file request used to wait forever on a hung service;
 * long sources are windowed below so one window always fits inside this.
 */
const TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS ?? 45 * 60 * 1000);

export interface Transcript {
  segments: TranscriptSegment[];
  language?: string;
  /** Phase 9: whisper's detection probability; null when the language was set. */
  languageProbability?: number | null;
  /** "set" | "detected" | "fallback" */
  languageSource?: LanguageSource;
}

// ponytail: node:http, not fetch. Global fetch (undici) drops any request
// whose first byte takes over 300 s, and a 20 min source on a busy box (proxy
// and filmstrip encodes running beside whisper) took longer than that, so the
// clip job failed with "fetch failed". Here only TIMEOUT_MS applies.
function post(body: Record<string, unknown>): Promise<Transcript> {
  const url = new URL(`${env.CAPTIONS_URL}/transcribe`);
  const payload = JSON.stringify(body);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (e) => reject(new Error(`the transcription service did not answer (${e.message})`)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            return reject(new Error(`transcription failed: ${status} ${text.slice(0, 300)}`));
          }
          try {
            resolve(JSON.parse(text) as Transcript);
          } catch {
            reject(new Error("transcription failed: the service sent something that is not JSON"));
          }
        });
      },
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`transcription timed out after ${Math.round(TIMEOUT_MS / 60000)} min`));
    });
    req.on("error", (e) => {
      reject(
        e.message.startsWith("transcription timed out")
          ? e
          : new Error(`the transcription service did not answer (${e.message})`),
      );
    });
    req.end(payload);
  });
}

/**
 * Throws with a readable reason. Sources over 20 minutes go in 10-minute
 * windows with a 2 s overlap; each overlap belongs to whichever window owns
 * its midpoint (the rule stitchWindows in core applies to bare words), so no
 * segment or word lands twice.
 */
export async function transcribeStrict(
  sourcePath: string,
  opts: { durationSec?: number | null; language?: string | null; hint?: string | null } = {},
): Promise<Transcript> {
  const language = opts.language || undefined;
  const fallback = opts.hint || "en";
  const dur = opts.durationSec ?? 0;
  if (dur <= WINDOW_THRESHOLD_SEC) return checked(await post({ path: sourcePath, language, fallback_language: fallback }));
  const windows = transcribeWindows(dur, 600, 2);
  const parts: TranscriptSegment[][] = [];
  let detected: string | undefined;
  let first: Transcript | undefined;
  // Sequential on purpose: the service holds one model, so parallel windows
  // only queue there and race the timeout. The first window decides the
  // language (with the weak-detection fallback); the rest are told it.
  for (const w of windows) {
    let t = await post({ path: sourcePath, language: language ?? detected, fallback_language: fallback, start: w.start, dur: w.dur });
    if (!first) {
      t = await checked(t, { start: w.start, dur: w.dur });
      first = t;
    }
    detected ??= t.language;
    parts.push(t.segments);
  }
  const segments: TranscriptSegment[] = [];
  parts.forEach((segs, i) => {
    const w = windows[i];
    const prev = windows[i - 1];
    const next = windows[i + 1];
    const lo = prev ? (w.start + prev.start + prev.dur) / 2 : -Infinity;
    const hi = next ? (next.start + w.start + w.dur) / 2 : Infinity;
    for (const s of segs) {
      if (s.start < lo || s.start >= hi) continue;
      segments.push({ ...s, words: s.words?.filter((x) => x.start >= lo && x.start < hi) });
    }
  });
  return {
    segments,
    language: language ?? detected,
    languageProbability: first?.languageProbability ?? null,
    languageSource: language ? "set" : first?.languageSource,
  };

  /**
   * An older captions service sends no probability and ignores the fallback:
   * then the worker applies the same rule and, when the guess loses, asks
   * again with the language set.
   */
  async function checked(t: Transcript, win: { start?: number; dur?: number } = {}): Promise<Transcript> {
    if (language) return { ...t, language, languageSource: "set", languageProbability: null };
    if (t.languageSource) return t;
    const pick = pickLanguage({ detected: t.language, prob: t.languageProbability, hint: fallback });
    if (pick.source !== "fallback") return { ...t, languageSource: "detected" };
    const again = await post({ path: sourcePath, language: pick.language, ...win });
    return { ...again, language: pick.language, languageSource: "fallback", languageProbability: t.languageProbability ?? null };
  }
}

/** Lenient form the analyzer and knowledge readers use: null on failure. */
export async function transcribe(sourcePath: string): Promise<Transcript | null> {
  try {
    return await transcribeStrict(sourcePath);
  } catch (err) {
    console.warn(`[worker] transcribe ${sourcePath}: ${(err as Error).message}`);
    return null;
  }
}
