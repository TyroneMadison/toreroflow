import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";

/**
 * Serves the drawn idea GIFs. Public on purpose so a plain <img> can load
 * them: the key is a content hash nobody can guess, and the bytes never change
 * for a key, so they cache forever.
 */
const prisma = getPrisma();

export default async function ideaGifRoutes(app: FastifyInstance) {
  app.get<{ Params: { key: string } }>("/idea-gifs/:key", async (request, reply) => {
    const key = request.params.key.replace(/\.gif$/, "");
    if (!/^[a-f0-9]{16,64}$/.test(key)) return reply.status(404).send({ error: "not found" });
    const gif = await prisma.ideaGif.findUnique({ where: { key } });
    if (!gif) return reply.status(404).send({ error: "not found" });
    return reply
      .header("Content-Type", "image/gif")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(Buffer.from(gif.bytes));
  });
}