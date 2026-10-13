import type { ReactNode } from "react";
import { sectionOf, type ScreenId } from "../lib/nav";

/**
 * Every screen's one h1: logo and title on the left, the section's pages as
 * tabs in the middle, the screen's own controls on the right.
 */
export default function PageHeader({
  screen,
  onNavigate,
  title,
  subtitle,
  controls,
}: {
  screen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  /** Defaults to the page's label. */
  title?: string;
  subtitle?: ReactNode;
  controls?: ReactNode;
}) {
  const section = sectionOf(screen);
  const page = section.pages.find((p) => p.id === screen)!;
  return (
    <header className="tf-head">
      <div className="tf-logo">
        <div className="tf-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M7 10v12H3V10zm2 12V10l4-8c1.7 0 3 1.3 3 3l-1 5h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 19.1 22z" />
          </svg>
        </div>
        <div>
          <h1>{title ?? page.label}</h1>
          <div className="tf-sub">{subtitle ?? "Toreroflow by Torerone"}</div>
        </div>
      </div>
      {section.pages.length > 1 && (
        <div className="tf-tabs glass-z1" role="tablist" aria-label={section.label}>
          {section.pages.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === screen}
              className={p.id === screen ? "a" : undefined}
              onClick={() => onNavigate(p.id)}
              data-testid={`nav.page.${p.slug}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="tf-ctr">{controls}</div>
    </header>
  );
}
