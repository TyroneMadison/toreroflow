import { useEffect, useState } from "react";
import { WEEK, effortOf, planShoots, type PlanIdea, type PlanSession } from "@toreroflow/core";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { Icon, Pills } from "./coralBits";

interface Row extends PlanIdea { hook?: string | null; creator?: string | null; formatName?: string | null; funnelStage?: string | null }

/** Rough filming time per idea, by difficulty (easy 15, medium 30, hard 40 min). */
const MINUTES: Record<number, number> = { 1: 15, 2: 30, 4: 40 };
function duration(ideas: PlanIdea[]) {
  const m = Math.max(15, Math.round(ideas.reduce((t, i) => t + (MINUTES[effortOf(i)] ?? 30), 0) / 15) * 15);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `about ${h ? `${h} hr${r ? ` ${r} min` : ""}` : `${r} min`}`;
}

/** "a car lot, two people" as "Car lot, two people": no articles, first letter up. */
const list = (xs: string[]) => xs.map((x) => x.replace(/^(a|an|the)\s+/i, "")).join(", ").replace(/^./, (c) => c.toUpperCase());

/** The next Monday on or after today, so the strip shows real dates. */
function weekStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7));
  return d;
}

/** Unshot saved ideas grouped into filming sessions across the week (computed on the fly). */
export default function ShootPlan({ clientId, reloadKey }: { clientId: string; reloadKey: number }) {
  const toast = useToast();
  const [plan, setPlan] = useState<PlanSession[] | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    api.get<Row[]>(`/clients/${clientId}/ideas`)
      .then((got) => { if (live) setPlan(planShoots(got.map((r) => ({ ...r, text: r.hook || r.text })))); })
      .catch((err) => { if (live) toast.fail("Could not load the shoot plan", err); });
    return () => { live = false; };
  }, [clientId, reloadKey, tries, toast]);

  const start = weekStart();
  const dates = WEEK.map((_, k) => new Date(start.getTime() + k * 864e5));
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const thisWeek = (plan ?? []).slice(0, 7);
  const ideaCount = (plan ?? []).reduce((t, s) => t + s.ideas.length, 0);
  const restIdx = thisWeek.length < 7 ? 6 : -1;
  const open = WEEK.map((d, k) => (k >= thisWeek.length && k !== restIdx ? d.slice(0, 3) : "")).filter(Boolean);

  return (
    <div className="co-shoot">
      <div className="co-plan">
        <button type="button" className="co-btn" onClick={() => setTries((n) => n + 1)}><Icon n="spark" />Plan my week</button>
        {plan && plan.length > 0 && (
          <span className="co-sm"><b>{plan.length}</b>session{plan.length === 1 ? "" : "s"} · {ideaCount} idea{ideaCount === 1 ? "" : "s"} · {fmt(dates[0]!)} to {fmt(dates[6]!)}</span>
        )}
      </div>
      {plan === null && <p className="co-muted">Planning...</p>}
      {plan && plan.length === 0 && (
        <div className="co-empty"><h3 className="co-d">Nothing left to shoot.</h3><p>Save some ideas first, or untick one that still needs filming.</p></div>
      )}
      {plan && plan.length > 0 && (
        <>
          <div className="co-lab">This week</div>
          <div className="co-week">
            {WEEK.map((d, k) => {
              const s = thisWeek[k];
              return (
                <div key={d} className={`co-day${s ? " has" : k === restIdx ? " off" : ""}`}>
                  {d.slice(0, 3)}<b>{dates[k]!.getDate()}</b>
                  <small>{s ? `${s.ideas.length} idea${s.ideas.length === 1 ? "" : "s"}` : k === restIdx ? "Rest" : "Open"}</small>
                </div>
              );
            })}
          </div>
          {plan.map((s, n) => {
            const level = Math.max(1, Math.min(5, Math.ceil((s.effort * 5) / 6)));
            const where = list([...s.where, ...s.people]) || "Anywhere";
            return (
              <section className="co-sess" key={s.day}>
                <div className="co-sl">
                  <b>{n < 7 ? dates[n]!.getDate() : n + 1}</b>
                  <div><span>{s.day.replace(/^(\w{3})\w*/, "$1")}</span><em>Session {n + 1} of {plan.length}</em></div>
                </div>
                <div className="co-sr">
                  <div className="co-sh">
                    <h3 className="co-d">{s.where[0] ? `At the ${s.where[0].replace(/^(a|an)\s+/i, "").toLowerCase()}` : `Session ${n + 1}`}</h3>
                    <div className="co-eff">
                      <div className="co-meter" aria-hidden="true">{[0, 1, 2, 3, 4].map((k) => <i key={k} className={k < level ? "on" : ""} />)}</div>
                      <span>Effort {level} of 5 · {duration(s.ideas)}</span>
                    </div>
                  </div>
                  <p className="co-bw">
                    <span><b>Where:</b>{where}</span>
                    <i>/</i>
                    <span><b>Bring:</b>{list(s.bring) || "Phone"}</span>
                  </p>
                  {(s.ideas as Row[]).map((i, k) => (
                    <div className="co-irow" key={i.id}>
                      <span className="n">{k + 1}</span>
                      <div className="tt">{i.text}<small>{[i.creator, i.formatName].filter(Boolean).join(" · ")}</small></div>
                      <Pills stage={i.funnelStage} level={i.difficulty} />
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          {restIdx >= 0 && (
            <section className="co-rest">
              <div className="co-sl"><b>{dates[restIdx]!.getDate()}</b><div><span>Sun · Rest day</span>{open.length > 0 && <em>{open.join(", ")} open</em>}</div></div>
              <div className="co-sr"><h3 className="co-d">Nothing to shoot.</h3><p>Sunday is a rest day.{open.length > 0 ? ` ${open.join(", ")} stay open for edits and posting.` : ""}</p></div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
