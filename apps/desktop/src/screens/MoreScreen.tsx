import { useEffect, useMemo, useState } from "react";
import { api, type ReadyQueue } from "../lib/api";
import { useFailedPosts } from "../lib/failedPosts";
import type { ScreenId } from "../lib/nav";
import { linkProps, navigate, SETTINGS_SECTIONS, type SettingsSection } from "../lib/routes";
import type { Theme } from "../lib/theme";
import { useAppState } from "../state/AppState";
import type { useApiStatus } from "../components/ApiStatus";
import ConfirmSheet from "../components/mobile/ConfirmSheet";
import { openStudio, Svg } from "../components/MobileNav";

/*
 * The phone's More tab as a page (mobile pass): what needs you first, then
 * every page the tab bar does not already hold, Settings as one row, the
 * theme, Log out and the API status. Desktop never routes here.
 */

type Dest = { label: string; icon: string; screen?: ScreenId; area?: "analyze" | "clips" | "kit" | "assets" | null; count?: number };

export default function MoreScreen({
  theme,
  onToggleTheme,
  apiStatus,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  apiStatus: ReturnType<typeof useApiStatus>;
}) {
  const { user, clients, logout, selectClient } = useAppState();
  const failed = useFailedPosts();
  const [ready, setReady] = useState<number | null>(null);
  const [queue, setQueue] = useState<number | null>(null);
  const [requests, setRequests] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [askLogout, setAskLogout] = useState(false);

  useEffect(() => {
    void api.get<ReadyQueue>("/trello/ready").then((r) => setReady(r.cards.filter((c) => !c.held).length)).catch(() => {});
    void api.get<{ items: unknown[] }>("/queue").then((r) => setQueue(r.items.length)).catch(() => {});
    void api
      .get<{ requests: { status: string }[] }>("/requests")
      .then((r) => setRequests(r.requests.filter((x) => x.status === "failed").length))
      .catch(() => {});
  }, []);

  const groups: Array<{ title: string; items: Dest[] }> = [
    {
      title: "Create",
      items: [
        { label: "Upload and schedule", icon: "#i-upload", screen: "upload" },
        { label: "Fan-out", icon: "#i-shuffle", screen: "fanout" },
        { label: "Studio", icon: "#i-film", screen: "edit", area: null },
        { label: "Clips", icon: "#i-scissors", screen: "edit", area: "clips" },
        { label: "Analyze", icon: "#i-target", screen: "edit", area: "analyze" },
        { label: "Carousels", icon: "#i-layers", screen: "carousels" },
        { label: "Workflows", icon: "#i-repeat", screen: "workflows" },
        { label: "Requests", icon: "#i-inbox", screen: "requests", count: requests ?? 0 },
        { label: "Brand kit", icon: "#i-palette", screen: "edit", area: "kit" },
        { label: "Assets", icon: "#i-image", screen: "edit", area: "assets" },
      ],
    },
    {
      title: "Business",
      items: [
        { label: "Financials", icon: "#i-dollar", screen: "financials" },
        { label: "Account overview", icon: "#i-users", screen: "overview" },
        { label: "Templates", icon: "#i-copy", screen: "templates" },
        { label: "Contracts", icon: "#i-pencil", screen: "contracts" },
      ],
    },
    {
      title: "Reports",
      items: [
        { label: "Analytics", icon: "#i-chart", screen: "analytics" },
        { label: "Rollup", icon: "#i-layers", screen: "rollup" },
        { label: "Monthly report", icon: "#i-report", screen: "monthly" },
        { label: "Insights", icon: "#i-bulb", screen: "insights" },
        { label: "Comments", icon: "#i-comment", screen: "comments" },
      ],
    },
  ];

  // "Jump to a screen": every page, every Settings section and every brand.
  const hits = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    const pages = [
      ...groups.flatMap((g) => g.items.map((d) => ({ key: `p-${d.label}`, label: d.label, sub: g.title, icon: d.icon, run: () => open(d) }))),
      { key: "p-failed", label: "Failed posts", sub: "Needs you", icon: "#i-alert", run: () => navigate("failed") },
      { key: "p-approvals", label: "Approvals", sub: "Needs you", icon: "#i-check-circle", run: () => navigate("approvals") },
      { key: "p-ready", label: "Ready queue", sub: "Needs you", icon: "#i-trello", run: () => navigate("ready") },
      { key: "p-queue", label: "Upload queue", sub: "Needs you", icon: "#i-up", run: () => navigate("queue") },
      { key: "p-dash", label: "Dashboard", sub: "Overview", icon: "#i-dash", run: () => navigate("dashboard") },
      { key: "p-cal", label: "Calendar", sub: "Calendar", icon: "#i-cal", run: () => navigate("calendar") },
      { key: "p-ideas", label: "Ideas", sub: "Ideas", icon: "#i-bulb", run: () => openStudio("ideas") },
      { key: "p-reports", label: "Reports", sub: "Reports", icon: "#i-report", run: () => navigate("reports") },
      ...SETTINGS_SECTIONS.map((s) => ({
        key: `s-${s.id}`,
        label: s.label,
        sub: "Settings",
        icon: "#i-gear",
        run: () => navigate("settings", s.id as SettingsSection),
      })),
      ...clients.map((c) => ({
        key: `b-${c.id}`,
        label: c.name,
        sub: "Brand",
        icon: "#i-user",
        run: () => {
          selectClient(c.id);
          navigate("dashboard");
        },
      })),
    ];
    return pages.filter((p) => p.label.toLowerCase().includes(term)).sort((a, b) => a.label.toLowerCase().indexOf(term) - b.label.toLowerCase().indexOf(term)).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, clients, requests]);

  function open(d: Dest) {
    if (d.screen === "edit") openStudio(d.area ?? null);
    else if (d.screen) navigate(d.screen);
  }

  const failedCount = failed?.count ?? 0;
  const needs: Array<{ key: string; label: string; icon: string; tone?: "bad"; count: number | null; screen: ScreenId }> = [
    { key: "failed", label: "Failed posts", icon: "#i-alert", tone: "bad", count: failedCount, screen: "failed" },
    { key: "approvals", label: "Approvals", icon: "#i-check-circle", count: null, screen: "approvals" },
    { key: "ready", label: "Ready queue", icon: "#i-trello", count: ready, screen: "ready" },
    { key: "queue", label: "Upload queue", icon: "#i-up", count: queue, screen: "queue" },
  ];

  return (
    <div className="screen active mb-page" data-screen="more" data-state="ready">
      <div className="mb-head">
        <div>
          <div className="mb-eyebrow">Everything else</div>
          <h1 className="mb-h1">More</h1>
        </div>
      </div>

      <label className="mb-search big">
        <Svg href="#i-search" />
        <input type="search" placeholder="Jump to a screen" value={q} onChange={(e) => setQ(e.target.value)} data-testid="more.search" />
      </label>
      {q.trim() && (
        <div className="mb-card list" data-testid="more.results">
          {hits.length ? (
            hits.map((h) => (
              <button key={h.key} type="button" className="mb-lrow" onClick={h.run}>
                <span className="mb-lic n">
                  <Svg href={h.icon} />
                </span>
                <span className="mb-lt">
                  <b>{h.label}</b>
                  <small>{h.sub}</small>
                </span>
                <Svg href="#i-chev-r" />
              </button>
            ))
          ) : (
            <p className="mb-p muted">Nothing called that. Try "fin" or "settings".</p>
          )}
        </div>
      )}

      <div className="mb-quick4">
        {needs.map((n) => (
          <a key={n.key} className="mb-q" {...linkProps(n.screen)} data-testid={`more.needs.${n.key}`}>
            <span className={`mb-lic${n.tone ? ` ${n.tone}` : ""}`}>
              <Svg href={n.icon} />
            </span>
            {n.label}
            {!!n.count && <span className={`mb-badge${n.tone ? ` ${n.tone}` : ""}`}>{n.count}</span>}
          </a>
        ))}
      </div>

      {groups.map((g) => (
        <section key={g.title} className="mb-grp" aria-label={g.title}>
          <h3>{g.title}</h3>
          <div className="mb-mt">
            {g.items.map((d) => (
              <button key={d.label} type="button" className="mb-m" onClick={() => open(d)} data-testid={`more.${d.label.toLowerCase().replace(/\s+/g, "-")}`}>
                <span className="mb-lic">
                  <Svg href={d.icon} />
                </span>
                <span className="mb-grow">{d.label}</span>
                {!!d.count && <span className="mb-badge bad">{d.count}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}

      <section className="mb-card list">
        <a className="mb-lrow" {...linkProps("settings")} data-testid="more.settings">
          <span className="mb-lic n">
            <Svg href="#i-gear" />
          </span>
          <span className="mb-lt">
            <b>Settings</b>
            <small>Accounts, business, Trello labels, updates</small>
          </span>
          <Svg href="#i-chev-r" />
        </a>
        <button type="button" className="mb-lrow" role="switch" aria-checked={theme === "dark"} onClick={onToggleTheme} data-testid="mobile.theme">
          <span className="mb-lic n">
            <Svg href={theme === "light" ? "#i-sun" : "#i-moon"} />
          </span>
          <span className="mb-lt">
            <b>Dark theme</b>
            <small>{theme === "dark" ? "On" : "Off"}</small>
          </span>
          <span className={`mb-tog${theme === "dark" ? " on" : ""}`} aria-hidden="true" />
        </button>
        <button type="button" className="mb-lrow" onClick={() => setAskLogout(true)} data-testid="more.logout">
          <span className="mb-lic n">
            <Svg href="#i-logout" />
          </span>
          <span className="mb-lt">
            <b>Log out</b>
            <small>Signed in as the {user?.role ?? "operator"}</small>
          </span>
        </button>
      </section>
      <div className="mb-status" role="status" title={apiStatus.title}>
        <i style={{ background: apiStatus.color }} />
        {apiStatus.online ? (apiStatus.workerUp ? "API online, worker running" : "API online, worker offline") : "API offline"}
        {apiStatus.version ? `. Version ${apiStatus.version}` : ""}
      </div>

      {askLogout && (
        <ConfirmSheet
          title="Log out?"
          body="You will need your email and password to sign in again on this phone."
          confirm="Log out"
          danger
          onConfirm={logout}
          onClose={() => setAskLogout(false)}
        />
      )}
    </div>
  );
}
