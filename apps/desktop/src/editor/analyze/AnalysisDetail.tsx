import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api, fileUrl } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import ScoreDial from "./ScoreDial";
import "./AnalysisDetail.css";

/**
 * One analysis, read end to end.
 *
 * Everything on this screen comes out of the video itself: the transcript, the
 * sampled frames, and the rubric the worker scored them against. No platform
 * ever hands out per-second retention, so the screen never implies it has any.
 */

interface Moment {
  at: number;
  kind: "strong" | "risk";
  label: string;
  detail: string;
}

interface PlanStep {
  title: string;
  why: string;
  fix: string;
}

interface SpinOff {
  idea: string;
  hook: string;
}

interface TranscriptLine {
  start: number;
  end: number;
  text: string;
}

interface AnalysisResult {
  scores: { hook: number; retention: number; payoff: number; peak: number };
  category: string;
  overview: string;
  viewerValue: string;
  whatWorked: string[];
  moments: Moment[];
  actionPlan: PlanStep[];
  spinOffs: SpinOff[];
  transcript: TranscriptLine[];
}

interface AnalysisRow {
  id: string;
  clientId: string;
  name: string;
  status: string;
  durationSec: number | null;
  videoUrl: string | null;
  error: string | null;
  result: AnalysisResult | null;
}

type Tab = "overview" | "plan" | "spinoffs";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Action plan" },
  { id: "spinoffs", label: "Spin-off ideas" },
];

/** What the worker is doing, in the order it does it. */
const WORKING_LINES = [
  "Reading the words",
  "Watching the frames",
  "Scoring the hook",
  "Writing the fixes",
];

function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A coral tick, used wherever the screen says something went right. */
function Tick() {
  return (
    <svg className="and-tick" viewBox="0 0 24 24" aria-hidden="true">
      <use href="#i-check" />
    </svg>
  );
}

