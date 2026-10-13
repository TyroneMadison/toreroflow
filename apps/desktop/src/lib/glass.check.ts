import { clampGlass, refractionScale, GLASS_DEFAULT } from "./glass";
function eq(a: unknown, b: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
eq(clampGlass("0.5"), 0.5, "parses stored strings");
eq(clampGlass(3), 1, "clamps high");
eq(clampGlass(-1), 0, "clamps low");
eq(clampGlass("junk"), GLASS_DEFAULT, "bad value falls back to default");
eq(refractionScale(0), 0, "frosted end has no refraction");
eq(refractionScale(1), 70, "clear end ripples hardest");
console.log("glass: all checks passed");
import { lensAt } from "./refraction";
{
  const [cx, cy] = lensAt(100, 50, 200, 100, 20);
  if (cx !== 0 || Math.abs(cy) > 0.01) throw new Error("centre of a panel is not bent");
  const [lx] = lensAt(1, 50, 200, 100, 20);
  if (!(lx > 0.9)) throw new Error("left rim pulls inward hard");
  const [tx, ty] = lensAt(2, 2, 200, 100, 20);
  if (!(tx > 0 && ty > 0)) throw new Error("top-left corner pulls toward the centre");
  console.log("refraction: all checks passed");
}
