import { useCallback, useEffect, useState } from "react";
import Pf from "../components/Pf";
import { api, fileUrl, type PostTargetInfo } from "../lib/api";
import { PF_ID, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";

interface CalendarScreenProps {
  onNewPost(): void;
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Instagram and Snapchat lean violet, TikTok and YouTube lean blue. */
const EV_CLASS: Record<Platform, "v" | "b"> = {
  instagram: "v",
  snapchat: "v",
  tiktok: "b",
  youtube: "b",
};

const STATUS_SUFFIX: Record<PostTargetInfo["status"], string> = {
  scheduled: "",
  publishing: " · publishing",
  posted: " · posted",
  failed: " · failed",
};

function currentWeek(): Date[] {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return DOW.map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function CalendarScreen({ onNewPost }: CalendarScreenProps) {
  const { selectedClient } = useAppState();
  const [targets, setTargets] = useState<PostTargetInfo[]>([]);
  const week = currentWeek();
  const today = new Date().toDateString();
  const first = week[0]!;
  const last = week[6]!;
  const weekEnd = new Date(last);
  weekEnd.setHours(23, 59, 59, 999);

  const load = useCallback(async () => {
    if (!selectedClient) {
      setTargets([]);
      return;
    }
    try {
      setTargets(
        await api.get<PostTargetInfo[]>(
          `/clients/${selectedClient.id}/posts?from=${first.toISOString()}&to=${weekEnd.toISOString()}`,
        ),
      );
    } catch {
      // API offline: keep whatever we have
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClient]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const scheduledCount = targets.filter(
    (t) => t.status === "scheduled" || t.status === "publishing",
  ).length;
  const range =
    first.getMonth() === last.getMonth()
      ? `${MONTHS[first.getMonth()]} ${first.getDate()} to ${last.getDate()}, ${last.getFullYear()}`
      : `${MONTHS[first.getMonth()]} ${first.getDate()} to ${MONTHS[last.getMonth()]} ${last.getDate()}, ${last.getFullYear()}`;

  const eventsFor = (day: Date) =>
    targets.filter(
      (t) => t.scheduledAt && new Date(t.scheduledAt).toDateString() === day.toDateString(),
    );

  return (
    <section className="screen active" data-screen="calendar">
      <div className="topbar">
        <div className="h">
          <h2>Content Calendar</h2>
          <p>
            {scheduledCount
              ? `${scheduledCount} ${scheduledCount === 1 ? "post" : "posts"} scheduled this week.`
              : "Nothing scheduled yet this week."}
          </p>
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
          {week.map((day, i) => {
            const events = eventsFor(day);
            return (
              <div className="col" key={i}>
                <div className={`colhead${day.toDateString() === today ? " today" : ""}`}>
                  <div className="dow">{DOW[i]}</div>
                  <div className="dnum">{day.getDate()}</div>
                </div>
                <div className="slotwrap">
                  {events.map((t) => {
                    const thumb = fileUrl(t.thumbUrl);
                    return (
                      <div
                        className={`ev ${EV_CLASS[t.platform]}`}
                        key={t.id}
                        title={t.error ?? t.caption ?? t.assetName}
                        style={t.status === "failed" ? { borderColor: "rgba(255,107,122,.5)" } : undefined}
                      >
                        <div className="t1">
                          <Pf p={PF_ID[t.platform]} size="sm" />{" "}
                          {t.scheduledAt ? fmtTime(t.scheduledAt) : ""}
                          {STATUS_SUFFIX[t.status]}
                        </div>
                        <div className="t2">{t.assetName}</div>
                        {thumb && (
                          <div
                            className="evthumb"
                            style={{
                              background: `url(${thumb}) center/cover`,
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                  {events.length === 0 && (
                    <div className="ghost-ev" onClick={onNewPost}>
                      + Add post
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="note">
          Posts are color-coded by platform. Failed posts show their error on hover;
          drag-to-reschedule is on the way.
        </div>
      </div>
    </section>
  );
}
