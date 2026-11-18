import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { sectionOf, type ScreenId } from "../lib/nav";
import { linkProps, navigate, setQuery, useRoute } from "../lib/routes";
import { useIsPhone } from "../lib/phone";
import { useAppState } from "../state/AppState";
import { api, fileUrl, videoLabel, type ClientSummary, type MediaAssetInfo, type PostTargetInfo, type SystemAlert } from "../lib/api";
import { useFailedPosts } from "../lib/failedPosts";
import { usePhoneBarState } from "../lib/phoneBar";
import { PF_ID } from "../lib/platforms";
import type { useApiStatus } from "./ApiStatus";
import BrandAvatar from "./BrandAvatar";
import Pf from "./Pf";
import { useToast } from "./Toasts";

/*
 * The phone shell (Direction C, then the mobile pass approved 2026-11-17): a
 * compact app bar with the brand switcher and the bell (or Back, a title and
 * one action on a deeper page), a bottom tab bar (Overview, Calendar, Create,
 * Ideas, Reports, More) and the sheets those open. More is a page (/more).
 * Renders nothing above the phone breakpoint, where the dock stays as it was.
 */

interface MobileNavProps {
  activeScreen: ScreenId;
  api: ReturnType<typeof useApiStatus>;
  onOpenConnect: () => void;
  alerts: SystemAlert[];
  onAlertsChanged: () => void;
}

type Sheet = "create" | "brand" | "alerts" | "offline" | null;

export function Svg({ children, href }: { children?: ReactNode; href?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {href ? <use href={href} /> : children}
    </svg>
  );
}

/** Studio with an area open; null is the editor itself. */
export function openStudio(area: "ideas" | "super" | "analyze" | "clips" | "kit" | "assets" | null) {
  navigate("edit");
  setQuery({ area });
}

