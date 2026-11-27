// The DM rules the server enforces and the screen explains: Meta's 24h window,
// the HUMAN_AGENT stretch, and which ids can scope a DM campaign.
import assert from "node:assert/strict";
import { dmReplySchema, dmThreadPatchSchema, isPlatformPostId, replyWindow } from "./dm";

const t0 = new Date("2026-11-27T12:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3600_000);

assert.deepEqual(replyWindow(null, t0), { open: false, reason: "never_messaged", endsAt: null });
const open = replyWindow(t0, h(23.9));
assert.equal(open.open && open.tag, null, "inside 24h: a plain reply");
assert.equal(replyWindow(t0, h(24)).open, false, "24h exactly is closed");
assert.equal(replyWindow(t0, h(30)).open, false, "closed without the human agent feature");
const tagged = replyWindow(t0, h(30), true);
assert.equal(tagged.open && tagged.tag, "HUMAN_AGENT", "day 2-7 with the feature: tagged");
assert.equal(replyWindow(t0, h(24 * 7), true).open, false, "7 days is the hard stop");

assert.equal(isPlatformPostId("instagram", "17895695668004550"), true);
assert.equal(isPlatformPostId("instagram", "dQw4w9WgXcQ"), false, "a YouTube id is not an Instagram post");
assert.equal(isPlatformPostId("instagram", "123"), false);
assert.equal(isPlatformPostId("facebook", "104857600000000_987654321012345"), true);
assert.equal(isPlatformPostId("facebook", "dQw4w9WgXcQ"), false);
assert.equal(isPlatformPostId("youtube", "17895695668004550"), false);

assert.equal(dmReplySchema.safeParse({}).success, false, "an empty reply is refused");
assert.equal(dmReplySchema.safeParse({ text: "  " }).success, false, "whitespace is not a reply");
assert.equal(dmReplySchema.safeParse({ media: { type: "image", url: "http://x.test/a.jpg" } }).success, false, "http media refused");
assert.equal(dmReplySchema.safeParse({ text: "hi", media: { type: "image", url: "https://x.test/a.jpg" } }).success, true);
assert.equal(dmThreadPatchSchema.safeParse({ stage: "won", tags: ["vip"] }).success, true);
assert.equal(dmThreadPatchSchema.safeParse({ stage: "bogus" }).success, false);
assert.equal(dmThreadPatchSchema.safeParse({ sneaky: 1 }).success, false, "unknown fields are refused");

console.log("dm.check: all checks passed");
