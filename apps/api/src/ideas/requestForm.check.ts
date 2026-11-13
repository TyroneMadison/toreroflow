// Public request form hardening: only a brand's signed link reaches it, links
// rotate and revoke, limits are counted in the database, fields are strict and
// size capped, Turnstile is off until its secret is set, a file's type comes
// from its bytes, and every outcome lands in the audit log. Trello and
// Cloudflare are mocked; nothing leaves the process.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const storage = mkdtempSync(path.join(os.tmpdir(), "reqform-"));
process.env.STORAGE_DIR = storage;
process.env.TRELLO_KEY = "";
process.env.TRELLO_TOKEN = "";
process.env.TURNSTILE_SECRET_KEY = "";
process.env.TURNSTILE_SITE_KEY = "";
delete process.env.BOT_FULL_ACCESS;
const turnstileCalls: URLSearchParams[] = [];
let turnstileOk = true;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (String(url) !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") throw new Error(`unexpected network call ${url}`);
  turnstileCalls.push(new URLSearchParams(String(init?.body)));
  return new Response(JSON.stringify({ success: turnstileOk }));
}) as typeof fetch;

const { getPrisma } = await import("@toreroflow/db");
const { env } = await import("../env");
const R = await import("../routes/contentRequests");
const { clientIp } = await import("./rateLimit");
const { testApp, mockRateLimits } = await import("./testApp");

