// The composer's posts through the real auth hook and schedule route, no
// database, no network: an image or carousel goes to Instagram and TikTok
// with its post details, never to YouTube; captions over a platform's limits
// are refused server side (hashtags and mentions included); TikTok's options
// ride every TikTok target; and Polly's posts carry her name for her own key
// while her token reaches operator-only routes no other bot can.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const storage = await fs.mkdtemp(path.join(os.tmpdir(), "composer-"));
process.env.STORAGE_DIR = storage;
process.env.PUBLISH_PROVIDER = "zernio";
process.env.PUBLISH_PROVIDER_API_KEY = "test-key";
delete process.env.BOT_FULL_ACCESS;
globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { postRoutes } = await import("./posts");

const accounts = [
  { id: "yt1", platform: "youtube", status: "connected", handle: "dud", providerAccountId: "z-yt", tokensEncrypted: "provider:zernio" },
  { id: "ig1", platform: "instagram", status: "connected", handle: "dud", providerAccountId: "z-ig", tokensEncrypted: "provider:zernio" },
  { id: "tt1", platform: "tiktok", status: "connected", handle: "dud", providerAccountId: "z-tt", tokensEncrypted: "provider:zernio" },
];
const CAROUSEL = {
  id: "car1",
  clientId: "client1",
  kind: "carousel",
  status: "ready",
  storageKey: "client1/car1/1.jpg",
  slideKeys: ["client1/car1/1.jpg", "client1/car1/2.jpg", "client1/car1/3.jpg", "client1/car1/4.jpg"],
  sourceDeletedAt: null,
  durationSec: null,
  draftCopy: { name: "Four angles, one weekend", description: "Four angles, one weekend." },
  client: { id: "client1", name: "Dud Rents", socialAccounts: accounts },
};
const VIDEO = {
  ...CAROUSEL,
  id: "vid1",
  kind: "video",
  slideKeys: null,
  storageKey: "client1/vid1/source.mp4",
  durationSec: 30,
  format: "short_form",
};
const assets: Record<string, Record<string, unknown>> = { car1: CAROUSEL, vid1: VIDEO };

type Created = { data: { targets: { create: Array<Record<string, any>> } } };
let created = null as Created | null;
const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("mediaAsset", {
  findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
    where.client.agencyId === "agencyA" && assets[where.id] ? { ...assets[where.id] } : null,
});
stub("user", { findFirst: async () => ({ id: "owner1" }) });
stub("contentIdea", { findFirst: async () => null });
stub("post", {
  create: async (args: Created) => {
    created = args;
    throw new Error("stop-before-enqueue");
  },
});

const app = Fastify();
await app.register(jwt, { secret: "composer-check" });
await app.register(postRoutes);
const sign = (extra: object = {}) => app.jwt.sign({ sub: "deploy-script", agencyId: "agencyA", role: "bot", ...extra });
const later = new Date(Date.now() + 3 * 3600_000).toISOString();
const schedule = (id: string, body: object, token = sign()) =>
  app.inject({ method: "POST", url: `/media/${id}/schedule`, headers: { authorization: `Bearer ${token}` }, payload: body });

// A carousel never goes to YouTube.
let res = await schedule("car1", { platforms: ["youtube"], accountIds: ["yt1"], scheduledAt: later });
assert.equal(res.statusCode, 400);
assert.match(res.json().detail, /only Instagram and TikTok take them/);

// Carousel to Instagram and TikTok with post details: stored per target.
created = null;
res = await schedule("car1", {
  platforms: ["instagram", "tiktok"],
  accountIds: ["ig1", "tt1"],
  scheduledAt: later,
  caption: "Four angles, one weekend. @dudthecarguy #miami",
  instagram: { collaborators: ["@dudthecarguy"], locationId: "105890561436614", userTags: ["jlo_drives"] },
  tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true },
});
assert.ok(created, res.body);
let targets = (created as Created | null)!.data.targets.create;
const ig = targets.find((t) => t.platform === "instagram")!;
const tt = targets.find((t) => t.platform === "tiktok")!;
assert.deepEqual(ig.options.instagram.collaborators, ["dudthecarguy"]);
assert.equal(ig.options.instagram.locationId, "105890561436614");
assert.deepEqual(ig.options.instagram.userTags, ["jlo_drives"]);
assert.deepEqual(tt.options.tiktok, { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true });
assert.equal(tt.options.tiktokTitle, "Four angles, one weekend");
assert.equal(ig.options.bot, undefined, "an unnamed bot carries no name");

