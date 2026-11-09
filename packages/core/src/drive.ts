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
  /** The client's Instagram SocialAccount the trial reels post to. */
  socialAccountId: string;
  graduation: "MANUAL" | "SS_PERFORMANCE";
  /** dryrun runs the whole pipeline and records the payload instead of posting. */
  mode: "dryrun" | "live";
  /** ISO. Files created before this are never posted. */
  linkedAt: string | null;
  lastCheckAt: string | null;
  lastResult: string | null;
}

/**
 * A Drive file or folder id. Strict on purpose: the id goes inside a Drive
 * query string ('<id>' in parents) and a URL path, so a quote or slash here
 * would change what is asked for.
 */
export const isDriveId = (s: string) => /^[A-Za-z0-9_-]{10,128}$/.test(s);

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
    socialAccountId: typeof r.socialAccountId === "string" ? r.socialAccountId : "",
    graduation: r.graduation === "SS_PERFORMANCE" ? "SS_PERFORMANCE" : "MANUAL",
    mode: r.mode === "live" ? "live" : "dryrun",
    linkedAt: isoOrNull(r.linkedAt),
    lastCheckAt: isoOrNull(r.lastCheckAt),
    lastResult: typeof r.lastResult === "string" ? r.lastResult : null,
  };
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
 * New videos to ingest, oldest first.
 *
 * Only files created at or after linkedAt count, so linking a folder never
 * posts its back catalogue. A file with no readable createdTime cannot be
 * shown to be new and is left alone.
 */
export function pickDriveFiles(
  files: DriveFile[],
  opts: { linkedAt: string | null; seenFileIds: Iterable<string> },
): DriveFile[] {
  const since = opts.linkedAt ? Date.parse(opts.linkedAt) : NaN;
  if (!Number.isFinite(since)) return [];
  const seen = new Set(opts.seenFileIds);
  const out = new Map<string, DriveFile & { at: number }>();
  for (const f of files) {
    const at = Date.parse(f.createdTime ?? "");
    if (!isDriveId(f.id) || seen.has(f.id) || out.has(f.id) || !isDriveVideo(f)) continue;
    if (Number.isFinite(at) && at >= since) out.set(f.id, { ...f, at });
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
  settings: Pick<DriveSource, "on" | "socialAccountId" | "mode" | "linkedAt">;
}): DriveAction {
  const { asset, settings } = input;
  if (asset.status === "failed") {
    return {
      kind: "fail",
      reason: "Toreroflow could not read this video file. Check that it plays, then add a fresh copy to the Drive folder.",
    };
  }
  if (asset.status !== "ready" || !settings.on) return { kind: "wait" };

  // Claimed before the folder was last switched on or changed: it was in the
  // folder by then, and the operator was told those are left alone.
  if (!(input.claimedAt.getTime() >= Date.parse(settings.linkedAt ?? ""))) {
    return {
      kind: "hold",
      reason:
        "This video was downloaded before Drive auto-post was last switched on or given a new folder, so it was not posted. " +
        "Schedule it by hand from Uploads.",
    };
  }

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

  if (!settings.socialAccountId) {
    return {
      kind: "hold",
      reason: "No Instagram account is picked for this Drive folder. Pick one in Settings, then schedule this video by hand from Uploads.",
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
