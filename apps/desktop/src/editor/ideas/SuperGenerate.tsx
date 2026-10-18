import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { Avatar, Icon, IdeaCard, StatBand, hookLine, stageCounts } from "./coralBits";

/**
 * The Super generate results, laid out as in the approved v2 mockup: one row
 * per creator with its status, a "what works" card per creator that opens
 * and closes, then the ideas as cards with + Add idea on each.
 */

export interface Playbook {
  summary: string;
  hook: string;
  framing: string;
  structure: string;
  script: string;
}

export interface CreatorRow {
  url: string;
  handle: string;
  platform: string;
  status: "queued" | "reading" | "analyzing" | "done" | "skipped" | "failed";
  videos: number;
  note: string;
  playbook?: Playbook;
}

export interface SuperIdea {
  text: string;
  label: string;
  /** The video format, from VIDEO_FORMATS (runs before v0.3.33 have none). */
  format?: string;
  /** top | middle | bottom, shown as the funnel pill and stored on save. */
  funnelStage?: string;
  /** One sentence on why the idea works (runs before v0.3.33 have none). */
  whyItWorks?: string;
  /** easy | medium | hard to film. */
  difficulty?: string;
  /** What the shoot needs, max 4. */
  needs?: Array<{ type: string; label: string }>;
  script?: string;
  creator?: string;
  shots?: Array<Record<string, string>>;
}

export interface SuperRun {
  id: string;
  status: "running" | "ready" | "failed" | "cancelled";
  creators: CreatorRow[];
  ideas: SuperIdea[];
  capCents: number;
  spentCents: number;
  error: string | null;
  createdAt: string;
}

const STATUS: Record<CreatorRow["status"], string> = {
  queued: "Waiting",
  reading: "Reading",
  analyzing: "Analyzing",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
};

export function PlatformDot({ platform }: { platform: string }) {
  return <span className={`pdot ${platform}`} aria-hidden />;
}

