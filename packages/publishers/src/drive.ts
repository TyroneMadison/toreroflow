import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { isDriveId, isDriveVideo, type DriveFile } from "@toreroflow/core";

/**
 * Google Drive v3 for folders shared as "Anyone with the link", read with an
 * API key. The key travels in the X-Goog-Api-Key header and never in a URL,
 * so no URL that reaches a log or an error can leak it.
 */

export const DRIVE_API_BASE_DEFAULT = "https://www.googleapis.com/drive/v3";

/** HTTP status (0 when no answer came back) and a plain reason. Never a URL or a key. */
export class DriveError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The server's key or its Google project is the problem, never the folder or a file. */
    public keyProblem = false,
  ) {
    super(message);
  }
}

export interface DriveOptions {
  apiKey: string;
  /** DRIVE_API_BASE; a local stub in tests. */
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const KEY_FROM = "The key is GOOGLE_DRIVE_API_KEY on the server, or YOUTUBE_API_KEY when that is empty.";
const KEY_INVALID = /^(API_KEY_INVALID|API_KEY_EXPIRED|keyInvalid|keyExpired)$/;
// ACCESS_DENIED is what a key whose Google project cannot use Drive gets ("Permission
// denied on the service"); a folder that is not shared answers 404 instead.
const KEY_BLOCKED = /^(ACCESS_DENIED|SERVICE_DISABLED|SERVICE_NOT_VISIBLE|BILLING_DISABLED|CONSUMER_\w+|accessNotConfigured|API_KEY_\w+_BLOCKED)$/;
const RATE = /^(rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|RATE_LIMIT_EXCEEDED)$/;

/** Google's machine reason from an error body, or "". Only this token is kept, never the body. */
export function googleReason(body: unknown): string {
  const e = (body as { error?: { details?: Array<{ reason?: unknown }>; errors?: Array<{ reason?: unknown }> } } | null)
    ?.error;
  const r = e?.details?.find((d) => typeof d?.reason === "string")?.reason ?? e?.errors?.[0]?.reason;
  return typeof r === "string" ? r : "";
}

/** A Drive failure in plain words, told apart by Google's reason so a key problem never reads as sharing. */
export function driveFailure(status: number, reason: string): DriveError {
  if (KEY_INVALID.test(reason) || status === 401 || (status === 400 && !reason))
    return new DriveError(status, `The server's Google API key is not valid. ${KEY_FROM}`, true);
  if (status === 403 && KEY_BLOCKED.test(reason))
    return new DriveError(
      status,
      `The server's Google API key is not allowed to use Google Drive. Turn on the Google Drive API in the key's Google Cloud project, and if the key is limited to certain APIs, add Drive to it. ${KEY_FROM}`,
      true,
    );
  if (status === 429 || (status === 403 && RATE.test(reason)))
    return new DriveError(429, "Drive is rate limiting this key. The next check will try again.");
  if (status === 403) return new DriveError(403, 'Drive refused access. Check the folder is shared as "Anyone with the link".');
  if (status === 404)
    return new DriveError(404, 'Drive could not find it. Check the link, and that it is shared as "Anyone with the link".');
  if (status >= 500) return new DriveError(status, "Drive had a problem on its side. The next check will try again.");
  return new DriveError(status, `Drive answered ${status}.`);
}

async function driveGet(url: string, opts: DriveOptions, timeoutMs: number): Promise<Response> {
  if (!opts.apiKey)
    throw new DriveError(0, "No Google API key is set on the server (GOOGLE_DRIVE_API_KEY, or YOUTUBE_API_KEY), so Drive cannot be read.", true);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      headers: { "X-Goog-Api-Key": opts.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new DriveError(0, e instanceof Error && e.name === "TimeoutError" ? "Drive did not answer in time." : "Drive could not be reached.");
  }
  if (!res.ok) throw driveFailure(res.status, googleReason(await res.json().catch(() => null)));
  return res;
}

// ponytail: a page cap instead of loop detection; 50 pages of 1000 is far past any real folder.
const MAX_PAGES = 50;

/** Every .mp4/.mov directly in the folder (no subfolders), across all pages. */
export async function listFolderVideos(folderId: string, opts: DriveOptions): Promise<DriveFile[]> {
  if (!isDriveId(folderId)) throw new DriveError(400, "That is not a Drive folder id.");
  const out: DriveFile[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      // Not narrowed by type here: a .mov often comes back as octet-stream, so
      // the name decides too, and Drive's name search only matches prefixes.
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "nextPageToken,files(id,name,size,mimeType,createdTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await driveGet(`${opts.base ?? DRIVE_API_BASE_DEFAULT}/files?${qs}`, opts, opts.timeoutMs ?? 30_000);
    const data = (await res.json().catch(() => null)) as {
      nextPageToken?: unknown;
      files?: Array<{ id?: unknown; name?: unknown; size?: unknown; mimeType?: unknown; createdTime?: unknown }>;
    } | null;
    if (!data) throw new DriveError(502, "Drive sent a folder listing that could not be read.");
    for (const f of data.files ?? []) {
      if (typeof f.id !== "string" || typeof f.name !== "string") continue;
      const file: DriveFile = {
        id: f.id,
        name: f.name,
        mimeType: typeof f.mimeType === "string" ? f.mimeType : null,
        size: typeof f.size === "string" && /^\d+$/.test(f.size) ? Number(f.size) : null,
        createdTime: typeof f.createdTime === "string" ? f.createdTime : null,
      };
      if (isDriveVideo(file)) out.push(file);
    }
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
    if (!pageToken) return out;
  }
  throw new DriveError(0, "The Drive folder has more files than one check reads. Move older files out of it.");
}

/**
 * The file's bytes, for a reader that sends the key itself in X-Goog-Api-Key
 * (ffmpeg grabbing one frame with range requests). The URL holds no key.
 */
export function driveMediaUrl(fileId: string, base = DRIVE_API_BASE_DEFAULT): string {
  if (!isDriveId(fileId)) throw new DriveError(400, "That is not a Drive file id.");
  return `${base}/files/${fileId}?${new URLSearchParams({ alt: "media", supportsAllDrives: "true" })}`;
}

/**
 * Streams one file to destPath, stopping past maxBytes.
 *
 * Anything that stops the download removes the partial file, so a half
 * written video never looks like a finished one.
 */
export async function downloadDriveFile(
  fileId: string,
  destPath: string,
  opts: DriveOptions & { maxBytes: number },
): Promise<{ bytes: number; contentType: string }> {
  const res = await driveGet(driveMediaUrl(fileId, opts.base), opts, opts.timeoutMs ?? 30 * 60_000);
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const tooLarge = `The file is over ${Math.round(opts.maxBytes / (1024 * 1024))} MB, so the download was stopped.`;
  if (!res.body || !/^(video\/|application\/octet-stream)/.test(contentType)) {
    void res.body?.cancel().catch(() => {});
    throw new DriveError(415, "Drive did not hand over a video file.");
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared > opts.maxBytes) {
    void res.body.cancel().catch(() => {});
    throw new DriveError(413, tooLarge);
  }
  let bytes = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > opts.maxBytes) done(new DriveError(413, tooLarge));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), cap, createWriteStream(destPath));
  } catch (e) {
    await rm(destPath, { force: true });
    if (e instanceof DriveError) throw e;
    throw new DriveError(0, e instanceof Error && e.name === "TimeoutError" ? "The Drive download took too long and was stopped." : "The Drive download stopped part way.");
  }
  return { bytes, contentType };
}
