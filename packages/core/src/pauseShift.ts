/**
 * Continue uploads: where a paused brand's held posts land when it resumes.
 *
 * delta = (resume local day) - (local day of the earliest held post), in whole
 * calendar days in the brand's time zone. When delta > 0 every held post moves
 * forward by delta days at the same wall-clock time, so the spacing between
 * them is kept. Any post still not in the future after that (an earlier slot
 * on the resume day) moves forward one day at a time until it is. Nothing
 * else moves, so resuming before the earliest post's day changes nothing.
 *
 * Day arithmetic is done on the local calendar date and converted back, so a
 * 9:00 post stays 9:00 across a DST change instead of drifting an hour.
 */
export const DEFAULT_TIME_ZONE = "America/New_York";

const DAY_MS = 86_400_000;

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
}

function wall(at: Date, timeZone: string): Wall {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
    ms: at.getUTCMilliseconds(),
  };
}

/** The local calendar day as a whole-day number, for subtracting. */
export function localDayNumber(at: Date, timeZone = DEFAULT_TIME_ZONE): number {
  const w = wall(at, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d) / DAY_MS;
}

const asUtc = (w: Wall) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s, w.ms);

/** The instant showing this wall time in the zone (a skipped DST hour lands just after). */
function fromWall(w: Wall, timeZone: string): Date {
  const target = asUtc(w);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const off = asUtc(wall(new Date(guess), timeZone)) - guess;
    const next = target - off;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** Same local time of day, `days` calendar days later in the zone. */
export function addLocalDays(at: Date, days: number, timeZone = DEFAULT_TIME_ZONE): Date {
  const w = wall(at, timeZone);
  const day = new Date(Date.UTC(w.y, w.m - 1, w.d + days));
  return fromWall({ ...w, y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate() }, timeZone);
}

export interface HeldPost {
  id: string;
  scheduledAt: Date;
}

export interface ResumePlan {
  delta: number;
  /** Every held post with its time after resuming, moved or not. */
  posts: Array<HeldPost & { moved: boolean }>;
}

export function planResume(held: HeldPost[], resumeAt: Date, timeZone = DEFAULT_TIME_ZONE): ResumePlan {
  if (held.length === 0) return { delta: 0, posts: [] };
  const earliest = Math.min(...held.map((p) => p.scheduledAt.getTime()));
  const delta = localDayNumber(resumeAt, timeZone) - localDayNumber(new Date(earliest), timeZone);
  const posts = held.map((p) => {
    let at = delta > 0 ? addLocalDays(p.scheduledAt, delta, timeZone) : p.scheduledAt;
    while (at.getTime() <= resumeAt.getTime()) at = addLocalDays(at, 1, timeZone);
    return { id: p.id, scheduledAt: at, moved: at.getTime() !== p.scheduledAt.getTime() };
  });
  return { delta, posts };
}
