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
  instagramVideoError,
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
  listFolderVideos,
  type InstagramScheduleOptions,
} from "@toreroflow/publishers";
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
  !(e instanceof DriveError) || e.status === 0 || e.status === 429 || e.status >= 500;

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
      if (!readDriveSource(c.driveSource).on) continue;
      const notes: string[] = [];
      for (const pass of [ingestNext, advance]) {
        try {
          notes.push(await pass(c));
        } catch (e) {
          notes.push(plain(e));
          console.error(`[drive] client ${c.id}: ${plain(e)}`);
        }
      }
      await saveResult(c.id, notes.filter(Boolean).join(" ") || "Nothing to do.");
    }
  } finally {
    running = false;
  }
}

/**
 * Merged into the stored settings in one statement, so an operator's save
 * that lands mid-check is never written back over.
 */
async function saveResult(clientId: string, lastResult: string): Promise<void> {
  const patch = JSON.stringify({ lastCheckAt: new Date().toISOString(), lastResult: lastResult.slice(0, 500) });
  await prisma.$executeRaw`UPDATE "Client" SET "driveSource" = "driveSource" || ${patch}::jsonb
    WHERE "id" = ${clientId} AND jsonb_typeof("driveSource") = 'object'`;
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
  if (!file) return `${files.length} videos in the folder, nothing new.`;
  const later = fresh.length > 1 ? ` ${fresh.length - 1} more follow on later checks.` : "";

  const over = file.size != null ? instagramVideoError(null, file.size) : null;
  const tooLarge = over?.replace(/, or untick Instagram\.$/, ", then add the new file to the Drive folder.") ?? null;
  let row: DriveImport;
  try {
    row = await prisma.driveImport.create({
      data: { clientId: c.id, fileId: file.id, name: file.name.slice(0, 300), status: tooLarge ? "skipped" : "claimed", reason: tooLarge },
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
    } catch (e) {
      // Left as downloaded, so the next check tries it again.
      errors.push(plain(e));
      console.error(`[drive] import ${row.id}: ${plain(e)}`);
    }
  }
  const line = [[...tally].map(([status, n]) => `${n} ${status}`).join(", "), ...errors].filter(Boolean).join(". ");
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
      reason: `No ticked Instagram account can post (${skipped.join("; ")}), so nothing was posted. Reconnect one or tick another in Settings, then schedule this video by hand from Uploads.`,
    });
  }
  // Posted to the rest, with the ones left out on the row for the operator.
  const partial = skipped.length
    ? `Not posted to every ticked account: ${skipped.join("; ")}. Reconnect or untick ${skipped.length === 1 ? "it" : "them"} in Settings.`
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

  const scheduledAt = new Date();
  // One transaction, so a crash cannot leave a post whose row still reads downloaded and posts again.
  const targets = await prisma.$transaction(async (tx) => {
    // Locking the client row makes a settings save, and a hand schedule (its
    // Post references this row), wait for this or land before it is read.
    const [locked] = await tx.$queryRaw<Array<{ driveSource: Prisma.JsonValue }>>`
      SELECT "driveSource" FROM "Client" WHERE "id" = ${c.id} AND "deletedAt" IS NULL FOR UPDATE`;
    if (settingsMoved(s, readDriveSource(locked?.driveSource))) {
      throw new Error("the Drive settings were saved during this check, so it was not posted. The next check uses them");
    }
    if (await tx.post.count({ where: { mediaAssetId: asset.id, deletedAt: null } })) return null;
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
    return post.targets;
  });
  if (!targets) return settle(row.id, BY_HAND);
  // As the schedule route queues them: each keyed on its own target so nothing can queue one twice.
  for (const target of targets) {
    await enqueue(
      "publish",
      { targetId: target.id },
      { key: target.id, startAfter: scheduledAt, retryLimit: 3, retryDelaySeconds: 30, retryBackoff: true },
    );
  }
  console.log(`[drive] import ${row.id} scheduled as targets ${targets.map((t) => t.id).join(", ")}`);
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
