import { useAppState } from "../state/AppState";

interface CalendarScreenProps {
  onNewPost(): void;
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function currentWeek(): Date[] {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return DOW.map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

export default function CalendarScreen({ onNewPost }: CalendarScreenProps) {
  const { selectedClient } = useAppState();
  const week = currentWeek();
  const today = new Date().toDateString();
  const first = week[0]!;
  const last = week[6]!;
  const range =
    first.getMonth() === last.getMonth()
      ? `${MONTHS[first.getMonth()]} ${first.getDate()} to ${last.getDate()}, ${last.getFullYear()}`
      : `${MONTHS[first.getMonth()]} ${first.getDate()} to ${MONTHS[last.getMonth()]} ${last.getDate()}, ${last.getFullYear()}`;

  return (
    <section className="screen active" data-screen="calendar">
      <div className="topbar">
        <div className="h">
          <h2>Content Calendar</h2>
          <p>Nothing scheduled yet.</p>
        </div>
        <button className="btn ghost" onClick={onNewPost}>
          <svg>
            <use href="#i-plus" />
          </svg>{" "}
          New post
        </button>
      </div>
      <div className="stage">
        <div className="calbar">
          <div className="seg">
            <span>Day</span>
            <span className="on">Week</span>
            <span>Month</span>
          </div>
          <div className="filterchip">
            <span className="d" style={{ background: "var(--v)" }} />{" "}
            {selectedClient?.name ?? "All brands"}
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
          <div style={{ marginLeft: "auto", fontSize: 13, color: "var(--txt-2)" }}>{range}</div>
        </div>
        <div className="cal glass">
          {week.map((day, i) => (
            <div className="col" key={i}>
              <div className={`colhead${day.toDateString() === today ? " today" : ""}`}>
                <div className="dow">{DOW[i]}</div>
                <div className="dnum">{day.getDate()}</div>
              </div>
              <div className="slotwrap">
                <div className="ghost-ev" onClick={onNewPost}>
                  + Add post
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="note">
          Posts you schedule will appear here color-coded by platform, with drag-to-reschedule
          on the way.
        </div>
      </div>
    </section>
  );
}
