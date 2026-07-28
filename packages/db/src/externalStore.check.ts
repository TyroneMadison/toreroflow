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
  assert.equal(row.views, 250000); // entry analytics win over post analytics
  assert.equal(row.likes, 1200);
  assert.equal(row.comments, 88);
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

console.log("externalStore.check: all checks passed");
