import { useCallback, useEffect, useState } from "react";
import { isReady, isRunning } from "@toreroflow/core";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
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

/** One thing needing doing, or a green line saying it does not. */
function Signal({
  tone,
  label,
  detail,
}: {
  tone: "bad" | "warn" | "ok";
  label: string;
  detail?: string;
}) {
  return (
    <div className={`signal ${tone}`}>
      <span className="sdot" />
      <b>{label}</b>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function ClientRow({
  client,
  onOpenInsights,
}: {
  client: OverviewClient;
  onOpenInsights(id: string): void;
}) {
  const { delivery, report } = client;
  const signals: Array<{ tone: "bad" | "warn" | "ok"; label: string; detail?: string }> = [];

  if (client.needsReconnect) {
    signals.push({
      tone: "bad",
      label: "Reconnect needed",
      detail: "a platform has dropped its authorisation",
    });
  }

  if (delivery) {
    const parts: string[] = [];
    if (delivery.short.target != null) {
      parts.push(`${delivery.short.delivered}/${delivery.short.target} short`);
    }
    if (delivery.long.target != null) {
      parts.push(`${delivery.long.delivered}/${delivery.long.target} long`);
    }
    signals.push(
      delivery.behindBy > 0
        ? {
            tone: "warn",
            label: `${delivery.behindBy} video${delivery.behindBy === 1 ? "" : "s"} behind`,
            detail: parts.join(" · "),
          }
        : { tone: "ok", label: "Delivered", detail: parts.join(" · ") },
    );
  }

  // Never published reads differently to gone quiet, so it is said differently.
  if (client.lastPostAt === null) {
    signals.push({ tone: "warn", label: "Nothing published yet" });
  } else if ((client.daysQuiet ?? 0) >= 7) {
    signals.push({
      tone: client.daysQuiet! >= 14 ? "bad" : "warn",
      label: `Quiet ${client.daysQuiet} days`,
      detail: "nothing has gone out",
    });
  } else {
    signals.push({
      tone: "ok",
      label: client.daysQuiet === 0 ? "Posted today" : `Posted ${client.daysQuiet}d ago`,
    });
  }

  // The plan runs on the worker, so this row is where an operator who closed
  // the modal finds out it landed.
  if (isRunning(client.insight?.status)) {
    signals.push({ tone: "warn", label: "Writing a plan", detail: "running in the background" });
  } else if (client.insight?.status === "failed") {
    signals.push({ tone: "bad", label: "Plan did not finish", detail: "open it to see why" });
  } else if (isReady(client.insight?.status)) {
    signals.push({ tone: "ok", label: "Plan ready", detail: "what to do next is written up" });
  }

  if (report.stale) {
    signals.push({
      tone: "warn",
      label: "Report page is out of date",
      detail: `still showing ${report.publishedMonth ?? "an earlier month"}`,
    });
  } else if (report.built && !report.opened) {
    signals.push({ tone: "warn", label: `${report.label} report ready`, detail: "not opened yet" });
  } else if (report.url) {
    signals.push({ tone: "ok", label: "Report published", detail: report.label });
  }

  const worst = signals.some((s) => s.tone === "bad")
    ? "bad"
    : signals.some((s) => s.tone === "warn")
      ? "warn"
      : "ok";

  return (
    <div className={`ovrow glass ${worst}`}>
      <div className="ovhead">
        <div className="ovav">
          {client.avatarUrl ? (
            <img src={client.avatarUrl} alt="" />
          ) : (
            <span>{client.avatarSeed ?? client.name.slice(0, 2).toUpperCase()}</span>
          )}
        </div>
        <div className="ovname">
          <b>{client.name}</b>
          <div className="ovplats">
            {client.platforms.map((p) => (
              <Pf key={p.platform} p={PF_ID[p.platform]} size="sm" />
            ))}
          </div>
        </div>
        <div className="ovactions">
          {report.url && (
            <button
              className="btn ghost"
              title="Open the client's live report page"
              onClick={() => void openExternal(report.url!)}
            >
              View report
            </button>
          )}
          <button className="btn" onClick={() => onOpenInsights(client.id)}>
            What to do next
          </button>
        </div>
      </div>

      <div className="ovsignals">
        {signals.map((s, i) => (
          <Signal key={i} {...s} />
        ))}
      </div>
    </div>
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
  const { clients: knownClients } = useAppState();
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
  const needing = clients.filter((c) => c.attention > 0).length;
  const anyRunning = clients.some((c) => isRunning(c.insight?.status));

  // Poll only while a plan is actually being written, so a screen left open
  // overnight is not hitting the API every few seconds for nothing.
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  return (
    <section className="screen active" data-screen="account-overview">
      <div className="topbar">
        <div className="h">
          <h2>Account Overview</h2>
          <p>
            {loading
              ? "Checking every brand…"
              : needing === 0
                ? "Nothing needs you right now."
                : `${needing} brand${needing === 1 ? "" : "s"} need${needing === 1 ? "s" : ""} attention, most urgent first.`}
          </p>
        </div>
        <button className="btn ghost" onClick={() => void load()}>
          <svg>
            <use href="#i-refresh" />
          </svg>{" "}
          Refresh
        </button>
      </div>

      <div className="stage">
        {!loading && clients.length === 0 ? (
          <div className="card glass">
            <div className="empty">
              <div className="eic">
                <svg>
                  <use href="#i-users" />
                </svg>
              </div>
              <b>No brands enrolled</b>
              <p>Enroll a client and their status appears here.</p>
              <button className="btn" style={{ marginTop: 12 }} onClick={onOpenConnect}>
                Enroll a client
              </button>
            </div>
          </div>
        ) : (
          <div className="ovlist">
            {clients.map((c) => (
              <ClientRow key={c.id} client={c} onOpenInsights={onOpenInsights} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
