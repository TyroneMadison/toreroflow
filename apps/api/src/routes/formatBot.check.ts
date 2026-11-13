// Short-form / long-form through the real auth hook and the real routes, as a
// bot: PATCH takes "short" | "long" (and the stored spellings), and upload
// takes ?format= so a bot can file a video as long-form from the start.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const storage = await fs.mkdtemp(path.join(os.tmpdir(), "format-bot-"));
process.env.STORAGE_DIR = storage;

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: multipart } = await import("@fastify/multipart");
const { getPrisma } = await import("@toreroflow/db");
const { mediaRoutes } = await import("./media");

const ASSET = { id: "asset1", clientId: "client1", agencyId: "agencyA", storageKey: "k", status: "ready", format: "short_form", updatedAt: new Date() };
let updated: Record<string, unknown> | null = null;
let created: Record<string, unknown> | null = null;
Object.defineProperty(getPrisma(), "client", {
  value: { findFirst: async ({ where }: { where: { agencyId: string } }) => (where.agencyId === "agencyA" ? { id: "client1" } : null) },
});
Object.defineProperty(getPrisma(), "mediaAsset", {
  value: {
    findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
      where.id === ASSET.id && where.client.agencyId === ASSET.agencyId ? ASSET : null,
    findMany: async () => [],
    create: async ({ data }: { data: Record<string, unknown> }) => {
      created = data;
      return { ...ASSET, id: "asset2", ...data };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      // The upload's storage-key write ends the test before it reaches the queue.
      if (where.id === "asset2") throw new Error("stop before enqueue");
      updated = data;
      return { ...ASSET, ...data };
    },
  },
});

const app = Fastify();
await app.register(jwt, { secret: "format-bot-check" });
await app.register(multipart, { limits: { fileSize: 1024 } });
await app.register(mediaRoutes);

const polly = app.jwt.sign({ sub: "polly", agencyId: "agencyA", role: "bot", bot: "polly" });
const bot = app.jwt.sign({ sub: "deploy-script", agencyId: "agencyA", role: "bot" });
const patch = (token: string, format: unknown) =>
  app.inject({
    method: "PATCH",
    url: `/media/${ASSET.id}/format`,
    headers: { authorization: `Bearer ${token}` },
    payload: { format },
  });

for (const [token, sent, stored] of [
  [polly, "long", "long_form"],
  [polly, "short", "short_form"],
  [bot, "long_form", "long_form"],
  [bot, "short", "short_form"],
] as const) {
  updated = null;
  const res = await patch(token, sent);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(updated, { format: stored }, `${sent} is stored as ${stored}`);
  assert.equal(res.json().format, stored);
}
updated = null;
assert.equal((await patch(polly, "carousel")).statusCode >= 400, true, "not a video format");
assert.equal((await patch(polly, "medium")).statusCode >= 400, true);
assert.equal(updated, null, "nothing written on a bad value");

function upload(query: string) {
  const boundary = "----fmtbot";
  return app.inject({
    method: "POST",
    url: `/clients/client1/media${query}`,
    headers: { authorization: `Bearer ${polly}`, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n`),
      Buffer.from("not really a video"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

let res = await upload("?format=sideways");
assert.equal(res.statusCode, 400, res.body);
assert.equal(created, null, "a bad format creates nothing");

await upload("?format=long");
assert.equal(created!.format, "long_form", "?format=long files it as long-form");
created = null;
await upload("");
assert.equal("format" in created!, false, "no format: the worker picks the default");

await app.close();
await fs.rm(storage, { recursive: true, force: true });
console.log("formatBot.check: all checks passed");
