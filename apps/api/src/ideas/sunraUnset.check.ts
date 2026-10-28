// The real server with no SUNRA_API_KEY: it boots, the carousel card still loads
// models and settings (connected: false), and building answers a plain 503 in words.
// Prisma is mocked and fetch throws, so nothing leaves the process.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const storage = mkdtempSync(path.join(os.tmpdir(), "sunra-unset-"));
process.env.STORAGE_DIR = storage;
delete process.env.SUNRA_API_KEY;
delete process.env.SUNRA_API_BASE;
globalThis.fetch = (async () => {
  throw new Error("no network in this check");
}) as typeof fetch;

const { getPrisma } = await import("@toreroflow/db");
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
mock("appSetting", {
  // Spending switched ON, so the only thing standing between a quote and a build is the missing key.
  findUnique: async () => ({ value: { generationEnabled: true } }),
});
mock("sunraQuote", {
  findFirst: async () => ({
    id: "q1",
    status: "quoted",
    model: "nano-banana-2",
    expiresAt: new Date(Date.now() + 60_000),
  }),
  updateMany: async () => assert.fail("a quote must not be claimed when Sunra is not connected"),
});

const { buildServer } = await import("../server");
const app = await buildServer({ logger: false });
const auth = { authorization: `Bearer ${app.jwt.sign({ sub: "u1", agencyId: "A" } as never)}` };

let res = await app.inject({ method: "GET", url: "/sunra/settings", headers: auth });
assert.equal(res.statusCode, 200);
assert.deepEqual(res.json(), { generationEnabled: true, connected: false });

res = await app.inject({ method: "GET", url: "/carousels/sunra/models", headers: auth });
assert.equal(res.statusCode, 200, "the fallback model list, not a Sunra call");
assert.ok(res.json().models.length > 0);

res = await app.inject({
  method: "POST",
  url: "/sunra/carousel/q1/generate",
  headers: auth,
  payload: { approved: true, modelId: "nano-banana-2" },
});
assert.equal(res.statusCode, 503);
assert.equal(res.json().error, "Sunra generation is not connected on this server");

await app.close();
rmSync(storage, { recursive: true, force: true });
console.log("sunraUnset.check: ok");
