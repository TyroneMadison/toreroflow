import { useEffect, useState } from "react";
import { api, type ClientQuota, type QuotaSection, type VideoFormat } from "../lib/api";

const FORMAT_LABEL: Record<VideoFormat, string> = {
  short_form: "Short-form",
  long_form: "Long-form",
};

/**
 * Videos delivered against this pay period's targets, split by format.
 *
 * The counts come from uploads (revisions excluded), so they follow the work
 * automatically; the per-format adjustment and the shared reset are there
 * for when reality disagrees.
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
  const [editing, setEditing] = useState<VideoFormat | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<VideoFormat | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<ClientQuota>(`/clients/${clientId}/quota`)
      .then(setQuota)
      .catch(() => setQuota(null));
  }, [clientId, reloadKey]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      setQuota(await api.patch<ClientQuota>(`/clients/${clientId}/quota`, body));
    } finally {
      setBusy(false);
    }
  };

  if (!quota) return null;

  const tracked: VideoFormat[] = (["short_form", "long_form"] as VideoFormat[]).filter(
    (f) => (f === "short_form" ? quota.short : quota.long).target != null,
  );
  const untracked = (["short_form", "long_form"] as VideoFormat[]).filter(
    (f) => !tracked.includes(f),
  );

  const sectionFor = (f: VideoFormat): QuotaSection =>
    f === "short_form" ? quota.short : quota.long;

  const setTarget = (f: VideoFormat, value: number | null) =>
    void patch({ format: f, target: value }).then(() => {
      setEditing(null);
      setDraft("");
    });

  const renderTracked = (f: VideoFormat) => {
    const s = sectionFor(f);
    const target = s.target ?? 0;
    const pct = target > 0 ? Math.min(100, (s.delivered / target) * 100) : 0;
    const remaining = Math.max(0, target - s.delivered);
    const over = s.delivered > target;

    return (
      <div className="qsec" key={f}>
        <div className="qsechead">
          <b>{FORMAT_LABEL[f]}</b>
          <span
            className="link"
            title="Change the target"
            onClick={() => {
              setDraft(String(target));
              setEditing(f);
            }}
          >
            {s.delivered} / {target}
          </span>
          <span
            className={`qdel${confirmDelete === f ? " armed" : ""}`}
            title={
              confirmDelete === f
                ? "Click again to remove this counter"
                : `Remove the ${FORMAT_LABEL[f].toLowerCase()} counter`
            }
            onClick={() => {
              if (confirmDelete === f) {
                setConfirmDelete(null);
                setTarget(f, null);
              } else {
                setConfirmDelete(f);
                setTimeout(() => setConfirmDelete((c) => (c === f ? null : c)), 4000);
              }
            }}
          >
            {confirmDelete === f ? (
              "remove?"
            ) : (
              <svg>
                <use href="#i-x" />
              </svg>
            )}
          </span>
        </div>

        {editing === f ? (
          <div className="qsetrow">
            <input
              className="field-in"
              type="number"
              min={0}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft !== "") setTarget(f, Number(draft));
                if (e.key === "Escape") setEditing(null);
              }}
            />
            <button className="btn" disabled={busy || draft === ""} onClick={() => setTarget(f, Number(draft))}>
              Set
            </button>
            <button className="btn ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div className="qbar">
              <div className={`fill${over ? " over" : ""}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="qsecfoot">
              <div className="qadjust">
                <div
                  className={`iconbtn${s.delivered === 0 ? " off" : ""}`}
                  title={s.delivered === 0 ? "Already at zero" : "Count one fewer"}
                  onClick={() => {
                    if (s.delivered > 0) void patch({ format: f, adjustBy: -1 });
                  }}
                >
                  <span>-</span>
                </div>
                <div className="iconbtn" title="Count one more" onClick={() => void patch({ format: f, adjustBy: 1 })}>
                  <span>+</span>
                </div>
                {s.adjustment !== 0 && (
                  <span className="qadj">
                    {s.adjustment > 0 ? "+" : ""}
                    {s.adjustment} manual
                  </span>
                )}
              </div>
              <span className={over ? "qover" : "qleft"}>
                {over ? `${s.delivered - target} over` : `${remaining} to go`}
              </span>
            </div>
            {s.revisions > 0 && (
              <div className="qrev">
                {s.revisions} revision{s.revisions === 1 ? "" : "s"} not counted
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="card glass quotacard">
      <div className="rowhead">
        <div>
          <h3>Videos this period</h3>
          <div className="sub">
            {tracked.length === 0
              ? `Set targets for ${clientName}`
              : quota.periodStart
                ? `Since ${new Date(quota.periodStart).toLocaleDateString([], { month: "short", day: "numeric" })}`
                : "All uploads so far"}
          </div>
        </div>
        {tracked.length > 0 && (
          <span
            className={`link${confirmReset ? " danger" : ""}`}
            onClick={() => {
              if (confirmReset) void patch({ reset: true }).then(() => setConfirmReset(false));
              else {
                setConfirmReset(true);
                setTimeout(() => setConfirmReset(false), 4000);
              }
            }}
          >
            {confirmReset ? "Reset both?" : "New period"}
          </span>
        )}
      </div>

      {tracked.map(renderTracked)}

      {untracked.length > 0 && (
        <div className="qadd">
          {untracked.map((f) =>
            editing === f ? (
              <div className="qsetrow" key={f}>
                <input
                  className="field-in"
                  type="number"
                  min={0}
                  placeholder={`${FORMAT_LABEL[f]} target`}
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && draft !== "") setTarget(f, Number(draft));
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
                <button className="btn" disabled={busy || draft === ""} onClick={() => setTarget(f, Number(draft))}>
                  Set
                </button>
              </div>
            ) : (
              <span
                className="link"
                key={f}
                onClick={() => {
                  setDraft("");
                  setEditing(f);
                }}
              >
                + {FORMAT_LABEL[f]} target
              </span>
            ),
          )}
        </div>
      )}

      {quota.unclassified > 0 && (
        <div className="qrev">
          {quota.unclassified} still processing, counted as short-form for now
        </div>
      )}
    </div>
  );
}
