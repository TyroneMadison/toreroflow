import { useState } from "react";
import Pf, { type PlatformId } from "../components/Pf";

interface UploadScheduleProps {
  onOpenComposer: () => void;
}

type QueueState = "filled" | "loading" | "empty";

interface PlatformToggle {
  id: PlatformId;
  name: string;
  handle: string;
  on: boolean;
}

const INITIAL_TOGGLES: PlatformToggle[] = [
  { id: "ig", name: "Reels", handle: "@halofitness", on: true },
  { id: "tt", name: "TikTok", handle: "@halo.fit", on: true },
  { id: "yt", name: "Shorts", handle: "Halo Fitness", on: true },
  { id: "sc", name: "Spotlight", handle: "@halofit", on: false },
];

interface QueueItemDef {
  title: string;
  gradient: string;
  platforms: PlatformId[];
  when: string;
}

const QUEUE_ITEMS: QueueItemDef[] = [
  {
    title: "5 protein myths, busted",
    gradient: "linear-gradient(160deg,#31266b,#141f3f)",
    platforms: ["ig", "tt"],
    when: "Today 5:15 PM",
  },
  {
    title: "Morning mobility flow",
    gradient: "linear-gradient(160deg,#1a2a55,#122f4a)",
    platforms: ["yt", "tt"],
    when: "Today 8:00 PM",
  },
  {
    title: "Client transformation reel",
    gradient: "linear-gradient(160deg,#3a2360,#231a5a)",
    platforms: ["ig"],
    when: "Tomorrow 12:30 PM",
  },
];

const SKELETON_ROWS: Array<{ w1: string; w2: string }> = [
  { w1: "72%", w2: "46%" },
  { w1: "60%", w2: "52%" },
  { w1: "66%", w2: "40%" },
];

const BEST_TIMES: Array<{ p: PlatformId; label: string; time: string }> = [
  { p: "ig", label: "Instagram Reels", time: "6:40 PM" },
  { p: "tt", label: "TikTok", time: "7:20 PM" },
  { p: "yt", label: "YouTube Shorts", time: "3:10 PM" },
];

export default function UploadSchedule({ onOpenComposer }: UploadScheduleProps) {
  const [toggles, setToggles] = useState<PlatformToggle[]>(INITIAL_TOGGLES);
  const [queueState, setQueueState] = useState<QueueState>("filled");

  const togglePlatform = (id: PlatformId) => {
    setToggles((prev) =>
      prev.map((t) => (t.id === id ? { ...t, on: !t.on } : t)),
    );
  };

  return (
    <section className="screen active" data-screen="upload">
      <div className="topbar">
        <div className="h">
          <h2>Upload &amp; Schedule</h2>
          <p>Drop a video, Toreroflow captions, formats, and queues it for every platform.</p>
        </div>
        <div className="search">
          <svg>
            <use href="#i-search" />
          </svg>{" "}
          Search content
        </div>
        <div className="iconbtn">
          <svg>
            <use href="#i-bell" />
          </svg>
          <span className="dot" />
        </div>
      </div>
      <div className="stage">
        <div className="split">
          <div>
            <div className="drop">
              <div className="ring">
                <svg>
                  <use href="#i-up" />
                </svg>
              </div>
              <b>Drop videos here</b>
              <p>or click to browse. MP4, MOV up to 4K. Batch drops welcome.</p>
              <div className="pills">
                <span className="mini">Auto captions</span>
                <span className="mini">Auto reframe 9:16</span>
                <span className="mini">Best time detect</span>
                <span className="mini">Per client presets</span>
              </div>
            </div>

            <div className="job glass-sm" onClick={onOpenComposer}>
              <div className="thumb">
                <span className="dur">0:38</span>
                <div className="play">
                  <svg>
                    <use href="#i-play" />
                  </svg>
                </div>
                <div className="cap">
                  <i className="on">POSTURE</i> <i>fix in</i> <i>60s</i>
                </div>
              </div>
              <div className="body">
                <div className="name">
                  posture-reset-final.mp4 <span className="tag ai">AI processed</span>
                </div>
                <div className="transcript">
                  <span className="w">Three moves to</span>{" "}
                  <span className="w hot">fix your posture</span>{" "}
                  <span className="w">in under a minute.</span>{" "}
                  <span className="w hot">Save this</span>{" "}
                  <span className="w">for later.</span>
                </div>

                <div className="toggles">
                  {toggles.map((t) => (
                    <div
                      key={t.id}
                      className={`pt${t.on ? " on" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePlatform(t.id);
                      }}
                    >
                      <Pf p={t.id} />
                      <div className="info">
                        <b>{t.name}</b>
                        <span>{t.handle}</span>
                      </div>
                      <div className="switch" />
                    </div>
                  ))}
                </div>

                <div className="schedrow">
                  <div className="timechip">
                    <svg>
                      <use href="#i-clock" />
                    </svg>{" "}
                    Best time <b>Tomorrow, 6:40 PM</b>
                  </div>
                  <span className="tag ok">Captions ready</span>
                  <button
                    className="btn"
                    style={{ marginLeft: "auto" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenComposer();
                    }}
                  >
                    <svg>
                      <use href="#i-bolt" />
                    </svg>{" "}
                    Schedule all
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div>
            <div className="card glass">
              <div className="rowhead">
                <h3>Up next in queue</h3>
                <div className="qstate">
                  {(["filled", "loading", "empty"] as const).map((q) => (
                    <span
                      key={q}
                      className={queueState === q ? "on" : undefined}
                      data-q={q}
                      onClick={() => setQueueState(q)}
                    >
                      {q.charAt(0).toUpperCase() + q.slice(1)}
                    </span>
                  ))}
                </div>
              </div>
              {queueState === "filled" && (
                <div id="qFilled">
                  {QUEUE_ITEMS.map((item) => (
                    <div key={item.title} className="queue-item" onClick={onOpenComposer}>
                      <div className="qthumb" style={{ background: item.gradient }} />
                      <div className="qmeta">
                        <b>{item.title}</b>
                        <span>
                          {item.platforms.map((p) => (
                            <Pf key={p} p={p} size="sm" />
                          ))}{" "}
                          {item.when}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {queueState === "loading" && (
                <div id="qLoading">
                  {SKELETON_ROWS.map((row, i) => (
                    <div key={i} className="skel-item">
                      <div className="skel" style={{ width: 44, height: 56 }} />
                      <div style={{ flex: 1 }}>
                        <div className="skel" style={{ height: 12, width: row.w1 }} />
                        <div className="skel" style={{ height: 9, width: row.w2, marginTop: 9 }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {queueState === "empty" && (
                <div id="qEmpty">
                  <div className="empty">
                    <div className="eic">
                      <svg>
                        <use href="#i-image" />
                      </svg>
                    </div>
                    <b>Nothing queued yet</b>
                    <p>Drop a video to start building this client queue.</p>
                  </div>
                </div>
              )}
            </div>

            <div className="card glass" style={{ marginTop: 16 }}>
              <h3>
                <svg
                  style={{ width: 16, height: 16, stroke: "var(--v)", fill: "none", strokeWidth: 2 }}
                  viewBox="0 0 24 24"
                >
                  <use href="#i-bolt" />
                </svg>{" "}
                Smart timing
              </h3>
              <div className="sub" style={{ marginBottom: 8 }}>
                Best windows for Halo Fitness this week
              </div>
              {BEST_TIMES.map((row) => (
                <div key={row.p} className="best">
                  <div className="l">
                    <Pf p={row.p} size="sm" /> {row.label}
                  </div>
                  <b>{row.time}</b>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
