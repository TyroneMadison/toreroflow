import type { EdlSegment } from "./edl";
import type { BrollItem, BrollSpot, EditDoc } from "./editDoc";

/**
 * Phase 8 collaboration & distribution helpers: comment threads and
 * timeline markers, NLE XML from the EDL, clip performance, YouTube
 * auto-import diffing, Drive links, Pexels picks and search queries.
 * All pure; the API and worker do the I/O.
 */

// ---------- comments ----------

export interface CommentRow {
  id: string;
  parentId: string | null;
  atSec: number | null;
  body: string;
  authorName: string;
  authorKind: string;
  resolvedAt: string | Date | null;
  createdAt: string | Date;
}

export interface CommentThread extends CommentRow {
  replies: CommentRow[];
}

const ms = (d: string | Date) => new Date(d).getTime();

/**
 * Roots in timeline order (untimed last, then by age), each with its
 * replies oldest first. Replies whose root is gone are dropped.
 */
export function threadComments(rows: CommentRow[]): CommentThread[] {
  const roots = rows.filter((r) => !r.parentId).map((r) => ({ ...r, replies: [] as CommentRow[] }));
  const byId = new Map(roots.map((r) => [r.id, r]));
  for (const r of rows) if (r.parentId) byId.get(r.parentId)?.replies.push(r);
  for (const r of roots) r.replies.sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  return roots.sort((a, b) => {
    const ta = a.atSec ?? Infinity;
    const tb = b.atSec ?? Infinity;
    return ta !== tb ? ta - tb : ms(a.createdAt) - ms(b.createdAt);
  });
}

export interface CommentMarker {
  id: string;
  at: number;
  count: number;
  resolved: boolean;
}

/**
 * One marker per timed root, clamped into [0, duration]. Roots closer
 * than `mergeSec` collapse into one marker (the first id), so a ruler
 * with 30 notes stays readable; resolved only when every merged note is.
 */
export function commentMarkers(threads: CommentThread[], duration: number, mergeSec = 0.5): CommentMarker[] {
  const out: CommentMarker[] = [];
  const timed = threads.filter((t) => t.atSec != null).sort((a, b) => a.atSec! - b.atSec!);
  for (const t of timed) {
    const at = Math.max(0, Math.min(duration, t.atSec!));
    const last = out[out.length - 1];
    if (last && at - last.at < mergeSec) {
      last.count += 1;
      last.resolved = last.resolved && !!t.resolvedAt;
    } else {
      out.push({ id: t.id, at, count: 1, resolved: !!t.resolvedAt });
    }
  }
  return out;
}

export const openCommentCount = (threads: CommentThread[]) => threads.filter((t) => !t.resolvedAt).length;

// ---------- NLE XML ----------

export interface XmlExportInput {
  name: string;
  fps: number;
  width: number;
  height: number;
  segments: EdlSegment[];
  /** assetId -> file name and source duration. */
  assets: Record<string, { name: string; durationSec: number; path?: string }>;
}

export const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const frames = (sec: number, fps: number) => Math.round(sec * fps);

