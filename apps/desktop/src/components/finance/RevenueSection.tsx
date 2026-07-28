import { useRef, useState } from "react";
import { formatCents } from "@toreroflow/core";
import { useToast } from "../Toasts";
import { api, fileUrl, type ClientSummary } from "../../lib/api";
import { openExternal } from "../../lib/external";
import { useAppState } from "../../state/AppState";
import { colorFor, type RevenueRow } from "../../lib/financials";
import ColorPicker from "./ColorPicker";

const STATUS_LABEL: Record<RevenueRow["status"], string> = {
  paid: "Paid",
  pending: "Not due",
  due: "Due",
};

type BillingMode = "calendar" | "on_fulfilment";

interface PriceDraft {
  dollars: string;
  mode: BillingMode;
}

const EMPTY_DRAFT: PriceDraft = { dollars: "", mode: "calendar" };

/**
 * What each client owes this month.
 *
 * "Not due" only ever appears for a fulfilment-gated client whose cycle is
 * unfinished, which is the signal for whether you have earned the right to
 * ask for the next payment.
 */
export default function RevenueSection({
  rows,
  totalCents,
  month,
  onChanged,
}: {
  rows: RevenueRow[];
  totalCents: number;
  month: string;
  onChanged(): void;
}) {
  const toast = useToast();
  const { clients, refreshClients } = useAppState();

  // Deleting a row only sticks where the month seeder will not recreate it:
  // past months, or clients with no standing price. Everywhere else the row
  // would silently come back on the next refresh, so the button hides and
  // setting the amount to $0 is the way to skip a month.
  const currentMonthKey = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  };
  const deleteSticks = (row: RevenueRow): boolean => {
    if (month < currentMonthKey()) return true;
    const client = clients.find((c) => c.id === row.clientId);
    return client?.monthlyPriceCents == null;
  };

  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  // Inline edit of one row's amount for this month only. The standing price
  // in Settings is untouched; future months seed from that, not from this.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amountDraft, setAmountDraft] = useState("");
  // Two-step delete: first click arms, second click within the window fires.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Escape unmounts the focused input, and that unmount fires a native blur
  // which would commit the value the user just cancelled. The ref lets the
  // blur handler tell an Escape-driven unmount from a real blur.
  const cancelEdit = useRef(false);

  // Clients the API never returned a row for. /financials seeds a revenue
  // row for every client with a price (see routes/financials.ts), so a
  // client missing here has no price yet, not a client that failed to load.
  // Without this, such a client is invisible on this screen and unreachable
  // from the app: the only way to price them was to curl the billing route.
  const unpriced = clients.filter((c) => !rows.some((r) => r.clientId === c.id));

  const draftFor = (clientId: string): PriceDraft => drafts[clientId] ?? EMPTY_DRAFT;

  const setDraft = (clientId: string, patch: Partial<PriceDraft>) => {
    setDrafts((prev) => ({ ...prev, [clientId]: { ...draftFor(clientId), ...patch } }));
  };

  const savePrice = async (client: ClientSummary) => {
    const draft = draftFor(client.id);
    const dollars = Number.parseFloat(draft.dollars);
    if (!Number.isFinite(dollars) || dollars < 0) {
      toast.fail(`Could not set a price for ${client.name}`, new Error("enter a valid amount"));
      return;
    }
    try {
      await api.patch(`/clients/${client.id}/billing`, {
        // Dollars live in the field; cents live in the database. Rounding
        // once here, rather than trusting the browser's float math, is what
        // keeps a price like 49.99 from drifting into a non-integer cents
        // value on the way in.
        monthlyPriceCents: Math.round(dollars * 100),
        billingMode: draft.mode,
      });
      // The delete button's resurrect guard reads the standing price from
      // context; without this refresh it would offer delete on a row the
      // month seeder immediately recreates.
      await refreshClients();
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[client.id];
        return next;
      });
      onChanged();
    } catch (err) {
      toast.fail(`Could not set a price for ${client.name}`, err);
    }
  };

  const togglePaid = async (row: RevenueRow) => {
    try {
      await api.patch(`/financials/revenue/${row.id}`, {
        receivedAt: row.status === "paid" ? null : new Date().toISOString(),
      });
      onChanged();
    } catch (err) {
      toast.fail(`Could not update ${row.clientName}`, err);
    }
  };

  const setColor = async (row: RevenueRow, color: string) => {
    try {
      await api.patch(`/financials/revenue/${row.id}`, { color });
      onChanged();
    } catch (err) {
      toast.fail(`Could not recolour ${row.clientName}`, err);
    }
  };

  const startAmountEdit = (row: RevenueRow) => {
    setEditingId(row.id);
    setAmountDraft((row.amountCents / 100).toFixed(2));
  };

  const commitAmount = async (row: RevenueRow) => {
    const dollars = Number.parseFloat(amountDraft);
    setEditingId(null);
    if (!Number.isFinite(dollars) || dollars < 0) return;
    const cents = Math.round(dollars * 100);
    if (cents === row.amountCents) return;
    try {
      await api.patch(`/financials/revenue/${row.id}`, { amountCents: cents });
      onChanged();
    } catch (err) {
      toast.fail(`Could not change the amount for ${row.clientName}`, err);
    }
  };

  const removeRow = async (row: RevenueRow) => {
    if (confirmingId !== row.id) {
      setConfirmingId(row.id);
      window.setTimeout(() => setConfirmingId((c) => (c === row.id ? null : c)), 2500);
      return;
    }
    setConfirmingId(null);
    try {
      await api.del(`/financials/revenue/${row.id}`);
      onChanged();
    } catch (err) {
      toast.fail(`Could not remove ${row.clientName}'s row`, err);
    }
  };

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>Money coming in</h3>
          <div className="sub">Click the tag to mark a month paid, click the amount to change it.</div>
        </div>
        <div className="amt i">{formatCents(totalCents)}</div>
      </div>

      {rows.length === 0 && unpriced.length === 0 ? (
        <div className="btnote" style={{ marginTop: 10 }}>
          No clients yet. Add one to start tracking revenue.
        </div>
      ) : (
        rows.map((row, i) => (
          <div className="lrow" key={row.id}>
            <div className="av">
              {row.avatarUrl ? (
                <img src={row.avatarUrl} alt="" />
              ) : (
                (row.avatarSeed ?? row.clientName.slice(0, 2).toUpperCase())
              )}
            </div>
            <div className="lmeta">
              <b>{row.clientName}</b>
              <span>
                {row.status === "paid" && row.receivedAt
                  ? `Paid ${new Date(row.receivedAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
                  : row.status === "pending"
                    ? "Cycle opens once delivered"
                    : "Payable now"}
              </span>
            </div>
            {row.quotaTarget !== null && (
              <div className={`quota${(row.quotaDelivered ?? 0) >= row.quotaTarget ? " ok" : ""}`}>
                <b>
                  {row.quotaDelivered}/{row.quotaTarget}
                </b>
                delivered
              </div>
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
                className="amt i editable"
                title="Click to change this month's amount"
                onClick={() => startAmountEdit(row)}
              >
                {formatCents(row.amountCents)}
              </div>
            )}
            <span
              className={`tag ${row.status === "paid" ? "paid" : row.status === "pending" ? "due" : "warn"}`}
              style={{ cursor: "pointer" }}
              title={row.status === "paid" ? "Mark unpaid" : "Mark paid"}
              onClick={() => void togglePaid(row)}
            >
              {STATUS_LABEL[row.status]}
            </span>
            <ColorPicker
              value={colorFor(row.color, i)}
              onChange={(c) => void setColor(row, c)}
            />
            {row.billingMode === "on_fulfilment" && row.quotaMet && (
              <button
                className="btn"
                onClick={() => {
                  void api
                    .post<{ url: string }>("/financials/invoices", {
                      clientId: row.clientId,
                      month,
                    })
                    .then((r) => openExternal(fileUrl(r.url)!))
                    .catch((err) => toast.fail(`Could not invoice ${row.clientName}`, err));
                }}
              >
                Invoice
              </button>
            )}
            {deleteSticks(row) && (
              <button
                className={`del${confirmingId === row.id ? " arm" : ""}`}
                title={confirmingId === row.id ? "Click again to remove" : "Remove this month's row"}
                onClick={() => void removeRow(row)}
              >
                {confirmingId === row.id ? "SURE?" : "✕"}
              </button>
            )}
          </div>
        ))
      )}

      {unpriced.map((client) => {
        const draft = draftFor(client.id);
        return (
          <div className="lrow priceset" key={client.id}>
            <div className="av">{client.avatarSeed ?? client.name.slice(0, 2).toUpperCase()}</div>
            <div className="lmeta">
              <b>{client.name}</b>
              <span>No price set yet</span>
            </div>
            <div className="pricein">
              <span>$</span>
              <input
                className="field-in"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={draft.dollars}
                onChange={(e) => setDraft(client.id, { dollars: e.target.value })}
              />
            </div>
            <div className="modepick">
              <button
                className={draft.mode === "calendar" ? "on" : ""}
                onClick={() => setDraft(client.id, { mode: "calendar" })}
              >
                Monthly
              </button>
              <button
                className={draft.mode === "on_fulfilment" ? "on" : ""}
                onClick={() => setDraft(client.id, { mode: "on_fulfilment" })}
              >
                When delivered
              </button>
            </div>
            <button
              className="btn"
              disabled={draft.dollars === ""}
              onClick={() => void savePrice(client)}
            >
              Save
            </button>
          </div>
        );
      })}
    </div>
  );
}
