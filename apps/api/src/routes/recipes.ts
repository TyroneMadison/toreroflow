import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyRecipe, recipeSummary, transcriptFromDoc, type EditDoc, type RecipeSettings } from "@toreroflow/core";
import { getPrisma, Prisma } from "@toreroflow/db";
import { requireAuth } from "../plugins/requireAuth";
import { projectMedia, recipeSettingsSchema, saveVersion } from "./editShared";

/**
 * Phase 6: recipes (a brand's saved edit style), edit versions, and
 * SRT/TXT transcript export.
 */

const recipeBody = z.object({
  name: z.string().trim().min(1).max(80),
  settings: recipeSettingsSchema,
  isDefault: z.boolean().optional(),
});
const versionBody = z.object({ label: z.string().trim().min(1).max(120).optional() });
const bad = (detail: string, error = "that request was not right") => ({ error, detail });

export async function recipeRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const ownedClient = (clientId: string, agencyId: string) =>
    prisma.client.findFirst({ where: { id: clientId, agencyId, deletedAt: null }, select: { id: true } });
  const ownedRecipe = (id: string, agencyId: string) => prisma.recipe.findFirst({ where: { id, client: { agencyId } } });
  const ownedProject = (id: string, agencyId: string) =>
    prisma.editProject.findFirst({ where: { id, client: { agencyId } } });

  const view = (r: { id: string; clientId: string; name: string; isDefault: boolean; settings: unknown; updatedAt: Date }) => ({
    id: r.id,
    clientId: r.clientId,
    name: r.name,
    isDefault: r.isDefault,
    settings: r.settings,
    summary: recipeSummary(r.settings as RecipeSettings),
    updatedAt: r.updatedAt,
  });

  /** One default per brand: setting one clears the rest in the same transaction. */
  async function writeDefault(clientId: string, id: string) {
    await prisma.$transaction([
      prisma.recipe.updateMany({ where: { clientId, NOT: { id } }, data: { isDefault: false } }),
      prisma.recipe.update({ where: { id }, data: { isDefault: true } }),
    ]);
  }

  app.get<{ Params: { clientId: string } }>("/clients/:clientId/recipes", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found" });
    const rows = await prisma.recipe.findMany({ where: { clientId: client.id }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] });
    return { recipes: rows.map(view) };
  });

  app.post<{ Params: { clientId: string } }>("/clients/:clientId/recipes", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "brand not found" });
    const parsed = recipeBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the recipe."));
    const r = await prisma.recipe.create({
      data: { clientId: client.id, name: parsed.data.name, settings: parsed.data.settings as Prisma.InputJsonValue },
    });
    if (parsed.data.isDefault) await writeDefault(client.id, r.id);
    return reply.status(201).send(view({ ...r, isDefault: !!parsed.data.isDefault }));
  });

  app.patch<{ Params: { id: string } }>("/recipes/:id", async (request, reply) => {
    const r = await ownedRecipe(request.params.id, request.user.agencyId);
    if (!r) return reply.status(404).send({ error: "recipe not found" });
    const parsed = recipeBody.partial().safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the recipe."));
    const { name, settings, isDefault } = parsed.data;
    let row = await prisma.recipe.update({
      where: { id: r.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(settings !== undefined ? { settings: settings as Prisma.InputJsonValue } : {}),
        ...(isDefault === false ? { isDefault: false } : {}),
      },
    });
    if (isDefault) {
      await writeDefault(r.clientId, r.id);
      row = { ...row, isDefault: true };
    }
    return view(row);
  });

  app.post<{ Params: { id: string } }>("/recipes/:id/default", async (request, reply) => {
    const r = await ownedRecipe(request.params.id, request.user.agencyId);
    if (!r) return reply.status(404).send({ error: "recipe not found" });
    await writeDefault(r.clientId, r.id);
    return view({ ...r, isDefault: true });
  });

  app.delete<{ Params: { id: string } }>("/recipes/:id", async (request, reply) => {
    const r = await ownedRecipe(request.params.id, request.user.agencyId);
    if (!r) return reply.status(404).send({ error: "recipe not found" });
    await prisma.recipe.delete({ where: { id: r.id } });
    return { ok: true };
  });

  /**
   * The recipe over a project's current doc, returned not saved: the
   * desktop applies it through update() so it is one undo step.
   */
  app.post<{ Params: { id: string; projectId: string } }>("/recipes/:id/apply/:projectId", async (request, reply) => {
    const r = await ownedRecipe(request.params.id, request.user.agencyId);
    if (!r) return reply.status(404).send({ error: "recipe not found" });
    const p = await ownedProject(request.params.projectId, request.user.agencyId);
    if (!p || p.clientId !== r.clientId) return reply.status(404).send({ error: "project not found" });
    const body = (request.body ?? {}) as { doc?: unknown };
    const doc = (body.doc && typeof body.doc === "object" ? body.doc : p.doc) as EditDoc | null;
    if (!doc) return reply.status(400).send(bad("This project has no edit yet.", "nothing to apply to"));
    const { durations, words } = await projectMedia(p.id);
    const out = applyRecipe(doc, r.settings as RecipeSettings, durations, words);
    return { doc: out.doc, change: out.change };
  });

  // Versions -------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/edit-projects/:id/versions", async (request, reply) => {
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send({ error: "project not found" });
    const rows = await prisma.editVersion.findMany({
      where: { projectId: p.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, auto: true, createdAt: true },
    });
    return { versions: rows };
  });

  /** Save the doc sent (the desktop's live doc) or, without one, the stored doc. */
  app.post<{ Params: { id: string } }>("/edit-projects/:id/versions", async (request, reply) => {
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send({ error: "project not found" });
    const parsed = versionBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the label."));
    const body = (request.body ?? {}) as { doc?: unknown };
    const doc = body.doc && typeof body.doc === "object" ? body.doc : p.doc;
    if (!doc) return reply.status(400).send(bad("Make an edit before saving a version.", "nothing to save"));
    const count = await prisma.editVersion.count({ where: { projectId: p.id } });
    const v = await saveVersion(p.id, doc, parsed.data.label ?? `Version ${count + 1}`);
    return reply.status(201).send(v);
  });

  /**
   * A version's doc, not written: the desktop applies it through update(),
   * so Restore is undoable and the autosave stores it like any edit.
   */
  app.get<{ Params: { id: string; versionId: string } }>("/edit-projects/:id/versions/:versionId", async (request, reply) => {
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send({ error: "project not found" });
    const v = await prisma.editVersion.findFirst({ where: { id: request.params.versionId, projectId: p.id } });
    if (!v) return reply.status(404).send({ error: "version not found" });
    return { id: v.id, label: v.label, auto: v.auto, createdAt: v.createdAt, doc: v.doc };
  });

  // Transcript export ------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/edit-projects/:id/transcript", async (request, reply) => {
    const p = await ownedProject(request.params.id, request.user.agencyId);
    if (!p) return reply.status(404).send({ error: "project not found" });
    const format = request.query.format === "txt" ? "txt" : "srt";
    if (!p.doc) return reply.status(400).send(bad("Make an edit first.", "nothing to export"));
    const { durations, words } = await projectMedia(p.id);
    const t = transcriptFromDoc(p.doc as unknown as EditDoc, durations, words);
    const base = (p.name || "transcript").replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "transcript";
    return reply
      .header("content-type", format === "srt" ? "application/x-subrip; charset=utf-8" : "text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="${base}.${format}"`)
      .send(format === "srt" ? t.srt : t.txt);
  });
}