// ---- pure parts ----
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
assert.equal(R.sniffFileType(PNG), "png");
assert.equal(R.sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), "jpg");
assert.equal(R.sniffFileType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
assert.equal(R.sniffFileType(Buffer.from("%PDF-1.7\n")), "pdf");
assert.equal(R.sniffFileType(Buffer.from("<svg onload=alert(1)>")), null);
assert.equal(R.sniffFileType(Buffer.from("MZ\x90\0")), null, "an exe named .png is still an exe");
assert.equal(R.sniffFileType(Buffer.alloc(0)), null);
assert.notEqual(R.requestFormToken("l1", "a"), R.requestFormToken("l1", "b"));
assert.notEqual(R.requestFormToken("l1"), R.requestFormToken("l2"));

const fakeReq = (ip: string, xff?: string) => ({ ip, headers: xff ? { "x-forwarded-for": xff } : {} }) as never;
assert.equal(clientIp(fakeReq("10.0.0.2", "6.6.6.6, 1.2.3.4")), "10.0.0.2", "off a server the socket is the truth");
env.IS_PRODUCTION = true;
assert.equal(clientIp(fakeReq("10.0.0.2", "6.6.6.6, 1.2.3.4")), "1.2.3.4", "behind Caddy: the entry Caddy appended, not the spoofable first");
assert.equal(clientIp(fakeReq("10.0.0.2")), "10.0.0.2");
env.IS_PRODUCTION = false;

// ---- in-memory database ----
const clients = [
  { id: "caleb", agencyId: "A", name: "Caleb Rentals", deletedAt: null as Date | null },
  { id: "gone", agencyId: "A", name: "Gone", deletedAt: new Date() },
];
const links: { id: string; clientId: string; createdById: string; revokedAt: Date | null; createdAt: Date }[] = [];
const audits: Record<string, any>[] = [];
const requests: Record<string, any>[] = [];
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
const buckets = await mockRateLimits();
const inAgency = (clientId: string, agencyId: string) => clients.some((c) => c.id === clientId && c.agencyId === agencyId);
mock("client", {
  findFirst: async ({ where }: { where: { id: string; agencyId: string } }) =>
    clients.find((c) => c.id === where.id && c.agencyId === where.agencyId && !c.deletedAt) ?? null,
  findMany: async ({ where }: { where: { agencyId: string } }) => clients.filter((c) => c.agencyId === where.agencyId),
});
mock("requestFormLink", {
  create: async ({ data }: { data: { clientId: string; createdById: string } }) => {
    const l = { id: `L${links.length + 1}`, revokedAt: null, createdAt: new Date(), ...data };
    links.push(l);
    return l;
  },
  findUnique: async ({ where }: { where: { id: string } }) => {
    const l = links.find((x) => x.id === where.id);
    const c = l && clients.find((x) => x.id === l.clientId)!;
    return l ? { ...l, client: { name: c!.name, deletedAt: c!.deletedAt } } : null;
  },
  findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
    links.find((l) => l.id === where.id && inAgency(l.clientId, where.client.agencyId)) ?? null,
  findMany: async ({ where }: { where: { client: { agencyId: string }; clientId?: string } }) =>
    links.filter((l) => inAgency(l.clientId, where.client.agencyId) && (!where.clientId || l.clientId === where.clientId)).reverse(),
  update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(links.find((l) => l.id === where.id)!, data),
});
mock("requestFormAudit", {
  create: async ({ data }: { data: object }) => void audits.push(data),
  findMany: async ({ where }: { where: { clientId: { in: string[] } } }) => audits.filter((a) => where.clientId.in.includes(a.clientId)).reverse(),
});
mock("contentRequest", {
  create: async ({ data }: { data: object }) => {
    const r = { id: `r${requests.length + 1}`, status: "pending", ...data };
    requests.push(r);
    return r;
  },
  update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(requests.find((r) => r.id === where.id)!, data),
  findUnique: async ({ where }: { where: { id: string } }) => {
    const r = requests.find((x) => x.id === where.id);
    return r ? { ...r, client: clients.find((c) => c.id === r.clientId) } : null;
  },
  findMany: async () => requests,
});
Object.defineProperty(prisma, "$transaction", { value: async (fn: (tx: unknown) => unknown) => fn(prisma) });

const ops = await testApp(R.contentRequestRoutes);
const pub = await testApp(R.publicContentRequestRoutes);
const viewer = { authorization: `Bearer ${ops.app.jwt.sign({ sub: "v", agencyId: "A", role: "viewer" } as never)}` };
let ipN = 0;
const freshIp = () => `10.1.${Math.floor(++ipN / 250)}.${ipN % 250}`;
const post = (token: string, payload: object, remoteAddress = freshIp()) =>
  pub.app.inject({ method: "POST", url: `/r/${token}`, payload, remoteAddress });
const actions = () => audits.map((a) => a.action);

// ---- operator: create, list, who may ----
let res = await ops.app.inject({ method: "POST", url: "/request-links", headers: viewer, payload: { brandId: "caleb" } });
assert.equal(res.statusCode, 403, "viewers cannot make links");
res = await ops.app.inject({ method: "POST", url: "/request-links", headers: ops.nova, payload: { brandId: "caleb" } });
assert.equal(res.statusCode, 403, "other bots cannot make links");
res = await ops.app.inject({ method: "POST", url: "/request-links", headers: ops.otherAgency, payload: { brandId: "caleb" } });
assert.equal(res.statusCode, 404);
res = await ops.app.inject({ method: "POST", url: "/request-links", headers: ops.operator, payload: { brandId: "gone" } });
assert.equal(res.statusCode, 404, "no links for a deleted brand");
res = await ops.app.inject({ method: "POST", url: "/request-links", headers: ops.operator, payload: { brandId: "caleb" } });
assert.equal(res.statusCode, 201, res.body);
const link1 = res.json();
assert.equal(link1.url, `/r/${link1.token}`);
assert.equal(link1.token, R.requestFormToken(link1.id));
assert.deepEqual(audits.at(-1), { action: "link_created", actor: "u1", clientId: "caleb", linkId: link1.id });
res = await ops.app.inject({ method: "GET", url: "/request-links?brandId=caleb", headers: ops.operator });
assert.deepEqual(res.json().links.map((l: { id: string }) => l.id), [link1.id]);
res = await ops.app.inject({ method: "GET", url: "/request-links", headers: ops.otherAgency });
assert.deepEqual(res.json().links, []);

// ---- public: the form info, a real submission ----
res = await pub.app.inject({ method: "GET", url: `/r/${link1.token}` });
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json(), { brandName: "Caleb Rentals", turnstileSiteKey: null, maxFileBytes: 10 * 1024 * 1024, fileTypes: ["png", "jpg", "webp", "pdf"] });
res = await post(link1.token, { what: "Walkaround of the M3", dueDate: "", footageUrl: "https://drive.google.com/x", website: "" });
assert.equal(res.statusCode, 201, res.body);
assert.equal(requests.length, 1);
assert.deepEqual([requests[0]!.clientId, requests[0]!.linkId, requests[0]!.dueDate], ["caleb", link1.id, null], "empty strings are not given");
assert.equal(requests[0]!.status, "failed", "stored even though Trello is not configured");
assert.equal(actions().at(-1), "submitted");

