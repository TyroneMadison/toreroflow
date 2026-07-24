import { useRef, useState, type DragEvent } from "react";
import Pf from "../components/Pf";
import { PF_ID, SURFACE_LABEL, type Platform } from "../lib/platforms";
import { formatDuration, probeVideo } from "../lib/video";
import { useAppState } from "../state/AppState";

export interface UploadJob {
  id: string;
  name: string;
  url: string;
  thumbnail: string;
  durationSec: number;
  targets: Platform[];
}

interface UploadScheduleProps {
  onPreview(job: UploadJob): void;
  onOpenConnect(): void;
}

let jobCounter = 0;

export default function UploadSchedule({ onPreview, onOpenConnect }: UploadScheduleProps) {
  const { selectedClient } = useAppState();
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [reading, setReading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const connectedPlatforms = new Set(
    (selectedClient?.accounts ?? [])
      .filter((a) => a.status === "connected")
      .map((a) => a.platform),
  );

  const addFiles = async (files: FileList | File[]) => {
    const videos = Array.from(files).filter((f) => f.type.startsWith("video/"));
    if (!videos.length) return;
    setReading(true);
    try {
      for (const file of videos) {
        try {
          const probe = await probeVideo(file);
          setJobs((prev) => [
            {
              id: `job-${++jobCounter}`,
              name: file.name,
              url: probe.url,
              thumbnail: probe.thumbnail,
              durationSec: probe.durationSec,
              targets: [...connectedPlatforms],
            },
            ...prev,
          ]);
        } catch {
          // Unreadable codec — skip the file rather than crash the drop.
        }
      }
    } finally {
      setReading(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void addFiles(e.dataTransfer.files);
  };

  const toggleTarget = (jobId: string, platform: Platform) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId
          ? {
              ...j,
              targets: j.targets.includes(platform)
                ? j.targets.filter((p) => p !== platform)
                : [...j.targets, platform],
            }
          : j,
      ),
    );
  };

  const removeJob = (jobId: string) => {
    setJobs((prev) => {
      const job = prev.find((j) => j.id === jobId);
      if (job) URL.revokeObjectURL(job.url);
      return prev.filter((j) => j.id !== jobId);
    });
  };

  const allPlatforms: Platform[] = ["instagram", "tiktok", "youtube", "snapchat"];

  return (
    <section className="screen active" data-screen="upload">
      <div className="topbar">
        <div className="h">
          <h2>Upload &amp; Schedule</h2>
          <p>
            {selectedClient
              ? `Drop a video for ${selectedClient.name} — captioning, formatting, and queueing land in M2/M3.`
              : "Pick or add a brand in the sidebar, then drop a video."}
          </p>
        </div>
      </div>
      <div className="stage">
        <div className="split">
          <div>
            <div
              className="drop"
              style={dragOver ? { borderColor: "rgba(139,123,255,.65)" } : undefined}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInput.current?.click()}
            >
              <input
                ref={fileInput}
                type="file"
                accept="video/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <div className="ring">
                <svg>
                  <use href="#i-up" />
                </svg>
              </div>
              <b>{reading ? "Reading video…" : "Drop videos here"}</b>
              <p>or click to browse. MP4, MOV up to 4K. Batch drops welcome.</p>
              <div className="pills">
                <span className="mini">Auto captions · M2</span>
                <span className="mini">Auto reframe 9:16 · M2</span>
                <span className="mini">Best time detect · M5</span>
              </div>
            </div>

            {jobs.map((job) => (
              <div className="job glass-sm" key={job.id}>
                <div
                  className="thumb"
                  style={{ cursor: "pointer" }}
                  onClick={() => onPreview(job)}
                  title="Click to preview"
                >
                  <img className="jobthumb-img" src={job.thumbnail} alt={job.name} />
                  <span className="dur">{formatDuration(job.durationSec)}</span>
                  <div className="play">
                    <svg>
                      <use href="#i-play" />
                    </svg>
                  </div>
                </div>
                <div className="body">
                  <div className="name">
                    {job.name}
                    <span
                      className="tag ai"
                      title="Transcription and AI captions arrive with the M2 media pipeline"
                    >
                      Captions · M2
                    </span>
                  </div>

                  <div className="toggles">
                    {allPlatforms.map((platform) => {
                      const connected = connectedPlatforms.has(platform);
                      const on = job.targets.includes(platform);
                      const account = selectedClient?.accounts.find(
                        (a) => a.platform === platform,
                      );
                      return (
                        <div
                          key={platform}
                          className={`pt${on ? " on" : ""}`}
                          style={connected ? undefined : { opacity: 0.45 }}
                          title={
                            connected
                              ? undefined
                              : "Not connected — connect this platform in Settings"
                          }
                          onClick={() =>
                            connected ? toggleTarget(job.id, platform) : onOpenConnect()
                          }
                        >
                          <Pf p={PF_ID[platform]} />
                          <div className="info">
                            <b>{SURFACE_LABEL[platform]}</b>
                            <span>{account ? `@${account.handle}` : "not connected"}</span>
                          </div>
                          <div className="switch" />
                        </div>
                      );
                    })}
                  </div>

                  <div className="schedrow">
                    <button className="btn ghost" onClick={() => removeJob(job.id)}>
                      Remove
                    </button>
                    <button
                      className="btn"
                      style={{ marginLeft: "auto", opacity: 0.55, cursor: "not-allowed" }}
                      title="Scheduling & publishing activate in M3"
                      disabled
                    >
                      <svg>
                        <use href="#i-bolt" />
                      </svg>{" "}
                      Schedule all · M3
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div>
            <div className="card glass">
              <div className="rowhead">
                <h3>Up next in queue</h3>
              </div>
              <div className="empty">
                <div className="eic">
                  <svg>
                    <use href="#i-image" />
                  </svg>
                </div>
                <b>Nothing queued yet</b>
                <p>
                  {selectedClient
                    ? `Drop a video to start building ${selectedClient.name}'s queue.`
                    : "Add a brand, then drop a video to build its queue."}
                </p>
              </div>
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
                Best posting windows are computed from each account's own history — they appear
                once analytics ingestion starts (M5).
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
