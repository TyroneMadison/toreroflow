// Drive auto-post settings through the real auth hook, database and Drive
// stubbed: agency scoping, folder links only, eligible Instagram accounts,
// the linkedAt clock, and Drive refusals read as plain reasons. Bots refused.
import assert from "node:assert/strict";

delete process.env.DATABASE_URL;
process.env.GOOGLE_DRIVE_API_KEY = "drive-check-key";
process.env.DRIVE_API_BASE = "https://drive.stub/v3";

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { driveSourceRoutes } = await import("./driveSource");

const FOLDER = "1AbCdEfGhIjKlMnOpQr";
const OTHER = "1ZyXwVuTsRqPoNmLkJi";
const folderLink = (id: string) => `https://drive.google.com/drive/folders/${id}?usp=sharing`;
const PAST = "2026-01-01T00:00:00.000Z";

const clients: Array<{ id: string; agencyId: string; deletedAt: Date | null; driveSource: unknown }> = [
  { id: "c1", agencyId: "agencyA", deletedAt: null, driveSource: null },
  { id: "c2", agencyId: "agencyB", deletedAt: null, driveSource: null },
  { id: "gone", agencyId: "agencyA", deletedAt: new Date(), driveSource: null },
];
const ig = { platform: "instagram", status: "connected", deletedAt: null, tokensEncrypted: "provider:zernio" };
const accounts = [
  { ...ig, id: "ig1", clientId: "c1", handle: "brand", connectedAt: new Date(1) },
  { ...ig, id: "igRem", clientId: "c1", handle: "personal", connectedAt: new Date(2), tokensEncrypted: "reminder" },
  { ...ig, id: "igOld", clientId: "c1", handle: "old", connectedAt: new Date(3), status: "needs_reconnect" },
  { ...ig, id: "tt1", clientId: "c1", handle: "brand", connectedAt: new Date(4), platform: "tiktok" },
  { ...ig, id: "igB", clientId: "c2", handle: "other", connectedAt: new Date(5) },
];
const imports = [{ id: "d1", clientId: "c1", fileId: "f1aaaaaaaaaa", name: "a.mp4", status: "held", reason: "No speech.", createdAt: new Date() }];

const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("client", {
  findFirst: async ({ where }: any) => clients.find((c) => c.id === where.id && c.agencyId === where.agencyId && !c.deletedAt) ?? null,
  update: async ({ where, data }: any) => Object.assign(clients.find((c) => c.id === where.id)!, data),
});
stub("socialAccount", {
  findMany: async ({ where }: any) =>
    accounts.filter((a) => Object.entries(where).every(([k, v]) => (a as Record<string, unknown>)[k] === v)).map((a) => ({ id: a.id, handle: a.handle })),
});
stub("driveImport", { findMany: async ({ where }: any) => imports.filter((i) => i.clientId === where.clientId) });
stub("botIdentity", { findUnique: async () => null });

let driveStatus = 200;
const fetched: Array<{ url: string; key: string | null }> = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  fetched.push({ url: String(url), key: new Headers(init?.headers).get("x-goog-api-key") });
  if (driveStatus !== 200) return new Response("{}", { status: driveStatus });
  return Response.json({
    files: [
      { id: "f1aaaaaaaaaa", name: "a.mp4", mimeType: "video/mp4" },
      { id: "f2aaaaaaaaaa", name: "b.MOV", mimeType: "application/octet-stream" },
      { id: "f3aaaaaaaaaa", name: "notes", mimeType: "application/vnd.google-apps.document" },
    ],
  });
}) as typeof fetch;

