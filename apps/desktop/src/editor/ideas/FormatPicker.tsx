import { FORMAT_FUNNEL_WEIGHTS, FUNNEL_STAGES, VIDEO_FORMATS, VIDEO_FORMAT_GUIDE } from "@toreroflow/core";
import { FunnelPill, Icon } from "./coralBits";

/** The stage with the biggest weight; ties go to the earlier stage. */
function dominant(f: (typeof VIDEO_FORMATS)[number]) {
  const w = FORMAT_FUNNEL_WEIGHTS[f];
  return FUNNEL_STAGES.reduce((best, s) => (w[s] > w[best] ? s : best));
}
const pct = (n: number) => Math.round(n * 100);

/**
 * All 17 formats with their funnel lean. Selecting them is the same selection
 * as the format chips on the Generate tab, so "Use n formats" goes straight there.
 */
export default function FormatPicker({ chosen, setChosen, onUse }: { chosen: string[]; setChosen: (next: string[]) => void; onUse: () => void }) {
  const toggle = (f: string) => setChosen(chosen.includes(f) ? chosen.filter((v) => v !== f) : [...chosen, f]);
  return (
    <div className="co-formats">
      <div className="co-fhead">
        <span className="co-sm"><b>{chosen.length}</b>of {VIDEO_FORMATS.length} selected{chosen.length ? ` · ${chosen.join(", ")}` : ""}</span>
        <button type="button" className="co-btn" disabled={chosen.length === 0} onClick={onUse}>
          <Icon n="check" s={18} w={2.6} />Use {chosen.length || ""} format{chosen.length === 1 ? "" : "s"}
        </button>
      </div>
      <div className="co-legend">
        <span className="co-lab">Funnel lean</span>
        <span><i style={{ background: "var(--co-l1)" }} />Top</span>
        <span><i style={{ background: "var(--co-l2)" }} />Middle</span>
        <span><i style={{ background: "var(--co-l3)" }} />Bottom</span>
        <span>▼ marks the dominant stage, also named in the pill</span>
      </div>
      <div className="co-fgrid">
        {VIDEO_FORMATS.map((f, k) => {
          const w = FORMAT_FUNNEL_WEIGHTS[f];
          const dom = dominant(f);
          const on = chosen.includes(f);
          const desc = VIDEO_FORMAT_GUIDE[f];
          return (
            <div
              key={f}
              className={`co-fc${on ? " co-sel" : ""}`}
              role="checkbox"
              aria-checked={on}
              tabIndex={0}
              onClick={() => toggle(f)}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  toggle(f);
                }
              }}
            >
              <span className="co-ck"><Icon n="check" s={14} w={3} /></span>
              <div className="co-fn"><em>{String(k + 1).padStart(2, "0")}</em><h3>{f}</h3></div>
              <p>{desc[0]!.toUpperCase() + desc.slice(1)}.</p>
              <div className="co-lean" role="img" aria-label={`Top ${pct(w.top)}%, Middle ${pct(w.middle)}%, Bottom ${pct(w.bottom)}%`}>
                {FUNNEL_STAGES.map((s, j) => (
                  <i key={s} className={`s${j + 1}${s === dom ? " dom" : ""}`} style={{ width: `${pct(w[s])}%` }} />
                ))}
              </div>
              <div className="co-lw">
                <span>T <b>{pct(w.top)}</b> · M <b>{pct(w.middle)}</b> · B <b>{pct(w.bottom)}</b></span>
                <FunnelPill stage={dom} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
