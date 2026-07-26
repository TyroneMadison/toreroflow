import { useCallback, useEffect, useState } from "react";
import { useToast } from "../components/Toasts";
import {
  api,
  fileUrl,
  type ClientPublishState,
  type ClientReport,
  type PublishResult,
  type ReportPublishing,
} from "../lib/api";
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

/** "2026-06" as "June 2026", for describing what a live page currently shows. */
function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/**
 * The link row under a client: its permanent report URL, copyable.
 *
 * Shown before the first publish too, greyed out, so the operator can see
 * exactly what link they are about to create rather than finding out after.
 */
function ReportLink({
  state,
  siteUnknown,
  onCopied,
}: {
  state: ClientPublishState;
  siteUnknown: boolean;
  onCopied(): void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  // Before the first publish the site's own domain is not known here, so the
  // path is shown on its own rather than inventing a hostname.
  const shown = state.url ?? (state.slug ? `/${state.slug}` : null);
  if (!shown) return null;
  const live = state.url !== null;

  const copy = async () => {
    if (!state.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
    } catch {
      onCopied();
    }
  };

  return (
    <>
      <div className="replink">
        <span className={`rlurl${live ? "" : " pending"}`} title={shown}>
          {shown}
        </span>
        <button
          className={`rlcopy${copied ? " done" : ""}`}
          disabled={!live}
          title={
            live
              ? "Copy the link to send to the client"
              : siteUnknown
                ? "Publish once to create this page"
                : "Not published yet"
          }
          onClick={() => void copy()}
        >
          <svg>
            <use href={copied ? "#i-check" : "#i-copy"} />
          </svg>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {live && state.publishedMonth && (
        <div className="repwhen">
          Showing {monthLabel(state.publishedMonth)}
          {state.publishedAt
            ? `, published ${new Date(state.publishedAt).toLocaleDateString([], {
                month: "short",
                day: "numeric",
              })}`
            : ""}
          . Refreshes on its own when a month ends.
        </div>
      )}
    </>
  );
}

export default function ReportsScreen({ onSeen }: { onSeen(): void }) {
  const { clients, selectedClient } = useAppState();
  const toast = useToast();
  const [reports, setReports] = useState<ClientReport[]>([]);
  const [canRender, setCanRender] = useState<boolean | null>(null);
  const [publishing, setPublishing] = useState<ReportPublishing | null>(null);
  const [month, setMonth] = useState(lastMonthValue);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReports(await api.get<ClientReport[]>("/reports"));
    } catch (err) {
      setReports([]);
      toast.fail("Could not load reports", err);
    }
  }, [toast]);

  const loadPublishing = useCallback(async () => {
    try {
      setPublishing(await api.get<ReportPublishing>("/reports/publishing"));
    } catch {
      // Publishing state is secondary: the screen still builds PDFs without
      // it, so this stays quiet rather than adding a second alarm.
      setPublishing(null);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPublishing();
    api
      .get<{ canRender: boolean }>("/reports/capability")
      .then((c) => setCanRender(c.canRender))
      .catch(() => setCanRender(false));
  }, [load, loadPublishing]);

  // `forMonth` is passed explicitly by Rebuild: setMonth does not apply until
  // the next render, so reading state here would rebuild the wrong month.
  const generate = async (clientId: string, name: string, forMonth = month) => {
    setBusy(clientId);
    try {
      await api.post(`/clients/${clientId}/reports?month=${forMonth}`, {});
      await load();
      toast.success(`Report built for ${name}.`);
    } catch (err) {
      toast.fail(`Could not build the report for ${name}`, err);
    } finally {
      setBusy(null);
    }
  };

  const publish = async (clientId: string, name: string) => {
    setBusy(clientId);
    try {
      const res = await api.post<PublishResult>(
        `/clients/${clientId}/reports/publish?month=${month}`,
        {},
      );
      await loadPublishing();
      toast.success(`${name} published at ${res.url}`);
    } catch (err) {
      toast.fail(`Could not publish the report for ${name}`, err);
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
  const publishState = new Map(publishing?.clients.map((c) => [c.id, c]) ?? []);
  const canPublish = publishing?.configured === true;

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
                Pick the month, then build it for whichever brand you need. Publishing
                puts the same numbers on a permanent link you can send the client.
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
                const state = publishState.get(c.id);
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
                      className="btn ghost"
                      disabled={busy !== null || canRender === false}
                      onClick={() => void generate(c.id, c.name)}
                    >
                      {busy === c.id ? "Working…" : "Build PDF"}
                    </button>
                    <button
                      className="btn pub"
                      disabled={busy !== null || !canPublish}
                      title={
                        canPublish
                          ? state?.url
                            ? "Rebuild the page at the same link"
                            : "Create the client's permanent report page"
                          : (publishing?.reason ?? "Publishing is not configured")
                      }
                      onClick={() => void publish(c.id, c.name)}
                    >
                      <svg>
                        <use href="#i-globe" />
                      </svg>{" "}
                      {state?.url ? "Republish" : "Publish"}
                    </button>
                    {state && (
                      <ReportLink
                        state={state}
                        siteUnknown={!canPublish}
                        onCopied={() =>
                          toast.error(
                            "Could not reach the clipboard. Select the link and copy it manually.",
                          )
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {publishing && !publishing.configured && (
            <div className="btnote" style={{ marginTop: 12 }}>
              Publishing is off. {publishing.reason}
            </div>
          )}

          {target && (
            <div className="btnote" style={{ marginTop: 12 }}>
              Watch time is estimated from views, and follower change is left out until
              there is a full month of history to compare against. A published page
              carries the last three months and stays at the same link for good.
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
                      void generate(r.clientId, r.clientName ?? "this brand", m);
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
