import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { env } from "../env";
import { fileLinkVersioned } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";

/**
 * The AI video analyzer.
 *
 * One VideoAnalysis row per run: dropped files land under
 * storage/<clientId>/analysis/<id>/, existing uploads are analyzed in place
 * through mediaAssetId. The worker owns everything after the 201.
 */

// The multipart plugin's global limit is 4GB for editor sources; the analyzer
// caps at 500MB on its own, so the cap is enforced by counting the bytes as
// they stream.
const MAX_ANALYSIS_BYTES = 500 * 1024 * 1024;

const fromMediaSchema = z.object({
  mediaAssetId: z.string().min(1),
});

export async function analysisRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const analyzeQueue = new Queue<{ analysisId: string }>("analyze", { connection });

  app.addHook("onRequest", requireAuth);

  /** Confirms the client belongs to the operator's workspace before anything else. */
  const ownedClient = async (clientId: string, agencyId: string) =>
    prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
      select: { id: true },
    });

  const analysisView = (a: {
    id: string;
    name: string;
    status: string;
    durationSec: number | null;
    thumbKey: string | null;
    requestedAt: Date;
    completedAt: Date | null;
  }) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    durationSec: a.durationSec,
    thumbUrl: a.thumbKey
      ? fileLinkVersioned(a.thumbKey, a.completedAt ? a.completedAt.getTime() : null)
      : null,
    requestedAt: a.requestedAt,
    completedAt: a.completedAt,
  });

  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/analyses",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const analyses = await prisma.videoAnalysis.findMany({
        where: { clientId: client.id },
        orderBy: { requestedAt: "desc" },
      });
      return analyses.map(analysisView);
    },
  );

  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/analyses",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });

      const file = await request.file();
      if (!file) return reply.status(400).send({ error: "no file uploaded" });
      const ext = path.extname(file.filename ?? "") || ".mp4";

      const analysis = await prisma.videoAnalysis.create({
        data: {
          clientId: client.id,
          name: file.filename ?? `video${ext}`,
          status: "running",
        },
      });
      const storageKey = `${client.id}/analysis/${analysis.id}/source${ext}`;
      const dir = path.join(env.STORAGE_DIR, client.id, "analysis", analysis.id);
      await fs.mkdir(dir, { recursive: true });

      let bytes = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          bytes += chunk.length;
          if (bytes > MAX_ANALYSIS_BYTES) return done(new Error("over the analyzer cap"));
          done(null, chunk);
        },
      });
      try {
        await pipeline(file.file, cap, createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
        if (file.file.truncated) throw new Error("over the multipart limit");
      } catch {
        await fs.rm(dir, { recursive: true, force: true });
        await prisma.videoAnalysis.delete({ where: { id: analysis.id } });
        return reply.status(413).send({
          error: "file too large",
          detail: "The analyzer takes videos up to 500MB.",
        });
      }

      const updated = await prisma.videoAnalysis.update({
        where: { id: analysis.id },
        data: { storageKey },
      });
      await analyzeQueue.add("analyze", { analysisId: analysis.id });
      return reply.status(201).send(analysisView(updated));
    },
  );

  /** Analyze a video already uploaded, without a second copy of the file. */
  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/analyses/from-media",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const parsed = fromMediaSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "nothing to analyze",
          detail: parsed.error.issues[0]?.message ?? "Pick an uploaded video.",
        });
      }
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: parsed.data.mediaAssetId, clientId: client.id },
      });
      if (!asset) return reply.status(404).send({ error: "asset not found" });
      if (asset.sourceDeletedAt) {
        return reply.status(404).send({
          error: "that video's file is gone",
          detail: "Its source was cleared after it posted, so there is nothing left to analyze.",
        });
      }

      const analysis = await prisma.videoAnalysis.create({
        data: {
          clientId: client.id,
          mediaAssetId: asset.id,
          name: asset.originalName,
          durationSec: asset.durationSec,
          status: "running",
        },
      });
      await analyzeQueue.add("analyze", { analysisId: analysis.id });
      return reply.status(201).send(analysisView(analysis));
    },
  );

  app.get<{ Params: { id: string } }>("/analyses/:id", async (request, reply) => {
    const analysis = await prisma.videoAnalysis.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!analysis) return reply.status(404).send({ error: "analysis not found" });
    return { ...analysis, ...analysisView(analysis) };
  });

  app.delete<{ Params: { id: string } }>("/analyses/:id", async (request, reply) => {
    const analysis = await prisma.videoAnalysis.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!analysis) return reply.status(404).send({ error: "analysis not found" });
    await prisma.videoAnalysis.delete({ where: { id: analysis.id } });
    // Every run keeps its files (dropped source, thumb) under its own
    // directory; from-media runs never touch the upload they point at.
    await fs.rm(path.join(env.STORAGE_DIR, analysis.clientId, "analysis", analysis.id), {
      recursive: true,
      force: true,
    });
    return { ok: true };
  });
}
