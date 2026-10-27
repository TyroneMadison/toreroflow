// Test-only: one route plugin behind the real auth hook, with server.ts's
// "ZodError is a 400" rule, and tokens for the operator, Polly and another bot.
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";

export async function testApp(routes: FastifyPluginAsync) {
  const app: FastifyInstance = Fastify();
  await app.register(jwt, { secret: "ideas-check" });
  await app.register(multipart);
  app.setErrorHandler((error, _req, reply) =>
    error instanceof ZodError
      ? reply.status(400).send({ error: "validation failed" })
      : reply.status((error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message }),
  );
  await app.register(routes);
  const as = (t: object) => ({ authorization: `Bearer ${app.jwt.sign(t as never)}` });
  /** A one-file multipart body for app.inject. */
  const upload = (filename: string, contentType: string, data: Buffer, fields: Record<string, string> = {}) => {
    const b = "----check" + Math.random().toString(16).slice(2);
    const parts = Object.entries(fields).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    const head = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
    return {
      payload: Buffer.concat([Buffer.from(parts.join("") + head), data, Buffer.from(`\r\n--${b}--\r\n`)]),
      headers: { "content-type": `multipart/form-data; boundary=${b}` },
    };
  };
  return {
    app,
    upload,
    operator: as({ sub: "u1", agencyId: "A" }),
    polly: as({ sub: "s", agencyId: "A", role: "bot", bot: "polly" }),
    nova: as({ sub: "s", agencyId: "A", role: "bot", bot: "nova" }),
    otherAgency: as({ sub: "u9", agencyId: "B" }),
  };
}
