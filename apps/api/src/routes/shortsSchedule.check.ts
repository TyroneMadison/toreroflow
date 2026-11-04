// YouTube Shorts cannot be scheduled past 3:00. The length is the file's when
// ffprobe can read it, and the stored measurement otherwise. Long-form YouTube
// and every other platform are unchanged. No database, no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const storage = await fs.mkdtemp(path.join(os.tmpdir(), "shorts-limit-"));
process.env.STORAGE_DIR = storage;
process.env.PUBLISH_PROVIDER = "zernio";
process.env.PUBLISH_PROVIDER_API_KEY = "test-key";
globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

function clip(name: string, seconds: number): string {
  const file = path.join(storage, name);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=64x64:r=1:d=${seconds}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-t",
      String(seconds),
      file,
    ],
    { stdio: "ignore" },
  );
  return file;
}

clip("short.mp4", 2);
clip("over.mp4", 181);

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { postRoutes } = await import("./posts");

const accounts = [
  { id: "yt1", platform: "youtube", status: "connected", handle: "dud", providerAccountId: "z-yt", tokensEncrypted: "provider:zernio" },
  { id: "ig1", platform: "instagram", status: "connected", handle: "dud", providerAccountId: "z-ig", tokensEncrypted: "provider:zernio" },
  { id: "tt1", platform: "tiktok", status: "connected", handle: "dud", providerAccountId: "z-tt", tokensEncrypted: "provider:zernio" },
];

function video(id: string, extra: Record<string, unknown>) {
  return {
    id,
    clientId: "client1",
    kind: "video",
    status: "ready",
    storageKey: `${id}.mp4`,
    sourceDeletedAt: null,
    durationSec: 30,
    format: "short_form",
    draftCopy: { name: "Weekend lap", description: "Weekend lap." },
    client: { id: "client1", name: "Dud Rents", socialAccounts: accounts },
    ...extra,
  };
}

const assets: Record<string, Record<string, unknown>> = {
  // Stored metadata says 30s. The file is 181s. The file wins.
  probed: video("probed", { storageKey: "over.mp4", durationSec: 30 }),
  // Stored metadata says 999s. The file is 2s. The file wins, so Shorts is allowed.
  stale: video("stale", { storageKey: "short.mp4", durationSec: 999 }),
  // No file. Stored 181s is the measurement.
  stored: video("stored", { storageKey: "missing.mp4", durationSec: 181 }),
  exact: video("exact", { storageKey: "missing.mp4", durationSec: 180 }),
  fraction: video("fraction", { storageKey: "missing.mp4", durationSec: 180.1 }),
  longform: video("longform", { storageKey: "missing.mp4", durationSec: 900, format: "long_form" }),
  reel: video("reel", { storageKey: "missing.mp4", durationSec: 400, format: "short_form" }),
};

type Created = { data: { targets: { create: Array<Record<string, unknown>> } } };
let created: Created | null = null;
const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("mediaAsset", {
  findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
    where.client.agencyId === "agencyA" && assets[where.id] ? { ...assets[where.id] } : null,
});
stub("user", { findFirst: async () => ({ id: "owner1" }) });
stub("contentIdea", { findFirst: async () => null });
stub("post", {
  create: async (args: Created) => {
    created = args;
    throw new Error("stop-before-enqueue");
  },
});

const app = Fastify();
await app.register(jwt, { secret: "shorts-limit-check" });
await app.register(postRoutes);
const token = app.jwt.sign({ sub: "owner1", agencyId: "agencyA" });
const later = new Date(Date.now() + 3 * 3600_000).toISOString();
const schedule = (id: string, body: object) =>
  app.inject({
    method: "POST",
    url: `/media/${id}/schedule`,
    headers: { authorization: `Bearer ${token}` },
    payload: { scheduledAt: later, ...body },
  });

let res = await schedule("probed", { platforms: ["youtube"], accountIds: ["yt1"] });
assert.equal(res.statusCode, 400);
assert.equal(res.json().error, "Over 3:00, Shorts limit");
assert.match(res.json().detail, /181 seconds \(3:01\)/);
assert.equal(created, null, "an over-length Short is not queued");

res = await schedule("probed", { platforms: ["youtube", "instagram"], accountIds: ["yt1", "ig1"] });
assert.equal(res.statusCode, 400, "YouTube in the request refuses the schedule");
assert.equal(created, null, "Instagram is not queued beside a Short that cannot post");

res = await schedule("stored", { platforms: ["youtube"], accountIds: ["yt1"] });
assert.equal(res.statusCode, 400);
assert.equal(res.json().error, "Over 3:00, Shorts limit");

res = await schedule("fraction", { platforms: ["youtube"], accountIds: ["yt1"] });
assert.equal(res.statusCode, 400, "180.1 seconds is over 180.0");
assert.match(res.json().detail, /180\.1 seconds/);

created = null;
res = await schedule("exact", { platforms: ["youtube"], accountIds: ["yt1"] });
assert.ok(created, res.body);
assert.equal((created as Created).data.targets.create[0]!.platform, "youtube", "3:00 exactly still schedules");

created = null;
res = await schedule("stale", { platforms: ["youtube"], accountIds: ["yt1"] });
assert.ok(created, `probe of a 2s file must beat stored 999s: ${res.body}`);

created = null;
res = await schedule("longform", { platforms: ["youtube"], accountIds: ["yt1"] });
assert.ok(created, `long-form YouTube is not a Short: ${res.body}`);

created = null;
res = await schedule("reel", { platforms: ["instagram", "tiktok"], accountIds: ["ig1", "tt1"] });
assert.ok(created, `other platforms ignore the Shorts cap: ${res.body}`);
const platforms = (created as Created).data.targets.create.map((t) => t.platform).sort();
assert.deepEqual(platforms, ["instagram", "tiktok"]);

await app.close();
await fs.rm(storage, { recursive: true, force: true });
console.log("shortsSchedule.check: all checks passed");