/** Final Cut Pro 7 / Premiere "xmeml" v4: one video track, one clipitem per segment. */
export function edlToPremiereXml(x: XmlExportInput): string {
  const fps = Math.round(x.fps);
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  let cursor = 0;
  const seen = new Set<string>();
  const items = x.segments.map((s, i) => {
    const a = x.assets[s.assetId] ?? { name: s.assetId, durationSec: s.srcOut };
    const len = frames(s.srcOut - s.srcIn, fps);
    const start = cursor;
    cursor += len;
    const fileId = `file-${xmlEscape(s.assetId)}`;
    const file = seen.has(s.assetId)
      ? `<file id="${fileId}"/>`
      : `<file id="${fileId}"><name>${xmlEscape(a.name)}</name><pathurl>${xmlEscape(fileUrl(a.path ?? a.name))}</pathurl>${rate}<duration>${frames(a.durationSec, fps)}</duration><media><video/><audio/></media></file>`;
    seen.add(s.assetId);
    return `<clipitem id="clip-${i + 1}"><name>${xmlEscape(a.name)}</name>${rate}<start>${start}</start><end>${cursor}</end><in>${frames(s.srcIn, fps)}</in><out>${frames(s.srcIn, fps) + len}</out>${file}</clipitem>`;
  });
  const audio = x.segments.map((s, i) => {
    const len = frames(s.srcOut - s.srcIn, fps);
    const start = x.segments.slice(0, i).reduce((n, p) => n + frames(p.srcOut - p.srcIn, fps), 0);
    return `<clipitem id="audio-${i + 1}"><name>${xmlEscape(x.assets[s.assetId]?.name ?? s.assetId)}</name>${rate}<start>${start}</start><end>${start + len}</end><in>${frames(s.srcIn, fps)}</in><out>${frames(s.srcIn, fps) + len}</out><file id="file-${xmlEscape(s.assetId)}"/><sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="seq-1"><name>${xmlEscape(x.name)}</name>${rate}<duration>${cursor}</duration><media><video><format><samplecharacteristics>${rate}<width>${x.width}</width><height>${x.height}</height></samplecharacteristics></format><track>${items.join("")}</track></video><audio><track>${audio.join("")}</track></audio></media></sequence></xmeml>\n`;
}

/** FCPXML 1.9: assets as resources, one asset-clip per segment on the spine. */
export function edlToFcpxml(x: XmlExportInput): string {
  const fps = Math.round(x.fps);
  const t = (sec: number) => `${frames(sec, fps)}/${fps}s`;
  const ids = [...new Set(x.segments.map((s) => s.assetId))];
  const ref = new Map(ids.map((id, i) => [id, `r${i + 2}`]));
  const assets = ids.map((id) => {
    const a = x.assets[id] ?? { name: id, durationSec: 0 };
    return `<asset id="${ref.get(id)}" name="${xmlEscape(a.name)}" start="0s" duration="${t(a.durationSec)}" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="${xmlEscape(fileUrl(a.path ?? a.name))}"/></asset>`;
  });
  let offset = 0;
  const clips = x.segments.map((s) => {
    const dur = frames(s.srcOut - s.srcIn, fps);
    const c = `<asset-clip ref="${ref.get(s.assetId)}" name="${xmlEscape(x.assets[s.assetId]?.name ?? s.assetId)}" offset="${offset}/${fps}s" start="${t(s.srcIn)}" duration="${dur}/${fps}s"/>`;
    offset += dur;
    return c;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9"><resources><format id="r1" frameDuration="1/${fps}s" width="${x.width}" height="${x.height}"/>${assets.join("")}</resources><library><event name="Toreroflow"><project name="${xmlEscape(x.name)}"><sequence format="r1" duration="${offset}/${fps}s" tcStart="0s"><spine>${clips.join("")}</spine></sequence></project></event></library></fcpxml>\n`;
}

/** Relative names stay relative-looking so the editor relinks by name. */
function fileUrl(p: string): string {
  if (/^file:/.test(p)) return p;
  if (p.startsWith("/")) return `file://${encodeURI(p)}`;
  return `file://./${encodeURI(p)}`;
}

// ---------- performance ----------

export interface ClipPerformance {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  /** Average watch time over the clip length, 0..1, when a platform gives it. */
  avgWatchPct: number | null;
  avgWatchSec: number | null;
  posts: number;
  platforms: string[];
}

export interface PerfSample {
  platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  avgWatchSec?: number | null;
}

/** Sums one latest sample per post; watch time is a view-weighted mean. */
export function aggregatePerformance(samples: PerfSample[], clipSec: number): ClipPerformance {
  const sum = (k: "views" | "likes" | "comments" | "shares" | "saves") => samples.reduce((n, s) => n + Math.max(0, s[k] || 0), 0);
  const timed = samples.filter((s) => s.avgWatchSec != null && s.avgWatchSec >= 0);
  const w = timed.reduce((n, s) => n + Math.max(1, s.views), 0);
  const avgWatchSec = timed.length ? timed.reduce((n, s) => n + s.avgWatchSec! * Math.max(1, s.views), 0) / w : null;
  return {
    views: sum("views"),
    likes: sum("likes"),
    comments: sum("comments"),
    shares: sum("shares"),
    saves: sum("saves"),
    avgWatchSec: avgWatchSec == null ? null : Math.round(avgWatchSec * 10) / 10,
    avgWatchPct: avgWatchSec == null || clipSec <= 0 ? null : Math.round(Math.min(1, avgWatchSec / clipSec) * 1000) / 1000,
    posts: samples.length,
    platforms: [...new Set(samples.map((s) => s.platform))].sort(),
  };
}

// ---------- auto-import ----------

export interface AutoImportSettings {
  on: boolean;
  /** UC... channel id; its uploads playlist is UU + the rest. */
  channelId: string | null;
  /** Extra playlists (PL...). */
  playlists: string[];
  /** Watch the channel's uploads playlist. */
  uploads: boolean;
  recipeId: string | null;
  lastCheckAt: string | null;
  lastResult: string | null;
}

export const defaultAutoImport = (): AutoImportSettings => ({
  on: false, channelId: null, playlists: [], uploads: true, recipeId: null, lastCheckAt: null, lastResult: null,
});

export function readAutoImport(raw: unknown): AutoImportSettings {
  const d = defaultAutoImport();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  return {
    on: r.on === true,
    channelId: typeof r.channelId === "string" && isChannelId(r.channelId) ? r.channelId : null,
    playlists: Array.isArray(r.playlists) ? r.playlists.filter((p): p is string => typeof p === "string" && isPlaylistId(p)).slice(0, 10) : [],
    uploads: r.uploads !== false,
    recipeId: typeof r.recipeId === "string" ? r.recipeId : null,
    lastCheckAt: typeof r.lastCheckAt === "string" ? r.lastCheckAt : null,
    lastResult: typeof r.lastResult === "string" ? r.lastResult : null,
  };
}

export const isChannelId = (s: string) => /^UC[A-Za-z0-9_-]{22}$/.test(s);
export const isPlaylistId = (s: string) => /^(PL|UU|FL|OL|LL)[A-Za-z0-9_-]{10,64}$/.test(s);
export const uploadsPlaylistId = (channelId: string) => `UU${channelId.slice(2)}`;

/** The playlists one check reads, uploads first, no repeats. */
export function watchedPlaylists(s: AutoImportSettings): string[] {
  const out: string[] = [];
  if (s.uploads && s.channelId) out.push(uploadsPlaylistId(s.channelId));
  for (const p of s.playlists) if (!out.includes(p)) out.push(p);
  return out;
}

export interface FeedVideo {
  videoId: string;
  title: string;
  publishedAt: string | null;
}

/**
 * Videos not seen before, oldest first. On the very first check (nothing
 * seen yet) only videos published after `since` count, so turning the
 * feature on never floods the queue with a back catalogue.
 */
export function newUploads(feed: FeedVideo[], seen: Set<string>, since: string | null, firstRun: boolean): FeedVideo[] {
  const cut = since ? Date.parse(since) : NaN;
  const uniq = new Map<string, FeedVideo>();
  for (const v of feed) if (!seen.has(v.videoId) && !uniq.has(v.videoId)) uniq.set(v.videoId, v);
  return [...uniq.values()]
    .filter((v) => !firstRun || (Number.isFinite(cut) && v.publishedAt != null && Date.parse(v.publishedAt) > cut))
    .sort((a, b) => (Date.parse(a.publishedAt ?? "") || 0) - (Date.parse(b.publishedAt ?? "") || 0));
}

// ---------- Google Drive ----------

export type DriveRef = { kind: "file" | "folder"; id: string };

/** File or folder id from a Drive share link (or a bare id). */
export function parseDriveLink(input: string): DriveRef | null {
  const s = input.trim();
  const ID = "([A-Za-z0-9_-]{10,})";
  let m = s.match(new RegExp(`^https://drive\\.google\\.com/(?:drive/(?:u/\\d+/)?)?folders/${ID}`));
  if (m) return { kind: "folder", id: m[1]! };
  m = s.match(new RegExp(`^https://drive\\.google\\.com/file/d/${ID}`));
  if (m) return { kind: "file", id: m[1]! };
  m = s.match(new RegExp(`^https://(?:drive|docs)\\.google\\.com/(?:open|uc)\\?(?:.*&)?id=${ID}`));
  if (m) return { kind: "file", id: m[1]! };
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return { kind: "file", id: s };
  return null;
}

/** Strip a name to something safe as a file name. */
export function safeFileName(name: string, fallback = "video.mp4"): string {
  const n = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return n || fallback;
}

// ---------- Pexels ----------

export interface PexelsFile {
  link: string;
  width: number;
  height: number;
  quality?: string | null;
  file_type?: string | null;
}

/** Only Pexels' own video hosts may be downloaded from. */
export function isPexelsMediaUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && /(^|\.)pexels\.com$/.test(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * The mp4 nearest to `targetH` tall in the wanted orientation, never above
 * 1920 on the long side (keeps downloads small); falls back to any mp4.
 */
export function pickPexelsFile(files: PexelsFile[], portrait = true, targetH = 1920): PexelsFile | null {
  const ok = files.filter((f) => isPexelsMediaUrl(f.link) && (!f.file_type || f.file_type === "video/mp4") && f.width > 0 && f.height > 0);
  const orient = ok.filter((f) => (portrait ? f.height >= f.width : f.width >= f.height));
  const pool = (orient.length ? orient : ok).filter((f) => Math.max(f.width, f.height) <= 1920);
  const use = pool.length ? pool : orient.length ? orient : ok;
  const long = (f: PexelsFile) => Math.max(f.width, f.height);
  return [...use].sort((a, b) => Math.abs(long(a) - targetH) - Math.abs(long(b) - targetH))[0] ?? null;
}

// ---------- search ----------

/**
 * A user's words as a Postgres tsquery: letters/digits only, each term a
 * prefix match, all required. Empty when nothing searchable is left.
 */
export function toTsQuery(q: string): string {
  const terms = q
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 8)
    .map((t) => t.slice(0, 40));
  return [...new Set(terms)].map((t) => `${t}:*`).join(" & ");
}

// ---------- b-roll spots ----------


/** The b-roll item a filled spot becomes: full frame, muted, soft fades, on its word. */
export function spotToBroll(spot: BrollSpot, assetId: string, id: string, assetSec?: number | null): BrollItem {
  const dur = assetSec && assetSec > 0 ? Math.min(spot.dur, assetSec) : spot.dur;
  return {
    id, assetId, at: 0, dur, x: 0, y: 0, scale: 1, shape: "full", volume: 0, fadeIn: 0.2, fadeOut: 0.2, word: spot.word,
  };
}

/**
 * Replace one spot with a b-roll item from `assetId`. `at` is 0 until
 * reanchorDoc moves it onto the spot's word. Unknown spot: doc unchanged.
 */
export function fillBrollSpot(doc: EditDoc, spotId: string, assetId: string, id: string, assetSec?: number | null): EditDoc {
  const spot = (doc.brollSpots ?? []).find((s) => s.id === spotId);
  if (!spot) return doc;
  return {
    ...doc,
    brollSpots: (doc.brollSpots ?? []).filter((s) => s.id !== spotId),
    broll: [...doc.broll, spotToBroll(spot, assetId, id, assetSec)],
  };
}