// Caption limits, server side: 31 hashtags, 21 mentions, 2,201 characters.
created = null;
const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
res = await schedule("car1", { platforms: ["instagram"], accountIds: ["ig1"], scheduledAt: later, caption: tags });
assert.equal(res.statusCode, 400);
assert.match(res.json().detail, /31 hashtags\. Instagram allows 30\. Remove 1 to post\./);
const mentions = Array.from({ length: 21 }, (_, i) => `@u${i}`).join(" ");
res = await schedule("car1", { platforms: ["instagram"], accountIds: ["ig1"], scheduledAt: later, caption: mentions });
assert.match(res.json().detail, /21 mentions/);
res = await schedule("vid1", { platforms: ["instagram"], accountIds: ["ig1"], scheduledAt: later, caption: "x".repeat(2201) });
assert.match(res.json().detail, /2,201 characters\. Instagram allows 2,200/);
// Hashtags sent separately count too.
res = await schedule("vid1", {
  platforms: ["instagram"],
  accountIds: ["ig1"],
  scheduledAt: later,
  caption: Array.from({ length: 25 }, (_, i) => `#a${i}`).join(" "),
  hashtags: Array.from({ length: 6 }, (_, i) => `b${i}`),
});
assert.match(res.json().detail, /31 hashtags/);
assert.equal(created, null, "nothing over a limit was created");

// TikTok: a 3,000 character video caption is refused, the same words on a photo post fit (4,000).
res = await schedule("vid1", { platforms: ["tiktok"], accountIds: ["tt1"], scheduledAt: later, caption: "x".repeat(3000) });
assert.equal(res.statusCode, 400);
assert.match(res.json().detail, /TikTok allows 2,200/);
res = await schedule("car1", { platforms: ["tiktok"], accountIds: ["tt1"], scheduledAt: later, caption: "x".repeat(3000) });
assert.ok(created, res.body);

// TikTok video options are kept now, not only on photo posts.
created = null;
res = await schedule("vid1", {
  platforms: ["tiktok"],
  accountIds: ["tt1"],
  scheduledAt: later,
  tiktok: { privacyLevel: "SELF_ONLY", allowComment: false, allowDuet: false, allowStitch: true },
});
assert.ok(created, res.body);
targets = (created as Created | null)!.data.targets.create;
assert.deepEqual(targets[0]!.options.tiktok, { privacyLevel: "SELF_ONLY", allowComment: false, allowDuet: false, allowStitch: true });
res = await schedule("vid1", { platforms: ["tiktok"], accountIds: ["tt1"], scheduledAt: later, tiktok: { privacyLevel: "FRIENDS" } });
assert.equal(res.statusCode >= 400, true, "an unknown privacy level is refused");

// Polly: her name rides each target so the worker posts with her own key.
created = null;
const polly = sign({ bot: "polly" });
res = await schedule("vid1", { platforms: ["instagram", "tiktok"], accountIds: ["ig1", "tt1"], scheduledAt: later }, polly);
assert.ok(created, res.body);
targets = (created as Created | null)!.data.targets.create;
assert.deepEqual(targets.map((t) => t.options?.bot), ["polly", "polly"]);

// Full access is Polly's alone: an operator-only route (reschedule) answers
// past the auth hook for her, and stays 403 for any other bot.
stub("postTarget", { findFirst: async () => null });
const reschedule = (token: string) =>
  app.inject({
    method: "PATCH",
    url: "/posts/targets/t1/reschedule",
    headers: { authorization: `Bearer ${token}` },
    payload: { scheduledAt: later },
  });
assert.equal((await reschedule(sign())).statusCode, 403);
assert.equal((await reschedule(sign({ bot: "nova" }))).statusCode, 403);
assert.notEqual((await reschedule(polly)).statusCode, 403);

await app.close();
await fs.rm(storage, { recursive: true, force: true });
console.log("composerSchedule.check: all checks passed");
