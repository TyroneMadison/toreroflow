import type { ReactNode } from "react";
import { sectionOf, type ScreenId } from "../lib/nav";
import { linkProps, SETTINGS_SECTIONS, useRoute } from "../lib/routes";

/**
 * Every screen's one h1: logo and title on the left, the section's pages as
 * tabs in the middle, the screen's own controls on the right. The tabs are
 * links, so each page has a URL that can be opened in a new tab or copied.
 * Settings has one page, so its tabs are its sections instead.
 */
export default function PageHeader({
  screen,
  title,
  subtitle,
  controls,
}: {
  screen: ScreenId;
  /** Defaults to the page's label. */
  title?: string;
  subtitle?: ReactNode;
  controls?: ReactNode;
}) {
  const { section: activeSection } = useRoute();
  const section = sectionOf(screen);
  const page = section.pages.find((p) => p.id === screen)!;
  const tabs =
    screen === "settings"
      ? SETTINGS_SECTIONS.map((s) => ({
          key: s.id,
          label: s.label,
          on: s.id === activeSection,
          link: linkProps("settings", s.id),
          testid: `settings.section.${s.id}`,
        }))
      : section.pages.filter((p) => !p.hidden || p.id === screen).map((p) => ({
          key: p.id,
          label: p.label,
          on: p.id === screen,
          link: linkProps(p.id),
          testid: `nav.page.${p.slug}`,
        }));
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
      {tabs.length > 1 && (
        <nav className="tf-tabs glass-z1" aria-label={section.label}>
          {tabs.map((t) => (
            <a
              key={t.key}
              aria-current={t.on ? "page" : undefined}
              className={t.on ? "a" : undefined}
              {...t.link}
              data-testid={t.testid}
            >
              {t.label}
            </a>
          ))}
        </nav>
      )}
      <div className="tf-ctr">{controls}</div>
    </header>
  );
}
