import path from "node:path";
import fs from "node:fs/promises";
import {
  annotateWords,
  autoReframe,
  type FaceTrack,
  assFromDoc,
  attachMarks,
  outputWordRefs,
  textsWithHook,
  wordMarks,
  BITRATE_PRESETS,
  chunksWithTimes,
  editedWords,
  edlFromDoc,
  outputWords,
  type EditDoc,
  type EditDocV1,
  migrateDoc,
  outputSize,
  type Word,
} from "@toreroflow/core";
import { getPrisma, Prisma, enqueue } from "@toreroflow/db";
import {
  buildRenderPlan,
  conformProxy,
  filmstrip,
  isBrowserReady,
  probe,
  renderEdit,
  sceneCuts,
  waveformPeaks,
} from "@toreroflow/media";
import { env } from "./env";
import { transcribeStrict } from "./transcribe";

const prisma = getPrisma();

/** Past this, words live in storage/<clientId>/edit/<projectId>/<assetId>-words.json. */
const WORDS_FILE_THRESHOLD_SEC = 15 * 60;

/** An asset's words from whichever place holds them. */
export async function assetWords(a: { words: unknown; wordsKey: string | null }): Promise<Word[]> {
  if (a.wordsKey) {
    try {
      return JSON.parse(await fs.readFile(path.join(env.STORAGE_DIR, a.wordsKey), "utf8")) as Word[];
    } catch {
      return [];
    }
  }
  return (a.words as Word[] | null) ?? [];
}

