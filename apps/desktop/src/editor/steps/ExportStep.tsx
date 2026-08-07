import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BITRATE_PRESETS,
  edlFromDoc,
  outputDuration,
  type ExportSettings,
} from "@toreroflow/core";
import { api, fileUrl } from "../../lib/api";
import { openExternal } from "../../lib/external";
import { useToast } from "../../components/Toasts";
import { useAppState } from "../../state/AppState";
import { useEditor } from "../StudioEditor";
import "./ExportStep.css";

/**
 * Step 4: Export. Name and quality settings, then a non-blocking render:
 * the render runs on the worker, this step polls the project row, and the
 * operator is free to keep editing or leave and come back.
 */

/** What the poll reads off the project row. Local shape, per house rules. */
interface RenderView {
  status: string;
  renderPct: number | null;
  renderError: string | null;
  renderedKey: string | null;
  renderedUrl: string | null;
}

type BitChip = "lower" | "recommended" | "higher" | "custom";

const RESOLUTIONS = [720, 1080, 1440] as const;
const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

export default function ExportStep() {
  const { project, assets, doc, update } = useEditor();
  const { selectedClient } = useAppState();
  const toast = useToast();

  const ex = doc.export;
  const setExport = useCallback(
    (patch: Partial<ExportSettings>) =>
      update((d) => ({ ...d, export: { ...d.export, ...patch } })),
    [update],
  );

  /* ---- what the settings add up to ---- */

  const durations = useMemo(() => {
    const d: Record<string, number> = {};
    for (const a of assets) if (a.kind === "clip" && a.durationSec !== null) d[a.id] = a.durationSec;
    return d;
  }, [assets]);
  const totalSec = useMemo(() => outputDuration(edlFromDoc(doc, durations)), [doc, durations]);

  const has1440 = assets.some((a) => a.kind === "clip" && (a.width ?? 0) >= 1440);

  // 60fps carries 1.5x the bit rate, applied here at the call site.
  const presets = BITRATE_PRESETS[ex.resolution];
  const fpsScale = ex.fps === 60 ? 1.5 : 1;
  const kFor = (tier: "lower" | "recommended" | "higher") => Math.round(presets[tier] * fpsScale);

  // The chip choice lives in doc.export.bitrate as a tier name; a number
  // means a custom kbps (the render route also writes numbers back).
  const [bitChip, setBitChip] = useState<BitChip>(() => {
    if (typeof ex.bitrate === "string") return ex.bitrate;
    const tier = (["lower", "recommended", "higher"] as const).find((t) => kFor(t) === ex.bitrate);
    return tier ?? "custom";
  });
  const [customMbps, setCustomMbps] = useState(() =>
    typeof ex.bitrate === "number" ? String(ex.bitrate / 1000) : "10",
  );
  const bitrateK =
    bitChip === "custom"
      ? Math.max(500, Math.round((parseFloat(customMbps) || 0) * 1000))
      : kFor(bitChip);

  const name = ex.name || project.name;
  const fileName = `${name}.${ex.format}`;
  const sizeMb = Math.max(1, Math.round((bitrateK * totalSec) / 8000));

  /* ---- the render, polled off the project row ---- */

  const [render, setRender] = useState<RenderView | null>(null);
  // After a success or failure was read, "Export again" and "Try again"
  // return to the settings without waiting for the status to change.
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const p = await api.get<RenderView>(`/edit-projects/${project.id}`);
      setRender({
        status: p.status,
        renderPct: p.renderPct,
        renderError: p.renderError,
        renderedKey: p.renderedKey,
        renderedUrl: p.renderedUrl,
      });
    } catch {
      // The next poll retries; a blip should not tear the step down.
    }
  }, [project.id]);

  // On mount too, so leaving and returning shows a live render.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rendering = render?.status === "rendering";
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [rendering, refresh]);

  /* ---- elapsed time, counted from when this screen saw the render ---- */

  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!rendering) {
      startRef.current = null;
      return;
    }
    if (startRef.current === null) {
      startRef.current = Date.now();
      setElapsed(0);
    }
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [rendering]);

  /* ---- actions ---- */

  const onExport = async () => {
    setBusy(true);
    try {
      await api.post(`/edit-projects/${project.id}/render`, {
        name: name.trim() || project.name,
        resolution: ex.resolution,
        fps: ex.fps,
        format: ex.format,
        bitrateK,
      });
      setDismissed(false);
      setRender((r) => ({
        status: "rendering",
        renderPct: 0,
        renderError: null,
        renderedKey: r?.renderedKey ?? null,
        renderedUrl: r?.renderedUrl ?? null,
      }));
    } catch (err) {
      toast.fail("Could not start the export", err);
    }
    setBusy(false);
  };

  const onSend = async () => {
    setSending(true);
    try {
      await api.post(`/edit-projects/${project.id}/send-to-uploads`);
      toast.success(`Sent to Upload and Schedule for ${selectedClient?.name ?? "this brand"}`);
    } catch (err) {
      toast.fail("Could not send to uploads", err);
    }
    setSending(false);
  };

  /* ---- render ---- */

  const pct = Math.max(0, Math.min(100, render?.renderPct ?? 0));
  const showDone = render?.status === "rendered" && !dismissed;
  const showFailed = render?.status === "failed" && !dismissed;

  const chipBtn = (
    on: boolean,
    label: string,
    onClick: () => void,
    disabled = false,
    title?: string,
  ) => (
    <button
      key={label}
      className={`exs-chip${on ? " on" : ""}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div className="exs">
      <div className="card glass exs-card">
        <h3>Export</h3>
        <div className="sub">Name the file, pick the quality, and render the final video.</div>

        <label className="lab" htmlFor="exs-name">
          File name
        </label>
        <input
          id="exs-name"
          className="field-in exs-name"
          value={name}
          onChange={(e) => setExport({ name: e.target.value })}
        />

        <div className="exs-grid">
          <div className="exs-field">
            <span className="lab">Resolution</span>
            <div className="exs-chips">
              {RESOLUTIONS.map((r) =>
                chipBtn(
                  ex.resolution === r,
                  `${r}p`,
                  () => setExport({ resolution: r }),
                  r === 1440 && !has1440,
                  r === 1440 && !has1440 ? "Source is below 1440p" : undefined,
                ),
              )}
            </div>
          </div>
          <div className="exs-field">
            <span className="lab">Frame rate</span>
            <div className="exs-chips">
              {([30, 60] as const).map((f) =>
                chipBtn(ex.fps === f, `${f} fps`, () => setExport({ fps: f })),
              )}
            </div>
          </div>
          <div className="exs-field">
            <span className="lab">Format</span>
            <div className="exs-chips">
              {(["mp4", "mov"] as const).map((f) =>
                chipBtn(ex.format === f, f.toUpperCase(), () => setExport({ format: f })),
              )}
            </div>
          </div>
          <div className="exs-field">
            <span className="lab">Bit rate</span>
            <div className="exs-chips">
              {(["lower", "recommended", "higher"] as const).map((t) =>
                chipBtn(
                  bitChip === t,
                  `${t === "lower" ? "Lower" : t === "recommended" ? "Recommended" : "Higher"} (${kFor(t) / 1000} Mbps)`,
                  () => {
                    setBitChip(t);
                    setExport({ bitrate: t });
                  },
                ),
              )}
              {chipBtn(bitChip === "custom", "Custom", () => {
                setBitChip("custom");
                setExport({ bitrate: Math.max(500, Math.round((parseFloat(customMbps) || 10) * 1000)) });
              })}
              {bitChip === "custom" && (
                <span className="exs-customwrap">
                  <input
                    className="field-in exs-custom"
                    type="number"
                    min={1}
                    step={0.5}
                    value={customMbps}
                    onChange={(e) => {
                      setCustomMbps(e.target.value);
                      const k = Math.round((parseFloat(e.target.value) || 0) * 1000);
                      if (k >= 500) setExport({ bitrate: k });
                    }}
                  />
                  <span className="mini">Mbps</span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mini exs-summary">
          9:16 vertical - {ex.resolution}p {ex.format.toUpperCase()} - about {sizeMb} MB
        </div>

        <div className="exs-foot">
          {rendering ? (
            <div className="exs-progress">
              <div className="exs-ringwrap">
                <svg className="exs-ring" viewBox="0 0 64 64" aria-hidden="true">
                  <circle className="exs-ring-track" cx="32" cy="32" r={RING_R} />
                  <circle
                    className="exs-ring-fill"
                    cx="32"
                    cy="32"
                    r={RING_R}
                    strokeDasharray={RING_C}
                    strokeDashoffset={RING_C * (1 - pct / 100)}
                  />
                </svg>
                <span className="exs-pct">{pct}%</span>
              </div>
              <div className="exs-lines">
                <b>Rendering your video</b>
                <span className="mini">
                  {pct}% - {fmtElapsed(elapsed)} elapsed
                </span>
                <span className="mini">
                  You can keep working. The render continues in the background.
                </span>
              </div>
            </div>
          ) : showDone ? (
            <div className="exs-done">
              <div className="exs-mark exs-check" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 12.5l5.5 5.5L20 6.5" />
                </svg>
              </div>
              <div className="exs-lines">
                <b>{fileName}</b>
                <span className="mini">Rendered and ready.</span>
              </div>
              <div className="exs-actions">
                <button
                  className="btn ghost"
                  onClick={() => {
                    const url = fileUrl(render?.renderedUrl ?? null);
                    if (url) void openExternal(url);
                  }}
                >
                  Download
                </button>
                <button className="btn" disabled={sending} onClick={onSend}>
                  {sending ? "Sending..." : "Send to Uploads"}
                </button>
                <button className="btn ghost" onClick={() => setDismissed(true)}>
                  Export again
                </button>
              </div>
            </div>
          ) : showFailed ? (
            <div className="exs-done">
              <div className="exs-mark exs-x" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </div>
              <div className="exs-lines">
                <b>The render failed</b>
                <span className="mini exs-err">
                  {render?.renderError ?? "Something went wrong."}
                </span>
              </div>
              <div className="exs-actions">
                <button className="btn ghost" onClick={() => setDismissed(true)}>
                  Try again
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn exs-export"
              disabled={busy || totalSec <= 0}
              title={totalSec <= 0 ? "Add clips before exporting" : undefined}
              onClick={onExport}
            >
              {busy ? "Starting..." : "Export"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
