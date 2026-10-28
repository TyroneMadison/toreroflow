import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPrisma, type Template as TemplateRow } from "@toreroflow/db";
import {
  canEditTemplates,
  hasScope,
  TemplateApplyRequestSchema,
  TemplateUpsertSchema,
  WorkflowPlatformSchema,
  type Draft,
  type Scope,
  type Template,
} from "@toreroflow/contracts";
import { principalOf, requireAuth } from "../plugins/requireAuth";
import { suggestCadence } from "../workflow/cadence";

/**
 * W5 templates, per client (brandId is the Client id) and brand scope.
 * The operator and Polly (full access) read, apply, create, edit and delete.
 * Any other bot reads and applies at most, and only with the templates:read
 * or templates:apply scope on its BotIdentity; by default it has neither.
 */
const toTemplate = (t: TemplateRow): Template => ({
  id: t.id,
  scope: t.scope,
  brandId: t.clientId,
  name: t.name,
  platforms: t.platforms.flatMap((p) => {
    const parsed = WorkflowPlatformSchema.safeParse(p);
    return parsed.success ? [parsed.data] : [];
  }),
  captionPattern: t.captionPattern,
  hashtags: t.hashtags,
  coverStyle: t.coverStyle,
  postTimes: t.postTimes,
  cadence: t.cadence,
});

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  /** Refuses and returns false when the caller lacks the scope. */
  const need = async (request: FastifyRequest, reply: FastifyReply, scope: Scope | "edit"): Promise<boolean> => {
    const p = principalOf(request);
    if (scope === "edit" ? canEditTemplates(p) : hasScope(p, scope)) return true;
    await reply.status(403).send({ error: scope === "edit" ? "editing templates needs the operator or Polly" : `needs ${scope}` });
    return false;
  };
  const ownClient = (id: string, agencyId: string) =>
    prisma.client.findFirst({ where: { id, agencyId, deletedAt: null }, select: { id: true } });
  const ownTemplate = (id: string, agencyId: string) =>
    prisma.template.findFirst({ where: { id, client: { agencyId } } });
  const data = (body: ReturnType<typeof TemplateUpsertSchema.parse>) => ({
    clientId: body.brandId,
    scope: body.scope,
    name: body.name,
    platforms: body.platforms,
    captionPattern: body.captionPattern,
    hashtags: body.hashtags,
    coverStyle: body.coverStyle,
    postTimes: body.postTimes,
    cadence: body.cadence,
  });

  app.get<{ Querystring: { brandId?: string } }>("/templates", async (request, reply) => {
    if (!(await need(request, reply, "templates:read"))) return;
    const rows = await prisma.template.findMany({
      where: { client: { agencyId: request.user.agencyId }, ...(request.query.brandId ? { clientId: request.query.brandId } : {}) },
      orderBy: { createdAt: "asc" },
    });
    return { templates: rows.map(toTemplate) };
  });

  app.get<{ Querystring: { brandId?: string } }>("/templates/cadence", async (request, reply) => {
    if (!(await need(request, reply, "templates:read"))) return;
    const brandId = request.query.brandId ?? "";
    if (!(await ownClient(brandId, request.user.agencyId))) return reply.status(404).send({ error: "brand not found" });
    const now = new Date();
    const targets = await prisma.postTarget.findMany({
      where: { status: "posted", publishedAt: { gte: new Date(now.getTime() - 10 * 7 * 86_400_000) }, post: { clientId: brandId } },
      select: { postId: true, publishedAt: true, postMetrics: { orderBy: { capturedAt: "desc" }, take: 1, select: { views: true } } },
    });
    // One entry per post: its first publish, its views summed across platforms.
    const posts = new Map<string, { at: Date; views: number | null }>();
    for (const t of targets) {
      const views = t.postMetrics[0]?.views ?? null;
      const p = posts.get(t.postId);
      if (!p) posts.set(t.postId, { at: t.publishedAt!, views });
      else {
        if (t.publishedAt! < p.at) p.at = t.publishedAt!;
        if (views != null) p.views = (p.views ?? 0) + views;
      }
    }
    return suggestCadence(brandId, [...posts.values()], now);
  });

  app.post("/templates", async (request, reply) => {
    if (!(await need(request, reply, "edit"))) return;
    const parsed = TemplateUpsertSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid template", detail: parsed.error.issues });
    if (!(await ownClient(parsed.data.brandId, request.user.agencyId))) return reply.status(404).send({ error: "brand not found" });
    return toTemplate(await prisma.template.create({ data: data(parsed.data) }));
  });

  app.put<{ Params: { id: string } }>("/templates/:id", async (request, reply) => {
    if (!(await need(request, reply, "edit"))) return;
    const parsed = TemplateUpsertSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid template", detail: parsed.error.issues });
    if (!(await ownTemplate(request.params.id, request.user.agencyId))) return reply.status(404).send({ error: "template not found" });
    if (!(await ownClient(parsed.data.brandId, request.user.agencyId))) return reply.status(404).send({ error: "brand not found" });
    return toTemplate(await prisma.template.update({ where: { id: request.params.id }, data: data(parsed.data) }));
  });

  app.delete<{ Params: { id: string } }>("/templates/:id", async (request, reply) => {
    if (!(await need(request, reply, "edit"))) return;
    if (!(await ownTemplate(request.params.id, request.user.agencyId))) return reply.status(404).send({ error: "template not found" });
    await prisma.template.delete({ where: { id: request.params.id } });
    return { ok: true as const };
  });

  /**
   * A prefilled draft for the W1 composer, not saved: one target per template
   * platform with no overrides, the caption pattern with the hashtags under
   * it. The video must belong to the template's brand.
   */
  app.post<{ Params: { id: string } }>("/templates/:id/apply", async (request, reply) => {
    if (!(await need(request, reply, "templates:apply"))) return;
    const parsed = TemplateApplyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "videoId and an ISO postAt are required" });
    const row = await ownTemplate(request.params.id, request.user.agencyId);
    if (!row) return reply.status(404).send({ error: "template not found" });
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: parsed.data.videoId, clientId: row.clientId },
      select: { id: true, draftCopy: true },
    });
    if (!asset) return reply.status(404).send({ error: "video not found for this brand" });
    const t = toTemplate(row);
    const tagLine = t.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
    const title = (asset.draftCopy as { name?: unknown } | null)?.name;
    const draft: Draft = {
      id: `template-${t.id}-${asset.id}`,
      brandId: t.brandId,
      videoId: asset.id,
      caption: [t.captionPattern, tagLine].filter(Boolean).join("\n\n"),
      ...(typeof title === "string" && title ? { title } : {}),
      postAt: parsed.data.postAt,
      targets: t.platforms.map((platform) => ({ platform, overrides: {} })),
    };
    return draft;
  });
}