// ---- tokens: forged, tampered, the old brandId route is gone ----
audits.length = 0;
for (const token of ["nope", `${link1.id}.AAAA`, `${link1.id}.${R.requestFormToken(link1.id, "other-secret").split(".")[1]}`, `L999.${R.requestFormToken("L999").split(".")[1]}`]) {
  res = await post(token, { what: "x" });
  assert.equal(res.statusCode, 404, token);
}
assert.deepEqual(actions(), ["bad_token", "bad_token", "bad_token", "bad_token"]);
res = await pub.app.inject({ method: "POST", url: "/requests", payload: { brandId: "caleb", what: "x" } });
assert.equal(res.statusCode, 404, "no public route takes a brandId any more");
assert.equal(requests.length, 1);

// ---- validation and size limits ----
audits.length = 0;
for (const [payload, why] of [
  [{ what: "   " }, "blank"],
  [{ what: "x".repeat(2001) }, "too long"],
  [{ what: "x", footageUrl: "javascript:alert(1)" }, "script link"],
  [{ what: "x", footageUrl: "ftp://x.com/a" }, "not http"],
  [{ what: "x", dueDate: "tomorrow" }, "not a date"],
  [{ what: "x", notes: "n".repeat(4001) }, "notes too long"],
  [{ what: "x", brandId: "dud" }, "unknown field, even brandId"],
  [{ what: "x", isAdmin: true }, "unknown field"],
] as const) {
  res = await post(link1.token, payload);
  assert.equal(res.statusCode, 400, why);
}
assert.match((await post(link1.token, { what: "x", footageUrl: "javascript:alert(1)" })).json().error, /^footageUrl: /);
assert.equal(requests.length, 1);
assert.ok(actions().every((a) => a === "rejected"));
res = await post(link1.token, { what: "x".repeat(40 * 1024) });
assert.equal(res.statusCode, 413, "JSON over 32 KB is refused before parsing");

// ---- honeypot: same answer, dropped, audited ----
res = await post(link1.token, { what: "buy pills", website: "spam.biz" });
assert.equal(res.statusCode, 201);
assert.equal(requests.length, 1);
assert.deepEqual([audits.at(-1)!.action, audits.at(-1)!.detail], ["rejected", "honeypot"]);

