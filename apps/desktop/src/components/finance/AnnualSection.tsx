import { useRef, useState } from "react";
import { formatCents, type ExpenseCategory } from "@toreroflow/core";
import { api } from "../../lib/api";
import { useToast } from "../Toasts";
import { dollarsToCents, type ExpenseRow } from "../../lib/financials";

/**
 * Costs billed once a year, and what they really cost per month.
 *
 * A domain renewal charged every March is money the business spends all year.
 * Seeing it only in March makes eleven months look cheaper than they are and
 * March look like a disaster, so a twelfth of the yearly total is counted in
 * every month's money out. The full figure stays on the row it was charged on,
 * which is what the tax export reads, so nothing is deducted twelve times.
 *
 * Editable here, which it did not use to be. The card listed the whole year
 * and sent you to Money coming out to change anything, but Money coming out
 * only ever shows one month: a subscription charged in July could not be
 * touched at all from August, which is most of the year. The amount, the name
 * and the delete now live on the row itself.
 */
export default function AnnualSection({
  rows,
  categories,
  shareCents,
  yearCents,
  onChanged,
}: {
  rows: ExpenseRow[];
  categories: ExpenseCategory[];
  /** A twelfth of the year, already counted in this month's money out. */
  shareCents: number;
  yearCents: number;
  onChanged(): void;
}) {
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amountDraft, setAmountDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Escape unmounts the focused input, and that unmount fires a native blur
  // which would commit the value just cancelled. The ref lets the blur handler
  // tell an Escape-driven unmount from a real blur.
  const cancelEdit = useRef(false);

  if (rows.length === 0) return null;
  const byKey = new Map(categories.map((c) => [c.key, c]));
  const missing = rows.filter((r) => r.amountCents === null).length;

  const chargedIn = (row: ExpenseRow): string =>
    new Date(Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7)) - 1, 1).toLocaleDateString(
      "en-US",
      { month: "long" },
    );

  const patch = async (row: ExpenseRow, data: Record<string, unknown>, what: string) => {
    try {
      await api.patch(`/financials/expenses/${row.id}`, data);
      onChanged();
    } catch (err) {
      toast.fail(`Could not ${what} ${row.name}`, err);
    }
  };

  const commitAmount = async (row: ExpenseRow) => {
    const cents = dollarsToCents(amountDraft);
    setEditingId(null);
    if (cents === undefined) {
      toast.fail("Could not save the amount", new Error("enter a valid amount or leave it blank"));
      return;
    }
    if (cents === row.amountCents) return;
    await patch(row, { amountCents: cents }, "change");
  };

  const commitName = async (row: ExpenseRow) => {
    const name = nameDraft.trim();
    setRenamingId(null);
    if (!name || name === row.name) return;
    await patch(row, { name }, "rename");
  };

  const remove = async (row: ExpenseRow) => {
    // Two presses, because a yearly cost is entered once and a stray click on
    // a row you cannot see from most months is easy to make and slow to spot.
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

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>Billed yearly</h3>
          <div className="sub">
            Charged once, spread across twelve months so every month shows what you are really
            paying.
          </div>
        </div>
        <div className="amt o">
          {formatCents(yearCents)}
          {missing > 0 ? " +" : ""}
        </div>
      </div>

      <div className="kpis k2" style={{ marginTop: 16 }}>
        <div className="kpi glass-sm">
          <div className="lab">Per year</div>
          <div className="val">{formatCents(yearCents)}</div>
        </div>
        <div className="kpi glass-sm">
          <div className="lab">Counted every month</div>
          <div className="val">{formatCents(shareCents)}</div>
        </div>
      </div>

      {rows.map((row) => (
        <div className={`lrow${row.amountCents === null ? " miss" : ""}`} key={row.id}>
          <div className="cat">{byKey.get(row.categoryLine)?.emoji ?? "📌"}</div>
          <div className="lmeta">
            {renamingId === row.id ? (
              <input
                className="field-in"
                autoFocus
                maxLength={120}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => {
                  if (cancelEdit.current) {
                    cancelEdit.current = false;
                    return;
                  }
                  void commitName(row);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    cancelEdit.current = true;
                    setRenamingId(null);
                  }
                }}
              />
            ) : (
              <b>{row.name}</b>
            )}
            <span>
              {byKey.get(row.categoryLine)?.label ?? row.categoryLine} · charged in {chargedIn(row)}
              {row.amountCents === null
                ? " · bill not entered"
                : ` · ${formatCents(Math.floor(row.amountCents / 12))} a month`}
            </span>
          </div>

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
              title="Click to set what this costs for the year"
              onClick={() => {
                setEditingId(row.id);
                setAmountDraft(row.amountCents === null ? "" : (row.amountCents / 100).toFixed(2));
              }}
            >
              {row.amountCents === null ? "-" : formatCents(row.amountCents)}
            </div>
          )}

          <button
            className={`del pencil${renamingId === row.id ? " arm" : ""}`}
            title="Rename"
            onClick={() => {
              if (renamingId === row.id) {
                setRenamingId(null);
                return;
              }
              setRenamingId(row.id);
              setNameDraft(row.name);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-pencil" />
            </svg>
          </button>
          <button
            className={`del${confirmingId === row.id ? " arm" : ""}`}
            title={confirmingId === row.id ? "Click again to delete" : "Delete"}
            onClick={() => void remove(row)}
          >
            {confirmingId === row.id ? "SURE?" : "✕"}
          </button>
        </div>
      ))}

      {missing > 0 && (
        <div className="warnline" style={{ marginTop: 10 }}>
          {missing} yearly bill{missing === 1 ? "" : "s"} with no amount entered, so the monthly
          share is lower than the real one.
        </div>
      )}
    </div>
  );
}
