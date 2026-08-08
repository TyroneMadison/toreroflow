import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

let client: PrismaClient | undefined;

/** Lazy singleton so importing the package never eagerly opens connections. */
export function getPrisma(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

export * from "./externalStore";
export * from "./grounding";
export * from "./queue";
export * from "./secrets";
