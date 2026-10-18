/**
 * Shoot plan: groups unshot saved ideas into filming sessions, deterministically.
 * Ideas that share a location or people need go together; each session is
 * capped by an effort budget (easy 1, medium 2, hard 4, about 6 per session),
 * and sessions are laid across the week, one per day from Monday.
 */
export interface PlanIdea {
  id: string;
  text: string;
  difficulty?: string | null;
  needs?: Array<{ type: string; label: string }> | null;
  completed?: boolean;
}

export interface PlanSession {
  day: string;
  ideas: PlanIdea[];
  effort: number;
  where: string[];
  bring: string[];
  people: string[];
}

export const EFFORT: Record<string, number> = { easy: 1, medium: 2, hard: 4 };
export const SESSION_BUDGET = 6;
export const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const effortOf = (i: PlanIdea) => EFFORT[String(i.difficulty ?? "")] ?? 2;
const keysOf = (i: PlanIdea) =>
  (i.needs ?? []).filter((n) => n.type === "location" || n.type === "people").map((n) => n.label.toLowerCase());

export function planShoots(ideas: readonly PlanIdea[], budget = SESSION_BUDGET): PlanSession[] {
  const todo = ideas.filter((i) => !i.completed);
  // Constrained ideas first (they decide the sessions), heavier first, then stable by id.
  const sorted = [...todo].sort((a, b) =>
    keysOf(b).length - keysOf(a).length || effortOf(b) - effortOf(a) || a.id.localeCompare(b.id));
  const groups: Array<{ keys: Set<string>; ideas: PlanIdea[]; effort: number }> = [];
  for (const idea of sorted) {
    const keys = keysOf(idea);
    const e = effortOf(idea);
    const fits = (g: (typeof groups)[number]) => g.effort + e <= budget || g.ideas.length === 0;
    let g = keys.length
      ? groups.find((x) => fits(x) && keys.some((k) => x.keys.has(k)))
      : groups.find((x) => fits(x) && x.keys.size === 0);
    // A no-needs idea can also fill spare room in any session.
    if (!g && !keys.length) g = groups.find(fits);
    if (!g) { g = { keys: new Set(), ideas: [], effort: 0 }; groups.push(g); }
    g.ideas.push(idea);
    g.effort += e;
    for (const k of keys) g.keys.add(k);
  }
  return groups.map((g, n) => {
    const needs = g.ideas.flatMap((i) => i.needs ?? []);
    const uniq = (t: string) => [...new Set(needs.filter((x) => x.type === t).map((x) => x.label.replace(/^Needs\s+/i, "")))];
    const week = Math.floor(n / 7);
    return {
      day: WEEK[n % 7]! + (week ? ` (week ${week + 1})` : ""),
      ideas: g.ideas,
      effort: g.effort,
      where: uniq("location"),
      bring: uniq("prop"),
      people: uniq("people"),
    };
  });
}
