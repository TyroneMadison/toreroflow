import path from "node:path";
import fs from "node:fs/promises";
import { constants as fsc, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ASPECTS,
  LENGTH_TARGETS,
  clipText,
  nudgeRanges,
  parseDriveLink,
  safeFileName,
  rangesDuration,
  applyRecipe,
  seedClipDoc,
  sentences,
  type EditDoc,
  type RecipeSettings,
  type Aspect,
  type Range,
  type Shot,
  type Word,
} from "@toreroflow/core";
import { getPrisma, Prisma, enqueue } from "@toreroflow/db";
import { env } from "../env";
import { fileLinkVersioned } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";
import { assetWords, saveVersion } from "./editShared";
import { logActivity } from "../collab/activity";

/**
 * Studio > Clips: a long source cut into scored short clips.
 *
 * ponytail: the source is an EditAsset inside a holder EditProject with
 * status "clipsource" (hidden from the project list). That reuses the
 * editor's whole pipeline (proxy, filmstrip, windowed transcription, words
 * file, auto reframe) instead of a second source model, and an opened
 * candidate is a normal project whose asset points at the same files.
 */

const optionsSchema = z.object({
  length: z.enum(["auto", ...(Object.keys(LENGTH_TARGETS) as [string, ...string[]])]).default("auto"),
  genre: z.string().max(40).optional(),
  prompt: z.string().max(300).optional(),
  keywords: z.array(z.string().max(40)).max(12).optional(),
  aspect: z.enum(ASPECTS as [Aspect, ...Aspect[]]).default("9:16"),
  range: z.tuple([z.number().min(0), z.number().positive()]).refine(([a, b]) => b > a, "range end is before its start").optional(),
  language: z.string().max(8).optional(),
  reframe: z.boolean().default(true),
  /** Phase 6: the recipe applied when a clip opens; none means the brand default. */
  recipeId: z.string().max(40).optional(),
});

const fromAssetSchema = optionsSchema.extend({
  mediaAssetId: z.string().optional(),
  editAssetId: z.string().optional(),
}).refine((v) => !!v.mediaAssetId !== !!v.editAssetId, "Pick one source: an upload or an editor clip.");

const refineSchema = z.object({
  start: z.number().min(0),
  end: z.number().positive(),
  prompt: z.string().max(300).optional(),
}).refine((v) => v.end - v.start >= 10, "Pick at least 10 seconds.");

