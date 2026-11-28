import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildCaptionUserMessage,
  CAPTION_SCHEMA,
  CAPTION_SYSTEM_PROMPT,
  composeCaption,
  decideDriveAction,
  decodeEscapes,
  DRIVE_AHEAD_DAYS,
  driveAlertKey,
  driveFrameKey,
  drivePerDay,
  driveUsedToday,
  instagramVideoError,
  needsDriveFrame,
  nextDriveSlot,
  pickDriveFiles,
  PLATFORM_MAX_UPLOAD_BYTES,
  readCaptionReply,
  readDriveSource,
  safeFileName,
  toPlainText,
  type DriveAction,
  type DriveSource,
  type WrittenCaption,
} from "@toreroflow/core";
import { enqueue, getPrisma, Prisma, type DriveImport, type MediaAsset } from "@toreroflow/db";
import {
  buildPostExtras,
  DriveError,
  DryRunPublisher,
  downloadDriveFile,
  driveMediaUrl,
  listFolderVideos,
  type InstagramScheduleOptions,
} from "@toreroflow/publishers";
import { extractThumbnail } from "@toreroflow/media";
import { env } from "./env";
import { transcribeStrict } from "./transcribe";

/**
 * Drive folder to Instagram trial reels.
 *
 * Per client with a linked folder: pass 1 claims and downloads at most one new
 * video into Uploads, pass 2 writes the caption for each one the media queue
 * has made ready and then posts it as a trial reel to every ticked Instagram
 * account (or records the dry run), or holds, skips or fails it with a reason
 * the operator can act on.
 *
 * Once-only is the database's job: the DriveImport row is created before the
 * download, and its unique (clientId, fileId) refuses a second claim.
 */

const prisma = getPrisma();

const IG_MAX_BYTES = PLATFORM_MAX_UPLOAD_BYTES.instagram!;
/** Past the download's own 30 minute timeout, so a claim still downloading is never swept. */
const CLAIM_EXPIRES_MS = 45 * 60_000;

const driveOpts = () => ({ apiKey: env.GOOGLE_DRIVE_API_KEY, base: env.DRIVE_API_BASE });

/** One line, no stack: these land in lastResult and the log. */
const plain = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);

type DriveClient = {
  id: string;
  name: string;
  agencyId: string;
  captionBlock: string | null;
  captionBlockOn: boolean;
  captionKeywords: Prisma.JsonValue;
};

/** The exact target options a Drive video posts with, and the provider payload they build. */
export function trialReelPlan(input: {
  graduation: DriveSource["graduation"];
  format: string | null;
  durationSec: number | null;
  caption: string;
}) {
  const instagram: InstagramScheduleOptions = { trial: true, graduationStrategy: input.graduation };
  const extras = buildPostExtras({
    platform: "instagram",
    format: input.format,
    durationSec: input.durationSec,
    coverUrl: null,
    caption: input.caption,
    instagram,
  });
  return { options: { instagram }, extras };
}

/**
 * Whether a failed download lets go of its claim for the next check to retry.
 * Drive being busy or unreachable does; a refusal about the file itself does
 * not, or one bad file would block the folder, since the oldest goes first.
 */
export const downloadRetries = (e: unknown) =>
  !(e instanceof DriveError) || e.keyProblem || e.status === 0 || e.status === 429 || e.status >= 500;

/**
 * Whether a transcription error is the service's passing trouble, tried again
 * next check. Any other answer is about this file (one with no audio track
 * gets a 500) and holds it with the service's own words, never as no speech.
 */
// ponytail: a 500 from a failed model load holds too; have the captions service answer 503 for it if that recurs.
export const transcriptionRetries = (e: unknown) =>
  /^(the transcription service did not answer|transcription timed out|transcription failed: 50[234]\b)/.test(plain(e));

/** The same accounts, in any order. */
const sameIds = (a: string[], b: string[]) => new Set(a).size === new Set(b).size && a.every((id) => b.includes(id));

