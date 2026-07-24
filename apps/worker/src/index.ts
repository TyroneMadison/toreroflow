import path from "node:path";
import fs from "node:fs/promises";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import Anthropic from "@anthropic-ai/sdk";
import { getPrisma, Prisma } from "@toreroflow/db";
import {
  buildAss,
  extractThumbnail,
  probe,
  renderVertical,
  type TranscriptSegment,
} from "@toreroflow/media";
import { env } from "./env";

const prisma = getPrisma();
const anthropic = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    caption: { type: "string" },
    hook: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["caption", "hook", "hashtags"],
  additionalProperties: false,
} as const;

async function transcribe(sourcePath: string): Promise<{
  segments: TranscriptSegment[];
} | null> {
  try {
    const res = await fetch(`${env.CAPTIONS_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sourcePath }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { segments: TranscriptSegment[] };
  } catch {
    return null; // captions service down: pipeline continues without captions
  }
}

async function draftCopy(
  clientName: string,
  transcriptText: string,
): Promise<unknown | null> {
  if (!anthropic || !transcriptText.trim()) return null;
  try {
    const response = await anthropic.messages.create({
      model: env.COPY_MODEL,
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: DRAFT_SCHEMA },
      },
      system:
        "You write short-form video post copy for a social media agency. " +
        "Given a video transcript, produce a scroll-stopping hook, a post caption " +
        "(1-3 sentences, no hashtags inside), and 5-8 relevant hashtags without the # sign.",
      messages: [
        {
          role: "user",
          content: `Brand: ${clientName}\nTranscript:\n${transcriptText.slice(0, 4000)}`,
        },
      ],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((b) => b.type === "text");
    return text && text.type === "text" ? JSON.parse(text.text) : null;
  } catch {
    return null; // draft is a nice-to-have; never fail the pipeline for it
  }
}

async function processAsset(assetId: string): Promise<void> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    include: { client: true },
  });
  if (!asset) return;

  const assetDir = path.join(env.STORAGE_DIR, asset.clientId, asset.id);
  const sourcePath = path.join(env.STORAGE_DIR, asset.storageKey);
  await prisma.mediaAsset.update({
    where: { id: asset.id },
    data: { status: "processing" },
  });

  try {
    // 1. Probe
    const meta = await probe(sourcePath);
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
      },
    });

    // 2. Transcribe (local faster-whisper service)
    const transcript = await transcribe(sourcePath);
    const segments = transcript?.segments ?? [];
    if (transcript) {
      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { transcript: segments as unknown as Prisma.InputJsonValue },
      });
    }

    // 3. AI post copy draft (needs ANTHROPIC_API_KEY; skipped gracefully)
    const transcriptText = segments.map((s) => s.text).join(" ");
    const draft = await draftCopy(asset.client.name, transcriptText);
    if (draft) {
      await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { draftCopy: draft },
      });
    }

    // 4. Vertical render with burned captions (Bold pop)
    let assPath: string | undefined;
    if (segments.some((s) => s.text.trim())) {
      assPath = path.join(assetDir, "subs.ass");
      await fs.writeFile(assPath, buildAss(segments), "utf8");
    }
    const renderKey = `${asset.clientId}/${asset.id}/vertical.mp4`;
    await renderVertical(sourcePath, path.join(env.STORAGE_DIR, renderKey), assPath);
    const existingRender = await prisma.render.findFirst({
      where: { mediaAssetId: asset.id },
    });
    // One representative 9:16 render for now; per-platform encode profiles
    // fan out when the publishing engine lands.
    if (existingRender) {
      await prisma.render.update({
        where: { id: existingRender.id },
        data: { status: "ready", storageKey: renderKey, captionStyle: "bold_pop" },
      });
    } else {
      await prisma.render.create({
        data: {
          mediaAssetId: asset.id,
          platform: "instagram",
          aspect: "9:16",
          storageKey: renderKey,
          captionStyle: segments.length ? "bold_pop" : null,
          status: "ready",
        },
      });
    }

    // 5. Thumbnail from the source video itself
    const thumbAt = Math.min(1, (meta.durationSec || 1) * 0.25);
    await extractThumbnail(sourcePath, path.join(assetDir, "thumb.jpg"), thumbAt);

    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: "ready" },
    });
    console.log(`[worker] asset ${asset.id} ready (${segments.length} caption segments)`);
  } catch (error) {
    console.error(`[worker] asset ${asset.id} failed:`, error);
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: "failed" },
    });
    throw error;
  }
}

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

new Worker<{ assetId: string }>(
  "media",
  async (job) => {
    await processAsset(job.data.assetId);
  },
  { connection, concurrency: 1 },
);

console.log("[toreroflow-worker] media pipeline worker listening on queue 'media'");
