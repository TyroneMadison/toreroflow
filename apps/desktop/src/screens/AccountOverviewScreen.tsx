import { useCallback, useEffect, useState } from "react";
import { isReady, isRunning } from "@toreroflow/core";
import Pf from "../components/Pf";
import ClientCarousel from "../components/ClientCarousel";
import Stat from "../components/glass/Stat";
import DataProvenance from "../components/DataProvenance";
import { useToast } from "../components/Toasts";
import { Empty, ErrorState, Loading } from "../components/states";
import { api, type AccountOverview, type OverviewClient } from "../lib/api";
import { PF_ID } from "../lib/platforms";
import { openExternal } from "../lib/external";
import { useAppState } from "../state/AppState";

/**
 * Which client needs you today.
 *
 * Deliberately holds no follower counts and no view totals. Those live on
 * Analytics and in the client-facing reports, and a fourth place to read them
 * would be the only one you could not act on. Every row here is something to
 * do or a confirmation there is nothing to do.
 *
 * The API sorts by how much attention each client needs, so the top of the
 * list is the work and the bottom is the finished.
 */

type Tone = "bad" | "warn" | "ok";

/** The five steps every brand moves through each month, each red, amber or green. */
function pipeline(c: OverviewClient): Array<{ label: string; tone: Tone; detail: string }> {
  const connected = c.platforms.filter((p) => p.status === "connected").length;
  const plan = c.insight?.status;
  return [
    {
      label: "Connected",
      tone: c.needsReconnect ? "bad" : connected === 0 ? "warn" : "ok",
      detail: c.needsReconnect ? "a platform dropped its authorisation" : `${connected} platform${connected === 1 ? "" : "s"}`,
    },
    {
      label: "Plan",
      tone: plan === "failed" ? "bad" : isReady(plan) ? "ok" : "warn",
      detail: plan === "failed" ? "did not finish" : isRunning(plan) ? "being written" : isReady(plan) ? "ready" : "none yet",
    },
    {
      label: "Posting",
      tone: c.lastPostAt === null ? "warn" : (c.daysQuiet ?? 0) >= 14 ? "bad" : (c.daysQuiet ?? 0) >= 7 ? "warn" : "ok",
      detail: c.lastPostAt === null ? "nothing published" : `last ${c.daysQuiet ?? 0}d ago`,
    },
    {
      label: "Delivered",
      tone: !c.delivery ? "ok" : c.delivery.behindBy > 0 ? "warn" : "ok",
      detail: !c.delivery ? "no quota" : c.delivery.behindBy > 0 ? `${c.delivery.behindBy} behind` : "on quota",
    },
    {
      label: "Report",
      tone: c.report.stale ? "bad" : c.report.built && !c.report.opened ? "warn" : c.report.url ? "ok" : "warn",
      detail: c.report.stale ? "out of date" : c.report.url ? "published" : "not published",
    },
  ];
}

/** One word for where the brand stands, the biggest thing on its card. */
function headline(c: OverviewClient, steps: ReturnType<typeof pipeline>): { word: string; tone: Tone } {
  if (c.needsReconnect) return { word: "Reconnect", tone: "bad" };
  if (steps.some((s) => s.tone === "bad")) return { word: "Stalled", tone: "bad" };
  if (c.delivery && c.delivery.behindBy > 0) return { word: "Behind", tone: "warn" };
  if (steps.some((s) => s.tone === "warn")) return { word: "Check in", tone: "warn" };
  return { word: "On track", tone: "ok" };
}

