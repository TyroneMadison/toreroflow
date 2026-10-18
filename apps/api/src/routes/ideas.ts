import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  cleanCreatorLinks,
  parseCreatorLink,
  toPlainText,
  CREATOR_LINK_CAP,
  topicKeywords,
  VIDEO_FORMATS,
  FUNNEL_STAGES,
  DIFFICULTIES,
  DIFFICULTY_RUBRIC,
  NEEDS_RULES,
  funnelPromptGuide,
  reconcileFunnel,
  cleanNeeds,
  needsLoad,
  checkDifficulty,
  enforceMix,
  SUPERGEN_CAP_MAX,
  SUPERGEN_CAP_MIN,
} from "@toreroflow/core";
import { getPrisma, groundingFor as grounding, enqueue, Prisma } from "@toreroflow/db";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

/**
 * The ideas list, the niche profile, the files side of the knowledge base, and
 * the three model calls that fill the Ideas screen: formats with hooks, a
 * script for one idea, and the brainstorm chat.
 *
 * KnowledgeNote routes stay in carousels.ts; these are the dropped files whose
 * contents the knowledge worker extracts once, on drop.
 *
 * Every model call here is pressed by a person and grounded in the same block:
 * the brand's notes, its dropped files, its niche profile and the ideas it
 * already has open. Nothing generates on a timer, and nothing is written from
 * material the operator did not put in.
 */

const IDEA_STATUSES = ["idea", "scripting", "ready", "posted", "analyzed"] as const;

const ideaCreateSchema = z.object({
  text: z.string().min(1).max(500),
  hook: z.string().max(500).optional(),
  formatName: z.string().max(120).optional(),
  niche: z.string().max(200).optional(),
  source: z.enum(["brainstorm", "analysis", "overview", "custom"]).optional(),
  scriptText: z.string().max(4000).optional(),
  creator: z.string().max(120).optional(),
  funnelStage: z.enum(["top", "middle", "bottom"]).optional(),
  whyItWorks: z.string().max(400).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  remixedFromId: z.string().max(40).optional(),
  needs: z.array(z.object({ type: z.enum(["prop", "location", "people"]), label: z.string().min(1).max(40) })).max(4).optional(),
  shots: z.array(z.record(z.string(), z.string().max(120))).max(8).optional(),
});

const ideaPatchSchema = z.object({
  status: z.enum(IDEA_STATUSES).optional(),
  text: z.string().min(1).max(500).optional(),
  hook: z.string().max(500).optional(),
  completed: z.boolean().optional(),
});

const nicheProfileSchema = z.object({
  niche: z.string().max(2000),
  audience: z.string().max(2000).optional(),
  outcome: z.string().max(2000).optional(),
  voiceTags: z.array(z.string().max(60)).max(20).optional(),
  filming: z.array(z.string().max(60)).max(20).optional(),
  faceless: z.boolean().optional(),
});

const generateIdeasSchema = z.object({
  categories: z.array(z.string().min(1).max(40)).max(20).default([]),
  /** The format to write more hooks for, by name. Absent means a fresh set. */
  formatId: z.string().max(120).optional(),
  /** Hooks the operator can already see, so the next batch is not the same four. */
  exclude: z.array(z.string().max(200)).max(40).default([]),
  more: z.boolean().optional(),
  /** Brainstorm context typed in the Ideas section. Absent for every other button. */
  niche: z.string().max(200).optional(),
  inspirations: z.array(z.string().max(300)).max(12).default([]),
});

const brainstormSchema = z.object({
  message: z.string().min(1).max(2000),
  /** An existing thread to continue. Absent starts a new one. */
  chatId: z.string().max(60).optional(),
  /**
   * Only used to open a thread. Once one exists the stored copy is what the
   * next turn is built from, because that is the half nothing else can edit.
   */
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(6000),
      }),
    )
    .max(200)
    .default([]),
});

type ChatTurn = { role: "user" | "assistant"; content: string };

/** How many turns a stored thread keeps, oldest dropped first. */
const MAX_STORED_TURNS = 200;

/** The list needs a name for a thread and the operator never types one. */
function chatTitle(firstMessage: string): string {
  const clean = firstMessage.trim().replace(/\s+/g, " ");
  return clean.length <= 80 ? clean : `${clean.slice(0, 79).trimEnd()}...`;
}

