import { useCallback, useEffect, useState } from "react";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import { api, type WorkflowInfo } from "../lib/api";
import { PF_ID, PLATFORMS, PLATFORM_LABELS, SURFACE_LABEL, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import DmCampaigns from "../components/DmCampaigns";
import DmInbox from "../components/DmInbox";
import DriveAutoPost from "../components/DriveAutoPost";
import { Empty, ErrorState, Loading } from "../components/states";
import { useIsPhone } from "../lib/phone";
import { Ic, Sheet } from "../components/analytics/phoneBits";
import { JumpChips, SwipeDel, useSoftDelete } from "../components/mobile/FlowBits";
import SwipeRow from "../components/mobile/SwipeRow";

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
  const isPhone = useIsPhone();
  // Phone: the New workflow sheet, and the counts the area chips show.
  const [newOpen, setNewOpen] = useState(false);
  const [dmCount, setDmCount] = useState<number | null>(null);
  const [inboxNew, setInboxNew] = useState<number | null>(null);

  // Keyed on the id, so a client-list refresh (Sync accounts in Drive auto-post)
  // does not blank and reload the rules below.
  const clientId = selectedClient?.id;
  const load = useCallback(async () => {
    if (!clientId) {
      setWorkflows([]);
      return;
    }
    const list = await api.get<WorkflowInfo[]>(`/clients/${clientId}/workflows`);
    setWorkflows(list);
  }, [clientId]);

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
    if (!selectedClient || !name.trim() || destinations.length === 0) return false;
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
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create workflow");
      return false;
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

  // Phone: a swiped workflow goes at once and is deleted after the Undo toast.
  const { hidden, del: delWorkflow } = useSoftDelete(async (id) => {
    const w = workflows?.find((x) => x.id === id);
    try {
      await api.del(`/workflows/${id}`);
      await load();
    } catch (err) {
      toast.fail(`Could not delete ${w?.name ?? "that workflow"}`, err);
      throw err;
    }
  });

  if (isPhone) {
    // Phone (mobile pass): one page with area chips. Drive auto-post leads,
    // then the workflows as rows with a switch (swipe left to delete, with
    // Undo) under a banner saying they are saved but not running, New
    // workflow in a sheet, then the DM campaigns and the DM inbox.
    const shown = (workflows ?? []).filter((w) => !hidden.has(w.id));
    const hasMeta = (selectedClient?.accounts ?? []).some(
      (a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "facebook"),
    );
    return (
      <section className="screen active mb-page fl-page" data-screen="workflows" data-state={state}>
        <p className="mb-sub mb-subonly">Automations for {selectedClient?.name ?? "this brand"}. Drive auto-post runs on its own.</p>
        {!selectedClient ? (
          <Empty screen="workflows" title="No brand selected" hint="Pick a brand in the dock to manage its workflows." />
        ) : (
          <>
            <JumpChips
              label="Workflow areas"
              items={[
                { id: "fl-drive", label: "Drive auto-post" },
                { id: "fl-wf", label: <>Workflows {workflows && <small>{shown.length}</small>}</> },
                { id: "fl-dm", label: <>DM campaigns {dmCount !== null && <small>{dmCount}</small>}</> },
                ...(hasMeta ? [{ id: "fl-inbox", label: <>DM inbox {!!inboxNew && <small>{inboxNew} new</small>}</> }] : []),
              ]}
            />
            <DriveAutoPost client={selectedClient} />

            <div id="fl-wf" className="fl-areah">
              <h2 className="mb-h2">Workflows</h2>
              <button type="button" className="mb-btn sm ghost" data-testid="workflow-new" onClick={() => setNewOpen(true)}>
                <Ic name="i-plus" />
                New workflow
              </button>
            </div>
            <div className="mb-banner info fl-banner">
              <Ic name="i-info" />
              <div className="mb-bt">
                <b>Saved, not running yet</b>
                These rules say what should happen when a video posts to the source. Fan-out is not built, so a scheduled video only goes to
                the platforms you tick.
              </div>
            </div>
            {workflows === null ? (
              loadError ? (
                <ErrorState screen="workflows" message={loadError} onRetry={() => setReloadKey((k) => k + 1)} />
              ) : (
                <Loading screen="workflows" />
              )
            ) : shown.length === 0 ? (
              <div className="mb-card mb-empty">
                <div className="mb-ei">
                  <Ic name="i-bolt" />
                </div>
                <h3>No workflows yet</h3>
                <p>Create one to fan a single upload out across platforms.</p>
              </div>
            ) : (
              <>
                <section className="mb-card list fl-rows" aria-label="Workflows">
                  {shown.map((w) => (
                    <div key={w.id} className="fl-swwrap">
                      <SwipeDel />
                      <SwipeRow className="fl-swrow" onLeft={() => delWorkflow(w.id, w.name)}>
                        <div className="fl-wfrow" data-testid={`workflow-${w.id}`}>
                          <span className="mb-grow">
                            <b>{w.name}</b>
                            <span className="fl-flow">
                              <Pf p={PF_ID[w.sourcePlatform]} size="xs" />
                              <Ic name="i-arrow-r" />
                              {w.destinations.map((d) => (
                                <Pf key={d} p={PF_ID[d]} size="xs" />
                              ))}
                              {!w.enabled && <small>Paused</small>}
                            </span>
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={w.enabled}
                            aria-label={`${w.name} enabled`}
                            className="fl-sw"
                            data-testid={`workflow-toggle-${w.id}`}
                            onClick={() => void toggleEnabled(w)}
                          >
                            <span className={`mb-tog${w.enabled ? " on" : ""}`} aria-hidden="true" />
                          </button>
                        </div>
                      </SwipeRow>
                    </div>
                  ))}
                </section>
                <p className="fl-help fl-under">Swipe a workflow left to delete it.</p>
              </>
            )}

            <DmCampaigns client={selectedClient} onCount={setDmCount} />
            <DmInbox client={selectedClient} onNew={setInboxNew} />
          </>
        )}

        {newOpen && selectedClient && (
          <Sheet
            label="New workflow"
            title="New workflow"
            sub={`For ${selectedClient.name}. Kept for when fan-out is built.`}
            onClose={() => setNewOpen(false)}
            foot={
              <>
                <button type="button" className="mb-btn" onClick={() => setNewOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="mb-btn pri"
                  data-testid="workflow-create"
                  disabled={busy || !name.trim() || destinations.length === 0}
                  onClick={() => void create().then((ok) => ok && setNewOpen(false))}
                >
                  {busy ? "Creating…" : "Create workflow"}
                </button>
              </>
            }
          >
            <div className="mb-field">
              <label htmlFor="fl-wfname">Workflow name</label>
              <input id="fl-wfname" className="mb-input" placeholder="e.g. TikTok everywhere" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="mb-field">
              <span className="mb-flab">Source platform</span>
              <div className="fl-srcpick" role="radiogroup" aria-label="Source platform">
                {PLATFORMS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={source === p}
                    className={`mb-chip${source === p ? " on" : ""}`}
                    onClick={() => {
                      setSource(p);
                      setDestinations((prev) => prev.filter((d) => d !== p));
                    }}
                  >
                    <Pf p={PF_ID[p]} size="xs" />
                    {SURFACE_LABEL[p]}
                    {source === p && <small>Source</small>}
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-field">
              <span className="mb-flab">Auto-publish to</span>
              <div className="mb-card list">
                {PLATFORMS.filter((p) => p !== source).map((p) => {
                  const on = destinations.includes(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={`Auto-publish to ${PLATFORM_LABELS[p]}`}
                      data-testid={`workflow-dest-${p}`}
                      className="mb-lrow"
                      onClick={() => toggleDestination(p)}
                    >
                      <Pf p={PF_ID[p]} size="sm" />
                      <span className="mb-lt">
                        <b>{SURFACE_LABEL[p]}</b>
                        <small>{PLATFORM_LABELS[p]}</small>
                      </span>
                      <span className={`mb-tog${on ? " on" : ""}`} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
            {error && <div className="mb-err">{error}</div>}
          </Sheet>
        )}
      </section>
    );
  }

  return (
    <section className="screen active" data-screen="workflows" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Workflows</h2>
          <p>
            Automations for this brand. Drive auto-post runs on its own. The fan-out rules
            below are saved but nothing runs them yet, so a scheduled video only goes to the
            platforms you tick.
          </p>
        </div>
      </div>
      <div className="stage">
        {selectedClient && <DriveAutoPost client={selectedClient} />}
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
