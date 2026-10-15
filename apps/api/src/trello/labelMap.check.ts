/* Runnable check: tsx src/trello/labelMap.check.ts */
import { baseColor, buildLabelMap, clientSlug, resolveCard } from "./labelMap";

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${m}\n  expected ${JSON.stringify(e)}\n  actual   ${JSON.stringify(a)}`);
}

eq(baseColor("black_dark"), "black", "dark variant folds");
eq(baseColor("gray"), "black", "gray means black");
eq(baseColor("gold"), "yellow", "gold means yellow");
eq(baseColor(null), null, "no color");

const clients = [
  { id: "c1", name: "Caleb Closer", slug: null, trelloLabels: [] },
  { id: "c2", name: "Dud Rents", slug: "dudley", trelloLabels: [] },
  { id: "c3", name: "Jacoby", slug: null, trelloLabels: [] },
];
const map = buildLabelMap(clients);
eq(resolveCard(["red"], map), { clientId: "c1", reason: "mapped" }, "red is Caleb");
eq(resolveCard(["black_dark"], map), { clientId: "c2", reason: "mapped" }, "gray-black is Dudley");
eq(resolveCard(["yellow_light"], map), { clientId: "c3", reason: "mapped" }, "gold is Jacoby");
eq(resolveCard([], map).reason, "unlabeled", "no label is held");
eq(resolveCard(["purple"], map).reason, "unmapped", "an unknown color is held");
eq(resolveCard(["red", "yellow"], map).reason, "conflict", "two clients is held");
eq(clientSlug(clients[0]!), "caleb-closer", "slug falls back to the name");

// An explicit color wins over the default and removes that client from defaults.
const custom = buildLabelMap([{ ...clients[0]!, trelloLabels: ["orange"] }, clients[1]!, clients[2]!]);
eq(resolveCard(["orange"], custom).clientId, "c1", "explicit color routes");
eq(resolveCard(["red"], custom).reason, "unmapped", "default dropped once a client sets its own");

console.log("labelMap: all checks passed");
