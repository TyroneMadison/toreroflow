import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { ASPECTS, CAPTION_TEMPLATES, VERSION_CAP, versionsToPrune, type Aspect, type Word } from "@toreroflow/core";
import { getPrisma, Prisma } from "@toreroflow/db";
import { env } from "../env";

/** Phase 6 helpers shared by the editor, clips and recipes routes. */

export const recipeSettingsSchema = z.object({
  aspect: z.enum(ASPECTS as [Aspect, ...Aspect[]]).optional(),
  captions: z
    .object({
      enabled: z.boolean().optional(),
      template: z
        .string()
        .refine((t) => CAPTION_TEMPLATES.some((c) => c.id === t), "That caption template does not exist.")
        .optional(),
      // ponytail: style overrides are trusted as Partial<CaptionStyle>; the
      // editor's own controls produce them, and a bad key is just ignored.
      style: z.record(z.unknown()).optional(),
    })
    .optional(),
  ai: z
    .object({
      hook: z.boolean().optional(),
      fillers: z.boolean().optional(),
      pauses: z.boolean().optional(),
      badTakes: z.boolean().optional(),
      zooms: z.boolean().optional(),
      highlights: z.boolean().optional(),
      emojis: z.boolean().optional(),
      pauseSec: z.number().min(0.2).max(3).optional(),
    })
    .optional(),
});

/** An asset's words from the row or the storage file the worker wrote. */
export async function assetWords(a: { words: unknown; wordsKey?: string | null }): Promise<Word[]> {
  if (a.wordsKey) {
    try {
      return JSON.parse(await fs.readFile(path.join(env.STORAGE_DIR, a.wordsKey), "utf8")) as Word[];
    } catch {
      return [];
    }
  }
  return Array.isArray(a.words) ? (a.words as Word[]) : [];
}

/** Durations and words for every clip asset of a project, keyed by asset id. */
export async function projectMedia(projectId: string) {
  const assets = await getPrisma().editAsset.findMany({ where: { projectId, kind: "clip" } });
  const durations: Record<string, number> = {};
  const words: Record<string, Word[]> = {};
  for (const a of assets) {
    if (a.durationSec && a.durationSec > 0) durations[a.id] = a.durationSec;
    words[a.id] = await assetWords(a);
  }
  return { durations, words };
}

/** Snapshot a doc as a version, then drop the oldest past the cap. */
export async function saveVersion(projectId: string, doc: unknown, label: string, auto = false) {
  const prisma = getPrisma();
  const v = await prisma.editVersion.create({
    data: { projectId, label: label.slice(0, 120), auto, doc: doc as Prisma.InputJsonValue },
    select: { id: true, label: true, auto: true, createdAt: true },
  });
  const rows = await prisma.editVersion.findMany({ where: { projectId }, select: { id: true, createdAt: true } });
  const gone = versionsToPrune(rows, VERSION_CAP);
  if (gone.length) await prisma.editVersion.deleteMany({ where: { id: { in: gone } } });
  return v;
}
