import { useEffect, useRef, type ReactNode } from "react";
import { sectionOf, type ScreenId } from "../lib/nav";
import { linkProps, SETTINGS_SECTIONS, useRoute } from "../lib/routes";
import { useIsPhone } from "../lib/phone";
import { useAppState } from "../state/AppState";

/** Screens that draw their own phone head (eyebrow, title, one line and an
 *  action), so the shared one steps aside on the phone. */
export const PHONE_SELF_HEAD = new Set<ScreenId>(["overview", "calendar", "preflight", "schedule"]);

/** Create pages that show the section's page chips on the phone (mockups). */
const CREATE_CHIPS = new Set<ScreenId>(["fanout", "queue", "ready", "approvals", "requests"]);

/** Phone subtitles for those pages; the screen's own line steps aside so it sits above the chips. */
const PHONE_SUB: Partial<Record<ScreenId, string>> = {
  financials: "What came in, what went out, and what is left.",
  fanout: "One draft for every platform. Override any one alone.",
  queue: "Client rush jumps ahead. Hold and drag to reorder the rest.",
  ready: "Cards in Trello's Ready for posting list, by client.",
  approvals: "Send a no-login link. The client approves or asks for changes.",
  requests: "Clients ask. A Trello card lands in the editor pipeline.",
};

/** Phone titles that differ from the page label (mobile pass mockups). */
const PHONE_TITLE: Partial<Record<ScreenId, string>> = {
  overview: "Accounts",
  upload: "Upload and schedule",
  reports: "Client reports",
};

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
  const isPhone = useIsPhone();
  const { user } = useAppState();
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
  // The phone chip row scrolls to show the page it is on, with the one before peeking.
  const chipRow = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = chipRow.current;
    const on = row?.querySelector<HTMLElement>(".a");
    if (row && on) row.scrollLeft = Math.max(0, on.offsetLeft - 48);
  }, [screen, isPhone]);
  if (isPhone && PHONE_SELF_HEAD.has(screen)) return null;
  if (isPhone) {
    // One head pattern on the phone: coral eyebrow, Fraunces title, and the
    // page chips for Reports and the Create queues (the rest live in More).
    const agency = user?.agencyName ?? "Torerone";
    const eyebrow =
      screen === "edit" ? "Studio"
      : screen === "settings" ? agency
      : screen === "financials" ? `Overview · ${agency}`
      : section.label;
    const chips = section.id === "reports" || CREATE_CHIPS.has(screen) ? tabs : [];
    return (
      <header className="tf-head mb-phead" data-phone-head={screen}>
        <div className="mb-ph">
          <div>
            <div className="mb-eyebrow">{eyebrow}</div>
            <h1 className="mb-h1">{PHONE_TITLE[screen] ?? title ?? page.label}</h1>
            {(subtitle ?? PHONE_SUB[screen]) && <div className="mb-sub">{subtitle ?? PHONE_SUB[screen]}</div>}
          </div>
        </div>
        {chips.length > 1 && (
          <nav className="tf-tabs mb-chips" aria-label={section.label} ref={chipRow}>
            {chips.map((t) => (
              <a key={t.key} aria-current={t.on ? "page" : undefined} className={t.on ? "a" : undefined} {...t.link} data-testid={t.testid}>
                {t.label}
              </a>
            ))}
          </nav>
        )}
        {controls && <div className="tf-ctr">{controls}</div>}
      </header>
    );
  }
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
