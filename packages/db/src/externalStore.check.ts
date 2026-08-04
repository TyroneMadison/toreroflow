// Guards the provider-to-store mapping: a wrong field pick here writes a
// wrong lifetime number into every board and report, and a broken day
// bucket would either duplicate history or overwrite yesterday.
import assert from "node:assert/strict";
import { mapProviderEntry, utcDay } from "./externalStore";

/* utcDay: any time of day collapses to that UTC date at midnight. */
{
  const morning = utcDay(new Date("2026-07-28T00:00:01.000Z"));
  const night = utcDay(new Date("2026-07-28T23:59:59.999Z"));
  assert.equal(morning.getTime(), night.getTime());
  assert.equal(morning.toISOString(), "2026-07-28T00:00:00.000Z");
  const nextDay = utcDay(new Date("2026-07-29T00:00:00.000Z"));
  assert.notEqual(morning.getTime(), nextDay.getTime());
}

/* The full mapping: entry analytics preferred, post-level fallback. */
{
  const post = {
    _id: "p1",
    content: "Widebody day 3 \\ud83d\\udd25",
    publishedAt: "2026-05-01T15:00:00.000Z",
    thumbnailUrl: "https://cdn.example/t.jpg",
    platformPostUrl: "https://instagram.com/p/abc",
    analytics: { views: 100, likes: 5, comments: 1, duration: 31.5 },
  };
  const entry = {
    accountId: "za1",
    platform: "instagram",
    platformPostId: "18000000000000001",
    analytics: { views: 250000, likes: 1200, comments: 88 },
  };
  const row = mapProviderEntry(post, entry, {
    socialAccountId: "sa1",
    platform: "instagram",
  });
  assert.ok(row, "a complete entry must map");
  assert.equal(row.socialAccountId, "sa1");
  assert.equal(row.platform, "instagram");
  assert.equal(row.platformVideoId, "18000000000000001");
  assert.equal(row.title, "Widebody day 3 \u{1F525}"); // escapes decoded
  assert.equal(row.views, 250000); // entry views still win over the post total
  assert.equal(row.likes, 1200); // entry likes win too, same rule as views
  assert.equal(row.comments, 88); // entry comments win too, same rule as views
  assert.equal(row.durationSec, 31.5); // duration only exists post-level
  assert.equal(row.thumbnailUrl, "https://cdn.example/t.jpg");
  assert.equal(row.url, "https://instagram.com/p/abc");
  assert.equal(row.publishedAt.toISOString(), "2026-05-01T15:00:00.000Z");
}

/* Post-level analytics used when the entry has none of its own. */
{
  const row = mapProviderEntry(
    {
      content: "clip",
      publishedAt: "2026-06-01T00:00:00.000Z",
      analytics: { views: "4200", likes: 7 },
    },
    { accountId: "za1", platformPostId: "pp2" },
    { socialAccountId: "sa1", platform: "tiktok" },
  );
  assert.ok(row);
  assert.equal(row.views, 4200); // string numbers normalize
  assert.equal(row.likes, 7);
  assert.equal(row.comments, 0); // absent metric is 0, matching the merge
}

/* No entry-level metrics: the post total splits across attributed entries
   for every metric, matching the screen's byPlatform math, so cross-post
   sibling rows sum back to the post total instead of each copying it whole. */
{
  const post = {
    content: "cross-post",
    publishedAt: "2026-06-01T00:00:00.000Z",
    analytics: { views: 1000, likes: 10, comments: 4 },
  };
  const entry = { accountId: "za1", platformPostId: "pp5" };
  const account = { socialAccountId: "sa1", platform: "instagram" as const };

  const split = mapProviderEntry(post, entry, account, 2);
  assert.ok(split);
  assert.equal(split.views, 500); // 1000 split across 2 attributed entries
  assert.equal(split.likes, 5); // 10 split across 2 attributed entries
  assert.equal(split.comments, 2); // 4 split across 2 attributed entries

  const single = mapProviderEntry(post, entry, account, 1);
  assert.ok(single);
  assert.equal(single.views, 1000); // one entry gets the whole post total
  assert.equal(single.likes, 10);
  assert.equal(single.comments, 4);
}

/* An entry with its own views never gets split, no matter entryCount. */
{
  const row = mapProviderEntry(
    {
      content: "cross-post",
      publishedAt: "2026-06-01T00:00:00.000Z",
      analytics: { views: 1000 },
    },
    { accountId: "za1", platformPostId: "pp6", analytics: { views: 777 } },
    { socialAccountId: "sa1", platform: "instagram" },
    3,
  );
  assert.ok(row);
  assert.equal(row.views, 777); // entry's own views win, untouched by the split
}

