import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load the repo root .env regardless of cwd. This file lives at
// apps/api/src/env.ts, so the repo root is three levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../../../.env") });

const DEFAULT_JWT_SECRET = "dev-only-change-me";

if (!process.env.JWT_SECRET) {
  console.warn(
    "[api] JWT_SECRET is not set; using the insecure dev default. Set JWT_SECRET in the repo root .env before any real deployment.",
  );
}

export interface Env {
  /** Read by Prisma directly from process.env as well; exposed here for completeness. */
  DATABASE_URL: string;
  JWT_SECRET: string;
  API_PORT: number;
}

export const env: Env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET,
  API_PORT: Number.parseInt(process.env.API_PORT ?? "", 10) || 4700,
};
