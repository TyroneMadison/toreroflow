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
  /**
   * YouTube Data API v3 key. Only needed to read a channel's lifetime
   * catalogue, which the publishing provider does not expose; empty means
   * all-time YouTube rankings stay unavailable rather than failing.
   */
  YOUTUBE_API_KEY: string;
  REDIS_URL: string;
  /** Local disk object storage for dev; swaps to R2/S3 for cloud deploys. */
  STORAGE_DIR: string;
  REPO_ROOT: string;
  /**
   * Netlify personal access token used to publish client report pages.
   * Empty means the publish endpoints answer 503 with guidance rather than
   * failing mid-deploy, and the Reports screen explains why the button is off.
   */
  NETLIFY_AUTH_TOKEN: string;
  /** Site the report pages are published into. Empty disables publishing. */
  NETLIFY_SITE_ID: string;
  /**
   * Public address report links are built from, when it is not the site they
   * are deployed to.
   *
   * Reports are published to their own Netlify site and torerone.com proxies
   * to it, so the address a client is given and the address the files live at
   * are different. Empty falls back to the deploy site's own URL, which is
   * what happens before that proxy exists.
   */
  REPORTS_PUBLIC_BASE: string;
  /** sandbox | production. Decides which Plaid host is called. */
  PLAID_ENV: string;
  /** Empty disables bank oversight; the screen says why. */
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
}

export const env: Env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET,
  API_PORT: Number.parseInt(process.env.API_PORT ?? "", 10) || 4700,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  SUGGESTIONS_MODEL: process.env.SUGGESTIONS_MODEL ?? "claude-opus-4-8",
  PUBLISH_PROVIDER: process.env.PUBLISH_PROVIDER ?? "dryrun",
  PUBLISH_PROVIDER_API_KEY: process.env.PUBLISH_PROVIDER_API_KEY ?? "",
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY ?? "",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  STORAGE_DIR: process.env.STORAGE_DIR ?? path.join(repoRoot, "storage"),
  REPO_ROOT: repoRoot,
  NETLIFY_AUTH_TOKEN: process.env.NETLIFY_AUTH_TOKEN ?? "",
  NETLIFY_SITE_ID: process.env.NETLIFY_SITE_ID ?? "",
  REPORTS_PUBLIC_BASE: (process.env.REPORTS_PUBLIC_BASE ?? "").replace(/\/+$/, ""),
  PLAID_ENV: process.env.PLAID_ENV ?? "sandbox",
  PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID ?? "",
  PLAID_SECRET: process.env.PLAID_SECRET ?? "",
};
