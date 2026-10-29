import { useCallback, useEffect, useState } from "react";
import { api, fileUrl } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import Modal from "../../modals/Modal";
import type { ClipCandidateRow } from "./clipTypes";

/**
 * Batch render (mock-ups 15 and 16): pick export settings, check each clip's
 * drafted copy when sending, then one click opens, renders and (optionally)
 * drops every clip in Uploads. Nothing posts from here.
 * ponytail: copy is the clip's curated title/description/hashtags, edited
 * here; no LLM call per clip.
 */

interface Status {
  candidateId: string;
  projectId: string | null;
  status: string;
  renderPct: number;
  error: string | null;
  uploadAssetId: string | null;
}

const KBPS: Record<number, number> = { 720: 6000, 1080: 12000, 1440: 20000 };
const DONE = new Set(["sent", "rendered", "failed", "none"]);

export default function BatchRender({
  clips,
  send,
  proxyUrl,
  onClose,
  onChanged,
}: {
  clips: ClipCandidateRow[];
  send: boolean;
  proxyUrl: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [stage, setStage] = useState<"setup" | "progress">("setup");
  const [ex, setEx] = useState({ resolution: 1080 as 720 | 1080 | 1440, fps: 30 as 30 | 60, format: "mp4" as "mp4" | "mov" });
  const [copy, setCopy] = useState(() =>
    Object.fromEntries(clips.map((c) => [c.id, { title: c.title, description: c.description ?? "", hashtags: c.hashtags.join(" ") }])),
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [rows, setRows] = useState<Status[]>([]);
  const [busy, setBusy] = useState(false);
  const [concurrency, setConcurrency] = useState<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const r = await api.get<{ items: Status[] }>(`/clip-candidates/batch-status?ids=${clips.map((c) => c.id).join(",")}`);
      setRows(r.items);
      // How many render at once, read off the live table: the most seen rendering together.
      const live = r.items.filter((i) => i.status === "rendering").length;
      setConcurrency((c) => Math.max(c ?? 0, live) || null);
    } catch (e) {
      toast.fail("Checking the batch", e);
    }
  }, [clips, toast]);

  const allDone = rows.length > 0 && rows.every((r) => DONE.has(r.status));
  useEffect(() => {
    if (stage !== "progress" || allDone) return;
    const t = window.setInterval(() => void poll(), 2000);
    return () => window.clearInterval(t);
  }, [stage, allDone, poll]);
  useEffect(() => {
    if (allDone) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone]);

  async function start(ids: string[]) {
    setBusy(true);
    try {
      if (send) {
        for (const id of ids) {
          const c = clips.find((x) => x.id === id)!;
          const d = copy[id];
          const tags = d.hashtags.split(/[\s,]+/).map((h) => h.replace(/^#/, "")).filter(Boolean);
          if (d.title !== c.title || d.description !== (c.description ?? "") || tags.join(" ") !== c.hashtags.join(" ")) {
            await api.patch(`/clip-candidates/${id}`, { title: d.title.trim() || c.title, description: d.description, hashtags: tags });
          }
        }
      }
      const r = await api.post<{ items: { candidateId: string; queued: boolean; error?: string }[] }>("/clip-candidates/batch-render", {
        ids,
        export: { ...ex, bitrateK: Math.round(KBPS[ex.resolution] * (ex.fps === 60 ? 1.5 : 1)) },
        send,
      });
      const skipped = r.items.filter((i) => !i.queued);
      if (skipped.length) toast.success(`${skipped.length} not queued: ${skipped[0].error ?? "skipped"}.`);
      setStage("progress");
      await poll();
    } catch (e) {
      toast.fail("Starting the batch", e);
    } finally {
      setBusy(false);
    }
  }

  const label = (r: Status) =>
    r.status === "sent"
      ? "Sent to Uploads"
      : r.status === "sending"
        ? "Sending to Uploads"
        : r.status === "rendering"
          ? `Rendering ${r.renderPct}%`
          : r.status === "queued"
            ? "Queued"
            : r.status === "rendered"
              ? r.error ?? "Rendered"
              : r.status === "failed"
                ? `Failed: ${r.error ?? "unknown"}`
                : r.status;

  return (
    <Modal maxWidth={760} onClose={onClose} label="Batch render">
      {stage === "setup" ? (
        <div className="bat">
          <h3>{send ? `Send ${clips.length} clips to Uploads` : `Render ${clips.length} clips`}</h3>
          <div className="bat-chips">
            {([720, 1080, 1440] as const).map((r) => (
              <span key={r} className={`chip${ex.resolution === r ? " on" : ""}`} onClick={() => setEx({ ...ex, resolution: r })}>{r}p</span>
            ))}
            {([30, 60] as const).map((f) => (
              <span key={f} className={`chip${ex.fps === f ? " on" : ""}`} onClick={() => setEx({ ...ex, fps: f })}>{f} fps</span>
            ))}
            {(["mp4", "mov"] as const).map((f) => (
              <span key={f} className={`chip${ex.format === f ? " on" : ""}`} onClick={() => setEx({ ...ex, format: f })}>{f.toUpperCase()}</span>
            ))}
          </div>
          <div className="sub">Each clip opens with its brand's recipe, then renders. Aspect follows the clip.</div>
          {send && (
            <div className="bat-cards">
              {clips.map((c) => {
                const d = copy[c.id];
                const set = (k: "title" | "description" | "hashtags", v: string) => setCopy({ ...copy, [c.id]: { ...d, [k]: v } });
                return (
                  <div key={c.id} className="bat-card">
                    <div className="thumb">{proxyUrl && <video src={`${fileUrl(proxyUrl)}#t=${c.ranges[0].start + 0.5}`} preload="metadata" muted />}</div>
                    <div className="meta">
                      {editing === c.id ? (
                        <>
                          <input className="field-in" value={d.title} maxLength={120} onChange={(e) => set("title", e.target.value)} />
                          <textarea className="field-in" rows={3} value={d.description} onChange={(e) => set("description", e.target.value)} />
                          <input className="field-in" value={d.hashtags} placeholder="#tags" onChange={(e) => set("hashtags", e.target.value)} />
                        </>
                      ) : (
                        <>
                          <b>{d.title}</b>
                          <div className="sub">{d.description || "No description"}</div>
                          <div className="sub">{d.hashtags.split(/[\s,]+/).filter(Boolean).map((h) => `#${h.replace(/^#/, "")}`).join(" ")}</div>
                        </>
                      )}
                      <div className="row">
                        <span className="chip on">✓ drafted</span>
                        <button className="btn sm ghost" onClick={() => setEditing(editing === c.id ? null : c.id)}>
                          {editing === c.id ? "Done" : "Edit copy"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="bat-foot">
            {send && <span className="sub">Nothing posts from here.</span>}
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn" disabled={busy} onClick={() => void start(clips.map((c) => c.id))}>
              {busy ? "Starting..." : send ? `Render + send ${clips.length} to Uploads` : `Render ${clips.length} clips`}
            </button>
          </div>
        </div>
      ) : (
        <div className="bat">
          <h3>
            Batch render · {clips.length} clips {concurrency ? <span className="sub">{concurrency} at a time</span> : null}
          </h3>
          <table className="bat-table">
            <tbody>
              {clips.map((c) => {
                const r = rows.find((x) => x.candidateId === c.id);
                const pct = !r ? 0 : r.status === "sent" || r.status === "rendered" || r.status === "sending" ? 100 : r.renderPct;
                return (
                  <tr key={c.id}>
                    <td className="t">{copy[c.id]?.title ?? c.title}</td>
                    <td>{c.score}</td>
                    <td className="barcell">
                      <div className="bar"><i style={{ transform: `scaleX(${pct / 100})` }} /></div>
                    </td>
                    <td className={r?.status === "failed" ? "err" : ""}>
                      {r ? label(r) : "Queued"}
                      {r?.status === "failed" && (
                        <button className="btn sm ghost" onClick={() => void start([c.id])}>Retry</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="bat-foot">
            <span className="sub">{allDone ? "Done. Finished files are in each project and, when sent, in Uploads." : "You can close this; renders keep going."}</span>
            <button className="btn" onClick={onClose}>{allDone ? "Close" : "Hide"}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
