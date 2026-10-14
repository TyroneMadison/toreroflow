import { useCallback, useEffect, useState } from "react";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import { api, type WorkflowInfo } from "../lib/api";
import { PF_ID, PLATFORMS, PLATFORM_LABELS, SURFACE_LABEL, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import DmCampaigns from "../components/DmCampaigns";
import DmInbox from "../components/DmInbox";
import { Empty, ErrorState, Loading } from "../components/states";

export default function WorkflowsScreen() {
  const { selectedClient } = useAppState();
  const toast = useToast();
  // null until the first list lands for this brand.
  const [workflows, setWorkflows] = useState<WorkflowInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [name, setName] = useState("");
  const [source, setSource] = useState<Platform>("instagram");
  const [destinations, setDestinations] = useState<Platform[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedClient) {
      setWorkflows([]);
      return;
    }
    const list = await api.get<WorkflowInfo[]>(`/clients/${selectedClient.id}/workflows`);
    setWorkflows(list);
  }, [selectedClient]);

  // Reloads after an edit throw into that edit's own catch; only this first
  // load feeds the screen's error state.
  useEffect(() => {
    setWorkflows(null);
    setLoadError(null);
    load().catch((err) => setLoadError(err instanceof Error ? err.message : "could not load workflows"));
  }, [load, reloadKey]);

  const state = !selectedClient ? "empty" : workflows === null ? (loadError ? "error" : "loading") : "ready";

  const toggleDestination = (p: Platform) => {
    if (p === source) return;
    setDestinations((prev) =>
      prev.includes(p) ? prev.filter((d) => d !== p) : [...prev, p],
    );
  };

  const create = async () => {
    if (!selectedClient || !name.trim() || destinations.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/clients/${selectedClient.id}/workflows`, {
        name: name.trim(),
        sourcePlatform: source,
        destinations,
      });
      setName("");
      setDestinations([]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create workflow");
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (w: WorkflowInfo) => {
    try {
      await api.patch(`/workflows/${w.id}`, { enabled: !w.enabled });
      await load();
    } catch (err) {
      // The switch only moves once the reload lands, so a silent failure looks
      // like the click never registered.
      toast.fail(`Could not ${w.enabled ? "pause" : "enable"} ${w.name}`, err);
    }
  };

  const remove = async (w: WorkflowInfo) => {
    try {
      await api.del(`/workflows/${w.id}`);
      await load();
    } catch (err) {
      toast.fail(`Could not delete ${w.name}`, err);
    }
  };

  return (
    <section className="screen active" data-screen="workflows" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Workflows</h2>
          <p>
            Fan-out rules for reposting one upload across platforms. Saved here, but
            nothing runs them yet, so a video only ever goes to the platforms you tick
            when you schedule it.
          </p>
        </div>
      </div>
      <div className="stage">
        {!selectedClient ? (
          <Empty
            screen="workflows"
            title="No brand selected"
            hint="Pick a brand in the dock to manage its workflows."
          />
        ) : workflows === null ? (
          loadError ? (
            <ErrorState screen="workflows" message={loadError} onRetry={() => setReloadKey((k) => k + 1)} />
          ) : (
            <Loading screen="workflows" />
          )
        ) : (
          <div className="split">
            <div>
              <div className="card glass">
                <h3>New workflow for {selectedClient.name}</h3>
                <div className="sub" style={{ marginBottom: 14 }}>
                  Describes what should happen when a video is posted to the source. Kept
                  for when fan-out is built; it does not repost anything today.
                </div>

                <label className="flabel">Workflow name</label>
                <input
                  className="field-in"
                  placeholder="e.g. TikTok everywhere"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />

                <label className="flabel" style={{ marginTop: 16 }}>
                  Source platform
                </label>
                <div className="ptabs">
                  {PLATFORMS.map((p) => (
                    <div
                      key={p}
                      className={`ptab${source === p ? " on src" : ""}`}
                      onClick={() => {
                        setSource(p);
                        setDestinations((prev) => prev.filter((d) => d !== p));
                      }}
                    >
                      <Pf p={PF_ID[p]} size="sm" /> {SURFACE_LABEL[p]}
                      {source === p && <span className="srctag">SOURCE</span>}
                    </div>
                  ))}
                </div>

                <label className="flabel" style={{ marginTop: 12 }}>
                  Auto-publish to
                </label>
                <div className="toggles" style={{ marginTop: 8 }}>
                  {PLATFORMS.filter((p) => p !== source).map((p) => {
                    const on = destinations.includes(p);
                    return (
                      <div
                        key={p}
                        className={`pt${on ? " on" : ""}`}
                        role="switch"
                        aria-checked={on}
                        aria-label={`Auto-publish to ${PLATFORM_LABELS[p]}`}
                        tabIndex={0}
                        data-testid={`workflow-dest-${p}`}
                        onClick={() => toggleDestination(p)}
                        onKeyDown={(e) => {
                          if (e.key === " " || e.key === "Enter") {
                            e.preventDefault();
                            toggleDestination(p);
                          }
                        }}
                      >
                        <Pf p={PF_ID[p]} />
                        <div className="info">
                          <b>{SURFACE_LABEL[p]}</b>
                          <span>{PLATFORM_LABELS[p]}</span>
                        </div>
                        <div className="switch" />
                      </div>
                    );
                  })}
                </div>

                {error && <div className="autherr">{error}</div>}

                <div className="schedrow">
                  <button
                    className="btn"
                    data-testid="workflow-create"
                    style={{ marginLeft: "auto" }}
                    disabled={busy || !name.trim() || destinations.length === 0}
                    onClick={() => void create()}
                  >
                    <svg>
                      <use href="#i-bolt" />
                    </svg>{" "}
                    {busy ? "Creating…" : "Create workflow"}
                  </button>
                </div>
              </div>
            </div>

            <div>
              <div className="card glass">
                <div className="rowhead">
                  <h3>Active workflows</h3>
                </div>
                {workflows.length === 0 ? (
                  <div className="empty">
                    <div className="eic">
                      <svg>
                        <use href="#i-bolt" />
                      </svg>
                    </div>
                    <b>No workflows yet</b>
                    <p>Create one to fan a single upload out across platforms.</p>
                  </div>
                ) : (
                  workflows.map((w) => (
                    <div className="best" key={w.id} style={{ alignItems: "center" }} data-testid={`workflow-${w.id}`}>
                      <div className="l" style={{ flexWrap: "wrap" }}>
                        <Pf p={PF_ID[w.sourcePlatform]} size="sm" />
                        <span style={{ color: "var(--txt-3)" }}>→</span>
                        {w.destinations.map((d) => (
                          <Pf key={d} p={PF_ID[d]} size="sm" />
                        ))}
                        <span style={{ fontWeight: 600 }}>{w.name}</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <div
                          className={`switch${w.enabled ? " on" : ""}`}
                          style={{ cursor: "pointer" }}
                          title={w.enabled ? "Enabled - click to pause" : "Paused - click to enable"}
                          role="switch"
                          aria-checked={w.enabled}
                          aria-label={`${w.name} enabled`}
                          tabIndex={0}
                          data-testid={`workflow-toggle-${w.id}`}
                          onClick={() => void toggleEnabled(w)}
                          onKeyDown={(e) => {
                            if (e.key === " " || e.key === "Enter") {
                              e.preventDefault();
                              void toggleEnabled(w);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="link"
                          style={{ color: "var(--red)", background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer" }}
                          aria-label={`Delete workflow ${w.name}`}
                          data-testid={`workflow-delete-${w.id}`}
                          onClick={() => void remove(w)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
        {selectedClient && <DmCampaigns client={selectedClient} />}
        {selectedClient && <DmInbox client={selectedClient} />}
      </div>
    </section>
  );
}
