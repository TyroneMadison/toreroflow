import { useEffect, useRef, useState } from "react";
import type { ScreenId } from "../App";
import type { Theme } from "../lib/theme";
import { useAppState } from "../state/AppState";
import ApiStatus from "./ApiStatus";

interface SidebarProps {
  activeScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenConnect: () => void;
}

interface NavItemDef {
  target: ScreenId;
  icon: string;
  label: string;
  badge?: string;
}

const CREATE_NAV: NavItemDef[] = [
  { target: "upload", icon: "#i-upload", label: "Upload & Schedule" },
  { target: "calendar", icon: "#i-cal", label: "Calendar" },
  { target: "workflows", icon: "#i-bolt", label: "Workflows" },
];

const MEASURE_NAV: NavItemDef[] = [
  { target: "analytics", icon: "#i-chart", label: "Analytics" },
  { target: "accounts", icon: "#i-users", label: "Accounts" },
];

const WORKSPACE_NAV: NavItemDef[] = [
  { target: "settings", icon: "#i-sliders", label: "Settings" },
];

function NavItem({
  item,
  active,
  onNavigate,
}: {
  item: NavItemDef;
  active: boolean;
  onNavigate: (screen: ScreenId) => void;
}) {
  return (
    <div
      className={`nav${active ? " active" : ""}`}
      onClick={() => onNavigate(item.target)}
    >
      <svg>
        <use href={item.icon} />
      </svg>{" "}
      {item.label}
      {item.badge && <span className="badge">{item.badge}</span>}
    </div>
  );
}

export default function Sidebar({
  activeScreen,
  onNavigate,
  theme,
  onToggleTheme,
  onOpenConnect,
}: SidebarProps) {
  const { clients, selectedClient, selectClient } = useAppState();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const renderNav = (items: NavItemDef[]) =>
    items.map((item) => (
      <NavItem
        key={item.label}
        item={item}
        active={item.target === activeScreen}
        onNavigate={onNavigate}
      />
    ));

  return (
    <aside className="side glass">
      <div className="brand">
        <div className="logo">
          <svg viewBox="0 0 24 24">
            <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
          </svg>
        </div>
        <div>
          <h1>
            <span>Toreroflow</span>
          </h1>
          <small>by Torerone</small>
        </div>
      </div>

      <div className="navlabel">Create</div>
      {renderNav(CREATE_NAV)}

      <div className="navlabel">Measure</div>
      {renderNav(MEASURE_NAV)}

      <div className="navlabel">Workspace</div>
      {renderNav(WORKSPACE_NAV)}

      <div className="side-foot">
        <ApiStatus />
        <div className="themetoggle" onClick={onToggleTheme}>
          <svg>
            <use href={theme === "light" ? "#i-sun" : "#i-moon"} />
          </svg>
          <span className="lbl">{theme === "light" ? "Light mode" : "Dark mode"}</span>
          <span className="knob" />
        </div>

        <div className="brandwrap" ref={wrapRef}>
          {menuOpen && (
            <div className="brandmenu glass">
              {clients.map((client) => (
                <div
                  key={client.id}
                  className={`bm-item${client.id === selectedClient?.id ? " on" : ""}`}
                  onClick={() => {
                    selectClient(client.id);
                    setMenuOpen(false);
                  }}
                >
                  <div
                    className="avatar"
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      fontSize: 10,
                      background: "linear-gradient(135deg,#8b7bff,#4ea8ff)",
                    }}
                  >
                    {client.avatarSeed ?? client.name.slice(0, 2).toUpperCase()}
                  </div>
                  {client.name}
                </div>
              ))}
              {clients.length === 0 && (
                <div className="bm-item" style={{ cursor: "default", color: "var(--txt-3)" }}>
                  No brands yet
                </div>
              )}
              <div
                className="bm-item bm-add"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenConnect();
                }}
              >
                + Add brand
              </div>
            </div>
          )}

          <div className="client-pill glass-sm" onClick={() => setMenuOpen((o) => !o)}>
            {selectedClient ? (
              <>
                <div
                  className="avatar"
                  style={{ background: "linear-gradient(135deg,#8b7bff,#4ea8ff)" }}
                >
                  {selectedClient.avatarSeed ?? selectedClient.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="meta">
                  <b>{selectedClient.name}</b>
                  <span>Active brand</span>
                </div>
              </>
            ) : (
              <div className="meta">
                <b style={{ color: "var(--txt-3)" }}>No brand selected</b>
                <span>{clients.length ? "Pick a brand" : "Add your first brand"}</span>
              </div>
            )}
            <div className="chev" style={menuOpen ? { transform: "rotate(180deg)" } : undefined}>
              <svg>
                <use href="#i-chev" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