function Avatar({ c, size = 44 }: { c: OverviewClient; size?: number }) {
  return (
    <div className="gx-av" style={{ width: size, height: size }}>
      {c.avatarUrl ? <img src={c.avatarUrl} alt="" /> : <span>{c.avatarSeed ?? c.name.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
}

function Pipe({ steps }: { steps: ReturnType<typeof pipeline> }) {
  return (
    <div className="gx-pipe" role="list" aria-label="Pipeline">
      {steps.map((s) => (
        <div key={s.label} role="listitem" className={`gx-step ${s.tone}`} title={`${s.label}: ${s.detail}`} data-step={s.label.toLowerCase()} data-tone={s.tone}>
          <i />
          <span>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

function subline(c: OverviewClient): string {
  const posted = c.lastPostAt === null ? "Nothing posted yet" : c.daysQuiet === 0 ? "Posted today" : `Posted ${c.daysQuiet}d ago`;
  const plan = isReady(c.insight?.status) ? "plan ready" : isRunning(c.insight?.status) ? "plan being written" : c.insight?.status === "failed" ? "plan did not finish" : "no plan yet";
  return `${posted} · ${plan}`;
}

function Tiles({ c }: { c: OverviewClient }) {
  const plan = c.insight?.status;
  return (
    <div className="gx-tiles">
      <div className="gx-stat glass-z2">
        <div className="tf-lbl">Plan</div>
        <div className="gx-statv">{isRunning(plan) ? "running" : isReady(plan) ? "ready" : plan === "failed" ? "failed" : "none"}</div>
        <div className="gx-sub">{isRunning(plan) ? "in the background" : "what to do next"}</div>
      </div>
      <div className="gx-stat glass-z2">
        <div className="tf-lbl">Last post</div>
        <div className="gx-statv">{c.lastPostAt === null ? "never" : c.daysQuiet === 0 ? "today" : `${c.daysQuiet}d ago`}</div>
        <div className="gx-sub">{c.platforms.length} platform{c.platforms.length === 1 ? "" : "s"}</div>
      </div>
      <div className="gx-stat glass-z2">
        <div className="tf-lbl">{c.report.label} report</div>
        <div className={`gx-statv ${c.report.stale ? "bad" : ""}`}>
          {c.report.stale ? "stale" : c.report.url ? (c.report.built && !c.report.opened ? "ready" : "live") : "unpublished"}
        </div>
        <div className="gx-sub">{c.report.stale ? `still ${c.report.publishedMonth ?? "earlier"}` : c.report.built && !c.report.opened ? "not opened yet" : "\u00a0"}</div>
      </div>
    </div>
  );
}

function BrandCard({ c, hero, onOpenInsights }: { c: OverviewClient; hero?: boolean; onOpenInsights(id: string): void }) {
  const steps = pipeline(c);
  const h = headline(c, steps);
  return (
    <article className={`gx-brand glass-z1 ${hero ? "hero" : ""} ${hero && c.avatarUrl ? "has-photo" : ""} ${h.tone}`} data-testid={`account-overview.client-${c.id}`} data-status={h.word.toLowerCase().replace(/ /g, "-")}>
      {hero && c.avatarUrl && (
        <div className="gx-photo" aria-hidden="true">
          <img src={c.avatarUrl} alt="" />
        </div>
      )}
      <header className="gx-head">
        {!(hero && c.avatarUrl) && <Avatar c={c} size={hero ? 52 : 40} />}
        <div className="gx-title">
          {hero && c.attention > 0 && <span className="tf-lbl">Needs you now</span>}
          <b>{c.name}</b>
          <span>{subline(c)}</span>
        </div>
        {hero ? (
          c.needsReconnect && <span className="gx-badge bad">Reconnect needed</span>
        ) : (
          <div className={`gx-word ${h.tone}`}>{h.word}</div>
        )}
      </header>
      <div className="gx-plats">
        {c.platforms.map((p) => (
          <Pf key={p.platform} p={PF_ID[p.platform]} size="sm" />
        ))}
      </div>
      {hero && (
        <>
          <div className="tf-lbl" style={{ marginTop: 14 }}>Status</div>
          <div className={`gx-hero-word ${h.tone}`}>{h.word}</div>
          <div className="gx-fill" />
        </>
      )}
      <Pipe steps={steps} />
      <Tiles c={c} />
      <footer className="gx-actions">
        {c.report.url && (
          <button type="button" className="tf-btn" onClick={() => void openExternal(c.report.url!)}>
            Report page
          </button>
        )}
        <button type="button" className="tf-btn pri grow" onClick={() => onOpenInsights(c.id)} data-testid={`account-overview.plan-${c.id}`}>
          {hero && c.needsReconnect ? "Open plan · reconnect in Settings" : "Open plan"}
        </button>
      </footer>
    </article>
  );
}

function ThisWeek({ clients }: { clients: OverviewClient[] }) {
  const need = clients.filter((c) => c.attention > 0).length;
  const postedWeek = clients.filter((c) => c.lastPostAt !== null && (c.daysQuiet ?? 99) < 7).length;
  const published = clients.filter((c) => c.report.url && !c.report.stale).length;
  return (
    <aside className="gx-side glass-z1" data-testid="account-overview.this-week">
      <div className="tf-lbl">This week</div>
      <Stat label="Need you" value={need} tone={need > 0 ? "bad" : "ok"} />
      <Stat label="Posted" value={postedWeek} sub={`of ${clients.length} brand${clients.length === 1 ? "" : "s"} in 7 days`} tone="ok" />
      <Stat label="Reports" value={`${published} / ${clients.length}`} sub="published and current" />
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
  const { clients: knownClients, selectedClient } = useAppState();
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
  // brand onboarded mid-session shows up here without navigating away. The
  // array identity changes on every refreshClients, which is exactly the
  // signal wanted.
  useEffect(() => {
    void load();
  }, [load, knownClients]);

  const clients = data?.clients ?? [];
  /** The carousel's pick leads; otherwise the most urgent brand does. */
  const hero = clients.find((c) => c.id === selectedClient?.id) ?? clients[0]!;
  /** Every connected platform on this screen, for the provenance footer. */
  const overviewPlatforms = clients.flatMap((c) =>
    c.platforms.filter((p) => p.status === "connected").map((p) => p.platform),
  );
  const needing = clients.filter((c) => c.attention > 0).length;
  const anyRunning = clients.some((c) => isRunning(c.insight?.status));

  // Poll only while a plan is actually being written, so a screen left open
  // overnight is not hitting the API every few seconds for nothing.
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  // A failed first load leaves no data; a failed refresh keeps the last good
  // list on screen and just toasts.
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
                  : `${needing} brand${needing === 1 ? "" : "s"} need${needing === 1 ? "s" : ""} attention, most urgent first.`}
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
              <button
                className="btn"
                style={{ marginTop: 12 }}
                onClick={onOpenConnect}
                data-testid="account-overview.enroll"
              >
                Enroll a client
              </button>
            }
          />
        ) : (
          <>
          <ClientCarousel clients={clients} />
          <div className="gx-ao">
            <BrandCard c={hero} hero onOpenInsights={onOpenInsights} />
            <div className="gx-ao-mid">
              {clients.filter((c) => c !== hero).map((c) => (
                <BrandCard key={c.id} c={c} onOpenInsights={onOpenInsights} />
              ))}
              <div className="gx-enroll glass-z1">
                <b>Enroll a client</b>
                <button type="button" className="tf-btn" onClick={onOpenConnect} data-testid="account-overview.enroll-more">
                  + Enroll
                </button>
              </div>
            </div>
            <ThisWeek clients={clients} />
          </div>
          </>
        )}
        <DataProvenance platforms={overviewPlatforms} />
      </div>
    </section>
  );
}
