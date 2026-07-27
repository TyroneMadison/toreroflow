import { formatCents } from "@toreroflow/core";
import { useToast } from "../Toasts";
import { api } from "../../lib/api";
import { colorFor, type RevenueRow } from "../../lib/financials";
import ColorPicker from "./ColorPicker";

const STATUS_LABEL: Record<RevenueRow["status"], string> = {
  paid: "Paid",
  pending: "Not due",
  due: "Due",
};

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
  onChanged,
}: {
  rows: RevenueRow[];
  totalCents: number;
  onChanged(): void;
}) {
  const toast = useToast();

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

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>Money coming in</h3>
          <div className="sub">Click the tag to mark a month paid.</div>
        </div>
        <div className="amt i">{formatCents(totalCents)}</div>
      </div>

      {rows.length === 0 ? (
        <div className="btnote" style={{ marginTop: 10 }}>
          No client has a monthly price yet. Set one on a brand to start tracking revenue.
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
            <div className="amt i">{formatCents(row.amountCents)}</div>
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
          </div>
        ))
      )}
    </div>
  );
}
