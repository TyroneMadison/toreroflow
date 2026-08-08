import path from "node:path";
import { fileLink, fileLinkVersioned } from "../files/link";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { CAROUSEL_ABSOLUTE_MAX, decodeEscapes, looksLikeRevisionOf } from "@toreroflow/core";
import { getPrisma, Prisma, cancelByKey, enqueue } from "@toreroflow/db";
import { extractThumbnail } from "@toreroflow/media";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

const revisionSchema = z.object({
  isRevision: z.boolean().optional(),
  revisionOfId: z.string().nullable().optional(),
  replaceScheduled: z.boolean().optional(),
});

const formatSchema = z.object({
  format: z.enum(["short_form", "long_form"]),
});

/**
 * The shape a generated caption comes back in. Structured output rather than
 * parsing prose, so a stray sentence of preamble cannot end up in a client's
 * caption. Note the model's structured output rejects maxItems and any
 * minItems above 1, so the hashtag count is asked for in the prompt and
 * trimmed on the way out instead.
 */
const CAPTION_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    title: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["description", "title", "hashtags"],
  additionalProperties: false,
} as const;

/** Carousels post nowhere that takes a title, so the shape is words and tags. */
const CAROUSEL_CAPTION_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["description", "hashtags"],
  additionalProperties: false,
} as const;

