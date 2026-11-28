import { businessDay } from "./banking";
import { addLocalDays, atLocalMinutes } from "./pauseShift";
import { checkCaption } from "./postLimits";
import { defaultFormat } from "./revisions";
import { instagramVideoError } from "./schemas";

/**
 * A client's linked Google Drive folder, posted to Instagram as trial reels.
 *
 * Lives on Client.driveSource as JSON. The folder is shared as "Anyone with
 * the link" and read with the server's Google API key, so nothing secret is
 * stored here.
 */
export interface DriveSource {
  on: boolean;
  /** The folder link as the operator pasted it. */
  link: string;
  folderId: string;
  /** The client's Instagram SocialAccounts each trial reel posts to, every one. */
  socialAccountIds: string[];
  graduation: "MANUAL" | "SS_PERFORMANCE";
  /** dryrun runs the whole pipeline and records the payload instead of posting. */
  mode: "dryrun" | "live";
  /** ISO. When this folder was linked. Null until one is. */
  linkedAt: string | null;
  /** Live: this many trial reels go out per business day, spread across it. Null is DRIVE_DEFAULT_PER_DAY. */
  dailyLimit: number | null;
  /** New videos in the folder not taken yet, as of the last check. */
  waiting: number | null;
  lastCheckAt: string | null;
  lastResult: string | null;
  /** False when the last check hit an error. Null until a worker has written it. */
  lastOk: boolean | null;
}

/**
 * A Drive file or folder id. Strict on purpose: the id goes inside a Drive
 * query string ('<id>' in parents) and a URL path, so a quote or slash here
 * would change what is asked for.
 */
export const isDriveId = (s: string) => /^[A-Za-z0-9_-]{10,128}$/.test(s);

export const MAX_DRIVE_ACCOUNTS = 10;
export const MAX_DRIVE_DAILY = 50;
/** How often the worker checks every folder. */
export const DRIVE_CHECK_MINUTES = 5;
/** The app-wide alert for one client's failing checks. */
export const driveAlertKey = (clientId: string) => `drive_check:${clientId}`;

/** A whole number from 1 to MAX_DRIVE_DAILY, else null (DRIVE_DEFAULT_PER_DAY). */
export const readDailyLimit = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_DRIVE_DAILY ? v : null;

/** Trimmed, non-empty, deduped in the order given, at most MAX_DRIVE_ACCOUNTS. */
export const driveAccountIds = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? [...new Set(raw.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))].slice(
        0,
        MAX_DRIVE_ACCOUNTS,
      )
    : [];

const isoOrNull = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

/** Never throws. Anything missing or malformed reads as off, dry run, MANUAL. */
export function readDriveSource(raw: unknown): DriveSource {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const folderId = typeof r.folderId === "string" && isDriveId(r.folderId) ? r.folderId : "";
  return {
    // On means watching a folder, which needs one.
    on: r.on === true && folderId !== "",
    link: typeof r.link === "string" ? r.link.slice(0, 500) : "",
    folderId,
    // Settings saved before several accounts could be picked held one id.
    socialAccountIds: driveAccountIds(Array.isArray(r.socialAccountIds) ? r.socialAccountIds : [r.socialAccountId]),
    graduation: r.graduation === "SS_PERFORMANCE" ? "SS_PERFORMANCE" : "MANUAL",
    mode: r.mode === "live" ? "live" : "dryrun",
    linkedAt: isoOrNull(r.linkedAt),
    dailyLimit: readDailyLimit(r.dailyLimit),
    waiting: typeof r.waiting === "number" && Number.isInteger(r.waiting) && r.waiting >= 0 ? r.waiting : null,
    lastCheckAt: isoOrNull(r.lastCheckAt),
    lastResult: typeof r.lastResult === "string" ? r.lastResult : null,
    lastOk: typeof r.lastOk === "boolean" ? r.lastOk : null,
  };
}

