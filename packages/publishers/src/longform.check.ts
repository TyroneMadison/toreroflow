// Long-form through Zernio with fetch mocked: the "Both" request shape, a 207
// partial publish, and the Instagram publishing limit. No network.
import assert from "node:assert/strict";
import { buildPostExtras, combinePostParts } from "./options";
import { ZernioProvider } from "./zernio";

type Call = { url: string; method: string; body: unknown };
function mockFetch(status: number, json: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const yt = {
  platform: "youtube" as const,
  accountId: "acc-yt",
  caption: "Full track day. Chapters below.",
  mediaUrl: "https://cdn.zernio/master.mp4",
  extras: buildPostExtras({
    platform: "youtube",
    format: "long_form",
    coverUrl: "https://cdn.zernio/cover.jpg",
    coverOffsetMs: 4200,
    youtubeTitle: "Track day in the M3",
  }),
};
const ig = {
  platform: "instagram" as const,
  accountId: "acc-ig",
  caption: "Track day in the M3 #m3",
  mediaUrl: "https://cdn.zernio/ig-crop916.mp4",
  extras: buildPostExtras({
    platform: "instagram",
    format: "long_form",
    durationSec: 842,
    coverUrl: "https://cdn.zernio/cover.jpg",
    coverOffsetMs: 4200,
    instagram: { longform: true, shareToFeed: true },
  }),
};

// Instagram listed first still comes out with YouTube leading.
const combined = combinePostParts([ig, yt]);
assert.equal(combined.content, yt.caption);
assert.equal(combined.mediaUrl, yt.mediaUrl);
assert.equal(combined.mediaThumbnail, "https://cdn.zernio/cover.jpg");

{
  const calls = mockFetch(207, {
    post: { _id: "post-1", status: "partial" },
    platformResults: [
      { platform: "youtube", status: "published", error: null },
      { platform: "instagram", status: "failed", error: "Media upload failed" },
    ],
  });
  const zernio = new ZernioProvider("k");
  const out = await zernio.createPost({ ...combined, publishNow: true });
  assert.equal(out.remotePostId, "post-1");
  assert.deepEqual(out.platformResults?.[1], { platform: "instagram", status: "failed", error: "Media upload failed" });

  // One POST /posts carrying both platforms.
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v1\/posts$/);
  const body = calls[0]!.body as Record<string, any>;
  assert.equal(body.content, yt.caption);
  assert.deepEqual(body.mediaItems, [
    { url: "https://cdn.zernio/master.mp4", type: "video", thumbnail: "https://cdn.zernio/cover.jpg" },
  ]);
  assert.deepEqual(body.platforms, [
    { platform: "youtube", accountId: "acc-yt", platformSpecificData: { title: "Track day in the M3" } },
    {
      platform: "instagram",
      accountId: "acc-ig",
      customContent: "Track day in the M3 #m3",
      customMedia: [{ url: "https://cdn.zernio/ig-crop916.mp4", type: "video" }],
      platformSpecificData: { thumbOffset: 4200, shareToFeed: true },
    },
  ]);
}

// A plain 201 has no platformResults.
{
  mockFetch(201, { post: { _id: "post-2" } });
  const out = await new ZernioProvider("k").createPost({ content: "x", mediaUrl: "https://a/b.mp4", targets: [{ platform: "youtube", accountId: "a" }] });
  assert.deepEqual(out, { remotePostId: "post-2" });
}

// Publishing limit reads the live numbers.
{
  const calls = mockFetch(200, { quotaUsage: 97, quotaTotal: 100, quotaDurationSeconds: 86400 });
  assert.deepEqual(await new ZernioProvider("k").instagramPublishingLimit("acc ig"), { used: 97, total: 100, windowSeconds: 86400 });
  assert.match(calls[0]!.url, /\/v1\/accounts\/acc%20ig\/instagram\/publishing-limit$/);
}

// Large files go through presign, then a PUT with no auth header.
{
  const calls = mockFetch(200, { uploadUrl: "https://put.example/u", publicUrl: "https://cdn.zernio/f.mp4" });
  const z = new ZernioProvider("k");
  assert.deepEqual(await z.presignMedia("ig-fit.mp4", "video/mp4"), { uploadUrl: "https://put.example/u", publicUrl: "https://cdn.zernio/f.mp4" });
  assert.deepEqual(calls[0]!.body, { filename: "ig-fit.mp4", contentType: "video/mp4" });
}

console.log("longform zernio checks passed");
