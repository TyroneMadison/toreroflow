import assert from "node:assert/strict";
import { resolveProvider } from "./provider";

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

ok("auto with a key uses anthropic", () => assert.equal(resolveProvider("auto", "k").provider, "anthropic"));
ok("auto without a key is heuristic", () => assert.deepEqual(resolveProvider("auto", ""), { provider: "heuristic" }));
ok("empty setting means auto", () => assert.equal(resolveProvider("", "k").provider, "anthropic"));
ok("heuristic forced even with a key", () => assert.equal(resolveProvider("heuristic", "k").provider, "heuristic"));
ok("anthropic without key falls back with a note", () => {
  const r = resolveProvider("anthropic", "");
  assert.equal(r.provider, "heuristic");
  assert.match(r.note ?? "", /no ANTHROPIC_API_KEY/);
});
ok("sunra is not a text provider", () => {
  const r = resolveProvider("sunra", "k");
  assert.equal(r.provider, "heuristic");
  assert.match(r.note ?? "", /Sunra has no text model/);
});
ok("case-insensitive", () => assert.equal(resolveProvider("HEURISTIC", "k").provider, "heuristic"));

console.log(`provider.check: ${passed} passed`);
