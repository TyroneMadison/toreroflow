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
