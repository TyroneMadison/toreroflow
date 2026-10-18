/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * Every rule in styles/mobile.css sits inside the one phone media query, so
 * wider windows (and the desktop app) never see a phone style.
 */
declare const process: { cwd(): string };
// @ts-expect-error node's fs is not in this package's browser tsconfig on
// purpose (see motion.check.ts). This file runs under tsx, never in the bundle.
import { readFileSync } from "node:fs";
import { PHONE_MAX, PHONE_QUERY } from "./phone";

const css = (readFileSync(`${process.cwd()}/src/styles/mobile.css`, "utf8") as string).replace(/\/\*[\s\S]*?\*\//g, "");
const queries = css.match(/@media[^{]*/g) ?? [];
if (!queries.length) throw new Error("mobile.css has no media query");
for (const q of queries) {
  if (!q.includes(`max-width:${PHONE_MAX}px`) && !q.includes(`max-width: ${PHONE_MAX}px`))
    throw new Error(`mobile.css query is not the phone breakpoint: ${q.trim()}`);
}
// Nothing outside a query: strip every top-level @media block and expect only whitespace.
let depth = 0;
let outside = "";
for (let i = 0; i < css.length; i++) {
  const ch = css[i]!;
  if (ch === "{") depth++;
  else if (ch === "}") depth--;
  else if (depth === 0) outside += ch;
}
if (outside.replace(/@media[^{]*/g, "").trim()) throw new Error(`mobile.css has rules outside the phone query: ${outside.trim().slice(0, 80)}`);
if (PHONE_QUERY !== `(max-width: ${PHONE_MAX}px)`) throw new Error("PHONE_QUERY drifted from PHONE_MAX");
console.log("phone: all checks passed");
