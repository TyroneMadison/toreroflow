import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fileUrl } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import Modal from "../../modals/Modal";
import ScoreDial from "../analyze/ScoreDial";
import { RUNNING, mmss, type ClipCandidateRow, type ClipJobRow } from "./clipTypes";
import "./Clips.css";

/**
 * One clip job: progress and stage log while it runs (mock-up 05), then the
 * ranked grid with sort, filters, transcript search and batch select (06),
 * a detail pane with ranges, nudges, judge comments and refine (07), and the
 * thumbs-down reason modal (08).
 *
 * ponytail: search is client-side over candidate.text; a job holds tens of
 * clips, so a round trip per keystroke buys nothing.
 */

type Sort = "score" | "time";
type Filter = "all" | "liked" | "edited" | "15-60" | "60-180";
const SUBS = ["hook", "flow", "value", "trend"] as const;
const REASONS = ["Starts mid-thought", "Ends too early", "Boring", "Off-topic", "Too long", "Bad framing"];

export default function ClipJobView({
  jobId,
  onBack,
  onOpenProject,
}: {
  jobId: string;
  onBack: () => void;
  onOpenProject: (projectId: string) => void;
}) {
  const toast = useToast();
  const [job, setJob] = useState<ClipJobRow | null>(null);
  const [sort, setSort] = useState<Sort>("score");
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const [downFor, setDownFor] = useState<string | null>(null);
  const [refine, setRefine] = useState({ start: "", end: "", prompt: "" });

  const load = useCallback(async () => {
    try {
      setJob(await api.get<ClipJobRow>(`/clip-jobs/${jobId}`));
    } catch (e) {
      toast.fail("Loading the clip job", e);
    }
  }, [jobId, toast]);

  useEffect(() => void load(), [load]);
  const running = job ? RUNNING.has(job.status) : true;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [running, load]);

  const cands = useMemo(() => {
    let list = [...(job?.candidates ?? [])];
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((c) => `${c.title} ${c.text ?? ""}`.toLowerCase().includes(needle));
    if (filter === "liked") list = list.filter((c) => c.feedback === "up");
    if (filter === "edited") list = list.filter((c) => c.editProjectId);
    if (filter === "15-60" || filter === "60-180") list = list.filter((c) => c.lengthTarget === filter);
    list.sort((a, b) => (sort === "score" ? b.score - a.score || a.rank - b.rank : a.ranges[0].start - b.ranges[0].start));
    return list;
  }, [job, q, filter, sort]);

  const scores = (job?.candidates ?? []).map((c) => c.score).sort((a, b) => a - b);
  const median = scores.length ? scores[Math.floor((scores.length - 1) / 2)] : null;

  function patchLocal(c: ClipCandidateRow) {
    setJob((j) => (j ? { ...j, candidates: j.candidates?.map((x) => (x.id === c.id ? c : x)) } : j));
  }

  async function patch(id: string, body: object) {
    try {
      patchLocal(await api.patch<ClipCandidateRow>(`/clip-candidates/${id}`, body));
    } catch (e) {
      toast.fail("Saving the clip", e);
    }
  }

  async function open(ids: string[]) {
    try {
      const res = await api.post<{ projects: { candidateId: string; projectId: string }[] }>("/clip-candidates/open", { ids });
      void load();
      if (res.projects.length === 1) onOpenProject(res.projects[0].projectId);
      else toast.success(`${res.projects.length} clips opened as projects in Edit.`);
    } catch (e) {
      toast.fail("Opening in the editor", e);
    }
  }

  async function post(path: string, body: object, what: string) {
    try {
      await api.post(path, body);
      void load();
    } catch (e) {
      toast.fail(what, e);
    }
  }

  if (!job) return <div className="skel projskel" />;
  const log = job.options.log ?? [];
  const d = job.candidates?.find((c) => c.id === detail) ?? null;
  const proxy = fileUrl(job.source.proxyUrl);

  return (
    <div className="clipjob">
      <div className="cj-head">
        <button className="btn ghost" onClick={onBack}>
          Back
        </button>
        <div>
          <h3>{job.source.name}</h3>
          <div className="sub">
            {job.candidates?.length ?? 0} clips{scores.length ? ` · top ${scores[scores.length - 1]} · median ${median}` : ""}
          </div>
        </div>
        {job.status === "ready" && (
          <>
            <input className="cj-search" placeholder="Search clip transcripts" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="seg">
              <span className={sort === "score" ? "on" : ""} onClick={() => setSort("score")}>Score</span>
              <span className={sort === "time" ? "on" : ""} onClick={() => setSort("time")}>Timeline order</span>
            </div>
            <div className="cj-filters">
              {(["all", "liked", "edited", "15-60", "60-180"] as Filter[]).map((f) => (
                <span key={f} className={`chip${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
                  {f === "all" ? "All" : f === "liked" ? "Liked" : f === "edited" ? "Edited" : `${f}s`}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {job.status !== "ready" && (
        <div className="cj-progress">
          <div className="bar">
            <i style={{ transform: `scaleX(${job.pct / 100})` }} />
          </div>
          <div className="sub">
            {job.status === "failed" ? `Failed at ${job.error ?? "an unknown stage"}` : `${job.status} · ${job.pct}%`}
          </div>
          <ol className="cj-log">
            {log.map((l, i) => (
              <li key={i}>
                <time>{new Date(l.at).toLocaleTimeString()}</time> {l.line}
              </li>
            ))}
          </ol>
          {job.status === "failed" && (
            <button className="btn" onClick={() => void post(`/clip-jobs/${job.id}/retry`, { stage: job.stage === "score" ? "score" : job.stage === "curate" ? "curate" : "analyze" }, "Retrying")}>
              Retry stage
            </button>
          )}
        </div>
      )}

      {job.status === "ready" && (
        <div className="cj-body">
          <div className="cj-grid">
            {cands.map((c) => (
              <div key={c.id} className={`cj-card${sel.has(c.id) ? " sel" : ""}${detail === c.id ? " open" : ""}`} onClick={() => setDetail(c.id)}>
                <div className="thumb">
                  {proxy && <video src={`${proxy}#t=${c.ranges[0].start + 0.5}`} preload="metadata" muted />}
                </div>
                <div className="meta">
                  <div className="top">
                    <span>#{c.rank} · {mmss(c.duration)}{c.ranges.length > 1 ? " · stitched" : ""}</span>
                    <input
                      type="checkbox"
                      checked={sel.has(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => setSel((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}
                    />
                  </div>
                  <div className="t">{c.title}</div>
                  <div className="scores">
                    <ScoreDial label="Score" value={c.score} dial="peak" />
                    <div className="subs">
                      {SUBS.map((k) => (
                        <div key={k} className="sub-row">
                          <span>{k[0].toUpperCase() + k.slice(1)}</span>
                          <i style={{ width: `${c[k] * 10}%` }} />
                          <b>{c[k]}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="acts" onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm" onClick={() => void open([c.id])}>{c.editProjectId ? "Edit" : "Open"}</button>
                    <button className="btn sm ghost" title="Rescore" onClick={() => void post(`/clip-candidates/${c.id}/rescore`, {}, "Rescoring")}>↻</button>
                    <button className={`btn sm ghost${c.feedback === "up" ? " on" : ""}`} onClick={() => void patch(c.id, { feedback: c.feedback === "up" ? null : "up" })}>👍</button>
                    <button className={`btn sm ghost${c.feedback?.startsWith("down") ? " on" : ""}`} onClick={() => setDownFor(c.id)}>👎</button>
                  </div>
                </div>
              </div>
            ))}
            {cands.length === 0 && <div className="empty">No clips match.</div>}
          </div>

          {d && (
            <aside className="cj-detail">
              <h4>{d.title}</h4>
              {proxy && <video controls src={`${proxy}#t=${d.ranges[0].start}`} />}
              <div className="sub">{d.why}</div>
              <ul className="ranges">
                {d.ranges.map((r, i) => (
                  <li key={i}>{mmss(r.start)} to {mmss(r.end)}</li>
                ))}
              </ul>
              <div className="nudges">
                <button className="btn sm ghost" onClick={() => void patch(d.id, { nudge: { edge: "start", dir: "extend" } })}>Start earlier</button>
                <button className="btn sm ghost" onClick={() => void patch(d.id, { nudge: { edge: "start", dir: "shrink" } })}>Start later</button>
                <button className="btn sm ghost" onClick={() => void patch(d.id, { nudge: { edge: "end", dir: "shrink" } })}>End sooner</button>
                <button className="btn sm ghost" onClick={() => void patch(d.id, { nudge: { edge: "end", dir: "extend" } })}>End later</button>
              </div>
              <dl className="comments">
                {SUBS.map((k) => (
                  <div key={k}>
                    <dt>{k} {d[k]}</dt>
                    <dd>{d.comments?.[k] ?? ""}</dd>
                  </div>
                ))}
              </dl>
              {d.hashtags.length > 0 && <div className="sub">{d.hashtags.map((h) => `#${h}`).join(" ")}</div>}
              <p className="transcript">{d.text}</p>
              <div className="refine">
                <div className="t">Find clips in a range</div>
                <input placeholder="start (s)" value={refine.start} onChange={(e) => setRefine({ ...refine, start: e.target.value })} />
                <input placeholder="end (s)" value={refine.end} onChange={(e) => setRefine({ ...refine, end: e.target.value })} />
                <input placeholder="prompt (optional)" value={refine.prompt} onChange={(e) => setRefine({ ...refine, prompt: e.target.value })} />
                <button
                  className="btn sm"
                  onClick={() =>
                    void post(
                      `/clip-jobs/${job.id}/refine`,
                      { start: Number(refine.start || d.ranges[0].start), end: Number(refine.end || d.ranges[d.ranges.length - 1].end), ...(refine.prompt ? { prompt: refine.prompt } : {}) },
                      "Finding clips",
                    )
                  }
                >
                  Find
                </button>
              </div>
            </aside>
          )}
        </div>
      )}

      {sel.size > 0 && (
        <div className="cj-batch">
          <span>{sel.size} selected</span>
          <button className="btn" onClick={() => void open([...sel])}>Open in editor</button>
        </div>
      )}

      {downFor && (
        <Modal maxWidth={420} onClose={() => setDownFor(null)} label="What was wrong with this clip?">
          <h3>What was wrong?</h3>
          <div className="cj-reasons">
            {REASONS.map((r) => (
              <span
                key={r}
                className="chip"
                onClick={() => {
                  void patch(downFor, { feedback: `down:${r}` });
                  setDownFor(null);
                }}
              >
                {r}
              </span>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