const app = Fastify();
await app.register(jwt, { secret: "drive-source-check" });
await app.register(driveSourceRoutes);
const token = (extra: object = {}) => app.jwt.sign({ sub: "owner1", agencyId: "agencyA", ...extra });
const req = (method: "GET" | "PUT" | "POST", url: string, payload?: object, t = token()) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${t}` } });
const save = (body: object) =>
  req("PUT", "/clients/c1/drive-source", { link: folderLink(FOLDER), socialAccountId: "ig1", graduation: "MANUAL", mode: "dryrun", on: true, ...body });
const stored = () => clients[0]!.driveSource as Record<string, unknown>;

// Defaults, the eligible accounts only, and the recent imports.
const first = (await req("GET", "/clients/c1/drive-source")).json();
assert.deepEqual(
  { on: first.settings.on, mode: first.settings.mode, graduation: first.settings.graduation, linkedAt: first.settings.linkedAt },
  { on: false, mode: "dryrun", graduation: "MANUAL", linkedAt: null },
);
assert.deepEqual(first.instagramAccounts, [{ id: "ig1", handle: "brand" }], "provider-connected Instagram only");
assert.equal(first.imports.length, 1);
assert.equal(first.imports[0].reason, "No speech.");
assert.equal(first.keyReady, true);

// Scoping.
assert.equal((await req("GET", "/clients/c2/drive-source")).statusCode, 404, "other agency");
assert.equal((await req("GET", "/clients/gone/drive-source")).statusCode, 404, "deleted brand");
assert.equal((await req("PUT", "/clients/c2/drive-source", { link: "", socialAccountId: "", graduation: "MANUAL", mode: "dryrun", on: false })).statusCode, 404, "other agency save");
assert.equal(clients[1]!.driveSource, null, "other agency untouched");
assert.equal((await req("POST", "/clients/c2/drive-source/check", {})).statusCode, 404, "other agency check");

// Who may call.
assert.equal((await req("PUT", "/clients/c1/drive-source", {}, token({ role: "viewer" }))).statusCode, 403, "viewer cannot save");
const bot = token({ role: "bot", bot: "nova" });
assert.equal((await req("GET", "/clients/c1/drive-source", undefined, bot)).statusCode, 403, "bot cannot read");
assert.equal((await req("PUT", "/clients/c1/drive-source", {}, bot)).statusCode, 403, "bot cannot save");
assert.equal((await req("POST", "/clients/c1/drive-source/check", {}, bot)).statusCode, 403, "bot cannot check");
assert.equal((await app.inject({ method: "GET", url: "/clients/c1/drive-source" })).statusCode, 401, "no token");

// Bad saves are refused and write nothing.
const refused = async (body: object, pattern: RegExp, why: string) => {
  const r = await save(body);
  assert.equal(r.statusCode, 400, why);
  assert.match(r.json().detail, pattern, why);
  assert.equal(clients[0]!.driveSource, null, `${why}: nothing written`);
};
await refused({ link: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view" }, /folder link/, "a file link");
await refused({ link: "https://example.com/folders/1AbCdEfGhIjKlMnOpQr" }, /folder link/, "not Drive");
await refused({ link: "" }, /Paste the Drive folder link/, "on with no folder");
await refused({ socialAccountId: "" }, /Pick the Instagram account/, "on with no account");
for (const id of ["igRem", "igOld", "tt1", "igB"]) await refused({ socialAccountId: id }, /not connected to this brand/, `account ${id}`);
assert.equal((await save({ mode: "posting" })).statusCode, 400, "unknown mode");
assert.equal((await save({ graduation: "AUTO" })).statusCode, 400, "unknown graduation");

// Switching on starts the clock.
const before = Date.now();
const on = await save({ graduation: "SS_PERFORMANCE", mode: "live" });
assert.equal(on.statusCode, 200);
assert.equal(stored().folderId, FOLDER);
assert.equal(stored().on, true);
assert.equal(stored().mode, "live");
assert.equal(stored().graduation, "SS_PERFORMANCE");
assert.ok(Date.parse(stored().linkedAt as string) >= before, "linkedAt is now");
assert.deepEqual(on.json().settings, stored(), "answers with what it saved");

// Same folder, still on: the clock and the worker's last check are kept.
clients[0]!.driveSource = { ...stored(), linkedAt: PAST, lastCheckAt: PAST, lastResult: "2 new videos." };
await save({ mode: "dryrun" });
assert.equal(stored().linkedAt, PAST, "same folder keeps linkedAt");
assert.equal(stored().lastCheckAt, PAST, "lastCheckAt kept");
assert.equal(stored().lastResult, "2 new videos.", "lastResult kept");
assert.equal(stored().mode, "dryrun");

// A new folder restarts it.
await save({ link: folderLink(OTHER) });
assert.equal(stored().folderId, OTHER);
assert.notEqual(stored().linkedAt, PAST, "new folder restarts linkedAt");

// Off keeps it, back on restarts it.
clients[0]!.driveSource = { ...stored(), linkedAt: PAST };
await save({ link: folderLink(OTHER), on: false });
assert.equal(stored().on, false);
assert.equal(stored().linkedAt, PAST, "off keeps linkedAt");
await save({ link: folderLink(OTHER) });
assert.notEqual(stored().linkedAt, PAST, "switching on restarts linkedAt");
// Off with nothing picked is allowed, so a disconnected account never blocks switching off.
assert.equal((await save({ link: "", socialAccountId: "", on: false })).statusCode, 200);
assert.equal(stored().folderId, "");

// Check folder: videos only, key in the header and never the URL.
fetched.length = 0;
const ok = (await req("POST", "/clients/c1/drive-source/check", { link: folderLink(FOLDER) })).json();
assert.deepEqual(ok, { ok: true, videos: 2, sample: ["a.mp4", "b.MOV"] });
assert.equal(fetched.length, 1, "one listing");
assert.ok(fetched[0]!.url.startsWith("https://drive.stub/v3/files?"), "DRIVE_API_BASE");
assert.ok(new URL(fetched[0]!.url).searchParams.get("q")!.startsWith(`'${FOLDER}' in parents`));
assert.equal(fetched[0]!.key, "drive-check-key");
assert.ok(!fetched[0]!.url.includes("drive-check-key") && !fetched[0]!.url.includes("key="), "no key in the URL");

// The saved folder when no link is sent; nothing saved means nothing fetched.
const noFolder = (await req("POST", "/clients/c1/drive-source/check", {})).json();
assert.deepEqual(noFolder, { ok: false, reason: "Paste the Drive folder link first." });
const fileLink = (await req("POST", "/clients/c1/drive-source/check", { link: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view" })).json();
assert.equal(fileLink.ok, false);
assert.match(fileLink.reason, /folder link/);
assert.equal(fetched.length, 1, "no fetch for a missing or file link");
await save({});
fetched.length = 0;
assert.equal((await req("POST", "/clients/c1/drive-source/check")).json().videos, 2, "saved folder");
assert.ok(new URL(fetched[0]!.url).searchParams.get("q")!.startsWith(`'${FOLDER}' in parents`));

// Drive refusals read as plain reasons, never a URL or the key.
for (const status of [403, 404]) {
  driveStatus = status;
  const r = (await req("POST", "/clients/c1/drive-source/check", {})).json();
  assert.deepEqual(r, { ok: false, reason: "Drive would not show this folder. Set its sharing to Anyone with the link." }, `Drive ${status}`);
}
driveStatus = 500;
const down = (await req("POST", "/clients/c1/drive-source/check", {})).json();
assert.equal(down.ok, false);
assert.ok(down.reason && !/drive-check-key|https?:/.test(down.reason), "plain reason");
driveStatus = 200;

await app.close();
console.log("driveSource.check: all checks passed");