/** "12 min ago", "Today, 8:02 AM", "Yesterday", "Nov 14". */
export function ago(isoTime: string, now = Date.now()): string {
  const t = new Date(isoTime);
  const mins = Math.round((now - t.getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const today = new Date(now);
  const time = t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (t.toDateString() === today.toDateString()) return `Today, ${time}`;
  const y = new Date(now - 864e5);
  if (t.toDateString() === y.toDateString()) return "Yesterday";
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "5 min ago", "2 hours ago", "3 days ago". */
export function since(isoTime: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - new Date(isoTime).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** Unique connected platforms of a brand, in the app's usual order. */
export function brandPlatforms(c: ClientSummary) {
  const order = ["instagram", "tiktok", "youtube", "facebook", "snapchat"];
  return [...new Set(c.accounts.filter((a) => a.status === "connected").map((a) => a.platform))].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
}

/** What each alert kind's fix button says and where it goes. */
function alertFix(a: SystemAlert): { label: string; run(): void } | null {
  const forClient = () => a.clientId && setQuery({ client: a.clientId });
  if (a.kind === "publish_auth") return { label: "Reconnect", run: () => navigate("settings", "accounts") };
  if (a.kind === "drive_check")
    return {
      label: "Open Drive auto-post",
      run: () => {
        navigate("workflows");
        forClient();
      },
    };
  if (a.kind === "report_publish" || a.kind === "report_build") return { label: "Open Reports", run: () => navigate("reports") };
  return null;
}

/** Brand sheet facts, cached for a minute so reopening the sheet is instant. */
type BrandFacts = { paused: boolean; next: string | null };
let factsCache: { at: number; facts: Record<string, BrandFacts> } | null = null;

export default function MobileNav(props: MobileNavProps) {
  const isPhone = useIsPhone();
  return isPhone ? <PhoneNav {...props} /> : null;
}

function PhoneNav({ activeScreen, api: apiStatus, onOpenConnect, alerts, onAlertsChanged }: MobileNavProps) {
  const { clients, selectedClient, selectClient } = useAppState();
  const { area, section } = useRoute();
  const toast = useToast();
  const bar = usePhoneBarState();
  const failed = useFailedPosts();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [pulse, setPulse] = useState(false);
  const [busyAlert, setBusyAlert] = useState<string | null>(null);
  const [facts, setFacts] = useState<Record<string, BrandFacts>>(() => factsCache?.facts ?? {});
  const [brandQuery, setBrandQuery] = useState("");
  const [resume, setResume] = useState<MediaAssetInfo | null>(null);
  const close = () => setSheet(null);
  const selectedIndex = clients.findIndex((c) => c.id === selectedClient?.id);
  const open = alerts.filter((a) => !a.dismissed).sort((a, b) => (a.severity === b.severity ? b.lastSeenAt.localeCompare(a.lastSeenAt) : a.severity === "error" ? -1 : 1));
  const failedCount = failed?.count ?? 0;

  const onIdeas = activeScreen === "edit" && (area === "ideas" || area === "super");
  const tab =
    onIdeas ? "ideas"
    : activeScreen === "calendar" ? "calendar"
    : activeScreen === "more" ? "more"
    : sectionOf(activeScreen).id === "overview" ? "overview"
    : sectionOf(activeScreen).id === "reports" ? "reports"
    : "more";

  // Escape closes a sheet; a route change closes it too.
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);
  useEffect(() => setSheet(null), [activeScreen, area, section]);

  // Phone-only page fixes that need the DOM: the active chip of every chip
  // row scrolled into view, and table cells labelled for the card layout.
  useEffect(() => {
    const main = document.querySelector(".main");
    if (!main) return;
    let raf = 0;
    const fix = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        main.querySelectorAll<HTMLElement>(".tf-tabs,.co-tabs,.seg,.tf-seg,.mcal-views,.mb-chips").forEach((row) => {
          const on = row.querySelector<HTMLElement>('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"],.on,.a');
          if (on && row.dataset.chipFor !== on.textContent) {
            row.dataset.chipFor = on.textContent ?? "";
            row.scrollLeft = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
          }
        });
        main.querySelectorAll("table:not(.mb-keep)").forEach((t) => {
          const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
          t.querySelectorAll("tbody tr").forEach((tr) =>
            [...tr.children].forEach((td, i) => heads[i] && !td.hasAttribute("data-label") && td.setAttribute("data-label", heads[i]!)),
          );
        });
      });
    };
    fix();
    const mo = new MutationObserver(fix);
    mo.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-selected", "aria-current", "aria-pressed"] });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // A new error while the app is open: one toast and one pulse on the bell.
  const seen = useRef<Set<string> | null>(null);
  const alertRuns = useRef(0);
  useEffect(() => {
    const ids = new Set(open.map((a) => a.id));
    // Run 1 is the empty list before the first fetch, run 2 that fetch: only
    // alerts arriving after those are new while the app is open.
    if (++alertRuns.current > 2 && seen.current) {
      const fresh = open.find((a) => a.severity === "error" && !seen.current!.has(a.id));
      if (fresh) {
        toast.error(fresh.message, { label: "View", run: () => setSheet("alerts") });
        setPulse(true);
        window.setTimeout(() => setPulse(false), 1200);
      }
    }
    seen.current = ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts]);

  // Losing the connection swaps the bell for an Offline pill; coming back says so once.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!apiStatus.checked) return;
    if (!apiStatus.online) wasOffline.current = true;
    else if (wasOffline.current) {
      wasOffline.current = false;
      toast.success("Back online. Everything is up to date again.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiStatus.online, apiStatus.checked]);

  // Brand sheet facts: paused, and the next scheduled post, per brand.
  useEffect(() => {
    if (sheet !== "brand") return;
    if (factsCache && Date.now() - factsCache.at < 60_000) return;
    let gone = false;
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 21 * 864e5).toISOString();
    void Promise.all(
      clients.map(async (c): Promise<[string, BrandFacts]> => {
        const [pause, posts] = await Promise.all([
          api.get<{ paused: boolean }>(`/brands/${c.id}/pause`).catch(() => ({ paused: false })),
          api
            .get<PostTargetInfo[]>(`/clients/${c.id}/posts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
            .catch(() => [] as PostTargetInfo[]),
        ]);
        const next = posts
          .filter((p) => p.status === "scheduled" && p.scheduledAt && p.scheduledAt >= from)
          .map((p) => p.scheduledAt!)
          .sort()[0];
        return [c.id, { paused: !!pause.paused, next: next ?? null }];
      }),
    ).then((rows) => {
      factsCache = { at: Date.now(), facts: Object.fromEntries(rows) };
      if (!gone) setFacts(factsCache.facts);
    });
    return () => {
      gone = true;
    };
  }, [sheet, clients]);

  // Create sheet: the newest ready upload that is not scheduled yet.
  useEffect(() => {
    if (sheet !== "create" || !selectedClient) return;
    let gone = false;
    void Promise.all([
      api.get<MediaAssetInfo[]>(`/clients/${selectedClient.id}/media`).catch(() => [] as MediaAssetInfo[]),
      api.get<PostTargetInfo[]>(`/clients/${selectedClient.id}/posts`).catch(() => [] as PostTargetInfo[]),
    ]).then(([media, posts]) => {
      const used = new Set(posts.map((p) => p.mediaAssetId));
      const next = media
        .filter((m) => m.status === "ready" && !used.has(m.id) && !m.sourceDeletedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!gone) setResume(next ?? null);
    });
    return () => {
      gone = true;
    };
  }, [sheet, selectedClient]);

  const go = (fn: () => void) => () => {
    setSheet(null);
    fn();
  };

  const dismiss = async (id: string) => {
    setBusyAlert(id);
    try {
      await api.post(`/alerts/${id}/dismiss`, {});
      onAlertsChanged();
    } catch (err) {
      toast.fail("Could not mark it as seen", err);
    } finally {
      setBusyAlert(null);
    }
  };

  const compose = (type: "carousel" | "longform") => () => {
    sessionStorage.setItem("tf-compose-type", type);
    navigate("upload");
  };
  const TILES: Array<{ key: string; icon: string; title: string; sub: string; run: () => void }> = [
    { key: "photo", icon: "#i-image", title: "Photo post", sub: "Single or carousel", run: compose("carousel") },
    { key: "post", icon: "#i-calplus", title: "Plan a post", sub: "Pick a day", run: () => navigate("calendar") },
    { key: "generate", icon: "#i-spark", title: "Generate ideas", sub: "From your niche", run: () => openStudio("ideas") },
    { key: "super", icon: "#i-shuffle", title: "Super generate", sub: "Across creators", run: () => openStudio("super") },
    { key: "longform", icon: "#i-video", title: "Long-form", sub: "YouTube or Instagram", run: compose("longform") },
    { key: "studio", icon: "#i-film", title: "Edit in Studio", sub: "Cut and caption", run: () => openStudio(null) },
  ];

  // The active brand first, then the rest in their usual order.
  const shownBrands = (
    brandQuery.trim() ? clients.filter((c) => c.name.toLowerCase().includes(brandQuery.trim().toLowerCase())) : clients
  )
    .slice()
    .sort((a, b) => Number(b.id === selectedClient?.id) - Number(a.id === selectedClient?.id));
  const failedByBrand = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of failed?.items ?? []) m[it.brandId] = (m[it.brandId] ?? 0) + 1;
    return m;
  }, [failed]);

  if (bar?.hide) return null;
  const offline = apiStatus.checked && !apiStatus.online;

  return (
    <>
      <header className={`mb-top${bar ? " deeper" : ""}`}>
        {bar ? (
          <>
            <button type="button" className="mb-ib ghost" aria-label="Back" onClick={bar.back} data-testid="mobile.back">
              <Svg href="#i-chev-l" />
            </button>
            <h1 className="mb-bartitle">{bar.title}</h1>
            <span className="mb-baract">{bar.action ?? null}</span>
          </>
        ) : (
          <>
            <button
              type="button"
              className="mb-brand"
              aria-haspopup="dialog"
              aria-expanded={sheet === "brand"}
              aria-label={`Active brand: ${selectedClient?.name ?? "none"}. Switch brand`}
              onClick={() => setSheet(sheet === "brand" ? null : "brand")}
              data-testid="mobile.brand-switcher"
            >
              {selectedClient && <BrandAvatar client={selectedClient} index={selectedIndex} size={38} />}
              <span className="mb-brandtext">
                <small>Active brand</small>
                <b>{selectedClient?.name ?? (clients.length ? "Pick a brand" : "No brands yet")}</b>
              </span>
              <Svg href={sheet === "brand" ? "#i-chev-u" : "#i-chev"} />
            </button>
            <span className="mb-sp" />
            {offline ? (
              <button type="button" className="mb-offline" onClick={() => setSheet("offline")} data-testid="mobile.offline">
                <Svg href="#i-wifi-off" />
                Offline
              </button>
            ) : (
              <button
                type="button"
                className={`mb-ib${pulse ? " pulse" : ""}`}
                aria-haspopup="dialog"
                aria-label={open.length ? `${open.length} ${open.length === 1 ? "problem" : "problems"}, open alerts` : "Alerts, nothing needs you"}
                onClick={() => setSheet("alerts")}
                data-testid="mobile.alerts"
              >
                <Svg href="#i-bell" />
                {open.length > 0 && <span className={`mb-badge${open.some((a) => a.severity === "error") ? " bad" : ""}`}>{open.length}</span>}
              </button>
            )}
          </>
        )}
      </header>
      {offline && !bar && (
        <section className="mb-offbanner" role="alert" data-testid="mobile.offline-banner">
          <div className="mb-offmsg">
            <Svg href="#i-alert" />
            <span>
              <b>Can't reach Toreroflow</b>
              The server is not answering. What is on screen stays; saving and uploading wait until it answers again.
            </span>
          </div>
          <div className="mb-offacts">
            <button type="button" className="mb-btn" onClick={() => apiStatus.recheck()}>
              Retry now
            </button>
            <button type="button" className="mb-btn ghost" onClick={() => setSheet("offline")}>
              Status details
            </button>
          </div>
        </section>
      )}

      {sheet && <div className={`mb-scrim${sheet === "create" ? " above-tabs" : ""}`} onClick={close} aria-hidden="true" />}

      {sheet === "brand" && (
        <div className="mb-sheet" role="dialog" aria-modal="true" aria-label="Switch brand" data-testid="mobile.brand-sheet">
          <div className="mb-grab" aria-hidden="true" />
          <div className="mb-sh">
            <h2>Brands</h2>
            <button type="button" className="mb-ib" aria-label="Close" onClick={close}>
              <Svg href="#i-x" />
            </button>
          </div>
          <div className="mb-shb">
            {clients.length > 8 && (
              <label className="mb-search">
                <Svg href="#i-search" />
                <input type="search" placeholder="Find a brand" value={brandQuery} onChange={(e) => setBrandQuery(e.target.value)} />
              </label>
            )}
            <div className="mb-brows" role="menu" aria-label="Brands">
              {shownBrands.map((c) => {
                const on = c.id === selectedClient?.id;
                const f = facts[c.id];
                const fails = failedByBrand[c.id] ?? 0;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={`mb-brow${on ? " on" : ""}`}
                    onClick={go(() => selectClient(c.id))}
                    data-testid={`mobile.brand.${c.id}`}
                  >
                    <BrandAvatar client={c} index={clients.indexOf(c)} size={46} />
                    <span className="mb-browt">
                      <b>{c.name}</b>
                      <span className="mb-meta">
                        {brandPlatforms(c).map((p) => (
                          <Pf key={p} p={PF_ID[p]} size="xs" />
                        ))}
                        {fails > 0 ? (
                          <span className="mb-bad">{fails} failed</span>
                        ) : f?.paused ? (
                          <span className="mb-pill paused">Paused</span>
                        ) : f?.next ? (
                          <span>
                            Next post{" "}
                            {new Date(f.next).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}
                          </span>
                        ) : f ? (
                          <span>Nothing scheduled</span>
                        ) : null}
                      </span>
                    </span>
                    {on && (
                      <span className="mb-ck">
                        <Svg href="#i-check" />
                      </span>
                    )}
                  </button>
                );
              })}
              <button type="button" role="menuitem" className="mb-addb" onClick={go(onOpenConnect)} data-testid="mobile.brand.connect">
                <span className="mb-lic">
                  <Svg href="#i-plus" />
                </span>
                Connect a client
              </button>
            </div>
            <a className="mb-link" {...linkProps("settings", "accounts")} onClick={(e) => {
              e.preventDefault();
              setSheet(null);
              navigate("settings", "accounts");
            }}>
              Manage connected accounts
            </a>
          </div>
        </div>
      )}

      {sheet === "create" && (
        <div className="mb-sheet above-tabs" role="dialog" aria-modal="true" aria-label="Create" data-testid="mobile.create-sheet">
          <div className="mb-grab" aria-hidden="true" />
          <div className="mb-sh">
            <div className="mb-ttl">
              <h2>Create</h2>
              {selectedClient && <small>for {selectedClient.name}</small>}
            </div>
            <button type="button" className="mb-ib" aria-label="Close" onClick={close}>
              <Svg href="#i-x" />
            </button>
          </div>
          <div className="mb-shb tight">
            <button type="button" className="mb-heroact" onClick={go(() => navigate("upload"))} data-testid="mobile.create.upload">
              <span className="mb-hi">
                <Svg href="#i-upload" />
              </span>
              <span>
                <b>Upload video</b>
                <small>From Photos, Files or Drive. AI drafts the title and caption.</small>
              </span>
            </button>
            <div className="mb-ctiles">
              {TILES.map((t, i) => (
                <button
                  key={t.key}
                  type="button"
                  className="mb-ctile"
                  style={{ animationDelay: `${(i + 1) * 30}ms` }}
                  onClick={go(t.run)}
                  data-testid={`mobile.create.${t.key}`}
                >
                  <span className="mb-lic">
                    <Svg href={t.icon} />
                  </span>
                  <span>
                    <b>{t.title}</b>
                    <small>{t.sub}</small>
                  </span>
                </button>
              ))}
            </div>
            {resume && (
              <>
                <div className="mb-lab">Continue where you left off</div>
                <button
                  type="button"
                  className="mb-resume"
                  onClick={go(() => {
                    navigate("upload");
                    sessionStorage.setItem("tf-open-asset", resume.id);
                  })}
                  data-testid="mobile.create.resume"
                >
                  <span className="mb-rthumb">{resume.thumbUrl && <img src={fileUrl(resume.thumbUrl) ?? undefined} alt="" />}</span>
                  <span className="mb-rt">
                    <b>{videoLabel(resume)}</b>
                    <small>Uploaded {since(resume.createdAt)}, not scheduled yet</small>
                  </span>
                  <Svg href="#i-chev-r" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {sheet === "alerts" && (
        <div className="mb-sheet full" role="dialog" aria-modal="true" aria-label="Alerts" data-testid="mobile.alerts-sheet">
          <div className="mb-grab" aria-hidden="true" />
          <div className="mb-sh">
            <div className="mb-ttl">
              <h2>Needs attention</h2>
              <small>{open.length ? `${open.length} open, errors first` : "Nothing open"}</small>
            </div>
            <button type="button" className="mb-ib" aria-label="Close" onClick={close}>
              <Svg href="#i-x" />
            </button>
          </div>
          <div className="mb-shb scroll">
            {failedCount > 0 && (
              <article className="mb-al err">
                <div className="mb-altop">
                  <span className="mb-lic bad">
                    <Svg href="#i-alert" />
                  </span>
                  <span className="mb-alt">
                    <b>
                      {failedCount} {failedCount === 1 ? "post" : "posts"} failed
                    </b>
                    <p>Nothing retries on its own. Each one has its reason and a Retry.</p>
                  </span>
                </div>
                <div className="mb-alacts">
                  <button type="button" className="mb-btn sm pri" onClick={go(() => navigate("failed"))}>
                    Open failed posts
                  </button>
                </div>
              </article>
            )}
            {open.map((a) => {
              const fix = alertFix(a);
              const ci = clients.findIndex((c) => c.id === a.clientId);
              return (
                <article key={a.id} className={`mb-al ${a.severity === "error" ? "err" : "warn"}`} data-testid={`mobile.alert.${a.id}`}>
                  <div className="mb-altop">
                    <span className={`mb-lic ${a.severity === "error" ? "bad" : "warn"}`}>
                      <Svg href={a.kind === "publish_auth" ? "#i-key" : a.kind === "drive_check" ? "#i-drive" : "#i-alert"} />
                    </span>
                    <span className="mb-alt">
                      {/* First sentence as the title, the rest (what to do) under it. */}
                      <b>{a.message.split(/(?<=\.)\s+/)[0]}</b>
                      {(a.message.split(/(?<=\.)\s+/).slice(1).join(" ") || a.count > 1) && (
                        <p>
                          {a.message.split(/(?<=\.)\s+/).slice(1).join(" ")}
                          {a.count > 1 ? ` Happened ${a.count} times.` : ""}
                        </p>
                      )}
                    </span>
                  </div>
                  <div className="mb-almeta">
                    {ci >= 0 && <BrandAvatar client={clients[ci]!} index={ci} size={20} />}
                    {a.clientName && <span>{a.clientName}</span>}
                    {a.clientName && <span>·</span>}
                    <span>{ago(a.lastSeenAt)}</span>
                  </div>
                  {a.detail && <div className="mb-tech">{a.detail}</div>}
                  <div className="mb-alacts">
                    <button type="button" className="mb-btn sm ghost" disabled={busyAlert === a.id} onClick={() => void dismiss(a.id)}>
                      {busyAlert === a.id ? "Saving" : "Got it"}
                    </button>
                    {fix && (
                      <button type="button" className={`mb-btn sm${a.severity === "error" ? " pri" : ""}`} onClick={go(fix.run)}>
                        {fix.label}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
            {!open.length && !failedCount && (
              <div className="mb-empty">
                <span className="mb-ei">
                  <Svg href="#i-check-circle" />
                </span>
                <h3>Nothing needs you</h3>
                <p>Publishing, reports and Drive auto-post are all working.</p>
              </div>
            )}
            {open.length > 0 && (
              <button type="button" className="mb-btn text" onClick={close}>
                Hide these for now
              </button>
            )}
          </div>
        </div>
      )}

      {sheet === "offline" && (
        <div className="mb-sheet" role="dialog" aria-modal="true" aria-label="Offline" data-testid="mobile.offline-sheet">
          <div className="mb-grab" aria-hidden="true" />
          <div className="mb-sh">
            <div className="mb-ttl">
              <h2>Can't reach Toreroflow</h2>
              <small>{apiStatus.label}</small>
            </div>
            <button type="button" className="mb-ib" aria-label="Close" onClick={close}>
              <Svg href="#i-x" />
            </button>
          </div>
          <div className="mb-shb">
            <p className="mb-p">
              The server is not answering, so new numbers and changes wait. What is on screen stays, and saving
              works again as soon as the connection is back. Toreroflow keeps trying on its own.
            </p>
            <div className="mb-sf">
              <button type="button" className="mb-btn" onClick={close}>
                Close
              </button>
              <button
                type="button"
                className="mb-btn pri"
                onClick={() => {
                  apiStatus.recheck();
                  close();
                }}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      )}

      <nav className="mb-tabs" aria-label="Primary">
        <a className={tab === "overview" ? "on" : undefined} aria-current={tab === "overview" ? "page" : undefined} {...linkProps("dashboard")} data-testid="mobile.tab.overview">
          <span className="mb-ti"><Svg href="#i-dash" /></span>
          <span>Overview</span>
        </a>
        <a className={tab === "calendar" ? "on" : undefined} aria-current={tab === "calendar" ? "page" : undefined} {...linkProps("calendar")} data-testid="mobile.tab.calendar">
          <span className="mb-ti"><Svg href="#i-cal" /></span>
          <span>Calendar</span>
          {failedCount > 0 && <span className="mb-badge bad" aria-label={`${failedCount} failed`}>{failedCount}</span>}
        </a>
        <button
          type="button"
          className={`mb-create${sheet === "create" ? " open" : ""}`}
          aria-expanded={sheet === "create"}
          aria-haspopup="dialog"
          onClick={() => setSheet(sheet === "create" ? null : "create")}
          data-testid="mobile.tab.create"
        >
          <span className="mb-fab"><Svg href="#i-plus" /></span>
          <span>{sheet === "create" ? "Close" : "Create"}</span>
        </button>
        <a
          className={tab === "ideas" ? "on" : undefined}
          aria-current={tab === "ideas" ? "page" : undefined}
          href={`/create/edit?area=ideas`}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            openStudio("ideas");
          }}
          data-testid="mobile.tab.ideas"
        >
          <span className="mb-ti"><Svg href="#i-bulb" /></span>
          <span>Ideas</span>
        </a>
        <a className={tab === "reports" ? "on" : undefined} aria-current={tab === "reports" ? "page" : undefined} {...linkProps("reports")} data-testid="mobile.tab.reports">
          <span className="mb-ti"><Svg href="#i-report" /></span>
          <span>Reports</span>
        </a>
        <a
          className={tab === "more" ? "on" : undefined}
          aria-current={tab === "more" ? "page" : undefined}
          {...linkProps("more")}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            // Tapping More again scrolls the page back to the top.
            if (activeScreen === "more") document.querySelector(".main")?.scrollTo({ top: 0, behavior: "smooth" });
            else navigate("more");
          }}
          data-testid="mobile.tab.more"
        >
          <span className="mb-ti"><Svg href="#i-dots-h" /></span>
          <span>More</span>
          {failedCount > 0 && <span className="mb-badge dot" aria-label="Something needs you" />}
        </a>
      </nav>
    </>
  );
}
