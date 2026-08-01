import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toasts";
import AnnualSection from "../components/finance/AnnualSection";
import BankSection from "../components/finance/BankSection";
import TaxCard from "../components/finance/TaxCard";
import RevenueSection from "../components/finance/RevenueSection";
import ExpenseSection from "../components/finance/ExpenseSection";
import NetCard from "../components/finance/NetCard";
import DonutCard from "../components/finance/DonutCard";
import GlanceCard from "../components/finance/GlanceCard";
import MonthBars from "../components/finance/MonthBars";
import { api, fileUrl } from "../lib/api";
import { syncComplaint, waitForBankSync } from "../lib/bankSync";
import { openExternal } from "../lib/external";
import Select from "../components/Select";
import type { FinancialsMonth } from "../lib/financials";
import { useAppState } from "../state/AppState";

/** "2026-03" as "March 2026". */
function monthLabel(key: string): string {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleDateString(
    "en-US",
    { month: "long", year: "numeric" },
  );
}

/** Months to offer, newest first, starting from the current one. */
function monthOptions(count = 12): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({ value, label: monthLabel(value) });
  }
  return out;
}

type Phase = "loading" | "ready" | "error";

export default function FinancialsScreen() {
  const toast = useToast();
  const { clients: knownClients } = useAppState();
  const recentMonths = monthOptions();
  const [month, setMonth] = useState(recentMonths[0]!.value);
  // Clicking the oldest bar reaches eleven months before whatever is on
  // screen, which walks off the end of the twelve the picker offers. Keeping
  // the open month in the list stops the picker reading blank on a month the
  // screen is plainly showing.
  const months = recentMonths.some((m) => m.value === month)
    ? recentMonths
    : [...recentMonths, { value: month, label: monthLabel(month) }].sort((a, b) =>
        b.value.localeCompare(a.value),
      );
  const [data, setData] = useState<FinancialsMonth | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [exportYear, setExportYear] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Bumped to make the bank card re-read once a pull has landed. */
  const [bankKey, setBankKey] = useState(0);
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

  /**
   * Everything on this screen, brought up to date.
   *
   * The month figures come out of our own database and are current the moment
   * they are read. The bank is the part that is not: it has to be pulled from
   * SimpleFIN first, which takes as long as it takes. So this queues the pull,
   * waits for it to actually finish, and only then re-reads. Waiting is the
   * point: a button that returns before the money has moved is the same button
   * that looked like it did nothing.
   */
  const refreshAll = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    let complaint: string | null = null;
    try {
      const { queued } = await api.post<{ queued: number }>("/bank/sync", {});
      if (queued > 0) complaint = syncComplaint(await waitForBankSync());
    } catch (err) {
      // The month still refreshes below: a bank that would not pull is no
      // reason to leave the rest of the screen stale.
      toast.fail("The bank did not finish pulling", err);
    }
    await refresh();
    setBankKey((k) => k + 1);
    setRefreshing(false);
    if (complaint) toast.fail("The bank pull finished with a problem", complaint);
  }, [refresh, refreshing, toast]);

  // The RevenueSection's unpriced list already tracks the client context;
  // this keeps the totals, donut, and charts in step with it when a client
  // is added or priced mid-session. Skipped before first load so the mount
  // does not double-fetch.
  useEffect(() => {
    if (data) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownClients]);

  const year = exportYear ?? data?.years[0] ?? new Date().getFullYear();

  return (
    <section className="screen active" data-screen="financials">
      <div className="topbar">
        <div className="h">
          <h2>Financials</h2>
          <p>What came in, what went out, and what is left.</p>
        </div>
        <Select
          className="repmonth"
          value={month}
          onChange={setMonth}
          aria-label="Month"
          options={months.map((m) => ({ value: m.value, label: m.label }))}
        />
        <button
          className="btn ghost"
          style={{ marginLeft: "auto" }}
          disabled={refreshing || phase === "loading"}
          title="Pull the bank again and re-read every figure on this screen"
          onClick={() => void refreshAll()}
        >
          <svg className={refreshing ? "spin" : undefined}>
            <use href="#i-refresh" />
          </svg>{" "}
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
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
          <div className="fincards">
            <div className="band">
              <NetCard series={data.series} />
              <DonutCard rows={data.revenue} totalCents={data.totals.inCents} />
              <GlanceCard totals={data.totals} ytd={data.ytd} />
            </div>

            <MonthBars series={data.series} onPick={setMonth} />

            {data.totals.missingBills > 0 && (
              <div className="warnline" style={{ marginBottom: 10 }}>
                {data.totals.missingBills} bill{data.totals.missingBills === 1 ? "" : "s"} not
                entered, so the out and net figures are incomplete.
              </div>
            )}

            <BankSection reloadKey={bankKey} />
            <TaxCard year={year} />

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

            <AnnualSection
              rows={data.annual}
              categories={data.categories}
              shareCents={data.totals.annualShareCents}
              yearCents={data.totals.annualYearCents}
              onChanged={() => void refresh()}
            />

            <div className="card glass exportcard">
              <div style={{ flex: 1 }}>
                <b style={{ fontSize: 14.5 }}>Export for taxes</b>
                <div className="sub">
                  Every expense grouped by its Schedule C line, gross receipts by client, meals
                  split at the deductible 50%, and your business details on the cover.
                </div>
              </div>
              <Select
                className="repmonth"
                value={String(year)}
                onChange={(v) => setExportYear(Number(v))}
                aria-label="Export year"
                options={data.years.map((y) => ({ value: String(y), label: String(y) }))}
              />
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
          </div>
        )}
      </div>
    </section>
  );
}
