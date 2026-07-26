import { useCallback, useEffect, useState } from "react";
import { api, fileUrl, type ClientReport } from "../lib/api";
import { clientAvatarUrl } from "../lib/avatar";
import { openExternal } from "../lib/external";
import { useAppState } from "../state/AppState";

/** The month that just ended, which is what a monthly report covers. */
function lastMonthValue(): string {
  const d = new Date();
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
}

function monthOptions(count = 12): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const now = new Date();
  for (let i = 1; i <= count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    });
  }
  return out;
}

export default function ReportsScreen({ onSeen }: { onSeen(): void }) {
  const { clients, selectedClient } = useAppState();
  const [reports, setReports] = useState<ClientReport[]>([]);
  const [canRender, setCanRender] = useState<boolean | null>(null);
  const [month, setMonth] = useState(lastMonthValue);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReports(await api.get<ClientReport[]>("/reports"));
    } catch {
      setReports([]);
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .get<{ canRender: boolean }>("/reports/capability")
      .then((c) => setCanRender(c.canRender))
      .catch(() => setCanRender(false));
  }, [load]);

  const generate = async (clientId: string) => {
    setBusy(clientId);
    setError(null);
    try {
      await api.post(`/clients/${clientId}/reports?month=${month}`, {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not build the report");
    } finally {
      setBusy(null);
    }
  };

  /** Opening a report is what marks it read, so the bell clears itself. */
  const open = async (report: ClientReport) => {
    const url = fileUrl(report.url);
    if (url) await openExternal(url);
    if (!report.seen) {
      try {
        await api.post(`/reports/${report.id}/seen`, {});
        await load();
        onSeen();
      } catch {
        // the PDF still opened; the badge just clears on the next poll
      }
    }
  };

  const target = selectedClient ?? clients[0] ?? null;
  const months = monthOptions();

  return (
    <section className="screen active" data-screen="reports">
      <div className="topbar">
        <div className="h">
          <h2>Reports</h2>
          <p>
            Monthly client reports. One is built automatically once a month ends, and you
            can rebuild any month here.
          </p>
        </div>
      </div>
      <div className="stage">
        {canRender === false && (
          <div className="card glass" style={{ marginBottom: 16 }}>
            <div className="autherr" style={{ marginTop: 0 }}>
              No Chrome or Edge was found on this machine, so PDFs cannot be rendered.
              Install either one, or set CHROME_PATH in .env.
            </div>
          </div>
        )}

        <div className="card glass">
          <div className="rowhead">
            <div>
              <h3>Build a report</h3>
              <div className="sub">
                Pick the month, then build it for whichever brand you need.
              </div>
            </div>
            <select
              className="field-in repmonth"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            >
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {clients.length === 0 ? (
            <div className="empty">
              <div className="eic">
                <svg>
                  <use href="#i-users" />
                </svg>
              </div>
              <b>No brands enrolled</b>
              <p>Enroll a client and their reports will build from real numbers.</p>
            </div>
          ) : (
            <div className="repbuild">
              {clients.map((c) => {
                const avatar = clientAvatarUrl(c);
                return (
                  <div className="repclient" key={c.id}>
                    <div className="avatar" style={{ width: 32, height: 32, borderRadius: 10, overflow: "hidden", background: avatar ? "var(--glass-2)" : "linear-gradient(135deg,#8b7bff,#4ea8ff)" }}>
                      {avatar ? (
                        <img src={avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      ) : (
                        (c.avatarSeed ?? c.name.slice(0, 2).toUpperCase())
                      )}
                    </div>
                    <b>{c.name}</b>
                    <button
                      className="btn"
                      disabled={busy !== null || canRender === false}
                      onClick={() => void generate(c.id)}
                    >
                      {busy === c.id ? "Building…" : "Build"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {error && <div className="autherr">{error}</div>}
          {target && (
            <div className="btnote" style={{ marginTop: 12 }}>
              Watch time is estimated from views, and follower change is left out until
              there is a full month of history to compare against.
            </div>
          )}
        </div>

        <div className="card glass" style={{ marginTop: 16 }}>
          <div className="rowhead">
            <div>
              <h3>Generated reports</h3>
              <div className="sub">Newest first. Opening one marks it read.</div>
            </div>
          </div>
          {reports.length === 0 ? (
            <div className="empty">
              <div className="eic">
                <svg>
                  <use href="#i-dl" />
                </svg>
              </div>
              <b>Nothing built yet</b>
              <p>Build one above, or wait for the month to end and it appears here.</p>
            </div>
          ) : (
            <div className="replist">
              {reports.map((r) => (
                <div className={`reprow${r.seen ? "" : " unseen"}`} key={r.id}>
                  <div className="repmeta">
                    <b>
                      {r.label}
                      {!r.seen && <span className="repnew">new</span>}
                    </b>
                    <span>
                      {r.clientName ?? ""} · built{" "}
                      {new Date(r.generatedAt).toLocaleDateString([], {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                  <button className="btn ghost" onClick={() => void open(r)}>
                    <svg>
                      <use href="#i-dl" />
                    </svg>{" "}
                    Open PDF
                  </button>
                  <button
                    className="btn ghost"
                    disabled={busy !== null}
                    title="Rebuild from the latest numbers"
                    onClick={() => {
                      const m = `${new Date(r.periodStart).getFullYear()}-${String(new Date(r.periodStart).getMonth() + 1).padStart(2, "0")}`;
                      setMonth(m);
                      void generate(r.clientId);
                    }}
                  >
                    Rebuild
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
