import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getPrisma } from "@toreroflow/db";
import {
  SunraCarouselRequestSchema,
  SunraGenerateRequestSchema,
  SunraSettingsSchema,
  type SunraCarouselQuote,
} from "@toreroflow/contracts";
import { env } from "../env";
import { fileLink } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";
import { readSetting, writeSetting } from "../ideas/settings";

/**
 * Sunra carousels for Instagram and TikTok: price check first, spend second.
 *
 * Generating costs money, so it takes three things at once: the agency's
 * generation switch ON (default OFF), a quote for this exact request that has
 * not expired, and `approved: true` sent for that quote. A quote is used at
 * most once, claimed atomically so a double tap cannot pay twice.
 *
 * There is no Sunra client in this codebase yet, so the generator is unset
 * and generate answers 503 even when approved. setSunraGenerator wires one in
 * (the checks use a fake; nothing here calls Sunra).
 */

export const SUNRA_SETTING = "sunra";
export const QUOTE_TTL_MS = 15 * 60 * 1000;
export const IG_MAX_SLIDES = 10;

export type SunraGenerator = (input: { prompt: string; slides: number; platform: string }) => Promise<Buffer[]>;
let generator: SunraGenerator | null = null;
export function setSunraGenerator(g: SunraGenerator | null): void {
  generator = g;
}

const readSunraSettings = (agencyId: string) =>
  readSetting(agencyId, SUNRA_SETTING, SunraSettingsSchema, { generationEnabled: false });

export async function sunraRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.get("/sunra/settings", async (request) => readSunraSettings(request.user.agencyId));
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
    if (env.SUNRA_PRICE_PER_IMAGE_USD == null) {
      return reply.status(503).send({ error: "set SUNRA_PRICE_PER_IMAGE_USD on the API server to price Sunra carousels" });
    }
    const brand = await prisma.client.findFirst({
      where: { id: body.brandId, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    const quote = await prisma.sunraQuote.create({
      data: {
        clientId: brand.id,
        platform: body.platform,
        slides: body.slides,
        prompt: body.prompt,
        priceUsd: Math.round(body.slides * env.SUNRA_PRICE_PER_IMAGE_USD * 100) / 100,
        expiresAt: new Date(Date.now() + QUOTE_TTL_MS),
      },
    });
    const out: SunraCarouselQuote = {
      quoteId: quote.id,
      priceUsd: quote.priceUsd,
      requiresApproval: true,
      expiresAt: quote.expiresAt.toISOString(),
    };
    return out;
  });

  app.post<{ Params: { quoteId: string } }>("/sunra/carousel/:quoteId/generate", async (request, reply) => {
    const parsed = SunraGenerateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "generation needs approved: true for this quote" });
    const { agencyId, sub, bot } = request.user;
    if (!(await readSunraSettings(agencyId)).generationEnabled) {
      return reply.status(403).send({ error: "Sunra generation is turned off in settings" });
    }
    const quote = await prisma.sunraQuote.findFirst({ where: { id: request.params.quoteId, client: { agencyId } } });
    if (!quote) return reply.status(404).send({ error: "quote not found" });
    if (quote.status !== "quoted") return reply.status(409).send({ error: "this quote was already used" });
    if (quote.expiresAt <= new Date()) return reply.status(410).send({ error: "this quote has expired, get a new price" });
    if (!generator) return reply.status(503).send({ error: "Sunra generation is not connected on this server" });

    // Claim the quote: only one request moves it out of "quoted".
    const claimed = await prisma.sunraQuote.updateMany({
      where: { id: quote.id, status: "quoted" },
      data: { status: "generating", approvedBy: bot ? `bot:${bot}` : sub, approvedAt: new Date() },
    });
    if (claimed.count !== 1) return reply.status(409).send({ error: "this quote was already used" });

    try {
      const images = await generator({ prompt: quote.prompt, slides: quote.slides, platform: quote.platform });
      const keys: string[] = [];
      for (const [i, img] of images.entries()) {
        const key = `${quote.clientId}/sunra/${quote.id}/slide-${i + 1}.png`;
        await fs.mkdir(path.dirname(path.join(env.STORAGE_DIR, key)), { recursive: true });
        await fs.writeFile(path.join(env.STORAGE_DIR, key), img);
        keys.push(key);
      }
      await prisma.sunraQuote.update({ where: { id: quote.id }, data: { status: "done", resultKeys: keys } });
      return { quoteId: quote.id, status: "done", slideUrls: keys.map(fileLink) };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await prisma.sunraQuote.update({ where: { id: quote.id }, data: { status: "failed", error } });
      return reply.status(502).send({ quoteId: quote.id, status: "failed", slideUrls: [], error });
    }
  });
}
