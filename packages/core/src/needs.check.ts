import assert from "node:assert/strict";
import { cleanNeeds, needsLoad } from "./needs";
const n = cleanNeeds([{ type: "people", label: "Needs two people" }, { type: "prop", label: "a mirror" }, { type: "bogus", label: "x" }, { type: "prop", label: "Needs a mirror" }], ["Walk around the car"]);
assert.deepEqual(n.map((x) => x.label), ["Needs two people", "Needs a mirror", "Needs a car"]);
assert.equal(cleanNeeds([], []).length, 0);
assert.equal(cleanNeeds(Array.from({ length: 9 }, (_, i) => ({ type: "prop", label: `Needs thing ${i}` }))).length, 4);
assert.deepEqual(needsLoad(n), { actors: 2, locations: 1, props: 2 });
console.log("needs ok");
