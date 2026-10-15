import assert from "node:assert/strict";
import { cleanCreatorLinks, costCents, parseCreatorLink } from "./creatorLinks";

assert.deepEqual(parseCreatorLink("https://www.youtube.com/@CarDealershipGuy/videos"), {
  url: "youtube.com/@cardealershipguy",
  platform: "youtube",
  handle: "@CarDealershipGuy",
});
assert.equal(parseCreatorLink("youtube.com/channel/UC123")?.handle, "UC123");
assert.equal(parseCreatorLink("@demo")?.platform, "youtube");
assert.equal(parseCreatorLink("instagram.com/hoovies.garage")?.handle, "@hoovies.garage");
assert.equal(parseCreatorLink("https://tiktok.com/@DealerDan")?.url, "tiktok.com/@dealerdan");
assert.equal(parseCreatorLink("youtube.com/watch?v=x"), null);
assert.equal(parseCreatorLink("   "), null);
assert.deepEqual(
  cleanCreatorLinks(["youtube.com/@a", " https://youtube.com/@A ", "", "tiktok.com/@b"]),
  ["youtube.com/@a", "tiktok.com/@b"],
);
assert.equal(cleanCreatorLinks(Array.from({ length: 14 }, (_, i) => `youtube.com/@c${i}`)).length, 10);
assert.equal(costCents(0, 0), 0);
assert.equal(costCents(1_000_000, 0), 1500);
console.log("creatorLinks ok");
