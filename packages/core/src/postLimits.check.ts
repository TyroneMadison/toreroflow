import assert from "node:assert/strict";
import { checkCaption, captionLimits, mentionCount } from "./postLimits";

// Mentions: handles count, emails do not, dots and underscores stay in a handle.
assert.equal(mentionCount("with @dudthecarguy and @miami.exotics"), 2);
assert.equal(mentionCount("mail me at a@b.com"), 0);
assert.equal(mentionCount("@start then @_x_ and @@double"), 2);

// Instagram: under every limit posts.
{
  const c = checkCaption("instagram", "Full walkaround with @a and @b. #bmw #m3");
  assert.deepEqual(c.problems, []);
  assert.equal(c.hashtags, 2);
  assert.equal(c.mentions, 2);
}

// 31 hashtags is refused with the count to remove, like the mockup.
{
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
  const c = checkCaption("instagram", tags);
  assert.deepEqual(c.problems, ["31 hashtags. Instagram allows 30. Remove 1 to post."]);
}

// 21 mentions and 2,201 characters, both refused.
{
  const mentions = Array.from({ length: 21 }, (_, i) => `@u${i}`).join(" ");
  assert.match(checkCaption("instagram", mentions).problems[0]!, /^21 mentions\. Instagram allows 20\. Remove 1/);
  assert.match(checkCaption("instagram", "x".repeat(2201)).problems[0]!, /^2,201 characters\. Instagram allows 2,200\. Remove 1/);
}

// TikTok: 2,200 for a video, 4,000 for a photo post, no hashtag or mention cap invented.
assert.deepEqual(captionLimits("tiktok"), { chars: 2200, hashtags: null, mentions: null });
assert.equal(captionLimits("tiktok", { photo: true })!.chars, 4000);
assert.equal(checkCaption("tiktok", "x".repeat(3000)).problems.length, 1);
assert.equal(checkCaption("tiktok", "x".repeat(3000), { photo: true }).problems.length, 0);
assert.equal(checkCaption("tiktok", Array.from({ length: 40 }, (_, i) => `#t${i}`).join(" ")).problems.length, 0);

// Platforms with no known limits never block.
assert.equal(captionLimits("snapchat"), null);
assert.deepEqual(checkCaption("snapchat", "x".repeat(9000)).problems, []);

console.log("postLimits ok");
