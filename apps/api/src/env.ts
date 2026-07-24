import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load the repo root .env regardless of cwd. This file lives at
// apps/api/src/env.ts, so the repo root is three levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });

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
  /** Empty string means the AI suggestions endpoint returns 503 with guidance. */
  ANTHROPIC_API_KEY: string;
  SUGGESTIONS_MODEL: string;
  /** dryrun until a real provider (Ayrshare/Blotato/Zernio/Postiz) is chosen in M1. */
  PUBLISH_PROVIDER: string;
  PUBLISH_PROVIDER_API_KEY: string;
  REDIS_URL: string;
  /** Local disk object storage for dev; swaps to R2/S3 for cloud deploys. */
  STORAGE_DIR: string;
}

export const env: Env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET,
  API_PORT: Number.parseInt(process.env.API_PORT ?? "", 10) || 4700,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  SUGGESTIONS_MODEL: process.env.SUGGESTIONS_MODEL ?? "claude-opus-4-8",
  PUBLISH_PROVIDER: process.env.PUBLISH_PROVIDER ?? "dryrun",
  PUBLISH_PROVIDER_API_KEY: process.env.PUBLISH_PROVIDER_API_KEY ?? "",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  STORAGE_DIR: process.env.STORAGE_DIR ?? path.join(repoRoot, "storage"),
};
