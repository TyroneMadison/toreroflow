import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { CAROUSEL_ABSOLUTE_MAX } from "@toreroflow/core";
import { env } from "./env";
import { verifyFileLink } from "./files/signing";
import { healthRoutes } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { clientRoutes } from "./routes/clients";
import { agencyRoutes } from "./routes/agency";
import { carouselRoutes } from "./routes/carousels";
import { editorRoutes } from "./routes/editor";
import { analysisRoutes } from "./routes/analysis";
import { ideasRoutes } from "./routes/ideas";
import { onboardingRoutes } from "./routes/onboarding";
import { bankRoutes } from "./routes/bank";
import { researchRoutes } from "./routes/research";
import { workflowRoutes } from "./routes/workflows";
import { dmCampaignRoutes } from "./routes/dmCampaigns";
import { mediaRoutes } from "./routes/media";
import { postRoutes } from "./routes/posts";
import { reportRoutes } from "./routes/reports";
import { overviewRoutes } from "./routes/overview";
import { financialsRoutes } from "./routes/financials";
import { deployRoutes } from "./routes/deploy";
import { oauthRoutes } from "./routes/oauth";

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

  /*
   * Who may make a cross-site request.
   *
   * This used to reflect whatever origin asked, which on 127.0.0.1 is a
   * shrug and on a public domain means any website a browser visits can call
   * this API with the operator's cookies and credentials attached.
   *
   * The desktop's own origin is not a fixed string: Tauri serves the webview
   * from tauri.localhost on Windows and from localhost:1420 in dev, and a
   * request from the webview may carry no Origin header at all. A request with
   * no origin is not a cross-site request, so it is allowed; a request that
   * names an origin has to be on the list.
   */
  await app.register(cors, {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (!env.IS_PRODUCTION) return cb(null, true);
      cb(null, env.ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, "")));
    },
    credentials: true,
  });
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(multipart, {
    // Ten files, because that is how many images Instagram takes in one
    // carousel. Video upload still reads a single file and is unaffected.
    limits: { fileSize: 4 * 1024 * 1024 * 1024, files: CAROUSEL_ABSOLUTE_MAX },
  });
  /*
   * Media for the desktop webview.
   *
   * Behind a signature, because this directory holds invoices carrying the
   * agency's EIN, tax exports carrying a year of revenue, every client's
   * videos and every game plan written for them. It used to be served with no
   * check in front of it at all, which was survivable while the only route to
   * it was 127.0.0.1 and is a data leak the moment the API answers on a public
   * domain.
   *
   * A hook rather than an auth plugin: the things that fetch these files are
   * <img>, <video> and the operating system's own browser, and not one of them
   * can be made to send an Authorization header. The signature travels in the
   * URL, which all three carry. See files/signing.ts.
   */
  await app.register(fastifyStatic, {
    root: env.STORAGE_DIR,
    prefix: "/files/",
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/files/")) return;
    const key = decodeURIComponent(request.url.slice("/files/".length).split("?")[0] ?? "");
    const verdict = verifyFileLink(
      key,
      request.query as { e?: unknown; s?: unknown },
      env.JWT_SECRET,
    );
    if (verdict === "ok") return;
    // 404 rather than 403 for a bad or missing signature: answering "forbidden"
    // confirms the file exists, which is the one thing a guessed path should
    // never learn. An expired link is different, because whoever holds it was
    // given it legitimately and needs to know to go back and reopen it.
    if (verdict === "expired") {
      return reply.status(410).send({ error: "this link has expired, open it from the app again" });
    }
    return reply.status(404).send({ error: "not found" });
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
  await app.register(agencyRoutes);
  await app.register(bankRoutes);
  await app.register(carouselRoutes);
  await app.register(editorRoutes);
  await app.register(analysisRoutes);
  await app.register(ideasRoutes);
  await app.register(onboardingRoutes);
  await app.register(researchRoutes);
  await app.register(workflowRoutes);
  await app.register(dmCampaignRoutes);
  await app.register(mediaRoutes);
  await app.register(postRoutes);
  await app.register(reportRoutes);
  await app.register(overviewRoutes);
  await app.register(financialsRoutes);
  await app.register(deployRoutes);
  await app.register(oauthRoutes);

  return app;
}
