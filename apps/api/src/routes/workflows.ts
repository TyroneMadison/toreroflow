import type { FastifyInstance } from "fastify";
import { createWorkflowSchema, updateWorkflowSchema } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Repurpose.io-style fan-out rules: when a video is posted to a client's
 * sourcePlatform, the publish pipeline (M3) automatically creates PostTargets
 * for every platform in destinations. M1/M2 store and manage the rules; M3
 * executes them.
 */
export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.addHook("onRequest", requireAuth);

  const ownedClient = async (clientId: string, agencyId: string) =>
    prisma.client.findFirst({
      where: { id: clientId, agencyId, deletedAt: null },
    });

  app.get<{ Params: { id: string } }>("/clients/:id/workflows", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    return prisma.workflow.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: "asc" },
    });
  });

  app.post<{ Params: { id: string } }>("/clients/:id/workflows", async (request, reply) => {
    const client = await ownedClient(request.params.id, request.user.agencyId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    const body = createWorkflowSchema.parse(request.body);
    if (body.destinations.includes(body.sourcePlatform)) {
      return reply
        .status(400)
        .send({ error: "destinations must not include the source platform" });
    }
    const workflow = await prisma.workflow.create({
      data: {
        clientId: client.id,
        name: body.name,
        sourcePlatform: body.sourcePlatform,
        destinations: body.destinations,
      },
    });
    return reply.status(201).send(workflow);
  });

  app.patch<{ Params: { id: string } }>("/workflows/:id", async (request, reply) => {
    const body = updateWorkflowSchema.parse(request.body);
    const workflow = await prisma.workflow.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId, deletedAt: null },
      },
    });
    if (!workflow) return reply.status(404).send({ error: "workflow not found" });

    const sourcePlatform = body.sourcePlatform ?? workflow.sourcePlatform;
    const destinations = body.destinations ?? workflow.destinations;
    if (destinations.includes(sourcePlatform)) {
      return reply
        .status(400)
        .send({ error: "destinations must not include the source platform" });
    }

    return prisma.workflow.update({
      where: { id: workflow.id },
      data: {
        name: body.name,
        sourcePlatform: body.sourcePlatform,
        destinations: body.destinations,
        enabled: body.enabled,
      },
    });
  });

  app.delete<{ Params: { id: string } }>("/workflows/:id", async (request, reply) => {
    const workflow = await prisma.workflow.findFirst({
      where: {
        id: request.params.id,
        client: { agencyId: request.user.agencyId, deletedAt: null },
      },
    });
    if (!workflow) return reply.status(404).send({ error: "workflow not found" });
    await prisma.workflow.delete({ where: { id: workflow.id } });
    return { ok: true };
  });
}