/** Whether a save moved anything a post is made from (lastCheckAt and lastResult are the check's own). */
export const settingsMoved = (a: DriveSource, b: DriveSource) =>
  a.on !== b.on ||
  a.mode !== b.mode ||
  !sameIds(a.socialAccountIds, b.socialAccountIds) ||
  a.graduation !== b.graduation ||
  a.linkedAt !== b.linkedAt;

type TickedAccount = {
  id: string;
  clientId: string;
  handle: string;
  platform: string;
  status: string;
  deletedAt: Date | null;
  tokensEncrypted: string | null;
};

/**
 * The ticked accounts a Drive video posts to, in the order ticked, and a note
 * for each ticked one it cannot. An id that is not this client's Instagram is
 * never named, since its handle may be another client's.
 */
export function driveTargets(clientId: string, ids: string[], found: TickedAccount[], mode: DriveSource["mode"]) {
  const eligible: TickedAccount[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const a = found.find((x) => x.id === id && x.clientId === clientId && x.platform === "instagram");
    if (!a) skipped.push("an account that is no longer one of this client's Instagram accounts");
    else if (a.deletedAt) skipped.push(`@${a.handle} was removed`);
    else if (a.status !== "connected") skipped.push(`@${a.handle} is not connected`);
    else if (mode === "live" && a.tokensEncrypted !== "provider:zernio") {
      skipped.push(`@${a.handle} is not connected through the publishing provider`);
    } else eligible.push(a);
  }
  return { eligible, skipped };
}

/**
 * The settings as saved now. One check can run for many minutes (downloads,
 * whisper, the model), so nothing is claimed or posted on the copy read at its start.
 */
const settingsNow = async (clientId: string) =>
  readDriveSource(
    (await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { driveSource: true } }))?.driveSource,
  );

const BY_HAND = {
  kind: "skip",
  reason: "This video was scheduled by hand from Uploads, so the Drive trial reel was not posted as well.",
} as const;

/** A caption problem that more checks will not fix, so the video is held instead of retried. */
class Held extends Error {}

/** A save landed mid-check: nothing was written, and the next check uses the new settings. Not a failure. */
const MOVED = "moved";

let running = false;

/** Every linked folder, once. A tick that lands while one is running does nothing. */
export async function driveAll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await expireClaims();
    const clients = await prisma.client.findMany({
      where: { deletedAt: null, driveSource: { not: Prisma.DbNull } },
      select: {
        id: true,
        name: true,
        agencyId: true,
        driveSource: true,
        captionBlock: true,
        captionBlockOn: true,
        captionKeywords: true,
      },
    });
    for (const c of clients) {
      const s0 = readDriveSource(c.driveSource);
      if (!s0.on) {
        // Stopped: no failure to show. Also catches one a check still running at Save raised after it.
        await prisma.systemAlert.deleteMany({ where: { agencyId: c.agencyId, key: driveAlertKey(c.id) } });
        continue;
      }
      const notes: string[] = [];
      const errors: string[] = [];
      for (const pass of [ingestNext, advance]) {
        try {
          notes.push(await pass(c));
        } catch (e) {
          notes.push(plain(e));
          errors.push(plain(e));
          console.error(`[drive] client ${c.id}: ${plain(e)}`);
        }
      }
      // Stopped, restarted or given a new folder during this check: its result belongs to the old run.
      const s1 = await settingsNow(c.id);
      if (!s1.on || s1.linkedAt !== s0.linkedAt) continue;
      const lastResult = (notes.filter(Boolean).join(" ") || "Nothing to do.").slice(0, 500);
      await patchSource(c.id, { lastCheckAt: new Date().toISOString(), lastResult, lastOk: !errors.length });
      // A single failed check shows on the card; the app-wide alert waits for a second in a row, so a blip never flaps it.
      await driveAlert(c, errors.length && s0.lastOk === false ? errors.join(" ") : errors.length ? null : "").catch((e) =>
        console.error(`[drive] alert for client ${c.id}: ${plain(e)}`),
      );
    }
    // Pictures last, so they never hold up a post. Stopped folders too: their rows still show.
    for (const c of clients) await driveFrames(c.id).catch((e) => console.error(`[drive] frames for client ${c.id}: ${plain(e)}`));
  } finally {
    running = false;
  }
}

