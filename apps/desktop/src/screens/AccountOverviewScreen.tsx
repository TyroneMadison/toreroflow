import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { isReady, isRunning } from "@toreroflow/core";
import Pf from "../components/Pf";
import Stat from "../components/glass/Stat";
import DataProvenance from "../components/DataProvenance";
import { useToast } from "../components/Toasts";
import { Empty, ErrorState, Loading } from "../components/states";
import { useBrandKit } from "../editor/brandKit";
import { api, type AccountOverview, type OverviewClient } from "../lib/api";
import { byUrgency, pipeline, reason, status, summary, type Step } from "../lib/accountOverview";
import { brandColor, initials } from "../lib/avatar";
import { PF_ID } from "../lib/platforms";
import { navigate } from "../lib/routes";
import { useAppState } from "../state/AppState";
import "./AccountOverviewScreen.css";

/**
 * Which client needs you today: every brand down the left, most urgent first,
 * and the selected one as a profile on the right.
 *
 * Deliberately holds no follower counts and no view totals. Those live on
 * Analytics and in the client-facing reports, and a fourth place to read them
 * would be the only one you could not act on.
 */

function Avatar({ c, color }: { c: OverviewClient; color: string }) {
  return (
    <span className="ao-av" style={{ background: `linear-gradient(160deg,${color},rgba(0,0,0,.35))` }}>
      {c.avatarUrl ? <img src={c.avatarUrl} alt="" draggable={false} /> : (c.avatarSeed ?? initials(c.name))}
    </span>
  );
}

function Pill({ c, steps }: { c: OverviewClient; steps: Step[] }) {
  const s = status(c, steps);
  return <span className={`ao-pill ${s.tone}`}>{s.word}</span>;
}

