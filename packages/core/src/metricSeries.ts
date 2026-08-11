/**
 * Reading the daily metric history.
 *
 * ExternalVideoMetric has written one row per video per UTC day since it
 * shipped, and nothing has ever read it. This is the first reader: it turns
 * those rows into a line to draw and a "views added this period" figure, which
 * is a genuinely different fact from the lifetime total the cards have always
 * shown.
 */

/** One captured day. `capturedOn` is a YYYY-MM-DD UTC date. */
export interface DayPoint {
  capturedOn: string;
  views: number;
}

export interface SeriesSummary {
  /** Captured days inside the window, oldest first. */
  points: DayPoint[];
  /** Views gained across the window, or null with fewer than two days. */
  added: number | null;
  /**
   * True when the video was published before its first captured day, so the
   * delta measures growth since tracking began rather than since publication.
   * Callers label it differently, so the number is never read as lifetime.
   */
  sinceTracking: boolean;
}

/**
 * Summarise a video's captured days inside a window.
 *
 * Fewer than two points yields a null delta rather than zero: one measurement
 * is not a trend, and a zero would read as "this video stopped growing".
 */
export function seriesSummary(
  rows: readonly DayPoint[],
  publishedAt: string,
  from: string,
  to: string,
): SeriesSummary {
  const day = (iso: string) => iso.slice(0, 10);
  const lo = day(from);
  const hi = day(to);
  // Both bounds are inclusive: a row captured on the first or last day of the
  // window is inside it. filter() already returns a new array, so sorting it
  // does not touch the caller's rows.
  const points = rows
    .filter((r) => r.capturedOn >= lo && r.capturedOn <= hi)
    .sort((a, b) => (a.capturedOn < b.capturedOn ? -1 : 1));

  if (points.length < 2) {
    return { points, added: null, sinceTracking: false };
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return {
    points,
    added: last.views - first.views,
    sinceTracking: day(publishedAt) < first.capturedOn,
  };
}
