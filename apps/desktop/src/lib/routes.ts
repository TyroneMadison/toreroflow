import { useMemo, useSyncExternalStore, type MouseEvent } from "react";
import type { ScreenId } from "./nav";

/*
 * Real URLs for every screen, on the History API with no router dependency.
 *
 * The screen used to live in a useState, so the address bar always read "/":
 * nothing could be bookmarked, linked, or reached directly by a bot, and the
 * browser's back button left the app. The URL is now the one source of truth
 * for which screen is open, the active brand (?client=) and the period
 * (?range=).
 */

/**
 * Hash URLs (#/dashboard) instead of real paths. Off, because neither shell
 * needs it: the web container's Caddy has `try_files {path} /index.html`, and
 * Tauri's asset resolver falls back to index.html for any path it does not
 * have (tauri 2.x manager/mod.rs). Flip it only if a shell ever 404s a deep
 * path on reload.
 */
export const HASH_ROUTES = false;

/** The public path of each screen. Account Overview is /accounts. */
export const PATHS: Record<ScreenId, string> = {
  dashboard: "/dashboard",
  financials: "/financials",
  overview: "/accounts",
  upload: "/create/upload",
  edit: "/create/edit",
  calendar: "/calendar",
  carousels: "/create/carousels",
  workflows: "/create/workflows",
  analytics: "/analytics",
  reports: "/reports",
  settings: "/settings",
};

/** Settings' cards, each reachable as /settings/<id>. */
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Connected Accounts" },
  { id: "business", label: "Business" },
  { id: "updates", label: "Updates" },
  { id: "deploy", label: "Ship an update" },
  { id: "operator", label: "Operator" },
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** Periods a range control can show. Dashboard offers 30/60/90; Analytics
 *  adds 7 and all. A screen falls back to 30 for one it does not offer. */
export const RANGES = [7, 30, 60, 90, "all"] as const;
export type Range = (typeof RANGES)[number];

export interface Route {
  screen: ScreenId;
  section: SettingsSection | null;
  clientId: string | null;
  range: Range | null;
}

const BASE = "http://x";

/** Reads "/path?query". Unknown paths land on the dashboard. */
export function parseUrl(url: string): Route {
  const u = new URL(url, BASE);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  let screen: ScreenId = "dashboard";
  let section: SettingsSection | null = null;
  if (path.startsWith("/settings/")) {
    // An unknown section still opens Settings, at the top.
    screen = "settings";
    section = SETTINGS_SECTIONS.find((s) => `/settings/${s.id}` === path)?.id ?? null;
  } else {
    screen = (Object.keys(PATHS) as ScreenId[]).find((s) => PATHS[s] === path) ?? "dashboard";
  }
  const r = u.searchParams.get("range");
  return {
    screen,
    section,
    clientId: u.searchParams.get("client") || null,
    range: RANGES.find((x) => String(x) === r) ?? null,
  };
}

export function pathFor(screen: ScreenId, section?: SettingsSection | null): string {
  return section ? `${PATHS[screen]}/${section}` : PATHS[screen];
}

/** The canonical form of a URL: its route's own path, query untouched. */
export function canonicalUrl(url: string): string {
  const r = parseUrl(url);
  return pathFor(r.screen, r.section) + new URL(url, BASE).search;
}

/**
 * The bot sign-in token from a URL's fragment, and the URL to show once it is
 * scrubbed. Works on any path, so /create/upload#token=... lands on Upload.
 */
export function scrubToken(href: string): { token: string; url: string } | null {
  const u = new URL(href);
  const m = /[#&]token=([^&]+)/.exec(u.hash);
  return m ? { token: decodeURIComponent(m[1]!), url: u.pathname + u.search } : null;
}

/* ---- the live location ---- */

const listeners = new Set<() => void>();

function readUrl(): string {
  return HASH_ROUTES
    ? window.location.hash.slice(1) || "/"
    : window.location.pathname + window.location.search;
}

function writeUrl(url: string, replace: boolean): void {
  const full = HASH_ROUTES ? `${window.location.pathname}#${url}` : url;
  history[replace ? "replaceState" : "pushState"](null, "", full);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  window.addEventListener("popstate", l);
  return () => {
    listeners.delete(l);
    window.removeEventListener("popstate", l);
  };
}

export function currentRoute(): Route {
  return parseUrl(readUrl());
}

/** "/" and unknown paths become their canonical path, without a history entry. */
export function normalizeUrl(): void {
  const url = readUrl();
  const want = canonicalUrl(url);
  if (want !== url) writeUrl(want, true);
}

export function useRoute(): Route {
  const url = useSyncExternalStore(subscribe, readUrl);
  return useMemo(() => parseUrl(url), [url]);
}

/** Opens a screen as a new history entry, keeping ?client and ?range. */
export function navigate(screen: ScreenId, section?: SettingsSection | null): void {
  const next = pathFor(screen, section) + new URL(readUrl(), BASE).search;
  if (next !== readUrl()) writeUrl(next, false);
}

/** Updates the query in place (replaceState). null removes a key. */
export function setQuery(patch: { client?: string | null; range?: Range | null }): void {
  const u = new URL(readUrl(), BASE);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) u.searchParams.delete(k);
    else u.searchParams.set(k, String(v));
  }
  const next = u.pathname + u.search;
  if (next !== readUrl()) writeUrl(next, true);
}

/**
 * href and onClick for an in-app <a>. A plain left click navigates in place;
 * middle, ctrl, cmd and shift clicks fall through to the browser, so opening
 * in a new tab and copying the link both work.
 */
export function linkProps(screen: ScreenId, section?: SettingsSection | null) {
  const path = pathFor(screen, section) + new URL(readUrl(), BASE).search;
  return {
    href: HASH_ROUTES ? `#${path}` : path,
    onClick(e: MouseEvent<HTMLAnchorElement>) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(screen, section);
    },
  };
}
