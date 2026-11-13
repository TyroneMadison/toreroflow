import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { cleanWordList, fontFamilyName, fontFileName } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { env } from "../env";
import { fileLink } from "../files/link";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Phase 7 polish: the client's censor word list and per-client fonts.
 * Fonts live at STORAGE_DIR/<clientId>/fonts/<name>.ttf|otf; the worker
 * copies them next to the bundled fonts for each render, and the preview
 * loads them through signed file links.
 */

const bad = (detail: string, error = "that request was not right") => ({ error, detail });
const NOT_FOUND = { error: "not found", detail: "no such client in this agency" };
const wordsBody = z.object({ words: z.array(z.string().max(60)).max(500) });
const MAX_FONT_BYTES = 15 * 1024 * 1024;

export async function polishRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const owned = (id: string, agencyId: string) =>
    prisma.client.findFirst({ where: { id, agencyId, deletedAt: null }, select: { id: true, censorWords: true } });
  const fontsDir = (clientId: string) => path.join(env.STORAGE_DIR, clientId, "fonts");

  app.get<{ Params: { id: string } }>("/clients/:id/censor-words", async (request, reply) => {
    const c = await owned(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(NOT_FOUND);
    return { words: c.censorWords };
  });

  app.put<{ Params: { id: string } }>("/clients/:id/censor-words", async (request, reply) => {
    const c = await owned(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(NOT_FOUND);
    const parsed = wordsBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "words must be a list"));
    const words = cleanWordList(parsed.data.words);
    await prisma.client.update({ where: { id: c.id }, data: { censorWords: words } });
    return { words };
  });

  const listFonts = async (clientId: string) => {
    const dir = fontsDir(clientId);
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /\.(ttf|otf)$/i.test(f)).sort();
    const out: { file: string; family: string; url: string }[] = [];
    for (const file of names) {
      const buf = await fs.readFile(path.join(dir, file)).catch(() => null);
      const family = (buf && fontFamilyName(new Uint8Array(buf))) || file.replace(/\.(ttf|otf)$/i, "");
      out.push({ file, family, url: fileLink(`${clientId}/fonts/${file}`) });
    }
    return out;
  };

  app.get<{ Params: { id: string } }>("/clients/:id/fonts", async (request, reply) => {
    const c = await owned(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(NOT_FOUND);
    return { fonts: await listFonts(c.id) };
  });

  app.post<{ Params: { id: string } }>("/clients/:id/fonts", async (request, reply) => {
    const c = await owned(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(NOT_FOUND);
    const file = await request.file();
    if (!file) return reply.status(400).send(bad("send a .ttf or .otf file", "no file uploaded"));
    const name = fontFileName(file.filename ?? "");
    if (!name) {
      file.file.resume();
      return reply.status(400).send(bad("only .ttf and .otf fonts work in exports", "not a font file"));
    }
    const buf = await file.toBuffer();
    if (buf.length > MAX_FONT_BYTES) return reply.status(400).send(bad("fonts are capped at 15 MB", "font too large"));
    const family = fontFamilyName(new Uint8Array(buf));
    if (!family) return reply.status(400).send(bad("the file has no readable font name table", "not a font file"));
    await fs.mkdir(fontsDir(c.id), { recursive: true });
    await fs.writeFile(path.join(fontsDir(c.id), name), buf);
    return { font: { file: name, family, url: fileLink(`${c.id}/fonts/${name}`) }, fonts: await listFonts(c.id) };
  });

  app.delete<{ Params: { id: string; file: string } }>("/clients/:id/fonts/:file", async (request, reply) => {
    const c = await owned(request.params.id, request.user.agencyId);
    if (!c) return reply.status(404).send(NOT_FOUND);
    const file = path.basename(request.params.file);
    if (!/\.(ttf|otf)$/i.test(file)) return reply.status(400).send(bad("not a font file name"));
    await fs.rm(path.join(fontsDir(c.id), file), { force: true });
    return { fonts: await listFonts(c.id) };
  });
}
