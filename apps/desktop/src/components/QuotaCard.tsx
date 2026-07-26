import { useEffect, useState } from "react";
import { api, type ClientQuota } from "../lib/api";

/**
 * Videos delivered against this pay period's target. The count comes from
 * uploads (revisions excluded), so it follows the work automatically; the
 * adjustment and reset are there for when reality disagrees.
 */
export default function QuotaCard({
  clientId,
  clientName,
  reloadKey,
}: {
  clientId: string;
  clientName: string;
  reloadKey: number;
}) {
  const [quota, setQuota] = useState<ClientQuota | null>(null);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .get<ClientQuota>(`/clients/${clientId}/quota`)
      .then(setQuota)
      .catch(() => setQuota(null));
  };

  useEffect(load, [clientId, reloadKey]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      setQuota(await api.patch<ClientQuota>(`/clients/${clientId}/quota`, body));
    } finally {
      setBusy(false);
    }
  };

  if (!quota) return null;

  const target = quota.target;
  const pct = target && target > 0 ? Math.min(100, (quota.delivered / target) * 100) : 0;
  const remaining = target != null ? Math.max(0, target - quota.delivered) : null;
  const over = target != null && quota.delivered > target;

  return (
    <div className="card glass quotacard">
      <div className="rowhead">
        <div>
          <h3>Videos this period</h3>
          <div className="sub">
            {target == null
              ? `Set a target for ${clientName}`
              : quota.periodStart
                ? `Since ${new Date(quota.periodStart).toLocaleDateString([], { month: "short", day: "numeric" })}`
                : "All uploads so far"}
          </div>
        </div>
        {target != null && !editingTarget && (
          <span
            className="link"
            onClick={() => {
              setTargetDraft(String(target));
              setEditingTarget(true);
            }}
          >
            Edit target
          </span>
        )}
      </div>

      {target == null || editingTarget ? (
        <div className="qsetrow">
          <input
            className="field-in"
            type="number"
            min={0}
            placeholder="e.g. 30"
            value={targetDraft}
            autoFocus
            onChange={(e) => setTargetDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && targetDraft !== "") {
                void patch({ target: Number(targetDraft) }).then(() => setEditingTarget(false));
              }
              if (e.key === "Escape") setEditingTarget(false);
            }}
          />
          <button
            className="btn"
            disabled={busy || targetDraft === ""}
            onClick={() =>
              void patch({ target: Number(targetDraft) }).then(() => setEditingTarget(false))
            }
          >
            Set
          </button>
          {target != null && (
            <button className="btn ghost" onClick={() => setEditingTarget(false)}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="qcount">
            <b className={over ? "over" : undefined}>{quota.delivered}</b>
            <span>of {target}</span>
            {remaining != null && remaining > 0 && (
              <em>{remaining} to go</em>
            )}
            {over && <em className="over">{quota.delivered - target} over</em>}
          </div>

          <div className="qbar">
            <div className={`fill${over ? " over" : ""}`} style={{ width: `${pct}%` }} />
          </div>

          <div className="qfoot">
            <div className="qadjust">
              <div
                className="iconbtn"
                title="Count one fewer"
                onClick={() => void patch({ adjustBy: -1 })}
              >
                <span>-</span>
              </div>
              <div
                className="iconbtn"
                title="Count one more"
                onClick={() => void patch({ adjustBy: 1 })}
              >
                <span>+</span>
              </div>
              {quota.adjustment !== 0 && (
                <span className="qadj">
                  {quota.adjustment > 0 ? "+" : ""}
                  {quota.adjustment} manual
                </span>
              )}
            </div>
            <span
              className={`link${confirmReset ? " danger" : ""}`}
              onClick={() => {
                if (confirmReset) {
                  void patch({ reset: true }).then(() => setConfirmReset(false));
                } else {
                  setConfirmReset(true);
                  setTimeout(() => setConfirmReset(false), 4000);
                }
              }}
            >
              {confirmReset ? "Reset for sure?" : "New period"}
            </span>
          </div>

          {quota.revisions > 0 && (
            <div className="qrev">
              {quota.revisions} revision{quota.revisions === 1 ? "" : "s"} not counted
            </div>
          )}
        </>
      )}
    </div>
  );
}
