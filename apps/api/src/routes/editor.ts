import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  edlFromDoc,
  outputDuration,
  sentencesFromWords,
  toOutputTime,
  type EditDoc,
} from "@toreroflow/core";
import { getPrisma, Prisma, enqueue } from "@toreroflow/db";
import { env } from "../env";
import { fileLink, fileLinkVersioned } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Studio projects and the source files they own.
 *
 * Editor sources are EditAsset rows, not MediaAssets, so the publish
 * pipeline's quota counts and retention sweeps never see them. Files live
 * under storage/<clientId>/edit/<projectId>/.
 */

const createSchema = z.object({
  name: z.string().min(1).max(200).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // The doc's internals are the desktop's contract with itself; the server
  // only insists it is an object, so a stringified blob cannot slip in.
  doc: z.record(z.unknown()).optional(),
});

/**
 * An asset row as the desktop sees it: raw storage keys swapped for signed
 * URLs the webview can actually load. Keys never leave the server.
 */
function assetView<
  T extends { storageKey: string; proxyKey: string | null; stripKey: string | null },
>(a: T) {
  const { storageKey, proxyKey, stripKey, ...rest } = a;
  return {
    ...rest,
    sourceUrl: storageKey !== "pending" ? fileLinkVersioned(storageKey, null) : null,
    proxyUrl: proxyKey ? fileLinkVersioned(proxyKey, null) : null,
    stripUrl: stripKey ? fileLinkVersioned(stripKey, null) : null,
  };
}

const ASSET_KINDS = ["clip", "audio", "graphic"] as const;
const ASSET_EXT_FALLBACK: Record<string, string> = {
  clip: ".mp4",
  audio: ".mp3",
  graphic: ".png",
};

const renderSchema = z.object({
  name: z.string().min(1).max(200),
  resolution: z.union([z.literal(720), z.literal(1080), z.literal(1440)]),
  fps: z.union([z.literal(30), z.literal(60)]),
  format: z.enum(["mp4", "mov"]),
  /** Video bit rate in kbps, already scaled for the frame rate by the desktop. */
  bitrateK: z.number().int().min(500).max(200_000),
});

/** The chip's number is the floor of a 10 second window: 10 means 10 to 20. */
const shortenSchema = z.object({
  targetSec: z.union([z.literal(10), z.literal(20), z.literal(30)]),
});

const SHORTEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cuts"],
  properties: {
    cuts: {
      /*
       * No length bounds on purpose: structured output rejects most array
       * bounds with a 400 that costs the whole generation. How much to cut
       * is asked for in the prompt, and the result is validated after.
       */
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["assetId", "start", "end"],
        properties: {
          assetId: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
        },
      },
    },
  },
} as const;

