/*
 * The app's map: which screens exist, which dock section each belongs to, and
 * the slug a bot (and later a URL route) names it by. Kept in one place so the
 * dock, the page headers and a future router all read the same table.
 */

export type ScreenId =
  | "dashboard"
  | "upload"
  | "edit"
  | "calendar"
  | "analytics"
  | "reports"
  | "comments"
  | "overview"
  | "financials"
  | "carousels"
  | "workflows"
  | "ready"
  | "schedule"
  | "fanout"
  | "preflight"
  | "queue"
  | "rollup"
  | "templates"
  | "contracts"
  | "approvals"
  | "requests"
  | "failed"
  | "insights"
  | "monthly"
  | "settings"
  | "more";

export type SectionId = "overview" | "create" | "reports" | "settings";

export interface PageDef {
  id: ScreenId;
  label: string;
  /** Stable name for data-testid and, later, the URL. "overview" alone would
   *  collide with the Overview section, hence account-overview. */
  slug: string;
  /** Reached by deep link only (e.g. a card's schedule page); not a tab. */
  hidden?: boolean;
  /** Icon in the Dock's drop-up menu (an IconDefs symbol). */
  icon?: string;
}

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: string;
  pages: PageDef[];
  /** The page the dock tab opens when it has no remembered page; defaults to the first. */
  opens?: ScreenId;
}

const REPORT_PAGES: PageDef[] = [
  { id: "analytics", label: "Analytics", slug: "analytics", icon: "#i-chart" },
  { id: "reports", label: "Reports", slug: "reports", icon: "#i-report" },
  { id: "rollup", label: "Rollup", slug: "rollup", icon: "#i-layers" },
  { id: "monthly", label: "Monthly report", slug: "monthly-report", icon: "#i-cal" },
  { id: "insights", label: "Insights", slug: "insights", icon: "#i-bulb" },
  { id: "comments", label: "Comments", slug: "comments", icon: "#i-comment" },
];

export const SECTIONS: SectionDef[] = [
  {
    id: "overview",
    label: "Overview",
    icon: "#i-dash",
    pages: [
      { id: "dashboard", label: "Dashboard", slug: "dashboard", icon: "#i-dash" },
      { id: "financials", label: "Financials", slug: "financials", icon: "#i-dollar" },
      { id: "overview", label: "Account Overview", slug: "account-overview", icon: "#i-users" },
      { id: "templates", label: "Templates", slug: "templates", icon: "#i-copy" },
      { id: "contracts", label: "Contracts", slug: "contracts", icon: "#i-pencil" },
      { id: "failed", label: "Failed posts", slug: "failed-posts", icon: "#i-alert" },
    ],
  },
  {
    id: "create",
    label: "Create",
    icon: "#i-upload",
    pages: [
      { id: "upload", label: "Upload & Schedule", slug: "upload", icon: "#i-upload" },
      { id: "fanout", label: "Fan-out", slug: "fanout", icon: "#i-shuffle" },
      { id: "preflight", label: "Preflight", slug: "preflight", hidden: true },
      { id: "queue", label: "Upload queue", slug: "queue", icon: "#i-up" },
      { id: "ready", label: "Ready queue", slug: "ready", icon: "#i-trello" },
      { id: "approvals", label: "Approvals", slug: "approvals", icon: "#i-check-circle" },
      { id: "schedule", label: "Schedule card", slug: "schedule", hidden: true },
      { id: "edit", label: "Studio", slug: "edit", icon: "#i-film" },
      { id: "calendar", label: "Calendar", slug: "calendar", icon: "#i-cal" },
      { id: "carousels", label: "Carousels", slug: "carousels", icon: "#i-layers" },
      { id: "workflows", label: "Workflows", slug: "workflows", icon: "#i-repeat" },
      { id: "requests", label: "Requests", slug: "requests", icon: "#i-inbox" },
    ],
  },
  // One Reports tab (Tyrone, 2026-11-27): Measure and Reports opened the same
  // six pages, so they merged, Analytics first.
  { id: "reports", label: "Reports", icon: "#i-report", pages: REPORT_PAGES },
  {
    id: "settings",
    label: "Settings",
    icon: "#i-gear",
    pages: [
      { id: "settings", label: "Settings", slug: "settings", icon: "#i-gear" },
      // The phone's More tab (mobile pass): every other page in one list.
      { id: "more", label: "More", slug: "more", hidden: true },
    ],
  },
];

export function sectionOf(screen: ScreenId): SectionDef {
  return SECTIONS.find((s) => s.pages.some((p) => p.id === screen))!;
}

/** Where a section's dock tab goes when nothing is remembered for it. */
export function sectionHome(s: SectionDef): ScreenId {
  return s.opens ?? s.pages[0]!.id;
}

/** The dock tab lit on a screen. */
export function dockSection(screen: ScreenId): SectionId {
  return sectionOf(screen).id;
}

export function pageOf(screen: ScreenId): PageDef {
  return sectionOf(screen).pages.find((p) => p.id === screen)!;
}
