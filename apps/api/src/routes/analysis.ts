import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { z } from "zod";
import { toPlainText } from "@toreroflow/core";
import { getPrisma, groundingFor as grounding } from "@toreroflow/db";
import { env } from "../env";
import { fileLink, fileLinkVersioned } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";

/**
 * The AI video analyzer.
 *
 * One VideoAnalysis row per run: dropped files land under
 * storage/<clientId>/analysis/<id>/, existing uploads are analyzed in place
 * through mediaAssetId. The worker owns everything after the 201.
 *
 * The one exception is the spin-offs button at the bottom of this file, which
 * a person presses while reading a finished run. It is a small call about a
 * result that already exists, so it answers on the request rather than going
 * back through the queue for a job the operator would have to wait on.
 */

// The multipart plugin's global limit is 4GB for editor sources; the analyzer
// caps at 500MB on its own, so the cap is enforced by counting the bytes as
// they stream.
const MAX_ANALYSIS_BYTES = 500 * 1024 * 1024;

const fromMediaSchema = z.object({
  mediaAssetId: z.string().min(1),
});

/*
 * No minItems above 1 and no maxItems: structured output rejects both with a
 * 400 that costs the whole generation. Three is asked for in the prompt and
 * applied with .slice() on the way out, the same as the analyzer's own schema.
 */
const SPIN_OFFS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["spinOffs"],
  properties: {
    spinOffs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["idea", "hook"],
        properties: {
          idea: { type: "string", maxLength: 300 },
          hook: { type: "string", maxLength: 200 },
        },
      },
    },
  },
} as const;

/** The one 503 body every AI route answers with when the key is absent. */
const NO_KEY = {
  error: "this needs an Anthropic API key",
  detail: "Add ANTHROPIC_API_KEY to the repo root .env and restart the API.",
};

const REFUSED = {
  error: "the model declined",
  detail: "The model would not answer this one. Try wording it differently.",
};

/** The text block of a response, or an empty string when there is none. */
function textOf(response: { content: Array<{ type: string }> }): string {
  const block = response.content.find((c) => c.type === "text");
  return block && "text" in block ? String(block.text) : "";
}

/**
 * The parts of a stored result this file reads. The full shape is the
 * worker's, and it stays on the row untouched: what is written back here is a
 * spread of whatever was there with one field swapped.
 */
type StoredResult = {
  overview?: string;
  whatWorked?: string[];
  spinOffs?: { idea: string; hook: string }[];
  transcript?: { text: string }[];
};

/**
 * How much of the transcript the spin-off prompt carries.
 *
 * Enough for a couple of minutes of talking, which is every video the analyzer
 * takes in practice. A long one only needs its opening to suggest what comes
 * next, and the overview above it already says how the whole thing went.
 */
const TRANSCRIPT_CHARS = 4000;

