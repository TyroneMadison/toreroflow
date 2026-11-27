import { dockSection, pageOf, SECTIONS, sectionHome, type ScreenId, type SectionId } from "./nav";
import { parseUrl, pathFor, SETTINGS_SECTIONS, type PageSection, type SettingsSection } from "./routes";

/*
 * The Dock's drop-up page menus (desktop and web; the phone has its own tab
 * bar). Everything here is plain data and math so dockMenu.check.ts can run it
 * without a browser; components/Dock.tsx wires it to the pointer and keys.
 * Design: round 2 mockups, assets/dock.js and dock.css.
 */

/** Hover-intent timings in ms. styles/dock.css uses the same numbers, and
 *  dockMenu.check.ts fails if the two drift apart. */
export const DOCK_TIMING = {
  /** Rest on a tab this long before its menu opens, so sweeping past opens nothing. */
  openDelay: 80,
  /** The menu slides up 10px and fades in over this long. */
  slide: 200,
  /** Each page follows the one above it by this much... */
  stagger: 22,
  /** ...for this many pages, so a long menu is still quick. */
  staggerCap: 8,
  /** Pointer away from tab, bridge and menu this long before it closes. */
  closeDelay: 250,
  /** Crossing another tab on the way up to the open menu: wait this long before swapping. */
  aimGrace: 120,
  /** Tab to tab, and reduced motion: a short fade, no slide. */
  fade: 120,
  /** Closing is quicker than opening. */
  closeFade: 140,
  /** The safe bridge and the aim check reach this far past each side of the menu. */
  bridge: 14,
} as const;

export interface MenuItem {
  key: string;
  label: string;
  icon: string;
  screen: ScreenId;
  section: PageSection | null;
  testid: string;
}

const SETTINGS_ICONS: Record<SettingsSection, string> = {
  general: "#i-sliders",
  accounts: "#i-link",
  business: "#i-bank",
  trello: "#i-trello",
  updates: "#i-refresh",
  deploy: "#i-rocket",
  operator: "#i-key",
};

/** A tab's pages in menu order: its visible pages, or Settings' cards. */
export function menuItems(tab: SectionId): MenuItem[] {
  if (tab === "settings")
    return SETTINGS_SECTIONS.map((s) => ({
      key: s.id,
      label: s.label,
      icon: SETTINGS_ICONS[s.id],
      screen: "settings",
      section: s.id,
      testid: `settings.section.${s.id}`,
    }));
  const sec = SECTIONS.find((s) => s.id === tab)!;
  return sec.pages
    .filter((p) => !p.hidden)
    .map((p) => ({ key: p.id, label: p.label, icon: p.icon ?? sec.icon, screen: p.id, section: null, testid: `nav.page.${p.slug}` }));
}

export interface Place {
  screen: ScreenId;
  section: PageSection | null;
}

/**
 * The menu item a place lights, or null. Settings matches by card (no card is
 * General, the top of the page); every other page by screen, so each
 * Workflows area lights Workflows.
 */
export function itemFor(tab: SectionId, at: Place): string | null {
  if (dockSection(at.screen) !== tab) return null;
  if (at.screen === "settings") return at.section ?? "general";
  return menuItems(tab).some((i) => i.key === at.screen) ? at.screen : null;
}

/* ---- last page per tab ---- */

/** localStorage key: { [tab]: path } of the last page used in each Dock tab. */
export const LAST_PAGE_KEY = "toreroflow-dock-last";

type Store = Pick<Storage, "getItem" | "setItem">;

/** The path a place is remembered by, or null for a deep-link-only page
 *  (Preflight, a card's schedule page, the phone's More) nobody reopens. */
function memoryPath(at: Place): string | null {
  return pageOf(at.screen).hidden ? null : pathFor(at.screen, at.section);
}

function readAll(store: Store): Partial<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(store.getItem(LAST_PAGE_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Notes the page as the last one used in its tab. */
export function rememberPage(at: Place, store: Store): void {
  const path = memoryPath(at);
  if (!path) return;
  const all = readAll(store);
  const tab = dockSection(at.screen);
  if (all[tab] === path) return;
  all[tab] = path;
  try {
    store.setItem(LAST_PAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the tab opens its first page, as before.
  }
}

/** Where a tab opens with nothing remembered: its first page (Settings at the top). */
export function defaultPlace(tab: SectionId): Place {
  if (tab === "settings") return { screen: "settings", section: null };
  return { screen: sectionHome(SECTIONS.find((s) => s.id === tab)!), section: null };
}

/**
 * Where a click on a Dock tab goes: the last page used in that tab, checked
 * against today's routes (a renamed or removed page falls back), else its
 * first page. On the tab you are in, the page you are on is the last one.
 */
export function tabTarget(tab: SectionId, store: Store, here?: Place): Place {
  if (here && dockSection(here.screen) === tab && memoryPath(here)) return { screen: here.screen, section: here.section };
  const saved = readAll(store)[tab];
  if (typeof saved === "string") {
    const r = parseUrl(saved);
    // parseUrl sends anything unknown somewhere else, so a saved path is good
    // only if it comes back to itself, in this tab.
    if (dockSection(r.screen) === tab && memoryPath(r) === saved) return { screen: r.screen, section: r.section };
  }
  return defaultPlace(tab);
}

/* ---- the aim check ---- */

export interface Pt {
  x: number;
  y: number;
  t: number;
}

/**
 * Is the pointer heading up for the open menu? Projects its last movement up
 * to the menu's bottom edge and checks the line lands on the menu (plus the
 * bridge). `from` is an earlier point (about 16ms back on a real mouse);
 * `to` is where it is now. pointerenter fires before pointermove, so `to`
 * must come from the entering event itself.
 */
export function aiming(from: Pt | undefined, to: Pt, menu: { left: number; right: number; bottom: number }): boolean {
  if (!from || to.t - from.t > 150) return false; // resting, not travelling
  const dy = to.y - from.y;
  const dx = to.x - from.x;
  if (dy >= -1 || to.y <= menu.bottom) return false;
  const x = to.x + dx * ((menu.bottom - to.y) / dy);
  return x >= menu.left - DOCK_TIMING.bridge && x <= menu.right + DOCK_TIMING.bridge;
}

/** How far to slide a centred menu so it stays `margin` px inside the window. */
export function menuShift(left: number, right: number, viewport: number, margin = 8): number {
  if (right - left > viewport - margin * 2) return margin - left;
  if (left < margin) return margin - left;
  if (right > viewport - margin) return viewport - margin - right;
  return 0;
}