/**
 * Make one editor source usable: clips get something the preview can play, a
 * filmstrip for the timeline lane, and word-level timestamps; audio gets a
 * duration; graphics are ready as dropped. The original file is never touched,
 * the render reads it directly.
 *
 * "Something the preview can play" is the source itself whenever the source
 * already is, which for phone and CapCut exports is almost always. Only
 * footage a webview cannot decode gets a converted copy.
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

    const stripKey = `${dir}/${asset.id}-strip.jpg`;

    /*
     * The three things a dropped clip needs, at the same time instead of one
     * after another.
     *
     * They were sequential and none of them feeds another: the proxy, the
     * filmstrip and the words are all made from the same untouched source. Run
     * in series the wait was their sum; run together it is whichever is
     * slowest. On a 35 second phone clip that measured 9.8s against 5.3s.
     *
     * Three at once rather than a pool, because the edit queue takes one job
     * at a time, so this is three processes on the machine, not thirty.
     */
    const proxyKey = isBrowserReady(meta)
      ? // Already playable, so the proxy is the source. An H.264 yuv420p MP4
        // re-encoded to an H.264 yuv420p MP4 is five seconds spent to arrive
        // where it started, and it was the longest step of the three.
        asset.storageKey
      : `${dir}/${asset.id}-proxy.mp4`;

    const peaksKey = `${dir}/${asset.id}-peaks.json`;
    // A language set up front (a clip job's option) skips whisper's guess.
    const runTranscribe = () =>
      transcribeStrict(sourcePath, { durationSec: meta.durationSec, language: asset.language }).then(
        (t) => ({ ok: true as const, t }),
        (e: Error) => ({ ok: false as const, reason: e.message }),
      );
    // ponytail: long sources transcribe alone first. On the e2e box a 20 min
    // talk transcribed beside the proxy and filmstrip encodes came back with
    // its first minutes missing and the language guessed wrong (ko, zh, nl);
    // the same audio alone came back whole, every time. Root cause not found
    // in whisper; this keeps the CPU to it. Short clips keep the parallel win.
    const serial = (meta.durationSec ?? 0) > 300;
    const early = serial ? await runTranscribe() : null;
    const [, , transcript, peaks] = await Promise.all([
      proxyKey === asset.storageKey
        ? Promise.resolve()
        : conformProxy(sourcePath, path.join(env.STORAGE_DIR, proxyKey)),
      filmstrip(sourcePath, path.join(env.STORAGE_DIR, stripKey)),
      // Word Editor and auto-cut both work on the flat word list; segment
      // boundaries carry nothing the editor needs. A failed transcription no
      // longer fails silently: the clip stays usable (proxy, filmstrip) and
      // the reason lands in EditAsset.error for the editor to show.
      early ? Promise.resolve(early) : runTranscribe(),
      // Waveform lane; a decode hiccup costs the lane, never the clip.
      waveformPeaks(sourcePath).catch(() => null),
    ]);
    const words: Word[] = transcript.ok
      ? annotateWords(transcript.t.segments.flatMap((s) => s.words ?? []))
      : [];
    if (peaks) await fs.writeFile(path.join(env.STORAGE_DIR, peaksKey), JSON.stringify(peaks));

    // Long sources keep their words in a file: an hour is megabytes of JSON
    // that every project load would otherwise drag out of Postgres.
    const longSource = (meta.durationSec ?? 0) > WORDS_FILE_THRESHOLD_SEC;
    const wordsKey = longSource ? `${dir}/${asset.id}-words.json` : null;
    if (wordsKey) await fs.writeFile(path.join(env.STORAGE_DIR, wordsKey), JSON.stringify(words));

    await prisma.editAsset.update({
      where: { id: asset.id },
      data: {
        proxyKey,
        stripKey,
        words: wordsKey ? Prisma.DbNull : (words as unknown as Prisma.InputJsonValue),
        wordsKey,
        language: transcript.ok ? (transcript.t.language ?? null) : null,
        peaksKey: peaks ? peaksKey : null,
        error: transcript.ok ? null : transcript.reason.slice(0, 500),
        status: "ready",
      },
    });
    console.log(
      `[worker] edit asset ${asset.id} ready (${asset.project.clientId}, ${words.length} words` +
        (transcript.ok ? ")" : `, transcription failed: ${transcript.reason})`),
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
 * Split one clip's audio into voice or everything-but-voice, as a new asset.
 *
 * Demucs runs inside the captions service at roughly realtime on CPU, which
 * is why this is a queued job rather than a request. The result lands in the
 * project's Audio drawer as its own ready asset, so the operator places it
 * like any other audio and the original clip is never modified.
 */
export async function isolateVoice(
  editAssetId: string,
  mode: "voice" | "instrumental",
): Promise<void> {
  const source = await prisma.editAsset.findUnique({
    where: { id: editAssetId },
    include: { project: true },
  });
  if (!source || source.kind !== "clip") return;

  const dir = path.posix.dirname(source.storageKey);
  const scratch = path.join(env.STORAGE_DIR, dir, "_separate");
  const row = await prisma.editAsset.create({
    data: {
      projectId: source.projectId,
      kind: "audio",
      storageKey: "pending",
      originalName: `${source.originalName} · ${mode === "voice" ? "voice only" : "no voice"}.mp3`,
      status: "processing",
    },
  });

  try {
    const res = await fetch(`${env.CAPTIONS_URL}/separate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: path.join(env.STORAGE_DIR, source.storageKey),
        mode,
        out_dir: scratch,
      }),
      // Under undici's 300s first-byte ceiling, which the API's 4 minute clip
      // cap keeps us inside; this just makes the giving-up explicit.
      signal: AbortSignal.timeout(290_000),
    });
    if (!res.ok) {
      throw new Error(`captions /separate: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const { path: produced } = (await res.json()) as { path: string };

    const storageKey = `${dir}/${row.id}-source.mp3`;
    await fs.rename(produced, path.join(env.STORAGE_DIR, storageKey));
    const meta = await probe(path.join(env.STORAGE_DIR, storageKey));
    await prisma.editAsset.update({
      where: { id: row.id },
      data: { storageKey, durationSec: meta.durationSec, status: "ready" },
    });
    console.log(`[worker] isolated ${mode} for ${source.id} -> ${row.id}`);
  } catch (error) {
    console.error(`[worker] isolate ${mode} failed for ${editAssetId}:`, error);
    await prisma.editAsset.update({ where: { id: row.id }, data: { status: "failed" } });
    throw error;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
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
    const raw = project.doc as unknown as EditDoc | EditDocV1 | null;
    if (!raw || (raw.v !== 1 && raw.v !== 2)) {
      await fail("this project has no edit document yet");
      return;
    }
    // Old v1 docs render through the same migration the editor loads with.
    const doc = migrateDoc(raw);

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
      const words = await assetWords(a);
      wordsByAsset[a.id] = editedWords(words, doc.wordEdits[a.id] ?? {});
    }
    const outWords = outputWords(edl, wordsByAsset);
    // Same chunks as chunksFor, plus each word's time for karaoke \k.
    // Phase 5 keyword levels and emojis ride on the chunks, packed alike.
    const chunks = attachMarks(
      chunksWithTimes(outWords, doc.captions.style.wordsPerLine, doc.captions.style.lines),
      wordMarks(outputWordRefs(edl, wordsByAsset), doc),
      doc.captions.style.wordsPerLine * doc.captions.style.lines,
    );
    // The hook headline renders through the text-overlay path.
    const texts = textsWithHook(doc);

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
    if (doc.captions.enabled || texts.length > 0) {
      assPath = path.join(projectDir, `render-${n}.ass`);
      await fs.writeFile(
        assPath,
        assFromDoc({
          chunks: doc.captions.enabled ? chunks : [],
          texts,
          captions: doc.captions,
        }),
        "utf8",
      );
    }

    const { resolution, fps } = doc.export;
    // The resolution number is the short edge; 9:16 at 1080 is 1080x1920 as before.
    const { width, height } = outputSize(doc.output.aspect, resolution);
    const preset = BITRATE_PRESETS[resolution];
    const baseK = typeof doc.export.bitrate === "number" ? doc.export.bitrate : preset[doc.export.bitrate];
    // 60fps carries twice the frames; presets scale up, a custom number is
    // the operator's exact choice and stays as typed.
    const videoBitrateK =
      fps === 60 && typeof doc.export.bitrate !== "number" ? Math.round(baseK * 1.5) : baseK;

    // Audio streams are probed here, not stored: a silent main clip needs
    // generated silence and b-roll sound only mixes in when it exists, and
    // a probe costs milliseconds against a render that takes minutes.
    const live = project.assets.filter((a) => a.storageKey !== "pending");
    const hasAudio = new Map<string, boolean>();
    await Promise.all(
      live
        .filter((a) => a.kind === "clip")
        .map(async (a) => {
          const m = await probe(path.join(env.STORAGE_DIR, a.storageKey)).catch(() => null);
          if (m) hasAudio.set(a.id, m.audioCodec !== "");
        }),
    );
    const plan = buildRenderPlan({
      doc,
      edl,
      assets: live.map((a) => ({
        id: a.id,
        kind: a.kind,
        path: path.join(env.STORAGE_DIR, a.storageKey),
        durationSec: a.durationSec ?? 0,
        width: a.width ?? 0,
        height: a.height ?? 0,
        hasAudio: hasAudio.get(a.id),
      })),
      assPath,
      // Resolved the way the insights template is: relative to the repo root,
      // which the Dockerfile also registers with fontconfig.
      fontsDir: path.join(env.REPO_ROOT, "assets", "fonts"),
      out: { path: outPath, width, height, fps, format: ext, videoBitrateK },
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
    await sendAfterRender(editProjectId);
    console.log(
      `[worker] render ${n} ready for project ${project.id} (${Math.round(plan.totalOutSec)}s to ${renderedKey})`,
    );
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Phase 6 "Render + send to Uploads": once a batch render lands, the file
 * goes to Uploads like the editor's Send button, with the clip's curated
 * title, description and hashtags as the drafted copy. Nothing posts.
 * A failed send keeps the render and says why in renderError.
 */
async function sendAfterRender(editProjectId: string): Promise<void> {
  const prisma = getPrisma();
  const p = await prisma.editProject.findUnique({ where: { id: editProjectId } });
  const after = p?.afterRender as { send?: boolean; title?: string; description?: string; hashtags?: string[] } | null;
  if (!p || !p.renderedKey || !after?.send || p.uploadAssetId) return;
  const ext = path.extname(p.renderedKey) || ".mp4";
  const base = (p.doc as { export?: { name?: string } } | null)?.export?.name?.trim() || p.name;
  const asset = await prisma.mediaAsset.create({
    data: {
      clientId: p.clientId,
      originalName: `${base}${ext}`,
      storageKey: "pending",
      status: "uploaded",
      draftCopy: {
        name: after.title ?? p.name,
        description: after.description ?? "",
        hashtags: Array.isArray(after.hashtags) ? after.hashtags : [],
      },
    },
  });
  const storageKey = `${p.clientId}/${asset.id}/source${ext}`;
  try {
    await fs.mkdir(path.join(env.STORAGE_DIR, p.clientId, asset.id), { recursive: true });
    await fs.copyFile(path.join(env.STORAGE_DIR, p.renderedKey), path.join(env.STORAGE_DIR, storageKey));
  } catch (error) {
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
    await prisma.editProject.updateMany({
      where: { id: editProjectId },
      data: { renderError: `rendered, but sending to Uploads failed: ${error instanceof Error ? error.message : String(error)}` },
    });
    return;
  }
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: { storageKey } });
  await enqueue("media", { assetId: asset.id });
  await prisma.editProject.updateMany({ where: { id: editProjectId }, data: { uploadAssetId: asset.id } });
  console.log(`[worker] sent render of ${editProjectId} to Uploads as ${asset.id}`);
}

/** Where the API and desktop read an auto reframe's progress and result. */
export function reframeStatusPath(storageKey: string, assetId: string): string {
  return path.join(env.STORAGE_DIR, path.posix.dirname(storageKey), `${assetId}-reframe.json`);
}

/**
 * Auto reframe: scene cuts (ffmpeg) + face samples (captions /faces, local
 * YuNet, no paid API) -> autoReframe -> shots in a status file.
 *
 * ponytail: the result goes to a file the desktop polls and applies as an
 * undoable doc edit, rather than into EditProject.doc. The desktop autosaves
 * the whole doc, so a worker write there would be silently overwritten by
 * the next keystroke. Same file shape as a failure, so one reader handles both.
 */
export async function reframeAsset(editAssetId: string): Promise<void> {
  const asset = await prisma.editAsset.findUnique({
    where: { id: editAssetId },
    include: { project: true },
  });
  if (!asset || asset.kind !== "clip") return;
  const statusPath = reframeStatusPath(asset.storageKey, asset.id);
  const write = (body: object) =>
    fs.writeFile(statusPath, JSON.stringify({ ...body, at: new Date().toISOString() }));

  try {
    await write({ status: "running" });
    const source = path.join(env.STORAGE_DIR, asset.storageKey);
    const facesKey = `${path.posix.dirname(asset.storageKey)}/${asset.id}-faces.json`;
    const [cuts, res] = await Promise.all([
      sceneCuts(source),
      fetch(`${env.CAPTIONS_URL}/faces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: source, out: path.join(env.STORAGE_DIR, facesKey) }),
        signal: AbortSignal.timeout(290_000),
      }),
    ]);
    if (!res.ok) {
      throw new Error(`captions /faces: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const track = JSON.parse(await fs.readFile(path.join(env.STORAGE_DIR, facesKey), "utf8")) as FaceTrack;
    const raw = asset.project.doc as unknown as EditDoc | EditDocV1 | null;
    // No doc yet means nothing picked an aspect: 9:16 is the editor default.
    const aspect = raw && (raw.v === 1 || raw.v === 2) ? migrateDoc(raw).output.aspect : "9:16";
    const { width, height } = outputSize(aspect, 1080);
    const duration = asset.durationSec ?? (await probe(source)).durationSec;
    const shots = autoReframe(track, cuts, duration, { W: width, H: height });
    await write({ status: "ready", shots, facesKey, aspect });
    console.log(`[worker] reframed ${asset.id}: ${shots.length} shots, ${cuts.length} cuts`);
  } catch (error) {
    console.error(`[worker] reframe failed for ${editAssetId}:`, error);
    await write({ status: "failed", error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    throw error;
  }
}
