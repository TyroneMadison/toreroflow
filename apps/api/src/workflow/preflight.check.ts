// W2 preflight: every rule on its own, the whole run, then the routes through
// the real auth hook with the database stubbed. The override needs the
// operator or Polly and a reason, and logs who and when.
import assert from "node:assert/strict";
import {
  brandKitRule,
  captionRule,
  coverRule,
  lengthRule,
  PREFLIGHT_LIMITS,
  runPreflight,
  tagsRule,
  titleRule,
  type PreflightTarget,
} from "./preflight";

const ctx = { draftId: "d1", targets: [], limits: PREFLIGHT_LIMITS };
const ig = (extra: Partial<PreflightTarget> = {}): PreflightTarget => ({ platform: "instagram", caption: "hi", cover: "c.jpg", ...extra });
const codes = (fs: { issue: { code: string } }[]) => fs.map((f) => f.issue.code);

// Cover.
assert.deepEqual(codes(coverRule(ig({ cover: null }), ctx)), ["cover_missing"]);
assert.equal(coverRule(ig({ cover: null }), ctx)[0]!.level, "blocking");
assert.equal(coverRule(ig({ cover: null }), ctx)[0]!.issue.fixRoute, "/create/d1#instagram.cover");
assert.deepEqual(coverRule(ig(), ctx), []);

// Video length, per platform, and per account when the limits say so.
assert.deepEqual(lengthRule(ig({ videoSeconds: 900 }), ctx), [], "15:00 is Instagram's limit, not over it");
assert.deepEqual(codes(lengthRule(ig({ videoSeconds: 901 }), ctx)), ["video_too_long"]);
const tenMinTikTok = { ...ctx, limits: { ...PREFLIGHT_LIMITS, maxVideoSeconds: { ...PREFLIGHT_LIMITS.maxVideoSeconds, tiktok: 600 } } };
const long = lengthRule({ platform: "tiktok", caption: "", cover: "c", videoSeconds: 768 }, tenMinTikTok);
assert.equal(long[0]!.issue.message, "video is 12:48, limit is 10:00");
assert.equal(long[0]!.issue.fixRoute, "/create/d1#tiktok.cutId");
assert.deepEqual(lengthRule({ platform: "tiktok", caption: "", videoSeconds: 768 }, ctx), [], "60 minutes by default");
assert.deepEqual(lengthRule(ig({ videoSeconds: null }), ctx), [], "unknown length is not checked");
const unchecked = { ...ctx, limits: { ...PREFLIGHT_LIMITS, maxVideoSeconds: { youtube: null, instagram: null, tiktok: null } } };
assert.deepEqual(lengthRule(ig({ videoSeconds: 99999 }), unchecked), [], "null limit is not checked");

// Caption characters: IG 2,200, TikTok 2,200, YouTube description 5,000.
assert.deepEqual(captionRule(ig({ caption: "a".repeat(2200) }), ctx), []);
assert.deepEqual(codes(captionRule(ig({ caption: "a".repeat(2201) }), ctx)), ["caption_too_long"]);
assert.deepEqual(codes(captionRule({ platform: "tiktok", caption: "a".repeat(2201) }, ctx)), ["caption_too_long"]);
assert.deepEqual(captionRule({ platform: "youtube", caption: "a".repeat(5000) }, ctx), []);
assert.deepEqual(codes(captionRule({ platform: "youtube", caption: "a".repeat(5001) }, ctx)), ["caption_too_long"]);

// Hashtags (30) and mentions (20) on Instagram only.
const tags = (k: number) => Array.from({ length: k }, (_, i) => `#t${i}`).join(" ");
const ats = (k: number) => Array.from({ length: k }, (_, i) => `@u${i}`).join(" ");
assert.deepEqual(tagsRule(ig({ caption: tags(30) }), ctx), []);
const over = tagsRule(ig({ caption: tags(31) }), ctx);
assert.deepEqual(codes(over), ["too_many_hashtags"]);
assert.equal(over[0]!.issue.message, "31 hashtags, limit 30");
assert.deepEqual(tagsRule(ig({ caption: ats(20) }), ctx), []);
assert.deepEqual(codes(tagsRule(ig({ caption: ats(21) }), ctx)), ["too_many_mentions"]);
assert.deepEqual(tagsRule(ig({ caption: "mail me at a@b.com" }), ctx), [], "an email is not a mention");
assert.deepEqual(tagsRule({ platform: "tiktok", caption: tags(40) }, ctx), [], "TikTok has no hashtag cap");

// YouTube title: missing and too long block, otherwise a pass.
const yt = (title: string | null) => ({ platform: "youtube" as const, caption: "", title });
assert.deepEqual(codes(titleRule(yt(null), ctx)), ["title_missing"]);
assert.deepEqual(codes(titleRule(yt("a".repeat(101)), ctx)), ["title_too_long"]);
const pass = titleRule(yt("a".repeat(54)), ctx);
assert.equal(pass[0]!.level, "ok");
assert.equal(pass[0]!.issue.message, "title 54 of 100 characters");
assert.deepEqual(titleRule(ig(), ctx), [], "only YouTube has a title");

