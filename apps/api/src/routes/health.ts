import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";

/**
 * Is the stack actually working, not just answering.
 *
 * The worker is reported separately because the two fail apart. The API can be
 * perfectly healthy while nothing is transcoding video, publishing posts or
 * pulling analytics, and from the app that looks like an upload that never
 * finishes rather than a process that is not running.
 */

/**
 * How old the worker's last stamp can be before it counts as dead.
 *
 * It stamps every 30 seconds. Three beats of slack, so one slow tick under
 * load does not flip the app to "worker down" while it is working fine.
 *
 * This was a Redis key with a TTL that expired on its own. Postgres has no
 * TTL, so staleness is judged here instead. The half that matters is unchanged:
 * a worker that is killed cannot clear anything on the way out, so this must go
 * stale by itself rather than depend on being tidied up.
 */
const HEARTBEAT_STALE_MS = 90_000;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get("/health", async (): Promise<HealthResponse> => {
    let worker: "up" | "down" = "down";
    try {
      const beat = await prisma.workerHeartbeat.findUnique({ where: { id: "worker" } });
      worker =
        beat && Date.now() - beat.beatAt.getTime() < HEARTBEAT_STALE_MS ? "up" : "down";
    } catch {
      // The database being unreachable is its own problem, but it does mean
      // nothing can be said about the worker, and "down" is the safer answer.
    }
    return {
      status: "ok",
      service: "toreroflow-api",
      version: "0.1.0",
      time: new Date().toISOString(),
      worker,
    };
  });
}
