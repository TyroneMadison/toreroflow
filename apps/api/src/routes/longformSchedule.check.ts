// Long-form Instagram through the real auth hook and the real routes, as a
// bot: the fit check (with Zernio's publishing limit mocked), the 15 minute
// refusal, and a "Both" schedule over 300MB that is let through and marks
// both targets for one combined provider post. No database, no network.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const storage = await fs.mkdtemp(path.join(os.tmpdir(), "longform-"));
process.env.STORAGE_DIR = storage;
process.env.PUBLISH_PROVIDER = "zernio";
process.env.PUBLISH_PROVIDER_API_KEY = "test-key";
await fs.mkdir(path.join(storage, "client1/asset1"), { recursive: true });
// 400MB, sparse: over the provider's 300MB Instagram cap without writing it.
const fh = await fs.open(path.join(storage, "client1/asset1/source.mp4"), "w");
await fh.truncate(400 * 1024 * 1024);
await fh.close();

const zernioCalls: string[] = [];
globalThis.fetch = (async (url: string) => {
  zernioCalls.push(String(url));
  return new Response(JSON.stringify({ quotaUsage: 97, quotaTotal: 100, quotaDurationSeconds: 86400 }), {
    status: 200,
  });
}) as typeof fetch;

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { postRoutes } = await import("./posts");

const ASSET = {
  id: "asset1",
  clientId: "client1",
  kind: "video",
  status: "ready",
  storageKey: "client1/asset1/source.mp4",
  sourceDeletedAt: null,
  durationSec: 842,
  width: 3840,
  height: 2160,
  format: "long_form",
  draftCopy: { name: "Track day in the M3" },
  client: {
    id: "client1",
    name: "Dud Rents",
    socialAccounts: [
      { id: "yt1", platform: "youtube", status: "connected", handle: "dud", providerAccountId: "z-yt", tokensEncrypted: "provider:zernio" },
      { id: "ig1", platform: "instagram", status: "connected", handle: "dud", providerAccountId: "z-ig", tokensEncrypted: "provider:zernio" },
    ],
  },
};
type Created = { data: { targets: { create: Array<Record<string, any>> } } };
let created = null as Created | null;
const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("mediaAsset", {
  findFirst: async ({ where }: { where: { client: { agencyId: string } } }) =>
    where.client.agencyId === "agencyA" ? { ...ASSET } : null,
});
stub("user", { findFirst: async () => ({ id: "owner1" }) });
stub("contentIdea", { findFirst: async () => null });
stub("post", {
  create: async (args: Created) => {
    created = args;
    // Stop before the job queue, which needs Postgres.
    throw new Error("stop-before-enqueue");
  },
});

const app = Fastify();
await app.register(jwt, { secret: "longform-check" });
await app.register(postRoutes);
const bot = app.jwt.sign({ sub: "deploy-script", agencyId: "agencyA", role: "bot" });
const auth = { authorization: `Bearer ${bot}` };

// Fit: a 4K 400MB master needs an Instagram copy; the allowance comes from Zernio.
let res = await app.inject({ method: "GET", url: "/media/asset1/instagram-fit?accountId=ig1", headers: auth });
assert.equal(res.statusCode, 200, res.body);
const fit = res.json();
assert.equal(fit.bytes, 400 * 1024 * 1024);
assert.equal(fit.needsCopy, true);
assert.deepEqual(fit.blocks, []);
assert.match(fit.warnings[0], /Instagram needs a smaller file/);
assert.deepEqual(fit.limit, { used: 97, total: 100, windowSeconds: 86400 });
assert.match(zernioCalls[0]!, /\/accounts\/z-ig\/instagram\/publishing-limit$/);

const later = new Date(Date.now() + 3 * 3600_000).toISOString();
const schedule = (body: object) =>
  app.inject({ method: "POST", url: "/media/asset1/schedule", headers: auth, payload: body });

// Short-form Instagram still refuses the oversize file, exactly as before.
res = await schedule({ platforms: ["instagram"], accountIds: ["ig1"], scheduledAt: later });
assert.equal(res.statusCode, 400);
assert.match(res.json().error, /300MB/);

// Over 15 minutes: refused for long-form Instagram, with the reason.
ASSET.durationSec = 16 * 60;
res = await schedule({ platforms: ["instagram"], accountIds: ["ig1"], scheduledAt: later, instagram: { longform: true } });
assert.equal(res.statusCode, 400);
assert.match(res.json().detail, /15 minutes/);
assert.equal(created, null);
ASSET.durationSec = 842;

// Both: past the size check, one combined post, Instagram options intact.
res = await schedule({
  platforms: ["youtube", "instagram"],
  accountIds: ["yt1", "ig1"],
  scheduledAt: later,
  caption: "Track day #m3",
  youtube: { title: "Track day in the M3", visibility: "public" },
  instagram: { longform: true, crop916: true, collaborators: ["@dudthecarguy"], locationId: "105890561436614", shareToFeed: true },
});
assert.ok(created, res.body);
const targets = (created as Created | null)!.data.targets.create;
const yt = targets.find((t) => t.platform === "youtube")!;
const ig = targets.find((t) => t.platform === "instagram")!;
assert.equal(yt.options.combined, true);
assert.equal(ig.options.combined, true);
assert.deepEqual(ig.options.instagram.collaborators, ["dudthecarguy"]);
assert.equal(ig.options.instagram.crop916, true);
assert.equal(ig.caption.startsWith("Track day #m3"), true);
assert.equal(targets.length, 2, "long-form never adds a story target");

// A bad location id is refused by the schema.
res = await schedule({ platforms: ["instagram"], accountIds: ["ig1"], scheduledAt: later, instagram: { longform: true, locationId: "Miami" } });
assert.equal(res.statusCode >= 400, true);

// Another agency's bot sees nothing.
const other = app.jwt.sign({ sub: "deploy-script", agencyId: "agencyB", role: "bot" });
res = await app.inject({ method: "GET", url: "/media/asset1/instagram-fit", headers: { authorization: `Bearer ${other}` } });
assert.equal(res.statusCode, 404);

await app.close();
await fs.rm(storage, { recursive: true, force: true });
console.log("longformSchedule.check: all checks passed");
