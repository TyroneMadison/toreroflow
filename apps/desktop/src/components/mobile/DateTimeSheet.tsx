import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { scheduleTimeError } from "@toreroflow/core";

const pad = (n: number) => String(n).padStart(2, "0");
/** A local "YYYY-MM-DDTHH:mm", the value format the app's time fields use. */
export const toLocalValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const DOW = ["M", "T", "W", "T", "F", "S", "S"];
const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

/** One wheel: a snapping column, the picked value centred and lifted. */
function Wheel<T extends string | number>({ items, value, onPick, label, fmt, disabled }: {
  items: T[];
  value: T;
  onPick(v: T): void;
  label: string;
  fmt?(v: T): string;
  disabled?(v: T): boolean;
}) {
  const col = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = col.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && col.current) col.current.scrollTop = el.offsetTop - (col.current.clientHeight - el.offsetHeight) / 2;
  }, [value]);
  return (
    <div ref={col} className="mb-wheel" role="listbox" aria-label={label}>
      {items.map((v) => (
        <button
          key={String(v)}
          type="button"
          role="option"
          aria-selected={v === value}
          disabled={disabled?.(v)}
          onClick={() => onPick(v)}
        >
          {fmt ? fmt(v) : String(v)}
        </button>
      ))}
    </div>
  );
}

/**
 * The phone's date and time picker (mobile pass): a small sheet stacked over
 * the sheet it came from, a Monday-first month that matches the calendar
 * (past days off, today ringed, the picked day coral), wheels for hour,
 * minute and AM or PM, "In 10 minutes", and Set time. A time that has
 * already passed says so and keeps Set time off.
 */
export default function DateTimeSheet({
  title,
  sub,
  icon,
  value,
  onSet,
  onClose,
  minDate = new Date(),
}: {
  title: string;
  sub?: ReactNode;
  /** A platform tile beside the title. */
  icon?: ReactNode;
  value: string;
  onSet(next: string): void;
  onClose(): void;
  minDate?: Date;
}) {
  const start = useMemo(() => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }, [value]);
  const [day, setDay] = useState(() => new Date(start.getFullYear(), start.getMonth(), start.getDate()));
  const [month, setMonth] = useState(() => new Date(start.getFullYear(), start.getMonth(), 1));
  const [hour12, setHour12] = useState(() => ((start.getHours() + 11) % 12) + 1);
  const [minute, setMinute] = useState(() => start.getMinutes());
  const [pm, setPm] = useState(() => start.getHours() >= 12);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const picked = new Date(day.getFullYear(), day.getMonth(), day.getDate(), (hour12 % 12) + (pm ? 12 : 0), minute);
  const err = scheduleTimeError(picked);
  const today = new Date();
  const minDay = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate());
  const lead = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
  const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const minutes = MINUTES.includes(minute) ? MINUTES : [...MINUTES, minute].sort((a, b) => a - b);
  const set = (d: Date) => {
    setDay(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setHour12(((d.getHours() + 11) % 12) + 1);
    setMinute(d.getMinutes());
    setPm(d.getHours() >= 12);
  };

  return createPortal(
    <>
      <div className="mb-scrim top" onClick={onClose} aria-hidden="true" />
      <div className="mb-sheet top mb-dts" role="dialog" aria-modal="true" aria-label={title} data-testid="mobile.datetime">
        <div className="mb-grab" aria-hidden="true" />
        <div className="mb-sh">
          {icon}
          <div className="mb-ttl">
            <h2>{title}</h2>
            {sub && <small>{sub}</small>}
          </div>
          <button type="button" className="mb-ib" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-x" />
            </svg>
          </button>
        </div>
        <div className="mb-shb">
          <div className="mb-dtmonth">
            <b>{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</b>
            <span className="mb-hnav">
              <button type="button" className="mb-ib" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-chev-l" />
                </svg>
              </button>
              <button type="button" className="mb-ib" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-chev-r" />
                </svg>
              </button>
            </span>
          </div>
          <div className="mb-dtgrid" role="grid" aria-label="Day">
            {DOW.map((d, i) => (
              <span key={i} className="mb-dtdow">
                {d}
              </span>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <span key={`b${i}`} />
            ))}
            {Array.from({ length: daysIn }, (_, i) => {
              const d = new Date(month.getFullYear(), month.getMonth(), i + 1);
              const past = d < minDay;
              const on = d.toDateString() === day.toDateString();
              return (
                <button
                  key={i}
                  type="button"
                  className={`mb-dtday${on ? " on" : ""}${d.toDateString() === today.toDateString() ? " today" : ""}`}
                  disabled={past}
                  aria-pressed={on}
                  aria-label={d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
                  onClick={() => setDay(d)}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
          <div className="mb-dttime">
            <span className="mb-lab">Time</span>
            <button type="button" className="mb-chip" onClick={() => set(new Date(Date.now() + 10 * 60_000))}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-clock" />
              </svg>
              In 10 minutes
            </button>
          </div>
          <div className="mb-dtwheels">
            <Wheel<number> items={HOURS} value={hour12} onPick={setHour12} label="Hour" />
            <span className="mb-dtcolon">:</span>
            <Wheel<number> items={minutes} value={minute} onPick={setMinute} label="Minute" fmt={(m) => pad(m)} />
            <Wheel<string> items={["AM", "PM"]} value={pm ? "PM" : "AM"} onPick={(v) => setPm(v === "PM")} label="AM or PM" />
          </div>
          {err && (
            <div className="mb-err" role="alert">
              {err}
            </div>
          )}
          <div className="mb-sf">
            <button type="button" className="mb-btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="mb-btn pri"
              disabled={!!err}
              onClick={() => {
                onSet(toLocalValue(picked));
                onClose();
              }}
              data-testid="mobile.datetime.set"
            >
              Set time
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
