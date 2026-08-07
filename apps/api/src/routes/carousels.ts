import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  carouselDraftSchema,
  csvFileName,
  MAX_CAROUSEL_SLIDES,
  toPlainText,
  toCanvaCsv,
  type CarouselSlide,
} from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { env } from "../env";
import { groundingFor } from "../knowledge/grounding";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Carousels, and the knowledge they are written from.
 *
 * The app writes words and hands over a spreadsheet. Canva's bulk create turns
 * that spreadsheet into designs, one row per slide. Deliberately not a Canva
 * integration: a CSV can be read, edited and re-imported by hand, and the
 * template stays where the designer works.
 *
 * Generation is done in the request rather than on a queue, and the draft is
 * written before the response is sent. Closing the screen therefore cannot
 * lose a generation that has already been paid for.
 */

const SLIDES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slides", "caption", "hashtags"],
  properties: {
    slides: {
      type: "array",
      /*
       * No length bounds here on purpose: structured output supports a
       * minItems of 0 or 1 and no maxItems at all, and sending either is a
       * 400 that costs the whole generation. How many slides are wanted is
       * asked for in the prompt, and the ceiling is applied to the result.
       */
      items: {
        type: "object",
        additionalProperties: false,
        required: ["headline", "body"],
        properties: {
          headline: { type: "string", maxLength: 90 },
          body: { type: "string", maxLength: 220 },
        },
      },
    },
    caption: { type: "string", maxLength: 1200 },
    hashtags: { type: "array", items: { type: "string", maxLength: 40 } },
  },
} as const;

const noteSchema = z.object({
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(20_000),
});

const generateSchema = z.object({
  topic: z.string().min(1).max(200),
  slideCount: z.number().int().min(3).max(MAX_CAROUSEL_SLIDES).default(7),
});

