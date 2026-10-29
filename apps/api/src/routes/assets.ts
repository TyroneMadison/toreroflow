import type { FastifyInstance } from "fastify";
import { MAX_VIDEO_UPLOAD_BYTES } from "../uploadLimits";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getPrisma } from "@toreroflow/db";
import { AssetQuerySchema, AssetSchema, type Asset } from "@toreroflow/contracts";
import { z } from "zod";
import { env } from "../env";
import { fileLink } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";

/**
 * The shared asset library. An asset belongs to one brand or, with no brand,
 * is shared by all of them. Inside a brand you see that brand's assets and the
 * shared ones, never another brand's; the agency-wide view sees everything.
 */

type AssetType = Asset["type"];
const MIME: Record<AssetType, Record<string, string>> = {
  logo: { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" },
  image: { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" },
  video: { "video/mp4": "mp4", "video/quicktime": "mov" },
  audio: { "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/aac": "aac" },
  template: { "application/json": "json", "application/zip": "zip", "image/png": "png", "image/jpeg": "jpg" },
};
export const MAX_BYTES: Record<AssetType, number> = {
  logo: 5 * 1024 * 1024,
  image: 50 * 1024 * 1024,
  template: 50 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  video: MAX_VIDEO_UPLOAD_BYTES,
};

/** The visibility and filter rules, pure so they are checked on their own. */
export function visible(a: { clientId: string | null; type: string }, q: z.infer<typeof AssetQuerySchema>): boolean {
  if (q.type && a.type !== q.type) return false;
  if (q.sharing === "shared" && a.clientId !== null) return false;
  if (q.sharing === "brand" && a.clientId === null) return false;
  if (q.brandId && a.clientId !== null && a.clientId !== q.brandId) return false;
  return true;
}

const view = (a: { id: string; clientId: string | null; type: string; name: string; storageKey: string; createdAt: Date }): Asset =>
  AssetSchema.parse({ id: a.id, brandId: a.clientId, type: a.type, name: a.name, url: fileLink(a.storageKey), createdAt: a.createdAt.toISOString() });

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  const isViewer = (request: { user: object }) => (request.user as { role?: string }).role === "viewer";

  app.get("/assets", async (request, reply) => {
    const q = AssetQuerySchema.parse(request.query);
    if (q.brandId) {
      const brand = await prisma.client.findFirst({ where: { id: q.brandId, agencyId: request.user.agencyId, deletedAt: null }, select: { id: true } });
      if (!brand) return reply.status(404).send({ error: "brand not found" });
    }
    // ponytail: filtered in memory over the agency's library; push into SQL past a few thousand assets.
    const rows = await prisma.libraryAsset.findMany({ where: { agencyId: request.user.agencyId }, orderBy: { createdAt: "desc" } });
    return { assets: rows.filter((a) => visible(a, q)).map(view) };
  });

  /** Multipart: fields type, name (optional) and brandId (empty = shared) before the file. */
  app.post("/assets", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot upload" });
    const file = await request.file({ limits: { fileSize: MAX_BYTES.video } });
    if (!file) return reply.status(400).send({ error: "no file uploaded" });
    const field = (k: string) => {
      const f = file.fields[k] as { value?: unknown } | undefined;
      return typeof f?.value === "string" ? f.value.trim() : "";
    };
    const type = AssetSchema.shape.type.safeParse(field("type"));
    if (!type.success) {
      file.file.resume();
      return reply.status(400).send({ error: "type must be logo, video, template, audio or image" });
    }
    const ext = MIME[type.data][file.mimetype];
    if (!ext) {
      file.file.resume();
      return reply.status(400).send({ error: `a ${type.data} cannot be ${file.mimetype}` });
    }
    const brandId = field("brandId") || null;
    if (brandId) {
      const brand = await prisma.client.findFirst({ where: { id: brandId, agencyId: request.user.agencyId, deletedAt: null }, select: { id: true } });
      if (!brand) {
        file.file.resume();
        return reply.status(404).send({ error: "brand not found" });
      }
    }
    const name = (field("name") || file.filename || `${type.data}.${ext}`).slice(0, 200);
    const asset = await prisma.libraryAsset.create({
      data: { agencyId: request.user.agencyId, clientId: brandId, type: type.data, name, storageKey: "", mimeType: file.mimetype },
    });
    const storageKey = `${brandId ?? `shared-${request.user.agencyId}`}/library/${asset.id}.${ext}`;
    const full = path.join(env.STORAGE_DIR, storageKey);
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Count while streaming so a type's own cap stops the write, not just the global one.
    let bytes = 0;
    let over = false;
    file.file.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES[type.data] && !over) {
        over = true;
        file.file.destroy(new Error("over"));
      }
    });
    try {
      await pipeline(file.file, createWriteStream(full));
    } catch (e) {
      if (!over) throw e;
    }
    if (over || file.file.truncated) {
      await fs.rm(full, { force: true });
      await prisma.libraryAsset.delete({ where: { id: asset.id } });
      return reply.status(413).send({ error: `a ${type.data} can be at most ${Math.round(MAX_BYTES[type.data] / 1024 / 1024)} MB` });
    }
    const saved = await prisma.libraryAsset.update({ where: { id: asset.id }, data: { storageKey, sizeBytes: bytes } });
    return reply.status(201).send(view(saved));
  });

  app.delete<{ Params: { id: string } }>("/assets/:id", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot delete" });
    const asset = await prisma.libraryAsset.findFirst({ where: { id: request.params.id, agencyId: request.user.agencyId } });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    // A kit pointing at a deleted logo shows no logo rather than a dead link.
    await prisma.brandKit.updateMany({ where: { logoAssetId: asset.id }, data: { logoAssetId: null } });
    await prisma.libraryAsset.delete({ where: { id: asset.id } });
    if (asset.storageKey) await fs.rm(path.join(env.STORAGE_DIR, asset.storageKey), { force: true });
    return { ok: true };
  });
}