// ---- files: type from the bytes, size capped ----
const send = (data: Buffer, filename: string, type: string, fields: Record<string, string> = { what: "See the reference" }) => {
  const u = pub.upload(filename, type, data, fields);
  return pub.app.inject({ method: "POST", url: `/r/${link1.token}`, payload: u.payload, headers: u.headers, remoteAddress: freshIp() });
};
res = await send(PNG, "ref.png", "image/png");
assert.equal(res.statusCode, 201, res.body);
const withFile = requests.at(-1)!;
assert.equal(withFile.attachmentKey, `caleb/requests/${withFile.id}.png`);
assert.deepEqual(readFileSync(path.join(storage, withFile.attachmentKey)), PNG);
res = await send(Buffer.from("%PDF-1.4 brief"), "brief.bin", "application/octet-stream");
assert.equal(res.statusCode, 201, "a PDF is a PDF whatever it is called");
assert.match(requests.at(-1)!.attachmentKey, /\.pdf$/);
const before = requests.length;
res = await send(Buffer.from("<html><script>x</script>"), "ref.png", "image/png");
assert.equal(res.statusCode, 415, "a lying name and Content-Type do not get in");
res = await send(Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]), "big.png", "image/png");
assert.equal(res.statusCode, 413);
res = await send(PNG, "ref.png", "image/png", { what: "x", isAdmin: "1" });
assert.equal(res.statusCode, 400, "multipart fields are strict too");
assert.equal(requests.length, before);
res = await ops.app.inject({ method: "GET", url: "/requests", headers: ops.operator });
assert.match(res.json().requests.find((r: { id: string }) => r.id === withFile.id).attachmentUrl, /^\/files\//);

// ---- rate limits, in the database table ----
audits.length = 0;
const ip = "7.7.7.7";
for (let i = 0; i < 5; i++) assert.equal((await post(link1.token, { what: `r${i}` }, ip)).statusCode, 201);
res = await post(link1.token, { what: "sixth" }, ip);
assert.equal(res.statusCode, 429, "6th from one IP in 10 minutes");
res = await post(link1.token, { what: "seventh" }, ip);
assert.equal(res.statusCode, 429);
assert.equal(actions().filter((a) => a === "rate_limited").length, 1, "a flood is logged once per window");
assert.ok([...buckets.keys()].some((k) => k.startsWith("request-form-ip|7.7.7.7|")));
res = await post("nope", { what: "x" }, ip);
assert.equal(res.statusCode, 429, "token guessing counts against the IP too");
// Per link: 100 a day, whoever sends them.
const linkKey = [...buckets.keys()].find((k) => k.startsWith(`request-form-link|${link1.id}|`))!;
buckets.get(linkKey)!.count = 100;
res = await post(link1.token, { what: "101st" });
assert.equal(res.statusCode, 429);
assert.match(res.json().error, /today/);
assert.deepEqual([audits.at(-1)!.action, audits.at(-1)!.detail], ["rate_limited", "per link"]);
buckets.get(linkKey)!.count = 0;

// ---- Turnstile: off by default, required once the secret is set ----
assert.equal(turnstileCalls.length, 0, "never called while off");
env.TURNSTILE_SECRET_KEY = "ts-secret";
env.TURNSTILE_SITE_KEY = "ts-site";
res = await pub.app.inject({ method: "GET", url: `/r/${link1.token}` });
assert.equal(res.json().turnstileSiteKey, "ts-site");
res = await post(link1.token, { what: "no captcha" });
assert.equal(res.statusCode, 403);
assert.equal(audits.at(-1)!.action, "captcha_failed");
turnstileOk = false;
res = await post(link1.token, { what: "bad captcha", turnstileToken: "bad" });
assert.equal(res.statusCode, 403);
turnstileOk = true;
const n = requests.length;
res = await post(link1.token, { what: "good captcha", "cf-turnstile-response": "good" }, "8.8.4.4");
assert.equal(res.statusCode, 201, res.body);
assert.equal(requests.length, n + 1);
assert.deepEqual([turnstileCalls.at(-1)!.get("secret"), turnstileCalls.at(-1)!.get("response"), turnstileCalls.at(-1)!.get("remoteip")], ["ts-secret", "good", "8.8.4.4"]);
env.TURNSTILE_SECRET_KEY = "";
env.TURNSTILE_SITE_KEY = "";

// ---- rotate and revoke ----
res = await ops.app.inject({ method: "POST", url: `/request-links/${link1.id}/rotate`, headers: viewer });
assert.equal(res.statusCode, 403);
res = await ops.app.inject({ method: "POST", url: `/request-links/${link1.id}/rotate`, headers: ops.otherAgency });
assert.equal(res.statusCode, 404);
res = await ops.app.inject({ method: "POST", url: `/request-links/${link1.id}/rotate`, headers: ops.polly });
assert.equal(res.statusCode, 201, res.body);
const link2 = res.json();
assert.notEqual(link2.token, link1.token);
assert.deepEqual([audits.at(-1)!.action, audits.at(-1)!.actor, audits.at(-1)!.detail], ["link_rotated", "bot:polly", `replaces ${link1.id}`]);
res = await post(link1.token, { what: "old link" });
assert.equal(res.statusCode, 410, "the rotated-out link is dead");
res = await pub.app.inject({ method: "GET", url: `/r/${link1.token}` });
assert.equal(res.statusCode, 410);
res = await post(link2.token, { what: "new link" });
assert.equal(res.statusCode, 201);
res = await ops.app.inject({ method: "DELETE", url: `/request-links/${link2.id}`, headers: viewer });
assert.equal(res.statusCode, 403);
res = await ops.app.inject({ method: "DELETE", url: `/request-links/${link2.id}`, headers: ops.operator });
assert.deepEqual(res.json(), { ok: true });
assert.equal(audits.at(-1)!.action, "link_revoked");
res = await ops.app.inject({ method: "DELETE", url: `/request-links/${link2.id}`, headers: ops.operator });
assert.equal(audits.filter((a) => a.action === "link_revoked").length, 1, "revoking twice logs once");
res = await post(link2.token, { what: "revoked" });
assert.equal(res.statusCode, 410);

// ---- the audit log, operator side ----
res = await ops.app.inject({ method: "GET", url: "/request-links/audit?brandId=caleb", headers: ops.operator });
assert.equal(res.statusCode, 200);
const seen = new Set(res.json().entries.map((e: { action: string }) => e.action));
for (const a of ["submitted", "rejected", "rate_limited", "captcha_failed", "link_rotated", "link_revoked"]) assert.ok(seen.has(a), a);
res = await ops.app.inject({ method: "GET", url: "/request-links/audit", headers: ops.otherAgency });
assert.deepEqual(res.json().entries, []);

await ops.app.close();
await pub.app.close();
rmSync(storage, { recursive: true, force: true });
console.log("requestForm.check: ok");
