import type { FastifyInstance } from "fastify";
import IORedis from "ioredis";
import type { HealthResponse } from "@toreroflow/core";
import { env } from "../env";

/**
 * Is the stack actually working, not just answering.
 *
 * The worker is reported separately because the two fail apart. The API can be
 * perfectly healthy while nothing is transcoding video, publishing posts or
 * pulling analytics, and from the app that looks like an upload that never
 * finishes rather than a process that is not running.
 */

/** Written by the worker every 30s with a TTL, so it expires when it dies. */
const HEARTBEAT_KEY = "toreroflow:worker:alive";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const redis = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    // Health has to answer even when Redis is the thing that is down.
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on("error", () => undefined);
  void redis.connect().catch(() => undefined);

  app.addHook("onClose", async () => {
    redis.disconnect();
  });

  app.get("/health", async (): Promise<HealthResponse> => {
    let worker: "up" | "down" = "down";
    try {
      worker = (await redis.exists(HEARTBEAT_KEY)) === 1 ? "up" : "down";
    } catch {
      // Redis unreachable means the worker cannot be running either.
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
