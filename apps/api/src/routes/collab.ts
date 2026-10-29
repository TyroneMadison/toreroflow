import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { Prisma, enqueue, getPrisma } from "@toreroflow/db";
import {
  commentMarkers,
  defaultAutoImport,
  edlFromDoc,
  edlToFcpxml,
  edlToPremiereXml,
  isChannelId,
  isPexelsMediaUrl,
  isPlaylistId,
  migrateDoc,
  openCommentCount,
  outputDuration,
  outputSize,
  pickPexelsFile,
  readAutoImport,
  safeFileName,
  threadComments,
  toTsQuery,
  type EditDoc,
} from "@toreroflow/core";
import { env } from "../env";
import { fileLink, fileLinkVersioned } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";
import { clientIp, rateLimiter } from "../ideas/rateLimit";
import { actorName, logActivity } from "../collab/activity";
import { assetView } from "./editor";

/**
 * Phase 8, Collaboration & distribution: timestamped comments, signed
 * review links, collections and favorites, team activity, clip
 * performance, YouTube auto-import settings, NLE XML export, cross-project
 * clip search and Pexels b-roll import. Drive import sits in clips.ts,
 * next to the clip-job helpers it reuses.
 */

const bad = (detail: string, error = "that request was not right") => ({ error, detail });

export function reviewToken(id: string, expiresAt: Date, secret = env.JWT_SECRET): string {
  const sig = createHmac("sha256", secret).update(`review|${id}|${expiresAt.getTime()}`).digest("base64url");
  return `${id}.${sig}`;
}

const reviewView = (l: { id: string; expiresAt: Date; revokedAt: Date | null; createdAt: Date }) => ({
  id: l.id,
  url: `/v/${reviewToken(l.id, l.expiresAt)}`,
  expiresAt: l.expiresAt.toISOString(),
  revokedAt: l.revokedAt?.toISOString() ?? null,
  createdAt: l.createdAt.toISOString(),
});

const commentBody = z.object({
  body: z.string().trim().min(1, "Write something first.").max(2000),
  atSec: z.number().min(0).max(36_000).nullable().optional(),
  parentId: z.string().max(40).nullable().optional(),
});

const commentView = (c: { id: string; parentId: string | null; atSec: number | null; body: string; authorName: string; authorKind: string; resolvedAt: Date | null; createdAt: Date }) => ({
  id: c.id, parentId: c.parentId, atSec: c.atSec, body: c.body, authorName: c.authorName, authorKind: c.authorKind,
  resolvedAt: c.resolvedAt?.toISOString() ?? null, createdAt: c.createdAt.toISOString(),
});

async function projectDurations(projectId: string) {
  const assets = await getPrisma().editAsset.findMany({ where: { projectId }, select: { id: true, durationSec: true, originalName: true } });
  const durations: Record<string, number> = {};
  for (const a of assets) if (a.durationSec) durations[a.id] = a.durationSec;
  return { assets, durations };
}

/** Comments as the panel and the review page read them. */
async function commentsFor(projectId: string, doc: unknown) {
  const prisma = getPrisma();
  const rows = (await prisma.editComment.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } })).map(commentView);
  const threads = threadComments(rows);
  let duration = 0;
  if (doc) {
    const { durations } = await projectDurations(projectId);
    duration = outputDuration(edlFromDoc(migrateDoc(doc as EditDoc), durations));
  }
  return { threads, open: openCommentCount(threads), markers: commentMarkers(threads, duration || 36_000) };
}

