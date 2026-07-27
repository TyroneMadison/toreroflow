import { useCallback, useEffect, useState } from "react";
import { useToast } from "../components/Toasts";
import RevenueSection from "../components/finance/RevenueSection";
import { formatCents } from "@toreroflow/core";
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

        {data && (
          <RevenueSection
            rows={data.revenue}
            totalCents={data.totals.inCents}
            month={data.month}
            onChanged={() => void load()}
          />
        )}

        <div className="card glass" style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 14.5 }}>Export for taxes</b>
            <div className="sub">
              Every expense grouped by its Schedule C line, gross receipts by client, meals split
              at the deductible 50%, and your business details on the cover.
            </div>
          </div>
          <button
            className="btn"
            onClick={() => {
              void api
                .get<{ url: string }>(`/financials/export?year=${new Date().getFullYear()}`)
                .then((r) => openExternal(fileUrl(r.url)!))
                .catch((err) => toast.fail("Could not build the tax export", err));
            }}
          >
            Export {new Date().getFullYear()}
          </button>
        </div>
      </div>
    </section>
  );
}