// ponytail: a fixed 9:00 to 21:00 business-time window; make it a setting if a brand needs other hours.
const DRIVE_FIRST_MIN = 9 * 60;
const DRIVE_LAST_MIN = 21 * 60;
/** Live trial reels a day when no daily limit is set: about one an hour across the window. */
export const DRIVE_DEFAULT_PER_DAY = 12;
/** Never slotted sooner than this, so each one sits on the calendar long enough to change. */
export const DRIVE_LEAD_MS = 2 * 3_600_000;
/** Live takes new videos only while fewer than this many days of slots are already filled ahead. */
export const DRIVE_AHEAD_DAYS = 14;

/** Trial reels a business day in Live. */
export const drivePerDay = (s: Pick<DriveSource, "dailyLimit">) => s.dailyLimit ?? DRIVE_DEFAULT_PER_DAY;

/**
 * When the next Live trial reel goes out: perDay times spread evenly across the
 * business day's window, at least DRIVE_LEAD_MS ahead, on the first day holding
 * fewer than perDay Drive posts, at a time no target already holds. `taken` is
 * every target of the Drive posts already scheduled, from yesterday on: one
 * dragged to its own time still holds that time and counts on that day.
 */
export function nextDriveSlot(o: {
  now: Date;
  timeZone: string;
  perDay: number;
  taken: Array<{ postId: string; at: Date }>;
  /** Strictly after this: the last video's time, so a newer one never goes before an older one. */
  after?: Date | null;
}): Date {
  const perDay = Math.max(1, Math.min(Math.floor(o.perDay), MAX_DRIVE_DAILY));
  const step = (DRIVE_LAST_MIN - DRIVE_FIRST_MIN) / perDay;
  const held = new Set(o.taken.map((t) => t.at.getTime()));
  // A post counts once on each day any of its targets goes out.
  const postDays = new Set(o.taken.map((t) => `${t.postId}|${businessDay(t.at, o.timeZone)}`));
  const onDay = new Map<string, number>();
  for (const pd of postDays) {
    const k = pd.slice(pd.indexOf("|") + 1);
    onDay.set(k, (onDay.get(k) ?? 0) + 1);
  }
  const earliest = Math.max(o.now.getTime() + DRIVE_LEAD_MS, (o.after?.getTime() ?? -Infinity) + 1);
  // Every day skipped after today holds at least one taken time, so this many days always finds one.
  for (let i = 0; i <= o.taken.length + 1; i++) {
    const day = addLocalDays(o.now, i, o.timeZone);
    if ((onDay.get(businessDay(day, o.timeZone)) ?? 0) >= perDay) continue;
    for (let n = 0; n < perDay; n++) {
      const at = atLocalMinutes(day, Math.round(DRIVE_FIRST_MIN + step * (n + 0.5)), o.timeZone);
      if (at.getTime() >= earliest && !held.has(at.getTime())) return at;
    }
  }
  throw new Error("no Drive slot found");
}

/**
 * The status line on the Drive card: running, not working, or off, from what
 * the worker last wrote. A null lastOk (an older worker) reads as working.
 */
export function driveRunState(s: DriveSource, now = Date.now()): { tone: "ok" | "bad" | "off"; text: string } {
  if (!s.on) return { tone: "off", text: "Not running. Paste a Drive folder link, tick an account, then Save." };
  const last = s.lastCheckAt ? Date.parse(s.lastCheckAt) : NaN;
  const ago = (at: number) => {
    const m = Math.max(0, Math.floor((now - at) / 60_000));
    return m < 1 ? "just now" : m < 120 ? `${m} min ago` : `${Math.floor(m / 60)} hours ago`;
  };
  // ponytail: 45 min is past a download's 30 min claim timeout, so a stopped worker shows after that.
  const STALE_MIN = 45;
  // A check from before this folder was linked or started says nothing about it.
  const linked = s.linkedAt ? Date.parse(s.linkedAt) : NaN;
  if (!Number.isFinite(last) || last < linked) {
    if (Number.isFinite(linked) && now - linked > STALE_MIN * 60_000)
      return { tone: "bad", text: `Not working. No check has run since it was saved ${ago(linked)}, so the worker may be stopped.` };
    return { tone: "ok", text: `Starting. The first check of the folder runs within ${DRIVE_CHECK_MINUTES} minutes.` };
  }
  const mins = Math.max(0, Math.floor((now - last) / 60_000));
  if (s.lastOk === false) return { tone: "bad", text: `Not working. Last checked ${ago(last)}: ${s.lastResult ?? "the check failed."}` };
  if (mins > STALE_MIN) return { tone: "bad", text: `Not working. The last check was ${ago(last)}, so the worker may be stopped.` };
  return {
    tone: "ok",
    text:
      mins < DRIVE_CHECK_MINUTES
        ? `Running. Last checked ${ago(last)}, next check in about ${DRIVE_CHECK_MINUTES - mins} min.`
        : `Running. Last checked ${ago(last)}. A check is under way; downloads and captions can take a while.`,
  };
}