export async function collabRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  const isViewer = (request: { user: object }) => (request.user as { role?: string }).role === "viewer";

  const ownedProject = (id: string, agencyId: string) => prisma.editProject.findFirst({ where: { id, client: { agencyId } } });
  const ownedClient = (id: string, agencyId: string) =>
    prisma.client.findFirst({ where: { id, agencyId, deletedAt: null }, select: { id: true, autoImport: true } });
  const ownedCandidate = (id: string, agencyId: string) =>
    prisma.clipCandidate.findFirst({ where: { id, job: { client: { agencyId } } }, include: { job: { select: { clientId: true } } } });

  // ---------- comments ----------

  app.get<{ Params: { id: string } }>("/edit-projects/:id/comments", async (request, reply) => {
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send(bad("No such project in this workspace.", "project not found"));
    return commentsFor(p.id, p.doc);
  });

  app.post<{ Params: { id: string } }>("/edit-projects/:id/comments", async (request, reply) => {
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send(bad("No such project in this workspace.", "project not found"));
    const parsed = commentBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the comment."));
    const { body, atSec, parentId } = parsed.data;
    if (parentId) {
      const root = await prisma.editComment.findFirst({ where: { id: parentId, projectId: p.id, parentId: null } });
      if (!root) return reply.status(404).send(bad("That thread is gone.", "comment not found"));
    }
    const c = await prisma.editComment.create({
      data: {
        projectId: p.id, parentId: parentId ?? null, atSec: parentId ? null : (atSec ?? null), body,
        authorName: await actorName(request), authorKind: "team", userId: request.user.bot ? null : request.user.sub,
      },
    });
    logActivity(request, { clientId: p.clientId, action: parentId ? "replied" : "commented", projectId: p.id, detail: body });
    return reply.status(201).send(commentView(c));
  });

  app.patch<{ Params: { id: string } }>("/edit-comments/:id", async (request, reply) => {
    const c = await prisma.editComment.findFirst({ where: { id: request.params.id, project: { client: { agencyId: request.user.agencyId } } }, include: { project: { select: { clientId: true } } } });
    if (!c) return reply.status(404).send(bad("That comment is gone.", "comment not found"));
    const parsed = z.object({ resolved: z.boolean().optional(), body: z.string().trim().min(1).max(2000).optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the change."));
    const { resolved, body } = parsed.data;
    const u = await prisma.editComment.update({
      where: { id: c.id },
      data: { ...(body != null ? { body } : {}), ...(resolved != null ? { resolvedAt: resolved ? new Date() : null } : {}) },
    });
    if (resolved != null) logActivity(request, { clientId: c.project.clientId, action: resolved ? "resolved" : "reopened", projectId: c.projectId, detail: c.body });
    return commentView(u);
  });

  app.delete<{ Params: { id: string } }>("/edit-comments/:id", async (request, reply) => {
    const c = await prisma.editComment.findFirst({ where: { id: request.params.id, project: { client: { agencyId: request.user.agencyId } } } });
    if (!c) return reply.status(404).send(bad("That comment is gone.", "comment not found"));
    await prisma.editComment.delete({ where: { id: c.id } });
    return { ok: true };
  });

  // ---------- review links ----------

  app.post<{ Params: { id: string } }>("/edit-projects/:id/review-links", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send(bad("Viewers cannot share edits.", "not allowed"));
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send(bad("No such project in this workspace.", "project not found"));
    const parsed = z.object({ expiresInHours: z.number().int().min(1).max(24 * 30).default(24 * 7) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad("Links last 1 hour to 30 days."));
    const link = await prisma.reviewLink.create({
      data: {
        projectId: p.id,
        createdById: request.user.bot ? `bot:${request.user.bot}` : request.user.sub,
        expiresAt: new Date(Date.now() + parsed.data.expiresInHours * 3600_000),
      },
    });
    logActivity(request, { clientId: p.clientId, action: "review_link", projectId: p.id, detail: p.name });
    return reply.status(201).send(reviewView(link));
  });

  app.get<{ Params: { id: string } }>("/edit-projects/:id/review-links", async (request, reply) => {
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send(bad("No such project in this workspace.", "project not found"));
    const links = await prisma.reviewLink.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "desc" } });
    return { links: links.map(reviewView) };
  });

  app.delete<{ Params: { id: string } }>("/review-links/:id", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send(bad("Viewers cannot change links.", "not allowed"));
    const l = await prisma.reviewLink.findFirst({ where: { id: request.params.id, project: { client: { agencyId: request.user.agencyId } } } });
    if (!l) return reply.status(404).send(bad("No such link.", "link not found"));
    if (!l.revokedAt) await prisma.reviewLink.update({ where: { id: l.id }, data: { revokedAt: new Date() } });
    return { ok: true };
  });

  // ---------- NLE export ----------

  app.get<{ Params: { id: string }; Querystring: { format?: string; json?: string } }>("/edit-projects/:id/export-xml", async (request, reply) => {
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send(bad("No such project in this workspace.", "project not found"));
    if (!p.doc) return reply.status(400).send(bad("Make an edit first.", "nothing to export"));
    const fcp = request.query.format === "fcpxml";
    const doc = migrateDoc(p.doc as unknown as EditDoc);
    const { assets, durations } = await projectDurations(p.id);
    const segments = edlFromDoc(doc, durations);
    if (!segments.length) return reply.status(400).send(bad("The edit has no footage left after cuts.", "nothing to export"));
    const size = outputSize(doc.output.aspect, 1080);
    const input = {
      name: p.name, fps: 30, width: size.width, height: size.height, segments,
      assets: Object.fromEntries(assets.map((a) => [a.id, { name: safeFileName(a.originalName), durationSec: a.durationSec ?? 0 }])),
    };
    const text = fcp ? edlToFcpxml(input) : edlToPremiereXml(input);
    const base = (p.name || "edit").replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "edit";
    const fileName = `${base}${fcp ? ".fcpxml" : ".xml"}`;
    if (request.query.json) return { fileName, text };
    return reply.header("content-type", "application/xml; charset=utf-8").header("content-disposition", `attachment; filename="${fileName}"`).send(text);
  });

  // ---------- Pexels b-roll import ----------

  /**
   * Downloads one Pexels video into the project as a clip asset; the
   * desktop then fills the spot (fillBrollSpot) so it renders like any
   * b-roll item. The file URL comes from Pexels' own API by id, never
   * from the caller, and must be on a Pexels host.
   */
  app.post<{ Params: { id: string } }>("/edit-projects/:id/broll/stock-import", async (request, reply) => {
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send(bad("No such project in this workspace.", "project not found"));
    if (!env.PEXELS_API_KEY) return reply.status(503).send(bad("Add PEXELS_API_KEY to the repo root .env and restart the API.", "stock search is off"));
    const parsed = z.object({ pexelsId: z.number().int().positive(), portrait: z.boolean().default(true) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad("Pick a stock result."));
    const meta = await fetch(`${env.PEXELS_API_BASE}/videos/videos/${parsed.data.pexelsId}`, { headers: { Authorization: env.PEXELS_API_KEY }, signal: AbortSignal.timeout(15_000) });
    if (!meta.ok) return reply.status(502).send(bad(`Pexels answered ${meta.status}.`, "stock lookup failed"));
    const v = (await meta.json()) as { id: number; user?: { name?: string }; video_files?: { link: string; width: number; height: number; quality?: string; file_type?: string }[] };
    const extra = process.env.PEXELS_EXTRA_MEDIA_ORIGIN; // ponytail: the e2e stub's origin only, unset in real use
    const okUrl = (u: string) => isPexelsMediaUrl(u) || (!!extra && u.startsWith(`${extra}/`));
    const pick = pickPexelsFile(v.video_files ?? [], parsed.data.portrait, 1920, okUrl);
    if (!pick) return reply.status(422).send(bad("That result has no downloadable mp4 on a Pexels host.", "no file"));
    const url = pick.link;
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body || !okUrl(res.url || url)) return reply.status(502).send(bad(`The download answered ${res.status}.`, "download failed"));
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > 400 * 1024 * 1024) return reply.status(413).send(bad("That stock file is over 400 MB.", "file too large"));
    const originalName = `pexels-${v.id}${v.user?.name ? `-${safeFileName(v.user.name).replace(/\s+/g, "-")}` : ""}.mp4`;
    const asset = await prisma.editAsset.create({ data: { projectId: p.id, kind: "clip", storageKey: "pending", originalName, status: "uploaded" } });
    const storageKey = `${p.clientId}/edit/${p.id}/${asset.id}-source.mp4`;
    await fs.mkdir(path.join(env.STORAGE_DIR, p.clientId, "edit", p.id), { recursive: true });
    try {
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
    } catch {
      await fs.rm(path.join(env.STORAGE_DIR, storageKey), { force: true });
      await prisma.editAsset.delete({ where: { id: asset.id } });
      return reply.status(502).send(bad("The download stopped part way.", "download failed"));
    }
    const updated = await prisma.editAsset.update({ where: { id: asset.id }, data: { storageKey } });
    // ponytail: "b-roll" processing is the normal clip pipeline (proxy, strip, words); the words are unused.
    await enqueue("edit", { editAssetId: asset.id });
    return reply.status(201).send({ asset: assetView({ ...updated, words: null }), credit: v.user?.name ?? null });
  });

  // ---------- favorites & collections ----------

  app.post<{ Params: { id: string } }>("/clip-candidates/:id/favorite", async (request, reply) => {
    const c = await ownedCandidate(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(bad("No such clip.", "clip not found"));
    const on = (request.body as { on?: unknown } | undefined)?.on !== false;
    await prisma.clipCandidate.update({ where: { id: c.id }, data: { favorite: on } });
    logActivity(request, { clientId: c.job.clientId, action: on ? "favorited" : "unfavorited", candidateId: c.id, jobId: c.jobId, detail: c.title });
    return { id: c.id, favorite: on };
  });

  app.get<{ Params: { clientId: string } }>("/clients/:clientId/collections", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    const [cols, favorites] = await Promise.all([
      prisma.clipCollection.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "asc" }, include: { _count: { select: { items: true } } } }),
      prisma.clipCandidate.count({ where: { favorite: true, job: { clientId: client.id } } }),
    ]);
    return { favorites, collections: cols.map((c) => ({ id: c.id, name: c.name, count: c._count.items })) };
  });

  app.post<{ Params: { clientId: string } }>("/clients/:clientId/collections", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    const parsed = z.object({ name: z.string().trim().min(1, "Name the collection.").max(60) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Name the collection."));
    try {
      const c = await prisma.clipCollection.create({ data: { clientId: client.id, name: parsed.data.name } });
      return reply.status(201).send({ id: c.id, name: c.name, count: 0 });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return reply.status(409).send(bad("A collection with that name exists.", "name taken"));
      throw e;
    }
  });

  const ownedCollection = (id: string, agencyId: string) => prisma.clipCollection.findFirst({ where: { id, client: { agencyId } } });

  app.patch<{ Params: { id: string } }>("/collections/:id", async (request, reply) => {
    const c = await ownedCollection(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(bad("No such collection.", "collection not found"));
    const parsed = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad("Name the collection."));
    const u = await prisma.clipCollection.update({ where: { id: c.id }, data: { name: parsed.data.name } }).catch(() => null);
    if (!u) return reply.status(409).send(bad("A collection with that name exists.", "name taken"));
    return { id: u.id, name: u.name };
  });

  app.delete<{ Params: { id: string } }>("/collections/:id", async (request, reply) => {
    const c = await ownedCollection(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(bad("No such collection.", "collection not found"));
    await prisma.clipCollection.delete({ where: { id: c.id } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/collections/:id/items", async (request, reply) => {
    const c = await ownedCollection(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(bad("No such collection.", "collection not found"));
    const parsed = z.object({ candidateIds: z.array(z.string().max(40)).min(1).max(100) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad("Pick clips to add."));
    const cands = await prisma.clipCandidate.findMany({ where: { id: { in: parsed.data.candidateIds }, job: { clientId: c.clientId } }, select: { id: true, title: true, jobId: true } });
    if (!cands.length) return reply.status(404).send(bad("Those clips are not in this brand.", "clip not found"));
    await prisma.clipCollectionItem.createMany({ data: cands.map((x) => ({ collectionId: c.id, candidateId: x.id })), skipDuplicates: true });
    for (const x of cands) logActivity(request, { clientId: c.clientId, action: "collected", candidateId: x.id, jobId: x.jobId, detail: `${x.title} → ${c.name}` });
    return { added: cands.length };
  });

  app.delete<{ Params: { id: string; candidateId: string } }>("/collections/:id/items/:candidateId", async (request, reply) => {
    const c = await ownedCollection(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(bad("No such collection.", "collection not found"));
    await prisma.clipCollectionItem.deleteMany({ where: { collectionId: c.id, candidateId: request.params.candidateId } });
    return { ok: true };
  });

  // ---------- search, favorites & collection listing ----------

  /**
   * Cross-project clip search over title + transcript (Postgres full-text,
   * prefix terms, ranked), optionally only favorites or one collection.
   * With no query it lists the filter's clips newest first.
   */
  app.get<{ Params: { clientId: string }; Querystring: { q?: string; favorites?: string; collectionId?: string; limit?: string } }>(
    "/clients/:clientId/clip-search",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
      const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
      const tsq = toTsQuery(request.query.q ?? "");
      const fav = request.query.favorites === "1";
      const col = request.query.collectionId ?? null;
      const rows = await prisma.$queryRaw<{ id: string; rank: number }[]>`
        SELECT c.id, ${tsq ? Prisma.sql`ts_rank(to_tsvector('simple', coalesce(c."title", '') || ' ' || coalesce(c."text", '')), to_tsquery('simple', ${tsq}))` : Prisma.sql`0`}::float AS rank
        FROM "ClipCandidate" c JOIN "ClipJob" j ON j.id = c."jobId"
        WHERE j."clientId" = ${client.id}
        ${tsq ? Prisma.sql`AND to_tsvector('simple', coalesce(c."title", '') || ' ' || coalesce(c."text", '')) @@ to_tsquery('simple', ${tsq})` : Prisma.empty}
        ${fav ? Prisma.sql`AND c."favorite" = true` : Prisma.empty}
        ${col ? Prisma.sql`AND EXISTS (SELECT 1 FROM "ClipCollectionItem" i WHERE i."candidateId" = c.id AND i."collectionId" = ${col})` : Prisma.empty}
        ORDER BY rank DESC, c."createdAt" DESC
        LIMIT ${limit}`;
      const cands = await prisma.clipCandidate.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        include: { job: { include: { source: { select: { originalName: true, stripKey: true } } } }, collections: { select: { collectionId: true } } },
      });
      const byId = new Map(cands.map((c) => [c.id, c]));
      return {
        query: tsq,
        results: rows.map((r) => byId.get(r.id)).filter((c): c is NonNullable<typeof c> => !!c).map((c) => ({
          id: c.id, jobId: c.jobId, title: c.title, score: c.score, duration: c.duration, favorite: c.favorite,
          source: c.job.source.originalName, stripUrl: c.job.source.stripKey ? fileLinkVersioned(c.job.source.stripKey, null) : null,
          ranges: c.ranges, collections: c.collections.map((x) => x.collectionId), perf: c.perf, editProjectId: c.editProjectId,
          snippet: (c.text ?? "").slice(0, 160),
        })),
      };
    },
  );

  // ---------- activity ----------

  app.get<{ Params: { clientId: string }; Querystring: { limit?: string } }>("/clients/:clientId/clip-activity", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    const rows = await prisma.clipActivity.findMany({ where: { clientId: client.id }, orderBy: { createdAt: "desc" }, take: Math.min(200, Number(request.query.limit) || 50) });
    return { activity: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  });

  // ---------- performance ----------

  app.get<{ Params: { clientId: string } }>("/clients/:clientId/clip-performance", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    const rows = await prisma.clipCandidate.findMany({
      where: { job: { clientId: client.id }, perf: { not: Prisma.DbNull } },
      select: { id: true, jobId: true, title: true, score: true, duration: true, perf: true, perfAt: true },
    });
    rows.sort((a, b) => ((b.perf as { views?: number }).views ?? 0) - ((a.perf as { views?: number }).views ?? 0));
    return { clips: rows.map((r) => ({ ...r, perfAt: r.perfAt?.toISOString() ?? null })) };
  });

  app.post<{ Params: { clientId: string } }>("/clients/:clientId/clip-performance/refresh", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    await enqueue("clips", { clipPerf: client.id }, { key: `perf:${client.id}` });
    return reply.status(202).send({ queued: true });
  });

  // ---------- YouTube auto-import ----------

  const autoImportBody = z.object({
    on: z.boolean(),
    channelId: z.string().trim().refine((s) => s === "" || isChannelId(s), "A channel id starts with UC and is 24 characters.").nullable().optional(),
    playlists: z.array(z.string().trim().refine(isPlaylistId, "That is not a playlist id.")).max(10).default([]),
    uploads: z.boolean().default(true),
    recipeId: z.string().max(40).nullable().optional(),
  });

  const autoImportView = async (clientId: string, raw: unknown) => {
    // A bare NOT would also drop rows whose reason is NULL (the imported ones).
    const imports = await prisma.youTubeImport.findMany({ where: { clientId, OR: [{ reason: null }, { reason: { not: "Published before auto-import was on." } }] }, orderBy: { createdAt: "desc" }, take: 20 });
    return { settings: readAutoImport(raw), keyReady: !!env.YOUTUBE_API_KEY, imports: imports.map((i) => ({ ...i, publishedAt: i.publishedAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString() })) };
  };

  app.get<{ Params: { clientId: string } }>("/clients/:clientId/auto-import", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    return autoImportView(client.id, client.autoImport);
  });

  app.put<{ Params: { clientId: string } }>("/clients/:clientId/auto-import", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    const parsed = autoImportBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the settings."));
    const b = parsed.data;
    if (b.recipeId && !(await prisma.recipe.findFirst({ where: { id: b.recipeId, clientId: client.id } }))) {
      return reply.status(404).send(bad("That recipe is not in this brand.", "recipe not found"));
    }
    const prev = readAutoImport(client.autoImport);
    const next = {
      ...defaultAutoImport(), ...prev,
      on: b.on, channelId: b.channelId || null, playlists: [...new Set(b.playlists)], uploads: b.uploads, recipeId: b.recipeId ?? null,
      // Turning it on starts the clock: only videos after this moment import.
      lastCheckAt: b.on && !prev.on ? new Date().toISOString() : prev.lastCheckAt,
    };
    await prisma.client.update({ where: { id: client.id }, data: { autoImport: next as unknown as Prisma.InputJsonValue } });
    return autoImportView(client.id, next);
  });

  app.post<{ Params: { clientId: string } }>("/clients/:clientId/auto-import/check", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    await enqueue("clips", { autoImport: client.id }, { key: `autoimport:${client.id}` });
    return reply.status(202).send({ queued: true });
  });
}

