import { useEffect, useRef, useState } from "react";
import { deductibleCents, formatCents, NOTE_MAX, type ExpenseCategory } from "@toreroflow/core";
import Select from "../Select";
import { useToast } from "../Toasts";
import { api } from "../../lib/api";
import {
  colorFor,
  dollarsToCents,
  monthsOfYear,
  ordinalDay,
  type ExpenseRow,
  type ExpenseYear,
} from "../../lib/financials";
import ColorPicker from "./ColorPicker";

interface AddDraft {
  name: string;
  categoryLine: string;
  dollars: string;
  variable: boolean;
  annual: boolean;
  dueDay: string;
  note: string;
  incurredOn: string;
}

/** What the pencil opens: everything about a cost that is not its amount. */
interface EditDraft {
  name: string;
  note: string;
  dueDay: string;
  annual: boolean;
  variable: boolean;
}

const DAY_OPTIONS = [
  { value: "", label: "No set day" },
  ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: ordinalDay(i + 1) })),
];

/**
 * One expense list, recurring or one-off; the two sections share everything
 * but their copy and their add-form fields. An amount left blank stays
 * null, shown as Missing: an unentered bill must never read as free.
 *
 * The one-off list carries its own month picker. One-offs never roll forward,
 * which is what makes them one-off, so each month holds only what happened in
 * it; without a picker here, reading last March meant moving the whole screen
 * to March and taking every other figure with it.
 */
