import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { stepIndex } from "../../lib/ideaContext";

/**
 * The saved ideas, one card at a time, so they can be gone through in order
 * with Previous and Next (or the arrow keys). The full table sits under it.
 */

interface SavedIdea {
  id: string;
  text: string;
  hook: string | null;
  formatName: string | null;
  niche: string;
  status: string;
  source: string;
  createdAt: string;
}

export default function SavedIdeas({ clientId, reloadKey }: { clientId: string; reloadKey: number }) {
  const toast = useToast();
  const [ideas, setIdeas] = useState<SavedIdea[] | null>(null);
  const [index, setIndex] = useState(0);

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

  const count = ideas?.length ?? 0;
  const step = (d: number) => setIndex((i) => stepIndex(i, d, count));

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
  if (count === 0) {
    return (
      <div className="card glass savedstep">
        <h3>No saved ideas yet</h3>
        <div className="sub">Press + Ideas on a hook in the Generate tab and it lands here.</div>
      </div>
    );
  }
  const idea = ideas[index];
  return (
    <div className="card glass savedstep">
      <div className="savedtop">
        <span className="lab">
          Idea {index + 1} of {count}
        </span>
        <div className="saveddots">
          {ideas.slice(0, 30).map((v, i) => (
            <button
              key={v.id}
              className={`sdot${i === index ? " on" : ""}`}
              title={`Idea ${i + 1}`}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      </div>
      <div className="savedbody">
        {idea.formatName && <span className="chip fcat">{idea.formatName}</span>}
        <b className="savedhook">{idea.hook || idea.text}</b>
        {idea.hook && idea.text !== idea.hook && <div className="sub">{idea.text}</div>}
        <div className="savedmeta">
          <span className="nchip on">{idea.status}</span>
          <span className="nchip">{idea.source}</span>
          {idea.niche && <span className="nchip">{idea.niche}</span>}
        </div>
      </div>
      <div className="nicheactions">
        <button className="btn ghost" disabled={index === 0} onClick={() => step(-1)}>
          Previous
        </button>
        <button className="btn" disabled={index >= count - 1} onClick={() => step(1)}>
          Next
        </button>
      </div>
    </div>
  );
}
