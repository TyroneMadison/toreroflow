import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load the repo root .env regardless of cwd. This file lives at
// apps/api/src/env.ts, so the repo root is three levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });

const DEFAULT_JWT_SECRET = "dev-only-change-me";

/**
 * Whether this process is answering to the internet.
 *
 * NODE_ENV rather than a flag of our own, because that is what the container
 * sets and what every other tool in the stack already reads.
 */
const isProduction = process.env.NODE_ENV === "production";

/*
 * Secrets that are fine to fudge on a laptop and must never be fudged on a
 * server.
 *
 * A warning was enough while the API only ever listened on 127.0.0.1. It is
 * not enough now: the dev JWT secret is a published string in this repository,
 * so a deploy that kept it would let anyone mint a token for the workspace,
 * and the same secret signs the file links. Refusing to start is the only
 * failure mode that cannot be scrolled past.
 */
function requireInProduction(name: string, value: string, why: string): void {
  if (!isProduction || value) return;
  throw new Error(`[api] ${name} must be set in production. ${why}`);
}

if (isProduction && (process.env.JWT_SECRET ?? "") === DEFAULT_JWT_SECRET) {
  throw new Error(
    "[api] JWT_SECRET is still the dev default, which is a published string in this repository. Generate one with: openssl rand -base64 48",
  );
}
requireInProduction(
  "JWT_SECRET",
  process.env.JWT_SECRET ?? "",
  "It signs operator sessions and every file link. Generate one with: openssl rand -base64 48",
);
requireInProduction(
  "TOKEN_ENCRYPTION_KEY",
  process.env.TOKEN_ENCRYPTION_KEY ?? "",
  "It encrypts the bank credential at rest. Generate one with: openssl rand -base64 32",
);
requireInProduction(
  "ALLOWED_ORIGINS",
  process.env.ALLOWED_ORIGINS ?? "",
  "Without it the API would accept cross-site requests from anywhere.",
);

if (!isProduction && !process.env.JWT_SECRET) {
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
  /**
   * Google OAuth client, for the YouTube Analytics API.
   *
   * A different product from YOUTUBE_API_KEY above and not a replacement for
   * it: the key reads public catalogue data, this reads what only the channel
   * owner can see (shares, watch time, subscribers gained). Empty means the
   * connect endpoints answer 503 with guidance rather than producing a link
   * that fails on Google's side.
   */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /**
   * The public origin OAuth redirects come back to, e.g.
   * https://api.torerone.com. Must match what is registered in each platform's
   * console character for character.
   *
   * Deliberately its own variable rather than reusing PUBLIC_API_URL, which is
   * the Tailscale Funnel address the desktop app talks to. The two are
   * different hosts for the same server, and the platforms only know about this
   * one. No default: a fallback to the production domain would mean a laptop
   * test binding a real client's credential on the live server.
   */
  OAUTH_REDIRECT_BASE: string;
  /** Local disk object storage for dev; swaps to R2/S3 for cloud deploys. */
  STORAGE_DIR: string;
  /**
   * The transcription service. The API calls it from the caption button, which
   * is where an uploaded video gets its words; the worker calls it for the
   * analyzer, the editor and knowledge files, which cannot do their job
   * without them.
   */
  CAPTIONS_URL: string;
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
  /**
   * Origins allowed to make cross-site requests, comma separated.
   *
   * Empty means "reflect whatever asked", which is only tolerable on a laptop.
   * In production this is required, checked above.
   */
  ALLOWED_ORIGINS: string[];
  /** True when this process is answering to the internet. */
  IS_PRODUCTION: boolean;
  /** The commit this server is running, for the deploy card. Empty off a server. */
  GIT_COMMIT: string;
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
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",
  OAUTH_REDIRECT_BASE: (process.env.OAUTH_REDIRECT_BASE ?? "").replace(/\/+$/, ""),
  STORAGE_DIR: process.env.STORAGE_DIR ?? path.join(repoRoot, "storage"),
  CAPTIONS_URL: process.env.CAPTIONS_URL ?? "http://localhost:4710",
  REPO_ROOT: repoRoot,
  NETLIFY_AUTH_TOKEN: process.env.NETLIFY_AUTH_TOKEN ?? "",
  NETLIFY_SITE_ID: process.env.NETLIFY_SITE_ID ?? "",
  REPORTS_PUBLIC_BASE: (process.env.REPORTS_PUBLIC_BASE ?? "").replace(/\/+$/, ""),
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  IS_PRODUCTION: isProduction,
  GIT_COMMIT: process.env.GIT_COMMIT ?? "",
};
