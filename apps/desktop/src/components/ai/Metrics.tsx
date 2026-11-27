import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DM_METRIC_KEYS, DM_METRIC_LABEL, DM_METRIC_RANGES, centsText, type DmMetricKey, type DmMetricRange, type DmMetricsView } from "@toreroflow/core";
import Pf from "../Pf";
import { useToast } from "../Toasts";
import { api, type ClientSummary } from "../../lib/api";
import { useIsPhone } from "../../lib/phone";
import { usePageHead } from "../../lib/pageHead";
import { PF_ID } from "../../lib/platforms";
import { automationPath, navigate, navigatePath } from "../../lib/routes";
import { chartGeo, durText, fmtNum, fmtPct, kpiText, metricsCsv, RANGE_LABEL } from "../../lib/aiMetrics";
import { CouldNotLoad, Dialog, I, Skeleton, Spark, Switch } from "../automations/parts";
import "./areas.css";

/**
 * Workflows > Metrics (F5): round 2 mockup 05, desktop and phone. The six
 * numbers are tabs over the chart (pick one, the chart shows it), delivery
 * problems sit at the chart's foot, then where people drop off, what started
 * conversations and top automations. Replies (response time, AI drafts and
 * spend) follow in one strip. Computed from the Dm* rows by the API.
 */

type MetricsResponse = DmMetricsView & {
  accounts: Array<{ accountId: string; platform: "instagram" | "facebook"; handle: string; transport: "native" | "zernio"; chosen: boolean }>;
  partial: boolean;
};

const STARTED_COLOR: Record<string, string> = {
  comment: "var(--ibx-info)",
  story_reply: "var(--ibx-trial)",
  dm_keyword: "var(--ibx-drive)",
  welcome: "var(--ibx-warn)",
  story_mention: "var(--ibx-ok)",
  messenger: "rgba(255,255,255,.45)",
  dm: "rgba(255,255,255,.25)",
};
const DAY = 86_400_000;

function Delta({ d, phone }: { d: DmMetricsView["kpis"][DmMetricKey]["delta"]; phone?: boolean }) {
  if (!d) return null;
  if (phone) return <span className={`d ${d.dir}`}>{d.text}</span>;
  return (
    <span className={`wa-delta ${d.dir}`}>
      {d.dir !== "flat" && <I name={d.dir === "up" ? "i-trend-up" : "i-trend-down"} />}
      {d.text.replace(/^\+/, "")}
    </span>
  );
}

