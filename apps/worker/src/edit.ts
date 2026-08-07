import path from "node:path";
import { getPrisma, Prisma } from "@toreroflow/db";
import { conformProxy, filmstrip, probe } from "@toreroflow/media";
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
