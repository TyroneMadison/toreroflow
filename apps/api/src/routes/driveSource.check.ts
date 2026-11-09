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
  { ...ig, id: "ig2", clientId: "c1", handle: "brand.rents", connectedAt: new Date(1.5) },
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
  req("PUT", "/clients/c1/drive-source", { link: folderLink(FOLDER), socialAccountIds: ["ig1"], graduation: "MANUAL", mode: "dryrun", on: true, ...body });
const stored = () => clients[0]!.driveSource as Record<string, unknown>;

// Defaults, the eligible accounts only, and the recent imports.
const first = (await req("GET", "/clients/c1/drive-source")).json();
assert.deepEqual(
  { on: first.settings.on, mode: first.settings.mode, graduation: first.settings.graduation, linkedAt: first.settings.linkedAt },
  { on: false, mode: "dryrun", graduation: "MANUAL", linkedAt: null },
);
assert.deepEqual(first.settings.socialAccountIds, [], "no accounts ticked yet");
assert.deepEqual(
  first.instagramAccounts,
  [{ id: "ig1", handle: "brand" }, { id: "ig2", handle: "brand.rents" }],
  "provider-connected Instagram only",
);
assert.equal(first.imports.length, 1);
assert.equal(first.imports[0].reason, "No speech.");
assert.equal(first.keyReady, true);

// Scoping.
assert.equal((await req("GET", "/clients/c2/drive-source")).statusCode, 404, "other agency");
assert.equal((await req("GET", "/clients/gone/drive-source")).statusCode, 404, "deleted brand");
assert.equal((await req("PUT", "/clients/c2/drive-source", { link: "", socialAccountIds: [], graduation: "MANUAL", mode: "dryrun", on: false })).statusCode, 404, "other agency save");
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
await refused({ socialAccountIds: [] }, /Tick at least one Instagram account/, "on with no account");
await refused({ socialAccountIds: ["", "  "] }, /Tick at least one Instagram account/, "blank ids are no account");
await refused({ socialAccountIds: undefined }, /Tick at least one Instagram account/, "no list at all is no account");
for (const id of ["igRem", "igOld", "tt1", "igB", "nope"]) {
  await refused({ socialAccountIds: ["ig1", id] }, /not connected to this brand/, `one bad account in the list: ${id}`);
}
await refused({ socialAccountIds: Array.from({ length: 11 }, () => "ig1") }, /at most 10/, "more than 10");
await refused({ socialAccountIds: "ig1" }, /./, "a string is not a list");
assert.equal((await save({ mode: "posting" })).statusCode, 400, "unknown mode");
assert.equal((await save({ graduation: "AUTO" })).statusCode, 400, "unknown graduation");

// Several accounts, deduped, in the order ticked.
assert.equal((await save({ socialAccountIds: ["ig2", "ig1", " ig2 "] })).statusCode, 200);
assert.deepEqual(stored().socialAccountIds, ["ig2", "ig1"], "deduped, in order");
assert.equal("socialAccountId" in stored(), false, "the single-account field is never written");
clients[0]!.driveSource = null;

// A save from an app that sends one account still works, as a list of one.
assert.equal((await save({ socialAccountIds: undefined, socialAccountId: "ig2" })).statusCode, 200);
assert.deepEqual(stored().socialAccountIds, ["ig2"], "legacy socialAccountId becomes a list");
assert.equal("socialAccountId" in stored(), false, "and is not stored as well");
assert.equal((await save({ socialAccountIds: undefined, socialAccountId: "igOld" })).statusCode, 400, "a legacy bad account is refused too");
assert.equal((await save({ socialAccountIds: ["ig1"], socialAccountId: "ig2" })).statusCode, 200);
assert.deepEqual(stored().socialAccountIds, ["ig1"], "the list wins over the legacy field");

// Settings stored with one account read back as a list.
clients[0]!.driveSource = { on: true, folderId: FOLDER, link: folderLink(FOLDER), socialAccountId: "ig1", linkedAt: PAST };
assert.deepEqual((await req("GET", "/clients/c1/drive-source")).json().settings.socialAccountIds, ["ig1"], "legacy stored id reads as a list");

