import { cleanVideoFormat, type VideoFormat } from "./videoFormats";

/**
 * How hard an idea is to film: easy, medium or hard. The model rates it from a
 * rubric; this file keeps the answer honest so it cannot be wildly off.
 */
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_RUBRIC =
  "difficulty is easy, medium or hard, judged on five things: number of shots, people or " +
  "actors needed, props and locations, performance or acting, and editing complexity. " +
  "easy: one person, one spot, few shots, no acting, simple cuts (a quick talking head). " +
  "medium: a few setups or a second person, some b-roll or a reveal edit. " +
  "hard: several actors or locations, real acting, many shots or heavy editing (a full skit shoot). " +
  "actors is how many people appear on camera; locations is how many distinct spots or setups.";

/** 0 easy, 1 medium, 2 hard: what a format usually takes before the details. */
export const FORMAT_DIFFICULTY_BASE: Record<VideoFormat, 0 | 1 | 2> = {
  Challenge: 2,
  Educational: 0,
  Storytelling: 1,
  Skits: 2,
  "Wait for it": 1,
  "Talking head POV": 0,
  Comparison: 1,
  Ranking: 0,
  "Before and after": 1,
  Reaction: 0,
  "Day in the life": 1,
  "Expectation vs reality": 1,
  "Faceless listicle": 0,
  "This is your sign": 0,
  "Unpopular opinion": 0,
  "Loading reveal": 1,
  "Tell me without telling me": 1,
};

/** The deterministic estimate from format, shot count, people and locations. */
export function estimateDifficulty(format: unknown, shots: number, actors: number, locations: number, props = 0): Difficulty {
  const f = cleanVideoFormat(format);
  const base = f ? FORMAT_DIFFICULTY_BASE[f] : 1;
  const s = base * 2 + (shots >= 5 ? 1 : 0) - (shots <= 2 ? 1 : 0) + (actors >= 2 ? 1 : 0) + (actors >= 3 ? 1 : 0) + (locations >= 2 ? 1 : 0) + (props >= 3 ? 1 : 0);
  return s <= 1 ? "easy" : s <= 3 ? "medium" : "hard";
}

/**
 * The model's rating, kept within one step of the estimate. One person in one
 * shot is never hard.
 */
export function checkDifficulty(model: unknown, format: unknown, shots: number, actors: unknown, locations: unknown, props = 0): Difficulty {
  const a = Math.max(1, Math.round(Number(actors) || 1));
  const l = Math.max(1, Math.round(Number(locations) || 1));
  const est = DIFFICULTIES.indexOf(estimateDifficulty(format, shots, a, l, props));
  const raw = DIFFICULTIES.indexOf(String(model ?? "").trim().toLowerCase() as Difficulty);
  let i = raw < 0 ? est : Math.min(est + 1, Math.max(est - 1, raw));
  if (shots <= 1 && a <= 1 && l <= 1 && props <= 1) i = Math.min(i, 1);
  return DIFFICULTIES[i]!;
}