/** Drive frames one check takes per client, so a backfill of old rows is spread over a few checks. */
const FRAMES_PER_CHECK = 4;

/**
 * Whether ffmpeg's failure to read a Drive file is about the file (gone, not
 * shared, not a video), so the row is not asked again. Anything else (Drive
 * busy, a timeout, no network) is tried on the next check.
 */
// ponytail: Drive's rate-limit 403 reads as final too; that row keeps its placeholder. Parse the reason if it ever bites.
export const frameFailureFinal = (message: string) => /(Server returned|HTTP error) 4(0[0-4]|1[05])\b|Invalid data found|does not contain any stream|Output file is empty/i.test(message);

/**
 * Recent videos pictures for the client's last 20 rows that have none: a
 * skipped file is never downloaded, a failed one is deleted, and a swept or
 * missing thumbnail leaves an old row blank. One frame, 1 s in, straight from
 * the Drive file: ffmpeg reads it with range requests, so even a 360 MB video
 * costs a few MB. The key travels in a header, never in the URL or a log.
 */
export async function driveFrames(clientId: string): Promise<number> {
  if (!env.GOOGLE_DRIVE_API_KEY) return 0;
  const rows = await prisma.driveImport.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, fileId: true, assetId: true, thumbKey: true },
  });
  const todo = rows.filter((r) => r.thumbKey === null);
  if (!todo.length) return 0;
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: todo.flatMap((r) => (r.assetId ? [r.assetId] : [])) }, clientId },
    select: { id: true, clientId: true, kind: true, status: true, coverKey: true, thumbDeletedAt: true, updatedAt: true },
  });
  let taken = 0;
  for (const row of todo) {
    if (taken >= FRAMES_PER_CHECK) break;
    const asset = assets.find((a) => a.id === row.assetId) ?? null;
    const onDisk = asset
      ? await fs.access(path.join(env.STORAGE_DIR, asset.clientId, asset.id, "thumb.jpg")).then(() => true, () => false)
      : false;
    if (!needsDriveFrame(row, asset, onDisk)) continue;
    taken++;
    const key = driveFrameKey(clientId, row.fileId);
    try {
      await fs.mkdir(path.dirname(path.join(env.STORAGE_DIR, key)), { recursive: true });
      await extractThumbnail(driveMediaUrl(row.fileId, env.DRIVE_API_BASE), path.join(env.STORAGE_DIR, key), 1, [
        "-v", "error",
        "-rw_timeout", "30000000",
        "-headers", `X-Goog-Api-Key: ${env.GOOGLE_DRIVE_API_KEY}\r\n`,
      ]);
      await prisma.driveImport.update({ where: { id: row.id }, data: { thumbKey: key } });
      console.log(`[drive] frame for import ${row.id} saved`);
    } catch (e) {
      const final = frameFailureFinal(e instanceof Error ? e.message : String(e));
      if (final) await prisma.driveImport.update({ where: { id: row.id }, data: { thumbKey: "" } });
      // The tail only: ffmpeg's words can name the URL, which holds no key.
      console.error(`[drive] frame for import ${row.id} ${final ? "unavailable" : "tried again next check"}: ${plain(e).slice(-160)}`);
    }
  }
  return taken;
}

/**
 * The check's own fields (lastCheckAt, lastResult, waiting), merged into the
 * stored settings in one statement, so an operator's save that lands
 * mid-check is never written back over.
 */
async function patchSource(
  clientId: string,
  fields: Partial<Pick<DriveSource, "lastCheckAt" | "lastResult" | "waiting" | "lastOk">>,
): Promise<void> {
  const patch = JSON.stringify(fields);
  await prisma.$executeRaw`UPDATE "Client" SET "driveSource" = "driveSource" || ${patch}::jsonb
    WHERE "id" = ${clientId} AND jsonb_typeof("driveSource") = 'object'`;
}

/**
 * The app-wide problem while a client's checks keep failing, gone after one
 * that works. failure: "" worked, null leave it as it is. A repeat does not
 * un-dismiss it, since this runs every few minutes: a dismissed one comes back
 * only once it has worked and then broken again.
 */
