import { useCallback, useEffect, useRef, useState } from "react";
import Select from "../components/Select";
import Story from "../components/glass/Story";
import { useToast } from "../components/Toasts";
import { Empty, ErrorState, Loading } from "../components/states";
import {
  api,
  type ClientPublishState,
  type PublishResult,
  type RefreshResult,
  type ReportPublishing,
  type SystemAlert,
} from "../lib/api";
import { clientAvatarUrl } from "../lib/avatar";
import { useIsPhone } from "../lib/phone";
import { useAppState } from "../state/AppState";
import BrandAvatar from "../components/BrandAvatar";
import ConfirmSheet from "../components/mobile/ConfirmSheet";
import { Ic, PhoneHead, PickSheet, Sheet, shareLink } from "../components/analytics/phoneBits";
import type { ClientSummary } from "../lib/api";

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

/**
 * What broke while nobody was watching.
 *
 * Sits above the controls rather than below them: the operator's next action
 * is usually to publish, and publishing on top of a failure they have not
 * seen is exactly the mistake this exists to prevent.
 */
function AlertBanner({
  alerts,
  onDismiss,
}: {
  alerts: SystemAlert[];
  onDismiss(id: string): void;
}) {
  const open = alerts.filter((a) => !a.dismissed);
  if (!open.length) return null;
  return (
    <div className="alertwrap">
      {open.map((a) => (
        <div className={`alertrow ${a.severity}`} key={a.id}>
          <span className="adot" />
          <div className="atext">
            <b>{a.message}</b>
            {a.count > 1 && (
              <span className="ameta">
                Happened {a.count} times, most recently{" "}
                {new Date(a.lastSeenAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
                .
              </span>
            )}
            {a.detail && <span className="adetail">{a.detail}</span>}
          </div>
          <button className="btn ghost" onClick={() => onDismiss(a.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

export default function ReportsScreen({
  onSeen,
  alerts,
  onAlertsChanged,
}: {
  onSeen(): void;
  alerts: SystemAlert[];
  onAlertsChanged(): void;
}) {
  const { clients } = useAppState();
  const toast = useToast();
  const isPhone = useIsPhone();
  const [publishing, setPublishing] = useState<ReportPublishing | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [month, setMonth] = useState(lastMonthValue);
  const [busy, setBusy] = useState<string | null>(null);
  /** Clients updated this session, so Publish can say the numbers are fresh. */
  const [updated, setUpdated] = useState<Record<string, string>>({});

  const loadPublishing = useCallback(async () => {
    try {
      setPublishing(await api.get<ReportPublishing>("/reports/publishing"));
      setLoadFailed(false);
    } catch (err) {
      setPublishing(null);
      setLoadFailed(true);
      toast.fail("Could not load the report links", err);
    }
  }, [toast]);

  // A new client gets its permanent report slug at create; re-reading when
  // the client list changes makes the link visible without a remount.
  useEffect(() => {
    void loadPublishing();
  }, [loadPublishing, clients]);

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

  /** Which bulk run is going and how far along, for the buttons' progress. */
  const [allRun, setAllRun] = useState<{ kind: "update" | "publish"; step: number } | null>(null);

  /**
   * Every brand, one at a time. Sequential on purpose: each refresh asks the
   * worker for follower counts and each publish is a site deploy, and firing
   * them together is how both stop answering. One summary at the end instead
   * of a toast per brand.
   */
  const runAll = async (kind: "update" | "publish") => {
    const failed: string[] = [];
    let lagging = 0;
    let baseWarning: string | null = null;
    for (const [i, c] of clients.entries()) {
      setAllRun({ kind, step: i + 1 });
      setBusy(c.id);
      try {
        if (kind === "update") {
          const res = await api.post<RefreshResult>(
            `/clients/${c.id}/reports/refresh?month=${month}`,
            {},
          );
          setUpdated((u) => ({ ...u, [c.id]: month }));
          if (!res.followersRefreshed) lagging += 1;
        } else {
          const res = await api.post<PublishResult>(
            `/clients/${c.id}/reports/publish?month=${month}`,
            {},
          );
          baseWarning ??= res.publicBaseWarning ?? null;
        }
      } catch {
        failed.push(c.name);
      }
    }
    setBusy(null);
    setAllRun(null);
    if (kind === "publish") await loadPublishing();
    const done = clients.length - failed.length;
    const verb = kind === "update" ? "updated" : "published";
    if (failed.length) {
      toast.fail(
        `${done} of ${clients.length} reports ${verb}`,
        new Error(`Could not finish: ${failed.join(", ")}. Try those on their own.`),
      );
    } else {
      toast.success(
        `All ${done} reports ${verb} for ${monthLabel(month)}.` +
          (lagging ? ` Follower counts may lag a cycle on ${lagging}.` : ""),
      );
    }
    if (baseWarning) toast.error(baseWarning);
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
      // The link is always correct, but it may not be the pretty one yet.
      // Said out loud so the fallback is a decision, not a surprise.
      if (res.publicBaseWarning) toast.error(res.publicBaseWarning);
    } catch (err) {
      toast.fail(`Could not publish the report for ${name}`, err);
    } finally {
      setBusy(null);
    }
  };

  const months = monthOptions();
  const publishState = new Map(publishing?.clients.map((c) => [c.id, c]) ?? []);
  const canPublish = publishing?.configured === true;
  const state =
    clients.length === 0 ? "empty" : loadFailed ? "error" : publishing === null ? "loading" : "ready";
  const dismiss = (id: string) => {
    void api
      .post(`/alerts/${id}/dismiss`, {})
      .then(onAlertsChanged)
      .catch((err) => toast.fail("Could not dismiss that", err));
  };

  if (isPhone) {
    return (
      <ReportsPhone
        state={state}
        clients={clients}
        publishing={publishing}
        publishState={publishState}
        canPublish={canPublish}
        month={month}
        setMonth={setMonth}
        months={months}
        busy={busy}
        updated={updated}
        allRun={allRun}
        update={(id, name) => void update(id, name)}
        publish={(id, name) => void publish(id, name)}
        runAll={(kind) => void runAll(kind)}
        alerts={alerts}
        onDismiss={dismiss}
        onRetry={() => {
          setLoadFailed(false);
          void loadPublishing();
        }}
        toast={toast}
      />
    );
  }

  return (
    <section className="screen active" data-screen="reports" data-state={state}>
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
        <div className="gx-toolbar">
          <Select
            className="repmonth"
            value={month}
            onChange={setMonth}
            aria-label="Month"
            options={months.map((m) => ({ value: m.value, label: m.label }))}
          />
          {clients.length > 1 && (
            <>
              <button
                type="button"
                className="tf-btn"
                disabled={busy !== null}
                title={`Pull the latest numbers for every brand's ${monthLabel(month)} report, one after another`}
                onClick={() => void runAll("update")}
                data-testid="reports.update-all"
              >
                {allRun?.kind === "update" ? `Updating ${allRun.step} of ${clients.length}…` : "Update all"}
              </button>
              <button
                type="button"
                className="tf-btn pri"
                disabled={busy !== null || !canPublish}
                title={
                  canPublish
                    ? `Rebuild every brand's live page with its ${monthLabel(month)} report, at the same links`
                    : (publishing?.reason ?? "Publishing is not configured")
                }
                onClick={() => void runAll("publish")}
                data-testid="reports.publish-all"
              >
                {allRun?.kind === "publish" ? `Publishing ${allRun.step} of ${clients.length}…` : "Republish all"}
              </button>
            </>
          )}
        </div>

        {state === "empty" ? (
          <Empty
            screen="reports"
            title="No brands enrolled"
            hint="Enroll a client and their reports will build from real numbers."
          />
        ) : state === "error" ? (
          <ErrorState
            screen="reports"
            message="Could not load the report links."
            onRetry={() => {
              setLoadFailed(false);
              void loadPublishing();
            }}
          />
        ) : state === "loading" ? (
          <Loading screen="reports" label="Loading the report links" />
        ) : (
          <div className="gx-cols gx-cols-rep">
            {clients.map((c) => {
              const avatar = clientAvatarUrl(c);
              const ps = publishState.get(c.id);
              const working = busy === c.id;
              const live = ps?.url != null;
              const current = live && ps?.publishedMonth === month;
              const shows = ps?.publishedMonth
                ? new Date(Number(ps.publishedMonth.slice(0, 4)), Number(ps.publishedMonth.slice(5)) - 1, 1).toLocaleDateString("en-US", { month: "short" })
                : "None";
              return (
                <Story
                  key={c.id}
                  testId={`reports.client-${c.id}`}
                  icon={
                    <div className="gx-av">
                      {avatar ? <img src={avatar} alt="" /> : <span>{c.avatarSeed ?? c.name.slice(0, 1).toUpperCase()}</span>}
                    </div>
                  }
                  title={c.name}
                  sub={updated[c.id] === month ? `Updated for ${monthLabel(month)}, publish to send` : monthLabel(month)}
                  badge={!live ? "Not published" : current ? "Published" : "Out of date"}
                  badgeTone={!live ? "warn" : current ? "ok" : "bad"}
                  bigLabel="Live page shows"
                  big={shows}
                  bigTone={current ? "ok" : undefined}
                  foot={
                    ps?.publishedAt
                      ? `published ${new Date(ps.publishedAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
                      : undefined
                  }
                  actions={
                    <div className="gx-repfoot">
                      {ps && (
                        <ReportLink
                          state={ps}
                          siteUnknown={!canPublish}
                          onCopyFailed={() =>
                            toast.error("Could not reach the clipboard. The link is selected, press Ctrl+C to copy it.")
                          }
                        />
                      )}
                      <div className="gx-repbtns">
                        <button
                          type="button"
                          className="tf-btn"
                          disabled={busy !== null}
                          title="Pull the latest numbers and rebuild this report"
                          onClick={() => void update(c.id, c.name)}
                          data-testid={`reports.update-${c.id}`}
                        >
                          {working ? "Working…" : "Update report"}
                        </button>
                        <button
                          type="button"
                          className="tf-btn pri grow"
                          disabled={busy !== null || !canPublish}
                          title={
                            canPublish
                              ? ps?.url
                                ? "Rebuild the page at the same link"
                                : "Create the client's permanent report page"
                              : (publishing?.reason ?? "Publishing is not configured")
                          }
                          onClick={() => void publish(c.id, c.name)}
                          data-testid={`reports.publish-${c.id}`}
                        >
                          {ps?.url ? "Republish" : "Publish"}
                        </button>
                      </div>
                    </div>
                  }
                />
              );
            })}
            <aside className="gx-side glass-z1" data-testid="reports.alerts">
              <div className="tf-lbl">Alerts</div>
              <AlertBanner
                alerts={alerts}
                onDismiss={(id) => {
                  void api
                    .post(`/alerts/${id}/dismiss`, {})
                    .then(onAlertsChanged)
                    .catch((err) => toast.fail("Could not dismiss that", err));
                }}
              />
              {!alerts.some((x) => !x.dismissed) && <div className="gx-note">Nothing failing.</div>}
              <div className="gx-fill" />
              {publishing && !publishing.configured && (
                <div className="gx-note warn">Publishing is off. {publishing.reason}</div>
              )}
              <div className="gx-note">
                Published pages refresh on their own when a month ends, carry the last 3 months, and keep the same link for good.
              </div>
            </aside>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Reports on the phone (mobile pass, mockup "reports"): a month switcher with
 * arrows, Update all and Republish all behind a more button that asks first,
 * alerts on top as one line, and one compact card per brand with its status,
 * the report link with Copy and Share, and the two actions. Same state and
 * calls as the desktop screen.
 */
function ReportsPhone({
  state,
  clients,
  publishing,
  publishState,
  canPublish,
  month,
  setMonth,
  months,
  busy,
  updated,
  allRun,
  update,
  publish,
  runAll,
  alerts,
  onDismiss,
  onRetry,
  toast,
}: {
  state: "empty" | "error" | "loading" | "ready";
  clients: ClientSummary[];
  publishing: ReportPublishing | null;
  publishState: Map<string, ClientPublishState>;
  canPublish: boolean;
  month: string;
  setMonth(m: string): void;
  months: Array<{ value: string; label: string }>;
  busy: string | null;
  updated: Record<string, string>;
  allRun: { kind: "update" | "publish"; step: number } | null;
  update(id: string, name: string): void;
  publish(id: string, name: string): void;
  runAll(kind: "update" | "publish"): void;
  alerts: SystemAlert[];
  onDismiss(id: string): void;
  onRetry(): void;
  toast: ReturnType<typeof useToast>;
}) {
  const [sheet, setSheet] = useState<"month" | "more" | "alerts" | null>(null);
  const [ask, setAsk] = useState<"update" | "publish" | null>(null);
  const idx = months.findIndex((m) => m.value === month);
  const open = alerts.filter((a) => !a.dismissed);
  const first = open.find((a) => a.severity === "error") ?? open[0];
  const monthName = monthLabel(month);
  const shortMonth = monthName.split(" ")[0];

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not reach the clipboard. Press and hold the link to copy it.");
    }
  };
  const share = async (url: string, name: string) => {
    const r = await shareLink(url, `${name} monthly report`);
    if (r === "copied") toast.success("Link copied");
    else if (r === "failed") toast.error("Could not share the link. Press and hold it to copy it.");
  };

  return (
    <section className="screen active mb-page rp-page" data-screen="reports" data-state={state}>
      <PhoneHead screen="reports" sub="Update a brand's report, then publish it to send the client their link." />

      <div className="rp-monthsw">
        <button
          type="button"
          className="mb-ib"
          aria-label="Previous month"
          disabled={idx < 0 || idx >= months.length - 1}
          onClick={() => setMonth(months[idx + 1]!.value)}
        >
          <Ic name="i-chev-l" />
        </button>
        <button type="button" className="rp-mid" aria-haspopup="dialog" onClick={() => setSheet("month")} data-testid="reports.month">
          {monthName}
          <Ic name="i-chev" />
        </button>
        <button type="button" className="mb-ib" aria-label="Next month" disabled={idx <= 0} onClick={() => setMonth(months[idx - 1]!.value)}>
          <Ic name="i-chev-r" />
        </button>
        {clients.length > 1 && (
          <button
            type="button"
            className="mb-ib"
            aria-label="Update all or republish all"
            aria-haspopup="dialog"
            disabled={busy !== null}
            onClick={() => setSheet("more")}
            data-testid="reports.more"
          >
            <Ic name="i-dots-h" />
          </button>
        )}
      </div>
      {allRun && (
        <div className="mb-status rp-run" role="status">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="spin">
            <use href="#i-refresh" />
          </svg>
          {allRun.kind === "update" ? "Updating" : "Publishing"} {allRun.step} of {clients.length}
        </div>
      )}

      {open.length > 0 && first ? (
        <div className="mb-banner bad rp-alert" data-testid="reports.alerts">
          <Ic name="i-alert" />
          <span className="mb-bt">{first.message}</span>
          <button type="button" className="mb-btn sm danger solid" onClick={() => setSheet("alerts")}>
            Open
          </button>
        </div>
      ) : (
        <div className="mb-banner rp-okb" data-testid="reports.alerts">
          <Ic name="i-check-circle" />
          <span className="mb-bt">
            <b>Nothing failing</b>
            Published pages refresh on their own when a month ends and keep the same link for good.
          </span>
        </div>
      )}
      {publishing && !publishing.configured && (
        <div className="mb-banner warn rp-okb">
          <Ic name="i-lock" />
          <span className="mb-bt">Publishing is off. {publishing.reason}</span>
        </div>
      )}

      {state === "empty" ? (
        <Empty screen="reports" title="No brands enrolled" hint="Enroll a client and their reports will build from real numbers." />
      ) : state === "error" ? (
        <ErrorState screen="reports" message="Could not load the report links." onRetry={onRetry} />
      ) : state === "loading" ? (
        <Loading screen="reports" label="Loading the report links" />
      ) : (
        clients.map((c, i) => {
          const ps = publishState.get(c.id);
          const working = busy === c.id;
          const live = ps?.url != null;
          const current = live && ps?.publishedMonth === month;
          const pending = !live && ps?.slug ? `/${ps.slug}` : null;
          return (
            <article className={`rp-rb${live && !current ? " stale" : ""}`} key={c.id} data-testid={`reports.client-${c.id}`}>
              <div className="rp-rbtop">
                <BrandAvatar client={c} index={i} size={40} />
                <span className="rp-grow">
                  <b>{c.name}</b>
                  <small>{updated[c.id] === month ? `Updated for ${monthName}, publish to send` : `${monthName} report`}</small>
                </span>
                <span className={`mb-pill ${!live ? "nodot" : current ? "ok" : "warn"}`}>
                  {!live ? "Not published" : current ? "Published" : "Out of date"}
                </span>
              </div>
              {live && ps?.url ? (
                <div className="rp-live">
                  <span className="rp-grow">
                    <b>
                      Live page shows {ps.publishedMonth ? monthLabel(ps.publishedMonth).split(" ")[0] : "an older report"}
                      {ps.publishedAt
                        ? `, published ${new Date(ps.publishedAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
                        : ""}
                    </b>
                    <small>{ps.url.replace(/^https?:\/\//, "")}</small>
                  </span>
                  <button type="button" className="mb-ib" aria-label={`Copy ${c.name}'s report link`} onClick={() => void copy(ps.url!)}>
                    <Ic name="i-copy" />
                  </button>
                  <button type="button" className="mb-ib" aria-label={`Share ${c.name}'s report link`} onClick={() => void share(ps.url!, c.name)}>
                    <Ic name="i-share" />
                  </button>
                </div>
              ) : (
                pending && (
                  <div className="rp-live pending">
                    <span className="rp-grow">
                      <b>{canPublish ? "Publishing creates this link" : "Not published yet"}</b>
                      <small>{pending}</small>
                    </span>
                  </div>
                )
              )}
              <div className="rp-acts">
                <button
                  type="button"
                  className="mb-btn sm ghost"
                  disabled={busy !== null}
                  onClick={() => update(c.id, c.name)}
                  data-testid={`reports.update-${c.id}`}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" className={working ? "spin" : undefined}>
                    <use href="#i-refresh" />
                  </svg>
                  {working ? "Working" : "Update report"}
                </button>
                <button
                  type="button"
                  className={`mb-btn sm${current ? "" : " pri"}`}
                  disabled={busy !== null || !canPublish}
                  onClick={() => publish(c.id, c.name)}
                  data-testid={`reports.publish-${c.id}`}
                >
                  {!live ? "Publish" : current ? "Republish" : `Publish ${shortMonth}`}
                </button>
              </div>
            </article>
          );
        })
      )}
      {open.length > 0 && (
        <p className="rp-note">
          Published pages refresh on their own when a month ends, carry the last 3 months, and keep the same link for good.
        </p>
      )}

      {sheet === "month" && (
        <PickSheet label="Report month" value={month} options={months} onPick={setMonth} onClose={() => setSheet(null)} testId="reports.month-sheet" />
      )}
      {sheet === "more" && (
        <Sheet label="Every brand" title="Every brand" sub={`${clients.length} brands, ${monthName}`} onClose={() => setSheet(null)} testId="reports.more-sheet">
          <div className="mb-card list">
            <button
              type="button"
              className="mb-lrow"
              onClick={() => {
                setSheet(null);
                setAsk("update");
              }}
              data-testid="reports.update-all"
            >
              <span className="mb-lic n">
                <Ic name="i-refresh" />
              </span>
              <span className="mb-lt">
                <b>Update all</b>
                <small>Pull the latest numbers for every brand's report, one after another</small>
              </span>
            </button>
            <button
              type="button"
              className="mb-lrow"
              disabled={!canPublish}
              onClick={() => {
                setSheet(null);
                setAsk("publish");
              }}
              data-testid="reports.publish-all"
            >
              <span className="mb-lic n">
                <Ic name="i-upload" />
              </span>
              <span className="mb-lt">
                <b>Republish all</b>
                <small>
                  {canPublish
                    ? "Rebuild every brand's live page with this month's report, at the same links"
                    : (publishing?.reason ?? "Publishing is not configured")}
                </small>
              </span>
            </button>
          </div>
        </Sheet>
      )}
      {sheet === "alerts" && (
        <Sheet label="Alerts" title="Alerts" sub={`${open.length} open`} onClose={() => setSheet(null)} testId="reports.alerts-sheet">
          {open.map((a) => (
            <div className={`mb-al ${a.severity === "error" ? "err" : "warn"}`} key={a.id}>
              <div className="mb-alt">
                <b>{a.message}</b>
                {a.count > 1 && (
                  <p>
                    Happened {a.count} times, most recently{" "}
                    {new Date(a.lastSeenAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.
                  </p>
                )}
              </div>
              {a.detail && <div className="mb-tech">{a.detail}</div>}
              <div className="mb-alacts">
                <button type="button" className="mb-btn sm ghost" onClick={() => onDismiss(a.id)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
          {!open.length && <p className="rp-empty">Nothing failing.</p>}
        </Sheet>
      )}
      {ask && (
        <ConfirmSheet
          title={ask === "update" ? "Update every report?" : "Republish every report?"}
          body={
            ask === "update"
              ? `This pulls the latest numbers into the ${monthName} report of all ${clients.length} brands, one after another.`
              : `This rebuilds the live page of all ${clients.length} brands with their ${monthName} report, at the same links. Clients see it right away.`
          }
          confirm={ask === "update" ? "Update all" : "Republish all"}
          onClose={() => setAsk(null)}
          onConfirm={() => {
            const kind = ask;
            setAsk(null);
            runAll(kind);
          }}
        />
      )}
    </section>
  );
}
