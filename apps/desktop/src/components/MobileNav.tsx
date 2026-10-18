import { useEffect, useState, type ReactNode } from "react";
import { SECTIONS, sectionOf, type ScreenId } from "../lib/nav";
import { linkProps, navigate, setQuery, SETTINGS_SECTIONS, useRoute } from "../lib/routes";
import { useIsPhone } from "../lib/phone";
import type { Theme } from "../lib/theme";
import { useAppState } from "../state/AppState";
import type { useApiStatus } from "./ApiStatus";
import BrandAvatar from "./BrandAvatar";

/*
 * The phone shell (Direction C, approved 2026-10): a compact top bar with the
 * brand switcher, a bottom tab bar (Overview, Calendar, Create, Ideas, More)
 * and the sheets those open. Renders nothing above the phone breakpoint, where
 * the dock stays exactly as it was.
 */

interface MobileNavProps {
  activeScreen: ScreenId;
  api: ReturnType<typeof useApiStatus>;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenConnect: () => void;
  alertCount: number;
  alertIsError: boolean;
}

type Sheet = "create" | "more" | "brand" | null;

/** Small line icons the shared sprite does not have. */
const Ico = {
  bulb: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />,
  dots: (
    <>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </>
  ),
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  shuffle: <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />,
  layers: <path d="M12 3 2 8l10 5 10-5zM2 16l10 5 10-5M2 12l10 5 10-5" />,
};

function Svg({ children, href }: { children?: ReactNode; href?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {href ? <use href={href} /> : children}
    </svg>
  );
}

/** Studio with an area open; null is the editor itself. */
function openStudio(area: "ideas" | "super" | "analyze" | null) {
  navigate("edit");
  setQuery({ area });
}

export default function MobileNav(props: MobileNavProps) {
  const isPhone = useIsPhone();
  return isPhone ? <PhoneNav {...props} /> : null;
}

