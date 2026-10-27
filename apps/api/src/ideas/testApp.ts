// Test-only: one route plugin behind the real auth hook, with server.ts's
// "ZodError is a 400" rule, and tokens for the operator, Polly and another bot.
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import jwt from "@fastify/jwt";
import { ZodError } from "zod";

export async function testApp(routes: FastifyPluginAsync) {
  const app: FastifyInstance = Fastify();
  await app.register(jwt, { secret: "ideas-check" });
  app.setErrorHandler((error, _req, reply) =>
    error instanceof ZodError
      ? reply.status(400).send({ error: "validation failed" })
      : reply.status((error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message }),
  );
  await app.register(routes);
  const as = (t: object) => ({ authorization: `Bearer ${app.jwt.sign(t as never)}` });
  return {
    app,
    operator: as({ sub: "u1", agencyId: "A" }),
    polly: as({ sub: "s", agencyId: "A", role: "bot", bot: "polly" }),
    nova: as({ sub: "s", agencyId: "A", role: "bot", bot: "nova" }),
    otherAgency: as({ sub: "u9", agencyId: "B" }),
  };
}
