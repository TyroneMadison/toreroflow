import { useState } from "react";
import Pf, { type PlatformId } from "../components/Pf";

interface CalendarScreenProps {
  onOpenComposer: () => void;
}

type CalView = "Day" | "Week" | "Month";

interface CalEvent {
  color: "v" | "b";
  p: PlatformId;
  time: string;
  title: string;
  thumb?: string;
}

interface CalDay {
  dow: string;
  dnum: number;
  today?: boolean;
  ghost?: boolean;
  events: CalEvent[];
}

// Week of Jul 20-26, 2026 — content ported verbatim from the prototype.
const WEEK: CalDay[] = [
  {
    dow: "Mon",
    dnum: 20,
    events: [
      {
        color: "v",
        p: "ig",
        time: "5:15 PM",
        title: "5 protein myths busted",
        thumb: "linear-gradient(160deg,#31266b,#141f3f)",
      },
      { color: "b", p: "tt", time: "8:00 PM", title: "Mobility flow" },
    ],
  },
  {
    dow: "Tue",
    dnum: 21,
    ghost: true,
    events: [
      {
        color: "b",
        p: "yt",
        time: "3:10 PM",
        title: "Form check: squats",
        thumb: "linear-gradient(160deg,#142f4a,#122540)",
      },
    ],
  },
  {
    dow: "Wed",
    dnum: 22,
    events: [
      { color: "v", p: "sc", time: "12:30 PM", title: "Transformation reel" },
      {
        color: "v",
        p: "ig",
        time: "6:40 PM",
        title: "Posture fix in 60s",
        thumb: "linear-gradient(160deg,#2a2350,#0c1a2a)",
      },
    ],
  },
  {
    dow: "Thu",
    dnum: 23,
    today: true,
    events: [
      { color: "b", p: "tt", time: "7:20 PM", title: "Posture fix in 60s" },
      {
        color: "b",
        p: "yt",
        time: "5:00 PM",
        title: "Meal prep in 10 min",
        thumb: "linear-gradient(160deg,#31266b,#142f4a)",
      },
    ],
  },
  {
    dow: "Fri",
    dnum: 24,
    events: [
      {
        color: "v",
        p: "ig",
        time: "6:40 PM",
        title: "Weekend workout drop",
        thumb: "linear-gradient(160deg,#3a2360,#231a5a)",
      },
      { color: "v", p: "sc", time: "9:00 PM", title: "Behind the scenes" },
      { color: "b", p: "tt", time: "7:30 PM", title: "Q and A duet" },
    ],
  },
  {
    dow: "Sat",
    dnum: 25,
    ghost: true,
    events: [
      {
        color: "b",
        p: "yt",
        time: "11:00 AM",
        title: "Full 20 min HIIT",
        thumb: "linear-gradient(160deg,#1a2a55,#122f4a)",
      },
    ],
  },
  {
    dow: "Sun",
    dnum: 26,
    events: [
      { color: "v", p: "ig", time: "10:00 AM", title: "Sunday reset routine" },
      {
        color: "b",
        p: "tt",
        time: "6:00 PM",
        title: "Weekly recap",
        thumb: "linear-gradient(160deg,#2a2350,#141f3f)",
      },
    ],
  },
];

export default function CalendarScreen({ onOpenComposer }: CalendarScreenProps) {
  const [view, setView] = useState<CalView>("Week");

  return (
    <section className="screen active" data-screen="calendar">
      <div className="topbar">
        <div className="h">
          <h2>Content Calendar</h2>
          <p>14 posts scheduled across 5 clients this week.</p>
        </div>
        <button className="btn ghost" onClick={onOpenComposer}>
          <svg>
            <use href="#i-plus" />
          </svg>{" "}
          New post
        </button>
        <div className="iconbtn">
          <svg>
            <use href="#i-bell" />
          </svg>
          <span className="dot" />
        </div>
      </div>
      <div className="stage">
        <div className="calbar">
          <div className="seg">
            {(["Day", "Week", "Month"] as const).map((v) => (
              <span
                key={v}
                className={view === v ? "on" : undefined}
                onClick={() => setView(v)}
              >
                {v}
              </span>
            ))}
          </div>
          <div className="filterchip">
            <span className="d" style={{ background: "var(--v)" }} /> Halo Fitness
          </div>
          <div className="filterchip" style={{ opacity: 0.65 }}>
            <svg
              style={{ width: 14, height: 14, stroke: "currentColor", fill: "none", strokeWidth: 2 }}
              viewBox="0 0 24 24"
            >
              <use href="#i-globe" />
            </svg>{" "}
            All platforms
          </div>
          <div style={{ marginLeft: "auto", fontSize: 13, color: "var(--txt-2)" }}>
            Jul 20 to 26, 2026
          </div>
        </div>
        <div className="cal glass">
          {WEEK.map((day) => (
            <div key={day.dow} className="col">
              <div className={`colhead${day.today ? " today" : ""}`}>
                <div className="dow">{day.dow}</div>
                <div className="dnum">{day.dnum}</div>
              </div>
              <div className="slotwrap">
                {day.events.map((ev) => (
                  <div
                    key={`${ev.time}-${ev.title}`}
                    className={`ev ${ev.color}`}
                    onClick={onOpenComposer}
                  >
                    <div className="t1">
                      <Pf p={ev.p} size="sm" /> {ev.time}
                    </div>
                    <div className="t2">{ev.title}</div>
                    {ev.thumb && (
                      <div className="evthumb" style={{ background: ev.thumb }} />
                    )}
                  </div>
                ))}
                {day.ghost && <div className="ghost-ev">+ Add post</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