/*
 * No minItems above 1 and no maxItems anywhere: structured output rejects both
 * with a 400 that costs the whole generation. How many formats, hooks, beats
 * and shots are wanted is asked for in the prompt and applied with .slice() on
 * the way out.
 */
const FORMATS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["formats"],
  properties: {
    formats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "category", "description", "hooks"],
        properties: {
          name: { type: "string", maxLength: 90 },
          category: { type: "string", maxLength: 40 },
          description: { type: "string", maxLength: 400 },
          hooks: { type: "array", items: { type: "string", maxLength: 200 } },
        },
      },
    },
  },
} as const;

const SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hook", "beats", "shotList", "caption"],
  properties: {
    hook: { type: "string", maxLength: 200 },
    beats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "line"],
        properties: {
          label: { type: "string", maxLength: 60 },
          line: { type: "string", maxLength: 500 },
        },
      },
    },
    shotList: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["shot", "note"],
        properties: {
          shot: { type: "string", maxLength: 120 },
          note: { type: "string", maxLength: 300 },
        },
      },
    },
    caption: { type: "string", maxLength: 1200 },
  },
} as const;

/** The one 503 body every AI route here answers with when the key is absent. */
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

const KNOWLEDGE_KINDS: Record<string, string> = {
  ".pdf": "pdf",
  ".txt": "text",
  ".md": "text",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".webp": "image",
};