// Brand kit: warnings only, and only when a kit and a design exist.
const kit = { fonts: [{ family: "Inter" }], colors: ["#112233"], logoAssetId: "logo1" };
const design = { fonts: ["inter", "Comic Sans"], colors: ["#112233", "#FF0000"], logoAssetId: "logo2" };
const brand = brandKitRule(yt("t"), { ...ctx, kit, design });
assert.deepEqual(codes(brand), ["font_off_brand", "color_off_brand", "logo_off_brand"]);
assert.ok(brand.every((f) => f.level === "warning"));
assert.match(brand[0]!.issue.message, /Comic Sans/);
assert.doesNotMatch(brand[0]!.issue.message, /inter/, "font names compare case-insensitively");
assert.deepEqual(brandKitRule(yt("t"), { ...ctx, kit, design: { fonts: ["Inter"], colors: ["#112233"], logoAssetId: "logo1" } }), []);
assert.deepEqual(brandKitRule(yt("t"), { ...ctx, kit: null, design }), [], "no kit, no check");
assert.deepEqual(brandKitRule(yt("t"), { ...ctx, kit, design: null }), [], "no design, no check");

// The whole run sorts every target's findings into the three lists.
const result = runPreflight({
  draftId: "d1",
  targets: [ig({ cover: null, caption: tags(31) }), { platform: "youtube", caption: "", title: "Good", cover: "c" }],
});
assert.deepEqual(result.blocking.map((i) => `${i.platform}:${i.code}`), ["instagram:cover_missing", "instagram:too_many_hashtags"]);
assert.deepEqual(result.warnings, []);
assert.deepEqual(result.ok.map((i) => i.code), ["title_ok"]);

// ---- Routes ----
const { default: Fastify } = await import("fastify");
const { default: jwt } = await import("@fastify/jwt");
const { getPrisma } = await import("@toreroflow/db");
const { preflightRoutes } = await import("../routes/preflight");

const POST = {
  id: "post1",
  mediaAsset: { kind: "video", durationSec: 30, coverKey: null, coverOffsetMs: null, storageKey: "v.mp4" },
  targets: [
    { platform: "instagram", caption: "Hello", hashtags: tags(31).split(" "), options: null, overrides: {} },
    { platform: "youtube", caption: "Desc", hashtags: [], options: { youtubeTitle: "Old title" }, overrides: { title: "New title", cover: "yt.jpg" } },
    { platform: "instagram", caption: null, hashtags: [], options: { instagram: { story: true } }, overrides: {} },
  ],
};
const logged: Record<string, unknown>[] = [];
const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("post", {
  findFirst: async ({ where }: { where: { id: string; client: { agencyId: string } } }) =>
    where.id === "post1" && where.client.agencyId === "agencyA" ? POST : null,
});
stub("user", { findFirst: async () => ({ id: "owner1" }) });
const clients = [{ id: "c1", agencyId: "agencyA" }, { id: "c2", agencyId: "agencyB" }];
stub("client", {
  findFirst: async ({ where }: { where: { id: string; agencyId: string } }) =>
    clients.find((c) => c.id === where.id && c.agencyId === where.agencyId) ?? null,
});
stub("botIdentity", { findUnique: async () => null });
stub("preflightOverride", {
  create: async ({ data }: { data: Record<string, unknown> }) => {
    logged.push(data);
    return { id: `ov${logged.length}`, ...data, createdAt: new Date("2026-10-26T12:00:00Z") };
  },
});

