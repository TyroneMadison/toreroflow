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
  | "approvals"
  | "requests"
  | "failed"
  | "insights"
  | "monthly"
  | "settings";

export type SectionId = "overview" | "create" | "measure" | "settings";

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
}

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
  {
    id: "measure",
    label: "Measure",
    icon: "#i-chart",
    pages: [
      { id: "analytics", label: "Analytics", slug: "analytics" },
      { id: "reports", label: "Reports", slug: "reports" },
      { id: "rollup", label: "Rollup", slug: "rollup" },
      { id: "monthly", label: "Monthly report", slug: "monthly-report" },
      { id: "insights", label: "Insights", slug: "insights" },
      { id: "comments", label: "Comments", slug: "comments" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "#i-gear",
    pages: [{ id: "settings", label: "Settings", slug: "settings" }],
  },
];

export function sectionOf(screen: ScreenId): SectionDef {
  return SECTIONS.find((s) => s.pages.some((p) => p.id === screen))!;
}

export function pageOf(screen: ScreenId): PageDef {
  return sectionOf(screen).pages.find((p) => p.id === screen)!;
}
