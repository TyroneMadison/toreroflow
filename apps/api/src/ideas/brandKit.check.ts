// Brand kit: fonts checked against the static Google Fonts list (no key, no
// network), colors normalized, logo uploaded into storage as a library asset,
// another brand's logo refused, Polly in and other bots out.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const storage = mkdtempSync(path.join(os.tmpdir(), "brandkit-"));
process.env.STORAGE_DIR = storage;
delete process.env.BOT_FULL_ACCESS;
const { getPrisma } = await import("@toreroflow/db");
const { BrandKitSchema } = await import("@toreroflow/contracts");
const { findFont, fontProblem, GOOGLE_FONTS } = await import("./googleFonts");
const { brandKitRoutes, LOGO_MAX_BYTES } = await import("../routes/brandKit");
const { testApp } = await import("./testApp");

// ---- the font list ----
assert.equal(new Set(GOOGLE_FONTS.map((x) => x.family)).size, GOOGLE_FONTS.length, "no duplicate families");
assert.ok(GOOGLE_FONTS.every((x) => x.weights.length && x.weights.every((w) => w % 100 === 0 && w >= 100 && w <= 900)));
assert.deepEqual(findFont(" bebas neue ")?.weights, [400]);
assert.equal(fontProblem([{ family: "Inter", weights: [400, 800] }]), null);
assert.equal(fontProblem([{ family: "Comic Sans MS", weights: [400] }]), '"Comic Sans MS" is not in the Google Fonts list');
assert.equal(fontProblem([{ family: "Bebas Neue", weights: [700] }]), "Bebas Neue has no 700 weight (has 400)");

// ---- in-memory database ----
const kits = new Map<string, Record<string, unknown>>();
const assets: Record<string, unknown>[] = [];
const clients = [
  { id: "caleb", agencyId: "A", deletedAt: null },
  { id: "dud", agencyId: "A", deletedAt: null },
];
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
mock("client", {
  findFirst: async ({ where }: { where: { id: string; agencyId: string } }) =>
    clients.find((c) => c.id === where.id && c.agencyId === where.agencyId) ?? null,
});
mock("brandKit", {
  findUnique: async ({ where }: { where: { clientId: string } }) => kits.get(where.clientId) ?? null,
  upsert: async ({ where, create, update }: { where: { clientId: string }; create: object; update: object }) =>
    void kits.set(where.clientId, { ...(kits.get(where.clientId) ?? create), ...update }),
});
mock("libraryAsset", {
  create: async ({ data }: { data: Record<string, unknown> }) => {
    const a = { id: `asset${assets.length + 1}`, ...data };
    assets.push(a);
    return a;
  },
  update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(assets.find((a) => a.id === where.id)!, data),
  delete: async ({ where }: { where: { id: string } }) => void assets.splice(assets.findIndex((a) => a.id === where.id), 1),
  findUnique: async ({ where }: { where: { id: string } }) => assets.find((a) => a.id === where.id) ?? null,
  findFirst: async ({ where }: { where: { id: string; type: string; OR: { clientId: string | null }[] } }) =>
    assets.find((a) => a.id === where.id && a.type === where.type && where.OR.some((o) => o.clientId === a.clientId)) ?? null,
});

const { app, upload, operator, polly, nova, otherAgency } = await testApp(brandKitRoutes);

let res = await app.inject({ method: "GET", url: "/brand-kit/fonts", headers: nova });
assert.equal(res.statusCode, 403, "other bots are closed out");
res = await app.inject({ method: "GET", url: "/brand-kit/fonts", headers: operator });
assert.equal(res.json().fonts.length, GOOGLE_FONTS.length);

// Empty kit until set.
res = await app.inject({ method: "GET", url: "/brands/caleb/kit", headers: operator });
assert.equal(res.statusCode, 200);
assert.deepEqual(res.json(), { brandId: "caleb", fonts: [], colors: [], logoAssetId: null, voiceNotes: "", logoUrl: null });
res = await app.inject({ method: "GET", url: "/brands/caleb/kit", headers: otherAgency });
assert.equal(res.statusCode, 404);

// Save: family case fixed, weights deduped and sorted, colors upper-cased.
const kit = { brandId: "caleb", fonts: [{ family: "bebas neue", weights: [400] }, { family: "Inter", weights: [700, 400, 700] }], colors: ["#ff5a36", "#FF5A36", "#0b0b0f"], logoAssetId: null, voiceNotes: "Short, confident, no emojis." };
res = await app.inject({ method: "PUT", url: "/brands/caleb/kit", headers: polly, payload: kit });
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json().fonts, [{ family: "Bebas Neue", weights: [400] }, { family: "Inter", weights: [400, 700] }]);
assert.deepEqual(res.json().colors, ["#FF5A36", "#0B0B0F"]);
BrandKitSchema.parse(res.json());

for (const [payload, why] of [
  [{ ...kit, fonts: [{ family: "Papyrus", weights: [400] }] }, "unknown family"],
  [{ ...kit, colors: ["red"] }, "not a hex color"],
  [{ ...kit, brandId: "dud" }, "brandId does not match the path"],
  [{ ...kit, logoAssetId: "nope" }, "unknown logo"],
] as const) {
  res = await app.inject({ method: "PUT", url: "/brands/caleb/kit", headers: operator, payload });
  assert.equal(res.statusCode, 400, why);
}

// Logo upload: stored under the brand, registered as a logo asset, set on the kit.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let up = upload("Caleb Logo.png", "image/png", png);
res = await app.inject({ method: "POST", url: "/brands/caleb/kit/logo", headers: { ...operator, ...up.headers }, payload: up.payload });
assert.equal(res.statusCode, 200, res.body);
const logo = assets[0]!;
assert.equal(logo.type, "logo");
assert.equal(logo.clientId, "caleb");
assert.equal(logo.storageKey, "caleb/brand-kit/logo-asset1.png");
assert.equal(logo.sizeBytes, png.length);
assert.deepEqual(readFileSync(path.join(storage, "caleb/brand-kit/logo-asset1.png")), png);
assert.equal(res.json().logoAssetId, "asset1");
assert.match(res.json().logoUrl, /^\/files\/caleb\/brand-kit\/logo-asset1\.png\?e=\d+&s=/);
assert.equal(res.json().voiceNotes, "Short, confident, no emojis.", "the rest of the kit is kept");

up = upload("logo.svg", "image/svg+xml", Buffer.from("<svg/>"));
res = await app.inject({ method: "POST", url: "/brands/caleb/kit/logo", headers: { ...operator, ...up.headers }, payload: up.payload });
assert.equal(res.statusCode, 400, "SVG can carry script; not accepted");
up = upload("big.png", "image/png", Buffer.alloc(LOGO_MAX_BYTES + 1));
res = await app.inject({ method: "POST", url: "/brands/caleb/kit/logo", headers: { ...operator, ...up.headers }, payload: up.payload });
assert.equal(res.statusCode, 413);
assert.equal(assets.length, 1, "a refused upload leaves no asset behind");

// Caleb's logo cannot be put on Dudley's kit.
res = await app.inject({ method: "PUT", url: "/brands/dud/kit", headers: operator, payload: { ...kit, brandId: "dud", logoAssetId: "asset1" } });
assert.equal(res.statusCode, 400);

await app.close();
rmSync(storage, { recursive: true, force: true });
console.log("brandKit.check: ok");
