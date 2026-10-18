import { useEffect, useRef, useState } from "react";
import { api, API_URL } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { stepIndex } from "../../lib/ideaContext";
import { burstConfetti } from "./confetti";
import RemixSheet from "./RemixSheet";
import { Avatar, FormatTag, Icon, NeedChips, Pills } from "./coralBits";

/**
 * Saved ideas, one card at a time (Coral Edition): the giant issue-style
 * counter, creator filter chips, then the card with its coral spine, topic,
 * the hook as a pull-quote, Setup / Payoff / CTA, why it works, the GIFs and
 * the actions. Big Previous / Next, swipe on the phone, the arrow keys on
 * desktop, and a done tick (full-screen confetti; a soft fade-back when unticked).
 */

export interface SavedIdea {
  id: string;
  text: string;
  hook: string | null;
  formatName: string | null;
  niche: string;
  status: string;
  source: string;
  scriptText: string | null;
  creator: string | null;
  funnelStage?: string | null;
  whyItWorks?: string | null;
  difficulty?: string | null;
  needs?: Array<{ type: string; label: string }> | null;
  completed: boolean;
  gifs: Array<{ kind: string; key: string; caption: string }> | null;
  createdAt: string;
  updatedAt?: string;
}

const LINE = /^(HOOK|SETUP|PAYOFF|CTA)\s*:\s*/i;
const SOURCE: Record<string, string> = { analysis: "Super generate", brainstorm: "Brainstorm", overview: "Overview", custom: "Your idea" };

/** Splits a script into its HOOK line, the labelled beats, and any loose lines. */
function parseScript(text: string) {
  let hook = "";
  const beats: Array<{ label: string; body: string }> = [];
  const loose: string[] = [];
  for (const l of text.split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
    const m = l.match(LINE);
    const body = l.replace(LINE, "");
    if (!m) loose.push(l);
    else if (m[1]!.toUpperCase() === "HOOK") hook = body;
    else beats.push({ label: m[1]!.toUpperCase() === "CTA" ? "CTA" : m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase(), body });
  }
  return { hook, beats, loose };
}

const pad = (n: number) => String(n).padStart(2, "0");

