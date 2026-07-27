import { useCallback, useEffect, useState } from "react";
import { useToast } from "../components/Toasts";
import { formatCents } from "@toreroflow/core";
import { api } from "../lib/api";
import type { FinancialsMonth } from "../lib/financials";

/** Months to offer, newest first, starting from the current one. */
function monthOptions(count = 12): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    });
  }
  return out;
}

export default function FinancialsScreen() {
  const toast = useToast();
  const months = monthOptions();
  const [month, setMonth] = useState(months[0]!.value);
  const [data, setData] = useState<FinancialsMonth | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<FinancialsMonth>(`/financials?month=${month}`));
    } catch (err) {
      toast.fail("Could not load the month", err);
    }
  }, [month, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const t = data?.totals;
  const outCents = (t?.recurringOutCents ?? 0) + (t?.oneOffOutCents ?? 0);
  const netCents = (t?.inCents ?? 0) - outCents;

  return (
    <section className="screen active" data-screen="financials">
      <div className="topbar">
        <div className="h">
          <h2>Financials</h2>
          <p>What came in, what went out, and what is left.</p>
        </div>
        <select
          className="field-in repmonth"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        >
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="stage">
        <div className="fintiles">
          <div className="fintile glass in">
            <div className="lbl">Money in</div>
            <div className="num">{formatCents(t?.inCents ?? 0)}</div>
          </div>
          <div className="fintile glass out">
            <div className="lbl">Money out</div>
            <div className="num">{formatCents(outCents)}</div>
            {t && t.missingBills > 0 && (
              <div className="warnline">
                {t.missingBills} bill{t.missingBills === 1 ? "" : "s"} not entered, so this is
                incomplete
              </div>
            )}
          </div>
          <div className="fintile glass net">
            <div className="lbl">Net</div>
            <div className="num">{formatCents(netCents)}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