export default function Metrics({ client }: { client: ClientSummary }) {
  const isPhone = useIsPhone();
  const toast = useToast();
  const [range, setRange] = useState<DmMetricRange>("7");
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [compare, setCompare] = useState(true);
  const [tab, setTab] = useState<DmMetricKey>("received");
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [allStarted, setAllStarted] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ range, ...(chosen ? { accounts: chosen.join(",") } : {}) });
      const r = await api.get<MetricsResponse>(`/clients/${client.id}/dm/metrics?${q}`);
      setData(r);
      setErr(null);
      setLastLoaded(new Date());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not load the metrics");
    }
  }, [client.id, range, chosen]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (data || !err) return;
    const t = window.setTimeout(() => void load(), 15_000);
    return () => window.clearTimeout(t);
  }, [data, err, load]);

  const accounts = data?.accounts ?? [];
  const exportCsv = () => {
    if (!data) return;
    const blob = new Blob([metricsCsv(data, client.name)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${client.name.replace(/[^\w-]+/g, "-").toLowerCase()}-dm-metrics-${range}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Exported.");
  };

  usePageHead(
    !isPhone
      ? {
          sub: `How DMs and automations did for ${client.name}. ${RANGE_LABEL[range]!.sub}`,
          controls: (
            <>
              <div className="wa-hseg" role="tablist" aria-label="Period">
                {DM_METRIC_RANGES.map((r) => (
                  <button key={r} type="button" role="tab" aria-selected={range === r} className={range === r ? "on" : undefined} onClick={() => setRange(r)} data-testid={`metrics.range.${r}`}>
                    {RANGE_LABEL[r]!.long}
                  </button>
                ))}
              </div>
              {accounts.length > 1 && (
                <label className="au-hsel">
                  <Pf p={PF_ID[accounts.find((a) => a.accountId === chosen?.[0])?.platform ?? "instagram"]} size="xs" />
                  <select aria-label="Accounts" value={chosen?.length === 1 ? chosen[0] : ""} onChange={(e) => setChosen(e.target.value ? [e.target.value] : null)} data-testid="metrics.account">
                    <option value="">All accounts</option>
                    {accounts.map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {a.platform === "facebook" ? "Messenger" : `@${a.handle}`}
                      </option>
                    ))}
                  </select>
                  <svg className="chev" viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-chev" />
                  </svg>
                </label>
              )}
            </>
          ),
        }
      : null,
  );

  const wrap = isPhone ? "ibx-wrap ph au wa" : "ibx-wrap au wa";
  if (!data) {
    return (
      <div className={wrap} data-testid="metrics" data-state={err ? "error" : "loading"}>
        {err ? <CouldNotLoad phone={isPhone} lastLoaded={lastLoaded} onRetry={() => void load()} what="the metrics" /> : <Skeleton phone={isPhone} label="Loading the metrics" />}
      </div>
    );
  }

  const k = data.kpis;
  const delta = (key: DmMetricKey) => (compare ? k[key].delta : null);
  const del = data.delivery;
  const started = allStarted || !isPhone ? data.started : data.started.slice(0, 3);
  const empty = data.empty;

  const notices = (
    <>
      {!accounts.length && (
        <div className={isPhone ? "au-slim info" : "au-notice info"}>
          <I name="i-info" />
          <span className="grow">No Instagram or Messenger account is connected for {client.name} yet, so there is nothing to count.</span>
        </div>
      )}
      {data.partial && accounts.length > 0 && (
        <div className={isPhone ? "au-slim info" : "au-notice info"} data-testid="metrics.partial">
          <I name="i-info" />
          <span className="grow">
            {isPhone ? (
              <>
                <b>Messages count on Instagram through Torerone's Meta app</b>
                Messenger and Zernio accounts count people only
              </>
            ) : (
              <>
                <b>Messages are counted on Instagram connected through Torerone's Meta app.</b> Messenger and Instagram read through Zernio count as people, by their latest message.
              </>
            )}
          </span>
        </div>
      )}
    </>
  );

  const funnel = (
    <div className="wa-fun">
      {data.funnel.map((f) => (
        <div key={f.key} className="r">
          <div className={isPhone ? "row-sb sb" : "sb"}>
            <b>{f.label}</b>
            <span>{isPhone && f.pct !== null && f.key !== "got" ? fmtPct(f.pct) : f.pct !== null && f.key !== "got" ? `${fmtNum(f.n)} · ${fmtPct(f.pct)}` : fmtNum(f.n)}</span>
          </div>
          <div className="tr">
            <i style={{ width: `${f.key === "triggered" ? (f.n ? 100 : 0) : Math.round((f.pct ?? 0) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
  const sbar = (
    <div className="wa-sbar">
      {data.started.map((s) => (
        <i key={s.key} style={{ flex: s.n, ["--c" as string]: STARTED_COLOR[s.key] ?? "rgba(255,255,255,.3)" }} />
      ))}
    </div>
  );
  const replyFacts = [
    { k: "Median reply time", v: durText(data.replies.medianResponseSec) },
    { k: "AI drafts written", v: fmtNum(data.ai.drafts) },
    { k: "Sent as written", v: fmtNum(data.ai.sentAsIs) },
    { k: "Edited, then sent", v: fmtNum(data.ai.edited) },
    { k: "Sent by the AI", v: fmtNum(data.ai.autoSent) },
    { k: "Handed to the team", v: fmtNum(data.ai.handedOff) },
    { k: "AI spend", v: centsText(data.ai.costCents) },
  ];

  const filter = filterOpen && (
    <Dialog
      phone={isPhone}
      title="Show numbers for"
      onClose={() => setFilterOpen(false)}
      foot={
        <>
          <button type="button" className="mb-btn ghost" onClick={() => (setChosen(null), setCompare(true))}>
            Reset
          </button>
          <button type="button" className="mb-btn pri" onClick={() => setFilterOpen(false)}>
            Apply
          </button>
        </>
      }
      testId="metrics.filter"
    >
      <div className="mb-card list au-optlist">
        {accounts.map((a) => {
          const on = !chosen || chosen.includes(a.accountId);
          return (
            <button
              key={a.accountId}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="au-check au-opt"
              onClick={() => {
                const all = accounts.map((x) => x.accountId);
                const cur = chosen ?? all;
                const next = on ? cur.filter((x) => x !== a.accountId) : [...cur, a.accountId];
                setChosen(!next.length || next.length === all.length ? null : next);
              }}
            >
              <span className="box">{on && <I name="i-check" />}</span>
              <Pf p={PF_ID[a.platform]} size="sm" />
              <span className="lt">
                <b>{a.platform === "facebook" ? "Messenger" : `@${a.handle}`}</b>
                <small>{a.platform === "facebook" ? `${client.name} page` : "Instagram"}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mb-card list au-optlist">
        <div className="au-optrow">
          <span className="lt">
            <b>Compare with the period before</b>
            <small>Shows the green and red changes</small>
          </span>
          <Switch on={compare} label="Compare with the period before" onChange={setCompare} />
        </div>
      </div>
    </Dialog>
  );
  const actions = actionsOpen && (
    <Dialog phone={isPhone} title={`Metrics, ${RANGE_LABEL[range]!.long.toLowerCase()}`} sub={chosen ? `${chosen.length} of ${accounts.length} accounts of ${client.name}` : `All accounts of ${client.name}`} onClose={() => setActionsOpen(false)} foot={<button type="button" className="mb-btn block" onClick={() => setActionsOpen(false)}>Cancel</button>} testId="metrics.actions">
      <div className="au-am">
        <button type="button" onClick={() => (setActionsOpen(false), exportCsv())}>
          <I name="i-dl" />
          <span className="grow">Export CSV</span>
        </button>
        <button type="button" disabled>
          <I name="i-link" />
          <span className="grow">
            Copy a read-only link<small>Not built yet</small>
          </span>
        </button>
        <button type="button" disabled>
          <I name="i-report" />
          <span className="grow">
            Add to the monthly report<small>Not built yet</small>
          </span>
        </button>
      </div>
    </Dialog>
  );

  // ---------------------------------------------------------------------------
  // Phone (mockup 05-metrics-phone)
  // ---------------------------------------------------------------------------
  if (isPhone) {
    return (
      <div className={wrap} data-testid="metrics" data-state={empty ? "empty" : "ready"}>
        <div className="au-toolrow">
          <div className="ibx-seg ph grow" role="tablist" aria-label="Period">
            {DM_METRIC_RANGES.map((r) => (
              <button key={r} type="button" role="tab" aria-selected={range === r} className={range === r ? "on" : undefined} onClick={() => setRange(r)}>
                {RANGE_LABEL[r]!.short}
              </button>
            ))}
          </div>
          <button type="button" className={`mb-ib${chosen || !compare ? " on" : ""}`} aria-label="Accounts and comparison" onClick={() => setFilterOpen(true)} data-testid="metrics.filter-open">
            <I name="i-sliders" />
          </button>
          <button type="button" className="mb-ib" aria-label="Export or share" onClick={() => setActionsOpen(true)} data-testid="metrics.actions-open">
            <I name="i-share" />
          </button>
        </div>
        {notices}
        <div className="wa-kg" role="tablist" aria-label="Pick a number for the chart">
          {DM_METRIC_KEYS.map((key) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : undefined} onClick={() => setTab(key)}>
              <span className="k">{DM_METRIC_LABEL[key].short}</span>
              <span className="v">{kpiText(key, k[key].value)}</span>
              <Delta d={delta(key)} phone />
            </button>
          ))}
        </div>
        <section className="mb-card wa-cc">
          <div className="wa-cch">
            <h3>{DM_METRIC_LABEL[tab].long}</h3>
            <small>last {data.chart.days} days</small>
          </div>
          <Chart data={data} tab={tab} compact />
          <div className="wa-legend">
            <span>
              <i style={{ ["--c" as string]: "var(--ibx-info)" }} />
              {tab === "received" ? "Received" : DM_METRIC_LABEL[tab].short}
            </span>
            {tab === "received" && (
              <span>
                <i style={{ ["--c" as string]: "rgba(245,242,239,.6)" }} />
                Sent
              </span>
            )}
            {compare && data.prevFrom && <span className="muted">Compared with the {RANGE_LABEL[range]!.long} before</span>}
          </div>
        </section>
        {del.total > 0 && (
          <div className="au-slim warn">
            <I name="i-alert" />
            <span className="grow">
              <b>{fmtNum(del.total)} {del.total === 1 ? "message" : "messages"} not delivered</b>
              {del.sends ? `${fmtPct(del.total / (del.sends + del.total))} of sends. ` : ""}
              {del.outsideWindow >= Math.max(del.cannotGet, del.hourly) ? "Most were outside the 24 hour window." : del.cannotGet >= del.hourly ? "Most could not get messages." : "Most waited for the hourly limit."}
            </span>
          </div>
        )}
        <section className="mb-card wa-cc">
          <div className="wa-cch">
            <h3>Where people drop off</h3>
          </div>
          {funnel}
        </section>
        <section className="mb-card wa-cc">
          <div className="wa-cch">
            <h3>What started chats</h3>
            <small>{fmtNum(data.startedTotal)} people</small>
          </div>
          {data.started.length ? (
            <>
              {sbar}
              {started.map((s) => (
                <div key={s.key} className="wa-srow">
                  <i style={{ ["--c" as string]: STARTED_COLOR[s.key] }} />
                  <span className="grow">{s.label}</span>
                  <b>{fmtPct(s.pct)}</b>
                </div>
              ))}
              {data.started.length > 3 && (
                <button type="button" className="au-showmore wa-flush" onClick={() => setAllStarted((v) => !v)}>
                  {allStarted ? "Show fewer" : `Show all ${data.started.length}`}
                  <I name="i-chev" />
                </button>
              )}
            </>
          ) : (
            <p className="au-help">No new conversations in this period.</p>
          )}
        </section>
        <section className="au-rlist" aria-label="Top automations">
          <div className="au-rlh">Top automations</div>
          {!data.top.length && <p className="ibx-nomatch">No automation ran in this period.</p>}
          {data.top.slice(0, 3).map((t) => (
            <button key={t.id} type="button" className="au-ar" onClick={() => navigatePath(automationPath(t.id))}>
              <span className={`au-dot ${t.status === "live" ? "live" : t.status === "paused" ? "off" : "draft"}`} />
              <span className="t">
                <b>{t.name}</b>
                <small>
                  {fmtNum(t.runs)} runs{t.ctr !== null ? `, ${fmtPct(t.ctr)} CTR` : ""}
                </small>
              </span>
              <I name="i-chev-r" className="chev" />
            </button>
          ))}
          <button type="button" className="au-showmore" onClick={() => navigate("workflows", "automations")}>
            All automations
            <I name="i-chev-r" />
          </button>
        </section>
        <div className="au-sech">
          <h2>Replies</h2>
        </div>
        <div className="wa-mfacts">
          {replyFacts.map((f) => (
            <div key={f.k}>
              <div className="k">{f.k}</div>
              <div className="v">{f.v}</div>
            </div>
          ))}
        </div>
        {filter}
        {actions}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Desktop and web (mockup 05-metrics-desktop)
  // ---------------------------------------------------------------------------
  return (
    <div className={wrap} data-testid="metrics" data-state={empty ? "empty" : "ready"}>
      {notices}
      <section className="au-card wa-hero" aria-label="Key numbers">
        <div className="wa-ktabs" role="tablist">
          {DM_METRIC_KEYS.map((key) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={`wa-ktab${tab === key ? " on" : ""}`} onClick={() => setTab(key)} data-testid={`metrics.kpi.${key}`}>
              <span className="k">{DM_METRIC_LABEL[key].long}</span>
              <span className="v">
                {kpiText(key, k[key].value)} <Delta d={delta(key)} />
              </span>
            </button>
          ))}
        </div>
        <div className="wa-chartwrap">
          <div className="ttl">
            {DM_METRIC_LABEL[tab].chart} <small>last {data.chart.days} days{data.chart.shadeFrom > 0 ? `, the ${RANGE_LABEL[range]!.long} shaded` : ""}</small>
          </div>
          <div className="wa-legend">
            <span>
              <i style={{ ["--c" as string]: "var(--ibx-info)" }} />
              {tab === "received" ? "Received" : DM_METRIC_LABEL[tab].short}
            </span>
            {tab === "received" && (
              <span>
                <i style={{ ["--c" as string]: "rgba(255,255,255,.6)" }} />
                Sent
              </span>
            )}
          </div>
          <Chart data={data} tab={tab} />
        </div>
        <div className="wa-deliv">
          <I name={del.total ? "i-alert" : "i-check-circle"} className={del.total ? undefined : "ok"} />
          {del.total ? (
            <>
              <span>
                <b>
                  {fmtNum(del.total)} {del.total === 1 ? "message" : "messages"} not delivered
                </b>{" "}
                in this period{del.sends ? `, ${fmtPct(del.total / (del.sends + del.total))} of sends` : ""}:
              </span>
              {del.outsideWindow > 0 && (
                <span className="it">
                  <em>{del.outsideWindow}</em> outside the 24 hour window
                </span>
              )}
              {del.cannotGet > 0 && (
                <span className="it">
                  <em>{del.cannotGet}</em> person cannot get messages
                </span>
              )}
              {del.hourly > 0 && (
                <span className="it">
                  <em>{del.hourly}</em> hourly limit, sent later
                </span>
              )}
              {del.other > 0 && (
                <span className="it">
                  <em>{del.other}</em> other errors
                </span>
              )}
            </>
          ) : (
            <span>Every message in this period was delivered.</span>
          )}
        </div>
      </section>

      <div className="wa-three">
        <section className="au-card">
          <div className="sect-t">
            <h3>Where people drop off</h3>
          </div>
          {funnel}
        </section>
        <section className="au-card">
          <div className="sect-t">
            <h3>What started conversations</h3>
            <small>{fmtNum(data.startedTotal)} people</small>
          </div>
          {data.started.length ? (
            <>
              {sbar}
              <div className="wa-src">
                {started.map((s) => (
                  <div key={s.key} className="r">
                    <i style={{ ["--c" as string]: STARTED_COLOR[s.key] }} />
                    <span className="grow">{s.label}</span>
                    <span className="n">{fmtNum(s.n)}</span>
                    <b>{fmtPct(s.pct)}</b>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="au-help" style={{ marginTop: 10 }}>
              No new conversations in this period.
            </p>
          )}
        </section>
        <section className="au-card">
          <div className="au-rowsb">
            <div className="sect-t">
              <h3>Top automations</h3>
            </div>
            <button type="button" className="au-lnk" onClick={() => navigate("workflows", "automations")}>
              All automations
            </button>
          </div>
          <div className="wa-ta h">
            <span>Automation</span>
            <span className="r">Runs</span>
            <span className="r">CTR</span>
            <span className="r">Trend</span>
          </div>
          {!data.top.length && <p className="au-help">No automation ran in this period.</p>}
          {data.top.slice(0, 4).map((t) => (
            <button key={t.id} type="button" className="wa-ta" onClick={() => navigatePath(automationPath(t.id))}>
              <span className="nm">
                <span className={`au-dot ${t.status === "live" ? "live" : t.status === "paused" ? "off" : "draft"}`} />
                <b>{t.name}</b>
              </span>
              <span className="r">{fmtNum(t.runs)}</span>
              <span className="r">{t.ctr === null ? "n/a" : fmtPct(t.ctr)}</span>
              <span className="r">
                <Spark values={t.spark} />
              </span>
            </button>
          ))}
        </section>
      </div>

      <section className="au-card p0 wa-strip" aria-label="Replies">
        <span className="ttl">Replies</span>
        {replyFacts.map((f) => (
          <div key={f.k}>
            <div className="k">{f.k}</div>
            <div className="v">{f.v}</div>
          </div>
        ))}
      </section>
    </div>
  );
}

/** The chart for the chosen number, with a hover tip (mockup 05). */
function Chart({ data, tab, compact = false }: { data: DmMetricsView; tab: DmMetricKey; compact?: boolean }) {
  const box = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(compact ? 320 : 900);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, Math.round(el.getBoundingClientRect().width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const h = compact ? 150 : 226;
  const rate = tab === "replyRate" || tab === "ctr";
  const series = data.chart.series[tab];
  const g = useMemo(() => chartGeo(series.a, series.b, w, h, data.chart.shadeFrom, rate, compact), [series, w, h, data.chart.shadeFrom, rate, compact]);
  const n = data.chart.days;
  const from = Date.parse(data.chart.from);
  const day = (i: number) => new Date(from + i * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const ticks = compact ? [0, n - 1] : [0, Math.round(n * 0.25), Math.round(n * 0.5), Math.round(n * 0.75), n - 1];
  const val = (v: number | null | undefined) => (v === null || v === undefined ? "none" : rate ? fmtPct(v) : fmtNum(v));
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * w;
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.abs(g.x(i) - x) < Math.abs(g.x(best) - x)) best = i;
    setHover(best);
  };
  const tipLeft = hover === null ? 0 : Math.min(Math.max(g.x(hover) + (compact ? 0 : 20) - 150, 0), w - 160);
  return (
    <div style={{ position: "relative" }}>
      <svg ref={box} className={compact ? "wa-chart wa-mchart" : "wa-chart"} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${DM_METRIC_LABEL[tab].chart}, last ${n} days`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {g.grid.map((l, i) => (
          <g key={i}>
            <line className="grid" x1={compact ? 0 : 34} x2={w} y1={l.y} y2={l.y} />
            {!compact && (
              <text x={0} y={l.y + 4}>
                {l.label}
              </text>
            )}
          </g>
        ))}
        {data.chart.shadeFrom > 0 && <rect className="shade" x={g.shadeX} y={compact ? 8 : 10} width={Math.max(0, w - g.shadeX - (compact ? 0 : 2))} height={h - (compact ? 28 : 36)} rx={6} />}
        <defs>
          <linearGradient id={`wa-g-${compact ? "m" : "d"}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#4C9DFF" stopOpacity=".28" />
            <stop offset="1" stopColor="#4C9DFF" stopOpacity="0" />
          </linearGradient>
        </defs>
        {!compact && g.area && <path d={g.area} fill={`url(#wa-g-d)`} />}
        {g.b && <path className="b" d={g.b} />}
        {g.a && <path className="a" d={g.a} />}
        {hover !== null && (
          <>
            <line className="cur" x1={g.x(hover)} x2={g.x(hover)} y1={compact ? 8 : 10} y2={h - (compact ? 20 : 26)} />
            {series.a[hover] !== null && <circle cx={g.x(hover)} cy={g.y(series.a[hover] ?? 0)} r={5} fill="#4C9DFF" stroke="#0b0b0b" strokeWidth={2} />}
          </>
        )}
        {ticks.map((i, k) => (
          <text key={k} x={g.x(i)} y={h - 6} textAnchor={k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle"}>
            {i === n - 1 ? "Today" : day(i)}
          </text>
        ))}
      </svg>
      {hover !== null && (
        <div className="wa-tip" style={{ left: tipLeft, top: compact ? 4 : 16 }}>
          <b>{new Date(from + hover * DAY).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</b>
          <span>
            <i style={{ ["--c" as string]: "var(--ibx-info)" }} />
            {val(series.a[hover])} {tab === "received" ? "received" : DM_METRIC_LABEL[tab].short.toLowerCase()}
          </span>
          {series.b && (
            <span>
              <i style={{ ["--c" as string]: "rgba(255,255,255,.6)" }} />
              {val(series.b[hover])} sent
            </span>
          )}
        </div>
      )}
    </div>
  );
}
