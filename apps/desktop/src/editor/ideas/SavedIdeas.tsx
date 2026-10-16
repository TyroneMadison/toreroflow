import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { stepIndex } from "../../lib/ideaContext";
import { burstConfetti } from "./confetti";

/**
 * Saved ideas, one card at a time (Ideas v2 mockup): source creator on top,
 * the topic, then the script. Big Previous / Next, swipe on the phone, the
 * arrow keys on desktop, an "n of N" counter, a creator filter, and a check
 * to mark an idea done (full-screen confetti; a soft fade-back when unticked).
 */

interface SavedIdea {
  id: string;
  text: string;
  hook: string | null;
  formatName: string | null;
  niche: string;
  status: string;
  source: string;
  scriptText: string | null;
  creator: string | null;
  completed: boolean;
  createdAt: string;
}

const LINE = /^(HOOK|SETUP|PAYOFF|CTA)\s*:\s*/i;

function ScriptLines({ text }: { text: string }) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return (
    <div className="sv2script">
      {lines.map((l, i) => {
        const m = l.match(LINE);
        return (
          <p key={i}>
            {m && <i>{m[1].toUpperCase() === "HOOK" ? "Say this · Hook:" : m[1].toUpperCase()}</i>}
            {m ? l.replace(LINE, "") : l}
          </p>
        );
      })}
    </div>
  );
}

function initials(h: string) {
  return h.replace(/^@/, "").slice(0, 2).toUpperCase() || "?";
}
function hue(h: string) {
  let n = 0;
  for (const c of h) n = (n * 31 + c.charCodeAt(0)) % 360;
  return n;
}

export default function SavedIdeas({ clientId, reloadKey }: { clientId: string; reloadKey: number }) {
  const toast = useToast();
  const [ideas, setIdeas] = useState<SavedIdea[] | null>(null);
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState<string>("");
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
  }, [clientId, reloadKey, toast]);

  const shown = (ideas ?? []).filter((i) => !filter || i.creator === filter);
  const creators = [...new Set((ideas ?? []).map((i) => i.creator).filter((c): c is string => Boolean(c)))];
  const count = shown.length;
  const step = (d: number) => {
    setAnim("");
    setIndex((i) => stepIndex(i, d, count));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!ideas) return <div className="skel nicheskel" />;
  if (ideas.length === 0) {
    return (
      <div className="card glass savedstep">
        <h3>No saved ideas yet</h3>
        <div className="sub">Press + Add idea on an idea in the Generate tab and it lands here.</div>
      </div>
    );
  }
  const at = Math.min(index, Math.max(0, count - 1));
  const idea = shown[at];

  const toggleDone = async () => {
    if (!idea) return;
    const next = !idea.completed;
    setIdeas((cur) => (cur ?? []).map((i) => (i.id === idea.id ? { ...i, completed: next } : i)));
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

  return (
    <div className="sv2">
      <div className="sv2counter">
        <div className="sv2n">
          <b>{count ? at + 1 : 0}</b> of {count}
        </div>
        {creators.length > 0 && (
          <div className="sv2filter">
            <button className={`sv2chip${filter === "" ? " on" : ""}`} onClick={() => { setFilter(""); setIndex(0); }}>
              All
            </button>
            {creators.map((c) => (
              <button key={c} className={`sv2chip${filter === c ? " on" : ""}`} onClick={() => { setFilter(c); setIndex(0); }}>
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {idea && (
        <div
          key={idea.id}
          className={`sv2card${idea.completed ? " done" : ""}${anim ? ` ${anim}` : ""}`}
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
          <div className="sv2head">
            {idea.creator ? (
              <>
                <div className="sv2av" style={{ background: `hsl(${hue(idea.creator)} 70% 58%)` }}>
                  {initials(idea.creator)}
                </div>
                <div className="sv2who">
                  <b>From {idea.creator}</b>
                  <span>{idea.source === "analysis" ? "Super generate" : idea.source}</span>
                </div>
              </>
            ) : (
              <div className="sv2who">
                <b>{idea.source === "custom" ? "Your idea" : idea.source}</b>
                {idea.niche && <span>{idea.niche}</span>}
              </div>
            )}
            <div className="sv2tags">
              {idea.formatName && <span className="sv2tag">{idea.formatName}</span>}
              {idea.completed && <span className="sv2tag g">Done</span>}
            </div>
            <button
              ref={checkRef}
              className="sv2check"
              aria-pressed={idea.completed}
              title={idea.completed ? "Mark not done" : "Mark done"}
              onClick={() => void toggleDone()}
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </button>
          </div>
          <div className="sv2body">
            <div className="sv2lab">Topic</div>
            <h2 className="sv2topic">{idea.hook || idea.text}</h2>
            {idea.hook && idea.text !== idea.hook && <div className="sub sv2sub">{idea.text}</div>}
            {idea.scriptText && (
              <>
                <div className="sv2lab">Script</div>
                <ScriptLines text={idea.scriptText} />
              </>
            )}
          </div>
          <div className="sv2acts">
            <button className="sv2ab" onClick={() => void copy()}>Copy script</button>
            <button className="sv2ab" onClick={() => void remove()}>Remove</button>
          </div>
        </div>
      )}

      <div className="sv2sel">
        <button className="sv2big" disabled={at === 0} onClick={() => step(-1)}>
          ‹ Previous
        </button>
        <button className="sv2big p" disabled={at >= count - 1} onClick={() => step(1)}>
          Next ›
        </button>
      </div>
      <div className="sv2hint">
        <span className="sv2desk">← → arrow keys also work</span>
        <span className="sv2phone">Swipe left or right to switch ideas</span>
      </div>
      {count > 1 && (
        <div className="sv2dots">
          {shown.slice(0, 30).map((v, i) => (
            <button key={v.id} className={i === at ? "on" : ""} title={`Idea ${i + 1}`} onClick={() => setIndex(i)} />
          ))}
        </div>
      )}
    </div>
  );
}