/* YouTube never persists through this path; the direct sync owns it. */
{
  const row = mapProviderEntry(
    { publishedAt: "2026-06-01T00:00:00.000Z" },
    { accountId: "za2", platformPostId: "yt1" },
    { socialAccountId: "sa2", platform: "youtube" },
  );
  assert.equal(row, null);
}

/* No platform post id, no row: there is nothing to key the upsert on. */
{
  const row = mapProviderEntry(
    { publishedAt: "2026-06-01T00:00:00.000Z" },
    { accountId: "za1" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.equal(row, null);
}

/* Unparseable publish date, no row. */
{
  const row = mapProviderEntry(
    { content: "x" },
    { accountId: "za1", platformPostId: "pp3" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.equal(row, null);
}

/* Blank caption falls back like the merge does. */
{
  const row = mapProviderEntry(
    { content: "   ", publishedAt: "2026-06-01T00:00:00.000Z" },
    { accountId: "za1", platformPostId: "pp4" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.ok(row);
  assert.equal(row.title, "(untitled)");
}

/*
 * Engagement metrics.
 *
 * These were measured on the live account before being added: across 499
 * posts, saves are non-zero on 113, shares on 141, reach on 205, and follows
 * on none at all. The point of pinning them here is that they all follow the
 * same entry-then-split rule as views, so a cross-post cannot report a
 * platform's saves as the whole post's saves.
 */
{
  const row = mapProviderEntry(
    {
      content: "reel",
      publishedAt: "2026-06-01T00:00:00.000Z",
      analytics: { views: 100, likes: 10, comments: 4, shares: 8, saves: 33, reach: 90, follows: 0 },
    },
    { accountId: "za1", platformPostId: "pp10" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.ok(row);
  assert.equal(row.saves, 33, "a save count is carried, not dropped");
  assert.equal(row.shares, 8);
  assert.equal(row.reach, 90);
  assert.equal(row.follows, 0, "a genuine zero is stored as zero, not as missing");
}

/* The entry's own numbers win over the post's when it reports them. */
{
  const row = mapProviderEntry(
    {
      publishedAt: "2026-06-01T00:00:00.000Z",
      analytics: { saves: 100, shares: 100 },
    },
    { accountId: "za1", platformPostId: "pp11", analytics: { saves: 7, shares: 3 } },
    { socialAccountId: "sa1", platform: "instagram" },
    2,
  );
  assert.ok(row);
  assert.equal(row.saves, 7, "the platform's own save count beats a split of the post total");
  assert.equal(row.shares, 3);
}

/* With no per-entry figures, a two-platform post splits evenly, so the
   sibling rows add back up to what the post reported. */
{
  const row = mapProviderEntry(
    {
      publishedAt: "2026-06-01T00:00:00.000Z",
      analytics: { saves: 10, shares: 6, reach: 50 },
    },
    { accountId: "za1", platformPostId: "pp12" },
    { socialAccountId: "sa1", platform: "instagram" },
    2,
  );
  assert.ok(row);
  assert.equal(row.saves, 5, "a cross-post splits saves rather than double counting them");
  assert.equal(row.shares, 3);
  assert.equal(row.reach, 25);
}

/* A post reporting nothing is zero, never NaN or undefined into the column. */
{
  const row = mapProviderEntry(
    { publishedAt: "2026-06-01T00:00:00.000Z" },
    { accountId: "za1", platformPostId: "pp13" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.ok(row);
  assert.equal(row.saves, 0);
  assert.equal(row.reach, 0);
  assert.equal(row.follows, 0);
}

/*
 * mediaType decides whether a post counts on the carousel board or the video
 * boards, and the live account already holds a native Instagram carousel that
 * was being counted as a video before this field existed.
 */
{
  const row = mapProviderEntry(
    {
      content: "carousel",
      publishedAt: "2026-06-01T00:00:00.000Z",
      mediaType: "carousel",
    },
    { accountId: "za1", platformPostId: "pp20" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.ok(row);
  assert.equal(row.mediaType, "carousel", "a carousel is stored as one");
}
{
  const row = mapProviderEntry(
    { content: "plain", publishedAt: "2026-06-01T00:00:00.000Z" },
    { accountId: "za1", platformPostId: "pp21" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.ok(row);
  assert.equal(row.mediaType, "video", "a post that says nothing is a video, the overwhelming case");
}

console.log("externalStore.check: all checks passed");