async function driveAlert(c: DriveClient, failure: string | null): Promise<void> {
  if (failure === null) return;
  const key = driveAlertKey(c.id);
  // Read now, not at the check's start: stopped during a long check means nothing to raise.
  const s = await settingsNow(c.id);
  if (!failure || !s.on) {
    await prisma.systemAlert.deleteMany({ where: { agencyId: c.agencyId, key } });
    return;
  }
  const severity = s.mode === "live" ? "error" : "warning";
  const detail = failure.slice(0, 500);
  await prisma.systemAlert.upsert({
    where: { agencyId_key: { agencyId: c.agencyId, key } },
    create: {
      agencyId: c.agencyId,
      key,
      kind: "drive_check",
      severity,
      clientId: c.id,
      message: "Drive auto-post is not working. Open Workflows to see why.",
      detail,
    },
    update: { severity, detail, lastSeenAt: new Date(), count: { increment: 1 } },
  });
}

/** Live Drive posts still to go out, plus videos on their way to becoming one. */
async function driveAhead(clientId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(DISTINCT t."postId") AS n FROM "PostTarget" t
    JOIN "DriveImport" d ON d."postId" = t."postId"
    WHERE d."clientId" = ${clientId} AND t."status" = 'scheduled' AND t."scheduledAt" > NOW()`;
  const inFlight = await prisma.driveImport.count({ where: { clientId, status: { in: ["claimed", "downloaded"] } } });
  return Number(row?.n ?? 0) + inFlight;
}

/** A claim whose download never finished (the worker died mid-file) fails, and its empty upload goes. */
async function expireClaims(): Promise<void> {
  const stale = await prisma.driveImport.findMany({
    where: { status: "claimed", createdAt: { lt: new Date(Date.now() - CLAIM_EXPIRES_MS) } },
    select: { id: true, assetId: true },
  });
  for (const row of stale) {
    // ponytail: the partial file stays on disk; sweep it if worker restarts mid-download become common.
    if (row.assetId) await prisma.mediaAsset.deleteMany({ where: { id: row.assetId, storageKey: "pending" } });
    await prisma.driveImport.update({
      where: { id: row.id },
      data: { status: "failed", assetId: null, reason: "The download did not finish. Add a fresh copy of the file to the Drive folder." },
    });
    console.log(`[drive] import ${row.id} failed: claim expired`);
  }
}

/** Pass 1: claim and download the oldest new video, if there is one. */
async function ingestNext(c: DriveClient): Promise<string> {
  const s = await settingsNow(c.id);
  if (!s.on) return "";
  const files = await listFolderVideos(s.folderId, driveOpts());
  const seen = await prisma.driveImport.findMany({ where: { clientId: c.id }, select: { fileId: true } });
  const fresh = pickDriveFiles(files, { linkedAt: s.linkedAt, seenFileIds: seen.map((r) => r.fileId) });
  // ponytail: one new file per client per tick paces the Instagram quota and the downloads;
  // read zernio.instagramPublishingLimit here if a folder ever fills faster than that.
  const file = fresh[0];
  if (!file) {
    await patchSource(c.id, { waiting: 0 });
    return `${files.length} videos in the folder, nothing new.`;
  }

  // Live lays videos out on the calendar ahead, perDay a day. Past DRIVE_AHEAD_DAYS of
  // them, new ones wait in the folder, so downloads never run far ahead of posting.
  if (s.mode === "live") {
    const ahead = await driveAhead(c.id);
    const cap = drivePerDay(s) * DRIVE_AHEAD_DAYS;
    if (ahead >= cap) {
      await patchSource(c.id, { waiting: fresh.length });
      return `${ahead} trial reels are scheduled ahead, ${DRIVE_AHEAD_DAYS} days of them. ${fresh.length} ${fresh.length === 1 ? "video waits" : "videos wait"} in the folder.`;
    }
  } else if (s.dailyLimit) {
    // A dry run has no calendar: past the daily limit, new videos wait for tomorrow.
    const recent = await prisma.driveImport.findMany({
      // Two days back covers today in any timezone; the business day is decided in code.
      where: { clientId: c.id, createdAt: { gte: new Date(Date.now() - 48 * 3600_000) } },
      select: { status: true, createdAt: true },
    });
    const used = driveUsedToday(recent, { now: new Date(), timeZone: env.BUSINESS_TIMEZONE, mode: s.mode });
    if (used >= s.dailyLimit) {
      await patchSource(c.id, { waiting: fresh.length });
      return `Daily limit reached (${used} of ${s.dailyLimit} today). ${fresh.length} ${fresh.length === 1 ? "video waits" : "videos wait"} for tomorrow.`;
    }
  }
  await patchSource(c.id, { waiting: fresh.length - 1 });
  const later = fresh.length > 1 ? ` ${fresh.length - 1} more follow on later checks.` : "";

  const over = file.size != null ? instagramVideoError(null, file.size) : null;
  const tooLarge = over?.replace(/, or untick Instagram\.$/, ", then add the new file to the Drive folder.") ?? null;
  let row: DriveImport;
  try {
    row = await prisma.driveImport.create({
      data: {
        clientId: c.id,
        fileId: file.id,
        name: file.name.slice(0, 300),
        status: tooLarge ? "skipped" : "claimed",
        reason: tooLarge,
        // Which folder it came from, so a video taken just before a folder change never posts.
        detail: { folderId: s.folderId },
      },
    });
  } catch (e) {
    // Claimed already, by an earlier check or another process: the row is theirs.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "";
    throw e;
  }
  console.log(`[drive] import ${row.id} ${row.status}`);
  if (tooLarge) return `1 new video skipped, over Instagram's size limit.${later}`;

  const ext = file.mimeType === "video/quicktime" || /\.mov$/i.test(file.name) ? ".mov" : ".mp4";
  const asset = await prisma.mediaAsset.create({
    data: {
      clientId: c.id,
      originalName: safeFileName(file.name),
      storageKey: "pending",
      status: "uploaded",
      // The name only. The caption is written from the video itself in pass 2, never from this.
      draftCopy: { name: file.name.replace(/\.[^.]+$/, "") },
    },
  });
  await prisma.driveImport.update({ where: { id: row.id }, data: { assetId: asset.id } });
  const storageKey = `${c.id}/${asset.id}/source${ext}`;
  try {
    await fs.mkdir(path.join(env.STORAGE_DIR, c.id, asset.id), { recursive: true });
    await downloadDriveFile(file.id, path.join(env.STORAGE_DIR, storageKey), { ...driveOpts(), maxBytes: IG_MAX_BYTES });
  } catch (e) {
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
    if (downloadRetries(e)) {
      await prisma.driveImport.delete({ where: { id: row.id } });
      console.log(`[drive] import ${row.id} released for a retry (${e instanceof DriveError ? e.status : "error"})`);
      return `A download did not finish and is tried again next check: ${plain(e)}`;
    }
    const code = e instanceof DriveError ? e.status : 0;
    const status = code === 413 ? "skipped" : "failed";
    await prisma.driveImport.update({ where: { id: row.id }, data: { status, assetId: null, reason: plain(e) } });
    console.log(`[drive] import ${row.id} ${status} (${code})`);
    return `1 new video ${status}: ${plain(e)}${later}`;
  }
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: { storageKey } });
  await enqueue("media", { assetId: asset.id });
  await prisma.driveImport.update({ where: { id: row.id }, data: { status: "downloaded" } });
  console.log(`[drive] import ${row.id} downloaded as asset ${asset.id}`);
  return `1 new video downloaded.${later}`;
}

