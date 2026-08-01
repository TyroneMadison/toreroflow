import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { DEFAULT_RETENTION_DAYS, DEFAULT_THUMB_RETENTION_DAYS } from "@toreroflow/core";

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
  /** Competitor research gateway. Empty disables the research queue. */
  MONID_API_KEY: process.env.MONID_API_KEY ?? "",
  /** Empty means lifetime YouTube refresh is skipped, not failed. */
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY ?? "",
  /**
   * Days a posted video keeps its source file before the sweep clears it.
   *
   * A number, not a switch: 0 would mean deleting the moment a post goes
   * live, which is the one setting nobody wants, so anything under 1 is
   * treated as the default rather than obeyed.
   */
  RETENTION_DAYS: Math.max(1, Number(process.env.RETENTION_DAYS) || DEFAULT_RETENTION_DAYS),
  // Longer than the source window and floored well above it, because the
  // images are what every card draws and they cannot be rebuilt once the
  // source they came from has gone.
  THUMB_RETENTION_DAYS: Math.max(
    7,
    Number(process.env.THUMB_RETENTION_DAYS) || DEFAULT_THUMB_RETENTION_DAYS,
  ),
  /**
   * The timezone whose calendar day a bank transaction is filed under.
   *
   * Defaults to this machine's, which is right while the worker runs on the
   * operator's own computer and wrong the moment it moves to a server sitting
   * in UTC. That is exactly the kind of thing nobody notices until a payment
   * lands in the wrong month, so it is a setting rather than a constant.
   */
  BUSINESS_TIMEZONE:
    process.env.BUSINESS_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
};
