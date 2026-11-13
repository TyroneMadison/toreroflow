import type { CadenceSuggestions } from "@toreroflow/contracts";

/**
 * W5 cadence suggestions from a brand's posting history: the 8 complete
 * weeks before this one, in ET, slots of weekday and hour. Pure; the route
 * hands in one entry per post (a fan-out counts once, at its first publish).
 *
 * A regular slot is one used in at least half of those weeks. Each week a
 * regular slot went unused is a missed slot. Best times rank slots by
 * average views.
 */
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type Day = (typeof DAYS)[number];
const WEEKS = 8;
const DAY_MS = 86_400_000;

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function et(d: Date): { day: Day; hour: number; weekOf: string } {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const day = p.weekday as Day;
  const monday = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) - DAYS.indexOf(day) * DAY_MS;
  return { day, hour: Number(p.hour), weekOf: new Date(monday).toISOString().slice(0, 10) };
}

export interface HistoryPost {
  at: Date;
  views: number | null;
}

export function suggestCadence(brandId: string, history: HistoryPost[], now: Date): CadenceSuggestions {
  const thisWeek = Date.parse(et(now).weekOf);
  const weeks = Array.from({ length: WEEKS }, (_, i) => new Date(thisWeek - (WEEKS - i) * 7 * DAY_MS).toISOString().slice(0, 10));
  const inWindow = new Set(weeks);

  const slots = new Map<string, { day: Day; time: string; weeks: Set<string>; views: number[]; posts: number }>();
  let count = 0;
  for (const post of history) {
    const { day, hour, weekOf } = et(post.at);
    if (!inWindow.has(weekOf)) continue;
    count++;
    const time = `${String(hour).padStart(2, "0")}:00`;
    const key = `${day} ${time}`;
    const slot = slots.get(key) ?? { day, time, weeks: new Set(), views: [], posts: 0 };
    slot.posts++;
    slot.weeks.add(weekOf);
    if (post.views != null) slot.views.push(post.views);
    slots.set(key, slot);
  }

  const all = [...slots.values()].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.time.localeCompare(b.time));
  const regular = all.filter((s) => s.weeks.size >= WEEKS / 2);
  const avg = (s: (typeof all)[number]) => (s.views.length ? Math.round(s.views.reduce((a, b) => a + b, 0) / s.views.length) : null);

  const bestTimes = all
    .map((s) => ({ day: s.day, time: s.time, posts: s.posts, avgViews: avg(s) }))
    .sort((a, b) => (b.avgViews ?? -1) - (a.avgViews ?? -1) || b.posts - a.posts)
    .slice(0, 3);
  const missedSlots = regular.flatMap((s) =>
    weeks.filter((w) => !s.weeks.has(w)).map((weekOf) => ({ day: s.day, time: s.time, weekOf })),
  );
  const postsPerWeek = Math.round((count / WEEKS) * 10) / 10;
  const perWeek = Math.round(postsPerWeek);
  const days = [...new Set(regular.map((s) => s.day))];
  const cadence = perWeek ? `${perWeek} per week${days.length ? `, ${days.join(" ")}` : ""}` : "";
  return { brandId, postsPerWeek, bestTimes, missedSlots, cadence };
}
