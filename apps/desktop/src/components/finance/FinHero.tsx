import { formatCents } from "@toreroflow/core";
import Spark from "../glass/Spark";
import Story from "../glass/Story";
import Stat from "../glass/Stat";
import { colorFor, type FinancialsMonth } from "../../lib/financials";

/*
 * Financials v3: the month strip, four tall story cards (money in, recurring
 * out, one-off out, the year) and the "this month" column. Every figure comes
 * from the same /financials payload the detail sections below use; the Open
 * buttons scroll to those sections, where the editing happens.
 */
function short(key: string) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString("en-US", { month: "short" });
}
function whole(cents: number) {
  return formatCents(cents).replace(/\.00$/, "");
}
function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export default function FinHero({
  data,
  onPick,
}: {
  data: FinancialsMonth;
  onPick(month: string): void;
}) {
  const { totals, series, ytd, bank } = data;
  const ins = series.map((p) => p.inCents);
  const outs = series.map((p) => p.outCents);
  const nets = series.map((p) => p.inCents - p.outCents);
  const net = totals.inCents - totals.recurringOutCents - totals.oneOffOutCents;
  const prev = series.length > 1 ? series[series.length - 2]! : null;
  const prevNet = prev ? prev.inCents - prev.outCents : null;
  const delta = prevNet ? ((net - prevNet) / Math.abs(prevNet)) * 100 : null;
  const label = short(data.month);
  const btn = (text: string, onClick: () => void, pri = false, testId?: string) => (
    <button type="button" className={`tf-btn${pri ? " pri" : ""}`} onClick={onClick} data-testid={testId}>
      {text}
    </button>
  );

  return (
    <div className="gx-fin" data-testid="financials.hero">
      <nav className="gx-months glass-z1" aria-label="Months">
        {series.map((p) => (
          <button
            type="button"
            key={p.month}
            className={p.month === data.month ? "on" : undefined}
            aria-pressed={p.month === data.month}
            onClick={() => onPick(p.month)}
            data-testid={`financials.month-${p.month}`}
          >
            {short(p.month)}
            {(p.inCents > 0 || p.outCents > 0) && <i aria-hidden="true" />}
          </button>
        ))}
      </nav>

      <div className="gx-cols gx-cols-fin">
        <Story
          testId="financials.card-in"
          tone="#4ADE9A"
          icon={<span className="gx-sq" style={{ background: "#4ADE9A" }} />}
          title="Money in"
          sub={`${data.revenue.length} source${data.revenue.length === 1 ? "" : "s"} this month`}
          rows={data.revenue.slice(0, 3).map((r, i) => ({
            key: r.id,
            dot: colorFor(r.color, i),
            label: r.clientName,
            value: formatCents(r.amountCents),
          }))}
          bigLabel={`${label} in`}
          big={whole(totals.inCents)}
          bigTone="ok"
          spark={<Spark values={ins} tone="#c8ffe4" />}
          actions={<>{btn("+ Add income", () => scrollTo("fin-revenue"))}{btn("Open", () => scrollTo("fin-revenue"), true)}</>}
        />
        <Story
          testId="financials.card-recurring"
          tone="#F0506E"
          icon={<span className="gx-sq" style={{ background: "#F0506E" }} />}
          title="Recurring out"
          sub="Counted every month"
          badge={`${data.recurring.length} bills`}
          rows={data.recurring.slice(0, 3).map((r, i) => ({
            key: r.id,
            dot: colorFor(r.color, i),
            label: r.name,
            value: r.amountCents == null ? "missing" : formatCents(r.amountCents),
          }))}
          bigLabel="Per month"
          big={whole(totals.recurringOutCents)}
          bigTone="bad"
          spark={<Spark values={outs} tone="#ffd0d8" />}
          actions={<>{btn("+ Add bill", () => scrollTo("fin-recurring"))}{btn("Open", () => scrollTo("fin-recurring"), true)}</>}
        />
        <Story
          testId="financials.card-oneoff"
          tone="#E0A458"
          icon={<span className="gx-sq" style={{ background: "#E0A458" }} />}
          title="One-off out"
          sub="Schedule C categories"
          badge={new Date(Number(data.month.slice(0, 4)), Number(data.month.slice(5)) - 1, 1).toLocaleDateString("en-US", { month: "long" })}
          rows={data.oneOff.slice(0, 3).map((r, i) => ({
            key: r.id,
            dot: colorFor(r.color, i),
            label: r.name,
            value: r.amountCents == null ? "missing" : formatCents(r.amountCents),
          }))}
          bigLabel="This month"
          big={formatCents(totals.oneOffOutCents)}
          spark={<Spark values={outs} tone="#ffe9c8" />}
          actions={<>{btn("+ Add expense", () => scrollTo("fin-oneoff"))}{btn("Open", () => scrollTo("fin-oneoff"), true)}</>}
        />
        <Story
          testId="financials.card-year"
          tone="#B57BFF"
          icon={<span className="gx-sq" style={{ background: "#B57BFF" }} />}
          title="This year"
          sub="Taxes and the annual export"
          rows={[
            { key: "in", dot: "#4ADE9A", label: "Money in", value: whole(ytd.inCents) },
            { key: "net", dot: "#4C9DFF", label: "Net", value: whole(ytd.netCents) },
            { key: "annual", dot: "#B57BFF", label: "Annual bills", value: whole(totals.annualYearCents) },
          ]}
          bigLabel="Year net"
          big={whole(ytd.netCents)}
          bigTone={ytd.netCents < 0 ? "bad" : undefined}
          spark={<Spark values={nets} />}
          actions={<>{btn("Taxes", () => scrollTo("fin-tax"))}{btn("Export for taxes", () => scrollTo("fin-export"), true, "financials.hero-export")}</>}
        />
        <aside className="gx-side glass-z1" data-testid="financials.this-month">
          <div className="tf-lbl">This month</div>
          <Stat
            label="Net this month"
            value={formatCents(net)}
            tone={net < 0 ? "bad" : "ok"}
            sub={delta == null ? undefined : `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(0)}% vs ${prev ? short(prev.month) : ""}`}
          />
          {bank && (
            <Stat
              label="In the bank"
              value={formatCents(bank.totalCents)}
              tone="info"
              sub={bank.asOf ? `Read-only · pulled ${new Date(bank.asOf).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Read-only"}
            />
          )}
          <Stat label="This year net" value={formatCents(ytd.netCents)} sub={`${whole(ytd.inCents)} in this year`} />
          <div className="gx-side-actions">
            {btn("Bank", () => scrollTo("fin-bank"))}
          </div>
          {totals.missingBills > 0 && (
            <div className="gx-note warn">
              {totals.missingBills} bill{totals.missingBills === 1 ? "" : "s"} not entered
            </div>
          )}
          <div className="gx-note">Bank is read-only via SimpleFIN.</div>
        </aside>
      </div>
    </div>
  );
}
