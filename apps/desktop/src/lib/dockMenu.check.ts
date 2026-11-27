/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * The Dock's drop-up menus: their pages, the hover timings (and that
 * styles/dock.css uses the same ones), reduced motion, the phone keeping its
 * own nav, the aim check, fitting a 360px window, and the last page per tab.
 */
declare const process: { cwd(): string };
// @ts-expect-error node's fs is not in this package's browser tsconfig on
// purpose (see motion.check.ts). This file runs under tsx, never in the bundle.
import { readFileSync } from "node:fs";
import { aiming, defaultPlace, DOCK_TIMING, itemFor, LAST_PAGE_KEY, menuItems, menuShift, rememberPage, tabTarget } from "./dockMenu";
import { PHONE_MAX } from "./phone";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}
const ok = (cond: boolean, message: string) => eq(cond, true, message);

/* ---- the menus: the mockups' pages, groups and order ---- */

eq(menuItems("overview").map((i) => i.label), ["Dashboard", "Financials", "Account Overview", "Templates", "Contracts", "Failed posts"], "Overview menu");
eq(
  menuItems("create").map((i) => i.label),
  ["Upload & Schedule", "Fan-out", "Upload queue", "Ready queue", "Approvals", "Studio", "Calendar", "Carousels", "Workflows", "Requests"],
  "Create menu: ten pages, Preflight and Schedule card stay deep links",
);
eq(menuItems("reports").map((i) => i.label), ["Analytics", "Reports", "Rollup", "Monthly report", "Insights", "Comments"], "one Reports menu, Analytics first");
eq(
  menuItems("settings").map((i) => i.label),
  ["General", "Connected Accounts", "Business", "Trello labels", "Updates", "Ship an update", "Operator"],
  "Settings menu lists its cards",
);
eq(menuItems("settings")[1]!.testid, "settings.section.accounts", "Settings items keep the old tab test ids");
eq(menuItems("overview")[2]!.testid, "nav.page.account-overview", "page items keep nav.page.<slug>");
ok(menuItems("create").every((i) => i.icon.startsWith("#i-")), "every page has an icon");

eq(itemFor("create", { screen: "workflows", section: "inbox" }), "workflows", "a Workflows area lights Workflows");
eq(itemFor("settings", { screen: "settings", section: null }), "general", "the top of Settings is General");
eq(itemFor("reports", { screen: "analytics", section: null }), "analytics", "Analytics lights in the Reports menu");
eq(itemFor("create", { screen: "analytics", section: null }), null, "another tab's page lights nothing");
eq(itemFor("create", { screen: "preflight", section: null }), null, "a deep-link-only page has no item");

/* ---- timings, in the code and in the stylesheet ---- */

eq(
  [DOCK_TIMING.openDelay, DOCK_TIMING.slide, DOCK_TIMING.stagger, DOCK_TIMING.closeDelay],
  [80, 200, 22, 250],
  "80ms open delay, 200ms slide and fade, 22ms stagger, 250ms close delay",
);
eq([DOCK_TIMING.staggerCap, DOCK_TIMING.aimGrace, DOCK_TIMING.fade, DOCK_TIMING.closeFade, DOCK_TIMING.bridge], [8, 120, 120, 140, 14], "cap, aim grace, fades, bridge");