export async function analysisRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const analyzeQueue = new Queue<{ analysisId: string }>("analyze", { connection });

  app.addHook("onRequest", requireAuth);

  /** Confirms the client belongs to the operator's workspace before anything else. */
  const ownedClient = async (clientId: string, agencyId: string) =>
    prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
      select: { id: true },
    });

  /**
   * The peak score off a finished run, for the list.
   *
   * The whole `result` blob is the detail screen's business; a wall of cards
   * only needs the one number, so the list does not carry a transcript per row.
   */
  const peakOf = (result: unknown): number | null => {
    const scores = (result as { scores?: { peak?: unknown } } | null)?.scores;
    return typeof scores?.peak === "number" ? scores.peak : null;
  };

  const analysisView = (a: {
    id: string;
    name: string;
    status: string;
    durationSec: number | null;
    thumbKey: string | null;
    result?: unknown;
    error: string | null;
    requestedAt: Date;
    completedAt: Date | null;
  }) => ({
    id: a.id,
    name: a.name,
    status: a.status,
    durationSec: a.durationSec,
    thumbUrl: a.thumbKey
      ? fileLinkVersioned(a.thumbKey, a.completedAt ? a.completedAt.getTime() : null)
      : null,
    peak: peakOf(a.result ?? null),
    error: a.error,
    requestedAt: a.requestedAt,
    completedAt: a.completedAt,
  });

  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/analyses",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const analyses = await prisma.videoAnalysis.findMany({
        where: { clientId: client.id },
        orderBy: { requestedAt: "desc" },
      });
      return analyses.map(analysisView);
    },
  );

  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/analyses",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });

      const file = await request.file();
      if (!file) return reply.status(400).send({ error: "no file uploaded" });
      const ext = path.extname(file.filename ?? "") || ".mp4";

      const analysis = await prisma.videoAnalysis.create({
        data: {
          clientId: client.id,
          name: file.filename ?? `video${ext}`,
          status: "running",
        },
      });
      const storageKey = `${client.id}/analysis/${analysis.id}/source${ext}`;
      const dir = path.join(env.STORAGE_DIR, client.id, "analysis", analysis.id);
      await fs.mkdir(dir, { recursive: true });

      let bytes = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          bytes += chunk.length;
          if (bytes > MAX_ANALYSIS_BYTES) return done(new Error("over the analyzer cap"));
          done(null, chunk);
        },
      });
      try {
        await pipeline(file.file, cap, createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
        if (file.file.truncated) throw new Error("over the multipart limit");
      } catch (err) {
        // A full disk and a permissions problem both land here too, and telling
        // someone their 40MB video is over a 500MB cap sends them off to
        // re-export it forever. Log the real reason, and only claim the cap
        // when the cap is what tripped.
        request.log.error({ err }, "analysis upload failed");
        await fs.rm(dir, { recursive: true, force: true });
        await prisma.videoAnalysis.delete({ where: { id: analysis.id } });
        const tooBig =
          err instanceof Error && /over the (analyzer cap|multipart limit)/.test(err.message);
        return tooBig
          ? reply.status(413).send({
              error: "file too large",
              detail: "The analyzer takes videos up to 500MB.",
            })
          : reply.status(500).send({
              error: "could not save that video",
              detail: "Something went wrong writing that file. Try it again.",
            });
      }

      const updated = await prisma.videoAnalysis.update({
        where: { id: analysis.id },
        data: { storageKey },
      });
      await analyzeQueue.add("analyze", { analysisId: analysis.id });
      return reply.status(201).send(analysisView(updated));
    },
  );

  /** Analyze a video already uploaded, without a second copy of the file. */
  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/analyses/from-media",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const parsed = fromMediaSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "nothing to analyze",
          detail: parsed.error.issues[0]?.message ?? "Pick an uploaded video.",
        });
      }
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: parsed.data.mediaAssetId, clientId: client.id },
      });
      if (!asset) return reply.status(404).send({ error: "asset not found" });
      if (asset.sourceDeletedAt) {
        return reply.status(404).send({
          error: "that video's file is gone",
          detail: "Its source was cleared after it posted, so there is nothing left to analyze.",
        });
      }

      const analysis = await prisma.videoAnalysis.create({
        data: {
          clientId: client.id,
          mediaAssetId: asset.id,
          name: asset.originalName,
          durationSec: asset.durationSec,
          status: "running",
        },
      });
      await analyzeQueue.add("analyze", { analysisId: analysis.id });
      return reply.status(201).send(analysisView(analysis));
    },
  );

  app.get<{ Params: { id: string } }>("/analyses/:id", async (request, reply) => {
    const analysis = await prisma.videoAnalysis.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!analysis) return reply.status(404).send({ error: "analysis not found" });

    // The detail screen plays the video beside the scores, and the key moment
    // pills seek it, so the row has to carry a playable link. A dropped run
    // holds its own copy; a from-media run borrows the upload's, which the
    // retention sweep may already have cleared out from under it.
    let playKey = analysis.storageKey;
    if (!playKey && analysis.mediaAssetId) {
      const asset = await prisma.mediaAsset.findUnique({
        where: { id: analysis.mediaAssetId },
        select: { storageKey: true, sourceDeletedAt: true },
      });
      playKey = asset && !asset.sourceDeletedAt ? asset.storageKey : null;
    }

    return {
      ...analysis,
      ...analysisView(analysis),
      videoUrl: playKey ? fileLink(playKey) : null,
    };
  });

  /**
   * Run it again.
   *
   * One route for both intakes: the row already knows where its video is, a
   * dropped file through `storageKey` and an existing upload through
   * `mediaAssetId`, so a retry never asks for the file a second time.
   */
  app.post<{ Params: { id: string } }>("/analyses/:id/retry", async (request, reply) => {
    const analysis = await prisma.videoAnalysis.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!analysis) return reply.status(404).send({ error: "analysis not found" });
    if (!analysis.storageKey && !analysis.mediaAssetId) {
      return reply.status(409).send({
        error: "nothing to read",
        detail: "This run has no video left to read, so it cannot be run again.",
      });
    }
    // Claim the row before enqueueing. A double click lands two POSTs before
    // either response re-renders the card, and both would otherwise queue the
    // same video: one upload, two analyzer bills. Moving the status check into
    // the write makes the claim atomic rather than a window between two
    // queries.
    const claimed = await prisma.videoAnalysis.updateMany({
      where: { id: analysis.id, status: { not: "running" } },
      data: { status: "running", error: null, completedAt: null },
    });
    if (!claimed.count) {
      return reply.status(409).send({
        error: "already running",
        detail: "This one is being read right now.",
      });
    }
    const updated = await prisma.videoAnalysis.findUniqueOrThrow({
      where: { id: analysis.id },
    });
    await analyzeQueue.add("analyze", { analysisId: analysis.id });
    return analysisView(updated);
  });

  /**
   * Three more spin-offs, written while the operator is reading the run.
   *
   * Grounded in both halves of the question: the video itself, through the
   * overview, what worked and what was actually said, and the brand's own
   * material, because a spin-off of a video has to sound like the account it
   * came from rather than like short form advice in general. The three already
   * on the row go into the prompt as the list not to write again, which is the
   * whole job of the button.
   *
   * The new three replace the old on the row rather than joining them. The
   * screen swaps its list for what comes back, so appending would leave the
   * row holding six while the operator looked at three, and the pair they had
   * just read would reappear the next time they opened the analysis. Anything
   * worth keeping is one press of Add to ideas away, and that is where a
   * spin-off was always going to end up.
   */
  app.post<{ Params: { id: string } }>("/analyses/:id/spin-offs", async (request, reply) => {
    const analysis = await prisma.videoAnalysis.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true, clientId: true, result: true, client: { select: { name: true } } },
    });
    if (!analysis) return reply.status(404).send({ error: "analysis not found" });

    const result = analysis.result as StoredResult | null;
    if (!result) {
      return reply.status(409).send({
        error: "nothing to spin off",
        detail: "This run has no analysis on it yet, so there is nothing to write from.",
      });
    }
    if (!env.ANTHROPIC_API_KEY) return reply.status(503).send(NO_KEY);

    const seen = (result.spinOffs ?? [])
      .map((s) => `- ${s.idea} (hook: ${s.hook})`)
      .join("\n");
    const worked = (result.whatWorked ?? []).map((w) => `- ${w}`).join("\n");
    const said = (result.transcript ?? [])
      .map((line) => line.text.trim())
      .filter(Boolean)
      .join(" ")
      .slice(0, TRANSCRIPT_CHARS);

    try {
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: env.SUGGESTIONS_MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: SPIN_OFFS_SCHEMA },
        },
        system:
          "You write the follow up videos one short form video earns, for the " +
          "person who filmed it.\n\n" +
          "Rules:\n" +
          "- A spin-off is the next video, not a summary of the one you are " +
          "reading. Same audience, same voice, a different angle on the subject.\n" +
          "- The idea is one plain sentence saying what the video is.\n" +
          "- The hook is its first line, spoken out loud, six to fifteen words. It " +
          "has to be specific to this brand's niche. A hook that would fit any " +
          "account is a wasted hook.\n" +
          "- Do not write a spin-off the operator has already been given, and do " +
          "not write one of them again in different words.\n" +
          "- No hashtags, no emoji, no all caps, no marketing language.\n" +
          "- Never use an em dash, an en dash or an arrow. Use commas and full stops.\n" +
          "- Use the brand's own material below. Do not invent facts, statistics, " +
          "prices or claims that are not in it.",
        messages: [
          {
            role: "user",
            content:
              `Brand: ${analysis.client.name}\n` +
              `How the video went: ${result.overview ?? "No overview was written."}\n` +
              (worked ? `What worked in it:\n${worked}\n` : "") +
              (said ? `\nWhat the video said:\n${said}\n` : "") +
              (seen
                ? `\nSpin-offs the operator has already read. Write none of these:\n${seen}\n`
                : "") +
              `\nWrite 3 new spin-offs.\n\n${await grounding(prisma, analysis.clientId)}`,
          },
        ],
      });
      if (response.stop_reason === "refusal") return reply.status(502).send(REFUSED);

      const raw = JSON.parse(textOf(response) || "{}") as { spinOffs?: unknown[] };
      const spinOffs = (raw.spinOffs ?? [])
        .slice(0, 3)
        .map((entry) => {
          const s = (entry ?? {}) as Record<string, unknown>;
          return {
            idea: toPlainText(String(s.idea ?? "")),
            hook: toPlainText(String(s.hook ?? "")),
          };
        })
        .filter((s) => s.idea);

      // Nothing usable came back, so the row keeps what it had. The new three
      // replace the old on the row, and an empty replacement would delete the
      // spin-offs the operator was reading with no way to get them back short
      // of running the whole analysis again.
      if (!spinOffs.length) {
        return reply.status(502).send({
          error: "no spin-offs came back",
          detail: "Nothing usable came back that time. Try it again.",
        });
      }

      // Written before the response goes out: the screen holds these in local
      // state only, so a generation that was paid for would be gone the moment
      // the operator left the analysis.
      await prisma.videoAnalysis.update({
        where: { id: analysis.id },
        data: { result: { ...result, spinOffs } },
      });
      return { spinOffs };
    } catch (err) {
      request.log.error({ err }, "could not write more spin-offs");
      return reply.status(502).send({
        error: "could not write more ideas",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.delete<{ Params: { id: string } }>("/analyses/:id", async (request, reply) => {
    const analysis = await prisma.videoAnalysis.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!analysis) return reply.status(404).send({ error: "analysis not found" });
    await prisma.videoAnalysis.delete({ where: { id: analysis.id } });
    // Every run keeps its files (dropped source, thumb) under its own
    // directory; from-media runs never touch the upload they point at.
    await fs.rm(path.join(env.STORAGE_DIR, analysis.clientId, "analysis", analysis.id), {
      recursive: true,
      force: true,
    });
    return { ok: true };
  });
}
