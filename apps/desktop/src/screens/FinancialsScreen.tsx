import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toasts";
import { ErrorState, Loading } from "../components/states";
import AnnualSection from "../components/finance/AnnualSection";
import BankSection from "../components/finance/BankSection";
import TaxCard from "../components/finance/TaxCard";
import RevenueSection from "../components/finance/RevenueSection";
import ExpenseSection from "../components/finance/ExpenseSection";
import NetCard from "../components/finance/NetCard";
import DonutCard from "../components/finance/DonutCard";
import GlanceCard from "../components/finance/GlanceCard";
import MonthBars from "../components/finance/MonthBars";
import FinHero from "../components/finance/FinHero";
import { api, fileUrl } from "../lib/api";
import { syncComplaint, waitForBankSync } from "../lib/bankSync";
import { openExternal } from "../lib/external";
import Select from "../components/Select";
import { ordinalDay, type FinancialsMonth } from "../lib/financials";
import { useAppState } from "../state/AppState";
import { useIsPhone } from "../lib/phone";

/** The phone's section chips (mobile pass). */
type FinTab = "overview" | "in" | "bills" | "oneoff" | "year" | "bank";

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
  const isPhone = useIsPhone();
  const [tab, setTab] = useState<FinTab>("overview");
  const [addMenu, setAddMenu] = useState(false);
  /** Bumped to open a section's add form from the phone's add sheet. */
  const [addSignal, setAddSignal] = useState(0);

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
  const exportTaxes = () => {
    void api
      .get<{ url: string }>(`/financials/export?year=${year}`)
      .then((r) => openExternal(fileUrl(r.url)!))
      .catch((err) => toast.fail("Could not build the tax export", err));
  };

  if (isPhone) {
    // Phone (mobile pass): a month switcher with arrows, the answer first
    // (net this month, money in and out, the bank), then chips for the
    // sections. Overview shows the top three of each list; the chips open
    // the full lists, so every editor, the donut, the tax card and the annual
    // export stay one tap away.
    const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const usd0 = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
    const step = (dir: -1 | 1) => {
      const d = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + dir, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (dir > 0 && key > recentMonths[0]!.value) return;
      setMonth(key);
    };
    const outCents = data ? data.totals.recurringOutCents + data.totals.oneOffOutCents : 0;
    const net = data ? data.totals.inCents - outCents : 0;
    const prev = data && data.series.length > 1 ? data.series[data.series.length - 2]! : null;
    const prevNet = prev ? prev.inCents - prev.outCents : null;
    const netChange = prevNet && prevNet !== 0 ? ((net - prevNet) / Math.abs(prevNet)) * 100 : null;
    const top3 = <T,>(rows: T[]) => rows.slice(0, 3);
    const TABS: Array<{ id: FinTab; label: string; count?: number }> = [
      { id: "overview", label: "Overview" },
      { id: "in", label: "Money in" },
      { id: "bills", label: "Bills", count: data?.recurring.length },
      { id: "oneoff", label: "One-off" },
      { id: "year", label: "Year and taxes" },
      { id: "bank", label: "Bank" },
    ];
    const goAdd = (t: FinTab) => {
      setAddMenu(false);
      setTab(t);
      setAddSignal((n) => n + 1);
    };
    return (
      <section className="screen active mb-page mb-fin" data-screen="financials" data-state={phase}>
        <div className="mb-monthsw">
          <button type="button" className="mb-ib" aria-label="Previous month" onClick={() => step(-1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-chev-l" />
            </svg>
          </button>
          <label className="mb-monthmid">
            {monthLabel(month)}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-chev" />
            </svg>
            <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="mb-ib" aria-label="Next month" disabled={month >= recentMonths[0]!.value} onClick={() => step(1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-chev-r" />
            </svg>
          </button>
          <button
            type="button"
            className="mb-ib"
            aria-label="Pull the bank again and refresh"
            disabled={refreshing || phase === "loading"}
            onClick={() => void refreshAll()}
            data-testid="financials.refresh"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className={refreshing ? "spin" : undefined}>
              <use href="#i-refresh" />
            </svg>
          </button>
        </div>

        {phase === "loading" && (
          <Loading screen="financials" label="Loading the month">
            <div className="mb-card mb-finhero">
              <span className="skel" style={{ display: "block", height: 120 }} />
            </div>
          </Loading>
        )}
        {phase === "error" && (
          <ErrorState screen="financials" message="Could not load this month. The numbers on this screen are unavailable, not zero." onRetry={() => void load()} />
        )}

        {phase === "ready" && data && (
          <>
            <section className="mb-finhero" aria-label="Net this month">
              <div className="mb-lab">Net this month</div>
              <div className={`mb-finbig${net < 0 ? " neg" : ""}`}>{net < 0 ? `-${usd(-net)}` : usd(net)}</div>
              {netChange != null && (
                <div className="mb-finvs">
                  <span className={`mb-delta ${netChange < 0 ? "down" : "up"}`}>
                    {netChange < 0 ? "▼" : "▲"} {Math.abs(netChange).toFixed(0)}%
                  </span>
                  <span>vs {prev ? monthLabel(prev.month).split(" ")[0] : "last month"}</span>
                </div>
              )}
              <div className="mb-trio">
                <div className="mb-stat">
                  <small>Money in</small>
                  <b className="ok">{usd0(data.totals.inCents)}</b>
                </div>
                <div className="mb-stat">
                  <small>Money out</small>
                  <b className="bad">{usd0(outCents)}</b>
                </div>
                <div className="mb-stat">
                  <small>In the bank</small>
                  <b className="info">{data.bank ? usd0(data.bank.totalCents) : "Not linked"}</b>
                </div>
              </div>
              {data.bank?.asOf && (
                <div className="mb-p muted small">
                  Bank is read-only via SimpleFIN, pulled {new Date(data.bank.asOf).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.
                </div>
              )}
            </section>

            <div className="mb-chips" role="tablist" aria-label="Sections">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`mb-chip${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
                  {t.label}
                  {t.count != null && <small>{t.count}</small>}
                </button>
              ))}
            </div>

            {tab === "overview" && (
              <>
                {data.totals.missingBills > 0 && (
                  <div className="mb-banner warn">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-receipt" />
                    </svg>
                    <span className="mb-bt">
                      <b>
                        {data.totals.missingBills} bill{data.totals.missingBills === 1 ? "" : "s"} not entered yet
                      </b>{" "}
                      {(() => {
                        const m = data.recurring.find((r) => r.amountCents === null);
                        return m?.dueDay
                          ? `${m.name} is usually paid by the ${ordinalDay(m.dueDay)}.`
                          : `The out and net figures are incomplete until ${data.totals.missingBills === 1 ? "it is" : "they are"} in.`;
                      })()}
                    </span>
                    <button type="button" className="mb-btn sm" onClick={() => setTab("bills")}>
                      Enter
                    </button>
                  </div>
                )}
                <section className="mb-card">
                  <div className="mb-cardh">
                    <h3>Money in</h3>
                    <small>
                      {data.revenue.length} {data.revenue.length === 1 ? "source" : "sources"}
                    </small>
                  </div>
                  {top3(data.revenue).map((r) => (
                    <div key={r.id} className="mb-mrow">
                      <i style={{ background: r.color ?? "var(--c-ok)" }} />
                      <span className="mb-grow">{r.clientName}</span>
                      <b>{usd(r.amountCents)}</b>
                    </div>
                  ))}
                  {data.revenue.length === 0 && <p className="mb-p muted small">Nothing in yet this month.</p>}
                  <div className="mb-cardfoot">
                    <button type="button" className="mb-btn sm ghost" onClick={() => setTab("in")}>
                      Open
                    </button>
                    <button type="button" className="mb-btn sm" onClick={() => goAdd("in")}>
                      Add income
                    </button>
                  </div>
                </section>
                <section className="mb-card">
                  <div className="mb-cardh">
                    <h3>Bills</h3>
                    <small>
                      {usd(data.totals.recurringOutCents)} a month · {data.recurring.length} {data.recurring.length === 1 ? "bill" : "bills"}
                    </small>
                  </div>
                  {top3([...data.recurring].sort((a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0))).map((r) => (
                    <div key={r.id} className="mb-mrow">
                      <i style={{ background: "var(--c-bad)" }} />
                      <span className="mb-grow">{r.name}</span>
                      <b>{r.amountCents == null ? "Not entered" : usd(r.amountCents)}</b>
                    </div>
                  ))}
                  <div className="mb-cardfoot">
                    <button type="button" className="mb-btn sm ghost" onClick={() => setTab("bills")}>
                      See all {data.recurring.length}
                    </button>
                    <button type="button" className="mb-btn sm" onClick={() => goAdd("bills")}>
                      Add bill
                    </button>
                  </div>
                </section>
                <section className="mb-card">
                  <div className="mb-cardh">
                    <h3>One-off out</h3>
                    <small>
                      {usd(data.totals.oneOffOutCents)} in {monthLabel(month).split(" ")[0]}
                    </small>
                  </div>
                  {top3([...data.oneOff].sort((a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0))).map((r) => (
                    <div key={r.id} className="mb-mrow">
                      <i style={{ background: "var(--c-warn)" }} />
                      <span className="mb-grow">{r.name}</span>
                      <b>{r.amountCents == null ? "Not entered" : usd(r.amountCents)}</b>
                    </div>
                  ))}
                  {data.oneOff.length === 0 && <p className="mb-p muted small">No one-off costs this month.</p>}
                  <div className="mb-cardfoot">
                    <button type="button" className="mb-btn sm ghost" onClick={() => setTab("oneoff")}>
                      Open
                    </button>
                    <button type="button" className="mb-btn sm" onClick={() => goAdd("oneoff")}>
                      Add expense
                    </button>
                  </div>
                </section>
                <section className="mb-card" aria-label="Last 12 months">
                  <div className="mb-cardh">
                    <h3>Last 12 months</h3>
                    <span className="mb-legend">
                      <span style={{ ["--c" as string]: "var(--c-ok)" }}>
                        <i />
                        In
                      </span>
                      <span style={{ ["--c" as string]: "var(--c-bad)" }}>
                        <i />
                        Out
                      </span>
                    </span>
                  </div>
                  <div className="mb-bars12">
                    {data.series.map((p) => {
                      const max = Math.max(1, ...data.series.flatMap((x) => [x.inCents, x.outCents]));
                      return (
                        <button
                          key={p.month}
                          type="button"
                          className={`mb-m12${p.month === month ? " on" : ""}`}
                          aria-label={`${monthLabel(p.month)}: ${usd0(p.inCents)} in, ${usd0(p.outCents)} out`}
                          onClick={() => setMonth(p.month)}
                        >
                          <i className="in" style={{ height: `${Math.max(3, (p.inCents / max) * 100)}%` }} />
                          <i className="out" style={{ height: `${Math.max(3, (p.outCents / max) * 100)}%` }} />
                        </button>
                      );
                    })}
                  </div>
                  <div className="mb-mlab">
                    {data.series
                      .filter((_, i) => i % 2 === 0 || i === data.series.length - 1)
                      .slice(-6)
                      .map((p) => (
                        <span key={p.month}>{monthLabel(p.month).slice(0, 3)}</span>
                      ))}
                  </div>
                </section>
                <section className="mb-card">
                  <div className="mb-cardh">
                    <h3>This year</h3>
                    <small>Taxes and the annual export</small>
                  </div>
                  <div className="mb-trio">
                    <div className="mb-stat">
                      <small>Money in</small>
                      <b>{usd0(data.ytd.inCents)}</b>
                    </div>
                    <div className="mb-stat">
                      <small>Net</small>
                      <b>{usd0(data.ytd.netCents)}</b>
                    </div>
                    <div className="mb-stat">
                      <small>Annual bills</small>
                      <b>{usd(data.totals.annualYearCents)}</b>
                    </div>
                  </div>
                  <div className="mb-cardfoot">
                    <button type="button" className="mb-btn sm ghost" onClick={() => setTab("year")}>
                      Taxes
                    </button>
                    <button type="button" className="mb-btn sm" onClick={exportTaxes} data-testid="financials.export">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <use href="#i-dl" />
                      </svg>
                      Export for taxes
                    </button>
                  </div>
                </section>
              </>
            )}
            {tab === "in" && (
              <RevenueSection rows={data.revenue} totalCents={data.totals.inCents} month={data.month} onChanged={() => void refresh()} addSignal={addSignal} />
            )}
            {tab === "bills" && (
              <>
                {data.totals.missingBills > 0 && (
                  <div className="warnline">
                    {data.totals.missingBills} bill{data.totals.missingBills === 1 ? "" : "s"} not entered, so the out and net figures are incomplete.
                  </div>
                )}
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
                  addSignal={addSignal}
                />
                <AnnualSection
                  rows={data.annual}
                  categories={data.categories}
                  shareCents={data.totals.annualShareCents}
                  yearCents={data.totals.annualYearCents}
                  onChanged={() => void refresh()}
                />
              </>
            )}
            {tab === "oneoff" && (
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
                addSignal={addSignal}
              />
            )}
            {tab === "year" && (
              <>
                <NetCard series={data.series} />
                <DonutCard rows={data.revenue} totalCents={data.totals.inCents} />
                <GlanceCard totals={data.totals} ytd={data.ytd} bank={data.bank} />
                <TaxCard year={year} />
                <section className="mb-card">
                  <div className="mb-cardh">
                    <h3>Export for taxes</h3>
                  </div>
                  <p className="mb-p muted small">
                    Every expense grouped by its Schedule C line, gross receipts by client, meals split at the deductible 50%, and your
                    business details on the cover.
                  </p>
                  <div className="mb-cardfoot">
                    <select className="mb-input" value={String(year)} onChange={(e) => setExportYear(Number(e.target.value))} aria-label="Export year">
                      {data.years.map((y) => (
                        <option key={y} value={String(y)}>
                          {y}
                        </option>
                      ))}
                    </select>
                    <button type="button" className="mb-btn sm" onClick={exportTaxes} data-testid="financials.export">
                      Export {year}
                    </button>
                  </div>
                </section>
              </>
            )}
            {tab === "bank" && <BankSection reloadKey={bankKey} onMoneyMoved={() => void refresh()} />}

            <div className="mb-actionbar">
              <button type="button" className="mb-btn pri" onClick={() => setAddMenu(true)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-plus" />
                </svg>
                Add money in or out
              </button>
            </div>
          </>
        )}

        {addMenu && (
          <>
            <div className="mb-scrim" onClick={() => setAddMenu(false)} aria-hidden="true" />
            <div className="mb-sheet" role="dialog" aria-modal="true" aria-label="Add money in or out">
              <div className="mb-grab" aria-hidden="true" />
              <div className="mb-sh">
                <h2>Add money in or out</h2>
                <button type="button" className="mb-ib" aria-label="Close" onClick={() => setAddMenu(false)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-x" />
                  </svg>
                </button>
              </div>
              <div className="mb-shb">
                {(
                  [
                    ["in", "Income", "Money that came in: a payment, a refund, a transfer", "#i-trend-up", "ok"],
                    ["bills", "Bill", "A recurring cost that rolls forward each month", "#i-receipt", "bad"],
                    ["oneoff", "One-off expense", "This month only, still counts toward taxes", "#i-dollar", "warn"],
                  ] as const
                ).map(([t, title, sub, icon, tone]) => (
                  <button key={t} type="button" className="mb-lrow" onClick={() => goAdd(t)}>
                    <span className={`mb-lic ${tone}`}>
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <use href={icon} />
                      </svg>
                    </span>
                    <span className="mb-lt">
                      <b>{title}</b>
                      <small>{sub}</small>
                    </span>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-chev-r" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </section>
    );
  }


  return (
    <section className="screen active" data-screen="financials" data-state={phase}>
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
          data-testid="financials.refresh"
        >
          <svg className={refreshing ? "spin" : undefined}>
            <use href="#i-refresh" />
          </svg>{" "}
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="stage">
        {phase === "loading" && (
          <Loading screen="financials" label="Loading the month">
            <div className="finskeleton">
              <div className="band">
                <div className="netcard glass finskel" />
                <div className="donutcard glass finskel" />
                <div className="actcard glass finskel" />
              </div>
              <div className="card glass chartcard finskel" style={{ height: 260 }} />
              <div className="finload">Loading the month…</div>
            </div>
          </Loading>
        )}

        {phase === "error" && (
          <ErrorState
            screen="financials"
            message="Could not load this month. The numbers on this screen are unavailable, not zero."
            onRetry={() => void load()}
          />
        )}

        {phase === "ready" && data && (
          <div className="fincards">
            <FinHero data={data} onPick={setMonth} />

            <h3 className="gx-section">Details</h3>
            <div className="band">
              <NetCard series={data.series} />
              <DonutCard rows={data.revenue} totalCents={data.totals.inCents} />
              <GlanceCard totals={data.totals} ytd={data.ytd} bank={data.bank} />
            </div>

            <MonthBars series={data.series} onPick={setMonth} />

            {data.totals.missingBills > 0 && (
              <div className="warnline" style={{ marginBottom: 10 }}>
                {data.totals.missingBills} bill{data.totals.missingBills === 1 ? "" : "s"} not
                entered, so the out and net figures are incomplete.
              </div>
            )}

            <div id="fin-bank" />
            <BankSection reloadKey={bankKey} onMoneyMoved={() => void refresh()} />
            <div id="fin-tax" />
            <TaxCard year={year} />

            <div id="fin-revenue" />
            <RevenueSection
              rows={data.revenue}
              totalCents={data.totals.inCents}
              month={data.month}
              onChanged={() => void refresh()}
            />

            <div id="fin-oneoff" />
            <div className="cols2" id="fin-recurring">
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

            <div className="card glass exportcard" id="fin-export">
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
                data-testid="financials.export"
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