/**
 * How many of today's videos count toward the daily limit: the ones being
 * worked on now, and the ones that went out in the current mode (live posts,
 * or dry runs while it is a dry run). Held, skipped and failed videos never
 * posted, so they leave room for another. Today is the business's own day.
 */
export function driveUsedToday(
  rows: Array<{ status: string; createdAt: Date }>,
  opts: { now: Date; timeZone: string; mode: DriveSource["mode"] },
): number {
  const today = businessDay(opts.now, opts.timeZone);
  const done = opts.mode === "live" ? "scheduled" : "dryrun";
  return rows.filter(
    (r) => (r.status === "claimed" || r.status === "downloaded" || r.status === done) && businessDay(r.createdAt, opts.timeZone) === today,
  ).length;
}

/** One entry of a Drive folder listing. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string | null;
  /** Bytes. Drive sends it as a string, and not at all for Google Docs. */
  size: number | null;
  /** ISO, when Drive gave one. */
  createdTime: string | null;
}

const VIDEO_MIME = new Set(["video/mp4", "video/quicktime"]);

/** An .mp4 or .mov, by type or, when Drive labels it generically, by name. */
export const isDriveVideo = (f: Pick<DriveFile, "name" | "mimeType">) =>
  VIDEO_MIME.has((f.mimeType ?? "").toLowerCase()) || /\.(mp4|mov)$/i.test(f.name);

/**
 * Videos in the folder not taken yet, oldest first: everything in it posts,
 * the ones there when it was linked included, then each one added later. A
 * file with no readable createdTime goes last. Nothing until a folder is linked.
 */
export function pickDriveFiles(
  files: DriveFile[],
  opts: { linkedAt: string | null; seenFileIds: Iterable<string> },
): DriveFile[] {
  if (!Number.isFinite(opts.linkedAt ? Date.parse(opts.linkedAt) : NaN)) return [];
  const seen = new Set(opts.seenFileIds);
  const out = new Map<string, DriveFile & { at: number }>();
  for (const f of files) {
    const at = Date.parse(f.createdTime ?? "");
    if (!isDriveId(f.id) || seen.has(f.id) || out.has(f.id) || !isDriveVideo(f)) continue;
    out.set(f.id, { ...f, at: Number.isFinite(at) ? at : Infinity });
  }
  return [...out.values()]
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map(({ at: _at, ...f }) => f);
}

/** What the asset looks like once it is in Uploads. */
export interface DriveAssetFacts {
  /** MediaAsset.status: uploaded | processing | ready | failed. */
  status: string;
  /** Null when not known yet; unknown values never refuse a video. */
  format: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Measured on disk; the asset has no size column. */
  bytes: number | null;
}

export type DriveAction =
  | { kind: "wait" }
  | { kind: "hold"; reason: string }
  | { kind: "skip"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "post"; mode: DriveSource["mode"] };

/**
 * What to do with one downloaded Drive video.
 *
 * Every refusal is a hold, skip or fail with a reason the operator can act
 * on; nothing here ever posts an empty caption or turns a trial into a post
 * to all followers.
 *
 * caption is the full written caption, or null when the video had no speech.
 * claimedAt is when its DriveImport row was created.
 */
