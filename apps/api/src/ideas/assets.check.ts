// Asset library: a brand's assets are visible only inside that brand (plus
// the shared ones), filters by brand, type and sharing, uploads are typed and
// capped per type, delete clears a kit's logo. Polly in, other bots out.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const storage = mkdtempSync(path.join(os.tmpdir(), "assets-"));
process.env.STORAGE_DIR = storage;
delete process.env.BOT_FULL_ACCESS;
const { getPrisma } = await import("@toreroflow/db");
const { AssetListSchema, AssetSchema } = await import("@toreroflow/contracts");
const { assetRoutes, visible, MAX_BYTES } = await import("../routes/assets");
const { testApp } = await import("./testApp");

// ---- the rules ----
const all = { sharing: "all" as const };
const caleb = { clientId: "caleb", type: "logo" };
const shared = { clientId: null, type: "audio" };
assert.equal(visible(caleb, { ...all, brandId: "caleb" }), true);
assert.equal(visible(caleb, { ...all, brandId: "dud" }), false, "another brand never sees it");
assert.equal(visible(shared, { ...all, brandId: "dud" }), true, "shared is seen by every brand");
assert.equal(visible(caleb, all), true, "the agency-wide view sees everything");
assert.equal(visible(caleb, { sharing: "shared" }), false);
assert.equal(visible(shared, { sharing: "brand" }), false);
assert.equal(visible(caleb, { ...all, type: "audio" }), false);

// ---- in-memory database ----
const rows: Record<string, any>[] = [];
const kits = [{ clientId: "caleb", logoAssetId: null as string | null }];
const clients = [{ id: "caleb", agencyId: "A" }, { id: "dud", agencyId: "A" }, { id: "other", agencyId: "B" }];
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
mock("client", {
  findFirst: async ({ where }: { where: { id: string; agencyId: string } }) => clients.find((c) => c.id === where.id && c.agencyId === where.agencyId) ?? null,
});
mock("libraryAsset", {
  create: async ({ data }: { data: object }) => {
    const a = { id: `a${rows.length + 1}`, createdAt: new Date(Date.now() + rows.length), ...data };
    rows.push(a);
    return a;
  },
  update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(rows.find((a) => a.id === where.id)!, data),
  delete: async ({ where }: { where: { id: string } }) => void rows.splice(rows.findIndex((a) => a.id === where.id), 1),
  findMany: async ({ where }: { where: { agencyId: string } }) => rows.filter((a) => a.agencyId === where.agencyId).reverse(),
  findFirst: async ({ where }: { where: { id: string; agencyId: string } }) => rows.find((a) => a.id === where.id && a.agencyId === where.agencyId) ?? null,
});
mock("brandKit", {
  updateMany: async ({ where }: { where: { logoAssetId: string } }) => {
    for (const k of kits) if (k.logoAssetId === where.logoAssetId) k.logoAssetId = null;
    return { count: 1 };
  },
});

const { app, upload, operator, polly, nova, otherAgency } = await testApp(assetRoutes);
const put = (headers: Record<string, string>, name: string, mime: string, data: Buffer, fields: Record<string, string>) => {
  const u = upload(name, mime, data, fields);
  return app.inject({ method: "POST", url: "/assets", headers: { ...headers, ...u.headers }, payload: u.payload });
};
const list = async (qs = "", headers = operator) => {
  const res = await app.inject({ method: "GET", url: `/assets${qs}`, headers });
  assert.equal(res.statusCode, 200, res.body);
  return AssetListSchema.parse(res.json()).assets.map((a) => a.name).sort();
};

// Uploads.
let res = await put(operator, "caleb-logo.png", "image/png", Buffer.from("png"), { type: "logo", brandId: "caleb" });
assert.equal(res.statusCode, 201, res.body);
const logo = AssetSchema.parse(res.json());
assert.equal(logo.brandId, "caleb");
assert.match(logo.url, /^\/files\/caleb\/library\/a1\.png\?e=/);
assert.ok(existsSync(path.join(storage, "caleb/library/a1.png")));
res = await put(polly, "Track day bed.mp3", "audio/mpeg", Buffer.from("mp3"), { type: "audio", name: "Track day bed" });
assert.equal(res.statusCode, 201, res.body);
assert.equal(res.json().brandId, null, "no brand means shared");
assert.ok(existsSync(path.join(storage, "shared-A/library/a2.mp3")));
res = await put(operator, "dud.mp4", "video/mp4", Buffer.from("mp4"), { type: "video", brandId: "dud" });
assert.equal(res.statusCode, 201);

// Refusals.
res = await put(operator, "x.png", "image/png", Buffer.from("x"), { type: "font" });
assert.equal(res.statusCode, 400);
res = await put(operator, "x.svg", "image/svg+xml", Buffer.from("<svg/>"), { type: "logo" });
assert.equal(res.statusCode, 400, "the type decides the file kinds allowed");
res = await put(operator, "x.png", "image/png", Buffer.from("x"), { type: "logo", brandId: "other" });
assert.equal(res.statusCode, 404, "another agency's brand");
res = await put(operator, "big.png", "image/png", Buffer.alloc(MAX_BYTES.logo + 1), { type: "logo", brandId: "caleb" });
assert.equal(res.statusCode, 413, "each type has its own cap");
assert.equal(rows.length, 3, "refused uploads leave nothing behind");
res = await put(nova, "x.png", "image/png", Buffer.from("x"), { type: "image" });
assert.equal(res.statusCode, 403);

// Visibility and filters.
assert.deepEqual(await list(), ["Track day bed", "caleb-logo.png", "dud.mp4"]);
assert.deepEqual(await list("?brandId=caleb"), ["Track day bed", "caleb-logo.png"]);
assert.deepEqual(await list("?brandId=dud"), ["Track day bed", "dud.mp4"]);
assert.deepEqual(await list("?brandId=dud&sharing=brand"), ["dud.mp4"]);
assert.deepEqual(await list("?sharing=shared"), ["Track day bed"]);
assert.deepEqual(await list("?type=logo", polly), ["caleb-logo.png"]);
assert.deepEqual(await list("", otherAgency), []);
res = await app.inject({ method: "GET", url: "/assets?brandId=other", headers: operator });
assert.equal(res.statusCode, 404);
res = await app.inject({ method: "GET", url: "/assets?type=font", headers: operator });
assert.equal(res.statusCode, 400);
res = await app.inject({ method: "GET", url: "/assets", headers: nova });
assert.equal(res.statusCode, 403);

// Delete: file gone, a kit using it as its logo is cleared.
kits[0]!.logoAssetId = logo.id;
res = await app.inject({ method: "DELETE", url: `/assets/${logo.id}`, headers: otherAgency });
assert.equal(res.statusCode, 404);
res = await app.inject({ method: "DELETE", url: `/assets/${logo.id}`, headers: operator });
assert.deepEqual(res.json(), { ok: true });
assert.equal(existsSync(path.join(storage, "caleb/library/a1.png")), false);
assert.equal(kits[0]!.logoAssetId, null);
assert.deepEqual(await list("?brandId=caleb"), ["Track day bed"]);

await app.close();
rmSync(storage, { recursive: true, force: true });
console.log("assets.check: ok");
