import assert from "node:assert/strict";
import {
  captionLead,
  competitorBrief,
  digestCompetitor,
  normalizeCompetitorPosts,
} from "./competitors";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * The Instagram fixture uses the field names taken off a real stored
 * snapshot (items[].caption.text, play_count, taken_at, video_duration).
 * The TikTok one uses that provider's own spelling, including milliseconds
 * for duration, because reading those as seconds would report every video as
 * a four hour film and put it top of the list.
 *
 * What is pinned here is what a client's document would be wrong about: the
 * numbers, the units, and the typical rather than the lucky post.
 */

const instagram = {
  more_available: true,
  next_max_id: "abc",
  items: [
    {
      // Instagram returns pinned posts first whatever their date. On the real
      // account this check was written against, the three pinned ones were up
      // to fifteen months old while the rest were from the last three days.
      code: "DPIN",
      taken_at: 1713350400, // 2024-04-17
      play_count: 667_104,
      like_count: 17_869,
      comment_count: 611,
      video_duration: 90,
      timeline_pinned_user_ids: [12345],
      caption: { text: "The one they all remember" },
    },
    {
      code: "DXXYfzbCRpP",
      taken_at: 1776713622, // 2026-04-20
      play_count: 93_162,
      ig_play_count: 93_162,
      like_count: 2051,
      comment_count: 35,
      video_duration: 18.233,
      media_type: 2,
      product_type: "clips",
      caption: { text: "There was a lot of doubters.\n\nI kept at it. #cars #hustle" },
      user: { username: "russflipswhips" },
    },
    {
      code: "DXX2",
      taken_at: 1776886422, // two days later
      play_count: 1_200_000,
      like_count: 40_000,
      comment_count: 900,
      video_duration: 31.5,
      caption: { text: "This one blew up" },
    },
    {
      code: "DXX3",
      taken_at: 1777059222, // two days after that
      play_count: 41_000,
      like_count: 800,
      comment_count: 12,
      video_duration: 22,
      caption: { text: "Normal day at the lot" },
    },
  ],
};

const tiktok = {
  data: {
    aweme_list: [
      {
        aweme_id: "7300",
        desc: "same car, different day",
        create_time: 1776713622,
        video: { duration: 15_000 },
        statistics: { play_count: 220_000, digg_count: 9000, comment_count: 120 },
      },
      {
        aweme_id: "7301",
        desc: "part 2",
        create_time: 1776886422,
        video: { duration: 45_500 },
        statistics: { play_count: 80_000, digg_count: 1200, comment_count: 40 },
      },
    ],
  },
};

/* ---- reading a payload ---- */

const igPosts = normalizeCompetitorPosts(instagram);
assert.equal(igPosts.length, 4, "found the Instagram post list");
assert.equal(igPosts[0]!.pinned, true, "timeline_pinned_user_ids marks a pinned post");
assert.equal(igPosts[1]!.pinned, false);
assert.equal(igPosts[1]!.views, 93_162);
assert.equal(igPosts[1]!.likes, 2051);
assert.equal(igPosts[1]!.comments, 35);
assert.equal(igPosts[1]!.seconds, 18, "Instagram reports float seconds");
assert.equal(igPosts[1]!.postedAt, "2026-04-20");
assert.match(igPosts[1]!.caption, /^There was a lot of doubters\. I kept at it\./);

const ttPosts = normalizeCompetitorPosts(tiktok);
assert.equal(ttPosts.length, 2, "found the TikTok post list nested under data");
assert.equal(ttPosts[0]!.views, 220_000, "TikTok keeps its numbers under statistics");
assert.equal(ttPosts[0]!.seconds, 15, "TikTok reports milliseconds and must be converted");
assert.equal(ttPosts[1]!.seconds, 46);
assert.equal(ttPosts[0]!.caption, "same car, different day");

assert.equal(ttPosts[0]!.pinned, false, "nothing is pinned unless the payload says so");

// A provider that switches its wrapper name must not empty the document.
assert.equal(normalizeCompetitorPosts({ output: { records: instagram.items } }).length, 4);
// Nothing usable is nothing, not a crash.
assert.deepEqual(normalizeCompetitorPosts(null), []);
assert.deepEqual(normalizeCompetitorPosts({ items: [] }), []);
assert.deepEqual(normalizeCompetitorPosts({ items: [{ unrelated: true }] }), []);

/* ---- the digest ---- */

const d = digestCompetitor({ platform: "instagram", handle: "russflipswhips", raw: instagram })!;
assert.ok(d, "a payload with posts digests");
assert.equal(d.postCount, 4);
assert.equal(
  d.medianViews,
  93_162,
  "typical is the median of unpinned posts: neither the 1.2M nor the pinned hit is a normal week",
);
assert.equal(d.bestViews, 1_200_000, "best looks at every post, pinned included");
assert.equal(d.typicalSeconds, 22);
assert.equal(d.newestPostedAt, "2026-04-24", "a two year old pinned post is not their newest");
// Three unpinned posts across five days inclusive is about four a week. The
// pinned post from 2024 must not stretch that span and report one a month.
assert.equal(d.postsPerWeek, 4.2);
assert.equal(d.top[0]!.views, 1_200_000, "best post leads");
assert.ok(d.top.length <= 4);

assert.equal(
  digestCompetitor({ platform: "tiktok", handle: "nobody", raw: { items: [] } }),
  null,
  "an account with nothing pulled is left out rather than shown as zeros",
);

// Twenty posts uploaded the same day is a backlog, not a cadence.
const sameDay = digestCompetitor({
  platform: "instagram",
  handle: "bulk",
  raw: {
    items: Array.from({ length: 20 }, (_, i) => ({
      taken_at: 1776713622 + i,
      play_count: 100,
      caption: { text: "x" },
    })),
  },
})!;
assert.equal(sameDay.postsPerWeek, null, "no cadence claimed from a single day");

/* ---- the brief handed to the model ---- */

const brief = competitorBrief([d]);
assert.match(brief, /@russflipswhips on instagram/);
assert.match(brief, /typical post 93,162 views/);
assert.match(brief, /usually 22s long/);
assert.match(brief, /1,200,000 views/);
assert.equal(competitorBrief([]), "", "no accounts researched means no competitor section");

/* ---- caption openings ---- */

assert.equal(
  captionLead("There was a lot of doubters. I kept at it. #cars #hustle"),
  "There was a lot of doubters. I kept at it.",
  "a wall of hashtags is not a hook",
);
assert.ok(captionLead("word ".repeat(60), 40).length <= 43);
assert.ok(captionLead("word ".repeat(60), 40).endsWith("..."), "a cut caption says it was cut");
assert.equal(captionLead(""), "");

console.log("competitors.check.ts: ok");
