import path from "node:path";
import fs from "node:fs/promises";
import {
  assFromDoc,
  BITRATE_PRESETS,
  chunksFor,
  editedWords,
  edlFromDoc,
  outputWords,
  type EditDoc,
  type Word,
} from "@toreroflow/core";
import { getPrisma, Prisma } from "@toreroflow/db";
import {
  buildRenderPlan,
  conformProxy,
  filmstrip,
  probe,
  renderEdit,
} from "@toreroflow/media";
import { env } from "./env";
import { transcribe } from "./transcribe";

const prisma = getPrisma();

/**
 * Make one editor source usable: clips get a browser-safe proxy, a filmstrip
 * for the timeline lane, and word-level timestamps; audio gets a duration;
 * graphics are ready as dropped. The original file is never touched, the
 * render reads it directly.
 */
export async function processEditAsset(editAssetId: string): Promise<void> {
  const asset = await prisma.editAsset.findUnique({
    where: { id: editAssetId },
    include: { project: true },
  });
  if (!asset) return;

  const sourcePath = path.join(env.STORAGE_DIR, asset.storageKey);
  // Outputs live beside the source, named by asset id: project assets can
  // share a directory without colliding.
  const dir = path.posix.dirname(asset.storageKey);

  try {
    if (asset.kind === "graphic") {
      await prisma.editAsset.update({ where: { id: asset.id }, data: { status: "ready" } });
      return;
    }

    if (asset.kind === "audio") {
      const meta = await probe(sourcePath);
      await prisma.editAsset.update({
        where: { id: asset.id },
        data: { durationSec: meta.durationSec, status: "ready" },
      });
      return;
    }

    await prisma.editAsset.update({ where: { id: asset.id }, data: { status: "processing" } });

    const meta = await probe(sourcePath);
    await prisma.editAsset.update({
      where: { id: asset.id },
      data: { durationSec: meta.durationSec, width: meta.width, height: meta.height },
    });

    const proxyKey = `${dir}/${asset.id}-proxy.mp4`;
    const stripKey = `${dir}/${asset.id}-strip.jpg`;
    await conformProxy(sourcePath, path.join(env.STORAGE_DIR, proxyKey));
    await filmstrip(sourcePath, path.join(env.STORAGE_DIR, stripKey));

    // Word Editor and auto-cut both work on the flat word list; segment
    // boundaries carry nothing the editor needs.
    const transcript = await transcribe(sourcePath);
    const words = (transcript?.segments ?? []).flatMap((s) => s.words ?? []);

    await prisma.editAsset.update({
      where: { id: asset.id },
      data: {
        proxyKey,
        stripKey,
        words: words as unknown as Prisma.InputJsonValue,
        status: "ready",
      },
    });
    console.log(
      `[worker] edit asset ${asset.id} ready (${asset.project.clientId}, ${words.length} words)`,
    );
  } catch (error) {
    console.error(`[worker] edit asset ${editAssetId} failed:`, error);
    await prisma.editAsset.update({
      where: { id: editAssetId },
      data: { status: "failed" },
    });
    throw error;
  }
}

/**
 * Render one project's edit document to a finished video.
 *
 * The API flipped status to "rendering" before enqueueing; anything else on
 * the row means a stale or replayed job, and rendering over it would fight
 * whatever changed the status. Reads the ORIGINAL source files (storageKey),
 * never the proxies. Success writes status rendered + renderedKey; failure
 * writes status failed + a message the export screen can show.
 */
