import path from "node:path";
import { fileLink } from "../files/link";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import { decodeEscapes, looksLikeRevisionOf, MAX_CAROUSEL_SLIDES } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { extractThumbnail } from "@toreroflow/media";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

const revisionSchema = z.object({
  isRevision: z.boolean().optional(),
  revisionOfId: z.string().nullable().optional(),
  replaceScheduled: z.boolean().optional(),
});

const formatSchema = z.object({
  format: z.enum(["short_form", "long_form"]),
});

const draftSchema = z.object({
  /** The video's label in the app, and the fallback for the fields below. */
  name: z.string().max(300).optional(),
  /** The caption on Instagram, TikTok, Facebook and Snapchat. */
  description: z.string().max(4000).optional(),
  youtubeTitle: z.string().max(100).optional(),
  youtubeDescription: z.string().max(4000).optional(),
  hashtags: z.array(z.string().max(60)).max(20).optional(),
});

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const mediaQueue = new Queue<{ assetId: string }>("media", { connection });
  // Needed to drop the delayed jobs of posts a revision supersedes.
  const publishQueue = new Queue<{ targetId: string }>("publish", { connection });

  app.addHook("onRequest", requireAuth);

  /**
   * Present draft copy in the current shape. Older rows carry {hook, caption}
   * from before the rename, and rows from before the split carry a `title`
   * that meant "YouTube title and everyone's caption". Both map onto `name`,
   * which is the field that still feeds every platform when nothing more
   * specific was written, so nothing already drafted changes behavior.
   */
  const normalizeDraft = (draft: unknown): unknown => {
    if (!draft || typeof draft !== "object") return draft;
    const d = draft as Record<string, unknown>;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" ? decodeEscapes(v) : undefined;
    return {
      name: str(d.name) ?? str(d.title) ?? str(d.hook) ?? "",
      description: str(d.description) ?? str(d.caption) ?? "",
      youtubeTitle: str(d.youtubeTitle) ?? "",
      youtubeDescription: str(d.youtubeDescription) ?? "",
      hashtags: Array.isArray(d.hashtags)
        ? d.hashtags.map((h) => (typeof h === "string" ? decodeEscapes(h) : h))
        : [],
    };
  };

  const assetView = (a: {
    id: string;
    clientId: string;
    originalName: string;
    storageKey: string;
    durationSec: number | null;
    status: string;
    transcript: unknown;
    draftCopy: unknown;
    format: string | null;
    isRevision: boolean;
    revisionOfId: string | null;
    coverOffsetMs: number | null;
    coverKey: string | null;
    sourceDeletedAt?: Date | null;
    kind?: string;
    slideKeys?: unknown;
    createdAt: Date;
  }) => {
    const ready = a.status === "ready";
    return {
      id: a.id,
      clientId: a.clientId,
      name: a.originalName,
      /** video | carousel. A carousel has images instead of a duration. */
      kind: a.kind ?? "video",
      slideCount: Array.isArray(a.slideKeys) ? a.slideKeys.length : 0,
      durationSec: a.durationSec,
      status: a.status,
      hasTranscript: Array.isArray(a.transcript) && a.transcript.length > 0,
      draftCopy: normalizeDraft(a.draftCopy),
      format: a.format,
      isRevision: a.isRevision,
      revisionOfId: a.revisionOfId,
      createdAt: a.createdAt,
      coverOffsetMs: a.coverOffsetMs,
      // A carousel has no video to take a frame from, so its first slide is
      // its own thumbnail. Pointing at thumb.jpg would render a blank card.
      thumbUrl: ready
        ? a.kind === "carousel"
          ? fileLink(a.storageKey)
          : a.coverKey
            ? fileLink(a.coverKey)
            : fileLink(`${a.clientId}/${a.id}/thumb.jpg`)
        : null,
      // The original upload: nothing is re-encoded, so preview and publish
      // both use the file exactly as it was exported. Null once the file has
      // been cleared, a week after the post went live, so the app can say the
      // video is gone rather than hand the player a URL that 404s.
      videoUrl: a.sourceDeletedAt ? null : fileLink(a.storageKey),
      sourceDeletedAt: a.sourceDeletedAt ?? null,
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
    const originalName = file.filename ?? `upload${ext}`;

    // A re-export of an earlier upload ("… v2", "… final") is a revision, so
    // it should not spend another slot in the client's quota. Match against
    // the newest candidate; the operator can override either way.
    const siblings = await prisma.mediaAsset.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, originalName: true, revisionOfId: true },
    });
    const match = siblings.find((s) => looksLikeRevisionOf(originalName, s.originalName));
    // Point at the root upload, so a v3 matching v2 still refers to v1.
    const rootId = match ? (match.revisionOfId ?? match.id) : null;

    const asset = await prisma.mediaAsset.create({
      data: {
        clientId: client.id,
        originalName,
        storageKey: "pending",
        status: "uploaded",
        isRevision: rootId !== null,
        revisionOfId: rootId,
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
      .send(assetView(updated));
  });

  /**
   * A carousel: several images posted to Instagram as one post.
   *
   * Stored as one asset with an ordered list of image keys, so the calendar,
   * the queue and the scheduler reach it without learning a second kind of
   * thing. None of the video pipeline runs on it: there is no duration to
   * probe, no transcript to make, no cover to pick, and it is not a video, so
   * it never spends a slot in the client's video quota.
   *
   * The order files arrive in is the order Instagram shows them, and the first
   * one decides the aspect ratio of the whole post.
   */
  app.post<{ Params: { id: string } }>("/clients/:id/carousel", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
    });
    if (!client) return reply.status(404).send({ error: "client not found" });

    const asset = await prisma.mediaAsset.create({
      data: {
        clientId: client.id,
        kind: "carousel",
        originalName: "carousel",
        storageKey: "pending",
        // Ready on arrival: nothing has to happen to an image before it posts.
        status: "ready",
      },
    });
    const dir = path.join(env.STORAGE_DIR, client.id, asset.id);
    await fs.mkdir(dir, { recursive: true });

    const slideKeys: string[] = [];
    let firstName: string | null = null;
    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        const mime = part.mimetype;
        if (mime !== "image/jpeg" && mime !== "image/png") {
          throw new Error("a carousel takes JPG or PNG images");
        }
        if (slideKeys.length >= MAX_CAROUSEL_SLIDES) {
          throw new Error(`Instagram takes at most ${MAX_CAROUSEL_SLIDES} images in one carousel`);
        }
        const ext = mime === "image/png" ? ".png" : ".jpg";
        const key = `${client.id}/${asset.id}/slide-${slideKeys.length + 1}${ext}`;
        await pipeline(part.file, createWriteStream(path.join(env.STORAGE_DIR, key)));
        if (part.file.truncated) throw new Error("that image was too large");
        firstName ??= part.filename ?? null;
        slideKeys.push(key);
      }
      if (!slideKeys.length) throw new Error("no images uploaded");
    } catch (err) {
      // Nothing half-made survives: a carousel missing a slide would publish
      // silently short.
      await fs.rm(dir, { recursive: true, force: true });
      await prisma.mediaAsset.delete({ where: { id: asset.id } });
      return reply.status(400).send({
        error: "could not save that carousel",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        slideKeys,
        // The first image doubles as the asset's file, so every existing
        // screen that shows a thumbnail keeps working unchanged.
        storageKey: slideKeys[0]!,
        originalName: firstName ?? "carousel",
      },
    });
    return reply.status(201).send(assetView(updated));
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
    // The upload list means "not yet scheduled". A video leaves it once it
    // has a live post, and comes back on its own if that post is removed
    // from the queue, because removing a target deletes the row. A post
    // whose every target failed is not live: nothing was published, so the
    // operator can fix it and schedule again from the same card.
    const assets = await prisma.mediaAsset.findMany({
      where: {
        clientId: client.id,
        posts: {
          none: {
            deletedAt: null,
            targets: {
              some: { status: { in: ["scheduled", "publishing", "posted"] } },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return assets.map(assetView);
  });

  app.get<{ Params: { id: string } }>("/media/:id", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId },
      },
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

  const coverSchema = z.object({
    offsetMs: z.number().int().min(0).max(4 * 60 * 60 * 1000),
  });

  /**
   * Choose a frame of the video as the cover. The frame is extracted to
   * cover.jpg beside the source; every platform that accepts a custom
   * cover gets this image at publish, and the app's thumbnails switch to
   * it so what the operator sees is what posts.
   */
  app.patch<{ Params: { id: string } }>("/media/:id/cover", async (request, reply) => {
    const body = coverSchema.parse(request.body ?? {});
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    if (asset.status !== "ready") {
      return reply.status(409).send({ error: "asset is still processing" });
    }
    const source = path.join(env.STORAGE_DIR, asset.storageKey);
    const coverKey = `${asset.clientId}/${asset.id}/cover.jpg`;
    await extractThumbnail(source, path.join(env.STORAGE_DIR, coverKey), body.offsetMs / 1000);
    // An uploaded .png cover may linger from before; the frame pick owns
    // the pointer now, so remove the stale file too.
    await fs.rm(path.join(env.STORAGE_DIR, `${asset.clientId}/${asset.id}/cover.png`), {
      force: true,
    });
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { coverOffsetMs: body.offsetMs, coverKey },
    });
    return assetView(updated);
  });

  /** Upload an image as the cover instead of picking a frame. */
  app.post<{ Params: { id: string } }>("/media/:id/cover-image", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: "no file uploaded" });
    const mime = file.mimetype;
    if (mime !== "image/jpeg" && mime !== "image/png") {
      return reply.status(400).send({ error: "cover must be a JPEG or PNG" });
    }
    const ext = mime === "image/png" ? ".png" : ".jpg";
    const coverKey = `${asset.clientId}/${asset.id}/cover${ext}`;
    await pipeline(
      file.file,
      createWriteStream(path.join(env.STORAGE_DIR, coverKey)),
    );
    if (file.file.truncated) {
      await fs.rm(path.join(env.STORAGE_DIR, coverKey), { force: true });
      return reply.status(413).send({ error: "file too large" });
    }
    // Remove the other-extension cover so exactly one exists.
    const other = path.join(
      env.STORAGE_DIR,
      `${asset.clientId}/${asset.id}/cover${ext === ".jpg" ? ".png" : ".jpg"}`,
    );
    await fs.rm(other, { force: true });
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { coverOffsetMs: null, coverKey },
    });
    return assetView(updated);
  });

  /** Back to the automatic thumbnail. */
  app.delete<{ Params: { id: string } }>("/media/:id/cover", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    for (const ext of [".jpg", ".png"]) {
      await fs.rm(
        path.join(env.STORAGE_DIR, `${asset.clientId}/${asset.id}/cover${ext}`),
        { force: true },
      );
    }
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { coverOffsetMs: null, coverKey: null },
    });
    return assetView(updated);
  });

  /**
   * Flip a video between counting toward the quota and being a revision.
   *
   * With `replaceScheduled`, the posts still queued for the video this one
   * revises are cancelled, so the new cut takes over the slot instead of
   * both going out. Only unpublished posts are touched.
   */
  app.patch<{
    Params: { id: string };
    Body: { isRevision?: boolean; revisionOfId?: string | null; replaceScheduled?: boolean };
  }>("/media/:id/revision", async (request, reply) => {
    const body = revisionSchema.parse(request.body ?? {});
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });

    const isRevision = body.isRevision ?? !asset.isRevision;
    const revisionOfId =
      body.revisionOfId !== undefined ? body.revisionOfId : (asset.revisionOfId ?? null);

    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { isRevision, revisionOfId: isRevision ? revisionOfId : null },
    });

    let cancelled = 0;
    if (isRevision && body.replaceScheduled && revisionOfId) {
      const stale = await prisma.postTarget.findMany({
        where: {
          post: { mediaAssetId: revisionOfId },
          status: { in: ["scheduled", "failed"] },
        },
      });
      for (const target of stale) {
        const job = await publishQueue.getJob(target.id);
        if (job) await job.remove();
      }
      const ids = stale.map((t) => t.id);
      if (ids.length) {
        await prisma.postTarget.deleteMany({ where: { id: { in: ids } } });
        cancelled = ids.length;
        // Drop posts left with no targets at all.
        const orphans = await prisma.post.findMany({
          where: { mediaAssetId: revisionOfId, targets: { none: {} } },
          select: { id: true },
        });
        if (orphans.length) {
          await prisma.post.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
        }
      }
    }

    return { ...assetView(updated), cancelledPosts: cancelled };
  });

  /**
   * Reclassify a video as short or long form. Duration is only a guess at
   * intent, so the operator gets the final say on which quota it spends.
   */
  app.patch<{ Params: { id: string }; Body: { format: string } }>(
    "/media/:id/format",
    async (request, reply) => {
      const body = formatSchema.parse(request.body ?? {});
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      });
      if (!asset) return reply.status(404).send({ error: "asset not found" });
      const updated = await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { format: body.format },
      });
      return assetView(updated);
    },
  );

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
