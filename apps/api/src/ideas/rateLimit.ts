import type { FastifyRequest } from "fastify";
import { getPrisma } from "@toreroflow/db";
import { env } from "../env";

/**
 * Per-key request limit for the public routes (request form, approval pages),
 * counted in the database so every API process and every restart sees the
 * same numbers. Resolves to the hit's count in its window; allowed when
 * count <= max.
 *
 * ponytail: fixed window, so a burst straddling a boundary can reach 2x max;
 * a sliding window is the upgrade if that ever matters.
 */
export function rateLimiter(scope: string, windowMs: number, max: number) {
  return async (subject: string, now = Date.now()): Promise<{ allowed: boolean; count: number }> => {
    const prisma = getPrisma();
    const start = Math.floor(now / windowMs) * windowMs;
    const key = `${scope}|${subject}|${start}`;
    // Upsert on the id alone is a single INSERT ... ON CONFLICT in Postgres, so
    // two processes counting the same key cannot both see a fresh row.
    const row = await prisma.rateLimitBucket.upsert({
      where: { key },
      create: { key, count: 1, expiresAt: new Date(start + windowMs) },
      update: { count: { increment: 1 } },
      select: { count: true },
    });
    if (Math.random() < 0.01) {
      void prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: new Date(now) } } }).catch(() => undefined);
    }
    return { allowed: row.count <= max, count: row.count };
  };
}

/**
 * The caller's address. In production the API sits behind Caddy, which sets
 * X-Forwarded-For and appends the real peer last, so the last entry is the
 * one a client cannot forge. Off a server there is no proxy and the socket
 * address is the truth.
 */
export function clientIp(request: FastifyRequest): string {
  if (!env.IS_PRODUCTION) return request.ip;
  const xff = request.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last || request.ip;
}
