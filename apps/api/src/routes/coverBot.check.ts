// A bot token can set a cover on a video in its own agency, through the real
// auth hook and the real route, and the route's own checks still hold: wrong
// file type is refused, and another agency's video is not there at all.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const storage = await fs.mkdtemp(path.join(os.tmpdir(), "cover-bot-"));
process.env.STORAGE_DIR = storage;
// The asset folder exists once the video is uploaded.
await fs.mkdir(path.join(storage, "client1/asset1"), { recursive: true });

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { default: multipart } = await import("@fastify/multipart");
const { getPrisma } = await import("@toreroflow/db");
const { mediaRoutes } = await import("./media");

// No database: stand in for the two calls the cover upload makes, honoring
// the agency filter the route passes, which is the whole ownership check.
const ASSET = {
  id: "asset1",
  clientId: "client1",
  agencyId: "agencyA",
  storageKey: "client1/asset1/source.mp4",
  status: "ready",
  coverOffsetMs: null,
  coverKey: null,
  updatedAt: new Date(),
};
let updated: Record<string, unknown> | null = null;
Object.defineProperty(getPrisma(), "mediaAsset", {
  value: {
    findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
      where.id === ASSET.id && where.client.agencyId === ASSET.agencyId ? ASSET : null,
    update: async ({ data }: { data: Record<string, unknown> }) => {
      updated = data;
      return { ...ASSET, ...data };
    },
  },
});

const app = Fastify();
await app.register(jwt, { secret: "cover-bot-check" });
await app.register(multipart, { limits: { fileSize: 1024 } });
await app.register(mediaRoutes);

function upload(token: string, mime: string, body: Buffer) {
  const boundary = "----coverbot";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: `/media/${ASSET.id}/cover-image`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}

const bot = app.jwt.sign({ sub: "deploy-script", agencyId: "agencyA", role: "bot" });
const otherBot = app.jwt.sign({ sub: "deploy-script", agencyId: "agencyB", role: "bot" });
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// Bot in the asset's agency: cover saved.
let res = await upload(bot, "image/png", png);
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(updated, { coverOffsetMs: null, coverKey: "client1/asset1/cover.png" });
assert.deepEqual(await fs.readFile(path.join(storage, "client1/asset1/cover.png")), png);

// Same validation as the operator gets.
res = await upload(bot, "image/gif", png);
assert.equal(res.statusCode, 400, "only JPEG or PNG");
res = await upload(bot, "image/jpeg", Buffer.alloc(2048));
assert.equal(res.statusCode, 413, "size cap still applies");

// Bot from another agency: the asset does not exist for it, nothing written.
updated = null;
res = await upload(otherBot, "image/png", png);
assert.equal(res.statusCode, 404, res.body);
assert.equal(updated, null);

// Still bot-closed: resetting the cover stays an operator action.
res = await app.inject({
  method: "DELETE",
  url: `/media/${ASSET.id}/cover`,
  headers: { authorization: `Bearer ${bot}` },
});
assert.equal(res.statusCode, 403);

await app.close();
await fs.rm(storage, { recursive: true, force: true });
console.log("coverBot.check: all checks passed");