export async function editorRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.addHook("onRequest", requireAuth);

  /** Confirms the client belongs to the operator's workspace before anything else. */
  const ownedClient = async (clientId: string, agencyId: string) =>
    prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
      select: { id: true },
    });

  /** A project reached by id, still scoped through the client's agency. */
  const ownedProject = async (id: string, agencyId: string) =>
    prisma.editProject.findFirst({
      where: { id, client: { agencyId } },
    });

  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/edit-projects",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const projects = await prisma.editProject.findMany({
        where: { clientId: client.id },
        orderBy: { updatedAt: "desc" },
        take: 50,
        include: { assets: { select: { kind: true, durationSec: true } } },
      });
      return projects.map((p) => {
        const clips = p.assets.filter((a) => a.kind === "clip");
        return {
          id: p.id,
          name: p.name,
          status: p.status,
          clipCount: clips.length,
          durationSec: clips.reduce((sum, a) => sum + (a.durationSec ?? 0), 0),
          updatedAt: p.updatedAt,
        };
      });
    },
  );

  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/edit-projects",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const parsed = createSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "that project could not be created",
          detail: parsed.error.issues[0]?.message ?? "A project name is a short line of text.",
        });
      }
      return reply.status(201).send(
        await prisma.editProject.create({
          data: { clientId: client.id, ...(parsed.data.name ? { name: parsed.data.name } : {}) },
        }),
      );
    },
  );

  app.get<{ Params: { id: string } }>("/edit-projects/:id", async (request, reply) => {
    const project = await prisma.editProject.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      include: { assets: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) return reply.status(404).send({ error: "project not found" });
    return {
      ...project,
      // Versioned by updatedAt so a re-render under the same key shows fresh.
      renderedUrl: project.renderedKey
        ? fileLinkVersioned(project.renderedKey, project.updatedAt.getTime())
        : null,
      assets: project.assets.map(assetView),
    };
  });

  /** The autosave target. The doc arrives whole every time; nothing merges. */
  app.patch<{ Params: { id: string } }>("/edit-projects/:id", async (request, reply) => {
    const project = await ownedProject(request.params.id, request.user.agencyId);
    if (!project) return reply.status(404).send({ error: "project not found" });
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "that change could not be saved",
        detail: parsed.error.issues[0]?.message ?? "The edit document has to be an object.",
      });
    }
    return prisma.editProject.update({
      where: { id: project.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.doc !== undefined
          ? { doc: parsed.data.doc as Prisma.InputJsonValue }
          : {}),
      },
    });
  });

  /**
   * Save Copy: fork the project so past renders never mutate.
   *
   * The EditAsset rows are duplicated but point at the same storage keys, so
   * the files on disk are shared between the two projects. Fine for now:
   * nothing deletes an asset's files while any row still references its key
   * is a rule the render-milestone sweep will own.
   */
  app.post<{ Params: { id: string } }>("/edit-projects/:id/copy", async (request, reply) => {
    const project = await prisma.editProject.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      include: { assets: true },
    });
    if (!project) return reply.status(404).send({ error: "project not found" });

    const copy = await prisma.editProject.create({
      data: {
        clientId: project.clientId,
        name: `${project.name} copy`,
        doc: project.doc === null ? Prisma.DbNull : (project.doc as Prisma.InputJsonValue),
      },
    });
    if (project.assets.length) {
      await prisma.editAsset.createMany({
        data: project.assets.map((a) => ({
          projectId: copy.id,
          kind: a.kind,
          storageKey: a.storageKey,
          proxyKey: a.proxyKey,
          stripKey: a.stripKey,
          originalName: a.originalName,
          durationSec: a.durationSec,
          width: a.width,
          height: a.height,
          words: a.words === null ? Prisma.DbNull : (a.words as Prisma.InputJsonValue),
          status: a.status,
        })),
      });
    }
    return reply.status(201).send(copy);
  });

  // Rows only. The files under storage/<clientId>/edit/<projectId>/ stay put,
  // because a copy may share them; the sweep story lands with the render
  // milestone.
  app.delete<{ Params: { id: string } }>("/edit-projects/:id", async (request, reply) => {
    const { count } = await prisma.editProject.deleteMany({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!count) return reply.status(404).send({ error: "project not found" });
    return { ok: true };
  });

  /**
   * Start a render. The chosen settings are written into doc.export so the
   * worker reads one source of truth, then the job rides the edit queue and
   * progress is polled off the project row.
   */
  app.post<{ Params: { id: string } }>("/edit-projects/:id/render", async (request, reply) => {
    const project = await ownedProject(request.params.id, request.user.agencyId);
    if (!project) return reply.status(404).send({ error: "project not found" });
    const parsed = renderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "that export could not start",
        detail: parsed.error.issues[0]?.message ?? "The export settings are not right.",
      });
    }
    if (project.status === "rendering") {
      return reply.status(409).send({
        error: "already rendering",
        detail: "This project is rendering right now. Wait for it to finish.",
      });
    }
    if (project.doc === null || typeof project.doc !== "object") {
      return reply.status(400).send({
        error: "nothing to render",
        detail: "Add clips and make an edit before exporting.",
      });
    }

    const { name, resolution, fps, format, bitrateK } = parsed.data;
    await prisma.editProject.update({
      where: { id: project.id },
      data: {
        status: "rendering",
        renderPct: 0,
        renderError: null,
        doc: {
          ...(project.doc as Record<string, unknown>),
          // A concrete kbps number, so the worker never re-derives presets.
          export: { name, resolution, fps, format, bitrate: bitrateK },
        } as Prisma.InputJsonValue,
      },
    });
    await enqueue("edit", { editProjectId: project.id, job: "render" });
    return reply.status(202).send({ ok: true });
  });

  /**
   * The finished render becomes a normal MediaAsset, so Upload and Schedule,
   * quota counts and retention sweeps all see it as any other upload.
   */
  app.post<{ Params: { id: string } }>(
    "/edit-projects/:id/send-to-uploads",
    async (request, reply) => {
      const project = await ownedProject(request.params.id, request.user.agencyId);
      if (!project) return reply.status(404).send({ error: "project not found" });
      if (project.status !== "rendered" || !project.renderedKey) {
        return reply.status(409).send({
          error: "nothing rendered yet",
          detail: "Export the video first, then send the finished file to uploads.",
        });
      }

      const ext = path.extname(project.renderedKey) || ".mp4";
      const doc = project.doc as { export?: { name?: unknown } } | null;
      const base =
        typeof doc?.export?.name === "string" && doc.export.name.trim()
          ? doc.export.name.trim()
          : project.name;

      const asset = await prisma.mediaAsset.create({
        data: {
          clientId: project.clientId,
          originalName: `${base}${ext}`,
          storageKey: "pending",
          status: "uploaded",
        },
      });
      const storageKey = `${project.clientId}/${asset.id}/source${ext}`;
      try {
        await fs.mkdir(path.join(env.STORAGE_DIR, project.clientId, asset.id), {
          recursive: true,
        });
        await fs.copyFile(
          path.join(env.STORAGE_DIR, project.renderedKey),
          path.join(env.STORAGE_DIR, storageKey),
        );
      } catch (error) {
        await prisma.mediaAsset.delete({ where: { id: asset.id } });
        return reply.status(500).send({
          error: "could not copy the rendered file",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      const updated = await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { storageKey },
      });
      await enqueue("media", { assetId: asset.id });

      // The media assetView shape, for a just-uploaded video: everything the
      // pipeline has not made yet is null, same as any fresh upload.
      return reply.status(201).send({
        id: updated.id,
        clientId: updated.clientId,
        name: updated.originalName,
        kind: "video",
        slideCount: 0,
        durationSec: updated.durationSec,
        status: updated.status,
        hasTranscript: false,
        draftCopy: null,
        format: updated.format,
        isRevision: updated.isRevision,
        revisionOfId: updated.revisionOfId,
        createdAt: updated.createdAt,
        coverOffsetMs: updated.coverOffsetMs,
        thumbUrl: null,
        videoUrl: fileLink(storageKey),
        sourceDeletedAt: null,
      });
    },
  );

  /**
   * Pick whole sentences to cut so the video lands inside a length window.
   *
   * Button-gated: one inline model call per press, nothing runs on its own.
   * The model only ever sees what the operator's own clips say, and only
   * returns ranges that sit inside real spoken sentences. The cuts are
   * returned rather than applied, so the desktop can apply them through
   * update() and the operator can undo them like any other edit.
   */
  app.post<{ Params: { id: string } }>("/edit-projects/:id/shorten", async (request, reply) => {
    const parsed = shortenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "that window is not one of the choices",
        detail: parsed.error.issues[0]?.message ?? "Pick 10, 20 or 30 seconds.",
      });
    }
    if (!env.ANTHROPIC_API_KEY) {
      return reply.status(503).send({
        error: "shortening needs an Anthropic API key",
        detail: "Add ANTHROPIC_API_KEY to the repo root .env and restart the API.",
      });
    }
    const project = await prisma.editProject.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      include: { assets: true },
    });
    if (!project) return reply.status(404).send({ error: "project not found" });
    const doc = project.doc as unknown as EditDoc | null;
    if (!doc) {
      return reply.status(400).send({
        error: "nothing to shorten",
        detail: "Add clips and make an edit before shortening.",
      });
    }

    const minSec = parsed.data.targetSec;
    const maxSec = parsed.data.targetSec + 10;

    const clips = project.assets.filter((a) => a.kind === "clip");
    const durations: Record<string, number> = {};
    for (const a of clips) if (a.durationSec) durations[a.id] = a.durationSec;
    const edl = edlFromDoc(doc, durations);
    const total = outputDuration(edl);
    if (total <= minSec) {
      return reply.status(400).send({
        error: "already short enough",
        detail: `The video runs ${Math.round(total)}s, which is not longer than the ${minSec}s window.`,
      });
    }

    // The kept sentences with output times, in the order they play. Word
    // edits are applied by index so the model reads what the captions say.
    const lines: string[] = [];
    const spans: { assetId: string; start: number; end: number }[] = [];
    for (const { assetId } of doc.clips) {
      const asset = clips.find((a) => a.id === assetId);
      const raw = Array.isArray(asset?.words)
        ? (asset.words as { start: number; end: number; word: string }[])
        : [];
      if (!raw.length) continue;
      const edits = doc.wordEdits?.[assetId] ?? {};
      const words = raw.map((w, i) =>
        typeof edits[i] === "string" ? { ...w, word: edits[i] } : w,
      );
      for (const s of sentencesFromWords(words)) {
        const kept = s.words.filter((w) => toOutputTime(edl, assetId, w.start) !== null);
        if (!kept.length) continue;
        const srcStart = kept[0].start;
        const srcEnd = kept[kept.length - 1].end;
        const outStart = toOutputTime(edl, assetId, srcStart) ?? 0;
        spans.push({ assetId, start: srcStart, end: srcEnd });
        lines.push(
          `at ${outStart.toFixed(1)}s (assetId ${assetId}, start ${srcStart.toFixed(2)}, ` +
            `end ${srcEnd.toFixed(2)}): "${kept.map((w) => w.word).join(" ")}"`,
        );
      }
    }
    if (!lines.length) {
      return reply.status(400).send({
        error: "no spoken sentences to work with",
        detail: "Shortening cuts whole sentences, and no transcript words were found.",
      });
    }

    try {
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: env.SUGGESTIONS_MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: SHORTEN_SCHEMA },
        },
        system:
          "You shorten a short form video by cutting whole spoken sentences.\n\n" +
          "Rules:\n" +
          "- Cut whole sentences only. For each sentence you cut, return its " +
          "assetId, start and end exactly as given in the list.\n" +
          "- The cuts together must remove between MIN and MAX seconds, the " +
          "numbers given in the request.\n" +
          "- Keep the hook and the payoff: the opening that earns attention " +
          "and the line that pays it off both stay.\n" +
          "- Prefer cutting asides, repeats and filler over anything that " +
          "carries the story.",
        messages: [
          {
            role: "user",
            content:
              `The video runs ${total.toFixed(1)} seconds. Cut between ${minSec} and ` +
              `${maxSec} seconds of it.\n\nThe sentences, in the order they play:\n` +
              lines.join("\n"),
          },
        ],
      });
      if (response.stop_reason === "refusal") {
        return reply.status(502).send({
          error: "the model declined",
          detail: "The model refused to pick cuts for this one. Try again.",
        });
      }
      const block = response.content.find((c) => c.type === "text");
      const raw = JSON.parse(block && "text" in block ? block.text : "{}") as {
        cuts?: unknown[];
      };
      // Only ranges inside a real spoken sentence survive; the model cannot
      // invent a cut over footage nobody spoke in.
      const cuts = (raw.cuts ?? []).filter(
        (c): c is { assetId: string; start: number; end: number } => {
          if (typeof c !== "object" || c === null) return false;
          const { assetId, start, end } = c as Record<string, unknown>;
          return (
            typeof assetId === "string" &&
            typeof start === "number" &&
            typeof end === "number" &&
            start < end &&
            spans.some(
              (s) =>
                s.assetId === assetId && start >= s.start - 0.05 && end <= s.end + 0.05,
            )
          );
        },
      );
      return { cuts };
    } catch (error) {
      request.log.error({ err: error }, "shorten failed");
      return reply.status(502).send({
        error: "could not pick the cuts",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post<{ Params: { id: string }; Querystring: { kind?: string } }>(
    "/edit-projects/:id/assets",
    async (request, reply) => {
      const project = await ownedProject(request.params.id, request.user.agencyId);
      if (!project) return reply.status(404).send({ error: "project not found" });

      const kind = request.query.kind ?? "clip";
      if (!ASSET_KINDS.includes(kind as (typeof ASSET_KINDS)[number])) {
        return reply.status(400).send({
          error: "unknown asset kind",
          detail: "An editor source is a clip, audio, or a graphic.",
        });
      }

      const file = await request.file();
      if (!file) return reply.status(400).send({ error: "no file uploaded" });
      const ext = path.extname(file.filename ?? "") || ASSET_EXT_FALLBACK[kind];
      const originalName = file.filename ?? `upload${ext}`;

      const asset = await prisma.editAsset.create({
        data: {
          projectId: project.id,
          kind,
          storageKey: "pending",
          originalName,
          status: "uploaded",
        },
      });
      const storageKey = `${project.clientId}/edit/${project.id}/${asset.id}-source${ext}`;
      const dir = path.join(env.STORAGE_DIR, project.clientId, "edit", project.id);
      await fs.mkdir(dir, { recursive: true });
      await pipeline(file.file, createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
      if (file.file.truncated) {
        await fs.rm(path.join(env.STORAGE_DIR, storageKey), { force: true });
        await prisma.editAsset.delete({ where: { id: asset.id } });
        return reply.status(413).send({ error: "file too large" });
      }

      const updated = await prisma.editAsset.update({
        where: { id: asset.id },
        data: { storageKey },
      });
      await enqueue("edit", { editAssetId: asset.id });
      return reply.status(201).send(assetView(updated));
    },
  );

  app.delete<{ Params: { id: string } }>("/edit-assets/:id", async (request, reply) => {
    const asset = await prisma.editAsset.findFirst({
      where: { id: request.params.id, project: { client: { agencyId: request.user.agencyId } } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    await prisma.editAsset.delete({ where: { id: asset.id } });
    // Individual files, not the project directory: sibling assets live there.
    // A Save Copy sharing this key loses the file too; acceptable until the
    // render-milestone sweep owns reference counting.
    for (const key of [asset.storageKey, asset.proxyKey, asset.stripKey]) {
      if (key && key !== "pending") {
        await fs.rm(path.join(env.STORAGE_DIR, key), { force: true });
      }
    }
    return { ok: true };
  });
}
