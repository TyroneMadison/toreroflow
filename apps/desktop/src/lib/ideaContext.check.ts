const assert = {
  equal(a: unknown, b: unknown) {
    if (a !== b) throw new Error(`expected ${String(b)}, got ${String(a)}`);
  },
  deepEqual(a: unknown, b: unknown) {
    this.equal(JSON.stringify(a), JSON.stringify(b));
  },
};
import { addCreators, parseContext, stepIndex, CREATOR_CAP } from "./ideaContext";

assert.deepEqual(addCreators([], " @@mkbhd, Doug DeMuro ,"), ["@mkbhd", "Doug DeMuro"]);
assert.deepEqual(addCreators(["@mkbhd"], "@MKBHD"), ["@mkbhd"]);
assert.equal(addCreators([], Array.from({ length: 20 }, (_, i) => `c${i}`).join(",")).length, CREATOR_CAP);
assert.deepEqual(parseContext(null), { niche: "", creators: [] });
assert.deepEqual(parseContext("{bad"), { niche: "", creators: [] });
assert.deepEqual(parseContext('{"niche":"Cars","creators":["a","a",3]}'), { niche: "Cars", creators: ["a"] });
assert.equal(stepIndex(0, -1, 3), 0);
assert.equal(stepIndex(2, 1, 3), 2);
assert.equal(stepIndex(1, 1, 3), 2);
assert.equal(stepIndex(5, 1, 0), 0);
console.log("ideaContext ok");
