import { useCallback, useEffect, useState } from "react";
import Select from "./Select";
import { useToast } from "./Toasts";
import { api, type AgencyBusiness } from "../lib/api";
import { useIsPhone } from "../lib/phone";
import { Ic } from "./analytics/phoneBits";

/**
 * The registered company behind the brand.
 *
 * "Torerone" is what a client sees on a report. "Torerone LLC" is what belongs
 * on an invoice their accountant keeps and on the year-end export a CPA works
 * from. Both documents have read these fields since the Financials module
 * shipped and nothing ever wrote them, so invoices carried the workspace name
 * and the export printed "EIN not recorded".
 *
 * Saved field by field on blur, like the client contact details, so a half
 * finished form never writes a whole object over values nobody was editing.
 */

const FIELDS = [
  {
    key: "legalName" as const,
    label: "Registered name",
    hint: "As it appears on your filing. Printed on invoices and the tax export.",
    placeholder: "Torerone LLC",
    type: "text",
  },
  {
    key: "ein" as const,
    label: "EIN",
    hint: "9 digits. Left blank, documents say it is not recorded.",
    placeholder: "12-3456789",
    type: "text",
  },
  {
    key: "businessCode" as const,
    label: "Business activity code",
    hint: "The 6 digit NAICS code from your return, Schedule C line B.",
    placeholder: "541800",
    type: "text",
  },
];

type SaveFlash = { key: string; ok: boolean } | null;

/**
 * A phone field's save result for a moment: "Saved" for two seconds, or "Not
 * saved" a little longer (the toast says why). Shared with the client contact
 * and billing fields in Settings.
 */
export function useSaved() {
  const [state, setState] = useState<SaveFlash>(null);
  const flash = useCallback((key: string, ok: boolean) => {
    setState({ key, ok });
    window.setTimeout(() => setState((s) => (s?.key === key ? null : s)), ok ? 2000 : 4000);
  }, []);
  return [state, flash] as const;
}

/** What a phone field's label says about its save: Saving, Saved or Not saved. */
export function SaveTag({ saving, state, k }: { saving: boolean; state: SaveFlash; k: string }) {
  if (saving) return <span className="st-tag">Saving</span>;
  if (state?.key !== k) return null;
  return state.ok ? (
    <span className="st-tag ok">
      <Ic name="i-check" />
      Saved
    </span>
  ) : (
    <span className="st-tag bad">Not saved</span>
  );
}

/** An EIN with its middle digits as dots: the start and the last four, enough to recognise it. */
const maskEin = (v: string) => (v.length > 7 ? v.slice(0, 3) + "\u2022".repeat(v.length - 7) + v.slice(-4) : v);

