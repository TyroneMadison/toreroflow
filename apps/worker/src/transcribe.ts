import http from "node:http";
import https from "node:https";
import { WINDOW_THRESHOLD_SEC, transcribeWindows } from "@toreroflow/core";
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
  opts: { durationSec?: number | null; language?: string | null } = {},
): Promise<Transcript> {
  const language = opts.language || undefined;
  const dur = opts.durationSec ?? 0;
  if (dur <= WINDOW_THRESHOLD_SEC) return post({ path: sourcePath, language });
  const windows = transcribeWindows(dur, 600, 2);
  const parts: TranscriptSegment[][] = [];
  let detected: string | undefined;
  // Sequential on purpose: the service holds one model, so parallel windows
  // only queue there and race the timeout.
  for (const w of windows) {
    const t = await post({ path: sourcePath, language: language ?? detected, start: w.start, dur: w.dur });
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
  return { segments, language: language ?? detected };
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
