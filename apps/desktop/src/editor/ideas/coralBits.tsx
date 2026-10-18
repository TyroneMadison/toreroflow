import type { ReactNode } from "react";

/**
 * Small pieces shared by the Ideas "Coral Edition" screens (approved v3
 * mockups, 2026-10-18): icons, the funnel and difficulty pills, the format
 * tag, Needs chips, avatars and the generated idea card.
 */

const PATHS = {
  shuffle: <><path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  bookmark: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="currentColor" />,
  dice: <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8.5" cy="8.5" r="1" fill="currentColor" /><circle cx="15.5" cy="15.5" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>,
  quote: <path d="M7 7h4v4c0 3-1 5-4 6M15 7h4v4c0 3-1 5-4 6" />,
};

export function Icon({ n, s = 16, w = 2 }: { n: keyof typeof PATHS; s?: number; w?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[n]}
    </svg>
  );
}

export const FUNNEL_LABEL: Record<string, string> = { top: "Top of funnel", middle: "Middle of funnel", bottom: "Bottom of funnel" };

/** Funnel pill with the 1/2/3 bar meter. Nothing for unknown or missing stages. */
export function FunnelPill({ stage }: { stage?: string | null }) {
  if (!stage || !FUNNEL_LABEL[stage]) return null;
  return (
    <span className={`co-fp ${stage[0]}`}>
      <span className="co-m" aria-hidden="true"><i /><i /><i /></span>
      {FUNNEL_LABEL[stage]}
    </span>
  );
}

const DIFF = ["easy", "medium", "hard"];
export function DiffPill({ level }: { level?: string | null }) {
  const k = DIFF.indexOf(String(level ?? ""));
  if (k < 0) return null;
  return (
    <span className="co-dp">
      <i aria-hidden="true">{DIFF.map((d, j) => <b key={d} className={j <= k ? "on" : ""} />)}</i>
      {DIFF[k]![0]!.toUpperCase() + DIFF[k]!.slice(1)}
    </span>
  );
}

export function Pills({ stage, level }: { stage?: string | null; level?: string | null }) {
  if (!stage && !level) return null;
  return <span className="co-pills"><FunnelPill stage={stage} /><DiffPill level={level} /></span>;
}

export function FormatTag({ name }: { name?: string | null }) {
  if (!name) return null;
  return <span className="co-fmt"><Icon n="grid" s={12} w={2.4} />{name}</span>;
}

export function NeedChips({ needs }: { needs?: Array<{ type: string; label: string }> | null }) {
  if (!needs?.length) return null;
  return (
    <div className="co-needs">
      <span className="co-lab">Needs</span>
      {needs.map((n) => <span className="co-nd" key={n.label}>{n.label.replace(/^Needs\s+/i, "").replace(/^(a|an)\s+/i, "").replace(/^./, (c) => c.toUpperCase())}</span>)}
    </div>
  );
}

export function initials(h: string) {
  return h.replace(/^@/, "").slice(0, 2).toUpperCase() || "?";
}
export function hue(h: string) {
  let n = 0;
  for (const c of h) n = (n * 31 + c.charCodeAt(0)) % 360;
  return n;
}
export function Avatar({ handle, small }: { handle: string; small?: boolean }) {
  return (
    <span className={`co-av${small ? " s" : ""}`} style={{ background: `hsl(${hue(handle)} 80% 78%)` }} aria-hidden="true">
      {initials(handle)}
    </span>
  );
}

/** The spoken HOOK line of a generated script, if it has one. */
export function hookLine(script?: string | null): string {
  const m = (script ?? "").match(/^\s*HOOK\s*:\s*(.+)$/im);
  return m ? m[1]!.trim() : "";
}

/** The magazine page header: issue kicker with folio, cover headline, lede. */
export function Masthead({ folio, word1, word2, lede }: { folio: string; word1: string; word2: string; lede: string }) {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const issue = Math.ceil(((now.getTime() - start.getTime()) / 864e5 + start.getDay() + 1) / 7);
  const month = now.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  return (
    <header className="co-mast">
      <div className="co-rule" />
      <div className="co-kick">
        <span className="k1">Ideas · Issue {issue} · {month}</span>
        <span className="k2">p. {folio}</span>
      </div>
      <section className="co-hero">
        <div className="co-vlab"><b>Vol. {now.getFullYear() - 2023}</b> · No. {issue}</div>
        <h1 className="co-d">{word1} <span className="co-us">{word2}</span></h1>
        <p>{lede}</p>
      </section>
    </header>
  );
}

export interface CardIdea {
  title: string;
  creator?: string;
  funnelStage?: string | null;
  difficulty?: string | null;
  needs?: Array<{ type: string; label: string }> | null;
  hook?: string;
  why?: string | null;
  format?: string;
}

/** A generated idea: number, creator, pills, title, needs, hook, why, format tag and Save idea. */
export function IdeaCard({ no, idea, saved, onSave, picked, extra }: { no: number; idea: CardIdea; saved: boolean; onSave: () => void; picked?: boolean; extra?: ReactNode }) {
  return (
    <article className={`co-ic${picked ? " pick" : ""}`}>
      {picked && <span className="co-ptab"><Icon n="dice" s={12} />Picked for you</span>}
      <div className="co-ich">
        <span className="co-no">{String(no).padStart(2, "0")}</span>
        {idea.creator && <span className="co-src"><Avatar handle={idea.creator} small /><span>{idea.creator}</span></span>}
        <Pills stage={idea.funnelStage} level={idea.difficulty} />
      </div>
      <h3>{idea.title}</h3>
      <NeedChips needs={idea.needs} />
      {idea.hook && (
        <div className="co-hk"><span className="co-lab">Say this · Hook:</span><p>{idea.hook}</p></div>
      )}
      {idea.why && <p className="co-wy"><b>Why this works</b>{idea.why}</p>}
      {extra}
      <div className="co-icf">
        <FormatTag name={idea.format} />
        <button type="button" className="co-sb" disabled={saved} onClick={onSave}>
          <Icon n={saved ? "check" : "bookmark"} s={14} />{saved ? "Saved" : "Save idea"}
        </button>
      </div>
    </article>
  );
}

/** "10 ideas · 4 / 3 / 3 by stage" band, plus any extra columns. */
export function StatBand({ total, totalLabel, stages, extra }: { total: number; totalLabel: string; stages: Record<string, number>; extra?: ReactNode }) {
  return (
    <div className="co-stats">
      <div className="c"><b>{total}</b>{totalLabel}</div>
      {extra}
      {(["top", "middle", "bottom"] as const).map((s) => (
        <div key={s}><b>{stages[s] ?? 0}</b><span className="s"><FunnelPill stage={s} /></span></div>
      ))}
    </div>
  );
}

export function stageCounts(list: Array<{ funnelStage?: string | null }>): Record<string, number> {
  const out: Record<string, number> = { top: 0, middle: 0, bottom: 0 };
  for (const i of list) if (i.funnelStage && i.funnelStage in out) out[i.funnelStage]! += 1;
  return out;
}