export async function ideasRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.addHook("onRequest", requireAuth);

  /** Confirms the client belongs to the operator's workspace before anything else. */
  const ownedClient = async (clientId: string, agencyId: string) =>
    prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
      select: { id: true, name: true },
    });

  /* ---- ideas ---- */

  app.get<{ Params: { clientId: string }; Querystring: { status?: string; q?: string } }>(
    "/clients/:clientId/ideas",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const { status, q } = request.query;
      return prisma.contentIdea.findMany({
        where: {
          clientId: client.id,
          ...(status ? { status } : {}),
          ...(q
            ? {
                OR: [
                  { text: { contains: q, mode: "insensitive" } },
                  { hook: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
    },
  );

  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/ideas",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const parsed = ideaCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "that idea could not be saved",
          detail: parsed.error.issues[0]?.message ?? "An idea is a line of text, up to 500 characters.",
        });
      }
      const created = await prisma.contentIdea.create({
        data: { clientId: client.id, ...parsed.data },
      });
      if (created.scriptText) await enqueue("ideagifs", { ideaId: created.id }, { key: `gifs-${created.id}` });
      return reply.status(201).send(created);
    },
  );

  app.patch<{ Params: { id: string } }>("/ideas/:id", async (request, reply) => {
    const existing = await prisma.contentIdea.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!existing) return reply.status(404).send({ error: "idea not found" });
    const parsed = ideaPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "that change could not be saved",
        detail: parsed.error.issues[0]?.message ?? "An idea's status is one of the five on the board.",
      });
    }
    return prisma.contentIdea.update({ where: { id: existing.id }, data: parsed.data });
  });

  app.post<{ Params: { id: string } }>("/ideas/:id/gifs", async (request, reply) => {
    const idea = await prisma.contentIdea.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!idea) return reply.status(404).send({ error: "idea not found" });
    await prisma.contentIdea.update({ where: { id: idea.id }, data: { gifs: Prisma.DbNull } });
    await enqueue("ideagifs", { ideaId: idea.id }, { key: `gifs-${idea.id}-${Date.now()}` });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/ideas/:id", async (request, reply) => {
    const { count } = await prisma.contentIdea.deleteMany({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!count) return reply.status(404).send({ error: "idea not found" });
    return { ok: true };
  });

  /* ---- the niche profile ---- */

  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/niche-profile",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.clientId, agencyId: request.user.agencyId, deletedAt: null },
        select: { nicheProfile: true },
      });
      if (!client) return reply.status(404).send({ error: "brand not found" });
      return { nicheProfile: client.nicheProfile };
    },
  );

  // PUT rather than PATCH: the form submits the whole profile every time.
  app.put<{ Params: { clientId: string } }>(
    "/clients/:clientId/niche-profile",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const parsed = nicheProfileSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "that profile could not be saved",
          detail: parsed.error.issues[0]?.message ?? "The niche is a short description, up to 2000 characters.",
        });
      }
      const updated = await prisma.client.update({
        where: { id: client.id },
        data: { nicheProfile: parsed.data },
        select: { nicheProfile: true },
      });
      return { nicheProfile: updated.nicheProfile };
    },
  );

  /* ---- knowledge files ---- */

  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/knowledge-files",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      return prisma.knowledgeFile.findMany({
        where: { clientId: client.id },
        // The extracted text is prompt fodder for the workers, not something
        // the list screen renders, and a dropped PDF's worth of it per row
        // would bloat every refresh.
        select: { id: true, name: true, kind: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
    },
  );

  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/knowledge-files",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });

      const file = await request.file();
      if (!file) return reply.status(400).send({ error: "no file uploaded" });
      const ext = path.extname(file.filename ?? "").toLowerCase();
      const name = file.filename ?? `file${ext}`;

      const row = await prisma.knowledgeFile.create({
        data: {
          clientId: client.id,
          name,
          kind: KNOWLEDGE_KINDS[ext] ?? "other",
          storageKey: "pending",
          status: "processing",
        },
      });
      const storageKey = `${client.id}/knowledge/${row.id}${ext}`;
      try {
        await fs.mkdir(path.join(env.STORAGE_DIR, client.id, "knowledge"), { recursive: true });
        await pipeline(file.file, createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
        if (file.file.truncated) throw new Error("over the multipart limit");
      } catch (err) {
        // The row exists before the bytes land, so the file has an id to be
        // named after. If the stream dies part way, a closed app or a full
        // disk, that row would sit on "processing" with no job to move it and
        // the drop zone would read "Reading it..." on every later visit, so
        // the row and whatever reached the disk both go back.
        request.log.error({ err }, "knowledge upload failed");
        await fs.rm(path.join(env.STORAGE_DIR, storageKey), { force: true });
        await prisma.knowledgeFile.delete({ where: { id: row.id } });
        return err instanceof Error && err.message === "over the multipart limit"
          ? reply.status(413).send({ error: "file too large" })
          : reply.status(500).send({
              error: "could not save that file",
              detail: "Something went wrong writing that file. Try it again.",
            });
      }

      const updated = await prisma.knowledgeFile.update({
        where: { id: row.id },
        data: { storageKey },
      });
      await enqueue("knowledge", { knowledgeFileId: row.id });
      return reply.status(201).send(updated);
    },
  );

  app.delete<{ Params: { clientId: string; fileId: string } }>(
    "/clients/:clientId/knowledge-files/:fileId",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const row = await prisma.knowledgeFile.findFirst({
        where: { id: request.params.fileId, clientId: client.id },
      });
      if (!row) return reply.status(404).send({ error: "file not found" });
      await prisma.knowledgeFile.delete({ where: { id: row.id } });
      if (row.storageKey !== "pending") {
        await fs.rm(path.join(env.STORAGE_DIR, row.storageKey), { force: true });
      }
      return { ok: true };
    },
  );

  /* ---- save vs skip feedback (quiet preference profile) ---- */

  const feedbackSchema = z.object({
    runId: z.string().max(64).default(""),
    events: z.array(z.object({
      text: z.string().min(1).max(500),
      format: z.string().max(60).optional(),
      funnelStage: z.string().max(10).optional(),
      hookStyle: z.string().max(120).optional(),
      creator: z.string().max(120).optional(),
      saved: z.boolean(),
    })).max(40),
  });

  app.post<{ Params: { clientId: string } }>("/clients/:clientId/idea-feedback", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found" });
    const parsed = feedbackSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "feedback not recorded" });
    const { runId, events } = parsed.data;
    for (const e of events) {
      const textKey = e.text.trim().toLowerCase().slice(0, 300);
      const data = {
        format: e.format ?? null, funnelStage: e.funnelStage ?? null, hookStyle: e.hookStyle ?? null,
        creator: e.creator ?? null, keywords: topicKeywords(e.text),
      };
      await prisma.ideaFeedback.upsert({
        where: { clientId_runId_textKey: { clientId: client.id, runId, textKey } },
        create: { clientId: client.id, runId, textKey, saved: e.saved, ...data },
        // A save always wins over an earlier skip; a skip never undoes a save.
        update: e.saved ? { saved: true } : {},
      });
    }
    return { ok: true, recorded: events.length };
  });

  /* ---- creator links and Super generate ---- */

  const creatorsSchema = z.object({
    creators: z.array(z.string().max(300)).max(CREATOR_LINK_CAP * 2).optional(),
    capCents: z.number().int().min(SUPERGEN_CAP_MIN).max(SUPERGEN_CAP_MAX).optional(),
  });

  const readiness = () => ({
    youtubeReady: Boolean(env.YOUTUBE_API_KEY),
    modelReady: Boolean(env.ANTHROPIC_API_KEY),
  });

  app.get<{ Params: { clientId: string } }>("/clients/:clientId/idea-creators", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.clientId, agencyId: request.user.agencyId, deletedAt: null },
      select: { ideaCreators: true, superGenCapCents: true },
    });
    if (!client) return reply.status(404).send({ error: "brand not found" });
    return { creators: client.ideaCreators, capCents: client.superGenCapCents, ...readiness() };
  });

  app.put<{ Params: { clientId: string } }>("/clients/:clientId/idea-creators", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found" });
    const parsed = creatorsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "those creators could not be saved",
        detail: parsed.error.issues[0]?.message ?? "Up to 15 channel links, and a cap between $0.10 and $50.",
      });
    }
    const updated = await prisma.client.update({
      where: { id: client.id },
      data: {
        ...(parsed.data.creators ? { ideaCreators: cleanCreatorLinks(parsed.data.creators) } : {}),
        ...(parsed.data.capCents !== undefined ? { superGenCapCents: parsed.data.capCents } : {}),
      },
      select: { ideaCreators: true, superGenCapCents: true },
    });
    return { creators: updated.ideaCreators, capCents: updated.superGenCapCents, ...readiness() };
  });

  const runView = (r: {
    id: string; status: string; creators: unknown; ideas: unknown; capCents: number;
    spentCents: number; error: string | null; createdAt: Date; completedAt: Date | null;
  }) => ({ ...r });

  app.get<{ Params: { clientId: string } }>("/clients/:clientId/super-generate", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found" });
    const run = await prisma.superGenerateRun.findFirst({
      where: { clientId: client.id },
      orderBy: { createdAt: "desc" },
    });
    return { run: run ? runView(run) : null, ...readiness() };
  });

  app.post<{ Params: { clientId: string } }>("/clients/:clientId/super-generate", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.clientId, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true, ideaCreators: true, superGenCapCents: true },
    });
    if (!client) return reply.status(404).send({ error: "brand not found" });
    if (!env.YOUTUBE_API_KEY) {
      return reply.status(503).send({
        code: "no_youtube_key",
        error: "Super generate needs a YouTube API key",
        detail: "Add YOUTUBE_API_KEY to infra/.env on the server and restart the API and worker.",
      });
    }
    if (!env.ANTHROPIC_API_KEY) return reply.status(503).send(NO_KEY);
    const only = typeof (request.body as { creator?: unknown } | null)?.creator === "string"
      ? String((request.body as { creator: string }).creator)
      : null;
    const all = cleanCreatorLinks(client.ideaCreators);
    const onlyKey = only ? (parseCreatorLink(only)?.url ?? only.trim().toLowerCase()) : null;
    const links = onlyKey ? all.filter((u) => (parseCreatorLink(u)?.url ?? u.trim().toLowerCase()) === onlyKey) : all;
    if (onlyKey && links.length === 0) {
      return reply.status(400).send({ error: "that creator is not in your list", detail: "Add the link first, then generate." });
    }
    if (links.length === 0) {
      return reply.status(400).send({ error: "add a creator first", detail: "Paste at least one YouTube channel link." });
    }
    const busy = await prisma.superGenerateRun.findFirst({
      where: { clientId: client.id, status: "running", createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) } },
    });
    if (busy) return { run: runView(busy), ...readiness() };
    const creators = links.map((url) => {
      const l = parseCreatorLink(url);
      return { url, handle: l?.handle ?? url, platform: l?.platform ?? "other", status: "queued", videos: 0, note: "" };
    });
    const run = await prisma.superGenerateRun.create({
      data: { clientId: client.id, creators, capCents: client.superGenCapCents },
    });
    await enqueue("supergen", { runId: run.id }, { key: run.id });
    return { run: runView(run), ...readiness() };
  });

  app.post<{ Params: { id: string } }>("/super-generate/:id/cancel", async (request, reply) => {
    const run = await prisma.superGenerateRun.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!run) return reply.status(404).send({ error: "run not found" });
    if (run.status !== "running") return { run: runView(run) };
    const updated = await prisma.superGenerateRun.update({
      where: { id: run.id },
      data: { status: "cancelled", completedAt: new Date() },
    });
    return { run: runView(updated) };
  });

  /* ---- formats and hooks ---- */

  /**
   * Names three repeatable formats and writes four sayable hooks for each.
   *
   * With `formatId` it does the narrow job instead: four more hooks for the
   * one format the operator is looking at. Formats are not rows, so the id is
   * the format's own name, echoed back so the screen can match it up, and the
   * hooks already on the screen come up in `exclude`, because a model cannot
   * avoid repeating what it was never shown.
   */
  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/generate-ideas",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });

      const parsed = generateIdeasSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "those ideas could not be written",
          detail: parsed.error.issues[0]?.message ?? "Pick a content style, or let it pick for you.",
        });
      }
      if (!env.ANTHROPIC_API_KEY) return reply.status(503).send(NO_KEY);

      const { categories, formatId, exclude, more, niche, inspirations } = parsed.data;
      const context =
        (niche?.trim() ? `Niche the operator typed for this brainstorm: ${niche.trim()}.\n` : "") +
        (inspirations.length
          ? `Creators that inspire this brand (borrow the shape and energy of their formats, never their words): ${inspirations.join(", ")}.\n`
          : "");
      const job = formatId
        ? `Write 4 more hooks for the format called "${formatId}". Return that one ` +
          `format only, keeping its name, with 4 hooks the operator has not seen.` +
          (exclude.length
            ? " These are the ones already on their screen, so none of them come " +
              `back, in any wording:\n${exclude.map((h) => `- ${h}`).join("\n")}`
            : "")
        : `Name 3 formats, each with 4 hooks.` +
          (more
            ? " These come after a set the operator has already read, so pick shapes " +
              "that set would not have used."
            : "");
      const styles = categories.length
        ? `Content styles to work in: ${categories.join(", ")}.`
        : "Pick the content styles yourself, whichever suit this brand.";

      try {
        const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
          model: env.SUGGESTIONS_MODEL,
          max_tokens: 2048,
          thinking: { type: "adaptive" },
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: FORMATS_SCHEMA },
          },
          system:
            "You name short form video formats for one brand and write the hooks " +
            "that open them.\n\n" +
            "Rules:\n" +
            "- A format is a repeatable shape a person can film again and again, " +
            "not a single video. Name it in a few words.\n" +
            "- The description is one or two plain sentences saying how the format " +
            "works and why it holds attention.\n" +
            "- A hook is the first line of the video, spoken out loud, six to " +
            "fifteen words. It has to be specific to this brand's niche. A hook " +
            "that would fit any account is a wasted hook.\n" +
            "- No hashtags, no emoji, no all caps, no marketing language.\n" +
            "- Never use an em dash, an en dash or an arrow. Use commas and full stops.\n" +
            "- Use the brand's own material below. Do not invent facts, statistics, " +
            "prices or claims that are not in it.\n" +
            "- Do not repeat a hook the brand already has among its open ideas.",
          messages: [
            {
              role: "user",
              content: `Brand: ${client.name}\n${context}${styles}\n${job}\n\n${await grounding(prisma, client.id)}`,
            },
          ],
        });
        if (response.stop_reason === "refusal") return reply.status(502).send(REFUSED);

        const raw = JSON.parse(textOf(response) || "{}") as { formats?: unknown[] };
        const formats = (raw.formats ?? []).slice(0, formatId ? 1 : 3).map((entry) => {
          const f = (entry ?? {}) as Record<string, unknown>;
          return {
            name: toPlainText(String(f.name ?? "")),
            category: toPlainText(String(f.category ?? "")),
            description: toPlainText(String(f.description ?? "")),
            hooks: (Array.isArray(f.hooks) ? f.hooks : [])
              .slice(0, 4)
              .map((h) => toPlainText(String(h)))
              .filter(Boolean),
          };
        });
        return { formats };
      } catch (err) {
        request.log.error({ err }, "could not write the formats");
        return reply.status(502).send({
          error: "could not write the formats",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /* ---- one idea, scripted ---- */

  /**
   * Turns an idea into something filmable: the hook, the beats in order, a
   * shot list and the caption.
   *
   * The script is written onto the row before the response is sent, so closing
   * the screen cannot lose a generation that has already been paid for. The
   * status only moves on the first script; an idea already marked ready to
   * film does not go backwards because someone regenerated its words.
   *
   * The whole row comes back rather than the script alone. That status rule is
   * decided here, and the list the operator is looking at has to show the
   * result of it without keeping a second copy of the rule.
   */
  app.post<{ Params: { id: string } }>("/ideas/:id/script", async (request, reply) => {
    const idea = await prisma.contentIdea.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: {
        id: true,
        clientId: true,
        text: true,
        hook: true,
        formatName: true,
        status: true,
        client: { select: { name: true } },
      },
    });
    if (!idea) return reply.status(404).send({ error: "idea not found" });
    if (!env.ANTHROPIC_API_KEY) return reply.status(503).send(NO_KEY);

    try {
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: env.SUGGESTIONS_MODEL,
        max_tokens: 2048,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: SCRIPT_SCHEMA },
        },
        system:
          "You write the script and storyboard for one short form video, for the " +
          "person who is about to film it.\n\n" +
          "Rules:\n" +
          "- The hook is the first line, spoken out loud, six to fifteen words.\n" +
          "- Beats are the video in order: 4 to 6 of them. The label is what the " +
          "beat is for (Hook, Setup, Turn, Proof, Payoff, Ask). The line is what " +
          "is actually said, written the way a person talks.\n" +
          "- The shot list is 4 to 6 shots. The shot is what the camera sees, the " +
          "note is how to get it. Assume a phone and whatever is already around.\n" +
          "- The caption is for the post, and repeats none of the spoken lines.\n" +
          "- Plain English. No jargon, no buzzwords, no hype, no stage directions " +
          "nobody could follow.\n" +
          "- Never use an em dash, an en dash or an arrow. Use commas and full stops.\n" +
          "- Use the brand's own material below. Do not invent facts, statistics, " +
          "prices or claims that are not in it.",
        messages: [
          {
            role: "user",
            content:
              `Brand: ${idea.client.name}\n` +
              `Idea: ${idea.text}\n` +
              (idea.formatName ? `Format: ${idea.formatName}\n` : "") +
              (idea.hook ? `Hook it was saved with: ${idea.hook}\n` : "") +
              `\n${await grounding(prisma, idea.clientId)}`,
          },
        ],
      });
      if (response.stop_reason === "refusal") return reply.status(502).send(REFUSED);

      const raw = JSON.parse(textOf(response) || "{}") as {
        hook?: unknown;
        beats?: unknown[];
        shotList?: unknown[];
        caption?: unknown;
      };
      const script = {
        hook: toPlainText(String(raw.hook ?? "")),
        beats: (raw.beats ?? []).slice(0, 8).map((entry) => {
          const b = (entry ?? {}) as Record<string, unknown>;
          return {
            label: toPlainText(String(b.label ?? "")),
            line: toPlainText(String(b.line ?? "")),
          };
        }),
        shotList: (raw.shotList ?? []).slice(0, 8).map((entry) => {
          const s = (entry ?? {}) as Record<string, unknown>;
          return {
            shot: toPlainText(String(s.shot ?? "")),
            note: toPlainText(String(s.note ?? "")),
          };
        }),
        caption: toPlainText(String(raw.caption ?? "")),
      };

      return prisma.contentIdea.update({
        where: { id: idea.id },
        data: { script, ...(idea.status === "idea" ? { status: "scripting" } : {}) },
      });
    } catch (err) {
      request.log.error({ err }, "could not write the script");
      return reply.status(502).send({
        error: "could not write the script",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /* ---- remix a saved idea ---- */

  const REMIX_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["variants"],
    properties: {
      variants: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "label", "format", "funnelStage", "whyItWorks", "difficulty", "actors", "locations", "needs", "script", "shots"],
          properties: {
            text: { type: "string" },
            label: { type: "string" },
            format: { type: "string", enum: [...VIDEO_FORMATS] },
            funnelStage: { type: "string", enum: [...FUNNEL_STAGES] },
            whyItWorks: { type: "string" },
            difficulty: { type: "string", enum: [...DIFFICULTIES] },
            actors: { type: "integer" },
            locations: { type: "integer" },
            needs: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "label"], properties: { type: { type: "string", enum: ["prop", "location", "people"] }, label: { type: "string" } } } },
            script: { type: "string" },
            shots: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "framing", "angle", "move", "pose", "time", "sign"], properties: {
              title: { type: "string" },
              framing: { type: "string", enum: ["close-up", "medium", "wide", "over-the-shoulder"] },
              angle: { type: "string", enum: ["eye", "low", "high"] },
              move: { type: "string", enum: ["push", "pull", "pan", "tilt", "static"] },
              pose: { type: "string", enum: ["talk", "point", "measure", "hold", "walk"] },
              time: { type: "string" },
              sign: { type: "string" },
            } } },
          },
        },
      },
    },
  } as const;

  /**
   * Three fresh takes on one saved idea: same core topic, a new hook and/or a
   * new format each. Nothing is saved here; the screen saves the ones the
   * operator picks as new ideas linked by remixedFromId.
   */
  app.post<{ Params: { id: string } }>("/ideas/:id/remix", async (request, reply) => {
    const idea = await prisma.contentIdea.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      include: { client: { select: { name: true } } },
    });
    if (!idea) return reply.status(404).send({ error: "idea not found" });
    if (!env.ANTHROPIC_API_KEY) return reply.status(503).send(NO_KEY);
    try {
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: env.SUGGESTIONS_MODEL,
        max_tokens: 5000,
        output_config: { effort: "low", format: { type: "json_schema", schema: REMIX_SCHEMA } },
        system:
          "You remix one short form video idea for a brand. Write 4 variants that keep the same core " +
          "idea and topic but each changes the hook, the format, or both, and no two variants alike. " +
          "text is the new opening line, spoken, six to fifteen words, never the same as the original. " +
          "label is the hook style, two to four words, different for every variant. format is exactly one " +
          "of the listed formats; funnelStage is top, middle or bottom, and the format must suit the stage:\n" +
          funnelPromptGuide() + "\n" +
          "whyItWorks is one specific sentence, under 25 words, on the psychology or trend behind it. " +
          DIFFICULTY_RUBRIC + " " + NEEDS_RULES + " " +
          "script is 40 to 90 words as four lines starting HOOK:, SETUP:, PAYOFF:, CTA:. shots is exactly 3 " +
          "shots: title under 8 words, time like 0:00-0:03, sign is short on-screen text or empty. " +
          "No hashtags, no emoji, never an em dash, en dash or arrow. Do not invent prices or facts.",
        messages: [{
          role: "user",
          content:
            `Brand: ${idea.client.name}\nOriginal idea: ${idea.hook || idea.text}\n` +
            (idea.formatName ? `Original format: ${idea.formatName}\n` : "") +
            (idea.scriptText ? `Original script:\n${idea.scriptText}\n` : "") +
            `\n${await grounding(prisma, idea.clientId)}`,
        }],
      } as Anthropic.MessageCreateParamsNonStreaming);
      if (response.stop_reason === "refusal") return reply.status(502).send(REFUSED);
      const raw = JSON.parse(textOf(response) || "{}") as { variants?: Array<Record<string, unknown>> };
      const cleaned = (raw.variants ?? []).map((v) => {
        const shots = (Array.isArray(v.shots) ? v.shots : []).slice(0, 5) as Array<Record<string, string>>;
        const fit = reconcileFunnel(v.format, v.funnelStage);
        const needs = cleanNeeds(v.needs, shots.map((s) => String(s.title ?? "")));
        const load = needsLoad(needs);
        return {
          text: toPlainText(String(v.text ?? "")).slice(0, 500),
          label: toPlainText(String(v.label ?? "")).slice(0, 60),
          format: fit.format,
          funnelStage: fit.funnelStage,
          whyItWorks: toPlainText(String(v.whyItWorks ?? "")).slice(0, 400),
          difficulty: checkDifficulty(v.difficulty, fit.format, shots.length, Math.max(Number(v.actors) || 1, load.actors), Math.max(Number(v.locations) || 1, load.locations), load.props),
          needs,
          script: toPlainText(String(v.script ?? "")).slice(0, 4000),
          shots,
          creator: idea.creator ?? undefined,
        };
      }).filter((v) => v.text);
      const variants = enforceMix(cleaned, 3, [idea.hook || idea.text]).slice(0, 3);
      if (variants.length === 0) return reply.status(502).send({ error: "could not remix this idea", detail: "Try again." });
      return { clientId: idea.clientId, originalId: idea.id, variants };
    } catch (err) {
      request.log.error({ err }, "could not remix the idea");
      return reply.status(502).send({ error: "could not remix this idea", detail: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ---- the brainstorm chat ---- */

  /**
   * One turn of the brainstorm.
   *
   * The chat is stateless on the server: the screen holds the thread and sends
   * it back each turn, and only the last twelve turns are carried, so a long
   * afternoon of chat cannot quietly grow into a very expensive prompt. What
   * grounds it is the brand's own material, sent as the system prompt so the
   * thread itself stays exactly what was typed.
   */
  app.post<{ Params: { clientId: string } }>(
    "/clients/:clientId/brainstorm",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });

      const parsed = brainstormSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: "that message could not be sent",
          detail: parsed.error.issues[0]?.message ?? "Type a message, up to 2000 characters.",
        });
      }
      if (!env.ANTHROPIC_API_KEY) return reply.status(503).send(NO_KEY);

      // Continuing a thread reads it back rather than trusting what the window
      // sent, so a stale tab cannot rewrite the history it is answering from.
      const chat = parsed.data.chatId
        ? await prisma.brainstormChat.findFirst({
            where: { id: parsed.data.chatId, clientId: client.id },
          })
        : null;
      if (parsed.data.chatId && !chat) {
        return reply.status(404).send({
          error: "that chat is gone",
          detail: "It was deleted somewhere else. Start a new one.",
        });
      }
      const history: ChatTurn[] = chat ? (chat.messages as ChatTurn[]) : parsed.data.history;

      try {
        const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
          model: env.SUGGESTIONS_MODEL,
          max_tokens: 2048,
          thinking: { type: "adaptive" },
          system:
            `You are the content strategist for ${client.name}, talking with the ` +
            "person who runs the account.\n\n" +
            "How you answer:\n" +
            "- Short plain paragraphs, two or three sentences each, three " +
            "paragraphs at the very most. Answer the question first.\n" +
            "- A bullet is never longer than one line, and most answers need none.\n" +
            "- No marketing jargon, no hype, no filler opener. Never say you would " +
            "be happy to help.\n" +
            "- When a hook would help, write it as a line they could say out loud, " +
            "in quotes, on its own line, so they can save it as an idea.\n" +
            "- Never use an em dash, an en dash or an arrow. Use commas and full stops.\n" +
            "- Use the brand's own material below. Say you do not know rather than " +
            "inventing a fact, a number or a claim that is not in it.\n\n" +
            (await grounding(prisma, client.id)),
          messages: [
            ...history.slice(-12),
            { role: "user" as const, content: parsed.data.message },
          ],
        });
        if (response.stop_reason === "refusal") return reply.status(502).send(REFUSED);
        const answer = toPlainText(textOf(response));

        // Written before the response goes out. The window holds the thread in
        // local state only, so a turn that was paid for would be gone the
        // moment the operator closed it.
        const turns: ChatTurn[] = [
          ...history,
          { role: "user" as const, content: parsed.data.message },
          { role: "assistant" as const, content: answer },
        ].slice(-MAX_STORED_TURNS);

        const saved = chat
          ? await prisma.brainstormChat.update({
              where: { id: chat.id },
              data: { messages: turns },
            })
          : await prisma.brainstormChat.create({
              data: {
                clientId: client.id,
                title: chatTitle(parsed.data.message),
                messages: turns,
              },
            });

        return { reply: answer, chatId: saved.id, title: saved.title };
      } catch (err) {
        request.log.error({ err }, "the brainstorm turn failed");
        return reply.status(502).send({
          error: "could not answer that",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * Past chats.
   *
   * The list never carries the threads themselves. A brand with fifty
   * brainstorms behind it would otherwise ship every word of all of them every
   * time the window opened, to render a column of titles.
   */
  app.get<{ Params: { clientId: string } }>(
    "/clients/:clientId/brainstorms",
    async (request, reply) => {
      const client = await ownedClient(request.params.clientId, request.user.agencyId);
      if (!client) return reply.status(404).send({ error: "brand not found" });
      const rows = await prisma.brainstormChat.findMany({
        where: { clientId: client.id },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { id: true, title: true, messages: true, updatedAt: true },
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        updatedAt: r.updatedAt,
        turns: Array.isArray(r.messages) ? r.messages.length : 0,
      }));
    },
  );

  app.get<{ Params: { id: string } }>("/brainstorms/:id", async (request, reply) => {
    const chat = await prisma.brainstormChat.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!chat) return reply.status(404).send({ error: "chat not found" });
    return chat;
  });

  app.delete<{ Params: { id: string } }>("/brainstorms/:id", async (request, reply) => {
    const chat = await prisma.brainstormChat.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!chat) return reply.status(404).send({ error: "chat not found" });
    await prisma.brainstormChat.delete({ where: { id: chat.id } });
    return { ok: true };
  });
}
