import { useEffect, useState } from "react";
import { planShoots, type PlanIdea, type PlanSession } from "@toreroflow/core";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";

interface Row extends PlanIdea { hook?: string | null }

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

  return (
    <div className="shootplan">
      <div className="shoothead">
        <div>
          <b>Shoot plan</b>
          <div className="sub">Unshot ideas grouped by where you film and who you need. Effort: easy 1, medium 2, hard 4.</div>
        </div>
        <button className="cbtn" onClick={() => setTries((n) => n + 1)}>Plan my week</button>
      </div>
      {plan === null && <div className="sub">Planning...</div>}
      {plan && plan.length === 0 && <div className="sub">Nothing left to shoot. Save some ideas first.</div>}
      <div className="shootgrid">
        {plan?.map((s) => (
          <div className="card shootcard" key={s.day}>
            <div className="shootcardhead">
              <b>{s.day}</b>
              <span className="difftag">Effort {s.effort}</span>
            </div>
            <div className="shootmeta"><span className="needslab">Where:</span> {s.where.length ? s.where.join(", ") : "Anywhere"}</div>
            {s.people.length > 0 && <div className="shootmeta"><span className="needslab">Who:</span> {s.people.join(", ")}</div>}
            {s.bring.length > 0 && <div className="shootmeta"><span className="needslab">Bring:</span> {s.bring.join(", ")}</div>}
            <ol className="shootlist">
              {s.ideas.map((i) => (
                <li key={i.id}>
                  <span>{i.text}</span>
                  {i.difficulty && <span className="difftag">{i.difficulty[0]!.toUpperCase() + i.difficulty.slice(1)}</span>}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
