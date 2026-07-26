import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/Toasts";
import {
  api,
  type ClientPublishState,
  type PublishResult,
  type RefreshResult,
  type ReportPublishing,
} from "../lib/api";
import { clientAvatarUrl } from "../lib/avatar";
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
  onCopyFailed,
}: {
  state: ClientPublishState;
  siteUnknown: boolean;
  onCopyFailed(): void;
}) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);

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

  /**
   * The clipboard API is not guaranteed: a webview can refuse it outright,
   * and it needs a secure context. So the link lives in a real input that can
   * be selected, and a failed copy selects the text and says so rather than
   * telling the operator to do something the markup made impossible.
   */
  const copy = async () => {
    if (!state.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
    } catch {
      field.current?.focus();
      field.current?.select();
      onCopyFailed();
    }
  };

  return (
    <>
      <div className="replink">
        <input
          ref={field}
          className={`rlurl${live ? "" : " pending"}`}
          value={shown}
          readOnly
          title={shown}
          aria-label="Report link"
          onFocus={(e) => e.currentTarget.select()}
        />
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
          Live page shows {monthLabel(state.publishedMonth)}
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
  const { clients } = useAppState();
  const toast = useToast();
  const [publishing, setPublishing] = useState<ReportPublishing | null>(null);
  const [month, setMonth] = useState(lastMonthValue);
  const [busy, setBusy] = useState<string | null>(null);
  /** Clients updated this session, so Publish can say the numbers are fresh. */
  const [updated, setUpdated] = useState<Record<string, string>>({});

  const loadPublishing = useCallback(async () => {
    try {
      setPublishing(await api.get<ReportPublishing>("/reports/publishing"));
    } catch (err) {
      setPublishing(null);
      toast.fail("Could not load the report links", err);
    }
  }, [toast]);

  useEffect(() => {
    void loadPublishing();
  }, [loadPublishing]);

  /**
   * The bell points here, so arriving is the acknowledgement. Without this
   * the badge would have nothing left to clear it.
   */
  useEffect(() => {
    void api
      .post("/reports/seen", {})
      .then(() => onSeen())
      .catch(() => {
        // Nothing was waiting, or the API is down; the badge clears on the
        // next poll either way.
      });
  }, [onSeen]);

  /** Pull fresh numbers and rebuild the page, without publishing it. */
  const update = async (clientId: string, name: string) => {
    setBusy(clientId);
    try {
      const res = await api.post<RefreshResult>(
        `/clients/${clientId}/reports/refresh?month=${month}`,
        {},
      );
      setUpdated((u) => ({ ...u, [clientId]: month }));
      toast.success(
        res.followersRefreshed
          ? `${name} updated with the latest numbers.`
          : `${name} updated. Follower counts may lag a cycle, the worker did not answer.`,
      );
    } catch (err) {
      toast.fail(`Could not update the report for ${name}`, err);
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
      toast.success(`${name} is live at ${res.url}`);
    } catch (err) {
      toast.fail(`Could not publish the report for ${name}`, err);
    } finally {
      setBusy(null);
    }
  };

  const months = monthOptions();
  const publishState = new Map(publishing?.clients.map((c) => [c.id, c]) ?? []);
  const canPublish = publishing?.configured === true;

  return (
    <section className="screen active" data-screen="reports">
      <div className="topbar">
        <div className="h">
          <h2>Reports</h2>
          <p>
            Update a brand's report to pull its latest numbers, then publish it to send the
            client their link. Published pages refresh on their own when a month ends.
          </p>
        </div>
      </div>
      <div className="stage">
        <div className="card glass">
          <div className="rowhead">
            <div>
              <h3>Client reports</h3>
              <div className="sub">
                Update pulls fresh views, engagement and followers. Publishing is what the
                client actually sees.
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
                const working = busy === c.id;
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
                      disabled={busy !== null}
                      title="Pull the latest numbers and rebuild this report"
                      onClick={() => void update(c.id, c.name)}
                    >
                      <svg>
                        <use href="#i-refresh" />
                      </svg>{" "}
                      {working ? "Working…" : "Update report"}
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
                        onCopyFailed={() =>
                          toast.error(
                            "Could not reach the clipboard. The link is selected, press Ctrl+C to copy it.",
                          )
                        }
                      />
                    )}
                    {updated[c.id] === month && (
                      <div className="repwhen">
                        Updated for {monthLabel(month)}. Publish to put it in front of the
                        client.
                      </div>
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

          <div className="btnote" style={{ marginTop: 12 }}>
            Watch time is estimated from views, and follower change is left out until there
            is a full month of history to compare against. A published page carries the last
            three months and stays at the same link for good.
          </div>
        </div>
      </div>
    </section>
  );
}