export default function AnalysisDetail({
  analysisId,
  onBack,
}: {
  analysisId: string;
  onBack(): void;
}) {
  const toast = useToast();
  const [row, setRow] = useState<AnalysisRow | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [openMoment, setOpenMoment] = useState<number | null>(null);
  const [stamps, setStamps] = useState(false);
  const [peakInfo, setPeakInfo] = useState(false);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [workingLine, setWorkingLine] = useState(0);

  const load = useCallback(async () => {
    try {
      setRow(await api.get<AnalysisRow>(`/analyses/${analysisId}`));
    } catch (err) {
      toast.fail("Could not load that analysis", err);
    }
  }, [analysisId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // The worker owns everything after the 201, so a running row is polled the
  // same way a "what to do next" run is.
  const running = row?.status === "running";
  useEffect(() => {
    if (!running) return;
    const poll = setInterval(() => void load(), 3000);
    const lines = setInterval(() => setWorkingLine((i) => (i + 1) % WORKING_LINES.length), 2500);
    return () => {
      clearInterval(poll);
      clearInterval(lines);
    };
  }, [running, load]);

  /* ---- the video ---- */

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [videoDur, setVideoDur] = useState(0);
  const src = fileUrl(row?.videoUrl ?? null);
  const duration = row?.durationSec || videoDur || 0;

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    if (v.readyState === 0) {
      pendingSeek.current = t;
      return;
    }
    v.currentTime = t;
    setAt(t);
    void v.play().catch(() => {});
  }, []);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  const troughRef = useRef<HTMLDivElement | null>(null);
  const scrubAt = (e: ReactPointerEvent) => {
    const el = troughRef.current;
    const v = videoRef.current;
    if (!el || !v || duration <= 0) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    v.currentTime = frac * duration;
    setAt(frac * duration);
  };

  const phone = (
    <div className="and-phone">
      <div className="and-frame glass-sm">
        <div className="and-screen" onClick={toggle}>
          {src ? (
            <video
              ref={videoRef}
              src={src}
              playsInline
              preload="metadata"
              onLoadedMetadata={(e) => {
                setVideoDur(e.currentTarget.duration || 0);
                if (pendingSeek.current !== null) {
                  e.currentTarget.currentTime = pendingSeek.current;
                  pendingSeek.current = null;
                  void e.currentTarget.play().catch(() => {});
                }
              }}
              onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
          ) : (
            <div className="and-novideo mini">No file to play</div>
          )}
          {!playing && src && (
            <div className="and-playover">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-play" />
              </svg>
            </div>
          )}
          <div className="and-notch" />
        </div>
        <div
          className="and-scrub"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubAt(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) scrubAt(e);
          }}
        >
          <div className="and-scrub-trough" ref={troughRef}>
            <div
              className="and-scrub-dot"
              style={{
                left: `${duration > 0 ? Math.min(100, (at / duration) * 100) : 0}%`,
                transform: "translate(-50%,-50%)",
              }}
            />
          </div>
        </div>
        <div className="and-time mini">
          {fmt(at)} / {fmt(duration)}
        </div>
      </div>
    </div>
  );

  const head = (
    <div className="and-head">
      <button className="iconbtn" title="Back to the list" onClick={onBack}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <div className="and-headtext">
        <h3>Video analysis</h3>
        <div className="sub">{row?.name ?? "Loading"}</div>
      </div>
    </div>
  );

  /* ---- the states before there is anything to read ---- */

  const retry = async () => {
    setRetrying(true);
    try {
      await api.post(`/analyses/${analysisId}/retry`);
      setRow((r) => (r ? { ...r, status: "running", error: null } : r));
    } catch (err) {
      toast.fail("Could not start that analysis again", err);
    } finally {
      setRetrying(false);
    }
  };

  if (!row) {
    return (
      <div className="and">
        {head}
        <div className="and-body">
          <div className="skel and-frameskel" />
          <div className="skel and-panelskel" />
        </div>
      </div>
    );
  }

  if (row.status !== "ready" || !row.result) {
    return (
      <div className="and">
        {head}
        <div className="and-body">
          {phone}
          <div className="card glass and-state">
            {row.status === "failed" ? (
              <>
                <h3>This one did not finish</h3>
                <div className="sub">{row.error ?? "The run stopped before it scored anything."}</div>
                <button className="btn and-retry" disabled={retrying} onClick={() => void retry()}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <h3>Reading your video</h3>
                <div className="sub">
                  This takes a couple of minutes. You can leave the screen and come back.
                </div>
                <div className="and-working">
                  {WORKING_LINES.map((line, i) => (
                    <div
                      key={line}
                      className={`and-workline${i === workingLine ? " on" : ""}`}
                      aria-current={i === workingLine ? "step" : undefined}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const r = row.result;
  const moments = r.moments ?? [];
  const transcript = r.transcript ?? [];
  const spinOffs = r.spinOffs ?? [];

  return (
    <div className="and">
      {head}
      <div className="and-body">
        {phone}
        <div className="and-right">
          <ScorePanel
            result={r}
            duration={duration}
            moments={moments}
            openMoment={openMoment}
            onMoment={(i) => {
              setOpenMoment((cur) => (cur === i ? null : i));
              seek(moments[i]!.at);
            }}
            peakInfo={peakInfo}
            setPeakInfo={setPeakInfo}
          />

          <div className="seg and-tabs">
            {TABS.map((t) => (
              <span key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
                {t.label}
              </span>
            ))}
          </div>

          {tab === "overview" && (
            <OverviewTab
              result={r}
              transcript={transcript}
              stamps={stamps}
              setStamps={setStamps}
              onCopied={() => toast.success("Transcript copied")}
              onCopyFailed={(err) => toast.fail("Could not copy the transcript", err)}
            />
          )}

          {tab === "plan" && (
            <div className="and-plan stagger">
              {(r.actionPlan ?? []).map((step, i) => (
                <div className="card glass and-step" key={i}>
                  <div className="and-stephead">
                    <span className="and-stepnum">{i + 1}</span>
                    <div>
                      <b>{step.title}</b>
                      <div className="sub">{step.why}</div>
                    </div>
                  </div>
                  <div className="and-stepfix">
                    <Tick />
                    <span>{step.fix}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "spinoffs" && (
            <SpinOffTab
              spinOffs={spinOffs}
              added={added}
              generating={generating}
              onAdd={async (i) => {
                const s = spinOffs[i]!;
                try {
                  await api.post(`/clients/${row.clientId}/ideas`, {
                    text: s.idea,
                    hook: s.hook,
                    source: "analysis",
                  });
                  setAdded((cur) => new Set(cur).add(i));
                  toast.success("Added to ideas");
                } catch (err) {
                  toast.fail("Could not add that idea", err);
                }
              }}
              onGenerate={async () => {
                setGenerating(true);
                try {
                  const out = await api.post<{ spinOffs: SpinOff[] }>(
                    `/analyses/${row.id}/spin-offs`,
                  );
                  setRow((cur) =>
                    cur && cur.result
                      ? { ...cur, result: { ...cur.result, spinOffs: out.spinOffs } }
                      : cur,
                  );
                  // The set holds positions in the old list. Keeping it would
                  // mark whichever new ideas happen to land on those positions
                  // as already added and lock them out of the ideas list.
                  setAdded(new Set());
                } catch (err) {
                  toast.fail("Could not write more ideas", err);
                } finally {
                  setGenerating(false);
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- the dials, the moment strip, and the peak score ---- */

function ScorePanel({
  result,
  duration,
  moments,
  openMoment,
  onMoment,
  peakInfo,
  setPeakInfo,
}: {
  result: AnalysisResult;
  duration: number;
  moments: Moment[];
  openMoment: number | null;
  onMoment(i: number): void;
  peakInfo: boolean;
  setPeakInfo(v: boolean): void;
}) {
  const peak = Math.max(0, Math.min(100, Math.round(result.scores.peak)));
  // Five labels, four steps, which is the ruler the reference screen draws.
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const open = openMoment !== null ? moments[openMoment] : undefined;

  return (
    <div className="card glass and-scores">
      <div className="and-dials">
        <ScoreDial label="Hook" value={result.scores.hook} dial="hook" />
        <ScoreDial label="Retention" value={result.scores.retention} dial="retention" />
        <ScoreDial label="Payoff" value={result.scores.payoff} dial="payoff" />
      </div>

      <div className="and-strip">
        <div className="and-lab lab">Key moments</div>
        <div className="and-bar">
          {moments.map((m, i) => (
            <button
              key={i}
              className={`and-pill and-${m.kind}${openMoment === i ? " on" : ""}`}
              style={{
                left: `${duration > 0 ? Math.min(97, Math.max(3, (m.at / duration) * 100)) : 50}%`,
              }}
              title={m.label}
              onClick={() => onMoment(i)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href={m.kind === "strong" ? "#i-up" : "#i-alert"} />
              </svg>
              {fmt(m.at)}
            </button>
          ))}
        </div>
        <div className="and-ruler mini">
          {ticks.map((t) => (
            <span key={t}>{fmt(duration * t)}</span>
          ))}
        </div>
        {open ? (
          <div className={`and-moment and-${open.kind}`}>
            <b>{open.label}</b>
            <div className="sub">{open.detail}</div>
          </div>
        ) : (
          <div className="and-hint sub">Tap a moment to see what happens there.</div>
        )}
      </div>

      <div className="and-peak">
        <div className="and-peakhead">
          <span className="lab">Peak score</span>
          <button
            className="iconbtn and-info"
            title="What this score is"
            onClick={() => setPeakInfo(!peakInfo)}
          >
            i
          </button>
          {peakInfo && (
            <>
              <div className="and-popshade" onClick={() => setPeakInfo(false)} />
              <div className="and-pop glass-sm" role="note">
                This score reads the video: how it opens, how it holds, how it lands. It is not
                view data.
              </div>
            </>
          )}
        </div>
        <div className="and-peakrow">
          <span className="and-peaknum">{peak}</span>
          <div className="and-peakbar">
            <div className="and-peakfill" style={{ width: `${peak}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- overview and the transcript ---- */

function OverviewTab({
  result,
  transcript,
  stamps,
  setStamps,
  onCopied,
  onCopyFailed,
}: {
  result: AnalysisResult;
  transcript: TranscriptLine[];
  stamps: boolean;
  setStamps(v: boolean): void;
  onCopied(): void;
  onCopyFailed(err: unknown): void;
}) {
  const words = useMemo(
    () =>
      transcript
        .map((l) => l.text)
        .join(" ")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length,
    [transcript],
  );
  const plain = useMemo(
    () =>
      transcript
        .map((l) => (stamps ? `${fmt(l.start)}  ${l.text.trim()}` : l.text.trim()))
        .join(stamps ? "\n" : " "),
    [transcript, stamps],
  );

  return (
    <>
      <div className="card glass and-overview">
        {result.category && <span className="chip and-cat">{result.category}</span>}
        <p className="and-para">{result.overview}</p>
        {result.viewerValue && (
          <div className="and-value">
            <div className="lab">Viewer value</div>
            <div>{result.viewerValue}</div>
          </div>
        )}
        {(result.whatWorked ?? []).length > 0 && (
          <>
            <div className="lab and-worklab">What worked</div>
            <ul className="and-worked">
              {result.whatWorked.map((w, i) => (
                <li key={i}>
                  <Tick />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="card glass and-transcript">
        <div className="rowhead">
          <div>
            <h3>Transcript</h3>
            <div className="sub">
              {words} {words === 1 ? "word" : "words"}. Copy it to study, adapt, or repurpose.
            </div>
          </div>
          <div className="and-tactions">
            <button className="mini" onClick={() => setStamps(!stamps)}>
              {stamps ? "Hide timestamps" : "Show timestamps"}
            </button>
            <button
              className="mini"
              onClick={() => {
                navigator.clipboard.writeText(plain).then(onCopied, onCopyFailed);
              }}
            >
              Copy
            </button>
          </div>
        </div>
        {transcript.length === 0 ? (
          <div className="empty">No words were picked up in this video.</div>
        ) : stamps ? (
          <div className="and-lines">
            {transcript.map((l, i) => (
              <div className="and-line" key={i}>
                <span className="and-stamp mini">{fmt(l.start)}</span>
                <span>{l.text.trim()}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="and-para">{plain}</p>
        )}
      </div>
    </>
  );
}

/* ---- spin-off ideas ---- */

function SpinOffTab({
  spinOffs,
  added,
  generating,
  onAdd,
  onGenerate,
}: {
  spinOffs: SpinOff[];
  added: Set<number>;
  generating: boolean;
  onAdd(i: number): void | Promise<void>;
  onGenerate(): void | Promise<void>;
}) {
  return (
    <div className="and-spins stagger">
      {spinOffs.length === 0 && (
        <div className="empty">No spin-offs came out of this one. Generate a few.</div>
      )}
      {spinOffs.map((s, i) => (
        <div className="card glass and-spin" key={i}>
          <div className="and-badge">
            <span>Idea</span>
            <span>Hook</span>
          </div>
          <div className="and-spinbody">
            <b>{s.idea}</b>
            <div className="and-hook">&ldquo;{s.hook}&rdquo;</div>
            <button
              className="cbtn and-addidea"
              disabled={added.has(i)}
              onClick={() => void onAdd(i)}
            >
              {added.has(i) ? "Added" : "+ Add to ideas"}
            </button>
          </div>
        </div>
      ))}
      <button className="btn ghost and-more" disabled={generating} onClick={() => void onGenerate()}>
        {generating ? "Writing three more" : "Generate more"}
      </button>
    </div>
  );
}