/** Pass 2: every downloaded video, once the media queue has finished with it. */
async function advance(c: DriveClient): Promise<string> {
  const rows = await prisma.driveImport.findMany({
    where: { clientId: c.id, status: "downloaded" },
    orderBy: { createdAt: "asc" },
  });
  const tally = new Map<string, number>();
  const errors: string[] = [];
  for (const row of rows) {
    try {
      const status = await advanceOne(c, row);
      tally.set(status, (tally.get(status) ?? 0) + 1);
      // Oldest first, strictly: nothing newer is scheduled while an older one is still on its way.
      // ponytail: a video stuck processing holds the line; it fails on its own if the media job fails.
      if (status === "processing") break;
    } catch (e) {
      // Left as downloaded, so the next check tries it again, still ahead of the newer ones.
      errors.push(plain(e));
      console.error(`[drive] import ${row.id}: ${plain(e)}`);
      break;
    }
  }
  const line = [[...tally].map(([status, n]) => `${n} ${status}`).join(", "), ...new Set(errors)].filter(Boolean).join(". ");
  // A video stuck on an error (no caption model, transcription down) is the check not working.
  if (errors.length) throw new Error(`${line}.`);
  return line && `${line}.`;
}

const SETTLED = { hold: "held", skip: "skipped", fail: "failed" } as const;

