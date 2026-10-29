import type { BrandKit, RepurposeJob } from "@toreroflow/contracts";

/*
 * Pure helpers behind the ideas screens (approval links, brand kit, monthly
 * report, content requests, insights and best time, failed posts, assets,
 * Sunra carousels, repurpose). No DOM and no fetch, so ideas.check.ts runs
 * them under plain node.
 */

/** Every time on these screens is Eastern, the way the clients talk about it. */
export const ET = "America/New_York";

/* ---- time ---- */

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "numeric", hourCycle: "h23" });
const DAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Day of week (Mon = 0) and hour (0 to 23) of an instant, in ET. */
export function etDayHour(iso: string): { day: number; hour: number } {
  const parts = etFmt.formatToParts(new Date(iso));
  const day = DAY_INDEX[parts.find((p) => p.type === "weekday")!.value]!;
  const hour = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  return { day, hour };
}

/** "6 PM", "12 AM". */
export function hourLabel(h: number): string {
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

/** "Oct 29, 6:00 PM ET". */
export function fmtEt(iso: string, withDate = true): string {
  const s = new Date(iso).toLocaleString("en-US", {
    timeZone: ET,
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
  return `${s} ET`;
}

/** 0:05:20 for a moment in a video. Hours always shown, like the mockup. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ---- client approval links ---- */

export const EXPIRY_HOURS = [24, 72, 168, 336, 720] as const;

/** "In 7 days (Nov 2)". */
export function expiryLabel(hours: number, now = new Date()): string {
  const at = new Date(now.getTime() + hours * 3600_000);
  const date = at.toLocaleDateString("en-US", { timeZone: ET, month: "short", day: "numeric" });
  const n = hours / 24;
  return `In ${n === 1 ? "1 day" : `${n} days`} (${date})`;
}

export type LinkState = "pending" | "approved" | "changes_requested" | "expired" | "revoked";

/** What a link is now: revoked and expired win over whatever the client said. */
export function linkState(l: { status: LinkState | string; expiresAt: string; revokedAt: string | null }, now = new Date()): LinkState {
  if (l.revokedAt) return "revoked";
  if (new Date(l.expiresAt) <= now) return "expired";
  return l.status as LinkState;
}

export const LINK_STATE_LABEL: Record<LinkState, string> = {
  pending: "Waiting for the client",
  approved: "Approved",
  changes_requested: "Changes requested",
  expired: "Expired",
  revoked: "Turned off",
};

/** The address a client opens. The API answers url as "/a/<token>". */
export function publicLink(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

/* ---- brand kit ---- */

export const HEX = /^#[0-9a-fA-F]{6}$/;

/** One Google Fonts CSS link for every family in the kit, or null for none. */
export function googleFontsHref(fonts: BrandKit["fonts"]): string | null {
  const fams = fonts.filter((f) => f.family.trim());
  if (!fams.length) return null;
  const q = fams
    .map((f) => {
      const w = [...new Set(f.weights.length ? f.weights : [400])].sort((a, b) => a - b);
      return `family=${f.family.trim().replace(/ /g, "+")}:wght@${w.join(";")}`;
    })
    .join("&");
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}

/** The weight to draw a role in: the heaviest for a headline, 400 (or nearest) for body. */
export function pickWeight(weights: number[], role: "headline" | "body"): number {
  if (!weights.length) return 400;
  if (role === "headline") return Math.max(...weights);
  return weights.reduce((best, w) => (Math.abs(w - 400) < Math.abs(best - 400) ? w : best), weights[0]!);
}

/**
 * Where the logo sits on a thumbnail: bottom right, a fifth of the short
 * side, aspect kept, inset by 4%.
 */
export function logoBox(w: number, h: number, lw: number, lh: number): { x: number; y: number; w: number; h: number } {
  const side = Math.min(w, h) / 5;
  const scale = Math.min(side / lw, side / lh);
  const bw = Math.round(lw * scale);
  const bh = Math.round(lh * scale);
  const pad = Math.round(Math.min(w, h) * 0.04);
  return { x: w - bw - pad, y: h - bh - pad, w: bw, h: bh };
}

/** Relative brightness, 0 (black) to 1 (white). */
function luma(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/**
 * What "Apply brand kit" changes on the caption style: the accent becomes the
 * kit's first real color (not near-black or near-white, which vanish as a
 * highlight), and the font becomes the first kit font the export can draw.
 * Anything the kit cannot answer is left as it is.
 */
export function brandCaptionPatch(
  kit: Pick<BrandKit, "fonts" | "colors">,
  exportFonts: readonly string[],
): { accentColor?: string; font?: string } {
  const out: { accentColor?: string; font?: string } = {};
  const accent = kit.colors.find((c) => HEX.test(c) && luma(c) > 0.12 && luma(c) < 0.9);
  if (accent) out.accentColor = accent.toUpperCase();
  const font = kit.fonts.map((f) => f.family).find((f) => exportFonts.includes(f));
  if (font) out.font = font;
  return out;
}

/* ---- monthly report ---- */

/** The month that just ended, in ET, as YYYY-MM. */
export function previousMonth(now = new Date()): string {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit" })
    .format(now)
    .split("-")
    .map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** The n months before this one, newest first. */
export function recentMonths(n: number, now = new Date()): string[] {
  const out = [previousMonth(now)];
  while (out.length < n) {
    const [y, m] = out[out.length - 1]!.split("-").map(Number) as [number, number];
    out.push(m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`);
  }
  return out;
}

/** "October 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
}

/** The next 1st of the month in ET, as "Nov 1". */
export function nextRunLabel(now = new Date()): string {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit" })
    .format(now)
    .split("-")
    .map(Number) as [number, number];
  return new Date(Date.UTC(m === 12 ? y + 1 : y, m % 12, 1, 12)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/** 212K, 1.4M, 950. */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (a >= 10_000) return `${Math.round(n / 1000)}K`;
  if (a >= 1_000) return `${+(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/* ---- best time to post ---- */

/** Three-hour bands, labelled by their start. */
export const BANDS = [0, 3, 6, 9, 12, 15, 18, 21] as const;
export const ENOUGH_POSTS = 20;
export const WINDOW_DAYS = 90;

export interface Slot {
  day: number;
  band: number;
  avg: number;
  posts: number;
  /** Percent above the average post. */
  uplift: number;
}
export interface BestTime {
  /** avg views per post, [day][band], null where nothing was posted. */
  grid: (number | null)[][];
  max: number;
  count: number;
  enough: boolean;
  slots: Slot[];
}

/**
 * Average views per post by ET day and three-hour band, over the last 90
 * days, and the three best cells against the overall average. A cell with one
 * post can top the list on luck alone, so slots need two.
 */
export function bestTime(posts: { publishedAt: string; views: number }[], now = new Date()): BestTime {
  const since = now.getTime() - WINDOW_DAYS * 86_400_000;
  const cells = DAYS.map(() => BANDS.map(() => ({ n: 0, total: 0 })));
  let n = 0;
  let total = 0;
  for (const p of posts) {
    const t = new Date(p.publishedAt).getTime();
    if (!(t >= since && t <= now.getTime())) continue;
    const { day, hour } = etDayHour(p.publishedAt);
    const c = cells[day]![Math.floor(hour / 3)]!;
    c.n++;
    c.total += p.views;
    n++;
    total += p.views;
  }
  const overall = n ? total / n : 0;
  const grid = cells.map((row) => row.map((c) => (c.n ? c.total / c.n : null)));
  const slots: Slot[] = [];
  cells.forEach((row, day) =>
    row.forEach((c, b) => {
      if (c.n < 2) return;
      const avg = c.total / c.n;
      slots.push({ day, band: BANDS[b]!, avg, posts: c.n, uplift: overall ? Math.round((avg / overall - 1) * 100) : 0 });
    }),
  );
  slots.sort((a, b) => b.avg - a.avg);
  return {
    grid,
    max: Math.max(0, ...grid.flat().map((v) => v ?? 0)),
    count: n,
    enough: n >= ENOUGH_POSTS,
    slots: slots.slice(0, 3).filter((s) => s.uplift > 0),
  };
}

/** "Thu 6 to 9 PM ET". */
export function slotLabel(s: { day: number; band: number }): string {
  const end = (s.band + 3) % 24;
  const a = hourLabel(s.band);
  const b = hourLabel(end);
  const sameHalf = a.slice(-2) === b.slice(-2);
  return `${DAYS[s.day]} ${sameHalf ? a.slice(0, -3) : a} to ${b} ET`;
}

/* ---- merged insights ---- */

export const SOURCE_LABEL: Record<string, string> = {
  zernio: "Zernio",
  instagram: "Instagram API",
  youtube: "YouTube API",
  tiktok: "TikTok API",
  toreroflow: "Toreroflow",
};

/** Merged rows grouped for a table: one row per metric, one column per platform plus total. */
export function insightTable<T extends { metric: string; platform?: string }>(rows: T[]): { metric: string; cells: Record<string, T> }[] {
  const by = new Map<string, Record<string, T>>();
  for (const r of rows) {
    const cells = by.get(r.metric) ?? {};
    cells[r.platform ?? "total"] = r;
    by.set(r.metric, cells);
  }
  return [...by.entries()].map(([metric, cells]) => ({ metric, cells }));
}

/* ---- failed posts ---- */

export const RETRY_OUTCOME: Record<"queued" | "already_live" | "needs_reconnect", string> = {
  queued: "Queued again. It posts on the next run.",
  already_live: "It was already live. Nothing was re-uploaded.",
  needs_reconnect: "The account needs reconnecting first.",
};

/* ---- asset library ---- */

export type Sharing = "all" | "shared" | "brand";

/** The GET /assets query for the filters. Empty values are left off. */
export function assetQuery(f: { brandId: string; type: string; sharing: Sharing }): string {
  const q = new URLSearchParams();
  if (f.brandId) q.set("brandId", f.brandId);
  if (f.type) q.set("type", f.type);
  if (f.sharing !== "all") q.set("sharing", f.sharing);
  const s = q.toString();
  return s ? `/assets?${s}` : "/assets";
}

/** The file kinds each type takes, matching the API's MIME table. */
export const ASSET_ACCEPT: Record<string, string> = {
  logo: "image/png,image/jpeg,image/webp",
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/quicktime",
  audio: "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac",
  template: "application/json,application/zip,image/png,image/jpeg",
};

/* ---- Sunra carousels ---- */

export function maxSlides(platform: "instagram" | "tiktok"): number {
  return platform === "instagram" ? 10 : 20;
}

/**
 * What a failed Sunra call means for the operator, by status. 503 is the
 * server having no Sunra key; 502 is Sunra itself failing or unreachable.
 */
export function sunraProblem(status: number | null, message: string): { text: string; notConnected?: true; newPrice?: true } {
  if (status === 503) return { text: "Sunra is not connected on the server yet. Pricing works; building does not.", notConnected: true };
  if (status === 502) return { text: `Sunra did not answer properly: ${message}. Nothing was charged for a failed build. Try again in a minute.` };
  if (status === 403) return { text: "Sunra spending is OFF. Turn it on to build." };
  if (status === 410 || status === 409) return { text: `${message}. Get a new price.`, newPrice: true };
  if (status === 400) return { text: `Sunra cannot build that: ${message}.`, newPrice: true };
  return { text: message };
}

/** Models that can make this platform's slide shape. An empty list means Sunra did not say, so the model stays. */
export function modelsFor<T extends { supportedAspectRatios: string[] }>(models: T[], platform: "instagram" | "tiktok"): T[] {
  const ratio = platform === "instagram" ? "4:5" : "9:16";
  return models.filter((m) => !m.supportedAspectRatios.length || m.supportedAspectRatios.includes(ratio));
}

/* ---- repurpose ---- */

export const REPURPOSE_STEPS: { id: RepurposeJob["step"]; label: string }[] = [
  { id: "transcribe", label: "Transcribe" },
  { id: "find_moments", label: "Find moments" },
  { id: "cut", label: "Cut clips" },
  { id: "captions", label: "Captions" },
  { id: "thumbnails", label: "Thumbnails" },
  { id: "review", label: "Review" },
];

export type StepStatus = "done" | "running" | "queued" | "failed" | "todo";

export function stepStatus(job: Pick<RepurposeJob, "step" | "state">, step: RepurposeJob["step"]): StepStatus {
  if (job.state === "done") return "done";
  const at = REPURPOSE_STEPS.findIndex((s) => s.id === job.step);
  const i = REPURPOSE_STEPS.findIndex((s) => s.id === step);
  if (i < at) return "done";
  if (i > at) return "todo";
  return job.state === "running" ? "running" : job.state === "failed" ? "failed" : "queued";
}

/** 0 to 1. A running step counts as half done. */
export function repurposeProgress(job: Pick<RepurposeJob, "step" | "state">): number {
  if (job.state === "done") return 1;
  const at = REPURPOSE_STEPS.findIndex((s) => s.id === job.step);
  return (at + (job.state === "running" ? 0.5 : 0)) / REPURPOSE_STEPS.length;
}

/** "14:02" for a source length. */
export function fmtDuration(sec: number | null): string {
  if (sec == null) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
