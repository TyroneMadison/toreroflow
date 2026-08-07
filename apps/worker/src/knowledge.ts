import path from "node:path";
import fs from "node:fs/promises";
import { getPrisma } from "@toreroflow/db";
import { env } from "./env";
import { transcribe } from "./transcribe";

const prisma = getPrisma();

/** Enough for any brand document; past this the model context pays for filler. */
const MAX_EXTRACTED_CHARS = 100_000;

/**
 * Pull the words out of a dropped knowledge file so knowledgeContext() can
 * feed them to every consumer. Text and video are extracted locally today;
 * pdf extraction and image vision descriptions land in milestone E, so those
 * kinds go ready with empty text rather than sitting "processing" forever.
 */
export async function extractKnowledgeFile(knowledgeFileId: string): Promise<void> {
  const file = await prisma.knowledgeFile.findUnique({ where: { id: knowledgeFileId } });
  if (!file) return;

  const sourcePath = path.join(env.STORAGE_DIR, file.storageKey);

  try {
    let extractedText = "";

    if (file.kind === "text") {
      extractedText = (await fs.readFile(sourcePath, "utf8")).slice(0, MAX_EXTRACTED_CHARS);
    } else if (file.kind === "video") {
      const transcript = await transcribe(sourcePath);
      extractedText = (transcript?.segments ?? [])
        .map((s) => s.text)
        .join(" ")
        .slice(0, MAX_EXTRACTED_CHARS);
    }
    // pdf: extraction lands in milestone E (no pdf parser installed today).
    // image and other: vision description lands in milestone E.

    await prisma.knowledgeFile.update({
      where: { id: file.id },
      data: { extractedText, status: "ready" },
    });
    console.log(`[worker] knowledge file ${file.id} ready (${extractedText.length} chars)`);
  } catch (error) {
    console.error(`[worker] knowledge file ${knowledgeFileId} failed:`, error);
    await prisma.knowledgeFile.update({
      where: { id: knowledgeFileId },
      data: { status: "failed" },
    });
    throw error;
  }
}
