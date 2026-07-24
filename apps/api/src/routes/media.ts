import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

const draftSchema = z.object({
  caption: z.string().max(4000).optional(),
  hook: z.string().max(500).optional(),
  hashtags: z.array(z.string().max(60)).max(20).optional(),
});

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const mediaQueue = new Queue<{ assetId: string }>("media", { connection });

  app.addHook("onRequest", requireAuth);

  const assetView = (a: {
    id: string;
    clientId: string;
    originalName: string;
    durationSec: number | null;
    status: string;
    transcript: unknown;
    draftCopy: unknown;
    createdAt: Date;
    renders: Array<{ storageKey: string; status: string; captionStyle: string | null }>;
  }) => {
    const ready = a.status === "ready";
    const render = a.renders.find((r) => r.status === "ready");
    return {
      id: a.id,
      clientId: a.clientId,
      name: a.originalName,
      durationSec: a.durationSec,
      status: a.status,
      hasCaptions: Array.isArray(a.transcript) && a.transcript.length > 0,
      draftCopy: a.draftCopy,
      createdAt: a.createdAt,
      thumbUrl: ready ? `/files/${a.clientId}/${a.id}/thumb.jpg` : null,
      renderUrl: render ? `/files/${render.storageKey}` : null,
      captionStyle: render?.captionStyle ?? null,
    };
  };

  app.post<{ Params: { id: string } }>("/clients/:id/media", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: {
        id: request.params.id,
        agencyId: request.user.agencyId,
        deletedAt: null,
      },
    });
    if (!client) return reply.status(404).send({ error: "client not found" });

    const file = await request.file();
    if (!file) return reply.status(400).send({ error: "no file uploaded" });

    const ext = path.extname(file.filename || ".mp4") || ".mp4";
    const asset = await prisma.mediaAsset.create({
      data: {
        clientId: client.id,
        originalName: file.filename ?? `upload${ext}`,
        storageKey: "pending",
        status: "uploaded",
      },
    });
    const storageKey = `${client.id}/${asset.id}/source${ext}`;
    const dir = path.join(env.STORAGE_DIR, client.id, asset.id);
    await fs.mkdir(dir, { recursive: true });
    await pipeline(file.file, createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
    if (file.file.truncated) {
      await fs.rm(dir, { recursive: true, force: true });
      await prisma.mediaAsset.delete({ where: { id: asset.id } });
      return reply.status(413).send({ error: "file too large" });
    }

    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { storageKey },
    });
    await mediaQueue.add("process", { assetId: asset.id });
    return reply
      .status(201)
      .send(assetView({ ...updated, renders: [] }));
  });

  app.get<{ Params: { id: string } }>("/clients/:id/media", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: {
        id: request.params.id,
        agencyId: request.user.agencyId,
        deletedAt: null,
      },
    });
    if (!client) return reply.status(404).send({ error: "client not found" });
    const assets = await prisma.mediaAsset.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: "desc" },
      include: { renders: true },
    });
    return assets.map(assetView);
  });

  app.get<{ Params: { id: string } }>("/media/:id", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId },
      },
      include: { renders: true },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    return assetView(asset);
  });

  app.patch<{ Params: { id: string } }>("/media/:id/draft", async (request, reply) => {
    const body = draftSchema.parse(request.body);
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId },
      },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    const current = (asset.draftCopy as Record<string, unknown> | null) ?? {};
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { draftCopy: { ...current, ...body } },
    });
    return { id: updated.id, draftCopy: updated.draftCopy };
  });

  app.delete<{ Params: { id: string } }>("/media/:id", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId },
      },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    await prisma.render.deleteMany({ where: { mediaAssetId: asset.id } });
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
    await fs.rm(path.join(env.STORAGE_DIR, asset.clientId, asset.id), {
      recursive: true,
      force: true,
    });
    return { ok: true };
  });
}