const patchSchema = z.object({
  // "up", "down" or "down:<reason>" (the feedback modal's chip).
  feedback: z.string().regex(/^(up|down)(:[^\n]{1,80})?$/, "Feedback is up or down.").nullable().optional(),
  nudge: z.object({ edge: z.enum(["start", "end"]), dir: z.enum(["extend", "shrink"]) }).optional(),
  title: z.string().min(1).max(120).optional(),
  /** Phase 6: the drafted copy, edited before a batch send. */
  description: z.string().max(2200).optional(),
  hashtags: z.array(z.string().trim().min(1).max(60).transform((h) => h.replace(/^#/, ""))).max(30).optional(),
});

const openSchema = z.object({ ids: z.array(z.string()).min(1).max(20) });

const batchSchema = z.object({
  ids: z.array(z.string()).min(1).max(20),
  export: z.object({
    resolution: z.union([z.literal(720), z.literal(1080), z.literal(1440)]).default(1080),
    fps: z.union([z.literal(30), z.literal(60)]).default(30),
    format: z.enum(["mp4", "mov"]).default("mp4"),
    bitrateK: z.number().int().min(500).max(200_000).default(12_000),
  }).default({}),
  /** Send each finished render to Uploads with the clip's copy drafted. */
  send: z.boolean().default(false),
});

const bad = (detail: string, error = "that request was not right") => ({ error, detail });

export async function clipRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const ownedClient = (clientId: string, agencyId: string) =>
    prisma.client.findFirst({ where: { id: clientId, agencyId, deletedAt: null }, select: { id: true } });

  const ownedJob = (id: string, agencyId: string) =>
    prisma.clipJob.findFirst({ where: { id, client: { agencyId } }, include: { source: true } });

  const ownedCandidate = (id: string, agencyId: string) =>
    prisma.clipCandidate.findFirst({ where: { id, job: { client: { agencyId } } }, include: { job: { include: { source: true } } } });

  async function holder(clientId: string, name: string) {
    return prisma.editProject.create({ data: { clientId, name: `Clips source: ${name}`.slice(0, 200), status: "clipsource" } });
  }

  /**
   * A job's recipe must be this brand's. Its aspect wins over the job's, so
   * auto reframe computes shots for the framing the recipe will open with.
   */
  async function withRecipe(clientId: string, options: z.infer<typeof optionsSchema>) {
    if (!options.recipeId) return options;
    const r = await prisma.recipe.findFirst({ where: { id: options.recipeId, clientId } });
    if (!r) return null;
    const aspect = (r.settings as RecipeSettings).aspect;
    return aspect ? { ...options, aspect } : options;
  }

  async function startJob(clientId: string, sourceAssetId: string, options: z.infer<typeof optionsSchema>) {
    const job = await prisma.clipJob.create({
      data: {
        clientId,
        sourceAssetId,
        options: { ...options, log: [{ at: new Date().toISOString(), line: "uploaded" }] } as unknown as Prisma.InputJsonValue,
        stage: "queued",
      },
    });
    await enqueue("clips", { clipJobId: job.id, stage: "analyze" });
    return job;
  }

  function jobView(j: {
    id: string; status: string; stage: string | null; pct: number; error: string | null; options: unknown;
    createdAt: Date; updatedAt: Date;
    source: { id: string; originalName: string; durationSec: number | null; width: number | null; height: number | null; language: string | null; status: string; proxyKey: string | null; stripKey: string | null; storageKey: string };
  }, extra: Record<string, unknown> = {}) {
    const o = (j.options ?? {}) as Record<string, unknown>;
    return {
      id: j.id,
      status: j.status,
      stage: j.stage,
      pct: j.pct,
      error: j.error,
      options: o,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      source: {
        id: j.source.id,
        name: j.source.originalName,
        durationSec: j.source.durationSec,
        width: j.source.width,
        height: j.source.height,
        language: j.source.language,
        status: j.source.status,
        proxyUrl: j.source.proxyKey ? fileLinkVersioned(j.source.proxyKey, null) : null,
        stripUrl: j.source.stripKey ? fileLinkVersioned(j.source.stripKey, null) : null,
      },
      ...extra,
    };
  }

  /** Multipart: fields first (options JSON in "options"), then the file. */
  app.post<{ Params: { clientId: string } }>("/clients/:clientId/clip-jobs", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found" });
    const file = await request.file();
    if (!file) return reply.status(400).send(bad("Choose a video file.", "no file uploaded"));
    const field = file.fields?.options as { value?: string } | undefined;
    let raw: unknown = {};
    try {
      raw = field?.value ? JSON.parse(field.value) : {};
    } catch {
      return reply.status(400).send(bad("The job options were not valid JSON."));
    }
    const parsed = optionsSchema.safeParse(raw);
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the job options."));
    const withR = await withRecipe(client.id, parsed.data);
    if (!withR) return reply.status(404).send(bad("That recipe is not in this brand.", "recipe not found"));
    parsed.data = withR;
    const name = file.filename ?? "upload.mp4";
    const project = await holder(client.id, name);
    const asset = await prisma.editAsset.create({
      data: { projectId: project.id, kind: "clip", storageKey: "pending", originalName: name, status: "uploaded", language: parsed.data.language ?? null, languageSource: parsed.data.language ? "set" : null },
    });
    const ext = path.extname(name) || ".mp4";
    const storageKey = `${client.id}/edit/${project.id}/${asset.id}-source${ext}`;
    await fs.mkdir(path.join(env.STORAGE_DIR, client.id, "edit", project.id), { recursive: true });
    await pipeline(file.file, createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
    if (file.file.truncated) {
      await fs.rm(path.join(env.STORAGE_DIR, storageKey), { force: true });
      await prisma.editProject.delete({ where: { id: project.id } });
      return reply.status(413).send({ error: "file too large", detail: "That file is over the upload limit." });
    }
    await prisma.editAsset.update({ where: { id: asset.id }, data: { storageKey } });
    const job = await startJob(client.id, asset.id, parsed.data);
    return reply.status(201).send({ id: job.id });
  });

  /** From an upload (MediaAsset, copied so retention can't pull it) or an editor clip (shared). */
  app.post<{ Params: { clientId: string } }>("/clients/:clientId/clip-jobs/from-asset", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found" });
    const parsed = fromAssetSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the job options."));
    const { mediaAssetId, editAssetId, ...options } = parsed.data;
    const opts = await withRecipe(client.id, optionsSchema.parse(options));
    if (!opts) return reply.status(404).send(bad("That recipe is not in this brand.", "recipe not found"));
    if (editAssetId) {
      const ea = await prisma.editAsset.findFirst({ where: { id: editAssetId, kind: "clip", project: { clientId: client.id } } });
      if (!ea) return reply.status(404).send(bad("That clip is not in this brand's projects.", "clip not found"));
      const project = await holder(client.id, ea.originalName);
      const copy = await prisma.editAsset.create({
        data: {
          projectId: project.id, kind: "clip", storageKey: ea.storageKey, proxyKey: ea.proxyKey, stripKey: ea.stripKey,
          originalName: ea.originalName, durationSec: ea.durationSec, width: ea.width, height: ea.height,
          words: ea.words ?? Prisma.DbNull, wordsKey: ea.wordsKey, language: ea.language, languageProb: ea.languageProb, languageSource: ea.languageSource, peaksKey: ea.peaksKey,
          status: ea.status === "ready" ? "ready" : "uploaded",
        },
      });
      const job = await startJob(client.id, copy.id, opts);
      return reply.status(201).send({ id: job.id });
    }
    const ma = await prisma.mediaAsset.findFirst({ where: { id: mediaAssetId!, clientId: client.id } });
    if (!ma) return reply.status(404).send(bad("That upload is not in this brand.", "upload not found"));
    const project = await holder(client.id, ma.originalName);
    const asset = await prisma.editAsset.create({
      data: { projectId: project.id, kind: "clip", storageKey: "pending", originalName: ma.originalName, status: "uploaded", language: opts.language ?? null, languageSource: opts.language ? "set" : null },
    });
    const storageKey = `${client.id}/edit/${project.id}/${asset.id}-source${path.extname(ma.originalName) || ".mp4"}`;
    await fs.mkdir(path.join(env.STORAGE_DIR, client.id, "edit", project.id), { recursive: true });
    try {
      await fs.copyFile(path.join(env.STORAGE_DIR, ma.storageKey), path.join(env.STORAGE_DIR, storageKey), fsc.COPYFILE_FICLONE);
    } catch {
      await prisma.editProject.delete({ where: { id: project.id } });
      return reply.status(409).send(bad("The upload's file is no longer on the server.", "source file missing"));
    }
    await prisma.editAsset.update({ where: { id: asset.id }, data: { storageKey } });
    const job = await startJob(client.id, asset.id, opts);
    return reply.status(201).send({ id: job.id });
  });

  /**
   * Phase 8 Google Drive import, no OAuth: a publicly shared ("anyone with
   * the link") file downloads keylessly; a shared folder lists through the
   * Drive API with GOOGLE_DRIVE_API_KEY (falls back to YOUTUBE_API_KEY).
   * ponytail: private files need the Drive picker with OAuth, deferred
   * (no new Google Cloud setup this phase).
   */
  app.post<{ Params: { clientId: string } }>("/clients/:clientId/drive/list", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found", detail: "No such brand in this workspace." });
    const ref = parseDriveLink(String((request.body as { link?: unknown } | undefined)?.link ?? ""));
    if (!ref) return reply.status(400).send(bad("Paste a Google Drive file or folder share link.", "not a Drive link"));
    if (ref.kind === "file") {
      if (!env.GOOGLE_DRIVE_API_KEY) return { kind: "file", files: [{ id: ref.id, name: null, size: null }] };
      const r = await fetch(`${env.DRIVE_API_BASE}/files/${ref.id}?fields=id,name,size,mimeType&supportsAllDrives=true&key=${env.GOOGLE_DRIVE_API_KEY}`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return reply.status(r.status === 404 ? 404 : 502).send(bad("Drive could not show that file. Is it shared as \"Anyone with the link\"?", "drive file not found"));
      const f = (await r.json()) as { id: string; name?: string; size?: string };
      return { kind: "file", files: [{ id: f.id, name: f.name ?? null, size: f.size ? Number(f.size) : null }] };
    }
    if (!env.GOOGLE_DRIVE_API_KEY) {
      return reply.status(503).send(bad("Listing a folder needs GOOGLE_DRIVE_API_KEY. Share single files instead, they import without it.", "folder listing is off"));
    }
    const q = encodeURIComponent(`'${ref.id}' in parents and trashed = false and mimeType contains 'video/'`);
    const r = await fetch(`${env.DRIVE_API_BASE}/files?q=${q}&fields=files(id,name,size,mimeType)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${env.GOOGLE_DRIVE_API_KEY}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return reply.status(502).send(bad(`Drive answered ${r.status}. Is the folder shared as "Anyone with the link"?`, "drive list failed"));
    const data = (await r.json()) as { files?: { id: string; name: string; size?: string }[] };
    return { kind: "folder", files: (data.files ?? []).map((f) => ({ id: f.id, name: f.name, size: f.size ? Number(f.size) : null })) };
  });

  app.post<{ Params: { clientId: string } }>("/clients/:clientId/clip-jobs/from-drive", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found", detail: "No such brand in this workspace." });
    const body = (request.body ?? {}) as { fileId?: unknown; name?: unknown };
    const fileId = typeof body.fileId === "string" && /^[A-Za-z0-9_-]{10,}$/.test(body.fileId) ? body.fileId : null;
    if (!fileId) return reply.status(400).send(bad("Pick a Drive file.", "no file"));
    const { fileId: _f, name: _n, ...rest } = body as Record<string, unknown>;
    const parsed = optionsSchema.safeParse(rest);
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the job options."));
    const opts = await withRecipe(client.id, parsed.data);
    if (!opts) return reply.status(404).send(bad("That recipe is not in this brand.", "recipe not found"));
    const url = env.GOOGLE_DRIVE_API_KEY
      ? `${env.DRIVE_API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true&key=${env.GOOGLE_DRIVE_API_KEY}`
      : `${env.DRIVE_DOWNLOAD_BASE}/download?id=${fileId}&export=download&confirm=t`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || /^text\/html|json/.test(type)) {
      return reply.status(res.status === 404 ? 404 : 422).send(bad("Drive did not hand over a video. Share it as \"Anyone with the link\" and try again.", "drive download failed"));
    }
    const disp = res.headers.get("content-disposition") ?? "";
    const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp)?.[1];
    const name = safeFileName(typeof body.name === "string" && body.name ? body.name : fromHeader ? decodeURIComponent(fromHeader) : `drive-${fileId}.mp4`);
    const project = await holder(client.id, name);
    const asset = await prisma.editAsset.create({
      data: { projectId: project.id, kind: "clip", storageKey: "pending", originalName: name, status: "uploaded", language: opts.language ?? null, languageSource: opts.language ? "set" : null },
    });
    const storageKey = `${client.id}/edit/${project.id}/${asset.id}-source${path.extname(name) || ".mp4"}`;
    await fs.mkdir(path.join(env.STORAGE_DIR, client.id, "edit", project.id), { recursive: true });
    try {
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
    } catch {
      await fs.rm(path.join(env.STORAGE_DIR, storageKey), { force: true });
      await prisma.editProject.delete({ where: { id: project.id } });
      return reply.status(502).send(bad("The Drive download stopped part way.", "drive download failed"));
    }
    await prisma.editAsset.update({ where: { id: asset.id }, data: { storageKey } });
    const job = await startJob(client.id, asset.id, opts);
    logActivity(request, { clientId: client.id, action: "imported", jobId: job.id, detail: `${name} from Drive` });
    return reply.status(201).send({ id: job.id });
  });

  app.get<{ Params: { clientId: string } }>("/clients/:clientId/clip-jobs", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found" });
    const jobs = await prisma.clipJob.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { source: true, _count: { select: { candidates: true } }, candidates: { select: { score: true }, orderBy: { score: "desc" }, take: 1 } },
    });
    return jobs.map((j) => jobView(j, { clipCount: j._count.candidates, topScore: j.candidates[0]?.score ?? null }));
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/clip-jobs/:id", async (request, reply) => {
    const job = await ownedJob(request.params.id, request.user.agencyId);
    if (!job) return reply.status(404).send({ error: "clip job not found" });
    const q = (request.query.q ?? "").trim();
    const candidates = await prisma.clipCandidate.findMany({
      where: { jobId: job.id, ...(q ? { OR: [{ text: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] } : {}) },
      orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    });
    return jobView(job, { candidates });
  });

  app.delete<{ Params: { id: string } }>("/clip-jobs/:id", async (request, reply) => {
    const job = await ownedJob(request.params.id, request.user.agencyId);
    if (!job) return reply.status(404).send({ error: "clip job not found" });
    // The holder goes with the job (cascade drops asset, job, candidates).
    // Files stay: opened candidates' projects point at the same source.
    await prisma.editProject.deleteMany({ where: { id: job.source.projectId, status: "clipsource" } });
    await prisma.clipJob.deleteMany({ where: { id: job.id } });
    return { ok: true };
  });

  /** Rerun from a stage (failed-state "Retry stage"). Stages are idempotent. */
  app.post<{ Params: { id: string }; Body: { stage?: string } }>("/clip-jobs/:id/retry", async (request, reply) => {
    const job = await ownedJob(request.params.id, request.user.agencyId);
    if (!job) return reply.status(404).send({ error: "clip job not found" });
    const stage = ["analyze", "curate", "score"].includes(request.body?.stage ?? "") ? request.body!.stage! : "analyze";
    await prisma.clipJob.update({ where: { id: job.id }, data: { status: "queued", error: null } });
    await enqueue("clips", { clipJobId: job.id, stage });
    return reply.status(202).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/clip-jobs/:id/refine", async (request, reply) => {
    const job = await ownedJob(request.params.id, request.user.agencyId);
    if (!job) return reply.status(404).send({ error: "clip job not found" });
    if (job.status !== "ready") return reply.status(409).send(bad("Wait for the job to finish first.", "job still running"));
    const parsed = refineSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the range."));
    await enqueue("clips", { clipJobId: job.id, stage: "refine", ...parsed.data });
    return reply.status(202).send({ ok: true });
  });

  async function wordsOf(source: { words: unknown; wordsKey: string | null }): Promise<Word[]> {
    if (source.wordsKey) {
      try {
        return JSON.parse(await fs.readFile(path.join(env.STORAGE_DIR, source.wordsKey), "utf8")) as Word[];
      } catch {
        return [];
      }
    }
    return (source.words as Word[] | null) ?? [];
  }

  app.patch<{ Params: { id: string } }>("/clip-candidates/:id", async (request, reply) => {
    const c = await ownedCandidate(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send({ error: "clip not found" });
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the change."));
    const data: Prisma.ClipCandidateUpdateInput = {};
    if (parsed.data.feedback !== undefined) data.feedback = parsed.data.feedback;
    if (parsed.data.title) data.title = parsed.data.title;
    if (parsed.data.description !== undefined) data.description = parsed.data.description;
    if (parsed.data.hashtags) data.hashtags = parsed.data.hashtags;
    if (parsed.data.nudge) {
      const words = await wordsOf(c.job.source);
      const ranges = nudgeRanges(c.ranges as unknown as Range[], sentences(words), parsed.data.nudge.edge, parsed.data.nudge.dir);
      data.ranges = ranges as unknown as Prisma.InputJsonValue;
      data.duration = Math.round(rangesDuration(ranges) * 100) / 100;
      data.text = clipText(ranges, words);
    }
    if (parsed.data.feedback) {
      logActivity(request, { clientId: c.job.clientId, action: parsed.data.feedback.startsWith("up") ? "liked" : "disliked", candidateId: c.id, jobId: c.jobId, detail: c.title });
    }
    if (parsed.data.nudge) logActivity(request, { clientId: c.job.clientId, action: "trimmed", candidateId: c.id, jobId: c.jobId, detail: c.title });
    const updated = await prisma.clipCandidate.update({ where: { id: c.id }, data });
    // Phase 9: every like or dislike retunes the client's judge rubric.
    if (parsed.data.feedback !== undefined) await enqueue("clips", { smart: c.job.clientId }, { key: `smart:${c.job.clientId}` });
    return updated;
  });

  app.post<{ Params: { id: string } }>("/clip-candidates/:id/rescore", async (request, reply) => {
    const c = await ownedCandidate(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send({ error: "clip not found" });
    await enqueue("clips", { clipJobId: c.jobId, stage: "rescore", candidateId: c.id });
    return reply.status(202).send({ ok: true });
  });

  /**
   * Open one or more candidates in the editor: one new project each, seeded
   * with the clip's ranges in play order, the source's auto-reframe shots
   * and captions on. A second open of the same candidate returns its project.
   */
  type Owned = NonNullable<Awaited<ReturnType<typeof ownedCandidate>>>;

  /** The recipe a job opens with: its own, else the brand default, else none. */
  async function recipeFor(c: Owned): Promise<RecipeSettings | null> {
    const opts = (c.job.options ?? {}) as { recipeId?: string };
    const r =
      (opts.recipeId ? await prisma.recipe.findFirst({ where: { id: opts.recipeId, clientId: c.job.clientId } }) : null) ??
      (await prisma.recipe.findFirst({ where: { clientId: c.job.clientId, isDefault: true } }));
    return r ? (r.settings as RecipeSettings) : null;
  }

  /**
   * One candidate as an editor project: seeded with the clip's ranges in play
   * order, the source's auto-reframe shots, captions on, then the recipe.
   * A second open returns the same project.
   */
  async function openCandidate(c: Owned): Promise<{ projectId: string } | { status: number; body: { error: string; detail: string } }> {
    if (c.editProjectId) {
      const still = await prisma.editProject.findFirst({ where: { id: c.editProjectId }, select: { id: true } });
      if (still) return { projectId: still.id };
    }
    const src = c.job.source;
    if (src.status !== "ready") return { status: 409, body: bad("The source is still processing.", "source not ready") };
    const opts = (c.job.options ?? {}) as { aspect?: Aspect };
    let shots: Shot[] | undefined;
    let facesKey: string | undefined;
    try {
      const st = JSON.parse(
        await fs.readFile(path.join(env.STORAGE_DIR, path.posix.dirname(src.storageKey), `${src.id}-reframe.json`), "utf8"),
      ) as { status: string; shots?: Shot[]; facesKey?: string; aspect?: string };
      // Shots are computed for one aspect; only reuse them for that one.
      if (st.status === "ready" && (st.aspect ?? "9:16") === (opts.aspect ?? "9:16")) {
        shots = st.shots;
        facesKey = st.facesKey;
      }
    } catch {
      // No reframe: the editor's default framing.
    }
    const project = await prisma.editProject.create({ data: { clientId: c.job.clientId, name: c.title.slice(0, 200) } });
    const asset = await prisma.editAsset.create({
      data: {
        projectId: project.id, kind: "clip", storageKey: src.storageKey, proxyKey: src.proxyKey, stripKey: src.stripKey,
        originalName: src.originalName, durationSec: src.durationSec, width: src.width, height: src.height,
        words: src.words ?? Prisma.DbNull, wordsKey: src.wordsKey, language: src.language, languageProb: src.languageProb, languageSource: src.languageSource, peaksKey: src.peaksKey,
        status: "ready",
      },
    });
    let doc: EditDoc = seedClipDoc(asset.id, c.ranges as unknown as Range[], { shots, facesKey, aspect: opts.aspect ?? "9:16", name: c.title });
    const recipe = await recipeFor(c);
    if (recipe) {
      // The seeded aspect matches the reframe shots; a different recipe
      // aspect would throw them away, so a job-time recipe already set it.
      const { aspect: _drop, ...rest } = recipe;
      void _drop;
      const words = await assetWords(src);
      doc = applyRecipe(doc, rest, { [asset.id]: src.durationSec ?? 0 }, { [asset.id]: words }).doc;
    }
    await prisma.editProject.update({ where: { id: project.id }, data: { doc: doc as unknown as Prisma.InputJsonValue } });
    await prisma.clipCandidate.update({ where: { id: c.id }, data: { editProjectId: project.id } });
    return { projectId: project.id };
  }

  app.post("/clip-candidates/open", async (request, reply) => {
    const parsed = openSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad("Pick at least one clip."));
    const out: { candidateId: string; projectId: string }[] = [];
    for (const id of parsed.data.ids) {
      const c = await ownedCandidate(id, request.user.agencyId);
      if (!c) return reply.status(404).send({ error: "clip not found", detail: `No clip ${id} in this workspace.` });
      const r = await openCandidate(c);
      if (!("projectId" in r)) return reply.status(r.status).send(r.body);
      out.push({ candidateId: c.id, projectId: r.projectId });
      logActivity(request, { clientId: c.job.clientId, action: "opened", candidateId: c.id, jobId: c.jobId, projectId: r.projectId, detail: c.title });
    }
    return { projects: out };
  });

  /**
   * Phase 6 batch: open (recipe applied) and queue a render for each clip.
   * With send, the worker drops each finished file in Uploads with the
   * clip's title, description and hashtags as its drafted copy.
   * ponytail: copy comes from the curated candidate, not POST
   * /media/:id/caption, so a batch never spends on an LLM.
   * Clips already rendering are left alone; failed ones re-queue (Retry).
   */
  app.post("/clip-candidates/batch-render", async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the batch."));
    const { ids, export: ex, send } = parsed.data;
    const items: { candidateId: string; projectId: string | null; queued: boolean; error?: string }[] = [];
    for (const id of ids) {
      const c = await ownedCandidate(id, request.user.agencyId);
      if (!c) {
        items.push({ candidateId: id, projectId: null, queued: false, error: "clip not found" });
        continue;
      }
      const r = await openCandidate(c);
      if (!("projectId" in r)) {
        items.push({ candidateId: id, projectId: null, queued: false, error: r.body.detail });
        continue;
      }
      const p = await prisma.editProject.findUnique({ where: { id: r.projectId } });
      if (!p || !p.doc) {
        items.push({ candidateId: id, projectId: r.projectId, queued: false, error: "nothing to render" });
        continue;
      }
      if (p.status === "rendering") {
        items.push({ candidateId: id, projectId: p.id, queued: false, error: "already rendering" });
        continue;
      }
      const name = c.title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120) || "clip";
      const doc = { ...(p.doc as Record<string, unknown>), export: { name, resolution: ex.resolution, fps: ex.fps, format: ex.format, bitrate: ex.bitrateK } };
      await saveVersion(p.id, p.doc, "Before batch render", true);
      await prisma.editProject.update({
        where: { id: p.id },
        data: {
          status: "rendering",
          renderPct: 0,
          renderError: null,
          uploadAssetId: null,
          doc: doc as Prisma.InputJsonValue,
          afterRender: send
            ? ({ send: true, title: c.title, description: c.description ?? "", hashtags: c.hashtags } as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });
      await enqueue("edit", { editProjectId: p.id, job: "render" });
      items.push({ candidateId: id, projectId: p.id, queued: true });
      logActivity(request, { clientId: c.job.clientId, action: send ? "rendered_sent" : "rendered", candidateId: c.id, jobId: c.jobId, projectId: p.id, detail: c.title });
    }
    return reply.status(202).send({ items });
  });

  /** Per-clip batch progress: status, percent, error, and the upload once sent. */
  app.get<{ Querystring: { ids?: string } }>("/clip-candidates/batch-status", async (request, reply) => {
    const ids = (request.query.ids ?? "").split(",").filter(Boolean).slice(0, 50);
    if (!ids.length) return reply.status(400).send(bad("Pass ids=a,b,c."));
    const cands = await prisma.clipCandidate.findMany({
      where: { id: { in: ids }, job: { client: { agencyId: request.user.agencyId } } },
      select: { id: true, editProjectId: true },
    });
    const projects = await prisma.editProject.findMany({
      where: { id: { in: cands.map((c) => c.editProjectId).filter((x): x is string => !!x) } },
      select: { id: true, status: true, renderPct: true, renderError: true, uploadAssetId: true, afterRender: true },
    });
    const byId = new Map(projects.map((p) => [p.id, p]));
    return {
      items: cands.map((c) => {
        const p = c.editProjectId ? byId.get(c.editProjectId) : undefined;
        const wantsSend = !!(p?.afterRender as { send?: boolean } | null)?.send;
        return {
          candidateId: c.id,
          projectId: p?.id ?? null,
          // queued = waiting for a free render slot (pct still 0).
          status: !p ? "none" : p.uploadAssetId ? "sent" : p.status === "rendering" && !p.renderPct ? "queued" : p.status === "rendered" && wantsSend ? "sending" : p.status,
          renderPct: p?.renderPct ?? 0,
          error: p?.renderError ?? null,
          uploadAssetId: p?.uploadAssetId ?? null,
        };
      }),
    };
  });
}
