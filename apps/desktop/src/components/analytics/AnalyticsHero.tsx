import Pf from "../Pf";
import { PF_ID, PLATFORM_LABELS, type Platform } from "../../lib/platforms";

/*
 * Analytics v6 top: the account's name and nothing else as the header,
 * oversized stats, a pill strip of each platform's real share of views, the
 * gradient glass profile card, and category tabs that jump to the sections
 * below. Kept in its own file so the page can be re-laid out without
 * touching the data code in AnalyticsScreen.
 */
export const AN_SECTIONS = [
  { id: "an-overview", label: "Overview" },
  { id: "an-views", label: "Views" },
  { id: "an-videos", label: "Videos" },
  { id: "an-platforms", label: "Platforms" },
  { id: "an-engagement", label: "Engagement" },
  { id: "an-growth", label: "Growth" },
] as const;

const PF_COLOR: Record<string, string> = {
  tiktok: "#25F4EE",
  instagram: "linear-gradient(90deg,#F58529,#DD2A7B)",
  youtube: "#FF3B30",
  facebook: "#1877F2",
};

export function AnalyticsTabs() {
  return (
    <nav className="an6-tabs glass-z1" aria-label="Analytics sections">
      {AN_SECTIONS.map((s) => (
        <button
          type="button"
          key={s.id}
          data-testid={`analytics.section.${s.id.slice(3)}`}
          onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}

export default function AnalyticsHero({
  name,
  avatar,
  initials,
  platforms,
  stats,
  shares,
  loading,
}: {
  name: string;
  avatar: string | null;
  initials: string;
  platforms: Platform[];
  stats: Array<{ label: string; value: string }>;
  shares: Array<{ platform: string; frac: number }>;
  loading: boolean;
}) {
  // A stat with no real figure ("-") is left out rather than shown as a dash.
  const real = stats.filter((s) => s.value !== "-");
  return (
    <div className="an6-hero" id="an-overview">
      <div className="an6-top">
        <div className="an6-namecol">
          <h1 className="an6-name" data-testid="analytics.name">{name}</h1>
          {shares.length > 0 && (
            <div className="an6-strip" aria-label="Share of views per platform" data-testid="analytics.platform-strip">
              {shares.map((s) => (
                <div key={s.platform} className="an6-pillwrap" style={{ flex: Math.max(s.frac, 0.08) }}>
                  <span className="tf-lbl">{PLATFORM_LABELS[s.platform as Platform] ?? s.platform}</span>
                  <div className="an6-pill">
                    <i style={{ width: `${Math.round(s.frac * 100)}%`, background: PF_COLOR[s.platform] ?? "var(--accent)" }} />
                    <b>{Math.round(s.frac * 100)}%</b>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="an6-stats">
          {real.map((s) => (
            <div className="an6-stat" key={s.label} data-testid={`analytics.stat.${s.label.split(" ")[0]!.toLowerCase()}`}>
              <div className="an6-statv">{loading ? "…" : s.value}</div>
              <div className="tf-lbl">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="an6-profile glass-z1" data-testid="analytics.profile">
        <div className="an6-orb">{avatar ? <img src={avatar} alt="" /> : <span>{initials}</span>}</div>
        <div className="an6-pname">
          <b>{name}</b>
          <span>
            {platforms.length
              ? `${platforms.length} connected platform${platforms.length === 1 ? "" : "s"}`
              : "No platforms connected"}
          </span>
        </div>
        <div className="an6-picons">
          {platforms.map((p) => (
            <Pf key={p} p={PF_ID[p]} size="sm" />
          ))}
        </div>
      </div>
    </div>
  );
}
