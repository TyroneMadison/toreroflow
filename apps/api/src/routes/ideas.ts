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

/**
 * The ideas list, the niche profile, and the files side of the knowledge base.
 *
 * KnowledgeNote routes stay in carousels.ts; these are the dropped files whose
 * contents the knowledge worker extracts once, on drop.
 */

const IDEA_STATUSES = ["idea", "scripting", "ready", "posted", "analyzed"] as const;

const ideaCreateSchema = z.object({
  text: z.string().min(1).max(500),
  hook: z.string().max(500).optional(),
  formatName: z.string().max(120).optional(),
  niche: z.string().max(200).optional(),
  source: z.enum(["brainstorm", "analysis", "overview", "custom"]).optional(),
});

const ideaPatchSchema = z.object({
  status: z.enum(IDEA_STATUSES).optional(),
  text: z.string().min(1).max(500).optional(),
  hook: z.string().max(500).optional(),
});

const nicheProfileSchema = z.object({
  niche: z.string().max(2000),
  audience: z.string().max(2000).optional(),
  outcome: z.string().max(2000).optional(),
  voiceTags: z.array(z.string().max(60)).max(20).optional(),
  filming: z.array(z.string().max(60)).max(20).optional(),
  faceless: z.boolean().optional(),
});

const KNOWLEDGE_KINDS: Record<string, string> = {
  ".pdf": "pdf",
  ".txt": "text",
  ".md": "text",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
};

export async function ideasRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const knowledgeQueue = new Queue<{ knowledgeFileId: string }>("knowledge", { connection });

  app.addHook("onRequest", requireAuth);

  /** Confirms the client belongs to the operator's workspace before anything else. */
  const ownedClient = async (clientId: string, agencyId: string) =>
    prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
      select: { id: true },
    });

  /* ---- ideas ---- */

  app.get<{ Params: { clientId: string }; Querystring: { status?: string; q?: string } }>(
    "/clients/:clientId/ideas",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const { status, q } = request.query;
      return prisma.contentIdea.findMany({
        where: {
          clientId: client.id,
          ...(status ? { status } : {}),
          ...(q
            ? {
                OR: [
                  { text: { contains: q, mode: "insensitive" } },
                  { hook: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
    },
  );

  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/ideas",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const parsed = ideaCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "that idea could not be saved",
          detail: parsed.error.issues[0]?.message ?? "An idea is a line of text, up to 500 characters.",
        });
      }
      return reply.status(201).send(
        await prisma.contentIdea.create({
          data: { clientId: client.id, ...parsed.data },
        }),
      );
    },
  );

  app.patch<{ Params: { id: string } }>("/ideas/:id", async (request, reply) => {
    const existing = await prisma.contentIdea.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!existing) return reply.status(404).send({ error: "idea not found" });
    const parsed = ideaPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "that change could not be saved",
        detail: parsed.error.issues[0]?.message ?? "An idea's status is one of the five on the board.",
      });
    }
    return prisma.contentIdea.update({ where: { id: existing.id }, data: parsed.data });
  });

  app.delete<{ Params: { id: string } }>("/ideas/:id", async (request, reply) => {
    const { count } = await prisma.contentIdea.deleteMany({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!count) return reply.status(404).send({ error: "idea not found" });
    return { ok: true };
  });

  /* ---- the niche profile ---- */

  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/niche-profile",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.clientId, agencyId: request.user.agencyId, deletedAt: null },
        select: { nicheProfile: true },
      });
      if (!client) return reply.status(404).send({ error: "brand not found" });
      return { nicheProfile: client.nicheProfile };
    },
  );

  // PUT rather than PATCH: the form submits the whole profile every time.
  app.put<{ Params: { clientId: string } }>(
    "/clients/:clientId/niche-profile",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const parsed = nicheProfileSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "that profile could not be saved",
          detail: parsed.error.issues[0]?.message ?? "The niche is a short description, up to 2000 characters.",
        });
      }
      const updated = await prisma.client.update({
        where: { id: client.id },
        data: { nicheProfile: parsed.data },
        select: { nicheProfile: true },
      });
      return { nicheProfile: updated.nicheProfile };
    },
  );

  /* ---- knowledge files ---- */

  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/knowledge-files",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      return prisma.knowledgeFile.findMany({
        where: { clientId: client.id },
        // The extracted text is prompt fodder for the workers, not something
        // the list screen renders, and a dropped PDF's worth of it per row
        // would bloat every refresh.
        select: { id: true, name: true, kind: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
    },
  );

  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/knowledge-files",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });

      const file = await request.file();
      if (!file) return reply.status(400).send({ error: "no file uploaded" });
      const ext = path.extname(file.filename ?? "").toLowerCase();
      const name = file.filename ?? `file${ext}`;

      const row = await prisma.knowledgeFile.create({
        data: {
          clientId: client.id,
          name,
          kind: KNOWLEDGE_KINDS[ext] ?? "other",
          storageKey: "pending",
          status: "processing",
        },
      });
      const storageKey = `${client.id}/knowledge/${row.id}${ext}`;
      await fs.mkdir(path.join(env.STORAGE_DIR, client.id, "knowledge"), { recursive: true });
      await pipeline(file.file, createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
      if (file.file.truncated) {
        await fs.rm(path.join(env.STORAGE_DIR, storageKey), { force: true });
        await prisma.knowledgeFile.delete({ where: { id: row.id } });
        return reply.status(413).send({ error: "file too large" });
      }

      const updated = await prisma.knowledgeFile.update({
        where: { id: row.id },
        data: { storageKey },
      });
      await knowledgeQueue.add("extract", { knowledgeFileId: row.id });
      return reply.status(201).send(updated);
    },
  );

  app.delete<{ Params: { clientId: string; fileId: string } }>(
    "/clients/:clientId/knowledge-files/:fileId",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const row = await prisma.knowledgeFile.findFirst({
        where: { id: request.params.fileId, clientId: client.id },
      });
      if (!row) return reply.status(404).send({ error: "file not found" });
      await prisma.knowledgeFile.delete({ where: { id: row.id } });
      if (row.storageKey !== "pending") {
        await fs.rm(path.join(env.STORAGE_DIR, row.storageKey), { force: true });
      }
      return { ok: true };
    },
  );
}
