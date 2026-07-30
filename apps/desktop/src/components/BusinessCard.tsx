import { useCallback, useEffect, useState } from "react";
import { useToast } from "./Toasts";
import { api, type AgencyBusiness } from "../lib/api";

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

export default function BusinessCard() {
  const toast = useToast();
  const [stored, setStored] = useState<AgencyBusiness | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

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
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!stored) return null;

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
    } catch (err) {
      toast.fail("Could not save that", err);
      setDraft((d) => ({ ...d, [key]: current }));
    } finally {
      setSaving(null);
    }
  };

  const method = stored.accountingMethod ?? "cash";

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
          <select
            className="field-in"
            value={method}
            onChange={(e) => {
              const next = e.target.value;
              setSaving("accountingMethod");
              void (async () => {
                try {
                  setStored(
                    await api.patch<AgencyBusiness>("/agency", { accountingMethod: next }),
                  );
                } catch (err) {
                  toast.fail("Could not save the accounting method", err);
                } finally {
                  setSaving(null);
                }
              })();
            }}
          >
            <option value="cash">Cash</option>
            <option value="accrual">Accrual</option>
          </select>
          <span className="sub" style={{ fontSize: 11 }}>
            Cash counts money when it arrives, so unpaid months stay out of the export.
          </span>
        </label>
      </div>
    </div>
  );
}
