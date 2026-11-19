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

export type SectionId = "overview" | "create" | "measure" | "reports" | "settings";

export interface PageDef {
  id: ScreenId;
  label: string;
  /** Stable name for data-testid and, later, the URL. "overview" alone would
   *  collide with the Overview section, hence account-overview. */
  slug: string;
  /** Reached by deep link only (e.g. a card's schedule page); not a tab. */
  hidden?: boolean;
}

export interface SectionDef {
  id: SectionId;
  label: string;
  icon: string;
  pages: PageDef[];
  /** The page the dock tab opens; defaults to the first. */
  opens?: ScreenId;
}

const REPORT_PAGES: PageDef[] = [
  { id: "analytics", label: "Analytics", slug: "analytics" },
  { id: "reports", label: "Reports", slug: "reports" },
  { id: "rollup", label: "Rollup", slug: "rollup" },
  { id: "monthly", label: "Monthly report", slug: "monthly-report" },
  { id: "insights", label: "Insights", slug: "insights" },
  { id: "comments", label: "Comments", slug: "comments" },
];

export const SECTIONS: SectionDef[] = [
  {
    id: "overview",
    label: "Overview",
    icon: "#i-dash",
    pages: [
      { id: "dashboard", label: "Dashboard", slug: "dashboard" },
      { id: "financials", label: "Financials", slug: "financials" },
      { id: "overview", label: "Account Overview", slug: "account-overview" },
      { id: "templates", label: "Templates", slug: "templates" },
      { id: "contracts", label: "Contracts", slug: "contracts" },
      { id: "failed", label: "Failed posts", slug: "failed-posts" },
    ],
  },
  {
    id: "create",
    label: "Create",
    icon: "#i-upload",
    pages: [
      { id: "upload", label: "Upload & Schedule", slug: "upload" },
      { id: "fanout", label: "Fan-out", slug: "fanout" },
      { id: "preflight", label: "Preflight", slug: "preflight", hidden: true },
      { id: "queue", label: "Upload queue", slug: "queue" },
      { id: "ready", label: "Ready queue", slug: "ready" },
      { id: "approvals", label: "Approvals", slug: "approvals" },
      { id: "schedule", label: "Schedule card", slug: "schedule", hidden: true },
      { id: "edit", label: "Studio", slug: "edit" },
      { id: "calendar", label: "Calendar", slug: "calendar" },
      { id: "carousels", label: "Carousels", slug: "carousels" },
      { id: "workflows", label: "Workflows", slug: "workflows" },
      { id: "requests", label: "Requests", slug: "requests" },
    ],
  },
  // Measure and Reports share one page list. Measure opens Analytics, the
  // Reports tab opens /reports, and sectionOf() names Reports for all six so
  // the Reports tab is the one lit and the sub-nav reads "Reports".
  { id: "measure", label: "Measure", icon: "#i-chart", pages: REPORT_PAGES },
  { id: "reports", label: "Reports", icon: "#i-report", pages: REPORT_PAGES, opens: "reports" },
  {
    id: "settings",
    label: "Settings",
    icon: "#i-gear",
    pages: [
      { id: "settings", label: "Settings", slug: "settings" },
      // The phone's More tab (mobile pass): every other page in one list.
      { id: "more", label: "More", slug: "more", hidden: true },
    ],
  },
];

/** Measure mirrors Reports' pages, so a screen belongs to the other section. */
export function sectionOf(screen: ScreenId): SectionDef {
  return SECTIONS.find((s) => s.id !== "measure" && s.pages.some((p) => p.id === screen))!;
}

/** Where a section's dock tab goes. */
export function sectionHome(s: SectionDef): ScreenId {
  return s.opens ?? s.pages[0]!.id;
}

/**
 * The dock tab lit on a screen: the tab that opens it, else its section. So
 * Analytics lights Measure (the tab that went there) while every other
 * Reports page lights Reports; sectionOf alone never names Measure.
 */
export function dockSection(screen: ScreenId): SectionDef["id"] {
  return SECTIONS.find((s) => sectionHome(s) === screen)?.id ?? sectionOf(screen).id;
}

export function pageOf(screen: ScreenId): PageDef {
  return sectionOf(screen).pages.find((p) => p.id === screen)!;
}
