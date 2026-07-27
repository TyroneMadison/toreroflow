import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toasts";
import RevenueSection from "../components/finance/RevenueSection";
import ExpenseSection from "../components/finance/ExpenseSection";
import NetCard from "../components/finance/NetCard";
import DonutCard from "../components/finance/DonutCard";
import GlanceCard from "../components/finance/GlanceCard";
import MonthBars from "../components/finance/MonthBars";
import { api, fileUrl } from "../lib/api";
import { openExternal } from "../lib/external";
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

type Phase = "loading" | "ready" | "error";

export default function FinancialsScreen() {
  const toast = useToast();
  const months = monthOptions();
  const [month, setMonth] = useState(months[0]!.value);
  const [data, setData] = useState<FinancialsMonth | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [exportYear, setExportYear] = useState<number | null>(null);
  // Guards the race where a slow response for one month lands after a faster
  // response for another and silently overwrites it.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setPhase("loading");
    try {
      const d = await api.get<FinancialsMonth>(`/financials?month=${month}`);
      if (seq.current !== mine) return;
      setData(d);
      setPhase("ready");
    } catch (err) {
      if (seq.current !== mine) return;
      setPhase("error");
      toast.fail("Could not load the month", err);
    }
  }, [month, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh without the skeleton: after an edit the screen already shows
  // real rows, and flashing them out for a beat would make every save feel
  // like a reload. Errors keep the current data and just say so.
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await api.get<FinancialsMonth>(`/financials?month=${month}`);
      if (seq.current !== mine) return;
      setData(d);
      setPhase("ready");
    } catch (err) {
      if (seq.current !== mine) return;
      toast.fail("Could not refresh the month", err);
    }
  }, [month, toast]);

  const year = exportYear ?? data?.years[0] ?? new Date().getFullYear();

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
        {phase === "loading" && (
          <div className="finskeleton">
            <div className="band">
              <div className="netcard glass finskel" />
              <div className="donutcard glass finskel" />
              <div className="actcard glass finskel" />
            </div>
            <div className="card glass chartcard finskel" style={{ height: 260 }} />
            <div className="finload">Loading the month…</div>
          </div>
        )}

        {phase === "error" && (
          <div className="card glass finerror">
            <b>Could not load this month.</b>
            <span>The numbers on this screen are unavailable, not zero.</span>
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}

        {phase === "ready" && data && (
          <>
            <div className="band">
              <NetCard series={data.series} />
              <DonutCard rows={data.revenue} totalCents={data.totals.inCents} />
              <GlanceCard totals={data.totals} ytd={data.ytd} />
            </div>

            <MonthBars series={data.series} />

            {data.totals.missingBills > 0 && (
              <div className="warnline" style={{ marginBottom: 10 }}>
                {data.totals.missingBills} bill{data.totals.missingBills === 1 ? "" : "s"} not
                entered, so the out and net figures are incomplete.
              </div>
            )}

            <RevenueSection
              rows={data.revenue}
              totalCents={data.totals.inCents}
              month={data.month}
              onChanged={() => void refresh()}
            />

            <div className="cols2">
              <ExpenseSection
                title="Money coming out"
                sub="Recurring only. Rolls forward each month."
                kind="recurring"
                rows={data.recurring}
                categories={data.categories}
                month={data.month}
                totalCents={data.totals.recurringOutCents}
                missingCount={data.recurring.filter((r) => r.amountCents === null).length}
                onChanged={() => void refresh()}
              />
              <ExpenseSection
                title="One-off expenses"
                sub="This month only. Does not roll forward, still counts toward taxes."
                kind="one_off"
                rows={data.oneOff}
                categories={data.categories}
                month={data.month}
                totalCents={data.totals.oneOffOutCents}
                missingCount={data.oneOff.filter((r) => r.amountCents === null).length}
                onChanged={() => void refresh()}
              />
            </div>

            <div className="card glass" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ flex: 1 }}>
                <b style={{ fontSize: 14.5 }}>Export for taxes</b>
                <div className="sub">
                  Every expense grouped by its Schedule C line, gross receipts by client, meals
                  split at the deductible 50%, and your business details on the cover.
                </div>
              </div>
              <select
                className="field-in repmonth"
                value={year}
                onChange={(e) => setExportYear(Number(e.target.value))}
              >
                {data.years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <button
                className="btn"
                onClick={() => {
                  void api
                    .get<{ url: string }>(`/financials/export?year=${year}`)
                    .then((r) => openExternal(fileUrl(r.url)!))
                    .catch((err) => toast.fail("Could not build the tax export", err));
                }}
              >
                Export {year}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
