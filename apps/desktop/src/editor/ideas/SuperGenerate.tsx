import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";

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
  script?: string;
  creator?: string;
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
}: {
  run: SuperRun;
  onCancel: () => void;
  onAdd: (idea: SuperIdea) => void;
  added: string[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const finished = run.creators.filter((c) => c.status === "done" || c.status === "skipped" || c.status === "failed").length;
  const books = run.creators.filter((c) => c.playbook);

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
          <div className="sglab">Ideas for your niche · {run.ideas.length}</div>
          <div className="sgideas">
            {run.ideas.map((i) => (
              <div className="card glass sgidea" key={i.text}>
                {i.creator && (
                  <span className="sgcreator">
                    <PlatformDot platform="youtube" />
                    From {i.creator}
                  </span>
                )}
                <div className="sgideatext">{i.text}</div>
                {i.script && <div className="sgscript">{i.script.replace(/^HOOK\s*:\s*/im, "Say this · Hook: ")}</div>}
                <div className="sgideafoot">
                  <span className="sub">{i.label}</span>
                  <button className="cbtn" disabled={added.includes(i.text)} onClick={() => onAdd(i)}>
                    {added.includes(i.text) ? "Added" : "+ Add idea"}
                  </button>
                </div>
              </div>
            ))}
          </div>
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
