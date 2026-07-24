import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "@toreroflow/core";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "toreroflow-api",
    version: "0.1.0",
    time: new Date().toISOString(),
  }));
}
