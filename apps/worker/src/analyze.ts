import path from "node:path";
import fs from "node:fs/promises";
import { getPrisma } from "@toreroflow/db";
import { extractThumbnail, probe } from "@toreroflow/media";
import { env } from "./env";
import { transcribe } from "./transcribe";

const prisma = getPrisma();

/**
 * One analyzer run. The intake half is real: probe, thumb, transcript. The
 * scoring half is milestone D, so until then every run ends "failed" with an
 * honest error rather than a screen pretending to have scores.
 */
export async function runAnalysis(analysisId: string): Promise<void> {
  const analysis = await prisma.videoAnalysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return;

  try {
    let sourceKey = analysis.storageKey;
    if (!sourceKey && analysis.mediaAssetId) {
      const asset = await prisma.mediaAsset.findUnique({
        where: { id: analysis.mediaAssetId },
        select: { storageKey: true },
      });
      sourceKey = asset?.storageKey ?? null;
    }
    if (!sourceKey) throw new Error("analysis has no source file");

    const sourcePath = path.join(env.STORAGE_DIR, sourceKey);
    const meta = await probe(sourcePath);

    // Always the analysis's own directory, never beside the source: a
    // from-media source lives in the MediaAsset's directory, where thumb.jpg
    // is the pipeline's own thumbnail and the retention sweep deletes it.
    const thumbKey = `${analysis.clientId}/analysis/${analysis.id}/thumb.jpg`;
    await fs.mkdir(path.join(env.STORAGE_DIR, analysis.clientId, "analysis", analysis.id), {
      recursive: true,
    });
    await extractThumbnail(
      sourcePath,
      path.join(env.STORAGE_DIR, thumbKey),
      Math.min(1, (meta.durationSec || 1) * 0.25),
    );

    const transcript = await transcribe(sourcePath);
    console.log(
      `[worker] analysis ${analysis.id} intake done (${transcript?.segments.length ?? 0} segments)`,
    );

    // Milestone D: sample 12 frames, feed transcript plus frames to the
    // schema-locked model call scored against the rubric, write `result`,
    // and this becomes status "ready".
    await prisma.videoAnalysis.update({
      where: { id: analysis.id },
      data: {
        durationSec: meta.durationSec,
        thumbKey,
        status: "failed",
        error: "analysis engine lands in milestone D",
        completedAt: new Date(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] analysis ${analysisId} failed:`, error);
    await prisma.videoAnalysis.update({
      where: { id: analysisId },
      data: { status: "failed", error: message.slice(0, 500), completedAt: new Date() },
    });
    throw error;
  }
}
