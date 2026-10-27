import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getPrisma } from "@toreroflow/db";
import {
  SUNRA_CREDITS_PER_IMAGE,
  SUNRA_SLIDE_SIZE,
  SunraCarouselRequestSchema,
  SunraGenerateRequestSchema,
  SunraImageModelSchema,
  SunraSettingsSchema,
  type SunraCarouselQuote,
  type SunraGenerateResult,
  type SunraImageModel,
  type SunraModelsResponse,
} from "@toreroflow/contracts";
import { env } from "../env";
import { fileLink } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";
import { readSetting, writeSetting } from "../ideas/settings";

/**
 * Sunra carousels for Instagram and TikTok (Create > Carousels): the user
 * types what they want, gets a price in Sunra credits (slides x credits per
 * image for the chosen model), approves it, and every slide is built at the
 * platform's size: Instagram 1080x1350 (4:5), TikTok 1080x1920 (9:16).
 *
 * Generating costs money, so it takes three things at once: the agency's
 * generation switch ON (default OFF), a quote for this exact request that has
 * not expired, and `approved: true` sent for that quote. A quote is used at
 * most once, claimed atomically so a double tap cannot pay twice.
 *
 * There is no Sunra HTTP client in this codebase yet, so the generator is
 * unset and generate answers 503 even when approved (GET /sunra/settings says
 * connected: false). setSunraGenerator wires one in; the checks use a fake and
 * nothing here calls Sunra.
 *
 * Models come from GET /carousels/sunra/models: Sunra's list_models (image
 * models only) priced with estimate_cost, cached for MODELS_TTL_MS.
 * setSunraCatalog wires those two calls in; until then the list is the two
 * observed nano-banana prices. Quote and generate only take a modelId on it.
 */

export const SUNRA_SETTING = "sunra";
export const QUOTE_TTL_MS = 15 * 60 * 1000;
export const IG_MAX_SLIDES = 10;
export const MODELS_TTL_MS = 60 * 60 * 1000;

export interface SunraJob {
  prompt: string;
  slides: number;
  platform: "instagram" | "tiktok";
  modelId: string;
  width: number;
  height: number;
  aspectRatio: string;
}
/** Builds every slide of one carousel, in order, one image per slide. */
export type SunraGenerator = (job: SunraJob) => Promise<Buffer[]>;
let generator: SunraGenerator | null = null;
export function setSunraGenerator(g: SunraGenerator | null): void {
  generator = g;
}

/** Sunra's own model calls, as wired at startup. */
export interface SunraCatalog {
  /** list_models: every model Sunra offers; only kind "image" is kept. */
  listModels(): Promise<Array<Omit<SunraImageModel, "creditsPerImage"> & { kind: string }>>;
  /** estimate_cost: credits for one image of this model. */
  estimateCost(modelId: string): Promise<number>;
}
let catalog: SunraCatalog | null = null;
let cached: { at: number; models: Promise<SunraImageModel[]> } | null = null;
export function setSunraCatalog(c: SunraCatalog | null): void {
  catalog = c;
  cached = null;
}

const OBSERVED_MODELS: SunraImageModel[] = Object.entries(SUNRA_CREDITS_PER_IMAGE).map(([id, creditsPerImage]) => ({
  id,
  label: id === "nano-banana-pro" ? "Nano Banana Pro" : "Nano Banana 2",
  provider: "google",
  creditsPerImage,
  supportedAspectRatios: [],
  supportedSizes: [],
  supportedResolutions: [],
  maxRefImages: 0,
}));