export default function SuperGenerate({
  run,
  onCancel,
  onAdd,
  added,
  onRerun,
  busy,
}: {
  run: SuperRun;
  onCancel: () => void;
  onAdd: (idea: SuperIdea) => void;
  added: string[];
  /** Runs again: one creator (per-creator Generate) or all of them. */
  onRerun?: (creator?: string) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const finished = run.creators.filter((c) => c.status === "done" || c.status === "skipped" || c.status === "failed").length;
  const books = run.creators.filter((c) => c.playbook);
  const single = run.creators.length === 1 ? run.creators[0] : undefined;
  const perCreator: Record<string, number> = {};
  for (const i of run.ideas) if (i.creator) perCreator[i.creator] = (perCreator[i.creator] ?? 0) + 1;
  const handles = Object.keys(perCreator);
  /* Highlights one unsaved idea from this run; nothing is generated or saved. */
  const pickOne = () => {
    const pool = run.ideas.filter((i) => !added.includes(i.text) && i.text !== picked);
    const got = pool[Math.floor(Math.random() * pool.length)];
    if (!got) return;
    setPicked(got.text);
    if (run.ideas.indexOf(got) >= 10) setAll(true);
  };

  useEffect(() => {
    if (open === null && books[0]) setOpen(books[0].url);
  }, [books, open]);

  return (
    <div className="supergen">
      <div className="card glass sgprogress">
        <div className="sghead">
          <b>✦ Super generate</b>
          <div className="sgheadr">
            <span className="sub">
              {run.status === "running"
                ? `${finished} of ${run.creators.length} done`
                : run.status === "ready"
                  ? `Finished · about $${(run.spentCents / 100).toFixed(2)} of $${(run.capCents / 100).toFixed(2)} cap`
                  : run.status === "cancelled"
                    ? "Cancelled"
                    : "Stopped"}
            </span>
            {run.status === "running" && (
              <button className="btn ghost" onClick={onCancel}>
                Cancel
              </button>
            )}
          </div>
        </div>
        {run.creators.map((c) => (
          <div className="sgrow" key={c.url}>
            <PlatformDot platform={c.platform} />
            <b>{c.handle}</b>
            <span className="sub">
              {c.videos > 0 ? `${c.videos} videos` : ""}
              {c.note ? `${c.videos > 0 ? " · " : ""}${c.note}` : ""}
            </span>
            <span className={`sgstat ${c.status}`}>
              {c.status === "done" ? "✓ " : ""}
              {STATUS[c.status]}
            </span>
          </div>
        ))}
        {run.error && <div className="sgerr">{run.error}</div>}
      </div>

      {books.length > 0 && (
        <>
          <div className="sglab">What works for these creators</div>
          {books.map((c) => {
            const isOpen = open === c.url;
            return (
              <div className="card glass sgbook" key={c.url}>
                <button className="sgbookhead" onClick={() => setOpen(isOpen ? "" : c.url)}>
                  <PlatformDot platform={c.platform} />
                  <b>{c.handle}</b>
                  {!isOpen && <span className="sub">{c.playbook!.summary}</span>}
                  <span className="sgtoggle">{isOpen ? "▾ Hide" : "▸ Show"}</span>
                </button>
                {isOpen && (
                  <ul className="sgbullets">
                    <li><b>Hook:</b> {c.playbook!.hook}</li>
                    <li><b>Framing:</b> {c.playbook!.framing}</li>
                    <li><b>Structure:</b> {c.playbook!.structure}</li>
                    <li><b>Script:</b> {c.playbook!.script}</li>
                  </ul>
                )}
              </div>
            );
          })}
        </>
      )}

      {run.ideas.length > 0 && (
        <>
          {single ? (
            <div className="co-crow">
              <Avatar handle={single.handle} />
              <div className="co-who"><b>{single.handle}</b><span>{single.platform === "youtube" ? "YouTube" : single.platform}{single.videos > 0 ? ` · ${single.videos} videos analyzed` : ""}</span></div>
              {onRerun && (
                <button type="button" className="co-btn" disabled={busy} onClick={() => onRerun(single.url)}>
                  <Icon n="spark" />Generate
                </button>
              )}
            </div>
          ) : (
            <div className="co-row">
              {onRerun && (
                <button type="button" className="co-btn" disabled={busy} onClick={() => onRerun()}>
                  <Icon n="spark" />Super generate
                </button>
              )}
              <button type="button" className="co-btn ghost" onClick={pickOne}>
                <Icon n="dice" s={18} />Pick for me
              </button>
            </div>
          )}
          <StatBand
            total={run.ideas.length}
            totalLabel={single ? "new ideas" : "ideas"}
            stages={stageCounts(run.ideas)}
            extra={single ? undefined : <div><b>{handles.length}</b>creators</div>}
          />
          {!single && handles.length > 0 && (
            <div className="co-spread">
              <span className="co-lab">Spread</span>
              {handles.map((h) => (
                <span className="it" key={h} title={h}>
                  <Avatar handle={h} small />
                  {perCreator[h]! > 1 && <em>×{perCreator[h]}</em>}
                </span>
              ))}
            </div>
          )}
          <div className={`co-grid${all ? " all" : ""}`}>
            {run.ideas.map((i, k) => (
              <IdeaCard
                key={i.text}
                no={k + 1}
                picked={picked === i.text}
                idea={{ title: i.text, creator: i.creator, funnelStage: i.funnelStage, difficulty: i.difficulty, needs: i.needs, hook: hookLine(i.script), why: i.whyItWorks, format: i.format || i.label }}
                saved={added.includes(i.text)}
                onSave={() => onAdd(i)}
              />
            ))}
          </div>
          {run.ideas.length > 10 && !all && (
            <button type="button" className="co-btn ghost co-more" onClick={() => setAll(true)}>
              Show {run.ideas.length - 10} more ideas
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Polls the run while it is going. */
export function useSuperRun(clientId: string) {
  const toast = useToast();
  const [run, setRun] = useState<SuperRun | null>(null);
  const [ready, setReady] = useState({ youtubeReady: true, modelReady: true });
  const running = run?.status === "running";
  const runId = run?.id;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const got = await api.get<{ run: SuperRun | null; youtubeReady: boolean; modelReady: boolean }>(
          `/clients/${clientId}/super-generate`,
        );
        if (!live) return;
        setRun(got.run);
        setReady({ youtubeReady: got.youtubeReady, modelReady: got.modelReady });
        if (got.run?.status === "running") timer = setTimeout(tick, 3000);
      } catch (err) {
        if (live) toast.fail("Could not load Super generate", err);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [clientId, toast, runId, running]);

  return { run, setRun, ...ready };
}
