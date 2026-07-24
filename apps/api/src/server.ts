import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { env } from "./env";
import { healthRoutes } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { clientRoutes } from "./routes/clients";
import { workflowRoutes } from "./routes/workflows";
import { mediaRoutes } from "./routes/media";

// Typed JWT payload so app.jwt.sign(...) and request.user are strict.
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; agencyId: string };
    user: { sub: string; agencyId: string };
  }
}

export interface BuildServerOptions {
  logger?: boolean;
}

/**
 * Factory so tests can build an instance and use app.inject() without
 * binding a port.
 */
export async function buildServer(
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });

  // origin: true - desktop webview origins vary between dev
  // (http://localhost:1420) and prod (tauri.localhost); tighten in M6.
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(multipart, {
    limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1 },
  });
  // Local media serving for the desktop webview (dev storage; R2/S3 later).
  await app.register(fastifyStatic, {
    root: env.STORAGE_DIR,
    prefix: "/files/",
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "validation failed",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      app.log.error(error);
      return reply.status(statusCode).send({ error: "internal server error" });
    }
    const message = error instanceof Error ? error.message : "request failed";
    return reply.status(statusCode).send({ error: message });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(clientRoutes);
  await app.register(workflowRoutes);
  await app.register(mediaRoutes);

  return app;
}