export default function SavedIdeas({ clientId, reloadKey, onFolio }: { clientId: string; reloadKey: number; onFolio?: (folio: string) => void }) {
  const toast = useToast();
  const [ideas, setIdeas] = useState<SavedIdea[] | null>(null);
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState<string>("");
  const [remixId, setRemixId] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [anim, setAnim] = useState<"" | "checking" | "unchecking">("");
  const touch = useRef<{ x: number; y: number } | null>(null);
  const checkRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const got = await api.get<SavedIdea[]>(`/clients/${clientId}/ideas`);
        if (!live) return;
        setIdeas(got);
        setIndex((i) => stepIndex(i, 0, got.length));
      } catch (err) {
        if (live) toast.fail("Could not load saved ideas", err);
      }
    })();
    return () => {
      live = false;
    };
  }, [clientId, reloadKey, toast, bump]);

  // While the worker draws the GIFs for this idea, look again every few seconds.
  const waitingId = ideas?.[index] && ideas[index].scriptText && !ideas[index].gifs ? ideas[index].id : null;
  const tries = useRef(0);
  useEffect(() => {
    if (!waitingId) return;
    if (tries.current > 20) return;
    const t = setTimeout(async () => {
      tries.current += 1;
      try {
        const got = await api.get<SavedIdea[]>(`/clients/${clientId}/ideas`);
        setIdeas((cur) => (cur ? cur.map((i) => got.find((g) => g.id === i.id) ?? i) : got));
      } catch {
        /* try again next tick */
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [waitingId, ideas, clientId]);

  const shown = (ideas ?? []).filter((i) => !filter || i.creator === filter);
  const creators = [...new Set((ideas ?? []).map((i) => i.creator).filter((c): c is string => Boolean(c)))];
  const count = shown.length;
  const at = Math.min(index, Math.max(0, count - 1));
  const step = (d: number) => {
    setAnim("");
    setIndex((i) => stepIndex(i, d, count));
  };

  useEffect(() => {
    onFolio?.(pad(count ? at + 1 : 0));
  }, [at, count, onFolio]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (remixId || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!ideas) return <div className="skel nicheskel" />;
  if (ideas.length === 0) {
    return (
      <div className="co-empty">
        <h3 className="co-d">No saved ideas yet</h3>
        <p>Press Save idea on an idea in the Generate tab and it lands here.</p>
      </div>
    );
  }
  const idea = shown[at];
  const done = ideas.filter((i) => i.completed).length;

  const toggleDone = async () => {
    if (!idea) return;
    const next = !idea.completed;
    setIdeas((cur) => (cur ?? []).map((i) => (i.id === idea.id ? { ...i, completed: next, updatedAt: new Date().toISOString() } : i)));
    setAnim(next ? "checking" : "unchecking");
    if (next) burstConfetti(checkRef.current);
    try {
      await api.patch(`/ideas/${idea.id}`, { completed: next });
    } catch (err) {
      setIdeas((cur) => (cur ?? []).map((i) => (i.id === idea.id ? { ...i, completed: !next } : i)));
      toast.fail("Could not save that", err);
    }
  };

  const remove = async () => {
    if (!idea) return;
    try {
      await api.del(`/ideas/${idea.id}`);
      setIdeas((cur) => (cur ?? []).filter((i) => i.id !== idea.id));
      setIndex((i) => Math.max(0, Math.min(i, count - 2)));
    } catch (err) {
      toast.fail("Could not remove that idea", err);
    }
  };

  const copy = async () => {
    if (!idea) return;
    try {
      await navigator.clipboard.writeText(`${idea.hook || idea.text}\n\n${idea.scriptText ?? ""}`.trim());
      toast.success("Copied");
    } catch (err) {
      toast.fail("Could not copy", err);
    }
  };

  const title = idea ? idea.hook || idea.text : "";
  const script = idea?.scriptText ? parseScript(idea.scriptText) : null;
  const sayThis = script?.hook || (idea && idea.hook && idea.text !== idea.hook ? idea.text : "");
  const source = idea ? SOURCE[idea.source] ?? idea.source : "";
  const stampDate = idea?.completed
    ? new Date(idea.updatedAt ?? idea.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase()
    : "";
  const stamp = idea?.completed ? <div className="co-stamp" aria-hidden="true"><b>SHOT</b><span>{stampDate} · DONE</span></div> : null;

  return (
    <div className="co-saved">
      <div className="co-bar">
        <div className="co-num">
          <b aria-hidden="true">{pad(count ? at + 1 : 0)}</b>
          <span><em>{count ? at + 1 : 0} of {count}</em>saved ideas{done ? ` · ${done} done` : ""}</span>
        </div>
        {creators.length > 0 && (
          <div className="co-chips">
            <button type="button" className={`co-chip${filter === "" ? " on" : ""}`} onClick={() => { setFilter(""); setIndex(0); }}>
              All {ideas.length}
            </button>
            {creators.map((c) => (
              <button type="button" key={c} className={`co-chip${filter === c ? " on" : ""}`} onClick={() => { setFilter(c); setIndex(0); }}>
                <Avatar handle={c} small />{c}
              </button>
            ))}
          </div>
        )}
      </div>

      {idea && (
        <article
          key={idea.id}
          className={`co-sv${idea.completed ? " done" : ""}${anim ? ` ${anim}` : ""}`}
          onTouchStart={(e) => {
            touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          }}
          onTouchEnd={(e) => {
            const s = touch.current;
            touch.current = null;
            if (!s) return;
            const dx = e.changedTouches[0].clientX - s.x;
            const dy = e.changedTouches[0].clientY - s.y;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
          }}
        >
          <div className="co-crops" aria-hidden="true" />
          <div className="co-spine">
            <span>No. {pad(at + 1)} · Saved idea<span className="co-desk"> · {source}</span></span>
            <span className="co-phone">{source}</span>
          </div>
          <div className="co-svin">
            <div className="co-ch">
              {idea.creator && <Avatar handle={idea.creator} />}
              <div className="co-who">
                <b>{idea.creator ? `From ${idea.creator}` : source}</b>
                <span>{[idea.creator ? source : "", idea.niche].filter(Boolean).join(" · ")}</span>
              </div>
              <Pills stage={idea.funnelStage} level={idea.difficulty} />
            </div>
            <div className="co-tl"><span className="co-lab">Topic</span><FormatTag name={idea.formatName} /></div>
            <h2 className="co-d co-topic">{title}</h2>
            <NeedChips needs={idea.needs} />
            {sayThis && (
              <div className="co-hook">
                <span className="co-q" aria-hidden="true">&#8220;</span>
                <div className="co-lab">Say this · Hook:</div>
                <blockquote>{sayThis}</blockquote>
              </div>
            )}
            {script && script.beats.length > 0 && (
              <div className="co-steps">
                {script.beats.map((b, k) => (
                  <div key={k}><div className="co-lab">{b.label}<em>{pad(k + 2)}</em></div>{b.body}</div>
                ))}
              </div>
            )}
            {script && script.loose.length > 0 && (
              <div className="co-loose">{script.loose.map((l, k) => <p key={k}>{l}</p>)}</div>
            )}
            {idea.whyItWorks && (
              <div className="co-why"><span className="co-lab">Why this works</span><p>{idea.whyItWorks}</p></div>
            )}
            {idea.scriptText && (
              <div className="co-sec">
                <div className="co-lab">See it</div>
                {idea.gifs && idea.gifs.length > 0 ? (
                  <div className="co-see">
                    {idea.gifs.map((g, k) => {
                      const m = g.caption.match(/^(Say this · Hook:|Shot \d+)\s*(?:·\s*)?(.*)$/);
                      return (
                        <figure key={g.key}>
                          <img src={`${API_URL}/idea-gifs/${g.key}.gif`} alt={g.caption} loading="lazy" width={480} height={270} />
                          <figcaption><i>Fig. {k + 1}</i>{m ? <><b>{m[1]}</b> {m[2]}</> : g.caption}</figcaption>
                        </figure>
                      );
                    })}
                  </div>
                ) : (
                  <div className="co-gifwait">
                    <span>Drawing the hook and shot GIFs...</span>
                    <button
                      type="button"
                      className="co-gb"
                      onClick={async () => {
                        tries.current = 0;
                        try {
                          await api.post(`/ideas/${idea.id}/gifs`, {});
                          setIdeas((cur) => (cur ?? []).map((i) => (i.id === idea.id ? { ...i, gifs: null } : i)));
                        } catch (err) {
                          toast.fail("Could not start the GIFs", err);
                        }
                      }}
                    >
                      Make GIFs
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="co-foot">
              <button type="button" className="co-gb" onClick={() => void copy()}>Copy script</button>
              <button type="button" className="co-rb" onClick={() => setRemixId(idea.id)}><Icon n="shuffle" />Remix</button>
              <button type="button" className="co-gb" onClick={() => void remove()}>Remove</button>
              <span className={`co-done${idea.completed ? " on" : ""}`}>
                <span>{idea.completed ? "Done" : "Mark done"}</span>
                <span className="co-phone">{stamp}</span>
                <button
                  type="button"
                  ref={checkRef}
                  className="co-tick"
                  role="checkbox"
                  aria-checked={idea.completed}
                  aria-label={idea.completed ? "Mark not done" : "Mark done"}
                  onClick={() => void toggleDone()}
                >
                  <Icon n="check" s={20} w={3} />
                </button>
              </span>
            </div>
            <span className="co-desk">{stamp}</span>
            <div className="co-folio">Toreroflow Ideas · p. {pad(at + 1)}</div>
          </div>
        </article>
      )}
      {idea && remixId === idea.id && (
        <RemixSheet ideaId={idea.id} title={title} niche={idea.niche} onClose={() => setRemixId(null)} onSaved={() => setBump((n) => n + 1)} />
      )}

      <div className="co-stick">
        <div className="co-pn">
          <button type="button" className="co-big" disabled={at === 0} onClick={() => step(-1)}>‹ Previous</button>
          <button type="button" className="co-big p" disabled={at >= count - 1} onClick={() => step(1)}>Next ›</button>
        </div>
      </div>
      <p className="co-hint">
        <span className="co-desk">Swipe or use the arrow keys to switch ideas</span>
        <span className="co-phone">Swipe left or right to switch ideas</span>
      </p>
    </div>
  );
}
