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
  STORAGE_DIR: process.env.STORAGE_DIR ?? path.join(repoRoot, "storage"),
  PUBLISH_PROVIDER: process.env.PUBLISH_PROVIDER ?? "dryrun",
  PUBLISH_PROVIDER_API_KEY: process.env.PUBLISH_PROVIDER_API_KEY ?? "",
};
