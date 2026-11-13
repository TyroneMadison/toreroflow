import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { RepurposeJobSchema, type RepurposeJob } from "@toreroflow/contracts";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Repurpose jobs for the in-app editor (Create > Studio > Edit). A backend
 * stub: jobs are created, tracked step by step and retried, but no step
 * runner exists yet and no outside provider is called. The worker that runs
 * the steps (transcribe, find moments, cut, captions, thumbnails) plugs into
 * `advance` once the provider decision is made.
 */

export const STEPS = RepurposeJobSchema.shape.step.options;
type Step = RepurposeJob["step"];
type State = RepurposeJob["state"];
export type RepurposeEvent = "start" | "succeed" | "fail" | "retry";

/**
 * The state machine. A step goes queued, running, then either on to the next
 * step (queued) or failed; a failed step retries in place, so a job resumes
 * where it stopped instead of starting over. "review" waits for the operator,
 * and its succeed is the operator finishing the review. Null means the event
 * does not apply.
 */
export function advance(job: { step: Step; state: State }, event: RepurposeEvent): { step: Step; state: State } | null {
  const { step, state } = job;
  if (state === "done") return null;
  if (event === "start") return state === "queued" ? { step, state: "running" } : null;
  if (event === "fail") return state === "running" ? { step, state: "failed" } : null;
  if (event === "retry") return state === "failed" ? { step, state: "queued" } : null;
  if (state !== "running") return null;
  const next = STEPS[STEPS.indexOf(step) + 1] as Step;
  return next === "done" ? { step: "done", state: "done" } : { step: next, state: "queued" };
}

const view = (j: { id: string; sourceVideoId: string; step: string; state: string }): RepurposeJob =>
  RepurposeJobSchema.parse({ id: j.id, sourceVideoId: j.sourceVideoId, step: j.step, state: j.state });

export async function repurposeRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  const own = (agencyId: string, id: string) => prisma.repurposeJob.findFirst({ where: { id, client: { agencyId } } });

  app.post("/repurpose", async (request, reply) => {
    const { sourceVideoId } = z.object({ sourceVideoId: z.string().min(1) }).parse(request.body);
    const video = await prisma.mediaAsset.findFirst({
      where: { id: sourceVideoId, kind: "video", client: { agencyId: request.user.agencyId } },
      select: { id: true, clientId: true },
    });
    if (!video) return reply.status(404).send({ error: "video not found" });
    const job = await prisma.repurposeJob.create({ data: { clientId: video.clientId, sourceVideoId: video.id } });
    return reply.status(201).send(view(job));
  });

  app.get<{ Params: { id: string } }>("/repurpose/:id", async (request, reply) => {
    const job = await own(request.user.agencyId, request.params.id);
    return job ? view(job) : reply.status(404).send({ error: "job not found" });
  });

  /** Retry the failed step only; finished steps are kept. */
  app.post<{ Params: { id: string } }>("/repurpose/:id/retry", async (request, reply) => {
    const job = await own(request.user.agencyId, request.params.id);
    if (!job) return reply.status(404).send({ error: "job not found" });
    const next = advance(job as { step: Step; state: State }, "retry");
    if (!next) return reply.status(409).send({ error: `only a failed step can be retried; this job is ${job.state}` });
    const saved = await prisma.repurposeJob.update({ where: { id: job.id }, data: { ...next, error: null } });
    return view(saved);
  });
}