function PhoneNav({ activeScreen, api, theme, onToggleTheme, onOpenConnect, alertCount, alertIsError }: MobileNavProps) {
  const { clients, selectedClient, selectClient } = useAppState();
  const { area, section } = useRoute();
  const [sheet, setSheet] = useState<Sheet>(null);
  const close = () => setSheet(null);
  const selectedIndex = clients.findIndex((c) => c.id === selectedClient?.id);

  const onIdeas = activeScreen === "edit" && (area === "ideas" || area === "super");
  const tab =
    sheet === "create" ? "create"
    : sheet === "more" ? "more"
    : onIdeas ? "ideas"
    : activeScreen === "calendar" ? "calendar"
    : sectionOf(activeScreen).id === "overview" ? "overview"
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
        main.querySelectorAll<HTMLElement>(".tf-tabs,.co-tabs,.seg,.tf-seg,.mcal-views").forEach((row) => {
          const on = row.querySelector<HTMLElement>('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"],.on,.a');
          if (on && row.dataset.chipFor !== on.textContent) {
            row.dataset.chipFor = on.textContent ?? "";
            row.scrollLeft = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
          }
        });
        main.querySelectorAll("table").forEach((t) => {
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

  const go = (fn: () => void) => () => {
    setSheet(null);
    fn();
  };

  const CREATE: Array<{ key: string; icon: ReactNode; title: string; sub: string; run: () => void; hero?: boolean }> = [
    { key: "upload", icon: <Svg href="#i-upload" />, title: "Upload video", sub: "Upload & Schedule · drafts title and caption", run: () => navigate("upload"), hero: true },
    { key: "generate", icon: <Svg>{Ico.spark}</Svg>, title: "Generate ideas", sub: "Ideas · from your niche and creators", run: () => openStudio("ideas") },
    { key: "super", icon: <Svg>{Ico.shuffle}</Svg>, title: "Super generate", sub: "Ideas split across your YouTube creators", run: () => openStudio("super") },
    { key: "post", icon: <Svg href="#i-cal" />, title: "New post", sub: "Calendar · pick a day and platforms", run: () => navigate("calendar") },
    { key: "carousel", icon: <Svg>{Ico.layers}</Svg>, title: "New carousel", sub: "Carousels · write slides, export to Canva", run: () => navigate("carousels") },
    { key: "studio", icon: <Svg href="#i-film" />, title: "Edit in Studio", sub: "Cut, score and plan a video", run: () => openStudio(null) },
  ];

  return (
    <>
      <header className="mb-top">
        <button
          type="button"
          className="mb-brand"
          aria-haspopup="dialog"
          aria-expanded={sheet === "brand"}
          aria-label={`Active brand: ${selectedClient?.name ?? "none"}. Switch brand`}
          onClick={() => setSheet(sheet === "brand" ? null : "brand")}
          data-testid="mobile.brand-switcher"
        >
          {selectedClient && <BrandAvatar client={selectedClient} index={selectedIndex} />}
          <span className="mb-brandtext">
            <small>Active brand</small>
            <b>{selectedClient?.name ?? (clients.length ? "Pick a brand" : "No brands yet")}</b>
          </span>
          <Svg href="#i-chev" />
        </button>
        {alertCount > 0 && (
          <a
            className={`mb-alert${alertIsError ? " bad" : ""}`}
            {...linkProps("reports")}
            aria-label={`${alertCount} ${alertCount === 1 ? "problem" : "problems"}, open Reports`}
            data-testid="mobile.alerts"
          >
            <Svg href="#i-bell" />
            <span className="tf-badge">{alertCount}</span>
          </a>
        )}
      </header>

      {sheet && <div className="mb-scrim" onClick={close} aria-hidden="true" />}

      {sheet === "brand" && (
        <div className="mb-sheet" role="dialog" aria-modal="true" aria-label="Switch brand" data-testid="mobile.brand-sheet">
          <div className="mb-grab" aria-hidden="true" />
          <div className="mb-sh">
            <h2>Brands</h2>
            <button type="button" className="mb-x" aria-label="Close" onClick={close}>
              <Svg href="#i-x" />
            </button>
          </div>
          <div className="mb-list" role="menu" aria-label="Brands">
            {clients.map((c, i) => (
              <button
                key={c.id}
                type="button"
                role="menuitemradio"
                aria-checked={c.id === selectedClient?.id}
                className={`mb-row${c.id === selectedClient?.id ? " on" : ""}`}
                onClick={go(() => selectClient(c.id))}
                data-testid={`mobile.brand.${c.id}`}
              >
                <BrandAvatar client={c} index={i} size={36} />
                <span className="mb-rowtext"><b>{c.name}</b></span>
                {c.id === selectedClient?.id && <Svg href="#i-check" />}
              </button>
            ))}
            <button type="button" role="menuitem" className="mb-row mb-add" onClick={go(onOpenConnect)}>
              <span className="mb-ic"><Svg href="#i-plus" /></span>
              <span className="mb-rowtext"><b>Connect client</b></span>
            </button>
          </div>
        </div>
      )}

      {sheet === "create" && (
        <div className="mb-sheet" role="dialog" aria-modal="true" aria-label="Create" data-testid="mobile.create-sheet">
          <div className="mb-grab" aria-hidden="true" />
          <div className="mb-sh">
            <h2>Create</h2>
            {selectedClient && <span className="mb-for">for {selectedClient.name}</span>}
          </div>
          <div className="mb-list">
            {CREATE.map((c) => (
              <button key={c.key} type="button" className="mb-row" onClick={go(c.run)} data-testid={`mobile.create.${c.key}`}>
                <span className={`mb-ic${c.hero ? " hero" : ""}`}>{c.icon}</span>
                <span className="mb-rowtext">
                  <b>{c.title}</b>
                  <small>{c.sub}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {sheet === "more" && (
        <div className="mb-sheet tall" role="dialog" aria-modal="true" aria-label="More" data-testid="mobile.more-sheet">
          <div className="mb-grab" aria-hidden="true" />
          <div className="mb-sh">
            <h2>Everything</h2>
            <button type="button" className="mb-x" aria-label="Close" onClick={close}>
              <Svg href="#i-x" />
            </button>
          </div>
          <div className="mb-scroll">
            {SECTIONS.map((s) => (
              <section key={s.id} className="mb-group" aria-label={s.label}>
                <h3>{s.label}</h3>
                <div className="mb-tiles">
                  {s.id === "settings"
                    ? SETTINGS_SECTIONS.map((x) => (
                        <a
                          key={x.id}
                          className={`mb-tile${activeScreen === "settings" && section === x.id ? " on" : ""}`}
                          {...linkProps("settings", x.id)}
                          data-testid={`mobile.more.settings.${x.id}`}
                        >
                          {x.label}
                        </a>
                      ))
                    : s.pages
                        .filter((p) => !p.hidden)
                        .flatMap((p) =>
                          p.id === "edit"
                            ? [
                                <button key="studio" type="button" className={`mb-tile${activeScreen === "edit" && !area ? " on" : ""}`} onClick={go(() => openStudio(null))} data-testid="mobile.more.studio">Studio</button>,
                                <button key="analyze" type="button" className={`mb-tile${activeScreen === "edit" && area === "analyze" ? " on" : ""}`} onClick={go(() => openStudio("analyze"))} data-testid="mobile.more.analyze">Analyze</button>,
                                <button key="ideas" type="button" className={`mb-tile${onIdeas ? " on" : ""}`} onClick={go(() => openStudio("ideas"))} data-testid="mobile.more.ideas">Ideas</button>,
                              ]
                            : [
                                <a
                                  key={p.id}
                                  className={`mb-tile${activeScreen === p.id ? " on" : ""}`}
                                  {...linkProps(p.id)}
                                  data-testid={`mobile.more.${p.slug}`}
                                >
                                  {p.label}
                                </a>,
                              ],
                        )}
                </div>
              </section>
            ))}
            <div className="mb-group">
              <button
                type="button"
                className="mb-row"
                role="switch"
                aria-checked={theme === "dark"}
                onClick={onToggleTheme}
                data-testid="mobile.theme"
              >
                <span className="mb-ic"><Svg href={theme === "light" ? "#i-sun" : "#i-moon"} /></span>
                <span className="mb-rowtext">
                  <b>Dark theme</b>
                  <small>{theme === "dark" ? "On" : "Off"}</small>
                </span>
                <span className={`tog${theme === "dark" ? " on" : ""}`} aria-hidden="true" />
              </button>
              <div className="mb-status" role="status" title={api.title}>
                <span className="tf-dot" style={{ background: api.color }} /> {api.label}
              </div>
            </div>
          </div>
        </div>
      )}

      <nav className="mb-tabs" aria-label="Primary">
        <a className={tab === "overview" ? "on" : undefined} aria-current={tab === "overview" ? "page" : undefined} {...linkProps("dashboard")} data-testid="mobile.tab.overview">
          <Svg href="#i-dash" />
          <span>Overview</span>
        </a>
        <a className={tab === "calendar" ? "on" : undefined} aria-current={tab === "calendar" ? "page" : undefined} {...linkProps("calendar")} data-testid="mobile.tab.calendar">
          <Svg href="#i-cal" />
          <span>Calendar</span>
        </a>
        <button
          type="button"
          className={`mb-create${sheet === "create" ? " open" : ""}`}
          aria-expanded={sheet === "create"}
          aria-haspopup="dialog"
          onClick={() => setSheet(sheet === "create" ? null : "create")}
          data-testid="mobile.tab.create"
        >
          <span className="mb-fab"><Svg href={sheet === "create" ? "#i-x" : "#i-plus"} /></span>
          <span>Create</span>
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
          <Svg>{Ico.bulb}</Svg>
          <span>Ideas</span>
        </a>
        <button
          type="button"
          className={tab === "more" ? "on" : undefined}
          aria-expanded={sheet === "more"}
          aria-haspopup="dialog"
          onClick={() => setSheet(sheet === "more" ? null : "more")}
          data-testid="mobile.tab.more"
        >
          <Svg>{Ico.dots}</Svg>
          <span>More</span>
        </button>
      </nav>
    </>
  );
}
