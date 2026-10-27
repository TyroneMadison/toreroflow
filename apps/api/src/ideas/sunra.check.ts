// Sunra carousels: the quote spends nothing, generation is OFF by default,
// needs approved: true on an unexpired quote, and a quote pays at most once.
// The generator is a fake and fetch throws, so no Sunra call can happen.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const storage = mkdtempSync(path.join(os.tmpdir(), "sunra-"));
process.env.STORAGE_DIR = storage;
process.env.SUNRA_PRICE_PER_IMAGE_USD = "0.045";
delete process.env.BOT_FULL_ACCESS;
globalThis.fetch = (async () => {
  throw new Error("no network in this check");
}) as typeof fetch;
const { getPrisma } = await import("@toreroflow/db");
const { SunraCarouselQuoteSchema } = await import("@toreroflow/contracts");
const { sunraRoutes, setSunraGenerator, QUOTE_TTL_MS } = await import("../routes/sunra");
const { testApp } = await import("./testApp");

const settings = new Map<string, unknown>();
const quotes: Record<string, any>[] = [];
const prisma = getPrisma();
const mock = (name: string, value: object) => Object.defineProperty(prisma, name, { value });
type Key = { where: { agencyId_key: { agencyId: string; key: string } } };
const sk = (w: Key["where"]) => `${w.agencyId_key.agencyId}|${w.agencyId_key.key}`;
mock("appSetting", {
  findUnique: async ({ where }: Key) => (settings.has(sk(where)) ? { value: settings.get(sk(where)) } : null),
  upsert: async ({ where, create }: Key & { create: { value: unknown } }) => void settings.set(sk(where), create.value),
});
mock("client", {
  findFirst: async ({ where }: { where: { id: string; agencyId: string } }) => (where.id === "caleb" && where.agencyId === "A" ? { id: "caleb" } : null),
});
mock("sunraQuote", {
  create: async ({ data }: { data: object }) => {
    const q = { id: `q${quotes.length + 1}`, status: "quoted", ...data };
    quotes.push(q);
    return q;
  },
  findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
    where.client.agencyId === "A" ? quotes.find((q) => q.id === where.id) ?? null : null,
  updateMany: async ({ where, data }: { where: { id: string; status: string }; data: object }) => {
    const q = quotes.find((x) => x.id === where.id && x.status === where.status);
    if (q) Object.assign(q, data);
    return { count: q ? 1 : 0 };
  },
  update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(quotes.find((q) => q.id === where.id)!, data),
});

let generated = 0;
const fakeGenerator = async ({ slides }: { slides: number }) => {
  generated++;
  return Array.from({ length: slides }, (_, i) => Buffer.from(`slide ${i + 1}`));
};

const { app, operator, polly, nova, otherAgency } = await testApp(sunraRoutes);
const quote = (headers: Record<string, string>, payload: object) => app.inject({ method: "POST", url: "/sunra/carousel/quote", headers, payload });
const generate = (headers: Record<string, string>, id: string, payload: object = { approved: true }) =>
  app.inject({ method: "POST", url: `/sunra/carousel/${id}/generate`, headers, payload });

// Price check: stored, priced per image, always needs approval, spends nothing.
let res = await quote(polly, { brandId: "caleb", slides: 6, prompt: "Fall lineup, 6 cars" });
assert.equal(res.statusCode, 200, res.body);
const q1 = SunraCarouselQuoteSchema.parse(res.json());
assert.equal(q1.priceUsd, 0.27);
assert.equal(q1.requiresApproval, true);
assert.ok(Math.abs(Date.parse(q1.expiresAt) - Date.now() - QUOTE_TTL_MS) < 5000);
assert.equal(quotes[0]!.platform, "instagram", "Instagram unless asked");
assert.equal(generated, 0);

res = await quote(operator, { brandId: "caleb", slides: 11, prompt: "x" });
assert.equal(res.statusCode, 400, "Instagram takes 10 slides at most");
res = await quote(operator, { brandId: "caleb", slides: 12, prompt: "x", platform: "tiktok" });
assert.equal(res.statusCode, 200, "TikTok takes more");
res = await quote(operator, { brandId: "caleb", slides: 21, prompt: "x", platform: "tiktok" });
assert.equal(res.statusCode, 400);
res = await quote(otherAgency, { brandId: "caleb", slides: 2, prompt: "x" });
assert.equal(res.statusCode, 404);
res = await quote(nova, { brandId: "caleb", slides: 2, prompt: "x" });
assert.equal(res.statusCode, 403, "other bots cannot ask Sunra for anything");

// Generation is OFF by default, even with approval and a generator.
setSunraGenerator(fakeGenerator);
res = await app.inject({ method: "GET", url: "/sunra/settings", headers: operator });
assert.deepEqual(res.json(), { generationEnabled: false });
res = await generate(operator, q1.quoteId);
assert.equal(res.statusCode, 403);
assert.equal(generated, 0);

res = await app.inject({ method: "PUT", url: "/sunra/settings", headers: nova, payload: { generationEnabled: true } });
assert.equal(res.statusCode, 403);
res = await app.inject({ method: "PUT", url: "/sunra/settings", headers: operator, payload: { generationEnabled: true } });
assert.equal(res.statusCode, 200);

// Approval must be the literal true.
for (const payload of [{}, { approved: "true" }, { approved: false }]) {
  res = await generate(operator, q1.quoteId, payload);
  assert.equal(res.statusCode, 400, JSON.stringify(payload));
}
assert.equal(generated, 0);

// Not connected: 503, and the quote is still usable afterwards.
setSunraGenerator(null);
res = await generate(operator, q1.quoteId);
assert.equal(res.statusCode, 503);
assert.equal(quotes[0]!.status, "quoted");
setSunraGenerator(fakeGenerator);

// Approved: generates once, slides stored, Polly recorded as the approver.
res = await generate(polly, q1.quoteId);
assert.equal(res.statusCode, 200, res.body);
assert.equal(res.json().status, "done");
assert.equal(res.json().slideUrls.length, 6);
assert.equal(readFileSync(path.join(storage, `caleb/sunra/${q1.quoteId}/slide-6.png`), "utf8"), "slide 6");
assert.equal(quotes[0]!.approvedBy, "bot:polly");
assert.equal(generated, 1);

// The same quote never pays twice.
res = await generate(operator, q1.quoteId);
assert.equal(res.statusCode, 409);
assert.equal(generated, 1);

// Expired quote.
res = await quote(operator, { brandId: "caleb", slides: 2, prompt: "y" });
const q2 = res.json().quoteId as string;
quotes.find((q) => q.id === q2)!.expiresAt = new Date(Date.now() - 1);
res = await generate(operator, q2);
assert.equal(res.statusCode, 410);
res = await generate(otherAgency, q2);
assert.equal(res.statusCode, 403, "the switch is per agency, and agency B never turned it on");

// A Sunra failure uses up the quote and is recorded.
res = await quote(operator, { brandId: "caleb", slides: 2, prompt: "z" });
const q3 = res.json().quoteId as string;
setSunraGenerator(async () => {
  throw new Error("sunra 500");
});
res = await generate(operator, q3);
assert.equal(res.statusCode, 502);
assert.equal(quotes.find((q) => q.id === q3)!.status, "failed");
assert.equal(quotes.find((q) => q.id === q3)!.error, "sunra 500");

await app.close();
rmSync(storage, { recursive: true, force: true });
console.log("sunra.check: ok");
