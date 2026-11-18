import type { AccountAnalytics } from "../../lib/api";

/* Number and date formatting shared by the Analytics screen and its phone layout. */

export function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n * 10) / 10);
}

export function fmtDur(sec: number | null): string {
  if (sec == null || sec <= 0) return "-";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** A "YYYY-MM-DD" day as written, never shifted a day back by the viewer's timezone. */
export function fmtDay(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** YouTube's default.jpg is tiny; swap for the medium-quality frame. */
export function thumb(url: string | null): string | null {
  if (!url) return null;
  return url.includes("ytimg.com") ? url.replace("/default.jpg", "/mqdefault.jpg") : url;
}

/** Follower change across the analytics window (first vs last snapshot). */
export function gain(a: AccountAnalytics): number | null {
  const f = a.history.map((h) => h.followers).filter((x): x is number => x != null);
  if (f.length < 2) return null;
  return f[f.length - 1]! - f[0]!;
}