export async function carouselRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.addHook("onRequest", requireAuth);

  /** Confirms the client belongs to the operator's workspace before anything else. */
  const ownedClient = async (clientId: string, agencyId: string) =>
    prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
      select: { id: true, name: true },
    });

  /* ---- the knowledge base ---- */

  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/knowledge",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      return prisma.knowledgeNote.findMany({
        where: { clientId: client.id },
        orderBy: { createdAt: "desc" },
      });
    },
  );

  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/knowledge",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const parsed = noteSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "that note could not be saved",
          detail: parsed.error.issues[0]?.message ?? "A note needs a title and something in it.",
        });
      }
      return reply.status(201).send(
        await prisma.knowledgeNote.create({
          data: { clientId: client.id, ...parsed.data },
        }),
      );
    },
  );

  app.delete<{ Params: { clientId: string; noteId: string } }>(
    "/clients/:clientId/knowledge/:noteId",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const { count } = await prisma.knowledgeNote.deleteMany({
        where: { id: request.params.noteId, clientId: client.id },
      });
      if (!count) return reply.status(404).send({ error: "note not found" });
      return { ok: true };
    },
  );

  /* ---- carousels ---- */

  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/carousels",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      return prisma.carouselDraft.findMany({
        where: { clientId: client.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    },
  );

  /**
   * Writes one carousel from what is known about the brand.
   *
   * Everything the model is given is the operator's own material: the notes
   * they wrote and the accounts the client named as inspiration. Nothing is
   * copied from those accounts, only the fact that they are the reference.
   */
  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/carousels",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });

      const parsed = generateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "that carousel could not be written",
          detail: parsed.error.issues[0]?.message ?? "Give it a topic.",
        });
      }
      if (!env.ANTHROPIC_API_KEY) {
        return reply.status(503).send({
          error: "writing carousels needs an Anthropic API key",
          detail: "Add ANTHROPIC_API_KEY to the repo root .env and restart the API.",
        });
      }

      // The same block every other AI feature reads. This used to be typed
      // notes only, so a brand whose knowledge lived in its niche profile and
      // its dropped files wrote its carousels on nothing at all.
      const [knowledge, inspirations] = await Promise.all([
        groundingFor(client.id),
        prisma.inspirationAccount.findMany({
          where: { clientId: client.id },
          select: { platform: true, handle: true },
          take: 10,
        }),
      ]);

      const references = inspirations.length
        ? inspirations.map((i) => `${i.platform} @${i.handle}`).join(", ")
        : "none named";

      try {
        const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
          model: env.SUGGESTIONS_MODEL,
          max_tokens: 2048,
          thinking: { type: "adaptive" },
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: SLIDES_SCHEMA },
          },
          system:
            "You write Instagram carousels for a short form video agency's client. " +
            "Each slide is a picture with a few words on it, so the words have to " +
            "carry the whole idea on their own.\n\n" +
            "Rules:\n" +
            "- Slide 1 is the hook. It has to stop a thumb on its own.\n" +
            "- The last slide asks for one thing, and only one.\n" +
            "- A headline is a few words, never a paragraph. The body is one " +
            "short sentence, and may be empty when the headline says it all.\n" +
            "- Plain English a 12 year old reads without stopping. No jargon, " +
            "no buzzwords, no hype.\n" +
            "- Never use an em dash, an en dash or an arrow. Use commas and " +
            "full stops.\n" +
            "- Use the brand's own knowledge below. Do not invent facts, " +
            "statistics, prices or claims that are not in it.\n" +
            "- The caption is for the post itself and repeats none of the slides.",
          messages: [
            {
              role: "user",
              content:
                `Brand: ${client.name}\n` +
                `Accounts they want to be like: ${references}\n` +
                `Slides wanted: ${parsed.data.slideCount}\n` +
                `Topic: ${parsed.data.topic}\n\n` +
                (knowledge ? `What we know about this brand and its niche:\n${knowledge}` : ""),
            },
          ],
        });

        const block = response.content.find((c) => c.type === "text");
        const raw = JSON.parse(block && "text" in block ? block.text : "{}") as {
          slides?: unknown[];
          hashtags?: unknown[];
        };

        /*
         * Trimmed to the ceiling rather than refused.
         *
         * Operator input is refused when it breaks a rule, because they can
         * fix it. A model returning an extra slide is not something anyone
         * typed, and throwing away a generation that has already been paid for
         * to punish it helps nobody.
         */
        const written = carouselDraftSchema.parse({
          ...raw,
          topic: parsed.data.topic,
          slides: (raw.slides ?? []).slice(0, MAX_CAROUSEL_SLIDES),
          hashtags: (raw.hashtags ?? []).slice(0, 30),
        });

        // The same punctuation lock the client-facing game plan uses: a stray
        // em dash from a model is not something to leave for a human to catch.
        const slides: CarouselSlide[] = written.slides.map((s) => ({
          headline: toPlainText(s.headline),
          body: toPlainText(s.body ?? ""),
        }));

        return reply.status(201).send(
          await prisma.carouselDraft.create({
            data: {
              clientId: client.id,
              topic: written.topic,
              slides,
              caption: toPlainText(written.caption ?? ""),
              hashtags: written.hashtags.map((h) => h.replace(/^#+/, "").trim()).filter(Boolean),
            },
          }),
        );
      } catch (err) {
        app.log.error({ err }, "could not write the carousel");
        return reply.status(502).send({
          error: "could not write the carousel",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /** Edits the words after the fact. The model writes a first draft, not the last one. */
  app.patch<{ Params: { id: string } }>("/carousels/:id", async (request, reply) => {
    const existing = await prisma.carouselDraft.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!existing) return reply.status(404).send({ error: "carousel not found" });

    const parsed = carouselDraftSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "that change could not be saved",
        detail:
          parsed.error.issues[0]?.message ??
          `A carousel needs between 1 and ${MAX_CAROUSEL_SLIDES} slides.`,
      });
    }
    return prisma.carouselDraft.update({ where: { id: existing.id }, data: parsed.data });
  });

  app.delete<{ Params: { id: string } }>("/carousels/:id", async (request, reply) => {
    const { count } = await prisma.carouselDraft.deleteMany({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!count) return reply.status(404).send({ error: "carousel not found" });
    return { ok: true };
  });

  /**
   * The bulk create sheet.
   *
   * Sent as a file download rather than JSON, because its whole purpose is to
   * be dropped into Canva.
   */
  app.get<{ Params: { id: string } }>("/carousels/:id/csv", async (request, reply) => {
    const draft = await prisma.carouselDraft.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!draft) return reply.status(404).send({ error: "carousel not found" });

    const csv = toCanvaCsv({
      topic: draft.topic,
      slides: draft.slides as unknown as CarouselSlide[],
    });
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="${csvFileName(draft.topic, draft.createdAt.toISOString())}"`,
      )
      .send(csv);
  });
}