function Pipe({ steps }: { steps: Step[] }) {
  return (
    <div className="ao-pipe" role="list" aria-label="Progress">
      {steps.map((s) => (
        <div key={s.label} role="listitem" className={`ao-step ${s.tone}`} title={`${s.label}: ${s.detail}`} data-step={s.label.toLowerCase()} data-tone={s.tone}>
          <i />
          <span>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

function Tiles({ c }: { c: OverviewClient }) {
  const plan = c.insight?.status;
  return (
    <div className="ao-tiles">
      <Stat label="Plan" value={isRunning(plan) ? "Running" : isReady(plan) ? "Ready" : plan === "failed" ? "Failed" : "Missing"} tone={plan === "failed" ? "bad" : undefined} />
      <Stat label="Last post" value={c.lastPostAt === null ? "Never" : c.daysQuiet === 0 ? "Today" : `${c.daysQuiet}d ago`} />
      <Stat
        label={`${c.report.label} report`}
        value={c.report.stale ? "Stale" : c.report.url ? (c.report.built && !c.report.opened ? "Ready" : "Live") : "Unpublished"}
        tone={c.report.stale ? "bad" : undefined}
      />
    </div>
  );
}

function Profile({ c, color, onOpenInsights }: { c: OverviewClient; color: string; onOpenInsights(id: string): void }) {
  const steps = pipeline(c);
  const kit = useBrandKit(c.id);
  // The brand kit's own colors when it has them, else the brand's list color.
  const [c1, c2] = kit?.colors.length ? [kit.colors[0]!, kit.colors[1] ?? "#7b2d8e"] : [color, "#7b2d8e"];
  return (
    <article
      className="ao-profile glass-z1"
      tabIndex={-1}
      id="ao-profile"
      aria-label={c.name}
      data-testid={`account-overview.client-${c.id}`}
      data-status={status(c, steps).word.toLowerCase().replace(/ /g, "-")}
    >
      <div className="ao-cover" style={{ background: `linear-gradient(120deg,${c1},${c2})` }} />
      <div className="ao-body">
        <div className="ao-big-av">
          <Avatar c={c} color={color} />
        </div>
        <div className="ao-name">
          <h3>{c.name}</h3>
          <Pill c={c} steps={steps} />
          <span className="ao-plats">
            {c.platforms.map((p) => (
              <Pf key={p.platform} p={PF_ID[p.platform]} size="sm" />
            ))}
          </span>
        </div>
        <p className="ao-summary">{summary(c)}</p>
        <div className="tf-lbl">Progress</div>
        <Pipe steps={steps} />
        <Tiles c={c} />
        <div className="ao-actions">
          <button type="button" className="tf-btn pri" onClick={() => onOpenInsights(c.id)} data-testid={`account-overview.plan-${c.id}`}>
            Make next week's plan
          </button>
          <button type="button" className="tf-btn" onClick={() => navigate("calendar")} data-testid="account-overview.calendar">
            Open calendar
          </button>
        </div>
      </div>
    </article>
  );
}

function ThisWeek({ clients }: { clients: OverviewClient[] }) {
  const need = clients.filter((c) => status(c).tone === "bad").length;
  const postedWeek = clients.filter((c) => c.lastPostAt !== null && (c.daysQuiet ?? 99) < 7).length;
  return (
    <aside className="ao-week glass-z1" data-testid="account-overview.this-week">
      <div className="tf-lbl">This week</div>
      <div className="ao-week-stats">
        <Stat label="Need you" value={need} tone={need > 0 ? "bad" : "ok"} />
        <Stat label="Posted" value={`${postedWeek} of ${clients.length}`} sub={`brand${clients.length === 1 ? "" : "s"} in 7 days`} tone="ok" />
      </div>
    </aside>
  );
}

export default function AccountOverviewScreen({
  onOpenConnect,
  onOpenInsights,
}: {
  onOpenConnect(): void;
  onOpenInsights(clientId: string): void;
}) {
  const toast = useToast();
  const { clients: knownClients, selectedClient, selectClient } = useAppState();
  const [data, setData] = useState<AccountOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.get<AccountOverview>("/overview"));
    } catch (err) {
      toast.fail("Could not load the overview", err);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // Refetch whenever the client list changes (enroll, connect, sync), so a
  // brand onboarded mid-session shows up here without navigating away.
  useEffect(() => {
    void load();
  }, [load, knownClients]);

  const clients = byUrgency(data?.clients ?? []);
  const found = clients.findIndex((c) => c.id === selectedClient?.id);
  const idx = found < 0 ? 0 : found;
  const current = clients[idx];
  /** Each brand keeps the color of its place in the app's client list. */
  const colorOf = (c: OverviewClient) => brandColor(Math.max(0, knownClients.findIndex((k) => k.id === c.id)));
  const overviewPlatforms = clients.flatMap((c) =>
    c.platforms.filter((p) => p.status === "connected").map((p) => p.platform),
  );
  const needing = clients.filter((c) => status(c).tone === "bad").length;
  const anyRunning = clients.some((c) => isRunning(c.insight?.status));

  // Poll only while a plan is actually being written.
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      const p = document.getElementById("ao-profile");
      p?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      p?.querySelector<HTMLElement>("button")?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const n = Math.max(0, Math.min(clients.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)));
      selectClient(clients[n]!.id);
    } else return;
    e.preventDefault();
  };
  // Keep focus on the selected row when the keyboard moved it.
  useEffect(() => {
    if (list.current?.contains(document.activeElement)) {
      list.current.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  }, [idx]);

  const state = loading ? "loading" : !data ? "error" : clients.length === 0 ? "empty" : "ready";

  return (
    <section className="screen active" data-screen="account-overview" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Account Overview</h2>
          <p>
            {loading
              ? "Checking every brand…"
              : !data
                ? "The overview did not load."
                : needing === 0
                  ? "Nothing needs you right now."
                  : `${needing} brand${needing === 1 ? "" : "s"} need${needing === 1 ? "s" : ""} you, most urgent first.`}
          </p>
        </div>
        <button className="btn ghost" onClick={() => void load()} data-testid="account-overview.refresh">
          <svg>
            <use href="#i-refresh" />
          </svg>{" "}
          Refresh
        </button>
      </div>

      <div className="stage">
        {state === "loading" ? (
          <Loading screen="account-overview" label="Checking every brand" />
        ) : state === "error" ? (
          <ErrorState
            screen="account-overview"
            message="Could not load the overview."
            onRetry={() => {
              setLoading(true);
              void load();
            }}
          />
        ) : state === "empty" ? (
          <Empty
            screen="account-overview"
            title="No brands enrolled"
            hint="Enroll a client and their status appears here."
            action={
              <button className="btn" style={{ marginTop: 12 }} onClick={onOpenConnect} data-testid="account-overview.enroll">
                Enroll a client
              </button>
            }
          />
        ) : (
          <div className="ao">
            <div className="ao-left">
              <div className="ao-list glass-z1">
                <div className="tf-lbl" id="ao-list-label">Brands, most urgent first</div>
                <div ref={list} className="ao-rows" role="listbox" aria-labelledby="ao-list-label" onKeyDown={onKeyDown} data-testid="account-overview.brands">
                  {clients.map((c, i) => {
                    const steps = pipeline(c);
                    const on = i === idx;
                    return (
                      <div
                        key={c.id}
                        role="option"
                        aria-selected={on}
                        tabIndex={on ? 0 : -1}
                        className={`ao-row${on ? " on" : ""}`}
                        data-testid={`account-overview.row-${c.id}`}
                        onClick={() => selectClient(c.id)}
                      >
                        <Avatar c={c} color={colorOf(c)} />
                        <span className="ao-row-txt">
                          <b>{c.name}</b>
                          <small>{reason(c, steps)}</small>
                        </span>
                        <Pill c={c} steps={steps} />
                      </div>
                    );
                  })}
                </div>
                <button type="button" className="tf-btn ao-enroll" onClick={onOpenConnect} data-testid="account-overview.enroll-more">
                  + Enroll a client
                </button>
              </div>
              <ThisWeek clients={clients} />
            </div>
            {current && <Profile key={current.id} c={current} color={colorOf(current)} onOpenInsights={onOpenInsights} />}
          </div>
        )}
        <DataProvenance platforms={overviewPlatforms} />
      </div>
    </section>
  );
}