export async function renderProject(editProjectId: string): Promise<void> {
  const project = await prisma.editProject.findUnique({
    where: { id: editProjectId },
    include: { assets: true },
  });
  if (!project) return;
  if (project.status !== "rendering") return;

  const fail = async (message: string): Promise<void> => {
    await prisma.editProject.updateMany({
      where: { id: editProjectId },
      data: { status: "failed", renderError: message.slice(0, 500) },
    });
    console.error(`[worker] render failed for ${editProjectId}: ${message}`);
  };

  try {
    const doc = project.doc as unknown as EditDoc | null;
    if (!doc || doc.v !== 1) {
      await fail("this project has no edit document yet");
      return;
    }

    const clips = project.assets.filter((a) => a.kind === "clip");
    const durations: Record<string, number> = {};
    for (const a of clips) {
      if (a.durationSec && a.durationSec > 0) durations[a.id] = a.durationSec;
    }
    const edl = edlFromDoc(doc, durations);
    if (edl.length === 0) {
      await fail("there is nothing left to render after the cuts");
      return;
    }

    // Caption chunks: word edits applied per asset, then remapped to output
    // time so captions follow the final cut, then packed into chunks. Break
    // overrides stay in doc.captions.breaks and assFromDoc applies them by
    // chunk index, so the indices here must be the raw chunk order.
    const wordsByAsset: Record<string, Word[]> = {};
    for (const a of clips) {
      const words = (a.words as unknown as Word[] | null) ?? [];
      wordsByAsset[a.id] = editedWords(words, doc.wordEdits[a.id] ?? {});
    }
    const outWords = outputWords(edl, wordsByAsset);
    const chunks = chunksFor(outWords, doc.captions.style.wordsPerLine, doc.captions.style.lines);

    // The output name: render-<n> past every render file already in the
    // project dir, so a re-render never overwrites what the operator may
    // have already downloaded.
    const projectDir = path.join(env.STORAGE_DIR, project.clientId, "edit", project.id);
    await fs.mkdir(projectDir, { recursive: true });
    let n = 1;
    for (const name of await fs.readdir(projectDir)) {
      const m = /^render-(\d+)\./.exec(name);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    const ext = doc.export.format;
    const renderedKey = `${project.clientId}/edit/${project.id}/render-${n}.${ext}`;
    const outPath = path.join(env.STORAGE_DIR, renderedKey);

    // The ASS file carries captions and text overlays both; with captions off
    // and no texts there is nothing to burn, so the subtitles filter is
    // skipped entirely.
    let assPath: string | null = null;
    if (doc.captions.enabled || doc.texts.length > 0) {
      assPath = path.join(projectDir, `render-${n}.ass`);
      await fs.writeFile(
        assPath,
        assFromDoc({
          chunks: doc.captions.enabled ? chunks : [],
          texts: doc.texts,
          captions: doc.captions,
        }),
        "utf8",
      );
    }

    const { resolution, fps } = doc.export;
    // 9:16 vertical: the resolution number is the width.
    const height = Math.round((resolution * 16) / 9);
    const preset = BITRATE_PRESETS[resolution];
    const baseK = typeof doc.export.bitrate === "number" ? doc.export.bitrate : preset[doc.export.bitrate];
    // 60fps carries twice the frames; presets scale up, a custom number is
    // the operator's exact choice and stays as typed.
    const videoBitrateK =
      fps === 60 && typeof doc.export.bitrate !== "number" ? Math.round(baseK * 1.5) : baseK;

    const plan = buildRenderPlan({
      doc,
      edl,
      assets: project.assets
        .filter((a) => a.storageKey !== "pending")
        .map((a) => ({
          id: a.id,
          kind: a.kind,
          path: path.join(env.STORAGE_DIR, a.storageKey),
          durationSec: a.durationSec ?? 0,
          width: a.width ?? 0,
          height: a.height ?? 0,
        })),
      assPath,
      // Resolved the way the insights template is: relative to the repo root,
      // which the Dockerfile also registers with fontconfig.
      fontsDir: path.join(env.REPO_ROOT, "assets", "fonts"),
      out: { path: outPath, width: resolution, height, fps, format: ext, videoBitrateK },
    });

    // Whole percents only, written when the number actually moves; the last
    // write is awaited so a straggler can never land after the success row.
    let lastPct = -1;
    let progressWrite: Promise<unknown> = Promise.resolve();
    await renderEdit({
      plan,
      onProgress: (pct: number) => {
        const whole = Math.max(0, Math.min(99, Math.floor(pct)));
        if (whole <= lastPct) return;
        lastPct = whole;
        progressWrite = prisma.editProject
          .updateMany({ where: { id: editProjectId }, data: { renderPct: whole } })
          .catch(() => {});
      },
    });
    await progressWrite;

    await prisma.editProject.updateMany({
      where: { id: editProjectId },
      data: { status: "rendered", renderedKey, renderPct: 100, renderError: null },
    });
    console.log(
      `[worker] render ${n} ready for project ${project.id} (${Math.round(plan.totalOutSec)}s to ${renderedKey})`,
    );
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
  }
}