const app = Fastify();
await app.register(jwt, { secret: "preflight-check" });
await app.register(preflightRoutes);
const token = (extra: object = {}) => app.jwt.sign({ sub: "owner1", agencyId: "agencyA", ...extra });
const operator = token();
const polly = token({ role: "bot", bot: "polly" });
const nova = token({ role: "bot", bot: "nova" });
const post = (url: string, payload: object, t = operator) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${t}` }, payload });

let res = await post("/preflight", { draftId: "post1" });
assert.equal(res.statusCode, 200, res.body);
let body = res.json();
assert.deepEqual(
  body.blocking.map((i: { platform: string; code: string }) => `${i.platform}:${i.code}`),
  ["instagram:cover_missing", "instagram:too_many_hashtags"],
  "hashtags count with the caption; the YouTube cover override counts; the story is skipped",
);
assert.equal(body.ok[0].message, "title 9 of 100 characters", "the title override wins");

res = await post("/preflight", {
  draftId: "post1",
  design: { fonts: ["Papyrus"], colors: [] },
  brandKit: { fonts: [{ family: "Inter" }], colors: [], logoAssetId: null },
});
assert.deepEqual(res.json().warnings.map((i: { code: string }) => i.code), ["font_off_brand", "font_off_brand"]);

assert.equal((await post("/preflight", { draftId: "nope" })).statusCode, 404);
assert.equal((await post("/preflight", { draftId: "post1" }, nova)).statusCode, 403, "other bots keep their scope");
assert.equal((await post("/preflight", { draftId: "post1" }, polly)).statusCode, 200);

// An unsaved draft, inline: same rules, nothing saved, fix routes point at the new draft.
const INLINE = {
  brandId: "c1",
  caption: `Hello ${tags(31)}`,
  title: "Draft title",
  postAt: "2026-11-02T23:00:00.000Z",
  cover: "draft.jpg",
  videoSeconds: 20 * 60,
  targets: [
    { platform: "instagram", overrides: {} },
    { platform: "youtube", overrides: { caption: "Desc", title: "YT title" } },
    { platform: "tiktok", overrides: { caption: "Short" } },
  ],
};
res = await post("/preflight", { draft: INLINE });
assert.equal(res.statusCode, 200, res.body);
body = res.json();
assert.deepEqual(
  body.blocking.map((i: { platform: string; code: string }) => `${i.platform}:${i.code}`),
  ["instagram:video_too_long", "instagram:too_many_hashtags"],
  "the draft cover counts for every target; 20 minutes is over Instagram's 15",
);
assert.equal(body.blocking[0].fixRoute, "/create/new#instagram.cutId");
assert.equal(body.ok.find((i: { code: string }) => i.code === "title_ok").message, "title 8 of 100 characters", "the title override wins");
res = await post("/preflight", { draft: { ...INLINE, kind: "carousel", cover: undefined, caption: "Hi" } });
assert.deepEqual(
  res.json().blocking.map((i: { platform: string; code: string }) => `${i.platform}:${i.code}`),
  ["instagram:cover_missing", "youtube:cover_missing", "tiktok:cover_missing"],
  "no cover anywhere; a carousel has no video length",
);
res = await post("/preflight", {
  draft: { ...INLINE, targets: [{ platform: "youtube", overrides: { cover: "yt.jpg" } }] },
  design: { fonts: ["Papyrus"], colors: [] },
  brandKit: { fonts: [{ family: "Inter" }], colors: [], logoAssetId: null },
});
assert.deepEqual(res.json().warnings.map((i: { code: string }) => i.code), ["font_off_brand"], "design and brandKit still apply");

// Exactly one of draftId or draft.
assert.equal((await post("/preflight", {})).statusCode, 400, "neither");
assert.equal((await post("/preflight", { draftId: "post1", draft: INLINE })).statusCode, 400, "both");
assert.equal((await post("/preflight", { draft: { ...INLINE, targets: [{ platform: "snapchat", overrides: {} }] } })).statusCode, 400);
// The brand must be in the caller's agency.
assert.equal((await post("/preflight", { draft: { ...INLINE, brandId: "c2" } })).statusCode, 404, "a brand of another agency");
assert.equal((await post("/preflight", { draft: { ...INLINE, brandId: "nope" } })).statusCode, 404);
// Same auth as a saved draft.
assert.equal((await post("/preflight", { draft: INLINE }, polly)).statusCode, 200);
assert.equal((await post("/preflight", { draft: INLINE }, nova)).statusCode, 403, "other bots keep their scope");

// Override: a reason is required.
assert.equal((await post("/drafts/post1/override", {})).statusCode, 400);
assert.equal((await post("/drafts/post1/override", { reason: "  " })).statusCode, 400);
assert.equal(logged.length, 0);

// The operator: logged with the user and time.
res = await post("/drafts/post1/override", { reason: "client approved the long cut" });
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json(), {
  id: "ov1",
  draftId: "post1",
  reason: "client approved the long cut",
  actor: { kind: "operator", userId: "owner1" },
  at: "2026-10-26T12:00:00.000Z",
});
assert.deepEqual(logged[0], { postId: "post1", reason: "client approved the long cut", actorKind: "operator", actorId: "owner1" });

// Polly: logged as the bot.
res = await post("/drafts/post1/override", { reason: "cover lands after upload" }, polly);
assert.equal(res.statusCode, 200, res.body);
assert.deepEqual(res.json().actor, { kind: "bot", bot: "polly" });
assert.deepEqual(logged[1], { postId: "post1", reason: "cover lands after upload", actorKind: "bot", actorId: "polly" });

// Any other bot, and a viewer, are refused.
assert.equal((await post("/drafts/post1/override", { reason: "please" }, nova)).statusCode, 403);
assert.equal((await post("/drafts/post1/override", { reason: "please" }, token({ role: "viewer" }))).statusCode, 403);
assert.equal((await post("/drafts/nope/override", { reason: "please" })).statusCode, 404);
assert.equal(logged.length, 2);

await app.close();
console.log("preflight.check: all checks passed");