const css = (readFileSync(`${process.cwd()}/src/styles/dock.css`, "utf8") as string).replace(/\/\*[\s\S]*?\*\//g, "");
const flat = css.replace(/\s+/g, " ");
const rule = (sel: string) => {
  const i = flat.indexOf(`${sel}{`);
  if (i < 0) throw new Error(`dock.css has no rule for ${sel}`);
  return flat.slice(i, flat.indexOf("}", i));
};
const ms = (n: number) => `${n}ms`;
ok(rule(".dock .dt.open>.dm").includes(`opacity ${ms(DOCK_TIMING.slide)} cubic-bezier(.2,.7,.2,1)`), "the menu fades in over the slide time");
ok(rule(".dock .dt.open>.dm").includes(`transform ${ms(DOCK_TIMING.slide)} cubic-bezier(.2,.7,.2,1)`), "and slides over it");
ok(rule(".dock .dm").includes("translate(calc(-50% + var(--dx,0px)),10px)"), "closed, the menu sits 10px low");
ok(rule(".dock .dm").includes(`opacity ${ms(DOCK_TIMING.closeFade)} ease-in`), "closing is the quicker fade");
ok(
  rule(".dock .dt.open .mi").includes(`calc(min(var(--i),${DOCK_TIMING.staggerCap})*${ms(DOCK_TIMING.stagger)})`),
  "pages follow each other by the stagger, capped",
);
ok(rule(".dock .dt.swap.open>.dm").includes(`opacity ${ms(DOCK_TIMING.fade)} linear`), "tab to tab is the short fade");
ok(rule(".dock .dm::after").includes(`left:-${DOCK_TIMING.bridge}px;right:-${DOCK_TIMING.bridge}px`), "the bridge is 14px wider each side");

/* ---- reduced motion: no slide, no stagger, a short fade ---- */

const reduced = flat.slice(flat.indexOf("@media (prefers-reduced-motion:reduce){"));
ok(flat.includes("@media (prefers-reduced-motion:reduce){"), "the OS reduce-motion setting is honoured");
for (const block of [reduced.slice(0, reduced.indexOf("} }") + 3), flat.slice(flat.indexOf('html[data-motion="reduced"] .dock .dm'))]) {
  ok(block.includes(`opacity ${ms(DOCK_TIMING.fade)} linear`), "reduced motion fades only");
  ok(block.includes("translate(calc(-50% + var(--dx,0px)),0) !important"), "reduced motion: no slide");
  ok(/\.mi[^{]*\{opacity:1;transform:none;transition:background-color 100ms,color 100ms !important/.test(block), "reduced motion: no stagger");
}
ok(flat.includes('html[data-motion="reduced"] .dock .dt.open>.dm'), "the app's automation mode counts as reduced motion");

/* ---- the phone keeps its own nav ---- */

ok(!new RegExp(`max-width: ?${PHONE_MAX}px`).test(css), "dock.css has no phone rules: the phone hides the Dock");
const mobile = (readFileSync(`${process.cwd()}/src/styles/mobile.css`, "utf8") as string).replace(/\s+/g, "");
ok(mobile.includes(".dock{display:none}"), "mobile.css hides the Dock (inside the phone query, see phone.check.ts)");

/* ---- the aim check ---- */

const menu = { left: 400, right: 650, bottom: 790 };
ok(aiming({ x: 700, y: 840, t: 0 }, { x: 690, y: 830, t: 16 }, menu), "heading up and left into the menu keeps it");
ok(!aiming({ x: 700, y: 840, t: 0 }, { x: 720, y: 838, t: 16 }, menu), "sliding sideways along the Dock swaps");
ok(!aiming({ x: 700, y: 840, t: 0 }, { x: 690, y: 830, t: 400 }, menu), "a resting pointer is not travelling");
ok(!aiming({ x: 900, y: 840, t: 0 }, { x: 905, y: 830, t: 16 }, menu), "heading up but away from the menu swaps");
ok(!aiming(undefined, { x: 690, y: 830, t: 16 }, menu), "no trail, no aim");
ok(aiming({ x: 670, y: 850, t: 0 }, { x: 664, y: 840, t: 16 }, menu), "the bridge counts: landing 14px past the edge still keeps it");

/* ---- every menu fits a 360px window ---- */

const minWidth = Number(/min-width:(\d+)px/.exec(rule(".dock .dm"))![1]);
ok(minWidth + 16 <= 360, "the narrowest menu plus margins fits 360px");
eq(menuShift(-60, 200, 360), 68, "a menu off the left edge slides right to 8px");
eq(menuShift(200, 400, 360), -48, "a menu off the right edge slides left");
eq(menuShift(50, 300, 360), 0, "a menu inside the window stays centred");
eq(menuShift(-30, 400, 360), 38, "a menu wider than the window starts at the left margin");

/* ---- the last page per tab ---- */

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const st = memStore();
eq(defaultPlace("overview"), { screen: "dashboard", section: null }, "Overview opens Dashboard first");
eq(defaultPlace("create"), { screen: "upload", section: null }, "Create opens Upload & Schedule first");
eq(defaultPlace("reports"), { screen: "analytics", section: null }, "Reports opens Analytics first");
eq(defaultPlace("settings"), { screen: "settings", section: null }, "Settings opens at the top");
eq(tabTarget("create", st), defaultPlace("create"), "nothing remembered: the first page");

rememberPage({ screen: "calendar", section: null }, st);
rememberPage({ screen: "rollup", section: null }, st);
rememberPage({ screen: "settings", section: "accounts" }, st);
eq(tabTarget("create", st), { screen: "calendar", section: null }, "Create reopens Calendar");
eq(tabTarget("reports", st), { screen: "rollup", section: null }, "Reports reopens Rollup");
eq(tabTarget("settings", st), { screen: "settings", section: "accounts" }, "Settings reopens Connected Accounts");
eq(tabTarget("overview", st), defaultPlace("overview"), "a tab with nothing remembered is untouched by the others");

// Survives a reload: a fresh read of the same storage gives the same answer.
const reloaded = memStore();
for (const [k, v] of st.m) reloaded.setItem(k, v);
eq(tabTarget("create", reloaded), { screen: "calendar", section: null }, "per-tab memory survives a reload");

rememberPage({ screen: "workflows", section: "inbox" }, st);
eq(tabTarget("create", st), { screen: "workflows", section: "inbox" }, "a Workflows area is remembered exactly");
rememberPage({ screen: "preflight", section: null }, st);
eq(tabTarget("create", st), { screen: "workflows", section: "inbox" }, "a deep-link-only page is not remembered");
eq(tabTarget("create", st, { screen: "queue", section: null }), { screen: "queue", section: null }, "on its own tab, the page you are on wins");
eq(tabTarget("create", st, { screen: "rollup", section: null }), { screen: "workflows", section: "inbox" }, "another tab's page does not");

// Validated against today's routes.
const bad = memStore();
bad.setItem(LAST_PAGE_KEY, JSON.stringify({ create: "/create/nope", reports: "/dashboard", settings: "/settings/nope", overview: 42 }));
eq(tabTarget("create", bad), defaultPlace("create"), "a path that is no page falls back");
eq(tabTarget("reports", bad), defaultPlace("reports"), "another tab's page falls back");
eq(tabTarget("settings", bad), defaultPlace("settings"), "an unknown Settings card falls back");
eq(tabTarget("overview", bad), defaultPlace("overview"), "junk falls back");
const junk = memStore();
junk.setItem(LAST_PAGE_KEY, "{not json");
eq(tabTarget("create", junk), defaultPlace("create"), "broken JSON falls back");
const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
rememberPage({ screen: "calendar", section: null }, full); // must not throw

// The mockup's unread count on Create and on its Workflows item: real data only.
const dock = readFileSync(`${process.cwd()}/src/components/Dock.tsx`, "utf8") as string;
if (!dock.includes("/dm/summary") || !/it\.key === "workflows" && unread > 0/.test(dock) || !/s\.id === "create" && unread > 0/.test(dock)) {
  throw new Error("the Dock lost the unread count on Create and Workflows");
}
if (!/\.dock \.di\.on \.cnt\{background:#fff/.test(css)) throw new Error("the count on the coral Create tab must be white (mockup dock.css)");

console.log("dockMenu: all checks passed");
