import { useCallback, useEffect, useState } from "react";
import { formatCents, FILING_STATUS_LABELS, STATE_TAX, type FilingStatus } from "@toreroflow/core";
import { useToast } from "../Toasts";
import { api, type AgencyBusiness, type TaxEstimateView } from "../../lib/api";

/**
 * What to set aside for tax.
 *
 * Built from the same receipts and deductions as the year-end export, so the
 * two can never disagree. It is an estimate for a single member LLC that has
 * not elected corporate treatment, and it says so rather than implying a
 * precision it does not have.
 *
 * The state rate is editable on purpose. A built-in table of state rates goes
 * stale every January, and an operator who can see a wrong number should never
 * be stuck with it.
 */

const STATES = Object.keys(STATE_TAX).sort();

export default function TaxCard({ year }: { year: number }) {
  const toast = useToast();
  const [estimate, setEstimate] = useState<TaxEstimateView | null>(null);
  const [agency, setAgency] = useState<AgencyBusiness | null>(null);
  const [otherIncome, setOtherIncome] = useState("");
  const [rateDraft, setRateDraft] = useState("");
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, a] = await Promise.all([
        api.get<TaxEstimateView>(`/financials/tax-estimate?year=${year}`),
        api.get<AgencyBusiness>("/agency"),
      ]);
      setEstimate(e);
      setAgency(a);
      setOtherIncome(a.otherIncomeCents == null ? "" : (a.otherIncomeCents / 100).toFixed(2));
      setRateDraft(a.stateTaxRatePct == null ? "" : String(a.stateTaxRatePct));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.patch<AgencyBusiness>("/agency", patch);
      await load();
    } catch (err) {
      toast.fail("Could not save that", err);
      await load();
    }
  };

  if (failed) {
    return (
      <div className="card glass" style={{ marginTop: 16 }}>
        <h3>Set aside for taxes</h3>
        <p className="insfailed">Could not work out the tax estimate just now.</p>
      </div>
    );
  }
  if (!estimate || !agency) return null;

  const table = STATE_TAX[estimate.state];

  return (
    <div className="card glass" style={{ marginTop: 16 }}>
      <div className="rowhead">
        <div>
          <h3>Set aside for taxes</h3>
          <div className="sub">
            An estimate on {formatCents(estimate.netProfitCents)} of profit so far in{" "}
            {estimate.year}, for an LLC taxed as a sole proprietor. Not tax advice: check it
            with your accountant before you file.
          </div>
        </div>
      </div>

      <div className="kpis stagger" style={{ gridTemplateColumns: "repeat(3,1fr)", marginTop: 14 }}>
        <div className="kpi glass-sm">
          <div className="lab">Set aside</div>
          <div className="val">{formatCents(estimate.totalCents)}</div>
        </div>
        <div className="kpi glass-sm">
          <div className="lab">That is</div>
          <div className="val">{estimate.effectiveRatePct}%</div>
        </div>
        <div className="kpi glass-sm">
          <div className="lab">Each quarter</div>
          <div className="val">{formatCents(estimate.quarterlyCents)}</div>
        </div>
      </div>

      <div className="best" style={{ marginTop: 12 }}>
        <div className="l">Self employment tax</div>
        <b>{formatCents(estimate.selfEmploymentCents)}</b>
      </div>
      <div className="best">
        <div className="l">Federal income tax on this profit</div>
        <b>{formatCents(estimate.federalIncomeCents)}</b>
      </div>
      <div className="best">
        <div className="l">
          State income tax
          {estimate.stateChosen && !estimate.stateRateExact && (
            <span style={{ color: "var(--txt-3)" }}>
              {" "}
              · at {estimate.state}'s top rate, which sets aside a little too much rather than
              too little
            </span>
          )}
          {table?.note && (
            <span style={{ color: "var(--txt-3)" }}> · {table.note}</span>
          )}
        </div>
        <b>{formatCents(estimate.stateIncomeCents)}</b>
      </div>

      {!estimate.stateChosen && (
        <p className="insworking" style={{ marginTop: 10 }}>
          No state picked yet, so only the federal half is counted. Choose one below.
        </p>
      )}

      <div className="pcontact" style={{ marginTop: 14, maxWidth: 560 }}>
        <label className="cfield">
          <span className="lab">State</span>
          <select
            className="field-in"
            value={agency.taxState ?? ""}
            onChange={(e) => void save({ taxState: e.target.value })}
          >
            <option value="">Pick a state</option>
            {STATES.map((code) => (
              <option key={code} value={code}>
                {code} · {STATE_TAX[code]!.rate}%
              </option>
            ))}
          </select>
        </label>

        <label className="cfield">
          <span className="lab">Filing status</span>
          <select
            className="field-in"
            value={agency.filingStatus ?? "single"}
            onChange={(e) => void save({ filingStatus: e.target.value })}
          >
            {(Object.keys(FILING_STATUS_LABELS) as FilingStatus[]).map((k) => (
              <option key={k} value={k}>
                {FILING_STATUS_LABELS[k]}
              </option>
            ))}
          </select>
        </label>

        <label className="cfield">
          <span className="lab">Other income this year</span>
          <input
            className="field-in"
            inputMode="decimal"
            placeholder="0.00"
            value={otherIncome}
            onChange={(e) => setOtherIncome(e.target.value)}
            onBlur={() => {
              const raw = otherIncome.trim();
              const parsed = raw === "" ? null : Number.parseFloat(raw);
              if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
                toast.fail("Could not save that", new Error("enter an amount, or leave it empty"));
                setOtherIncome(
                  agency.otherIncomeCents == null ? "" : (agency.otherIncomeCents / 100).toFixed(2),
                );
                return;
              }
              void save({ otherIncomeCents: parsed === null ? null : Math.round(parsed * 100) });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <span className="sub" style={{ fontSize: 11 }}>
            A job, a spouse's salary, anything taxed the same way. It decides which bracket this
            profit lands in, and only the tax the business itself causes is counted above.
          </span>
        </label>

        <label className="cfield">
          <span className="lab">State rate, if the built-in one is wrong</span>
          <input
            className="field-in"
            inputMode="decimal"
            placeholder={table ? `${table.rate}` : "0"}
            value={rateDraft}
            onChange={(e) => setRateDraft(e.target.value)}
            onBlur={() => {
              const raw = rateDraft.trim();
              const parsed = raw === "" ? null : Number.parseFloat(raw);
              if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 30)) {
                toast.fail("Could not save that", new Error("enter a rate between 0 and 30"));
                setRateDraft(agency.stateTaxRatePct == null ? "" : String(agency.stateTaxRatePct));
                return;
              }
              void save({ stateTaxRatePct: parsed });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <span className="sub" style={{ fontSize: 11 }}>
            Built-in rates are the ones published for {estimate.ratesYear}. Leave empty to use
            them.
          </span>
        </label>
      </div>
    </div>
  );
}
