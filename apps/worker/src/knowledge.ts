import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { getPrisma } from "@toreroflow/db";
import { env } from "./env";
import { transcribe } from "./transcribe";

const prisma = getPrisma();

/** Enough for any brand document; past this the model context pays for filler. */
const MAX_EXTRACTED_CHARS = 100_000;

const run = promisify(execFile);

/** Resolved per call so dotenv has run and an operator can point at their own copy. */
const pdftotextBin = (): string => process.env.PDFTOTEXT_PATH ?? "pdftotext";

/**
 * The image formats the vision API accepts, by extension.
 *
 * Anything else dropped in goes ready with no text rather than failing: a
 * knowledge base is a pile of whatever the operator had, not a validated
 * upload form.
 */
const IMAGE_MEDIA_TYPES: Record<string, "image/jpeg" | "image/png" | "image/gif" | "image/webp"> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * The vision API refuses a base64 image over 5MB, and base64 is a third
 * bigger than the file. Above this the describe call is skipped rather than
 * spent and rejected.
 */
const MAX_IMAGE_BYTES = 3_500_000;

/**
 * The words out of a PDF, or nothing.
 *
 * pdftotext ships with poppler-utils, which the server image installs and a
 * Windows machine may not have. A missing binary, an encrypted file and a
 * scan with no text layer all reach the same place: an empty string, a ready
 * row, and "No text found" on the file in the list. None of those is a reason
 * to fail the drop, and none of them is worth paying an OCR bill for on the
 * chance the file mattered.
 */
async function pdfText(sourcePath: string): Promise<string> {
  try {
    const { stdout } = await run(
      pdftotextBin(),
      ["-q", "-enc", "UTF-8", sourcePath, "-"],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    return stdout;
  } catch (error) {
    console.warn(`[worker] pdftotext could not read ${path.basename(sourcePath)}:`, error);
    return "";
  }
}

/**
 * One sentence-or-three description of an image, so it can be retrieved.
 *
 * This is the only place ingestion spends money, which is why the drop zone
 * says so out loud. It describes rather than interprets: what is in the
 * picture and what text is on it, because that is what a later prompt will be
 * searching this row for.
 */
async function imageText(sourcePath: string, name: string): Promise<string> {
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(sourcePath).toLowerCase()];
  if (!mediaType) return "";
  if (!env.ANTHROPIC_API_KEY) {
    console.warn("[worker] no Anthropic key, so images go in without a description");
    return "";
  }

  const bytes = await fs.readFile(sourcePath);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    console.warn(`[worker] ${name} is too large to describe (${bytes.byteLength} bytes)`);
    return "";
  }

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: env.COPY_MODEL,
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
          },
          {
            type: "text",
            text:
              "Describe this image so someone can find it again later by what is in it. " +
              "Say what it shows, then write out any text that appears in it, word for word. " +
              "Plain sentences, no headings, no lists, no guessing at anything you cannot see.",
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") return "";
  const block = response.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}

/**
 * Pull the words out of a dropped knowledge file so knowledgeContext() can
 * feed them to every consumer.
 *
 * Every kind lands on `ready`, with or without text. A row stuck at
 * `processing` is a spinner the operator has to guess about; a ready row with
 * nothing in it says "No text found" on the screen and is honest.
 */
export async function extractKnowledgeFile(knowledgeFileId: string): Promise<void> {
  const file = await prisma.knowledgeFile.findUnique({ where: { id: knowledgeFileId } });
  if (!file) return;

  const sourcePath = path.join(env.STORAGE_DIR, file.storageKey);

  try {
    let extractedText = "";

    if (file.kind === "text") {
      extractedText = await fs.readFile(sourcePath, "utf8");
    } else if (file.kind === "video") {
      const transcript = await transcribe(sourcePath);
      extractedText = (transcript?.segments ?? []).map((s) => s.text).join(" ");
    } else if (file.kind === "pdf") {
      extractedText = await pdfText(sourcePath);
    } else if (file.kind === "image") {
      extractedText = await imageText(sourcePath, file.name);
    }
    // "other": nothing here can read it, so it goes ready with no text.

    await prisma.knowledgeFile.update({
      where: { id: file.id },
      data: { extractedText: extractedText.slice(0, MAX_EXTRACTED_CHARS), status: "ready" },
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