// An account stored earlier that has since disconnected is dropped by leaving it out.
clients[0]!.driveSource = { ...stored(), socialAccountIds: ["ig1", "igOld"] };
assert.equal((await save({ socialAccountIds: ["ig1"] })).statusCode, 200, "dropping a disconnected account saves");
assert.deepEqual(stored().socialAccountIds, ["ig1"]);
assert.equal((await save({ socialAccountIds: ["ig1", "igOld"] })).statusCode, 400, "keeping it is refused");

// Installed 0.3.52 apps read one id and send one back. This is the pick such an app shows, by its own expression.
const oldAppPick = async () => {
  const v = (await req("GET", "/clients/c1/drive-source")).json();
  const ids: string[] = v.instagramAccounts.map((a: { id: string }) => a.id);
  const s: string | undefined = v.settings.socialAccountId;
  return s && ids.includes(s) ? s : !s && ids.length === 1 ? ids[0]! : "";
};
clients[0]!.driveSource = { ...stored(), socialAccountIds: ["ig1", "ig2"] };
assert.equal(await oldAppPick(), "ig1", "an old app shows a ticked account as picked");
accounts[1]!.status = "needs_reconnect";
clients[0]!.driveSource = { ...stored(), socialAccountIds: ["ig2"] };
assert.equal((await req("GET", "/clients/c1/drive-source")).json().settings.socialAccountId, "ig2", "a disconnected id is still sent");
assert.equal(await oldAppPick(), "", "so an old app never preselects the one account left, which nobody ticked");
accounts[1]!.status = "connected";

const legacySave = (body: object) => save({ socialAccountIds: undefined, ...body });
clients[0]!.driveSource = { ...stored(), socialAccountIds: ["ig1", "ig2"] };
assert.equal((await legacySave({ socialAccountId: "ig1", graduation: "SS_PERFORMANCE" })).statusCode, 200);
assert.deepEqual(stored().socialAccountIds, ["ig1", "ig2"], "an old app sending back the account it was shown keeps the list");
assert.equal(stored().graduation, "SS_PERFORMANCE", "and its other changes save");
assert.equal((await legacySave({ socialAccountId: "ig1", on: false })).statusCode, 200);
assert.deepEqual(stored().socialAccountIds, ["ig1", "ig2"], "switching off from an old app keeps the list");
const several = JSON.stringify(stored());
for (const id of ["ig2", ""]) {
  const r = await legacySave({ socialAccountId: id });
  assert.equal(r.statusCode, 400, `an old app cannot change a list of several: ${id || "none"}`);
  assert.match(r.json().detail, /Update the app/);
  assert.equal(JSON.stringify(stored()), several, "nothing written");
}
clients[0]!.driveSource = { ...stored(), socialAccountIds: ["ig1"] };
assert.equal((await legacySave({ socialAccountId: "ig2" })).statusCode, 200);
assert.deepEqual(stored().socialAccountIds, ["ig2"], "a list of one it can still replace");
clients[0]!.driveSource = { ...stored(), socialAccountIds: ["ig1", "igOld"] };
assert.equal((await legacySave({ socialAccountId: "ig1" })).statusCode, 200);
assert.deepEqual(stored().socialAccountIds, ["ig1"], "a disconnected id is dropped on an old app's save too");
clients[0]!.driveSource = { ...stored(), socialAccountIds: ["igOld"] };
const nonePicked = await legacySave({ socialAccountId: "" });
assert.equal(nonePicked.statusCode, 400);
assert.match(nonePicked.json().detail, /Pick the Instagram account/, "in words the old app's picker matches");
clients[0]!.driveSource = null;

// Switching on starts the clock.
const before = Date.now();
const on = await save({ graduation: "SS_PERFORMANCE", mode: "live" });
assert.equal(on.statusCode, 200);
assert.equal(stored().folderId, FOLDER);
assert.equal(stored().on, true);
assert.equal(stored().mode, "live");
assert.equal(stored().graduation, "SS_PERFORMANCE");
assert.ok(Date.parse(stored().linkedAt as string) >= before, "linkedAt is now");
assert.deepEqual(on.json().settings, { ...stored(), socialAccountId: "ig1" }, "answers with what it saved, plus the one id old apps read");

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
assert.equal((await save({ link: "", socialAccountIds: [], on: false })).statusCode, 200);
assert.deepEqual(stored().socialAccountIds, []);
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
