import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { FormatTag, Icon, NeedChips, Pills, hookLine } from "./coralBits";

export interface RemixVariant {
  text: string;
  label: string;
  format: string;
  funnelStage: string | null;
  whyItWorks: string;
  difficulty: string;
  needs: Array<{ type: string; label: string }>;
  script: string;
  shots: Array<Record<string, string>>;
  creator?: string;
}

/**
 * Three remixes of one saved idea, each with Save, plus Remix again. A modal
 * over the dimmed saved card on desktop, a bottom sheet with a grabber on phones.
 */
export default function RemixSheet({ ideaId, title, niche, onClose, onSaved }: { ideaId: string; title: string; niche: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [data, setData] = useState<{ clientId: string; variants: RemixVariant[] } | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    setState("loading");
    api.post<{ clientId: string; variants: RemixVariant[] }>(`/ideas/${ideaId}/remix`, {})
      .then((got) => { if (live) { setData(got); setState("ready"); } })
      .catch((err: unknown) => { if (live) { setError(err instanceof Error ? err.message : "Could not remix this idea."); setState("error"); } });
    return () => { live = false; };
  }, [ideaId, tries]);

  const feedback = (v: RemixVariant, isSaved: boolean) => {
    if (!data) return;
    void api.post(`/clients/${data.clientId}/idea-feedback`, {
      runId: `remix-${ideaId}`,
      events: [{ text: v.text, ...(v.format ? { format: v.format } : {}), ...(v.funnelStage ? { funnelStage: v.funnelStage } : {}), ...(v.label ? { hookStyle: v.label } : {}), ...(v.creator ? { creator: v.creator } : {}), saved: isSaved }],
    }).catch(() => undefined);
  };

  /** Variants shown but not saved count as skips in the learning loop. */
  const skipUnsaved = () => {
    if (data) for (const v of data.variants) if (!saved.includes(v.text)) feedback(v, false);
  };
  const close = () => {
    skipUnsaved();
    onClose();
  };
  const again = () => {
    skipUnsaved();
    setTries((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = async (v: RemixVariant) => {
    if (!data) return;
    try {
      await api.post(`/clients/${data.clientId}/ideas`, {
        text: v.text,
        formatName: v.format ? `${v.format} · ${v.label}` : v.label,
        niche: niche.slice(0, 200),
        source: "analysis",
        scriptText: v.script,
        ...(v.creator ? { creator: v.creator } : {}),
        ...(v.shots.length ? { shots: v.shots.slice(0, 8) } : {}),
        ...(v.funnelStage ? { funnelStage: v.funnelStage } : {}),
        ...(v.whyItWorks ? { whyItWorks: v.whyItWorks } : {}),
        difficulty: v.difficulty,
        ...(v.needs.length ? { needs: v.needs } : {}),
        remixedFromId: ideaId,
      });
      feedback(v, true);
      setSaved((cur) => [...cur, v.text]);
      onSaved();
      toast.success("Remix saved as a new idea");
    } catch (err) {
      toast.fail("Could not save that remix", err);
    }
  };

  return (
    <div className="co-scrim" onClick={close}>
      <div className="co-modal" role="dialog" aria-modal="true" aria-label="Remix" onClick={(e) => e.stopPropagation()}>
        <div className="co-grab" aria-hidden="true" />
        <div className="co-mh">
          <button type="button" className="co-x" aria-label="Close" onClick={close}><Icon n="x" s={18} /></button>
          <div className="co-lab acc">Remix · 3 variants</div>
          <h2 className="co-d">Remix<Icon n="shuffle" s={40} w={2.4} /></h2>
          <p>Remixed from: <b>{title}</b></p>
        </div>
        {state === "loading" && <div className="co-mstate">Writing 3 fresh takes...</div>}
        {state === "error" && (
          <div className="co-mstate">
            {error}
            <button type="button" className="co-gb" onClick={() => setTries((n) => n + 1)}>Try again</button>
          </div>
        )}
        {state === "ready" && data && data.variants.map((v, k) => {
          const L = "ABCDE"[k] ?? String(k + 1);
          const hook = hookLine(v.script);
          return (
            <div className="co-rv" key={v.text}>
              <div className="co-L">{L}<small>Variant {L}</small></div>
              <div className="co-rvb">
                <div className="co-rvt"><FormatTag name={v.format} /><Pills stage={v.funnelStage} level={v.difficulty} /></div>
                <h3>{v.text}</h3>
                {hook && <div className="co-hk"><span className="co-lab">Say this · Hook:</span><p>{hook}</p></div>}
                <NeedChips needs={v.needs} />
                {v.whyItWorks && <p className="co-wy"><b>Why this works</b>{v.whyItWorks}</p>}
                <div className="co-rvf">
                  <span className="co-lab">{v.label}</span>
                  <button type="button" className="co-sb" disabled={saved.includes(v.text)} onClick={() => void save(v)}>
                    <Icon n={saved.includes(v.text) ? "check" : "bookmark"} s={14} />{saved.includes(v.text) ? "Saved" : "Save"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        <div className="co-mf">
          <span>New hooks and formats, same idea. Save the ones you like.</span>
          <button type="button" className="co-rb" disabled={state === "loading"} onClick={again}><Icon n="shuffle" />Remix again</button>
        </div>
      </div>
    </div>
  );
}