/** Public, no login: /v/:token read-only review page and client comments. */
export async function publicReviewRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const allow = rateLimiter("review", 60_000, 60);

  async function open(token: string, ip: string, reply: FastifyReply) {
    if (!(await allow(ip)).allowed) return void reply.status(429).send(bad("Too many requests, slow down.", "rate limited"));
    const dot = token.lastIndexOf(".");
    const id = dot > 0 ? token.slice(0, dot) : "";
    const link = id ? await prisma.reviewLink.findUnique({ where: { id }, include: { project: true } }) : null;
    const expected = link ? Buffer.from(reviewToken(link.id, link.expiresAt)) : null;
    const given = Buffer.from(token);
    if (!link || !expected || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return void reply.status(404).send(bad("This review link does not exist.", "not found"));
    }
    if (link.revokedAt) return void reply.status(410).send(bad("This link was turned off, ask for a new one.", "gone"));
    if (link.expiresAt <= new Date()) return void reply.status(410).send(bad("This link has expired, ask for a new one.", "gone"));
    return link;
  }

  app.get<{ Params: { token: string } }>("/v/:token", async (request, reply) => {
    const link = await open(request.params.token, clientIp(request), reply);
    if (!link) return reply;
    const p = link.project;
    const c = await commentsFor(p.id, p.doc);
    return {
      name: p.name,
      expiresAt: link.expiresAt.toISOString(),
      video: p.renderedKey ? { url: fileLink(p.renderedKey) } : null,
      ...c,
    };
  });

  app.post<{ Params: { token: string } }>("/v/:token/comments", async (request, reply) => {
    const link = await open(request.params.token, clientIp(request), reply);
    if (!link) return reply;
    const parsed = commentBody.extend({ name: z.string().trim().min(1, "Add your name.").max(60) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the comment."));
    const { body, atSec, parentId, name } = parsed.data;
    if (parentId && !(await prisma.editComment.findFirst({ where: { id: parentId, projectId: link.projectId, parentId: null } }))) {
      return reply.status(404).send(bad("That thread is gone.", "comment not found"));
    }
    const c = await prisma.editComment.create({
      data: { projectId: link.projectId, parentId: parentId ?? null, atSec: parentId ? null : (atSec ?? null), body, authorName: name, authorKind: "client" },
    });
    await prisma.clipActivity.create({ data: { clientId: link.project.clientId, actor: `${name} (client)`, action: "commented", projectId: link.projectId, detail: body.slice(0, 200) } });
    return reply.status(201).send(commentView(c));
  });
}