async function settle(rowId: string, action: Exclude<DriveAction, { kind: "post" }>): Promise<string> {
  if (action.kind === "wait") return "processing";
  const status = SETTLED[action.kind];
  await prisma.driveImport.update({ where: { id: rowId }, data: { status, reason: action.reason } });
  console.log(`[drive] import ${rowId} ${status}`);
  return status;
}

async function advanceOne(c: DriveClient, row: DriveImport): Promise<string> {
  const asset = row.assetId ? await prisma.mediaAsset.findUnique({ where: { id: row.assetId } }) : null;
  if (!asset) {
    return settle(row.id, { kind: "fail", reason: "The upload this file became was deleted from Uploads, so it was not posted." });
  }
  // It sits in Uploads while it waits here, so the operator may have scheduled it already.
  if (await prisma.post.count({ where: { mediaAssetId: asset.id, deletedAt: null } })) return settle(row.id, BY_HAND);
  const s = await settingsNow(c.id);
  const from = (row.detail as { folderId?: unknown } | null)?.folderId;
  if (typeof from === "string" && from && s.folderId && from !== s.folderId) {
    return settle(row.id, {
      kind: "skip",
      reason: "This video came from a Drive folder this brand no longer uses, so it was not posted. It is still in Uploads.",
    });
  }
  const bytes = asset.sourceDeletedAt
    ? null
    : await fs.stat(path.join(env.STORAGE_DIR, asset.storageKey)).then((st) => st.size, () => null);
  const facts = {
    status: asset.status,
    format: asset.format,
    durationSec: asset.durationSec,
    width: asset.width,
    height: asset.height,
    bytes,
  };

  // Everything but the words is decided first, before any whisper or model time is spent.
  const pre = decideDriveAction({ asset: facts, caption: "-", claimedAt: row.createdAt, settings: s });
  if (pre.kind !== "post") return settle(row.id, pre);

  const { eligible, skipped } = driveTargets(
    c.id,
    s.socialAccountIds,
    await prisma.socialAccount.findMany({
      where: { id: { in: s.socialAccountIds }, clientId: c.id },
      select: { id: true, clientId: true, handle: true, platform: true, status: true, deletedAt: true, tokensEncrypted: true },
    }),
    s.mode,
  );
  if (!eligible.length) {
    return settle(row.id, {
      kind: "hold",
      reason: `No ticked Instagram account can post (${skipped.join("; ")}), so nothing was posted. Reconnect one or tick another in Workflows, then schedule this video by hand from Uploads.`,
    });
  }
  // Posted to the rest, with the ones left out on the row for the operator.
  const partial = skipped.length
    ? `Not posted to every ticked account: ${skipped.join("; ")}. Reconnect or untick ${skipped.length === 1 ? "it" : "them"} in Workflows.`
    : null;

  let written: { description: string; hashtags: string[] } | null;
  try {
    written = await writeCaption(asset, c.name);
  } catch (e) {
    if (e instanceof Held) return settle(row.id, { kind: "hold", reason: e.message });
    throw e;
  }

  // Composed the way the schedule route composes it: the client's block under
  // the words, the hashtags after a blank line, as the publish job joins them.
  const name = (asset.draftCopy as { name?: unknown } | null)?.name;
  const body = written
    ? composeCaption({ caption: written.description, title: typeof name === "string" ? name : "" }, c)
    : "";
  const hashtags = written?.hashtags ?? [];
  const words = [body, hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")].filter(Boolean).join("\n\n");

  // The words can take many minutes. A save in that time is decided on next
  // check (the caption is kept on the draft), never posted on the old settings.
  if (settingsMoved(s, await settingsNow(c.id))) return "processing";
  const action = decideDriveAction({ asset: facts, caption: written ? words : null, claimedAt: row.createdAt, settings: s });
  if (action.kind !== "post") return settle(row.id, action);

  const plan = trialReelPlan({ graduation: s.graduation, format: asset.format, durationSec: asset.durationSec, caption: words });

  if (action.mode === "dryrun") {
    const planned = [];
    for (const a of eligible) {
      const result = await new DryRunPublisher("instagram").publish({
        account: { id: a.id, platform: "instagram", handle: a.handle },
        videoUrl: asset.storageKey,
        caption: words,
        hashtags,
        extras: plan.extras,
      });
      planned.push({
        account: { id: a.id, handle: a.handle },
        caption: body,
        hashtags,
        options: plan.options,
        extras: plan.extras,
        remotePostId: result.remotePostId,
      });
    }
    await prisma.driveImport.update({
      where: { id: row.id },
      data: { status: "dryrun", reason: partial, detail: { targets: planned, skipped } as unknown as Prisma.InputJsonValue },
    });
    console.log(`[drive] import ${row.id} dryrun`);
    return "dry run";
  }

  // The actingUserId fallback in the API: the agency's first owner.
  const owner = await prisma.user.findFirst({
    where: { agencyId: c.agencyId, role: "owner" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!owner) throw new Error("this agency has no owner user to post as");

  // One transaction, so a crash cannot leave a post whose row still reads downloaded and posts again.
  const made = await prisma.$transaction(async (tx) => {
    // Locking the client row makes a settings save, and a hand schedule (its
    // Post references this row), wait for this or land before it is read. It
    // also lets one check at a time pick this client's next slot.
    const [locked] = await tx.$queryRaw<Array<{ driveSource: Prisma.JsonValue }>>`
      SELECT "driveSource" FROM "Client" WHERE "id" = ${c.id} AND "deletedAt" IS NULL FOR UPDATE`;
    // Nothing written yet; the next check decides on the new settings.
    if (settingsMoved(s, readDriveSource(locked?.driveSource))) return MOVED;
    if (await tx.post.count({ where: { mediaAssetId: asset.id, deletedAt: null } })) return null;
    // The next free slot on the calendar, so it can be moved or reworded there before it goes out.
    // Every target's own time: one dragged on its own still holds its slot.
    const taken = await tx.$queryRaw<Array<{ postId: string; at: Date }>>`
      SELECT DISTINCT t."postId" AS "postId", t."scheduledAt" AS at FROM "PostTarget" t
      JOIN "DriveImport" d ON d."postId" = t."postId"
      WHERE d."clientId" = ${c.id} AND t."scheduledAt" >= ${new Date(Date.now() - 24 * 3_600_000)}`;
    // The newest Drive post's time: this video, newer in the folder, goes after it.
    const [last] = await tx.$queryRaw<Array<{ at: Date | null }>>`
      SELECT MIN(t."scheduledAt") AS at FROM "PostTarget" t
      WHERE t."postId" = (
        SELECT p."id" FROM "Post" p JOIN "DriveImport" d ON d."postId" = p."id"
        WHERE d."clientId" = ${c.id} ORDER BY p."createdAt" DESC LIMIT 1
      )`;
    const scheduledAt = nextDriveSlot({
      now: new Date(),
      timeZone: env.BUSINESS_TIMEZONE,
      // The limit as saved now; a change to it alone does not stop this check.
      perDay: drivePerDay(readDriveSource(locked?.driveSource)),
      taken,
      after: last?.at ?? null,
    });
    const post = await tx.post.create({
      data: {
        clientId: c.id,
        mediaAssetId: asset.id,
        createdById: owner.id,
        status: "scheduled",
        // One target per account, the same trial reel on each.
        targets: {
          create: eligible.map((a) => ({
            socialAccountId: a.id,
            platform: "instagram",
            caption: body,
            hashtags,
            scheduledAt,
            status: "scheduled",
            options: plan.options as unknown as Prisma.InputJsonValue,
          })),
        },
      },
      include: { targets: true },
    });
    const moved = await tx.driveImport.updateMany({
      where: { id: row.id, status: "downloaded" },
      data: { status: "scheduled", reason: partial, postId: post.id },
    });
    if (!moved.count) throw new Error("this import was moved on by another check");
    return { targets: post.targets, scheduledAt };
  });
  if (made === MOVED) return "processing";
  if (!made) return settle(row.id, BY_HAND);
  // As the schedule route queues them: each keyed on its own target so nothing can queue one twice.
  for (const target of made.targets) {
    await enqueue(
      "publish",
      { targetId: target.id },
      { key: target.id, startAfter: made.scheduledAt, retryLimit: 3, retryDelaySeconds: 30, retryBackoff: true },
    );
  }
  console.log(
    `[drive] import ${row.id} scheduled for ${made.scheduledAt.toISOString()} as targets ${made.targets.map((t) => t.id).join(", ")}`,
  );
  return "scheduled";
}

const textOf = (t: unknown): string =>
  Array.isArray(t)
    ? (t as Array<{ text?: unknown }>)
        .map((seg) => (typeof seg.text === "string" ? seg.text : ""))
        .join(" ")
        .trim()
    : "";

/**
 * The caption the upload card's "Write with AI" writes: the same prompt,
 * schema and model call (POST /media/:id/caption), from the video's own
 * words. Null when the video has no speech.
 *
 * Saved onto the upload's draft, so a later check reuses it rather than
 * paying twice, and a held video shows its words in Uploads. Words already
 * in the draft (the operator typed some) win over writing new ones.
 */
async function writeCaption(asset: MediaAsset, brand: string): Promise<{ description: string; hashtags: string[] } | null> {
  const draft = (asset.draftCopy as Record<string, unknown> | null) ?? {};
  if (typeof draft.description === "string" && draft.description.trim()) {
    const tags = Array.isArray(draft.hashtags) ? draft.hashtags.filter((h): h is string => typeof h === "string") : [];
    return { description: draft.description, hashtags: tags };
  }

  let transcript = textOf(asset.transcript);
  if (!transcript && !asset.sourceDeletedAt) {
    try {
      const t = await transcribeStrict(path.join(env.STORAGE_DIR, asset.storageKey), { durationSec: asset.durationSec });
      if (t.segments.length) {
        await prisma.mediaAsset.update({
          where: { id: asset.id },
          data: { transcript: t.segments as unknown as Prisma.InputJsonValue },
        });
        transcript = textOf(t.segments);
      }
    } catch (e) {
      if (transcriptionRetries(e)) throw e;
      throw new Held(
        `The transcription service could not transcribe this video (${plain(e)}), so no caption was written and it was not posted. Write a caption and schedule it by hand from Uploads.`,
      );
    }
  }
  if (!transcript) return null;

  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set, so the caption cannot be written.");
  const response = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).messages.create({
    model: env.COPY_MODEL,
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: CAPTION_SCHEMA },
    },
    system: CAPTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildCaptionUserMessage(brand, transcript) }],
  });
  const block = response.content.find((b) => b.type === "text");
  let reply: WrittenCaption | null = null;
  if (response.stop_reason !== "refusal" && block?.type === "text") {
    try {
      reply = readCaptionReply(block.text);
    } catch {
      // Not JSON: held below rather than paid for again every check.
    }
  }
  const description = toPlainText(decodeEscapes(reply?.description ?? ""));
  if (!reply || !description) {
    throw new Held(
      "The caption writer did not return a usable caption, so this video was not posted. Write a caption and schedule it by hand from Uploads.",
    );
  }
  const hashtags = reply.hashtags.map((h) => toPlainText(decodeEscapes(h)).replace(/^#/, "")).filter(Boolean);
  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { draftCopy: { ...draft, description, hashtags } as Prisma.InputJsonValue },
  });
  return { description, hashtags };
}
