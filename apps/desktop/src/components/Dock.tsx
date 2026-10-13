import { useEffect, useRef, useState } from "react";
import { SECTIONS, sectionOf, type ScreenId } from "../lib/nav";
import type { Theme } from "../lib/theme";
import { useAppState } from "../state/AppState";
import { useApiStatus } from "./ApiStatus";
import BrandAvatar from "./BrandAvatar";

interface DockProps {
  activeScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenConnect: () => void;
  /** Hover text for the Measure bell; null hides it. */
  reportNotice: string | null;
  /** Open background failures, shown wherever the operator is. */
  alertCount: number;
  alertIsError: boolean;
}

/**
 * The bottom dock that replaced the sidebar: API status on the left, the four
 * sections in the middle, theme and the active brand on the right. A section
 * opens its first page; the page tabs live in each screen's header.
 */
export default function Dock({
  activeScreen,
  onNavigate,
  theme,
  onToggleTheme,
  onOpenConnect,
  reportNotice,
  alertCount,
  alertIsError,
}: DockProps) {
  const { clients, selectedClient, selectClient } = useAppState();
  const api = useApiStatus();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = sectionOf(activeScreen).id;
  const selectedIndex = clients.findIndex((c) => c.id === selectedClient?.id);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <nav className="dock glass-z1" aria-label="Primary">
      <span className="di di-status" title={api.title} role="status" data-testid="nav.api-status">
        <span className="tf-dot" style={{ background: api.color, boxShadow: `0 0 10px ${api.color}` }} />
        <span className="di-lbl">{api.label}</span>
      </span>
      {alertCount > 0 && (
        <button
          type="button"
          className={`di di-alert${alertIsError ? " bad" : ""}`}
          onClick={() => onNavigate("reports")}
          title="Open the Reports screen to see what failed"
          data-testid="nav.alerts"
        >
          <span className="tf-badge">{alertCount}</span>
          <span className="di-lbl">{alertCount === 1 ? "problem" : "problems"}</span>
        </button>
      )}
      <span className="sep" />

      {SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`di${active === s.id ? " on" : ""}`}
          aria-current={active === s.id ? "page" : undefined}
          aria-label={s.label}
          title={s.id === "measure" && reportNotice ? reportNotice : s.label}
          onClick={() => onNavigate(s.pages[0]!.id)}
          data-testid={`nav.section.${s.id}`}
        >
          <svg aria-hidden="true">
            <use href={s.icon} />
          </svg>
          <span className="di-lbl">{s.label}</span>
          {s.id === "measure" && reportNotice && <span className="tf-bell" aria-hidden="true" />}
        </button>
      ))}

      <span className="sep" />
      <button
        type="button"
        className="di"
        role="switch"
        aria-checked={theme === "dark"}
        aria-label="Dark theme"
        onClick={onToggleTheme}
        data-testid="theme.toggle"
      >
        <svg aria-hidden="true">
          <use href={theme === "light" ? "#i-sun" : "#i-moon"} />
        </svg>
        <span className={`tog${theme === "dark" ? " on" : ""}`} aria-hidden="true" />
      </button>

      <div className="tf-brandwrap" ref={wrapRef}>
        <button
          type="button"
          className="di di-brand"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Active brand: ${selectedClient?.name ?? "none"}. Switch brand`}
          onClick={() => setMenuOpen((o) => !o)}
          data-testid="brand-switcher.open"
        >
          {selectedClient && <BrandAvatar client={selectedClient} index={selectedIndex} />}
          <span className="di-lbl di-brandtext">
            <b>{selectedClient?.name ?? (clients.length ? "Pick a brand" : "No brands yet")}</b>
            <small>Active brand ▾</small>
          </span>
        </button>
        {menuOpen && (
          <div className="tf-menu glass-z3" role="menu" aria-label="Brands">
            {clients.map((client, i) => (
              <button
                key={client.id}
                type="button"
                role="menuitemradio"
                aria-checked={client.id === selectedClient?.id}
                className={`tf-mi${client.id === selectedClient?.id ? " on" : ""}`}
                onClick={() => {
                  selectClient(client.id);
                  setMenuOpen(false);
                }}
                data-testid={`brand-switcher.option.${client.id}`}
              >
                <BrandAvatar client={client} index={i} size={28} />
                {client.name}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className="tf-mi tf-mi-add"
              onClick={() => {
                setMenuOpen(false);
                onOpenConnect();
              }}
              data-testid="brand-switcher.add-client"
            >
              + Connect client
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