const draftSchema = z.object({
  /** The video's label in the app, and the fallback for the fields below. */
  name: z.string().max(300).optional(),
  /** The caption on Instagram, TikTok, Facebook and Snapchat. */
  description: z.string().max(4000).optional(),
  youtubeTitle: z.string().max(100).optional(),
  youtubeDescription: z.string().max(4000).optional(),
  hashtags: z.array(z.string().max(60)).max(20).optional(),
});

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.addHook("onRequest", requireAuth);

  /**
   * Present draft copy in the current shape. Older rows carry {hook, caption}
   * from before the rename, and rows from before the split carry a `title`
   * that meant "YouTube title and everyone's caption". Both map onto `name`,
   * which is the field that still feeds every platform when nothing more
   * specific was written, so nothing already drafted changes behavior.
   */
  const normalizeDraft = (draft: unknown): unknown => {
    if (!draft || typeof draft !== "object") return draft;
    const d = draft as Record<string, unknown>;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" ? decodeEscapes(v) : undefined;
    return {
      name: str(d.name) ?? str(d.title) ?? str(d.hook) ?? "",
      description: str(d.description) ?? str(d.caption) ?? "",
      youtubeTitle: str(d.youtubeTitle) ?? "",
      youtubeDescription: str(d.youtubeDescription) ?? "",
      hashtags: Array.isArray(d.hashtags)
        ? d.hashtags.map((h) => (typeof h === "string" ? decodeEscapes(h) : h))
        : [],
    };
  };

  const assetView = (a: {
    id: string;
    clientId: string;
    originalName: string;
    storageKey: string;
    durationSec: number | null;
    status: string;
    transcript: unknown;
    draftCopy: unknown;
    format: string | null;
    isRevision: boolean;
    revisionOfId: string | null;
    coverOffsetMs: number | null;
    coverKey: string | null;
    sourceDeletedAt?: Date | null;
    thumbDeletedAt?: Date | null;
    kind?: string;
    slideKeys?: unknown;
    createdAt: Date;
    updatedAt?: Date;
  }) => {
    const ready = a.status === "ready";
    return {
      id: a.id,
      clientId: a.clientId,
      name: a.originalName,
      /** video | carousel. A carousel has images instead of a duration. */
      kind: a.kind ?? "video",
      slideCount: Array.isArray(a.slideKeys) ? a.slideKeys.length : 0,
      durationSec: a.durationSec,
      status: a.status,
      hasTranscript: Array.isArray(a.transcript) && a.transcript.length > 0,
      draftCopy: normalizeDraft(a.draftCopy),
      format: a.format,
      isRevision: a.isRevision,
      revisionOfId: a.revisionOfId,
      createdAt: a.createdAt,
      coverOffsetMs: a.coverOffsetMs,
      // A carousel has no video to take a frame from, so its first slide is
      // its own thumbnail. Pointing at thumb.jpg would render a blank card.
      // A re-picked cover overwrites the same cover.jpg, so the address alone
      // never changes and the webview keeps showing the frame it already has.
      // Versioning by the row's own updatedAt is what makes a new pick appear
      // without a reload; the parameter sits outside the signature.
      //
      // Null once the images have been swept, a month after posting. Handing
      // out a link to a file that is no longer there would render a broken
      // image on every card; every consumer already treats null as "draw the
      // placeholder", so saying nothing is what degrades cleanly.
      thumbUrl:
        ready && !a.thumbDeletedAt
          ? a.kind === "carousel"
            ? fileLink(a.storageKey)
            : a.coverKey
              ? fileLinkVersioned(a.coverKey, a.updatedAt ? a.updatedAt.getTime() : null)
              : fileLink(`${a.clientId}/${a.id}/thumb.jpg`)
          : null,
      // The original upload: nothing is re-encoded, so preview and publish
      // both use the file exactly as it was exported. Null once the file has
      // been cleared, a week after the post went live, so the app can say the
      // video is gone rather than hand the player a URL that 404s.
      videoUrl: a.sourceDeletedAt ? null : fileLink(a.storageKey),
      sourceDeletedAt: a.sourceDeletedAt ?? null,
    };
  };

  app.post<{ Params: { id: string } }>("/clients/:id/media", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: {
        id: request.params.id,
        agencyId: request.user.agencyId,
        deletedAt: null,
      },
    });
    if (!client) return reply.status(404).send({ error: "client not found" });

    const file = await request.file();
    if (!file) return reply.status(400).send({ error: "no file uploaded" });

    const ext = path.extname(file.filename || ".mp4") || ".mp4";
    const originalName = file.filename ?? `upload${ext}`;

    // A re-export of an earlier upload ("… v2", "… final") is a revision, so
    // it should not spend another slot in the client's quota. Match against
    // the newest candidate; the operator can override either way.
    const siblings = await prisma.mediaAsset.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, originalName: true, revisionOfId: true },
    });
    const match = siblings.find((s) => looksLikeRevisionOf(originalName, s.originalName));
    // Point at the root upload, so a v3 matching v2 still refers to v1.
    const rootId = match ? (match.revisionOfId ?? match.id) : null;

    const asset = await prisma.mediaAsset.create({
      data: {
        clientId: client.id,
        originalName,
        storageKey: "pending",
        status: "uploaded",
        isRevision: rootId !== null,
        revisionOfId: rootId,
      },
    });
    const storageKey = `${client.id}/${asset.id}/source${ext}`;
    const dir = path.join(env.STORAGE_DIR, client.id, asset.id);
    await fs.mkdir(dir, { recursive: true });
    await pipeline(file.file, createWriteStream(path.join(env.STORAGE_DIR, storageKey)));
    if (file.file.truncated) {
      await fs.rm(dir, { recursive: true, force: true });
      await prisma.mediaAsset.delete({ where: { id: asset.id } });
      return reply.status(413).send({ error: "file too large" });
    }

    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { storageKey },
    });
    await enqueue("media", { assetId: asset.id });
    return reply
      .status(201)
      .send(assetView(updated));
  });

  /**
   * A carousel: several images posted to Instagram as one post.
   *
   * Stored as one asset with an ordered list of image keys, so the calendar,
   * the queue and the scheduler reach it without learning a second kind of
   * thing. None of the video pipeline runs on it: there is no duration to
   * probe, no transcript to make, no cover to pick, and it is not a video, so
   * it never spends a slot in the client's video quota.
   *
   * The order files arrive in is the order Instagram shows them, and the first
   * one decides the aspect ratio of the whole post.
   */
  app.post<{ Params: { id: string }; Querystring: { draftId?: string } }>(
    "/clients/:id/carousel",
    async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
    });
    if (!client) return reply.status(404).send({ error: "client not found" });

    /*
     * The words written in Create > Carousels ride along with the images.
     *
     * The loop is: write the carousel there, let Canva bulk create make the
     * slides, upload them here. Without this the caption and hashtags written
     * in the first step had to be retyped in the third, which is the kind of
     * step people skip, and then a designed carousel posts captionless.
     *
     * Looked up before anything is written so a bad id fails the upload
     * loudly rather than quietly dropping the words.
     */
    let draftWords: { name: string; description: string; hashtags: string[] } | null = null;
    if (request.query.draftId) {
      const carouselDraft = await prisma.carouselDraft.findFirst({
        where: { id: request.query.draftId, clientId: client.id },
      });
      if (!carouselDraft) {
        return reply.status(404).send({
          error: "that carousel draft is gone",
          detail:
            "The carousel this upload was started from no longer exists. Go back to the Carousels tab and pick again, or upload without one.",
        });
      }
      draftWords = {
        name: carouselDraft.topic,
        description: carouselDraft.caption,
        hashtags: Array.isArray(carouselDraft.hashtags)
          ? (carouselDraft.hashtags as string[])
          : [],
      };
    }

    /*
     * The originals land untouched, plus a crops.json carrying the builder's
     * pan/zoom rects; the worker then conforms every slide to the first
     * item's aspect ratio, exactly as videos are probed and thumbnailed off
     * the request path. Conforming inline was fine when a carousel was a few
     * JPEGs; a set holding MP4 slides means ffmpeg re-encodes, and an
     * operator should not sit inside a hanging POST while that happens.
     *
     * The first item must be an image. Its ratio governs the whole set, it
     * doubles as the thumbnail every card draws, and it is what survives the
     * retention sweeps for the calendar's sake.
     */
    const asset = await prisma.mediaAsset.create({
      data: {
        clientId: client.id,
        kind: "carousel",
        originalName: "carousel",
        storageKey: "pending",
        status: "uploaded",
      },
    });
    const dir = path.join(env.STORAGE_DIR, client.id, asset.id);
    await fs.mkdir(dir, { recursive: true });

    const IMAGE_EXT: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
    };
    const VIDEO_EXT: Record<string, string> = {
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
    };

    const originals: string[] = [];
    let cropsRaw = "";
    let firstName: string | null = null;
    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "crops") cropsRaw = String(part.value ?? "");
          continue;
        }
        const ext = IMAGE_EXT[part.mimetype] ?? VIDEO_EXT[part.mimetype];
        if (!ext) {
          throw new Error(
            "a carousel takes JPG, PNG or WebP images, and MP4 or MOV video (Instagram only)",
          );
        }
        if (originals.length >= CAROUSEL_ABSOLUTE_MAX) {
          throw new Error(`nothing takes more than ${CAROUSEL_ABSOLUTE_MAX} items in one carousel`);
        }
        if (originals.length === 0 && VIDEO_EXT[part.mimetype]) {
          throw new Error(
            "the first item must be an image: it sets the aspect ratio for the whole carousel and becomes its cover",
          );
        }
        const name = `orig-${originals.length + 1}${ext}`;
        await pipeline(part.file, createWriteStream(path.join(dir, name)));
        if (part.file.truncated) throw new Error("one of the files was too large");
        firstName ??= part.filename ?? null;
        originals.push(name);
      }
      if (!originals.length) throw new Error("no images uploaded");

      // The builder's crop rects, aligned with the files by position. Absent
      // or malformed entries mean center-crop, decided by the worker.
      let crops: Array<Record<string, number> | null> = [];
      try {
        const parsed = JSON.parse(cropsRaw || "[]") as unknown;
        if (Array.isArray(parsed)) crops = parsed as Array<Record<string, number> | null>;
      } catch {
        // A broken crops field is not worth failing the upload over.
      }
      await fs.writeFile(
        path.join(dir, "crops.json"),
        JSON.stringify({ originals, crops: originals.map((_, i) => crops[i] ?? null) }),
        "utf8",
      );
    } catch (err) {
      // Nothing half-made survives: a carousel missing a slide would publish
      // silently short.
      await fs.rm(dir, { recursive: true, force: true });
      await prisma.mediaAsset.delete({ where: { id: asset.id } });
      return reply.status(400).send({
        error: "could not save that carousel",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        // The finished first slide, named before it exists so every screen
        // that reads storageKey points at the right place the moment the
        // worker sets the asset ready.
        storageKey: `${client.id}/${asset.id}/slide-1.jpg`,
        // The draft's topic names the carousel; a file name like
        // "slide-1.png" names nothing.
        originalName: draftWords?.name ?? firstName ?? "carousel",
        ...(draftWords
          ? {
              draftCopy: {
                name: draftWords.name,
                description: draftWords.description,
                hashtags: draftWords.hashtags,
              },
            }
          : {}),
      },
    });
    await enqueue("media", { assetId: asset.id });
    return reply.status(201).send(assetView(updated));
    },
  );

  app.get<{ Params: { id: string } }>("/clients/:id/media", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: {
        id: request.params.id,
        agencyId: request.user.agencyId,
        deletedAt: null,
      },
    });
    if (!client) return reply.status(404).send({ error: "client not found" });
    // The upload list means "not yet scheduled". A video leaves it once it
    // has a live post, and comes back on its own if that post is removed
    // from the queue, because removing a target deletes the row. A post
    // whose every target failed is not live: nothing was published, so the
    // operator can fix it and schedule again from the same card.
    const assets = await prisma.mediaAsset.findMany({
      where: {
        clientId: client.id,
        posts: {
          none: {
            deletedAt: null,
            targets: {
              some: { status: { in: ["scheduled", "publishing", "posted"] } },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return assets.map(assetView);
  });

  app.get<{ Params: { id: string } }>("/media/:id", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId },
      },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    return assetView(asset);
  });

  /**
   * The stored transcript, segments with word-level timings when the captions
   * service produced them. Null when the video was never transcribed.
   */
  app.get<{ Params: { id: string } }>("/media/:id/transcript", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId },
      },
      select: { transcript: true },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    return { transcript: asset.transcript ?? null };
  });

  app.patch<{ Params: { id: string } }>("/media/:id/draft", async (request, reply) => {
    const body = draftSchema.parse(request.body);
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId },
      },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    const current = (asset.draftCopy as Record<string, unknown> | null) ?? {};
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { draftCopy: { ...current, ...body } },
    });
    return { id: updated.id, draftCopy: updated.draftCopy };
  });

  /**
   * The "Generate caption and title" button: transcribe if needed, then write.
   *
   * This is the only place the app spends Anthropic money on copy. The upload
   * pipeline used to draft automatically on every video, which billed for
   * captions the operator was going to rewrite anyway; now words are written
   * when they are asked for, once, on a press.
   *
   * Returns the text rather than saving the visible fields. A generated
   * caption the operator has not read yet is a suggestion, and overwriting
   * whatever they had typed with it would make the button dangerous to press.
   * Hashtags are the one exception, saved directly: there is no hashtag field
   * to fill on screen, and they are invisible until scheduling reads them.
   */
  app.post<{ Params: { id: string } }>("/media/:id/caption", async (request, reply) => {
    if (!env.ANTHROPIC_API_KEY) {
      return reply.status(400).send({
        error: "no writing key",
        detail: "ANTHROPIC_API_KEY is not set on the server, so nothing can write the caption.",
      });
    }

    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      include: { client: { select: { name: true } } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });

    const textOf = (t: unknown): string =>
      Array.isArray(t)
        ? (t as Array<{ text?: unknown }>)
            .map((s) => (typeof s.text === "string" ? s.text : ""))
            .join(" ")
            .trim()
        : "";

    let transcriptText = textOf(asset.transcript);

    /*
     * No transcript yet: make one now, while the button is held down.
     *
     * This is the normal path, not a fallback. Uploading no longer transcribes,
     * because doing it there made every upload wait on the slowest step for
     * words most videos never needed. Here they are wanted, by definition: the
     * caption is about to be written from them.
     *
     * It needs the source file, which retention clears a week after posting, so
     * an old posted video genuinely cannot be transcribed and the error below
     * says so.
     *
     * Transcription is the local whisper container, not a paid API, so doing
     * it inline costs seconds rather than money. A 60 second clip is a few
     * seconds of CPU.
     */
    if (!transcriptText && !asset.sourceDeletedAt && asset.kind !== "carousel") {
      try {
        const res = await fetch(`${env.CAPTIONS_URL}/transcribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: path.join(env.STORAGE_DIR, asset.storageKey) }),
        });
        if (res.ok) {
          const data = (await res.json()) as { segments?: unknown };
          if (Array.isArray(data.segments) && data.segments.length) {
            await prisma.mediaAsset.update({
              where: { id: asset.id },
              data: { transcript: data.segments as Prisma.InputJsonValue },
            });
            transcriptText = textOf(data.segments);
          }
        }
      } catch {
        // The captions service being down falls through to the plain error
        // below, which is accurate either way: there are no words to write
        // from.
      }
    }

    if (!transcriptText) {
      return reply.status(400).send({
        error: "nothing to write from",
        detail: asset.sourceDeletedAt
          ? "This video's file was cleared after it posted, and it was never transcribed while the file existed, so there are no words to write from."
          : "No speech was found to transcribe in this video, so there are no words to write from.",
      });
    }

    try {
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: env.SUGGESTIONS_MODEL,
        max_tokens: 1024,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: CAPTION_SCHEMA },
        },
        system:
          "You write short-form video captions for a social media agency whose clients are car " +
          "dealerships and automotive personalities. Given what is said in the video, write a " +
          "description that makes someone stop and watch, and that can be found by search.\n\n" +
          "The description is 2 to 4 sentences, posted as the caption on Instagram, TikTok, " +
          "Facebook and Snapchat and as the YouTube description. Open on the most interesting " +
          "thing in the video, not a summary of it. Name the specific cars, models, years, " +
          "prices and places that are actually mentioned, because those are the words people " +
          "search for. End with a question or a reason to comment. No hashtags inside the " +
          "description, no emoji spam, and never invent a fact that is not in the transcript.\n\n" +
          "Also give a title under 100 characters for YouTube, and 5 to 8 hashtags without the " +
          "# sign, ordered from most specific to broadest.",
        messages: [
          {
            role: "user",
            content: `Brand: ${asset.client.name}\nWhat is said in the video:\n${transcriptText.slice(0, 6000)}`,
          },
        ],
      });
      if (response.stop_reason === "refusal") {
        return reply.status(502).send({
          error: "the model declined",
          detail: "The model refused to write this one. Try again, or write it yourself.",
        });
      }
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") {
        return reply.status(502).send({ error: "no caption came back" });
      }
      const parsed = JSON.parse(text.text) as {
        description?: unknown;
        title?: unknown;
        hashtags?: unknown;
      };
      const hashtags = Array.isArray(parsed.hashtags)
        ? parsed.hashtags.filter((h): h is string => typeof h === "string").slice(0, 8)
        : [];
      // Hashtags save now rather than riding the visible fields: there is no
      // hashtag box on the card to fill, and scheduling reads them from the
      // draft. Name and description stay a suggestion until the operator
      // saves what they have read.
      if (hashtags.length) {
        const current = (asset.draftCopy as Record<string, unknown> | null) ?? {};
        await prisma.mediaAsset.update({
          where: { id: asset.id },
          data: { draftCopy: { ...current, hashtags } },
        });
      }
      return {
        description: typeof parsed.description === "string" ? parsed.description : "",
        title: typeof parsed.title === "string" ? parsed.title : "",
        hashtags,
      };
    } catch (error) {
      request.log.error({ err: error }, "caption generation failed");
      return reply.status(502).send({
        error: "could not write the caption",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * Write a carousel's caption from the slides themselves.
   *
   * A carousel has no transcript, so the words come from looking: the builder
   * sends the first few slides, downscaled client-side so a 4K design does
   * not ride the wire, and the model describes what is actually on them.
   * Returns rather than saves, same contract as the video caption button; the
   * operator reads it before it becomes what posts.
   */
  app.post<{ Params: { id: string } }>(
    "/clients/:id/carousel-caption",
    async (request, reply) => {
      if (!env.ANTHROPIC_API_KEY) {
        return reply.status(400).send({
          error: "no writing key",
          detail: "ANTHROPIC_API_KEY is not set on the server, so nothing can write the caption.",
        });
      }
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        select: { name: true },
      });
      if (!client) return reply.status(404).send({ error: "client not found" });

      const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"] as const);
      type SlideMedia = "image/jpeg" | "image/png" | "image/webp";
      const images: Array<{ mediaType: SlideMedia; data: string }> = [];
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;
        if (!MEDIA_TYPES.has(part.mimetype as SlideMedia)) continue;
        // Four slides carry a carousel's story; more is spend, not signal.
        if (images.length >= 4) {
          await part.file.resume();
          continue;
        }
        const buf = await part.toBuffer();
        images.push({ mediaType: part.mimetype as SlideMedia, data: buf.toString("base64") });
      }
      if (!images.length) {
        return reply.status(400).send({ error: "no slides to read" });
      }

      try {
        const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
          model: env.SUGGESTIONS_MODEL,
          max_tokens: 1024,
          thinking: { type: "adaptive" },
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: CAROUSEL_CAPTION_SCHEMA },
          },
          system:
            "You write Instagram and TikTok captions for a social media agency whose clients " +
            "are car dealerships and automotive personalities. You are shown the slides of a " +
            "carousel post. Write a caption of 2 to 4 sentences from what is actually on the " +
            "slides: name the specific cars, models, years, prices and claims that appear, " +
            "because those are the words people search for. Open on the most interesting thing, " +
            "end with a question or a reason to comment, and never invent anything the slides " +
            "do not say. No hashtags inside the caption. Also give 5 to 8 hashtags without the " +
            "# sign, most specific first.",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `Brand: ${client.name}. The carousel's slides, in order:` },
                ...images.map(
                  (img) =>
                    ({
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: img.mediaType,
                        data: img.data,
                      },
                    }) as const,
                ),
              ],
            },
          ],
        });
        if (response.stop_reason === "refusal") {
          return reply.status(502).send({
            error: "the model declined",
            detail: "The model refused to write this one. Try again, or write it yourself.",
          });
        }
        const text = response.content.find((b) => b.type === "text");
        if (!text || text.type !== "text") {
          return reply.status(502).send({ error: "no caption came back" });
        }
        const parsed = JSON.parse(text.text) as { description?: unknown; hashtags?: unknown };
        return {
          description: typeof parsed.description === "string" ? parsed.description : "",
          hashtags: Array.isArray(parsed.hashtags)
            ? parsed.hashtags.filter((h): h is string => typeof h === "string").slice(0, 8)
            : [],
        };
      } catch (error) {
        request.log.error({ err: error }, "carousel caption generation failed");
        return reply.status(502).send({
          error: "could not write the caption",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  const coverSchema = z.object({
    offsetMs: z.number().int().min(0).max(4 * 60 * 60 * 1000),
  });

  /**
   * Choose a frame of the video as the cover. The frame is extracted to
   * cover.jpg beside the source; every platform that accepts a custom
   * cover gets this image at publish, and the app's thumbnails switch to
   * it so what the operator sees is what posts.
   */
  app.patch<{ Params: { id: string } }>("/media/:id/cover", async (request, reply) => {
    const body = coverSchema.parse(request.body ?? {});
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    if (asset.status !== "ready") {
      return reply.status(409).send({ error: "asset is still processing" });
    }
    const source = path.join(env.STORAGE_DIR, asset.storageKey);
    const coverKey = `${asset.clientId}/${asset.id}/cover.jpg`;
    await extractThumbnail(source, path.join(env.STORAGE_DIR, coverKey), body.offsetMs / 1000);
    // An uploaded .png cover may linger from before; the frame pick owns
    // the pointer now, so remove the stale file too.
    await fs.rm(path.join(env.STORAGE_DIR, `${asset.clientId}/${asset.id}/cover.png`), {
      force: true,
    });
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { coverOffsetMs: body.offsetMs, coverKey },
    });
    return assetView(updated);
  });

  /** Upload an image as the cover instead of picking a frame. */
  app.post<{ Params: { id: string } }>("/media/:id/cover-image", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: "no file uploaded" });
    const mime = file.mimetype;
    if (mime !== "image/jpeg" && mime !== "image/png") {
      return reply.status(400).send({ error: "cover must be a JPEG or PNG" });
    }
    const ext = mime === "image/png" ? ".png" : ".jpg";
    const coverKey = `${asset.clientId}/${asset.id}/cover${ext}`;
    await pipeline(
      file.file,
      createWriteStream(path.join(env.STORAGE_DIR, coverKey)),
    );
    if (file.file.truncated) {
      await fs.rm(path.join(env.STORAGE_DIR, coverKey), { force: true });
      return reply.status(413).send({ error: "file too large" });
    }
    // Remove the other-extension cover so exactly one exists.
    const other = path.join(
      env.STORAGE_DIR,
      `${asset.clientId}/${asset.id}/cover${ext === ".jpg" ? ".png" : ".jpg"}`,
    );
    await fs.rm(other, { force: true });
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { coverOffsetMs: null, coverKey },
    });
    return assetView(updated);
  });

  /** Back to the automatic thumbnail. */
  app.delete<{ Params: { id: string } }>("/media/:id/cover", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    for (const ext of [".jpg", ".png"]) {
      await fs.rm(
        path.join(env.STORAGE_DIR, `${asset.clientId}/${asset.id}/cover${ext}`),
        { force: true },
      );
    }
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { coverOffsetMs: null, coverKey: null },
    });
    return assetView(updated);
  });

  /**
   * Flip a video between counting toward the quota and being a revision.
   *
   * With `replaceScheduled`, the posts still queued for the video this one
   * revises are cancelled, so the new cut takes over the slot instead of
   * both going out. Only unpublished posts are touched.
   */
  app.patch<{
    Params: { id: string };
    Body: { isRevision?: boolean; revisionOfId?: string | null; replaceScheduled?: boolean };
  }>("/media/:id/revision", async (request, reply) => {
    const body = revisionSchema.parse(request.body ?? {});
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });

    const isRevision = body.isRevision ?? !asset.isRevision;
    const revisionOfId =
      body.revisionOfId !== undefined ? body.revisionOfId : (asset.revisionOfId ?? null);

    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { isRevision, revisionOfId: isRevision ? revisionOfId : null },
    });

    let cancelled = 0;
    if (isRevision && body.replaceScheduled && revisionOfId) {
      const stale = await prisma.postTarget.findMany({
        where: {
          post: { mediaAssetId: revisionOfId },
          status: { in: ["scheduled", "failed"] },
        },
      });
      for (const target of stale) {
        // Drops the delayed publish of a post this revision supersedes.
        await cancelByKey("publish", target.id);
      }
      const ids = stale.map((t) => t.id);
      if (ids.length) {
        await prisma.postTarget.deleteMany({ where: { id: { in: ids } } });
        cancelled = ids.length;
        // Drop posts left with no targets at all.
        const orphans = await prisma.post.findMany({
          where: { mediaAssetId: revisionOfId, targets: { none: {} } },
          select: { id: true },
        });
        if (orphans.length) {
          await prisma.post.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
        }
      }
    }

    return { ...assetView(updated), cancelledPosts: cancelled };
  });

  /**
   * Reclassify a video as short or long form. Duration is only a guess at
   * intent, so the operator gets the final say on which quota it spends.
   */
  app.patch<{ Params: { id: string }; Body: { format: string } }>(
    "/media/:id/format",
    async (request, reply) => {
      const body = formatSchema.parse(request.body ?? {});
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      });
      if (!asset) return reply.status(404).send({ error: "asset not found" });
      const updated = await prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { format: body.format },
      });
      return assetView(updated);
    },
  );

  app.delete<{ Params: { id: string } }>("/media/:id", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId },
      },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    await prisma.render.deleteMany({ where: { mediaAssetId: asset.id } });
    await prisma.mediaAsset.delete({ where: { id: asset.id } });
    await fs.rm(path.join(env.STORAGE_DIR, asset.clientId, asset.id), {
      recursive: true,
      force: true,
    });
    return { ok: true };
  });
}
