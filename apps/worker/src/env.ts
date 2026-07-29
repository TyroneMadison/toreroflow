import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });

export const env = {
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  CAPTIONS_URL: process.env.CAPTIONS_URL ?? "http://localhost:4710",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  COPY_MODEL: process.env.SUGGESTIONS_MODEL ?? "claude-opus-4-8",
  /** Where the insights PDF template lives, alongside the report template. */
  REPO_ROOT: repoRoot,
  STORAGE_DIR: process.env.STORAGE_DIR ?? path.join(repoRoot, "storage"),
  PUBLISH_PROVIDER: process.env.PUBLISH_PROVIDER ?? "dryrun",
  PUBLISH_PROVIDER_API_KEY: process.env.PUBLISH_PROVIDER_API_KEY ?? "",
  /** Bank oversight. Empty disables the bank sync queue. */
  PLAID_ENV: process.env.PLAID_ENV ?? "sandbox",
  PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID ?? "",
  PLAID_SECRET: process.env.PLAID_SECRET ?? "",
  /** Competitor research gateway. Empty disables the research queue. */
  MONID_API_KEY: process.env.MONID_API_KEY ?? "",
  /** Empty means lifetime YouTube refresh is skipped, not failed. */
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY ?? "",
};
