/** Shapes the clip-job routes answer with (apps/api/src/routes/clips.ts). */

export interface ClipRange {
  start: number;
  end: number;
}

export interface ClipCandidateRow {
  id: string;
  rank: number;
  ranges: ClipRange[];
  duration: number;
  lengthTarget: string;
  title: string;
  why: string | null;
  description: string | null;
  hashtags: string[];
  text: string | null;
  hook: number;
  flow: number;
  value: number;
  trend: number;
  relevance: number | null;
  raw: number;
  score: number;
  comments: Record<string, string> | null;
  feedback: "up" | "down" | null;
  origin: string;
  editProjectId: string | null;
  favorite?: boolean;
  createdAt: string;
}

export interface ClipJobRow {
  id: string;
  /** queued | transcribing | analyzing | curating | scoring | ready | failed */
  status: string;
  stage: string | null;
  pct: number;
  error: string | null;
  options: {
    length?: string;
    prompt?: string;
    aspect?: string;
    log?: { at: string; line: string }[];
    provider?: string;
  };
  createdAt: string;
  updatedAt: string;
  source: {
    id: string;
    name: string;
    durationSec: number | null;
    status: string;
    proxyUrl: string | null;
    stripUrl: string | null;
  };
  clipCount?: number;
  topScore?: number | null;
  candidates?: ClipCandidateRow[];
}

export const RUNNING = new Set(["queued", "transcribing", "analyzing", "curating", "scoring"]);

export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
