import type { CSSProperties, ReactNode } from "react";

/*
 * The tall glass story card from Financials v3 and Reports v2: a header with
 * an icon or avatar and a badge, a short list of rows, then a big number with
 * a sparkline, and clear buttons along the bottom. Used by every redesigned
 * page, so they all read the same way.
 */
export interface StoryRow {
  key: string;
  label: ReactNode;
  value?: ReactNode;
  dot?: string;
  onClick?: () => void;
}

export default function Story({
  id,
  testId,
  tone,
  icon,
  title,
  sub,
  badge,
  badgeTone,
  rows,
  bigLabel,
  big,
  bigTone,
  foot,
  spark,
  actions,
  children,
}: {
  id?: string;
  testId?: string;
  tone?: string;
  icon?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  badge?: ReactNode;
  badgeTone?: "ok" | "warn" | "bad";
  rows?: StoryRow[];
  bigLabel?: ReactNode;
  big?: ReactNode;
  bigTone?: "ok" | "bad" | "info";
  foot?: ReactNode;
  spark?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article
      className="gx-story glass-z1"
      id={id}
      data-testid={testId}
      style={tone ? ({ "--story": tone } as CSSProperties) : undefined}
    >
      <div className="gx-ticks" aria-hidden="true">
        <i className="on" /><i className="on" /><i /><i />
      </div>
      <header className="gx-head">
        {icon && <div className="gx-ico">{icon}</div>}
        <div className="gx-title">
          <b>{title}</b>
          {sub && <span>{sub}</span>}
        </div>
        {badge && <span className={`gx-badge ${badgeTone ?? ""}`}>{badge}</span>}
      </header>
      {rows && rows.length > 0 && (
        <div className="gx-rows">
          {rows.map((r) => (
            <div
              key={r.key}
              className={`gx-row glass-z2${r.onClick ? " click" : ""}`}
              onClick={r.onClick}
              role={r.onClick ? "button" : undefined}
            >
              {r.dot && <span className="gx-dot" style={{ background: r.dot }} />}
              <span className="gx-rl">{r.label}</span>
              {r.value != null && <b>{r.value}</b>}
            </div>
          ))}
        </div>
      )}
      {children}
      <div className="gx-fill" />
      {big != null && (
        <div className="gx-bigwrap">
          {bigLabel && <div className="tf-lbl">{bigLabel}</div>}
          <div className={`gx-big ${bigTone ?? ""}`}>{big}</div>
          {foot && <div className="gx-foot">{foot}</div>}
        </div>
      )}
      {spark}
      {actions && <footer className="gx-actions">{actions}</footer>}
    </article>
  );
}
