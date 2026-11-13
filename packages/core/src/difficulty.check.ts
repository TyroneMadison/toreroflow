import assert from "node:assert/strict";
import { checkDifficulty, estimateDifficulty } from "./difficulty";
assert.equal(estimateDifficulty("Talking head POV", 1, 1, 1), "easy");
assert.equal(estimateDifficulty("Skits", 4, 2, 1), "hard");
assert.equal(checkDifficulty("hard", "Talking head POV", 1, 1, 1), "medium", "a one shot talking head is never hard");
assert.equal(checkDifficulty("easy", "Skits", 5, 3, 2), "medium", "kept within one step");
assert.equal(checkDifficulty("medium", "Comparison", 3, 1, 1), "medium");
assert.equal(checkDifficulty(undefined, "Ranking", 3, 1, 1), "easy");
console.log("difficulty ok");
