/**
 * Phase 5 AI editing passes. Each route reads the words that survive the
 * current cut and answers with word-index suggestions; the desktop applies
 * them through update() so every pass is one undo step.
 *
 * ponytail: heuristic only (packages/core aiPasses), no model call, so no AI
 * spend. These routes are the swap point if a model is wanted later.
 */
import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  edlFromDoc,
  editedWords,
  migrateDoc,
  outputWordRefs,
  speechCleanup,
  suggestBrollSpots,
  suggestHighlights,
  suggestHooks,
  suggestZooms,
  type EditDoc,
  type EditDocV1,
  type Word,
} from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

const PASSES = ["cleanup", "hook", "highlights", "zooms", "broll-spots"] as const;

const bodySchema = z.object({
  /** The desktop's live doc, so unsaved edits count; else the stored one. */
  doc: z.unknown().optional(),
  pauseSec: z.number().min(0.2).max(5).optional(),
  fillers: z.array(z.string().min(1).max(40)).max(60).optional(),
});

async function wordsOf(a: { words: unknown; wordsKey?: string | null }): Promise<Word[]> {
  if (Array.isArray(a.words) && a.words.length) return a.words as Word[];
  if (!a.wordsKey) return [];
  try {
    const w = JSON.parse(await fs.readFile(path.join(env.STORAGE_DIR, a.wordsKey), "utf8"));
    return Array.isArray(w) ? (w as Word[]) : [];
  } catch {
    return [];
  }
}

export async function editorAiRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.post<{ Params: { id: string; pass: string } }>(
    "/edit-projects/:id/ai/:pass",
    async (request, reply) => {
      const pass = request.params.pass as (typeof PASSES)[number];
      if (!PASSES.includes(pass)) {
        return reply.status(404).send({ error: "unknown pass", detail: `Use one of: ${PASSES.join(", ")}.` });
      }
      const parsed = bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "bad request",
          detail: parsed.error.issues[0]?.message ?? "Check the pass options.",
        });
      }
      const project = await prisma.editProject.findFirst({
        where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
        include: { assets: true },
      });
      if (!project) return reply.status(404).send({ error: "project not found" });
      const raw = (parsed.data.doc ?? project.doc) as EditDoc | EditDocV1 | null;
      const doc = raw ? migrateDoc(raw) : null;
      if (!doc || doc.clips.length === 0) {
        return reply.status(400).send({ error: "nothing to work on", detail: "Add a clip first." });
      }
      const clips = project.assets.filter((a) => a.kind === "clip");
      const durations: Record<string, number> = {};
      const wordsByAsset: Record<string, Word[]> = {};
      for (const a of clips) {
        if (a.durationSec) durations[a.id] = a.durationSec;
        const w = await wordsOf(a);
        if (w.length) wordsByAsset[a.id] = editedWords(w, doc.wordEdits[a.id] ?? {});
      }
      const refs = outputWordRefs(edlFromDoc(doc, durations), wordsByAsset);
      if (refs.length === 0) {
        return reply.status(400).send({
          error: "no transcript words",
          detail: "AI passes read the transcript; wait for captions to finish.",
        });
      }
      switch (pass) {
        case "cleanup":
          return speechCleanup(refs, { pauseSec: parsed.data.pauseSec, fillers: parsed.data.fillers });
        case "hook":
          return { hooks: suggestHooks(refs) };
        case "highlights":
          return suggestHighlights(refs);
        case "zooms":
          return { zooms: suggestZooms(refs) };
        case "broll-spots":
          return { spots: suggestBrollSpots(refs), stock: Boolean(env.PEXELS_API_KEY) };
      }
    },
  );

  /** Optional free stock search for a b-roll spot; 503 when no key is set. */
  app.get<{ Querystring: { q?: string } }>("/broll/stock", async (request, reply) => {
    if (!env.PEXELS_API_KEY) {
      return reply.status(503).send({
        error: "stock search is off",
        detail: "Add PEXELS_API_KEY to the repo root .env and restart the API.",
      });
    }
    const q = (request.query.q ?? "").trim().slice(0, 80);
    if (!q) return reply.status(400).send({ error: "missing query", detail: "Pass ?q=keywords." });
    const res = await fetch(
      `https://api.pexels.com/videos/search?per_page=6&orientation=portrait&query=${encodeURIComponent(q)}`,
      { headers: { Authorization: env.PEXELS_API_KEY } },
    );
    if (!res.ok) {
      return reply.status(502).send({ error: "stock search failed", detail: `Pexels answered ${res.status}.` });
    }
    const data = (await res.json()) as {
      videos?: {
        id: number;
        url: string;
        image: string;
        duration: number;
        user?: { name?: string };
        video_files?: { link: string; width: number; height: number; quality: string }[];
      }[];
    };
    return {
      results: (data.videos ?? []).map((v) => {
        const files = (v.video_files ?? []).filter((f) => f.height >= f.width);
        const best = files.sort((a, b) => Math.abs(a.height - 1920) - Math.abs(b.height - 1920))[0];
        return {
          id: v.id,
          page: v.url,
          thumb: v.image,
          duration: v.duration,
          by: v.user?.name ?? "",
          file: best?.link ?? null,
        };
      }),
    };
  });
}
