// Composer, post details, TikTok and comments through Zernio, with fetch
// mocked: the exact request each produces. No network.
import assert from "node:assert/strict";
import { buildPostExtras } from "./options";
import { botZernioKey, ZernioProvider } from "./zernio";

type Call = { url: string; method: string; body: unknown; auth: string | null };
function mockFetch(status: number, json: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization ?? null,
    });
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

// An Instagram carousel (or single image) takes collaborators, a location and
// people tags on the first item, centred because photo tags need a spot.
{
  const x = buildPostExtras({
    platform: "instagram",
    format: null,
    coverUrl: null,
    carousel: true,
    instagram: {
      collaborators: ["dudthecarguy", " ", "a", "b", "c"],
      locationId: "105890561436614",
      userTags: ["@jlo_drives"],
      trial: true,
      shareToFeed: false,
      audioName: "nope",
    },
  });
  assert.deepEqual(x.platformSpecificData, {
    collaborators: ["dudthecarguy", "a", "b"],
    locationId: "105890561436614",
    userTags: [{ username: "jlo_drives", x: 0.5, y: 0.5, mediaIndex: 0 }],
  });
}

// A reel still gets the reel-only details: trial with its graduation, audio name, feed.
{
  const x = buildPostExtras({
    platform: "instagram",
    format: "short_form",
    durationSec: 30,
    coverUrl: null,
    instagram: { trial: true, graduationStrategy: "SS_PERFORMANCE", audioName: "Dud Rents original audio", shareToFeed: false, userTags: ["caleb.films"], locationId: "1" },
  });
  assert.deepEqual(x.platformSpecificData, {
    contentType: "reels",
    trialParams: { graduationStrategy: "SS_PERFORMANCE" },
    audioName: "Dud Rents original audio",
    shareToFeed: false,
    locationId: "1",
    userTags: [{ username: "caleb.films" }],
  });
}

// TikTok video: privacy, comments, duet, stitch; a picked frame as its offset.
{
  const x = buildPostExtras({
    platform: "tiktok",
    format: "short_form",
    coverUrl: null,
    coverOffsetMs: 2500,
    tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: false, allowStitch: true },
  });
  assert.deepEqual(x.tiktokSettings, {
    privacy_level: "PUBLIC_TO_EVERYONE",
    allow_comment: true,
    allow_duet: false,
    allow_stitch: true,
    video_cover_timestamp_ms: 2500,
  });
  // An uploaded image wins over the frame.
  const img = buildPostExtras({ platform: "tiktok", format: "short_form", coverUrl: "https://x/c.jpg", coverOffsetMs: 2500 });
  assert.deepEqual(img.tiktokSettings, { video_cover_image_url: "https://x/c.jpg" });
}

// TikTok photo post: privacy and comments only, never duet or stitch.
{
  const x = buildPostExtras({
    platform: "tiktok",
    format: null,
    coverUrl: null,
    carousel: true,
    caption: "four angles",
    tiktok: { privacyLevel: "SELF_ONLY", allowComment: false, allowDuet: true, allowStitch: true },
  });
  assert.deepEqual(x.tiktokSettings, {
    media_type: "photo",
    content_preview_confirmed: true,
    express_consent_given: true,
    description: "four angles",
    privacy_level: "SELF_ONLY",
    allow_comment: false,
  });
}

// A bot's own key: ZERNIO_API_KEY_<BOT>, nothing for odd names or unset keys.
{
  const envs = { ZERNIO_API_KEY_POLLY: "sk_polly", ZERNIO_API_KEY_OTHER_BOT: "sk_o" };
  assert.equal(botZernioKey("polly", envs), "sk_polly");
  assert.equal(botZernioKey("Polly", envs), "sk_polly");
  assert.equal(botZernioKey("other-bot", envs), "sk_o");
  assert.equal(botZernioKey("nova", envs), null);
  assert.equal(botZernioKey("../x", envs), null);
  assert.equal(botZernioKey(null, envs), null);
}

// Comments: list, read, reply, delete, hide, unhide, each the documented call.
{
  let calls = mockFetch(200, {
    data: [{ id: "p1", platform: "instagram", accountId: "a1", accountUsername: "dudrents", content: "Track day", commentCount: 3 }],
  });
  const z = new ZernioProvider("sk_polly");
  const posts = await z.commentedPosts("prof1", { platform: "instagram" });
  assert.equal(calls[0]!.url, "https://zernio.com/api/v1/inbox/comments?profileId=prof1&limit=50&platform=instagram");
  assert.equal(calls[0]!.auth, "Bearer sk_polly");
  assert.equal(posts[0]!.commentCount, 3);
  assert.equal(posts[0]!.accountUsername, "dudrents");

  calls = mockFetch(200, {
    comments: [
      { id: "c1", message: "How much for a weekend?", from: { username: "miami.cars" }, canReply: true, canDelete: true, canHide: true, replies: [{ id: "r1", message: "DM us", from: { username: "dudrents", isOwner: true } }] },
    ],
  });
  const comments = await z.postComments("p1", "a1");
  assert.equal(calls[0]!.url, "https://zernio.com/api/v1/inbox/comments/p1?accountId=a1&limit=50");
  assert.equal(comments[0]!.username, "miami.cars");
  assert.equal(comments[0]!.canHide, true);
  assert.equal(comments[0]!.replies[0]!.isOwner, true);

  calls = mockFetch(200, { success: true, data: { commentId: "c9" } });
  assert.deepEqual(await z.replyToComment("p1", { accountId: "a1", message: "$300", commentId: "c1" }), { commentId: "c9" });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "https://zernio.com/api/v1/inbox/comments/p1");
  assert.deepEqual(calls[0]!.body, { accountId: "a1", message: "$300", commentId: "c1" });

  calls = mockFetch(200, { success: true });
  await z.deleteComment("p1", "a1", "c1");
  assert.equal(calls[0]!.method, "DELETE");
  assert.equal(calls[0]!.url, "https://zernio.com/api/v1/inbox/comments/p1?accountId=a1&commentId=c1");

  calls = mockFetch(200, { hidden: true });
  await z.setCommentHidden("p1", "c1", "a1", true);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "https://zernio.com/api/v1/inbox/comments/p1/c1/hide");
  assert.deepEqual(calls[0]!.body, { accountId: "a1" });
  await z.setCommentHidden("p1", "c1", "a1", false);
  assert.equal(calls[1]!.method, "DELETE");
  assert.equal(calls[1]!.url, "https://zernio.com/api/v1/inbox/comments/p1/c1/hide?accountId=a1");
}

console.log("composer, tiktok and comments checks passed");
