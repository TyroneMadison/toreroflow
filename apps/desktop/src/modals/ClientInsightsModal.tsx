import { useEffect, useState } from "react";
import Modal from "./Modal";
import Pf from "../components/Pf";
import { api, ApiError, type ClientAnalytics, type Suggestion } from "../lib/api";
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
  const [data, setData] = useState<ClientAnalytics | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

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

  const generate = async () => {
    setSuggesting(true);
    setSuggestError(null);
    try {
      const result = await api.post<{ suggestions: Suggestion[] }>(
        `/clients/${clientId}/suggestions`,
      );
      setSuggestions(result.suggestions);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setSuggestError(
          "AI suggestions need an Anthropic API key. Add ANTHROPIC_API_KEY to the repo .env and restart the API.",
        );
      } else {
        setSuggestError(err instanceof Error ? err.message : "suggestion request failed");
      }
    } finally {
      setSuggesting(false);
    }
  };

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
            <div className="sub">AI-generated moves to improve this brand's numbers</div>
          </div>
          <button className="cbtn" disabled={suggesting} onClick={() => void generate()}>
            {suggesting ? "Thinking…" : suggestions ? "Regenerate" : "Generate"}
          </button>
        </div>

        {suggestError && <div className="autherr">{suggestError}</div>}
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
