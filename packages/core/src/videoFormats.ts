/**
 * Short form video formats the idea generators pick from. The first six are
 * the original Ideas styles; the rest were added 2026-10-17 from what is
 * trending on TikTok, Reels and Shorts this month (sources in the commit).
 * Plain labels, no em dashes: these show in the app as they are.
 */
export const VIDEO_FORMATS = [
  "Challenge",
  "Educational",
  "Storytelling",
  "Skits",
  "Wait for it",
  "Talking head POV",
  "Comparison",
  "Ranking",
  "Before and after",
  "Reaction",
  "Day in the life",
  "Expectation vs reality",
  "Faceless listicle",
  "This is your sign",
  "Unpopular opinion",
  "Loading reveal",
  "Tell me without telling me",
] as const;

export type VideoFormat = (typeof VIDEO_FORMATS)[number];

/** One line each, so the model knows what shape every format takes. */
export const VIDEO_FORMAT_GUIDE: Record<VideoFormat, string> = {
  Challenge: "someone attempts a task or dare on camera",
  Educational: "teach one useful thing clearly",
  Storytelling: "a short true story with a turn at the end",
  Skits: "a short acted scene with a punchline",
  "Wait for it": "build up to a payoff the viewer stays for",
  "Talking head POV": "one person to camera, framed as a point of view",
  Comparison: "two options side by side (X vs Y) with a clear winner",
  Ranking: "rank several items from worst to best or on a tier list, ending on the top pick",
  "Before and after": "show the start, then the transformed result",
  Reaction: "react to or respond to another clip, comment or claim",
  "Day in the life": "a fast montage of a real day behind the scenes",
  "Expectation vs reality": "what people expect, then what actually happens",
  "Faceless listicle": "a numbered list told over b-roll with on-screen text, no face",
  "This is your sign": "on-screen 'this is your sign to...' nudge toward one action",
  "Unpopular opinion": "state a hot take for the niche, then back it up",
  "Loading reveal": "a percentage climbs from 0 to 100 with each cut until the final reveal",
  "Tell me without telling me": "show a niche truth through visuals only, no explaining",
};

/** Keeps a model-written format to one of the list (case-insensitive), or empty. */
export function cleanVideoFormat(value: unknown): VideoFormat | "" {
  const v = String(value ?? "").trim().toLowerCase();
  return VIDEO_FORMATS.find((f) => f.toLowerCase() === v) ?? "";
}

/* ---- funnel stages (v0.3.33) ---- */

export const FUNNEL_STAGES = ["top", "middle", "bottom"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_STAGE_GUIDE: Record<FunnelStage, string> = {
  top: "top of funnel, awareness: reach people who do not know the brand yet",
  middle: "middle of funnel, consideration: help people weigh the brand against options",
  bottom: "bottom of funnel, decision: push people who are ready to book or buy",
};

/**
 * How well each format fits each funnel stage, as weights that sum to 1.
 * Storytelling and skits lean top (reach), comparison sits middle or bottom
 * depending on intent, ranking leans bottom because it ends on a verdict.
 */
export const FORMAT_FUNNEL_WEIGHTS: Record<VideoFormat, Record<FunnelStage, number>> = {
  Challenge: { top: 0.7, middle: 0.2, bottom: 0.1 },
  Educational: { top: 0.3, middle: 0.6, bottom: 0.1 },
  Storytelling: { top: 0.7, middle: 0.2, bottom: 0.1 },
  Skits: { top: 0.8, middle: 0.15, bottom: 0.05 },
  "Wait for it": { top: 0.7, middle: 0.2, bottom: 0.1 },
  "Talking head POV": { top: 0.3, middle: 0.5, bottom: 0.2 },
  Comparison: { top: 0.1, middle: 0.5, bottom: 0.4 },
  Ranking: { top: 0.1, middle: 0.3, bottom: 0.6 },
  "Before and after": { top: 0.2, middle: 0.4, bottom: 0.4 },
  Reaction: { top: 0.6, middle: 0.3, bottom: 0.1 },
  "Day in the life": { top: 0.5, middle: 0.4, bottom: 0.1 },
  "Expectation vs reality": { top: 0.5, middle: 0.4, bottom: 0.1 },
  "Faceless listicle": { top: 0.3, middle: 0.6, bottom: 0.1 },
  "This is your sign": { top: 0.1, middle: 0.3, bottom: 0.6 },
  "Unpopular opinion": { top: 0.6, middle: 0.3, bottom: 0.1 },
  "Loading reveal": { top: 0.5, middle: 0.3, bottom: 0.2 },
  "Tell me without telling me": { top: 0.7, middle: 0.2, bottom: 0.1 },
};

/** Below this weight a format and a stage are treated as a mismatch. */
export const FUNNEL_FIT_MIN = 0.2;

/** Formats that fit a stage (weight at or above the minimum), best first. */
export function formatsForStage(stage: FunnelStage): VideoFormat[] {
  return VIDEO_FORMATS.filter((f) => FORMAT_FUNNEL_WEIGHTS[f][stage] >= FUNNEL_FIT_MIN)
    .sort((a, b) => FORMAT_FUNNEL_WEIGHTS[b][stage] - FORMAT_FUNNEL_WEIGHTS[a][stage]);
}

/** The stage a format fits best. */
export function bestStageFor(format: VideoFormat): FunnelStage {
  const w = FORMAT_FUNNEL_WEIGHTS[format];
  return FUNNEL_STAGES.reduce((best, s) => (w[s] > w[best] ? s : best), "top" as FunnelStage);
}

export function cleanFunnelStage(value: unknown): FunnelStage | null {
  const v = String(value ?? "").trim().toLowerCase().replace(/ of funnel$/, "");
  return (FUNNEL_STAGES as readonly string[]).includes(v) ? (v as FunnelStage) : null;
}

/**
 * Makes a generated idea's format and stage agree. The format is what gets
 * filmed, so it wins: a stage the format barely fits (or no stage) becomes
 * the format's best stage. Ideas without a known format keep the model's stage.
 */
export function reconcileFunnel(format: unknown, stage: unknown): { format: VideoFormat | ""; funnelStage: FunnelStage | null } {
  const f = cleanVideoFormat(format);
  const s = cleanFunnelStage(stage);
  if (!f) return { format: "", funnelStage: s };
  if (s && FORMAT_FUNNEL_WEIGHTS[f][s] >= FUNNEL_FIT_MIN) return { format: f, funnelStage: s };
  return { format: f, funnelStage: bestStageFor(f) };
}

/** Prompt lines listing the formats that suit each stage. */
export function funnelPromptGuide(): string {
  return FUNNEL_STAGES.map((s) => `${s} (${FUNNEL_STAGE_GUIDE[s]}): ${formatsForStage(s).join(", ")}`).join("\n");
}
