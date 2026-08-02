import { useEffect, useMemo, useRef, useState } from "react";

interface GlassDateTimeProps {
  /** Local datetime value, "YYYY-MM-DDTHH:mm", same shape as datetime-local. */
  value: string;
  onChange(next: string): void;
  /** Earliest selectable day; past days render disabled. */
  minDate?: Date;
}

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Approximate rendered panel height, used only to choose a drop direction. */
const PANEL_HEIGHT = 330;

/** Breathing room between the panel and the edge of the window. */
const EDGE_GAP = 12;

/**
 * Below this the panel is not worth opening in that direction at all, so the
 * roomier side wins even if neither can show the whole thing.
 */
const MIN_USABLE_HEIGHT = 220;

export interface Placement {
  /** True to open above the trigger rather than below it. */
  up: boolean;
  /** How tall the panel may be before it has to scroll inside itself. */
  maxHeight: number;
}

/**
 * Which way the panel opens, and how much room it gets.
 *
 * The version this replaced only flipped upward when the whole panel fit
 * above. That is fine on a desktop and wrong on a laptop: when neither side
 * fits, it left the panel dropping downward past the bottom of the window,
 * clipped, with the last two weeks of the month unreachable. The window was
 * short, not the panel.
 *
 * So downward is still preferred, because that is what a picker normally
 * does, but when it does not fit the roomier side wins and the panel is told
 * how tall it may be. It scrolls inside itself from there.
 *
 * Pure so the three branches can be checked without a browser, since getting
 * this wrong reproduces the original bug exactly.
 */
export function choosePlacement(
  triggerTop: number,
  triggerBottom: number,
  windowHeight: number,
): Placement {
  const below = windowHeight - triggerBottom - EDGE_GAP;
  const above = triggerTop - EDGE_GAP;

  const up = below >= PANEL_HEIGHT ? false : above >= PANEL_HEIGHT ? true : above > below;
  const room = up ? above : below;
  // Floored, so a trigger jammed against an edge still opens something usable
  // and scrollable rather than a sliver nobody can read.
  return { up, maxHeight: Math.max(MIN_USABLE_HEIGHT, room) };
}

const pad = (n: number) => n.toString().padStart(2, "0");

function toValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseValue(v: string): Date {
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * Date and time picker styled to the app's glass language. Replaces the
 * native datetime-local popup, whose panel is browser chrome and cannot be
 * themed with CSS.
 */
export default function GlassDateTime({ value, onChange, minDate }: GlassDateTimeProps) {
  const selected = useMemo(() => parseValue(value), [value]);
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [viewMonth, setViewMonth] = useState(
    () => new Date(selected.getFullYear(), selected.getMonth(), 1),
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hourColRef = useRef<HTMLDivElement | null>(null);
  const minuteColRef = useRef<HTMLDivElement | null>(null);
  /**
   * How tall the panel may be, given where the trigger sits in the window.
   * Null until it has been measured, which is also the "no clamp yet" state.
   */
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  const place = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const { up, maxHeight: room } = choosePlacement(r.top, r.bottom, window.innerHeight);
    setDropUp(up);
    setMaxHeight(room);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Resizing the window while the panel is open changes how much room it
    // has, and this app is resized often. Without this the panel keeps the
    // height it was given when it opened and clips again.
    const onResize = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Bring the chosen hour and minute into view instead of leaving both columns at the top.
  useEffect(() => {
    if (!open) return;
    for (const col of [hourColRef.current, minuteColRef.current]) {
      const el = col?.querySelector<HTMLElement>(".on");
      if (el && col) col.scrollTop = el.offsetTop - col.clientHeight / 2 + el.clientHeight / 2;
    }
  }, [open]);

  const commit = (next: Date) => onChange(toValue(next));

  const pickDay = (day: number) => {
    const next = new Date(selected);
    next.setFullYear(viewMonth.getFullYear(), viewMonth.getMonth(), day);
    commit(next);
  };

  const hour12 = selected.getHours() % 12 === 0 ? 12 : selected.getHours() % 12;
  const isPm = selected.getHours() >= 12;

  const setHour12 = (h: number) => {
    const next = new Date(selected);
    next.setHours((h % 12) + (isPm ? 12 : 0));
    commit(next);
  };
  const setMinute = (m: number) => {
    const next = new Date(selected);
    next.setMinutes(m);
    commit(next);
  };
  const setMeridiem = (pm: boolean) => {
    const next = new Date(selected);
    next.setHours((selected.getHours() % 12) + (pm ? 12 : 0));
    commit(next);
  };

  const firstWeekday = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();
  const daysInMonth = new Date(
    viewMonth.getFullYear(),
    viewMonth.getMonth() + 1,
    0,
  ).getDate();

  const floor = minDate ? new Date(minDate) : null;
  if (floor) floor.setHours(0, 0, 0, 0);

  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const label = selected.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="gdt" ref={wrapRef}>
      <button
        type="button"
        className="gdt-trigger field-in"
        onClick={() => {
          place();
          setOpen((o) => !o);
        }}
      >
        <span>{label}</span>
        <svg className="gdt-cal">
          <use href="#i-cal" />
        </svg>
      </button>

      {open && (
        <div
          className={`gdt-pop glass${dropUp ? " up" : ""}`}
          style={maxHeight !== null ? { maxHeight } : undefined}
        >
          <div className="gdt-cols">
            <div className="gdt-cal-side">
              <div className="gdt-head">
                <b>
                  {MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}
                </b>
                <div className="gdt-nav">
                  <button
                    type="button"
                    onClick={() =>
                      setViewMonth(
                        new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1),
                      )
                    }
                    aria-label="Previous month"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setViewMonth(
                        new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1),
                      )
                    }
                    aria-label="Next month"
                  >
                    ›
                  </button>
                </div>
              </div>

              <div className="gdt-grid gdt-dow">
                {DAY_LABELS.map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </div>
              <div className="gdt-grid">
                {cells.map((day, i) => {
                  if (day === null) return <span key={`b${i}`} className="gdt-blank" />;
                  const thisDay = new Date(
                    viewMonth.getFullYear(),
                    viewMonth.getMonth(),
                    day,
                  );
                  const disabled = floor ? thisDay < floor : false;
                  return (
                    <button
                      type="button"
                      key={day}
                      className={`gdt-day${sameDay(thisDay, selected) ? " on" : ""}${
                        sameDay(thisDay, new Date()) ? " today" : ""
                      }`}
                      disabled={disabled}
                      onClick={() => pickDay(day)}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="gdt-time">
              <div className="gdt-col" ref={hourColRef}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                  <button
                    type="button"
                    key={h}
                    className={h === hour12 ? "on" : undefined}
                    onClick={() => setHour12(h)}
                  >
                    {pad(h)}
                  </button>
                ))}
              </div>
              <div className="gdt-col" ref={minuteColRef}>
                {Array.from({ length: 60 }, (_, i) => i).map((m) => (
                  <button
                    type="button"
                    key={m}
                    className={m === selected.getMinutes() ? "on" : undefined}
                    onClick={() => setMinute(m)}
                  >
                    {pad(m)}
                  </button>
                ))}
              </div>
              <div className="gdt-col gdt-mer">
                <button
                  type="button"
                  className={!isPm ? "on" : undefined}
                  onClick={() => setMeridiem(false)}
                >
                  AM
                </button>
                <button
                  type="button"
                  className={isPm ? "on" : undefined}
                  onClick={() => setMeridiem(true)}
                >
                  PM
                </button>
              </div>
            </div>
          </div>

          <div className="gdt-foot">
            <span
              className="link"
              onClick={() => {
                const now = new Date(Date.now() + 10 * 60_000);
                setViewMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                commit(now);
              }}
            >
              In 10 minutes
            </span>
            <span className="link" onClick={() => setOpen(false)}>
              Done
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