export function decideDriveAction(input: {
  asset: DriveAssetFacts;
  caption: string | null;
  claimedAt: Date;
  settings: Pick<DriveSource, "on" | "socialAccountIds" | "mode">;
}): DriveAction {
  const { asset, settings } = input;
  if (asset.status === "failed") {
    return {
      kind: "fail",
      reason: "Toreroflow could not read this video file. Check that it plays, then add a fresh copy to the Drive folder.",
    };
  }
  // Stopped (the link cleared): it waits, and posts once a folder is linked again.
  if (asset.status !== "ready" || !settings.on) return { kind: "wait" };

  const limit = instagramVideoError(asset.durationSec, asset.bytes);
  if (limit) {
    return { kind: "skip", reason: limit.replace(/, or untick Instagram\.$/, ", then add the new file to the Drive folder.") };
  }

  /*
   * Long-form goes through the long-form screen (Instagram copy, 9:16 crop),
   * which this pipeline does not build. Holding it keeps a landscape episode
   * from going out as a plain trial reel.
   */
  if ((asset.format ?? defaultFormat(asset)) === "long_form") {
    return {
      kind: "hold",
      reason:
        "This video is long-form (landscape and over 3 minutes), and Drive trial reels only post short-form. " +
        "Schedule it by hand from Uploads, or add a vertical or shorter cut to the folder.",
    };
  }

  if (!settings.socialAccountIds.length) {
    return {
      kind: "hold",
      reason: "No Instagram account is ticked for this Drive folder. Tick one in Workflows, then schedule this video by hand from Uploads.",
    };
  }

  const caption = input.caption?.trim() ?? "";
  if (!caption) {
    return {
      kind: "hold",
      reason: "No speech was found in this video, so no caption was written and it was not posted. Write a caption and schedule it by hand from Uploads.",
    };
  }
  const problems = checkCaption("instagram", caption).problems;
  if (problems.length) {
    return { kind: "hold", reason: `The written caption does not fit Instagram: ${problems.join(" ")} Edit it and schedule it by hand from Uploads.` };
  }

  return { kind: "post", mode: settings.mode };
}

/** The upload a Drive row became, as far as its picture goes. */
export interface DriveThumbAsset {
  id: string;
  clientId: string;
  kind: string;
  status: string;
  coverKey: string | null;
  thumbDeletedAt: Date | null;
  updatedAt: Date;
}

/**
 * The image a Recent videos row draws, as a storage key, or null for the
 * coloured placeholder. The operator's cover first, then a frame taken from
 * the Drive file (set only when the upload has no usable picture, so it wins
 * over thumb.jpg), then the upload's own thumbnail. version busts the
 * webview's cache when a cover is re-picked under the same key.
 */
export function driveRowThumb(
  row: { thumbKey: string | null },
  asset: DriveThumbAsset | null,
): { key: string; version: number | null } | null {
  const images = asset && !asset.thumbDeletedAt ? asset : null;
  if (images?.coverKey) return { key: images.coverKey, version: images.updatedAt.getTime() };
  if (row.thumbKey) return { key: row.thumbKey, version: null };
  if (images && images.kind === "video" && images.status === "ready") return { key: `${images.clientId}/${images.id}/thumb.jpg`, version: null };
  return null;
}

/**
 * Whether the worker should take a frame from the Drive file for this row.
 * thumbKey "" means Drive could not give one, so it is not asked again. An
 * upload still processing makes its own thumbnail soon; one that is ready
 * only needs Drive when its thumbnail file is missing.
 */
export function needsDriveFrame(row: { thumbKey: string | null }, asset: DriveThumbAsset | null, thumbOnDisk: boolean): boolean {
  if (row.thumbKey !== null) return false;
  if (!asset || asset.thumbDeletedAt || asset.status === "failed") return true;
  if (asset.coverKey) return false;
  if (asset.status !== "ready") return false;
  return !thumbOnDisk;
}

/** Where a frame taken from a Drive file is kept: beside the client's uploads, one per file. */
export const driveFrameKey = (clientId: string, fileId: string) => `${clientId}/drive-frames/${fileId}.jpg`;
