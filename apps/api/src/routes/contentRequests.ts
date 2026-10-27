import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { ContentRequestSchema, TrelloIntakeConfigSchema } from "@toreroflow/contracts";
import { requireAuth } from "../plugins/requireAuth";
import { pushRequestToTrello, readIntakeConfig, TRELLO_INTAKE_SETTING } from "../ideas/trelloIntake";
import { writeSetting } from "../ideas/settings";

const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 5;

/**
 * The public request form: no login. Spam protection is a honeypot field
 * ("website", hidden in the form, bots fill it) plus 5 requests per IP per
 * 10 minutes. The request is stored first, so a Trello outage loses nothing.
 *
 * ponytail: the rate limit lives in memory, per process; move it to the
 * database if the API ever runs on more than one server.
 */
export async function publicContentRequestRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const hits = new Map<string, number[]>();

  app.post("/requests", async (request, reply) => {
    const now = Date.now();
    const recent = (hits.get(request.ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= PER_WINDOW) return reply.status(429).send({ error: "too many requests, try again in a few minutes" });
    hits.set(request.ip, [...recent, now]);

    const raw = (request.body ?? {}) as Record<string, unknown>;
    // A filled honeypot gets the same answer as a real request and is dropped.
    if (typeof raw.website === "string" && raw.website.trim()) return reply.status(201).send({ ok: true });
    const body = ContentRequestSchema.parse(raw);
    const client = await prisma.client.findFirst({ where: { id: body.brandId, deletedAt: null }, select: { id: true } });
    if (!client) return reply.status(404).send({ error: "brand not found" });
    const saved = await prisma.contentRequest.create({
      data: {
        clientId: client.id,
        what: body.what,
        dueDate: body.dueDate ?? null,
        footageUrl: body.footageUrl ?? null,
        notes: body.notes ?? null,
      },
    });
    await pushRequestToTrello(saved.id);
    return reply.status(201).send({ ok: true });
  });
}

/** Operator side: the request list with card status, Retry, and the intake config. */
export async function contentRequestRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  const isViewer = (request: { user: object }) => (request.user as { role?: string }).role === "viewer";

  app.get<{ Querystring: { brandId?: string } }>("/requests", async (request) => {
    const requests = await prisma.contentRequest.findMany({
      where: { client: { agencyId: request.user.agencyId }, ...(request.query.brandId ? { clientId: request.query.brandId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return { requests };
  });

  app.post<{ Params: { id: string } }>("/requests/:id/retry", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change Trello" });
    const req = await prisma.contentRequest.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
      select: { id: true },
    });
    if (!req) return reply.status(404).send({ error: "request not found" });
    return pushRequestToTrello(req.id);
  });

  app.get("/trello/intake-config", async (request) => readIntakeConfig(request.user.agencyId));

  /** labelByBrand: brandId to Trello label id. Null ids make the next card look the board up again. */
  app.put("/trello/intake-config", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change Trello" });
    const config = TrelloIntakeConfigSchema.extend({
      labelByBrand: z.record(z.string(), z.string().regex(/^[a-f0-9]{24}$/, "a Trello label id")),
    }).parse(request.body);
    await writeSetting(request.user.agencyId, TRELLO_INTAKE_SETTING, config);
    return config;
  });
}
