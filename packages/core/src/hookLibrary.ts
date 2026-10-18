import { captionLead } from "./competitors";
import { reconcileFunnel, type FunnelStage, type VideoFormat } from "./videoFormats";

/**
 * The hook library (v0.3.34): the pure half. Mining, the model call and the
 * database live in the API; what decides which hooks are kept, how a model's
 * answer is cleaned, which videos still need reading and which hooks go into
 * a generate prompt lives here, so it can be checked without a network.
 */

export const HOOK_SOURCES = ["OWN", "WEB", "CREATOR"] as const;
export type HookSourceType = (typeof HOOK_SOURCES)[number];

/** Creator and web hooks below this niche score are not kept. */
export const HOOK_NICHE_MIN = 0.5;

/** The niche hooks are scored against when the brand has not set one. */
export const DEFAULT_HOOK_NICHE = "AI agency and content creation tools";

/** An own post counts as a top performer at this multiple of the account median. */
export const OWN_LIFT_MIN = 1.5;

/** Used when the model's format is not one of the 17. A talking head fits almost any hook. */
export const FALLBACK_FORMAT: VideoFormat = "Talking head POV";

/** Lowercase, punctuation and extra spaces gone: the text the dedupe key is hashed from. */
export function normalizeHookText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** The opening line of a caption or title: first line, hashtags off, at most 150 characters. */
export function hookFromCaption(caption: string | null | undefined): string {
  const first = String(caption ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return first ? captionLead(first, 150) : "";
}

export interface HookClassification {
  format: VideoFormat;
  funnelStage: FunnelStage | null;
  nicheScore: number;
  reworded: string | null;
}

/**
 * One model answer, cleaned: the format kept to the 17 (fallback when it is
 * not one), the stage made to agree with it, the score clamped to 0..1, and
 * an empty or unchanged reword dropped.
 */
export function cleanHookClassification(raw: Record<string, unknown> | null | undefined, original = ""): HookClassification {
  const r = raw ?? {};
  const fit = reconcileFunnel(r.format, r.funnelStage);
  const format = fit.format || FALLBACK_FORMAT;
  const funnelStage = fit.format ? fit.funnelStage : reconcileFunnel(format, r.funnelStage).funnelStage;
  const n = Number(r.nicheScore);
  const nicheScore = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  const rw = String(r.reworded ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const reworded = rw && normalizeHookText(rw) !== normalizeHookText(original) ? rw : null;
  return { format, funnelStage, nicheScore, reworded };
}

/** Keeps the hooks that fit the niche well enough. */
export function keepNicheFit<T extends { nicheScore: number }>(hooks: readonly T[], min = HOOK_NICHE_MIN): T[] {
  return hooks.filter((h) => h.nicheScore >= min);
}

/** The videos the miner has not looked at yet, at most `cap` of them, in the order given. */
export function unseenVideos<T extends { videoId: string }>(videos: readonly T[], seen: Iterable<string>, cap = Infinity): T[] {
  const done = new Set(seen);
  const out: T[] = [];
  for (const v of videos) {
    if (out.length >= cap) break;
    if (done.has(v.videoId)) continue;
    done.add(v.videoId);
    out.push(v);
  }
  return out;
}

export interface OwnPost {
  videoId: string;
  account: string;
  hook: string;
  views: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  url?: string | null;
}

export interface HookStats {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  /** Engagement rate, percent of views. */
  er?: number;
  /** Views as a multiple of the account's median. */
  lift?: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Our own posts that did well: views at least OWN_LIFT_MIN times the median of
 * the same account, best lift first, at most `cap`. An account needs three
 * posts before a median means anything.
 */
export function topPerformers(posts: readonly OwnPost[], cap = 10): Array<OwnPost & { stats: HookStats }> {
  const byAccount = new Map<string, number[]>();
  for (const p of posts) byAccount.set(p.account, [...(byAccount.get(p.account) ?? []), p.views]);
  const out: Array<OwnPost & { stats: HookStats }> = [];
  for (const p of posts) {
    const views = byAccount.get(p.account)!;
    const med = median(views);
    if (views.length < 3 || med <= 0 || !p.hook.trim()) continue;
    const lift = p.views / med;
    if (lift < OWN_LIFT_MIN) continue;
    const eng = (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.saves ?? 0);
    out.push({
      ...p,
      stats: {
        views: p.views, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves,
        er: p.views > 0 ? Math.round((eng / p.views) * 1000) / 10 : undefined,
        lift: Math.round(lift * 10) / 10,
      },
    });
  }
  return out.sort((a, b) => b.stats.lift! - a.stats.lift!).slice(0, cap);
}

export interface SampleHook {
  text: string;
  reworded?: string | null;
  sourceType: string;
  format: string;
  funnelStage?: string | null;
  nicheScore: number;
  stats?: HookStats | null;
}

/** Niche fit plus a bonus for a proven lift, capped so one viral post cannot crowd out the rest. */
function sampleScore(h: SampleHook): number {
  const lift = Number(h.stats?.lift ?? 0);
  return h.nicheScore + (lift > 0 ? Math.min(1, lift / 3) : 0);
}

/**
 * Up to `n` hooks for a generate prompt, diverse by format and stage: best
 * scored first, but a second hook of the same format, or of the same format
 * and stage, only once every other option is used.
 */
export function sampleInspiration<T extends SampleHook>(hooks: readonly T[], n = 8): T[] {
  const ranked = [...hooks].sort((a, b) => sampleScore(b) - sampleScore(a));
  const out: T[] = [];
  const formats = new Set<string>();
  const pairs = new Set<string>();
  for (const pass of [0, 1, 2]) {
    for (const h of ranked) {
      if (out.length >= n) return out;
      if (out.includes(h)) continue;
      const pair = `${h.format}|${h.funnelStage ?? ""}`;
      if (pass === 0 && formats.has(h.format)) continue;
      if (pass === 1 && pairs.has(pair)) continue;
      out.push(h);
      formats.add(h.format);
      pairs.add(pair);
    }
  }
  return out;
}

/** The prompt block for sampled hooks. Empty when there are none. */
export function inspirationPrompt(hooks: readonly SampleHook[]): string {
  if (!hooks.length) return "";
  return (
    "Hooks from this brand's hook library, as inspiration only. Borrow the shape and the energy, " +
    "never copy one verbatim:\n" +
    hooks.map((h) => `- "${h.reworded || h.text}" (${h.format}${h.funnelStage ? `, ${h.funnelStage}` : ""})`).join("\n")
  );
}
