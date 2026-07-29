import { useCallback, useEffect, useRef, useState } from "react";
import { isReady, isRunning } from "@toreroflow/core";
import Modal from "./Modal";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import {
  api,
  ApiError,
  fileUrl,
  type ClientAnalytics,
  type ClientInsight,
} from "../lib/api";
import { openExternal } from "../lib/external";
import { PF_ID, PLATFORM_LABELS } from "../lib/platforms";

interface ClientInsightsModalProps {
  clientId: string;
  onClose: () => void;
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ClientInsightsModal({ clientId, onClose }: ClientInsightsModalProps) {
  const toast = useToast();
  const [data, setData] = useState<ClientAnalytics | null>(null);
  const [insight, setInsight] = useState<ClientInsight | null>(null);
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get<ClientAnalytics>(`/clients/${clientId}/analytics`)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const loadInsight = useCallback(async () => {
    try {
      const row = await api.get<ClientInsight | null>(`/clients/${clientId}/suggestions`);
      if (alive.current) setInsight(row);
    } catch {
      // Polls stay silent. A finished run is on the row either way, and the
      // operator was told they could walk away from this screen.
    }
  }, [clientId]);

  // A finished run is already stored, so reopening shows it without paying
  // for the model again.
  useEffect(() => {
    void loadInsight();
  }, [loadInsight]);

  // Poll only while the worker is actually doing something.
  useEffect(() => {
    if (!isRunning(insight?.status)) return;
    const t = setInterval(() => void loadInsight(), 3000);
    return () => clearInterval(t);
  }, [insight?.status, loadInsight]);

  const generate = async () => {
    setStarting(true);
    try {
      // Returns as soon as the run is queued: the work happens on the worker.
      setInsight(await api.post<ClientInsight>(`/clients/${clientId}/suggestions`));
    } catch (err) {
      // A missing key comes back as a 503, and the fix is the whole message.
      if (err instanceof ApiError && err.status === 503) {
        toast.error(
          "AI suggestions need an Anthropic API key. Add ANTHROPIC_API_KEY to the repo .env and restart the API.",
        );
      } else {
        toast.fail("Could not start the plan", err);
      }
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  const running = isRunning(insight?.status);
  const suggestions = isReady(insight?.status) ? insight?.suggestions : null;
  const pdfUrl = isReady(insight?.status) ? fileUrl(insight?.url ?? null) : null;

  return (
    <Modal maxWidth={640} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>{data?.client.name ?? "Client"} - analytics</h3>
          <p>Live metrics land daily once ingestion starts; suggestions work now.</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <div className="kpis" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
          <div className="kpi glass-sm">
            <div className="lab">Views</div>
            <div className="val">{fmt(data?.totals.views ?? null)}</div>
          </div>
          <div className="kpi glass-sm">
            <div className="lab">Reach</div>
            <div className="val">{fmt(data?.totals.reach ?? null)}</div>
          </div>
          <div className="kpi glass-sm">
            <div className="lab">Followers</div>
            <div className="val">{fmt(data?.totals.followers ?? null)}</div>
          </div>
        </div>

        <label className="flabel" style={{ marginTop: 18 }}>
          Platforms
        </label>
        {data?.accounts.length ? (
          data.accounts.map((a) => (
            <div className="best" key={a.id}>
              <div className="l">
                <Pf p={PF_ID[a.platform]} size="sm" /> {PLATFORM_LABELS[a.platform]}{" "}
                <span style={{ color: "var(--txt-3)" }}>@{a.handle}</span>
              </div>
              <b>{a.latest ? `${fmt(a.latest.views)} views` : "no data yet"}</b>
            </div>
          ))
        ) : (
          <p style={{ fontSize: 12.5, color: "var(--txt-3)", marginTop: 4 }}>
            No platforms connected yet - connect them in Settings → Connected Accounts.
          </p>
        )}

        <div className="rowhead" style={{ marginTop: 20, marginBottom: 4 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 620 }}>Deep research suggestions</h3>
            <div className="sub">
              {running
                ? "Working on it. You can close this and carry on."
                : "AI-generated moves to improve this brand's numbers"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {pdfUrl && (
              <button className="cbtn" onClick={() => void openExternal(pdfUrl)}>
                Open PDF
              </button>
            )}
            <button className="cbtn" disabled={starting || running} onClick={() => void generate()}>
              {running ? "Working…" : suggestions ? "Regenerate" : "Generate"}
            </button>
          </div>
        </div>

        {running && (
          <p className="insworking">
            The plan is being written in the background. It will be here when you come back, and
            it saves itself as a PDF.
          </p>
        )}

        {insight?.status === "failed" && (
          <p className="insfailed">
            That run did not finish: {insight.error ?? "unknown error"}
          </p>
        )}

        {suggestions?.map((s, i) => (
          <div className="sugg" key={i}>
            <span className="cat">{s.category}</span>
            <div className="body">
              <b>{s.title}</b>
              <p>{s.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