export default function BusinessCard() {
  const toast = useToast();
  const [stored, setStored] = useState<AgencyBusiness | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const isPhone = useIsPhone();
  const [failed, setFailed] = useState(false);
  const [savedState, flash] = useSaved();
  const [showEin, setShowEin] = useState(false);
  const [einFocus, setEinFocus] = useState(false);

  const load = useCallback(async () => {
    try {
      const a = await api.get<AgencyBusiness>("/agency");
      setStored(a);
      setDraft({
        legalName: a.legalName ?? "",
        ein: a.ein ?? "",
        businessCode: a.businessCode ?? "",
        businessAddress: a.businessAddress ?? "",
      });
    } catch (err) {
      toast.fail("Could not load your business details", err);
      setFailed(true);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const intro = (
    <p className="st-intro">
      Your registered company. This goes on invoices, the year-end tax export and the reports clients keep. Leave a
      field empty and documents say it is not recorded rather than inventing one.
    </p>
  );
  if (!stored)
    return isPhone ? (
      <>
        {intro}
        {failed ? (
          <div className="mb-card st-blk">
            <p className="mb-p">Could not load your business details.</p>
            <button
              type="button"
              className="mb-btn"
              onClick={() => {
                setFailed(false);
                void load();
              }}
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="mb-card st-skelcard" aria-busy="true" />
        )}
      </>
    ) : null;

  const save = async (key: string) => {
    const value = draft[key] ?? "";
    const current = (stored[key as keyof AgencyBusiness] as string | null) ?? "";
    if (value.trim() === current) return;
    setSaving(key);
    try {
      const updated = await api.patch<AgencyBusiness>("/agency", { [key]: value });
      setStored(updated);
      // Show the stored form, not the typed one: an EIN typed without its
      // hyphen is saved with one, and the field should say so rather than
      // leave the operator wondering which version was kept.
      setDraft((d) => ({
        ...d,
        [key]: ((updated[key as keyof AgencyBusiness] as string | null) ?? "") as string,
      }));
      flash(key, true);
    } catch (err) {
      toast.fail("Could not save that", err);
      setDraft((d) => ({ ...d, [key]: current }));
      flash(key, false);
    } finally {
      setSaving(null);
    }
  };

  const saveMethod = (next: string) => {
    setSaving("accountingMethod");
    void (async () => {
      try {
        setStored(
          await api.patch<AgencyBusiness>("/agency", { accountingMethod: next }),
        );
        flash("accountingMethod", true);
      } catch (err) {
        toast.fail("Could not save the accounting method", err);
        flash("accountingMethod", false);
      } finally {
        setSaving(null);
      }
    })();
  };

  const method = stored.accountingMethod ?? "cash";

  if (isPhone) {
    return (
      <>
        {intro}
        <section className="mb-card st-form">
          {FIELDS.map((f) => {
            const ein = f.key === "ein";
            const value = draft[f.key] ?? "";
            const input = (
              <input
                id={`st-biz-${f.key}`}
                className="mb-input"
                type="text"
                inputMode={f.key === "legalName" ? undefined : "numeric"}
                autoComplete={f.key === "legalName" ? "organization" : "off"}
                value={ein && !showEin && !einFocus ? maskEin(value) : value}
                placeholder={f.placeholder}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                onFocus={ein ? () => setEinFocus(true) : undefined}
                onBlur={() => {
                  if (ein) setEinFocus(false);
                  void save(f.key);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            );
            return (
              <div className="mb-field" key={f.key}>
                <label className="mb-flab st-flab" htmlFor={`st-biz-${f.key}`}>
                  {f.label}
                  <SaveTag saving={saving === f.key} state={savedState} k={f.key} />
                </label>
                {ein ? (
                  <span className="st-eye">
                    {input}
                    <button
                      type="button"
                      className="mb-ib ghost"
                      aria-label={showEin ? "Hide EIN" : "Show EIN"}
                      aria-pressed={showEin}
                      onClick={() => setShowEin((x) => !x)}
                    >
                      <Ic name="i-eye" />
                    </button>
                  </span>
                ) : (
                  input
                )}
                <span className="st-help">{f.hint}</span>
              </div>
            );
          })}
        </section>
        <section className="mb-card st-form">
          <div className="mb-field">
            <label className="mb-flab st-flab" htmlFor="st-biz-businessAddress">
              Business address
              <SaveTag saving={saving === "businessAddress"} state={savedState} k="businessAddress" />
            </label>
            <textarea
              id="st-biz-businessAddress"
              className="mb-input"
              rows={2}
              autoComplete="street-address"
              value={draft.businessAddress ?? ""}
              placeholder={"123 Example Ave\nMiami, FL 33101"}
              onChange={(e) => setDraft((d) => ({ ...d, businessAddress: e.target.value }))}
              onBlur={() => void save("businessAddress")}
            />
            <span className="st-help">Printed under your name on invoices and the tax export.</span>
          </div>
          <div className="mb-field">
            <span className="mb-flab st-flab">
              Accounting method
              <SaveTag saving={saving === "accountingMethod"} state={savedState} k="accountingMethod" />
            </span>
            <div className="seg st-lg" role="radiogroup" aria-label="Accounting method">
              {(["cash", "accrual"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={method === m}
                  className={method === m ? "on" : undefined}
                  disabled={saving === "accountingMethod"}
                  onClick={() => method !== m && saveMethod(m)}
                >
                  {m === "cash" ? "Cash" : "Accrual"}
                </button>
              ))}
            </div>
            <span className="st-help">Cash counts money when it arrives, so unpaid months stay out of the export.</span>
          </div>
        </section>
      </>
    );
  }

  return (
    <div className="card glass setsec">
      <h3>Business</h3>
      <div className="sub" style={{ marginBottom: 10 }}>
        Your registered company. This is what goes on invoices, the year-end tax export and
        the reports clients keep. Leave a field empty and documents say it is not recorded
        rather than inventing one.
      </div>

      <div className="pcontact" style={{ maxWidth: 560 }}>
        {FIELDS.map((f) => (
          <label className="cfield" key={f.key}>
            <span className="lab">
              {f.label}
              {saving === f.key && <i> saving…</i>}
            </span>
            <input
              className="field-in"
              type={f.type}
              value={draft[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              onBlur={() => void save(f.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <span className="sub" style={{ fontSize: 11 }}>
              {f.hint}
            </span>
          </label>
        ))}

        <label className="cfield">
          <span className="lab">
            Business address
            {saving === "businessAddress" && <i> saving…</i>}
          </span>
          <textarea
            className="field-in"
            rows={3}
            value={draft.businessAddress ?? ""}
            placeholder={"123 Example Ave\nMiami, FL 33101"}
            onChange={(e) => setDraft((d) => ({ ...d, businessAddress: e.target.value }))}
            onBlur={() => void save("businessAddress")}
          />
          <span className="sub" style={{ fontSize: 11 }}>
            Printed under your name on invoices and the tax export.
          </span>
        </label>

        <label className="cfield">
          <span className="lab">
            Accounting method
            {saving === "accountingMethod" && <i> saving…</i>}
          </span>
          <Select
            value={method}
            options={[
              { value: "cash", label: "Cash" },
              { value: "accrual", label: "Accrual" },
            ]}
            onChange={saveMethod}
          />
          <span className="sub" style={{ fontSize: 11 }}>
            Cash counts money when it arrives, so unpaid months stay out of the export.
          </span>
        </label>
      </div>
    </div>
  );
}
