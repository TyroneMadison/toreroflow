import type { FastifyInstance } from "fastify";
import { ZernioProvider } from "@toreroflow/publishers";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import { postInsights } from "../ideas/insights";

/** Merged insights for one post, every number with its source. */
export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get<{ Params: { postId: string } }>("/insights/:postId", async (request, reply) => {
    const zernio =
      env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY) : null;
    const result = await postInsights(request.user.agencyId, request.params.postId, zernio);
    if (!result) return reply.status(404).send({ error: "post not found" });
    return result;
  });
}
