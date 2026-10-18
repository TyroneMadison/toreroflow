import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";

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

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Three remixes of one saved idea, each with Save. A sheet from the bottom on phones. */
export default function RemixSheet({ ideaId, niche, onClose, onSaved }: { ideaId: string; niche: string; onClose: () => void; onSaved: () => void }) {
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

  const close = () => {
    // Variants shown but not saved count as skips in the learning loop.
    if (data) for (const v of data.variants) if (!saved.includes(v.text)) feedback(v, false);
    onClose();
  };

  const save = async (v: RemixVariant) => {
    if (!data) return;
    try {
      await api.post(`/clients/${data.clientId}/ideas`, {
        text: v.text,
        formatName: v.format ? `${v.format} \u00b7 ${v.label}` : v.label,
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
    <div className="remixback" onClick={close}>
      <div className="remixsheet" role="dialog" aria-label="Remix" onClick={(e) => e.stopPropagation()}>
        <div className="remixhead">
          <b>Remix</b>
          <button className="cbtn" onClick={close}>Close</button>
        </div>
        {state === "loading" && <div className="remixstate">Writing 3 fresh takes...</div>}
        {state === "error" && (
          <div className="remixstate">
            {error}
            <button className="cbtn" onClick={() => setTries((n) => n + 1)}>Try again</button>
          </div>
        )}
        {state === "ready" && data && data.variants.map((v) => (
          <div className="remixcard" key={v.text}>
            <div className="remixtop">
              {v.format && <span className="sgformat">{v.format}</span>}
              {v.difficulty && <span className="difftag">{cap(v.difficulty)}</span>}
            </div>
            {v.needs.length > 0 && (
              <div className="needs"><span className="needslab">Needs:</span>{v.needs.map((n) => <span className="needchip" key={n.label}>{n.label.replace(/^Needs\s+/i, "")}</span>)}</div>
            )}
            <div className="remixtext">{v.text}</div>
            {v.whyItWorks && <div className="whyline"><span className="whylab">Why this works</span>{v.whyItWorks}</div>}
            {v.script && <div className="sgscript">{v.script.replace(/^HOOK\s*:\s*/im, "Say this \u00b7 Hook: ")}</div>}
            <div className="remixfoot">
              <span className="sub">{v.label}</span>
              <button className="cbtn" disabled={saved.includes(v.text)} onClick={() => void save(v)}>
                {saved.includes(v.text) ? "Saved" : "Save"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
