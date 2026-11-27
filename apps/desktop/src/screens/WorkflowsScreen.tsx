import { useCallback, useEffect, useRef, useState } from "react";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import { api, type WorkflowInfo } from "../lib/api";
import { PF_ID, PLATFORMS, PLATFORM_LABELS, SURFACE_LABEL, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import Automations from "../components/automations/Automations";
import Inbox from "../components/inbox/Inbox";
import Contacts from "../components/inbox/Contacts";
import DriveAutoPost from "../components/DriveAutoPost";
import { Empty, ErrorState, Loading } from "../components/states";
import { useIsPhone } from "../lib/phone";
import { Ic, Sheet } from "../components/analytics/phoneBits";
import { JumpChips, SwipeDel, useSoftDelete } from "../components/mobile/FlowBits";
import SwipeRow from "../components/mobile/SwipeRow";
import { linkProps, navigate, useRoute, WORKFLOW_AREAS, type WorkflowArea } from "../lib/routes";
import type { ClientSummary } from "../lib/api";

/** Desktop and web: Workflows' seven areas in a slim rail (round 2 mockups).
 *  Areas whose screens ship later in this update show a labelled placeholder. */
const AREA_ICON: Record<WorkflowArea | "overview", string> = {
  overview: "#i-dash",
  inbox: "#i-inbox",
  automations: "#i-bolt",
  "ai-replies": "#i-spark",
  contacts: "#i-users",
  metrics: "#i-chart",
  "auto-post": "#i-drive",
};
const SOON = new Set<WorkflowArea>(["ai-replies", "metrics"]);
const SOON_LINE: Partial<Record<WorkflowArea, (brand: string) => string>> = {
  "ai-replies": (b) => `Answers DMs for ${b} and hands the chat to your team when it is not sure. Off until you turn it on.`,
  metrics: () => "How DMs and automations did: runs, replies, click-throughs and where people drop off.",
};

function WorkflowRail({ area, client, inboxNew, mini = false }: { area: WorkflowArea | null; client: ClientSummary | null; inboxNew: number | null; mini?: boolean }) {
  const dm = (client?.accounts ?? []).filter((a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "facebook"));
  const names = dm.map((a) => (a.platform === "instagram" ? `@${a.handle.replace(/^@/, "")}` : "Messenger"));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const rows: Array<{ id: WorkflowArea | null; label: string }> = [{ id: null, label: "Overview" }, ...WORKFLOW_AREAS];
  return (
    <nav className={`wfr-rail${mini ? " slim" : ""}`} aria-label="Workflows">
      <div className="lbl">Workflows</div>
      {rows.map((r) => {
        const on = r.id === area;
        return (
          <a
            key={r.id ?? "overview"}
            className={`wfr-ri${on ? " on" : ""}`}
            aria-current={on ? "page" : undefined}
            aria-label={mini ? r.label : undefined}
            title={mini ? r.label : undefined}
            {...linkProps("workflows", r.id)}
            data-testid={`workflows.area.${r.id ?? "overview"}`}
          >
            <svg aria-hidden="true">
              <use href={AREA_ICON[r.id ?? "overview"]} />
            </svg>
            <span>{r.label}</span>
            {r.id === "inbox" && !!inboxNew && (
              <span className="cnt">
                {inboxNew}
                <span className="vh"> new</span>
              </span>
            )}
            {r.id && SOON.has(r.id) && <span className="tail">Soon</span>}
          </a>
        );
      })}
      <div className="wfr-foot">
        {dm.length ? `${dm.length} ${dm.length === 1 ? "account" : "accounts"} connected: ${list}` : "No Instagram or Facebook account connected yet"}
      </div>
    </nav>
  );
}

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
  const [inboxNew, setInboxNew] = useState<number | null>(null);
  const { section, item } = useRoute();
  const area = WORKFLOW_AREAS.find((a) => a.id === section)?.id ?? null;
  // The phone chip row scrolls to the area it is on, the one before peeking (as PageHeader does).
  const areaRow = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = areaRow.current;
    const on = row?.querySelector<HTMLElement>(".on");
    if (row && on) row.scrollLeft = Math.max(0, on.offsetLeft - 48);
  }, [area, isPhone]);
  // Contacts' "Open conversation" lands on this thread in the Inbox.
  const [openThread, setOpenThread] = useState<string | null>(null);
  const openFromContacts = useCallback((threadId: string) => {
    setOpenThread(threadId);
    navigate("workflows", "inbox");
  }, []);
  const hasDm = (selectedClient?.accounts ?? []).some(
    (a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "facebook"),
  );
  // The rail's and the phone chip's unread count while the Inbox itself is not
  // open (it reports its own while it is): one small read per brand and area.
  useEffect(() => {
    if (!selectedClient || !hasDm || area === "inbox") return;
    let live = true;
    api
      .get<{ counts: { unread: number } }>(`/clients/${selectedClient.id}/dm/threads?limit=1`)
      .then((r) => live && setInboxNew(r.counts.unread))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [selectedClient, hasDm, area]);

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
    // Phone: the area chips under the title (mockups 02a, 04), with the Inbox
    // chip carrying the unread count. Overview is the mobile-pass page: Drive
    // auto-post and the workflows as rows with a switch (swipe left to delete,
    // with Undo) under the "saved, not running" banner, New workflow in a
    // sheet. Inbox, Automations and Contacts are their own screens; the
    // automation editor is a deeper page (Back in the app bar, no chips).
    const shown = (workflows ?? []).filter((w) => !hidden.has(w.id));
    const showDrive = area === null || area === "auto-post";
    const areaRows: Array<{ id: WorkflowArea | null; label: string }> = [{ id: null, label: "Overview" }, ...WORKFLOW_AREAS];
    return (
      <section className="screen active mb-page fl-page" data-screen="workflows" data-state={state} data-area={area ?? "overview"}>
        {area === null && <p className="mb-sub mb-subonly">Automations for {selectedClient?.name ?? "this brand"}. Drive auto-post runs on its own.</p>}
        {!item && <nav className="mb-chips wf-areas" aria-label="Workflow areas" ref={areaRow}>
          {areaRows.map((r) => (
            <a
              key={r.id ?? "overview"}
              className={"mb-chip" + (r.id === area ? " on" : "")}
              aria-current={r.id === area ? "page" : undefined}
              {...linkProps("workflows", r.id)}
              data-testid={"workflows.area." + (r.id ?? "overview")}
            >
              {r.label}
              {r.id === "inbox" && !!inboxNew && (
                <span className="cnt">
                  {inboxNew}
                  <span className="vh"> new</span>
                </span>
              )}
            </a>
          ))}
        </nav>}
        {!selectedClient ? (
          <Empty screen="workflows" title="No brand selected" hint="Pick a brand in the dock to manage its workflows." />
        ) : area === "inbox" ? (
          <Inbox client={selectedClient} onUnread={setInboxNew} initialThreadId={openThread} />
        ) : area === "contacts" ? (
          <Contacts client={selectedClient} onOpenThread={openFromContacts} />
        ) : area === "automations" ? (
          <Automations client={selectedClient} />
        ) : area && SOON.has(area) ? (
          <section className="mb-card wf-soon-ph" data-testid={"workflows.soon." + area}>
            <b>{WORKFLOW_AREAS.find((a) => a.id === area)!.label}: coming soon</b>
            <p>{SOON_LINE[area]!(selectedClient.name)}</p>
          </section>
        ) : (
          <>
            {area === null && (
              <JumpChips
                label="Workflow sections"
                items={[
                  { id: "fl-drive", label: "Drive auto-post" },
                  { id: "fl-wf", label: <>Workflows {workflows && <small>{shown.length}</small>}</> },
                ]}
              />
            )}
            {showDrive && <DriveAutoPost client={selectedClient} />}

            {showDrive && <><div id="fl-wf" className="fl-areah">
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
            </>}
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

  // Fan-out rules: the new-rule form and the saved rules. Overview and Auto-post both show them.
  const rules = !selectedClient ? (
    <Empty screen="workflows" title="No brand selected" hint="Pick a brand in the dock to manage its workflows." />
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
  );

  const brand = selectedClient?.name ?? "this brand";
  return (
    <section className="screen active" data-screen="workflows" data-state={state} data-area={area ?? "overview"}>
      <div className={`wfr${item ? " slim" : ""}`}>
        <WorkflowRail area={area} client={selectedClient} inboxNew={inboxNew} mini={!!item} />
        <div className="wfr-body">
          {area === null && (
            <>
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
                {rules}
              </div>
            </>
          )}
          {area === "inbox" &&
            (selectedClient ? (
              <Inbox client={selectedClient} onUnread={setInboxNew} initialThreadId={openThread} />
            ) : (
              <Empty screen="workflows" title="No brand selected" hint="Pick a brand in the dock to see its DMs." />
            ))}
          {area === "contacts" &&
            (selectedClient ? (
              <Contacts client={selectedClient} onOpenThread={openFromContacts} />
            ) : (
              <Empty screen="workflows" title="No brand selected" hint="Pick a brand in the dock to see its contacts." />
            ))}
          {area === "automations" &&
            (selectedClient ? (
              <Automations client={selectedClient} />
            ) : (
              <Empty screen="workflows" title="No brand selected" hint="Pick a brand in the dock to see its automations." />
            ))}
          {area === "auto-post" && (
            <>
              {selectedClient && <DriveAutoPost client={selectedClient} />}
              {rules}
            </>
          )}
          {area && SOON.has(area) && (
            <section className="card glass wfr-soon" data-testid={`workflows.soon.${area}`}>
              <div className="eic">
                <svg aria-hidden="true">
                  <use href={AREA_ICON[area]} />
                </svg>
              </div>
              <b>{WORKFLOW_AREAS.find((a) => a.id === area)!.label}: coming soon in this update</b>
              <p>{SOON_LINE[area]!(brand)}</p>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
