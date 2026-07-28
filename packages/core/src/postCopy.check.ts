// Guards the per-platform copy rules. These decide what actually gets
// published, so a wrong pick here posts the wrong words to a client's
// audience, silently and irreversibly.
import assert from "node:assert/strict";
import { captionFor, youtubeTitleFor } from "./postCopy";

const full = {
  name: "ZR1X first drive",
  description: "We take the ZR1X out for the first time.",
  youtubeTitle: "ZR1X FIRST DRIVE (it moves)",
  youtubeDescription: "Full walkaround and first impressions.",
};

/* Every caption platform posts the description, never the name or a title. */
for (const p of ["instagram", "tiktok", "facebook", "snapchat"]) {
  assert.equal(captionFor(p, full), "We take the ZR1X out for the first time.", p);
}

/* YouTube gets its own description, and its own title. */
assert.equal(captionFor("youtube", full), "Full walkaround and first impressions.");
assert.equal(youtubeTitleFor(full), "ZR1X FIRST DRIVE (it moves)");

/* A blank description falls back to the name on the caption platforms. */
assert.equal(captionFor("instagram", { name: "Just the name" }), "Just the name");

/* YouTube's description falls back to the card description, then the name. */
assert.equal(
  captionFor("youtube", { name: "n", description: "card copy" }),
  "card copy",
);
assert.equal(captionFor("youtube", { name: "n" }), "n");

/* YouTube's title falls back to the name, and is empty when nothing exists. */
assert.equal(youtubeTitleFor({ name: "n" }), "n");
assert.equal(youtubeTitleFor({ description: "d" }), "");
assert.equal(youtubeTitleFor({}), "");

/* Whitespace is not content. */
assert.equal(captionFor("tiktok", { name: "n", description: "   " }), "n");
assert.equal(youtubeTitleFor({ youtubeTitle: "\n\t ", name: "n" }), "n");

/* Everything blank yields empty, never the string "undefined". */
assert.equal(captionFor("instagram", {}), "");
assert.equal(captionFor("youtube", {}), "");

/* Values are trimmed on the way out. */
assert.equal(captionFor("instagram", { description: "  spaced  " }), "spaced");

console.log("post copy: all checks passed");
