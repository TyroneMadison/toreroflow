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
  ready: "/create/ready",
  schedule: "/create/schedule",
  fanout: "/create/fanout",
  preflight: "/create/preflight",
  queue: "/create/queue",
  rollup: "/rollup",
  templates: "/templates",
  approvals: "/create/approvals",
  requests: "/create/requests",
  failed: "/failed-posts",
  insights: "/insights",
  monthly: "/reports/monthly",
  analytics: "/analytics",
  reports: "/reports",
  comments: "/comments",
  settings: "/settings",
};

/** Settings' cards, each reachable as /settings/<id>. */
export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "accounts", label: "Connected Accounts" },
  { id: "business", label: "Business" },
  { id: "trello", label: "Trello labels" },
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
  /** Client handle from /clients/:slug/ready or /clients/:slug/schedule/:card. */
  slug: string | null;
  /** Trello card id from /clients/:slug/schedule/:card. */
  cardId: string | null;
  /** The open step of a multi-step flow (?step=), so a bot can deep-link it. */
  step: string | null;
  /** The media asset whose schedule flow is open (?schedule=). */
  scheduleId: string | null;
  /** Where a long-form upload goes (?dest=youtube|instagram|both). */
  dest: string | null;
  /** Studio's open area (?area=ideas), so the phone tab bar can open Ideas. */
  area: string | null;
  /** The workflow draft open in Fan-out and Preflight (?draft=). */
  draft: string | null;
  /** The source video a Rollup shows (?video=). */
  video: string | null;
}

const SEG = "([A-Za-z0-9_-]+)";
const CLIENT_READY = new RegExp(`^/clients/${SEG}/ready$`);
const CLIENT_SCHEDULE = new RegExp(`^/clients/${SEG}/schedule/${SEG}$`);
/** A preflight fix link: /create/<draft id>, or /create/new for an unsaved draft. */
const CREATE_DRAFT = new RegExp(`^/create/${SEG}$`);

const BASE = "http://x";

/**
 * The two pages a client opens with no login: an approval link (/a/<token>)
 * and a brand's signed request form (/r/<token>). The app shell renders them
 * before sign-in, and normalizeUrl leaves them alone.
 */
export type PublicRoute = { kind: "approval" | "request" | "review"; token: string };
const PUBLIC_APPROVAL = /^\/a\/([A-Za-z0-9_.-]+)$/;
const PUBLIC_REQUEST = /^\/r\/([A-Za-z0-9_.-]+)$/;
/** Phase 8: a read-only edit review link (/v/<token>). */
const PUBLIC_REVIEW = /^\/v\/([A-Za-z0-9_.-]+)$/;

export function publicRoute(url: string): PublicRoute | null {
  const path = new URL(url, BASE).pathname.replace(/\/+$/, "");
  const a = PUBLIC_APPROVAL.exec(path);
  if (a) return { kind: "approval", token: a[1]! };
  const v = PUBLIC_REVIEW.exec(path);
  if (v) return { kind: "review", token: v[1]! };
  const r = PUBLIC_REQUEST.exec(path);
  return r ? { kind: "request", token: r[1]! } : null;
}

/** Reads "/path?query". Unknown paths land on the dashboard. */
export function parseUrl(url: string): Route {
  const u = new URL(url, BASE);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  let screen: ScreenId = "dashboard";
  let section: SettingsSection | null = null;
  let slug: string | null = null;
  let cardId: string | null = null;
  let draft: string | null = null;
  const ready = CLIENT_READY.exec(path);
  const sched = CLIENT_SCHEDULE.exec(path);
  if (ready) {
    screen = "ready";
    slug = ready[1]!;
  } else if (sched) {
    screen = "schedule";
    slug = sched[1]!;
    cardId = sched[2]!;
  } else if (path === "/clients") {
    screen = "ready";
  } else if (path.startsWith("/settings/")) {
    // An unknown section still opens Settings, at the top.
    screen = "settings";
    section = SETTINGS_SECTIONS.find((s) => `/settings/${s.id}` === path)?.id ?? null;
  } else {
    const known = (Object.keys(PATHS) as ScreenId[]).find((s) => PATHS[s] === path);
    const fix = known ? null : CREATE_DRAFT.exec(path);
    screen = known ?? (fix ? "fanout" : "dashboard");
    if (fix) draft = fix[1]!;
  }
  const r = u.searchParams.get("range");
  return {
    screen,
    section,
    clientId: u.searchParams.get("client") || null,
    range: RANGES.find((x) => String(x) === r) ?? null,
    slug,
    cardId,
    step: u.searchParams.get("step") || null,
    scheduleId: u.searchParams.get("schedule") || null,
    dest: u.searchParams.get("dest") || null,
    area: u.searchParams.get("area") || null,
    draft: draft ?? (u.searchParams.get("draft") || null),
    video: u.searchParams.get("video") || null,
  };
}

/** /clients/caleb/ready, /clients/caleb/schedule/<card>, or /create/ready for all. */
export function clientPath(slug: string | null, cardId?: string | null): string {
  if (!slug) return PATHS.ready;
  return cardId ? `/clients/${slug}/schedule/${cardId}` : `/clients/${slug}/ready`;
}

export function pathFor(screen: ScreenId, section?: SettingsSection | null): string {
  return section ? `${PATHS[screen]}/${section}` : PATHS[screen];
}

/** The canonical form of a URL: its route's own path, query untouched. */
export function canonicalUrl(url: string): string {
  if (publicRoute(url)) return url;
  const r = parseUrl(url);
  const own = new URL(url, BASE).pathname;
  if (r.screen === "fanout" && CREATE_DRAFT.test(own) && own !== PATHS.fanout) return own + new URL(url, BASE).search;
  const path =
    r.slug && (r.screen === "ready" || r.screen === "schedule")
      ? clientPath(r.slug, r.cardId)
      : r.screen === "schedule"
        ? PATHS.ready // a schedule page with no card has nothing to show
        : pathFor(r.screen, r.section);
  return path + new URL(url, BASE).search;
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

/** The query a link to `screen` carries over; ?area belongs to Studio alone. */
function carriedQuery(screen: ScreenId): string {
  const u = new URL(readUrl(), BASE);
  if (screen !== "edit") u.searchParams.delete("area");
  return u.search;
}

/** Opens a screen as a new history entry, keeping ?client and ?range. */
export function navigate(screen: ScreenId, section?: SettingsSection | null): void {
  const next = pathFor(screen, section) + carriedQuery(screen);
  if (next !== readUrl()) writeUrl(next, false);
}

/** Updates the query in place (replaceState). null removes a key. */
export function setQuery(patch: {
  client?: string | null;
  range?: Range | null;
  step?: string | null;
  schedule?: string | null;
  area?: string | null;
  dest?: string | null;
  draft?: string | null;
  video?: string | null;
}): void {
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
  const path = pathFor(screen, section) + carriedQuery(screen);
  return {
    href: HASH_ROUTES ? `#${path}` : path,
    onClick(e: MouseEvent<HTMLAnchorElement>) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(screen, section);
    },
  };
}

/** Opens an exact in-app path ("/clients/caleb/ready") as a new history entry. */
export function navigatePath(path: string): void {
  if (path !== readUrl()) writeUrl(path, false);
}

/** href and onClick for an in-app <a> to an exact path. */
export function pathLinkProps(path: string) {
  return {
    href: HASH_ROUTES ? `#${path}` : path,
    onClick(e: MouseEvent<HTMLAnchorElement>) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigatePath(path);
    },
  };
}
