import type { FastifyInstance } from "fastify";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getPrisma } from "@toreroflow/db";
import { BrandKitSchema, type BrandKit } from "@toreroflow/contracts";
import { env } from "../env";
import { fileLink } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";
import { findFont, fontProblem, GOOGLE_FONTS } from "../ideas/googleFonts";

const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

/** Brand kit per brand: fonts from the Google Fonts list, colors, logo, voice notes. */
export async function brandKitRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const ownBrand = (agencyId: string, id: string) =>
    prisma.client.findFirst({ where: { id, agencyId, deletedAt: null }, select: { id: true, agencyId: true } });

  /** The kit as the contract shapes it, plus a signed link to the logo. */
  async function view(brandId: string): Promise<BrandKit & { logoUrl: string | null }> {
    const row = await prisma.brandKit.findUnique({ where: { clientId: brandId } });
    const kit = BrandKitSchema.parse({
      brandId,
      fonts: row?.fonts ?? [],
      colors: row?.colors ?? [],
      logoAssetId: row?.logoAssetId ?? null,
      voiceNotes: row?.voiceNotes ?? "",
    });
    const logo = kit.logoAssetId ? await prisma.libraryAsset.findUnique({ where: { id: kit.logoAssetId } }) : null;
    return { ...kit, logoUrl: logo ? fileLink(logo.storageKey) : null };
  }

  app.get("/brand-kit/fonts", async () => ({ fonts: GOOGLE_FONTS }));

  app.get<{ Params: { brandId: string } }>("/brands/:brandId/kit", async (request, reply) => {
    const brand = await ownBrand(request.user.agencyId, request.params.brandId);
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    return view(brand.id);
  });

  app.put<{ Params: { brandId: string } }>("/brands/:brandId/kit", async (request, reply) => {
    const brand = await ownBrand(request.user.agencyId, request.params.brandId);
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    const kit = BrandKitSchema.parse(request.body);
    if (kit.brandId !== brand.id) return reply.status(400).send({ error: "brandId does not match the brand in the path" });
    const problem = fontProblem(kit.fonts);
    if (problem) return reply.status(400).send({ error: problem });
    if (kit.logoAssetId) {
      const logo = await prisma.libraryAsset.findFirst({
        where: { id: kit.logoAssetId, agencyId: brand.agencyId, type: "logo", OR: [{ clientId: brand.id }, { clientId: null }] },
      });
      if (!logo) return reply.status(400).send({ error: "logoAssetId is not a logo this brand can use" });
    }
    const data = {
      fonts: kit.fonts.map((x) => ({ family: findFont(x.family)!.family, weights: [...new Set(x.weights)].sort((a, b) => a - b) })),
      colors: [...new Set(kit.colors.map((c) => c.toUpperCase()))],
      logoAssetId: kit.logoAssetId,
      voiceNotes: kit.voiceNotes.slice(0, 4000),
    };
    await prisma.brandKit.upsert({ where: { clientId: brand.id }, create: { clientId: brand.id, ...data }, update: data });
    return view(brand.id);
  });

  /** Upload the logo (PNG, JPEG or WebP, 5 MB): stored as a library asset and set on the kit. */
  app.post<{ Params: { brandId: string } }>("/brands/:brandId/kit/logo", async (request, reply) => {
    const brand = await ownBrand(request.user.agencyId, request.params.brandId);
    if (!brand) return reply.status(404).send({ error: "brand not found" });
    const file = await request.file({ limits: { fileSize: LOGO_MAX_BYTES } });
    if (!file) return reply.status(400).send({ error: "no file uploaded" });
    const ext = LOGO_TYPES[file.mimetype];
    if (!ext) {
      file.file.resume();
      return reply.status(400).send({ error: "logo must be a PNG, JPEG or WebP" });
    }
    const asset = await prisma.libraryAsset.create({
      data: {
        agencyId: brand.agencyId,
        clientId: brand.id,
        type: "logo",
        name: (file.filename || `logo.${ext}`).slice(0, 200),
        storageKey: "",
        mimeType: file.mimetype,
      },
    });
    const storageKey = `${brand.id}/brand-kit/logo-${asset.id}.${ext}`;
    const full = path.join(env.STORAGE_DIR, storageKey);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await pipeline(file.file, createWriteStream(full));
    if (file.file.truncated) {
      await fs.rm(full, { force: true });
      await prisma.libraryAsset.delete({ where: { id: asset.id } });
      return reply.status(413).send({ error: "logo is over 5 MB" });
    }
    const { size } = await fs.stat(full);
    await prisma.libraryAsset.update({ where: { id: asset.id }, data: { storageKey, sizeBytes: size } });
    await prisma.brandKit.upsert({
      where: { clientId: brand.id },
      create: { clientId: brand.id, logoAssetId: asset.id },
      update: { logoAssetId: asset.id },
    });
    return view(brand.id);
  });
}