/** Every Sunra image model with its price, cached; a failed fetch is not cached. */
export function sunraModels(): Promise<SunraImageModel[]> {
  const c = catalog;
  if (!c) return Promise.resolve(OBSERVED_MODELS);
  if (cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;
  const models = c.listModels().then((all) =>
    Promise.all(
      all
        .filter((m) => m.kind === "image")
        .map(async ({ kind: _kind, ...m }) => SunraImageModelSchema.parse({ ...m, creditsPerImage: await c.estimateCost(m.id) })),
    ),
  );
  const entry = { at: Date.now(), models };
  cached = entry;
  models.catch(() => {
    if (cached === entry) cached = null;
  });
  return models;
}

const readSunraSettings = (agencyId: string) =>
  readSetting(agencyId, SUNRA_SETTING, SunraSettingsSchema, { generationEnabled: false });

export async function sunraRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.get("/carousels/sunra/models", async (_request, reply) => {
    try {
      const out: SunraModelsResponse = { models: await sunraModels() };
      return out;
    } catch (e) {
      return reply.status(502).send({ error: `Could not load Sunra models: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

  app.get("/sunra/settings", async (request) => ({
    ...(await readSunraSettings(request.user.agencyId)),
    connected: generator !== null,
  }));
  app.put("/sunra/settings", async (request) => {
    const settings = SunraSettingsSchema.parse(request.body);
    await writeSetting(request.user.agencyId, SUNRA_SETTING, settings);
    return settings;
  });

  /** The price check. Stores the quote; spends nothing. */
  app.post("/sunra/carousel/quote", async (request, reply) => {
    const body = SunraCarouselRequestSchema.parse(request.body);
    if (body.platform === "instagram" && body.slides > IG_MAX_SLIDES) {
      return reply.status(400).send({ error: `Instagram carousels take at most ${IG_MAX_SLIDES} slides` });
    }
    const brand = await prisma.client.findFirst({
      where: { id: body.brandId, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    let model: SunraImageModel | undefined;
    try {
      model = (await sunraModels()).find((m) => m.id === body.modelId);
    } catch {
      return reply.status(502).send({ error: "Could not load Sunra models" });
    }
    if (!model) return reply.status(400).send({ error: `Unknown Sunra image model: ${body.modelId}` });
    const size = SUNRA_SLIDE_SIZE[body.platform];
    if (model.supportedAspectRatios.length && !model.supportedAspectRatios.includes(size.aspectRatio)) {
      return reply.status(400).send({ error: `${model.label} does not make ${size.aspectRatio} images` });
    }
    const quote = await prisma.sunraQuote.create({
      data: {
        clientId: brand.id,
        platform: body.platform,
        slides: body.slides,
        prompt: body.prompt,
        model: model.id,
        credits: Math.ceil(body.slides * model.creditsPerImage),
        expiresAt: new Date(Date.now() + QUOTE_TTL_MS),
      },
    });
    const out: SunraCarouselQuote = {
      quoteId: quote.id,
      modelId: model.id,
      slides: quote.slides,
      creditsPerImage: model.creditsPerImage,
      credits: quote.credits,
      ...size,
      requiresApproval: true,
      expiresAt: quote.expiresAt.toISOString(),
    };
    return out;
  });

  app.post<{ Params: { quoteId: string } }>("/sunra/carousel/:quoteId/generate", async (request, reply) => {
    const parsed = SunraGenerateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "generation needs approved: true and the modelId of this quote" });
    const { agencyId, sub, bot } = request.user;
    if (!(await readSunraSettings(agencyId)).generationEnabled) {
      return reply.status(403).send({ error: "Sunra generation is turned off in settings" });
    }
    const quote = await prisma.sunraQuote.findFirst({ where: { id: request.params.quoteId, client: { agencyId } } });
    if (!quote) return reply.status(404).send({ error: "quote not found" });
    if (quote.status !== "quoted") return reply.status(409).send({ error: "this quote was already used" });
    if (quote.expiresAt <= new Date()) return reply.status(410).send({ error: "this quote has expired, get a new price" });
    if (parsed.data.modelId !== quote.model) {
      return reply.status(400).send({ error: `this quote was priced for ${quote.model}, not ${parsed.data.modelId}` });
    }
    try {
      if (!(await sunraModels()).some((m) => m.id === quote.model)) {
        return reply.status(400).send({ error: `Sunra no longer offers ${quote.model}, get a new price` });
      }
    } catch {
      return reply.status(502).send({ error: "Could not load Sunra models" });
    }
    if (!generator) return reply.status(503).send({ error: "Sunra generation is not connected on this server" });

    // Claim the quote: only one request moves it out of "quoted".
    const claimed = await prisma.sunraQuote.updateMany({
      where: { id: quote.id, status: "quoted" },
      data: { status: "generating", approvedBy: bot ? `bot:${bot}` : sub, approvedAt: new Date() },
    });
    if (claimed.count !== 1) return reply.status(409).send({ error: "this quote was already used" });

    try {
      const platform = quote.platform as SunraJob["platform"];
      const images = await generator({ prompt: quote.prompt, slides: quote.slides, platform, modelId: quote.model, ...SUNRA_SLIDE_SIZE[platform] });
      if (images.length !== quote.slides) throw new Error(`Sunra returned ${images.length} of ${quote.slides} slides`);
      const keys: string[] = [];
      for (const [i, img] of images.entries()) {
        const key = `${quote.clientId}/sunra/${quote.id}/slide-${i + 1}.png`;
        await fs.mkdir(path.dirname(path.join(env.STORAGE_DIR, key)), { recursive: true });
        await fs.writeFile(path.join(env.STORAGE_DIR, key), img);
        keys.push(key);
      }
      await prisma.sunraQuote.update({ where: { id: quote.id }, data: { status: "done", resultKeys: keys } });
      const out: SunraGenerateResult = { quoteId: quote.id, modelId: quote.model, status: "done", slideUrls: keys.map(fileLink) };
      return out;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await prisma.sunraQuote.update({ where: { id: quote.id }, data: { status: "failed", error } });
      const out: SunraGenerateResult = { quoteId: quote.id, modelId: quote.model, status: "failed", slideUrls: [], error };
      return reply.status(502).send(out);
    }
  });
}
