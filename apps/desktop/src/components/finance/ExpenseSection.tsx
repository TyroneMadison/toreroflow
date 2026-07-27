import { useRef, useState } from "react";
import { formatCents, type ExpenseCategory } from "@toreroflow/core";
import { useToast } from "../Toasts";
import { api } from "../../lib/api";
import { colorFor, type ExpenseRow } from "../../lib/financials";
import ColorPicker from "./ColorPicker";

interface AddDraft {
  name: string;
  categoryLine: string;
  dollars: string;
  variable: boolean;
  incurredOn: string;
}

/**
 * One expense list, recurring or one-off; the two sections share everything
 * but their copy and their add-form fields. An amount left blank stays
 * null, shown as Missing: an unentered bill must never read as free.
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
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<AddDraft>({
    name: "",
    categoryLine: kind === "recurring" ? "software" : "other",
    dollars: "",
    variable: false,
    incurredOn: new Date().toISOString().slice(0, 10),
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amountDraft, setAmountDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Escape unmounts the focused input, and that unmount fires a native blur
  // which would commit the value the user just cancelled. The ref lets the
  // blur handler tell an Escape-driven unmount from a real blur.
  const cancelEdit = useRef(false);

  const dollarsToCents = (raw: string): number | null | undefined => {
    if (raw.trim() === "") return null;
    const dollars = Number.parseFloat(raw);
    if (!Number.isFinite(dollars) || dollars < 0) return undefined;
    return Math.round(dollars * 100);
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
        variable: kind === "recurring" ? draft.variable : false,
        incurredOn: kind === "one_off" ? new Date(`${draft.incurredOn}T12:00:00`).toISOString() : null,
      });
      setAdding(false);
      setDraft((d) => ({ ...d, name: "", dollars: "", variable: false }));
      onChanged();
    } catch (err) {
      toast.fail("Could not add the expense", err);
    }
  };

  const commitAmount = async (row: ExpenseRow) => {
    const cents = dollarsToCents(amountDraft);
    setEditingId(null);
    if (cents === undefined) return;
    if (cents === row.amountCents) return;
    try {
      await api.patch(`/financials/expenses/${row.id}`, { amountCents: cents });
      onChanged();
    } catch (err) {
      toast.fail(`Could not change ${row.name}`, err);
    }
  };

  const setCategory = async (row: ExpenseRow, categoryLine: string) => {
    try {
      await api.patch(`/financials/expenses/${row.id}`, { categoryLine });
      onChanged();
    } catch (err) {
      toast.fail(`Could not recategorise ${row.name}`, err);
    }
  };

  const setColor = async (row: ExpenseRow, color: string) => {
    try {
      await api.patch(`/financials/expenses/${row.id}`, { color });
      onChanged();
    } catch (err) {
      toast.fail(`Could not recolour ${row.name}`, err);
    }
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
      onChanged();
    } catch (err) {
      toast.fail(`Could not delete ${row.name}`, err);
    }
  };

  const subLine = (row: ExpenseRow): string => {
    const cat = byKey.get(row.categoryLine);
    const catLabel = cat?.label ?? row.categoryLine;
    if (row.amountCents === null) return `${catLabel} · bill not entered`;
    if (kind === "one_off") {
      const day = row.incurredOn
        ? new Date(row.incurredOn).toLocaleDateString([], { month: "short", day: "numeric" })
        : "";
      if (row.categoryLine === "meals") {
        return `${catLabel}${day ? ` · ${day}` : ""} · 50% deductible, ${formatCents(Math.round(row.amountCents / 2))} claimable`;
      }
      return `${catLabel}${day ? ` · ${day}` : ""}`;
    }
    return `${catLabel} · ${row.variable ? "varies monthly" : "monthly"}`;
  };

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>{title}</h3>
          <div className="sub">{sub}</div>
        </div>
        <div className="amt o">
          {formatCents(totalCents)}
          {missingCount > 0 ? " +" : ""}
        </div>
      </div>

      {rows.map((row, i) => (
        <div className={`lrow${row.amountCents === null ? " miss" : ""}`} key={row.id}>
          <div className="cat">{byKey.get(row.categoryLine)?.emoji ?? "📌"}</div>
          <div className="lmeta">
            <b>{row.name}</b>
            <span>{subLine(row)}</span>
          </div>
          <select
            className="field-in catpick"
            value={row.categoryLine}
            onChange={(e) => void setCategory(row, e.target.value)}
            title="Schedule C category"
          >
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          {row.amountCents === null && editingId !== row.id && <span className="tag miss">Missing</span>}
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
              title="Click to set this month's amount"
              onClick={() => {
                setEditingId(row.id);
                setAmountDraft(row.amountCents === null ? "" : (row.amountCents / 100).toFixed(2));
              }}
            >
              {row.amountCents === null ? "-" : formatCents(row.amountCents)}
            </div>
          )}
          <ColorPicker value={colorFor(row.color, i)} onChange={(c) => void setColor(row, c)} />
          <button
            className={`del${confirmingId === row.id ? " arm" : ""}`}
            title={confirmingId === row.id ? "Click again to delete" : "Delete"}
            onClick={() => void remove(row)}
          >
            {confirmingId === row.id ? "SURE?" : "✕"}
          </button>
        </div>
      ))}

      {adding ? (
        <div className="lrow addform">
          <input
            className="field-in"
            style={{ flex: 1, minWidth: 120 }}
            placeholder={kind === "recurring" ? "e.g. Adobe Creative Cloud" : "e.g. Client dinner"}
            autoFocus
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <select
            className="field-in catpick"
            value={draft.categoryLine}
            onChange={(e) => setDraft((d) => ({ ...d, categoryLine: e.target.value }))}
          >
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <div className="pricein">
            <span>$</span>
            <input
              className="field-in"
              type="number"
              min="0"
              step="0.01"
              placeholder="blank = unknown"
              value={draft.dollars}
              onChange={(e) => setDraft((d) => ({ ...d, dollars: e.target.value }))}
            />
          </div>
          {kind === "recurring" ? (
            <label className="varpick">
              <input
                type="checkbox"
                checked={draft.variable}
                onChange={(e) => setDraft((d) => ({ ...d, variable: e.target.checked }))}
              />
              varies monthly
            </label>
          ) : (
            <input
              className="field-in"
              type="date"
              value={draft.incurredOn}
              onChange={(e) => setDraft((d) => ({ ...d, incurredOn: e.target.value }))}
            />
          )}
          <button className="btn" disabled={!draft.name.trim()} onClick={() => void add()}>
            Add
          </button>
          <button className="btn" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="addrow" onClick={() => setAdding(true)}>
          ＋ {kind === "recurring" ? "Add a recurring cost" : "Add a one-off expense"}
        </div>
      )}
    </div>
  );
}
