import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import { getPrisma, Prisma } from "@toreroflow/db";
import { env } from "../env";
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

const ASSET_KINDS = ["clip", "audio", "graphic"] as const;
const ASSET_EXT_FALLBACK: Record<string, string> = {
  clip: ".mp4",
  audio: ".mp3",
  graphic: ".png",
};

export async function editorRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const editQueue = new Queue<{ editAssetId: string }>("edit", { connection });

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
    return project;
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
      await editQueue.add("process", { editAssetId: asset.id });
      return reply.status(201).send(updated);
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
