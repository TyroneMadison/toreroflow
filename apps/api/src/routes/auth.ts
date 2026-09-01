import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  loginSchema,
  registerSchema,
  type AuthUser,
  type LoginResponse,
} from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";
import { requireAuth } from "../plugins/requireAuth";

/** Uniform body for wrong email OR wrong password - never reveal which. */
const INVALID_CREDENTIALS = { error: "invalid credentials" } as const;
const UNAUTHORIZED = { error: "unauthorized" } as const;

const BCRYPT_COST = 12;
/** Desktop app device-style session: long-lived token, revisit in M6. */
const TOKEN_TTL = "30d";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  /** First-run detection for the desktop app: register vs login screen. */
  app.get("/auth/bootstrap", async () => {
    const users = await prisma.user.count();
    return { needsSetup: users === 0 };
  });

  /**
   * Mint a bot token: a year-long credential that can upload, write copy and
   * schedule, and nothing else (auth/botAccess.ts is the whole list).
   *
   * Operator-only, and the guard itself refuses bots calling it, so a bot
   * cannot mint its own successors. A year rather than 30 days because a bot
   * cannot answer a login screen; rotating it is: call this again, update the
   * bot, and the old token dies at its own expiry.
   */
  app.post(
    "/auth/bot-token",
    { onRequest: requireAuth },
    async (request, reply) => {
      if (request.user.role === "bot") {
        return reply.status(403).send({ error: "a bot cannot mint tokens" });
      }
      const token = app.jwt.sign(
        { sub: request.user.sub, agencyId: request.user.agencyId, role: "bot" },
        { expiresIn: "365d" },
      );
      return { token, role: "bot", expiresInDays: 365 };
    },
  );

  const signToken = (user: { id: string; agencyId: string }): string =>
    app.jwt.sign({ sub: user.id, agencyId: user.agencyId }, { expiresIn: TOKEN_TTL });

  app.post("/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);

    // M0 rule (spec Section 12 M0 "operator auth"; assumption per Section 0
    // rule 6): registration is only allowed while the User table is empty -
    // this is first-run operator setup for the solo agency operator. Any
    // later registration attempt returns 409. Additional users (e.g. client
    // viewers) arrive via invites in a later milestone, not open signup.
    const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);

    const created = await prisma.$transaction(async (tx) => {
      const existingUsers = await tx.user.count();
      if (existingUsers > 0) return null;

      const agency = await tx.agency.create({
        data: { name: body.agencyName, ownerEmail: body.email },
      });
      const user = await tx.user.create({
        data: {
          agencyId: agency.id,
          email: body.email,
          passwordHash,
          role: "owner",
        },
      });
      return { agency, user };
    });

    if (!created) {
      return reply.status(409).send({ error: "operator already exists" });
    }

    const response: LoginResponse = {
      token: signToken(created.user),
      user: {
        id: created.user.id,
        email: created.user.email,
        role: created.user.role,
        agencyId: created.agency.id,
        agencyName: created.agency.name,
      },
    };
    return reply.status(201).send(response);
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
      include: { agency: true },
    });
    if (!user) {
      return reply.status(401).send(INVALID_CREDENTIALS);
    }

    const passwordOk = await bcrypt.compare(body.password, user.passwordHash);
    if (!passwordOk) {
      return reply.status(401).send(INVALID_CREDENTIALS);
    }

    const response: LoginResponse = {
      token: signToken(user),
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        agencyId: user.agencyId,
        agencyName: user.agency.name,
      },
    };
    return response;
  });

  app.get("/auth/me", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send(UNAUTHORIZED);
    }

    const user = await prisma.user.findUnique({
      where: { id: request.user.sub },
      include: { agency: true },
    });
    if (!user) {
      return reply.status(401).send(UNAUTHORIZED);
    }

    const me: AuthUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      agencyId: user.agencyId,
      agencyName: user.agency.name,
    };
    return me;
  });
}
