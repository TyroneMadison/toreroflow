import { useCallback, useEffect, useRef, useState } from "react";
import { isReady, isRunning } from "@toreroflow/core";
import Modal from "./Modal";
import Select from "../components/Select";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import {
  api,
  ApiError,
  fileUrl,
  type ClientAnalytics,
  type ClientInsight,
  type InspirationsView,
} from "../lib/api";
import { openExternal } from "../lib/external";
import { PF_ID, PLATFORM_LABELS } from "../lib/platforms";
import { useIsPhone } from "../lib/phone";
import { navigate } from "../lib/routes";
import { useAppState } from "../state/AppState";
import BrandAvatar from "../components/BrandAvatar";
import ConfirmSheet from "../components/mobile/ConfirmSheet";
import { Ic, PickSheet } from "../components/analytics/phoneBits";

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

  /* ---- competitor research ---- */
  const [insp, setInsp] = useState<InspirationsView | null>(null);
  const [newHandle, setNewHandle] = useState("");
  const [newPlatform, setNewPlatform] = useState("both");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const isPhone = useIsPhone();
  const { clients, selectClient } = useAppState();
  const [pickPlatform, setPickPlatform] = useState(false);
  const [allSugg, setAllSugg] = useState(false);
  const [askRemove, setAskRemove] = useState<{ id: string; handle: string } | null>(null);

  const loadInspirations = useCallback(async () => {
    try {
      const v = await api.get<InspirationsView>(`/clients/${clientId}/inspirations`);
      if (alive.current) setInsp(v);
    } catch {
      // Silent: this section is additive, and a failure here should not eat
      // the analytics the operator opened this modal for.
    }
  }, [clientId]);

  useEffect(() => {
    void loadInspirations();
  }, [loadInspirations]);

  const researching = isRunning(insp?.run?.status);

  // Poll only while a run is actually spending money.
  useEffect(() => {
    if (!researching) return;
    const t = setInterval(() => void loadInspirations(), 3000);
    return () => clearInterval(t);
  }, [researching, loadInspirations]);

  const addInspiration = async () => {
    const handle = newHandle.trim();
    if (!handle) return;
    setNewHandle("");
    try {
      await api.post(`/clients/${clientId}/inspirations`, {
        accounts: [{ handle, platform: newPlatform }],
      });
      await loadInspirations();
    } catch (err) {
      toast.fail("Could not add that account", err);
    }
  };

  /**
   * Removing an account takes its research with it: the snapshot rows hang off
   * it and go when it goes. That is a paid fetch thrown away, which is why the
   * button arms first rather than deleting on a single click.
   */
  const removeInspiration = async (id: string) => {
    try {
      await api.del(`/inspirations/${id}`);
      await loadInspirations();
    } catch (err) {
      toast.fail("Could not remove that account", err);
    }
  };

  const startResearch = async () => {
    try {
      await api.post(`/clients/${clientId}/research`);
      await loadInspirations();
    } catch (err) {
      toast.fail("Could not start the research", err);
    }
  };

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  const running = isRunning(insight?.status);
  const suggestions = isReady(insight?.status) ? insight?.suggestions : null;
  const pdfUrl = isReady(insight?.status) ? fileUrl(insight?.url ?? null) : null;

  // Phone sheet (mobile pass, mockup "m-client-insights"): the brand in the
  // head, three tiles and the accounts by views, research as tagged cards
  // (top three, See more), the accounts they want to be like with Remove
  // (asks first) and the add row, and Research as the footer's main button.
  // Same state and calls as the desktop dialog.
  if (isPhone) {
    const client = clients.find((c) => c.id === clientId);
    const name = data?.client.name ?? client?.name ?? "Client";
    const byViews = [...(data?.accounts ?? [])].sort((a, b) => (b.latest?.views ?? -1) - (a.latest?.views ?? -1));
    const shown = suggestions ? (allSugg ? suggestions : suggestions.slice(0, 3)) : [];
    const PLATFORM_CHOICES = [
      { value: "both", label: "Both" },
      { value: "instagram", label: "Instagram" },
      { value: "tiktok", label: "TikTok" },
    ];
    return (
      <Modal maxWidth={640} onClose={onClose} label={`${name} analytics`} testId="client-insights">
        <div className="modal-head rp-cihead">
          {client && <BrandAvatar client={client} index={clients.indexOf(client)} size={44} />}
          <div>
            <h3>{name}</h3>
            <p>{running ? "Working on new suggestions. You can close this." : "Analytics · live metrics land daily"}</p>
          </div>
          <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
            <svg>
              <use href="#i-x" />
            </svg>
          </button>
        </div>
        <div className="modal-body rp-ci">
          <div className="rp-stats three">
            {(
              [
                ["Views", data?.totals.views],
                ["Reach", data?.totals.reach],
                ["Followers", data?.totals.followers],
              ] as const
            ).map(([k, v]) => (
              <div className="rp-stat" key={k}>
                <div className="k">{k}</div>
                <div className="v">{fmt(v ?? null)}</div>
              </div>
            ))}
          </div>
          {byViews.length ? (
            <div className="mb-card list rp-ciacc">
              {byViews.map((a) => (
                <div className="mb-lrow" key={a.id}>
                  <Pf p={PF_ID[a.platform]} size="sm" />
                  <span className="mb-lt">
                    <b>
                      {PLATFORM_LABELS[a.platform]} <span className="rp-muted">@{a.handle}</span>
                    </b>
                  </span>
                  <b className="rp-civ">{a.latest ? fmt(a.latest.views) : "no data yet"}</b>
                </div>
              ))}
            </div>
          ) : (
            <p className="rp-note">No platforms connected yet. Connect them in Settings, Connected accounts.</p>
          )}

          <div className="rp-rowsb rp-cisec">
            <div>
              <h3 className="rp-h3">Deep research</h3>
              <small className="rp-muted">
                {running ? "Working on it. You can close this and carry on." : "AI moves to improve this brand's numbers"}
              </small>
            </div>
            {pdfUrl && (
              <button type="button" className="mb-btn sm ghost" onClick={() => void openExternal(pdfUrl)}>
                <Ic name="i-dl" />
                PDF
              </button>
            )}
          </div>
          {running && (
            <p className="rp-note">
              The plan is being written in the background. It will be here when you come back, and it saves itself as a PDF.
            </p>
          )}
          {insight?.status === "failed" && <div className="mb-err">That run did not finish: {insight.error ?? "unknown error"}</div>}
          {shown.map((s, i) => (
            <div className="rp-sg" key={i}>
              <span className="rp-tg">{s.category}</span>
              <b>{s.title}</b>
              <p>{s.detail}</p>
            </div>
          ))}
          <div className="rp-cilinks">
            {suggestions && suggestions.length > 3 && (
              <button type="button" className="mb-btn text sm" aria-expanded={allSugg} onClick={() => setAllSugg((v) => !v)}>
                {allSugg ? "Show fewer" : `See ${suggestions.length - 3} more`}
              </button>
            )}
            <button type="button" className="mb-btn text sm" disabled={starting || running} onClick={() => void generate()}>
              {running ? "Working" : suggestions ? "Regenerate" : "Generate"}
            </button>
          </div>

          <div className="rp-cisec">
            <h3 className="rp-h3">Accounts they want to be like</h3>
            <small className="rp-muted">
              {researching ? "Pulling what these accounts have been posting." : "What is working for them on Instagram and TikTok"}
            </small>
          </div>
          {insp?.run?.error && <div className="mb-err">{insp.run.error}</div>}
          {insp && insp.accounts.length > 0 && (
            <div className="mb-card list rp-ciacc">
              {insp.accounts.map((a) => (
                <div className="mb-lrow" key={a.id}>
                  {a.platform === "instagram" || a.platform === "tiktok" ? (
                    <Pf p={PF_ID[a.platform]} size="sm" />
                  ) : (
                    <span className="rp-pfpair">
                      <Pf p="ig" size="xs" />
                      <Pf p="tt" size="xs" />
                    </span>
                  )}
                  <span className="mb-lt">
                    <b>@{a.handle}</b>
                    <small className={a.error ? "rp-warn" : undefined}>
                      {a.error
                        ? a.error
                        : a.lastFetchedAt
                          ? `Last pulled ${new Date(a.lastFetchedAt).toLocaleDateString([], { month: "short", day: "numeric" })}`
                          : a.resolved
                            ? "Found, not pulled yet"
                            : "Not looked up yet"}
                    </small>
                  </span>
                  <button type="button" className="mb-ib ghost" aria-label={`Remove @${a.handle}`} onClick={() => setAskRemove({ id: a.id, handle: a.handle })}>
                    <Ic name="i-x" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {insp && insp.accounts.length === 0 && (
            <p className="rp-note">
              No accounts yet. New clients name 5 of these when they sign up; add them by hand for anyone who joined before that.
            </p>
          )}
          <div className="rp-ciadd">
            <input
              className="mb-input"
              placeholder="@handle or a profile link"
              aria-label="Account to add, a handle or a profile link"
              value={newHandle}
              enterKeyHint="done"
              autoCapitalize="none"
              onChange={(e) => setNewHandle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addInspiration();
              }}
            />
            <button type="button" className="mb-btn rp-ciplat" aria-haspopup="dialog" aria-label="Which app this account is on" onClick={() => setPickPlatform(true)}>
              {PLATFORM_CHOICES.find((o) => o.value === newPlatform)?.label}
              <Ic name="i-chev" />
            </button>
            <button type="button" className="mb-btn" disabled={!newHandle.trim()} onClick={() => void addInspiration()}>
              Add
            </button>
          </div>
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="mb-btn ghost"
            onClick={() => {
              selectClient(clientId);
              navigate("analytics");
              onClose();
            }}
          >
            Open Analytics
          </button>
          {insp && insp.accounts.length > 0 && (
            <button type="button" className="mb-btn pri rp-cimain" disabled={researching} onClick={() => void startResearch()}>
              {researching ? "Working" : `Research (${money(insp.quoteCents)})`}
            </button>
          )}
        </div>
        {pickPlatform && (
          <PickSheet label="Which app" value={newPlatform} options={PLATFORM_CHOICES} onPick={setNewPlatform} onClose={() => setPickPlatform(false)} top />
        )}
        {askRemove && (
          <ConfirmSheet
            title={`Remove @${askRemove.handle}?`}
            body="Anything already pulled for this account goes with it."
            confirm="Remove"
            danger
            onClose={() => setAskRemove(null)}
            onConfirm={() => {
              const id = askRemove.id;
              setAskRemove(null);
              void removeInspiration(id);
            }}
          />
        )}
      </Modal>
    );
  }

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
        <div className="kpis stagger" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
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

        <div className="rowhead" style={{ marginTop: 22, marginBottom: 4 }}>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 620 }}>Accounts they want to be like</h3>
            <div className="sub">
              {researching
                ? "Pulling what these accounts have been posting."
                : "We look at what is working for them on Instagram and TikTok."}
            </div>
          </div>
          {insp && insp.accounts.length > 0 && (
            <button className="cbtn" disabled={researching} onClick={() => void startResearch()}>
              {researching ? "Working…" : `Research (${money(insp.quoteCents)})`}
            </button>
          )}
        </div>

        {insp?.run?.error && <p className="insfailed">{insp.run.error}</p>}

        {insp?.accounts.map((a) => (
          <div className="sugg" key={a.id}>
            <span className="cat">{a.platform}</span>
            <div className="body">
              <b>@{a.handle}</b>
              <p>
                {a.error
                  ? a.error
                  : a.lastFetchedAt
                    ? `Last pulled ${new Date(a.lastFetchedAt).toLocaleDateString()}`
                    : a.resolved
                      ? "Found, not pulled yet"
                      : "Not looked up yet"}
              </p>
            </div>
            <span
              className={`qdel${confirmRemove === a.id ? " armed" : ""}`}
              title={
                confirmRemove === a.id
                  ? "Click again to remove this account and anything pulled for it"
                  : `Remove @${a.handle}`
              }
              onClick={() => {
                if (confirmRemove === a.id) {
                  setConfirmRemove(null);
                  void removeInspiration(a.id);
                } else {
                  setConfirmRemove(a.id);
                  setTimeout(() => setConfirmRemove((c) => (c === a.id ? null : c)), 4000);
                }
              }}
            >
              {confirmRemove === a.id ? (
                "remove?"
              ) : (
                <svg>
                  <use href="#i-x" />
                </svg>
              )}
            </span>
          </div>
        ))}

        {insp && insp.accounts.length === 0 && (
          <p className="insworking">
            No accounts yet. New clients name 5 of these when they sign up; add them by hand
            for anyone who joined before that.
          </p>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            className="field-in"
            style={{ flex: 1 }}
            placeholder="@handle or a profile link"
            value={newHandle}
            onChange={(e) => setNewHandle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addInspiration();
            }}
          />
          <Select
            style={{ width: 130 }}
            value={newPlatform}
            onChange={setNewPlatform}
            aria-label="Which app this account is on"
            options={[
              { value: "both", label: "Both" },
              { value: "instagram", label: "Instagram" },
              { value: "tiktok", label: "TikTok" },
            ]}
          />
          <button className="cbtn" onClick={() => void addInspiration()}>
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}
