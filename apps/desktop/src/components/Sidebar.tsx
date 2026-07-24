import type { ScreenId } from "../App";
import type { Theme } from "../lib/theme";
import ApiStatus from "./ApiStatus";

interface SidebarProps {
  activeScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  theme: Theme;
  onToggleTheme: () => void;
}

interface NavItemDef {
  target: ScreenId;
  icon: string;
  label: string;
  badge?: string;
}

const CREATE_NAV: NavItemDef[] = [
  { target: "upload", icon: "#i-upload", label: "Upload & Schedule" },
  { target: "calendar", icon: "#i-cal", label: "Calendar", badge: "14" },
];

const MEASURE_NAV: NavItemDef[] = [
  { target: "analytics", icon: "#i-chart", label: "Analytics" },
  { target: "accounts", icon: "#i-users", label: "Accounts" },
];

// Matches the prototype: Automations points at the upload screen.
const WORKSPACE_NAV: NavItemDef[] = [
  { target: "upload", icon: "#i-sliders", label: "Automations" },
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
}: SidebarProps) {
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
        <div className="client-pill glass-sm">
          <div
            className="avatar"
            style={{ background: "linear-gradient(135deg,#8b7bff,#4ea8ff)" }}
          >
            HF
          </div>
          <div className="meta">
            <b>Halo Fitness</b>
            <span>Active client</span>
          </div>
          <div className="chev">
            <svg>
              <use href="#i-chev" />
            </svg>
          </div>
        </div>
      </div>
    </aside>
  );
}
