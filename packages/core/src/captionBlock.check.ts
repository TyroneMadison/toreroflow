import assert from "node:assert/strict";
import { composeCaption, keywordLineFor, readCaptionKeywords } from "./captionBlock";

const block = "Hey, if we haven’t met, I’m Caleb!\n\nI run CACV Motors.\n\nMr. Caleb | CACV Motors\n@cacvmotors";
const caleb = { captionBlock: block, captionBlockOn: true, captionKeywords: [] };

/* Block goes directly under, no blank line, internal breaks kept. */
assert.equal(composeCaption({ caption: "Z06 delivered 🏁" }, caleb), "Z06 delivered 🏁\n" + block);
/* CRLF and surrounding blank space in the stored block are normalised. */
assert.equal(composeCaption({ caption: "A" }, { captionBlock: "\r\nX\r\n\r\nY\r\n\r\n" }), "A\nX\n\nY");
/* Per-post toggle and client default off skip it. */
assert.equal(composeCaption({ caption: "A", useBlock: false }, caleb), "A");
assert.equal(composeCaption({ caption: "A" }, { ...caleb, captionBlockOn: false }), "A");
/* No block, no keywords: unchanged. */
assert.equal(composeCaption({ caption: "A" }, {}), "A");
/* Already composed text is not doubled. */
assert.equal(composeCaption({ caption: "A\n" + block }, caleb), "A\n" + block);

const dudley = {
  captionKeywords: [
    { keywords: ["BMW", "GLE"], line: "another successful transaction ✅" },
    { keywords: ["Audi"], line: "another successful Audi rental transaction" },
  ],
};
assert.equal(composeCaption({ caption: "Keys handed over", title: "bmw 5 series rental" }, dudley), "Keys handed over\nanother successful transaction ✅");
assert.equal(composeCaption({ caption: "Done", cardName: "Audi Q8 $300" }, dudley), "Done\nanother successful Audi rental transaction");
assert.equal(composeCaption({ caption: "New gle in" }, dudley), "New gle in\nanother successful transaction ✅");
assert.equal(composeCaption({ caption: "Nothing here", title: "Tesla" }, dudley), "Nothing here");
/* Whole word only: "audience" is not Audi. */
assert.equal(keywordLineFor(readCaptionKeywords(dudley.captionKeywords), ["great audience"]), null);
/* Keyword line then block, each on the next line. */
assert.equal(composeCaption({ caption: "C", title: "BMW" }, { ...dudley, captionBlock: "B1\n\nB2" }), "C\nanother successful transaction ✅\nB1\n\nB2");
/* Malformed stored keywords are ignored. */
assert.deepEqual(readCaptionKeywords([{ nope: 1 }]), []);
console.log("captionBlock ok");