export default function ExpenseSection({
  title,
  sub,
  kind,
  rows,
  categories,
  month,
  totalCents,
  missingCount,
  onChanged,
}: {
  title: string;
  sub: string;
  kind: "recurring" | "one_off";
  rows: ExpenseRow[];
  categories: ExpenseCategory[];
  month: string;
  totalCents: number;
  missingCount: number;
  onChanged(): void;
}) {
  const toast = useToast();
  const byKey = new Map(categories.map((c) => [c.key, c]));
  const recurring = kind === "recurring";
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<AddDraft>({
    name: "",
    categoryLine: recurring ? "software" : "other",
    dollars: "",
    variable: false,
    annual: false,
    dueDay: "",
    note: "",
    incurredOn: new Date().toISOString().slice(0, 10),
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amountDraft, setAmountDraft] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EditDraft | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Escape unmounts the focused input, and that unmount fires a native blur
  // which would commit the value the user just cancelled. The ref lets the
  // blur handler tell an Escape-driven unmount from a real blur.
  const cancelEdit = useRef(false);

  /*
   * Browsing an earlier month, for the one-off list only.
   *
   * Null means "whatever the screen is showing", which is the ordinary case
   * and costs no request. Picking another month fetches that year once.
   */
  const [browseMonth, setBrowseMonth] = useState<string | null>(null);
  const [year, setYear] = useState<ExpenseYear | null>(null);
  const browsing = browseMonth !== null && browseMonth !== month;

  useEffect(() => {
    // The screen moved months, so a stale browse would be lying about where
    // the operator is.
    setBrowseMonth(null);
    setYear(null);
  }, [month]);

  const loadYear = async (target: string) => {
    try {
      const data = await api.get<ExpenseYear>(
        `/financials/expenses/by-month?year=${target.slice(0, 4)}&kind=${kind}`,
      );
      setYear(data);
    } catch (err) {
      setBrowseMonth(null);
      toast.fail("Could not load that month", err);
    }
  };

  const browsed = browsing ? (year?.months.find((m) => m.month === browseMonth) ?? null) : null;
  const shownRows = browsed ? browsed.rows : rows;
  const shownTotal = browsed ? browsed.totalCents : totalCents;
  const shownMissing = browsed ? browsed.missingBills : missingCount;

  /** A month the operator is only reading is not one they should be editing. */
  const readOnly = browsing;

  const refresh = () => {
    if (browsing && browseMonth) void loadYear(browseMonth);
    onChanged();
  };

  const add = async () => {
    if (!draft.name.trim()) return;
    const cents = dollarsToCents(draft.dollars);
    if (cents === undefined) {
      toast.fail("Could not add the expense", new Error("enter a valid amount or leave it blank"));
      return;
    }
    try {
      await api.post("/financials/expenses", {
        name: draft.name.trim(),
        categoryLine: draft.categoryLine,
        amountCents: cents,
        month,
        kind,
        variable: recurring ? draft.variable : false,
        cadence: recurring && draft.annual ? "annual" : "monthly",
        dueDay: recurring && draft.dueDay ? Number(draft.dueDay) : null,
        note: draft.note.trim() || null,
        incurredOn: !recurring ? new Date(`${draft.incurredOn}T12:00:00`).toISOString() : null,
      });
      setAdding(false);
      setDraft((d) => ({ ...d, name: "", dollars: "", variable: false, annual: false, note: "" }));
      onChanged();
    } catch (err) {
      toast.fail("Could not add the expense", err);
    }
  };

  const patch = async (row: ExpenseRow, data: Record<string, unknown>, what: string) => {
    try {
      await api.patch(`/financials/expenses/${row.id}`, data);
      refresh();
    } catch (err) {
      toast.fail(`Could not ${what} ${row.name}`, err);
    }
  };

  const commitAmount = async (row: ExpenseRow) => {
    const cents = dollarsToCents(amountDraft);
    setEditingId(null);
    if (cents === undefined) return;
    if (cents === row.amountCents) return;
    await patch(row, { amountCents: cents }, "change");
  };

  const openDetail = (row: ExpenseRow) => {
    setDetailId(row.id);
    setDetail({
      name: row.name,
      note: row.note ?? "",
      dueDay: row.dueDay === null ? "" : String(row.dueDay),
      annual: row.cadence === "annual",
      variable: row.variable,
    });
  };

  const commitDetail = async (row: ExpenseRow) => {
    if (!detail) return;
    const name = detail.name.trim();
    if (!name) {
      toast.fail("Could not save", new Error("an expense needs a name"));
      return;
    }
    setDetailId(null);
    await patch(
      row,
      {
        name,
        note: detail.note.trim() || null,
        ...(recurring
          ? {
              dueDay: detail.dueDay ? Number(detail.dueDay) : null,
              cadence: detail.annual ? "annual" : "monthly",
              variable: detail.variable,
            }
          : {}),
      },
      "save",
    );
  };

  const remove = async (row: ExpenseRow) => {
    if (confirmingId !== row.id) {
      setConfirmingId(row.id);
      window.setTimeout(() => setConfirmingId((c) => (c === row.id ? null : c)), 2500);
      return;
    }
    setConfirmingId(null);
    try {
      await api.del(`/financials/expenses/${row.id}`);
      refresh();
    } catch (err) {
      toast.fail(`Could not delete ${row.name}`, err);
    }
  };

  const subLine = (row: ExpenseRow): string => {
    const cat = byKey.get(row.categoryLine);
    const catLabel = cat?.label ?? row.categoryLine;
    if (row.amountCents === null) return `${catLabel} · bill not entered`;
    if (!recurring) {
      const day = row.incurredOn
        ? new Date(row.incurredOn).toLocaleDateString([], { month: "short", day: "numeric" })
        : "";
      if (row.categoryLine === "meals") {
        return `${catLabel}${day ? ` · ${day}` : ""} · 50% deductible, ${formatCents(deductibleCents(row.categoryLine, row.amountCents))} claimable`;
      }
      return `${catLabel}${day ? ` · ${day}` : ""}`;
    }
    const when = row.dueDay ? ` · ${ordinalDay(row.dueDay)}` : "";
    return `${catLabel}${when} · ${row.variable ? "varies monthly" : "monthly"}`;
  };

  const monthLabel = (key: string): string =>
    new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>{title}</h3>
          <div className="sub">{sub}</div>
        </div>
        {!recurring && (
          <Select
            className="repmonth monthbrowse"
            value={browseMonth ?? month}
            onChange={(v) => {
              setBrowseMonth(v);
              if (v !== month) void loadYear(v);
            }}
            aria-label="Which month of one-off expenses to show"
            title="Look back at another month without moving the whole screen"
            options={monthsOfYear(Number(month.slice(0, 4)))}
          />
        )}
        <div className="amt o">
          {formatCents(shownTotal)}
          {shownMissing > 0 ? " +" : ""}
        </div>
      </div>

      {browsing && (
        <div className="warnline" style={{ marginTop: 8 }}>
          Reading {monthLabel(browseMonth!)}. Switch back to {monthLabel(month)} to make changes.
        </div>
      )}

      {shownRows.map((row, i) => (
        <div key={row.id}>
          <div className={`lrow${row.amountCents === null ? " miss" : ""}`}>
            <div className="cat">{byKey.get(row.categoryLine)?.emoji ?? "📌"}</div>
            <div className="lmeta">
              <b>{row.name}</b>
              <span>{subLine(row)}</span>
            </div>
            <Select
              className="catpick"
              value={row.categoryLine}
              disabled={readOnly}
              onChange={(v) => void patch(row, { categoryLine: v }, "recategorise")}
              title="Schedule C category"
              options={categories.map((c) => ({ value: c.key, label: c.label }))}
            />
            {row.amountCents === null && editingId !== row.id && (
              <span className="tag miss">Missing</span>
            )}
            {editingId === row.id ? (
              <div className="pricein">
                <span>$</span>
                <input
                  className="field-in"
                  type="number"
                  min="0"
                  step="0.01"
                  autoFocus
                  value={amountDraft}
                  onChange={(e) => setAmountDraft(e.target.value)}
                  onBlur={() => {
                    if (cancelEdit.current) {
                      cancelEdit.current = false;
                      return;
                    }
                    void commitAmount(row);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      cancelEdit.current = true;
                      setEditingId(null);
                    }
                  }}
                />
              </div>
            ) : (
              <div
                className={`amt o editable${row.amountCents === null ? " unknown" : ""}`}
                title={readOnly ? "Switch back to this month to edit" : "Click to set this month's amount"}
                onClick={() => {
                  if (readOnly) return;
                  setEditingId(row.id);
                  setAmountDraft(row.amountCents === null ? "" : (row.amountCents / 100).toFixed(2));
                }}
              >
                {row.amountCents === null ? "-" : formatCents(row.amountCents)}
              </div>
            )}
            <ColorPicker value={colorFor(row.color, i)} onChange={(c) => void patch(row, { color: c }, "recolour")} />
            <button
              className={`del pencil${detailId === row.id ? " arm" : ""}`}
              title="Rename, and write a note to yourself"
              disabled={readOnly}
              onClick={() => (detailId === row.id ? setDetailId(null) : openDetail(row))}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-pencil" />
              </svg>
            </button>
            <button
              className={`del${confirmingId === row.id ? " arm" : ""}`}
              title={confirmingId === row.id ? "Click again to delete" : "Delete"}
              disabled={readOnly}
              onClick={() => void remove(row)}
            >
              {confirmingId === row.id ? "SURE?" : "✕"}
            </button>
          </div>

          {/* The pencil opens here rather than adding a fifth control to the
              row. A 250 character note needs room to be read back, and the
              row is already carrying everything it can hold. */}
          {detailId === row.id && detail && (
            <div className="editpanel">
              <label className="cfield">
                <span className="lab">Name</span>
                <input
                  className="field-in"
                  autoFocus
                  maxLength={120}
                  value={detail.name}
                  onChange={(e) => setDetail((d) => d && { ...d, name: e.target.value })}
                />
              </label>
              <label className="cfield">
                <span className="lab">
                  Note <i>{detail.note.length}/{NOTE_MAX}</i>
                </span>
                <textarea
                  className="field-in"
                  rows={3}
                  maxLength={NOTE_MAX}
                  placeholder="What this is, and anything you want to remember about it"
                  value={detail.note}
                  onChange={(e) => setDetail((d) => d && { ...d, note: e.target.value })}
                  style={{ resize: "vertical" }}
                />
              </label>
              {recurring && (
                <div className="editrow">
                  <label className="cfield" style={{ flex: 1, minWidth: 160 }}>
                    <span className="lab">Day the bill lands</span>
                    <Select
                      value={detail.dueDay}
                      onChange={(v) => setDetail((d) => d && { ...d, dueDay: v })}
                      options={DAY_OPTIONS}
                    />
                  </label>
                  <label className="varpick">
                    <input
                      type="checkbox"
                      checked={detail.annual}
                      onChange={(e) => setDetail((d) => d && { ...d, annual: e.target.checked })}
                    />
                    billed yearly
                  </label>
                  <label className="varpick">
                    <input
                      type="checkbox"
                      checked={detail.variable}
                      onChange={(e) => setDetail((d) => d && { ...d, variable: e.target.checked })}
                    />
                    varies monthly
                  </label>
                </div>
              )}
              <div className="editrow">
                <button className="btn" onClick={() => void commitDetail(row)}>
                  Save
                </button>
                <button className="btn ghost" onClick={() => setDetailId(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {row.note && detailId !== row.id && <div className="lnote">{row.note}</div>}
        </div>
      ))}

      {shownRows.length === 0 && (
        <p className="insworking" style={{ marginTop: 12 }}>
          Nothing here for {monthLabel(browseMonth ?? month)}.
        </p>
      )}

      {readOnly ? null : adding ? (
        <div className="lrow addform">
          <input
            className="field-in"
            style={{ flex: 1, minWidth: 120 }}
            placeholder={recurring ? "e.g. Adobe Creative Cloud" : "e.g. Client dinner"}
            autoFocus
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <Select
            className="catpick"
            value={draft.categoryLine}
            onChange={(v) => setDraft((d) => ({ ...d, categoryLine: v }))}
            options={categories.map((c) => ({ value: c.key, label: c.label }))}
          />
          <div className="pricein">
            <span>$</span>
            <input
              className="field-in"
              type="number"
              min="0"
              step="0.01"
              placeholder={draft.annual ? "per year" : "blank = unknown"}
              value={draft.dollars}
              onChange={(e) => setDraft((d) => ({ ...d, dollars: e.target.value }))}
            />
          </div>
          {recurring ? (
            <>
              <Select
                className="catpick"
                value={draft.dueDay}
                title="Which day of the month this bill lands"
                onChange={(v) => setDraft((d) => ({ ...d, dueDay: v }))}
                options={DAY_OPTIONS}
              />
              <label className="varpick">
                <input
                  type="checkbox"
                  checked={draft.annual}
                  onChange={(e) => setDraft((d) => ({ ...d, annual: e.target.checked }))}
                />
                billed yearly
              </label>
              <label className="varpick">
                <input
                  type="checkbox"
                  checked={draft.variable}
                  onChange={(e) => setDraft((d) => ({ ...d, variable: e.target.checked }))}
                />
                varies monthly
              </label>
            </>
          ) : (
            <input
              className="field-in"
              type="date"
              style={{ width: "auto", flex: "0 1 160px" }}
              value={draft.incurredOn}
              onChange={(e) => setDraft((d) => ({ ...d, incurredOn: e.target.value }))}
            />
          )}
          <textarea
            className="field-in addnote"
            rows={2}
            maxLength={NOTE_MAX}
            placeholder={`A note to yourself, up to ${NOTE_MAX} characters`}
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          />
          <div className="editrow">
            <button className="btn" disabled={!draft.name.trim()} onClick={() => void add()}>
              Add
            </button>
            <button className="btn ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="addrow" onClick={() => setAdding(true)}>
          ＋ {recurring ? "Add a recurring cost" : "Add a one-off expense"}
        </div>
      )}
    </div>
  );
}
