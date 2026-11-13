import { useCallback, useEffect, useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  canEditTemplates,
  canOverridePreflight,
  OverrideRequestSchema,
  resolveTarget,
  type CadenceSuggestions,
  type Draft,
  type Issue,
  type OverrideField,
  type PreflightResult,
  type QueueItem,
  type Rollup,
  type Template,
  type WorkflowPlatform,
} from "@toreroflow/contracts";
import { api, ApiError, getToken, videoLabel, type MediaAssetInfo, type PostTargetInfo } from "../lib/api";
import { navigatePath, pathLinkProps, setQuery, useRoute } from "../lib/routes";
import {
  blankTemplate,
  draftProblem,
  fieldFromHash,
  fieldId,
  fixHref,
  fixLabel,
  fixTarget,
  fmtMetric,
  formToTemplate,
  fromLocalInput,
  isOverridden,
  loadStashedDraft,
  METRIC_LABEL,
  moveId,
  newDraft,
  PLATFORM_LABEL,
  preflightBody,
  preflightErrorText,
  preflightSummary,
  principalFrom,
  queueOrder,
  resetField,
  rollupHasData,
  saveErrorText,
  setOverride,
  setTargets,
  stashDraft,
  templateToForm,
  toLocalInput,
  upsertBody,
  WORKFLOW_PLATFORMS,
  type DraftSession,
  type TemplateForm,
} from "../lib/workflow";
import { useAppState } from "../state/AppState";
import { useToast } from "../components/Toasts";
import { Empty, ErrorState, Loading } from "../components/states";
import GlassDateTime from "../components/GlassDateTime";
import Select from "../components/Select";
import "./WorkflowScreens.css";

/*
 * The workflow set (mockups W1 to W5): fan-out, preflight, upload queue,
 * rollup and templates. Every shape is from @toreroflow/contracts and every
 * call is one of its ENDPOINTS; the server decides who may do what, and the
 * buttons only hide what it would refuse.
 */

function usePrincipal() {
  const { user } = useAppState();
  return useMemo(() => principalFrom(user?.role, getToken()), [user?.role]);
}

const errText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/** The brand's videos that can be posted, for the pickers. */
function useReadyVideos(clientId: string | null | undefined) {
  const [videos, setVideos] = useState<MediaAssetInfo[] | null>(null);
  useEffect(() => {
    setVideos(null);
    if (!clientId) return;
    api
      .get<MediaAssetInfo[]>(`/clients/${clientId}/media`)
      .then((list) => setVideos(list.filter((a) => a.kind === "video" && a.status === "ready")))
      .catch(() => setVideos([]));
  }, [clientId]);
  return videos;
}

function tomorrowAt(hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------- W1 fan-out

const FIELD_LABEL: Record<OverrideField, string> = {
  caption: "Caption",
  title: "Title",
  cover: "Cover",
  cutId: "Cut",
  postAt: "Post time",
};

export function FanoutScreen() {
  const { selectedClient } = useAppState();
  const { draft: draftId } = useRoute();
  const toast = useToast();
  const principal = usePrincipal();
  const videos = useReadyVideos(selectedClient?.id);
  const [session, setSession] = useState<DraftSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draft = session?.draft ?? null;
  // Any edit leaves the server's copy behind until the next save.
  const setDraft = (d: Draft) => {
    setSession({ draft: d, saved: false });
    setSaveError(null);
  };

  // ?draft= (or a fix link's /create/<id>) names the draft: the one in hand
  // when it matches, else the saved one. /create/new is the unsaved one.
  useEffect(() => {
    setError(null);
    setSaveError(null);
    if (!draftId) return setSession(null);
    const stashed = loadStashedDraft();
    if (stashed && (draftId === "new" || stashed.draft.id === draftId)) return setSession(stashed);
    if (draftId === "new") return setError("This unsaved draft is gone. Start it again from a video or a template.");
    api
      .get<Draft>(`/drafts/${encodeURIComponent(draftId)}`)
      .then((d) => setSession({ draft: d, saved: true }))
      .catch((err) => setError(errText(err, "could not load the draft")));
  }, [draftId]);

  // Keep the hand-off current, so a reload or a trip to Preflight keeps edits.
  useEffect(() => {
    if (session) stashDraft(session);
  }, [session]);

  // A preflight fix link lands here with #<platform>.<field>.
  useEffect(() => {
    if (!draft) return;
    const id = fieldFromHash(window.location.hash);
    const el = id ? document.getElementById(id) : null;
    if (!el) return;
    el.closest("details")?.setAttribute("open", "");
    el.scrollIntoView({ block: "center" });
    el.focus();
  }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (s: DraftSession) => {
    // Stashed first, so the ?draft= change finds it instead of asking the server.
    stashDraft(s);
    setSession(s);
    if (draftId !== s.draft.id) navigatePath(`/create/fanout?draft=${encodeURIComponent(s.draft.id)}`);
  };

  const start = (video: MediaAssetInfo) => {
    const copy = video.draftCopy ?? {};
    open({ draft: newDraft(crypto.randomUUID(), video.clientId, video.id, copy.description ?? "", tomorrowAt(18), copy.youtubeTitle ?? copy.name), saved: false });
  };

  // Saving only saves: the post stays a draft and nothing is scheduled.
  const save = async () => {
    if (!draft) return;
    const problem = draftProblem(draft);
    if (problem) return setSaveError(problem);
    setBusy(true);
    setSaveError(null);
    try {
      open({ draft: await api.put<Draft>(`/drafts/${encodeURIComponent(draft.id)}`, upsertBody(draft)), saved: true });
      toast.success("Draft saved");
    } catch (err) {
      setSaveError(saveErrorText(err instanceof ApiError ? err.status : null, errText(err, "could not save the draft")));
    } finally {
      setBusy(false);
    }
  };

  const video = videos?.find((v) => v.id === draft?.videoId);
  const missing = draft ? WORKFLOW_PLATFORMS.filter((p) => !draft.targets.some((t) => t.platform === p)) : [];
  const viewer = principal.role === "viewer";
  const state = error ? "error" : draft ? "ready" : draftId ? "loading" : !selectedClient ? "empty" : videos ? "pick" : "loading";

  return (
    <section className="screen active wf" data-screen="fanout" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>One draft, {draft ? draft.targets.length : 3} platforms</h2>
          <p>Edit the draft once. Override any platform without touching the others.</p>
        </div>
      </div>
      <div className="stage">
        {state === "error" && <ErrorState screen="fanout" message={error} onRetry={() => setQuery({ draft: null })} />}
        {state === "loading" && <Loading screen="fanout" label="Loading the draft" />}
        {state === "empty" && <Empty screen="fanout" title="No brand selected" hint="Pick a brand in the dock." />}
        {state === "pick" &&
          (videos!.length === 0 ? (
            <Empty screen="fanout" title="No videos ready" hint="Upload a video in Upload & Schedule, or start from a template." />
          ) : (
            <div className="card glass wf-card">
              <div className="wf-lbl">Start a draft</div>
              <p className="wf-note">Pick a video. Templates in Overview can prefill one too.</p>
              <div className="wf-picklist">
                {videos!.map((v) => (
                  <button type="button" key={v.id} className="btn ghost wf-btn" onClick={() => start(v)}>
                    {videoLabel(v)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        {state === "ready" && draft && session && (
          <>
            <div className="card glass wf-card wf-draft" data-testid="fanout-draft">
              <div className="wf-lbl">
                Draft{" "}
                <span className="wf-from" data-testid="fanout-saved">
                  {session.saved ? "saved" : "not saved"}
                </span>
              </div>
              <div className="wf-draftgrid">
                <div className="wf-thumb" aria-hidden={!video?.thumbUrl}>
                  {video?.thumbUrl ? <img src={video.thumbUrl} alt="" /> : <span>{video ? videoLabel(video) : draft.videoId}</span>}
                </div>
                <div className="wf-fields">
                  <label className="wf-field">
                    <span>Draft caption</span>
                    <textarea
                      className="field-in"
                      rows={3}
                      value={draft.caption}
                      onChange={(e) => setDraft({ ...draft, caption: e.target.value })}
                      data-testid="fanout-draft-caption"
                    />
                  </label>
                  <label className="wf-field">
                    <span>Draft title</span>
                    <input
                      className="field-in"
                      value={draft.title ?? ""}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value || undefined })}
                    />
                  </label>
                  <div className="wf-field">
                    <span id="fanout-draft-time">Post time</span>
                    <div aria-labelledby="fanout-draft-time">
                      <GlassDateTime value={toLocalInput(draft.postAt)} onChange={(v) => setDraft({ ...draft, postAt: fromLocalInput(v) })} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="wf-plat">
              {draft.targets.map((t) => (
                <PlatformCard key={t.platform} draft={draft} platform={t.platform} onChange={setDraft} />
              ))}
            </div>
            {missing.length > 0 && (
              <div className="wf-acts" data-testid="fanout-add">
                {missing.map((p) => (
                  <button
                    type="button"
                    key={p}
                    className="btn ghost wf-btn"
                    onClick={() => setDraft(setTargets(draft, [...draft.targets.map((t) => t.platform), p]))}
                  >
                    Add {PLATFORM_LABEL[p]}
                  </button>
                ))}
              </div>
            )}
            {saveError && (
              <div className="lfnote bad wf-banner" role="alert" data-testid="fanout-save-error">
                {saveError}
              </div>
            )}
            <div className="wf-two">
              <button
                type="button"
                className="btn ghost wf-btn wf-full"
                disabled={busy || viewer || session.saved}
                aria-describedby={viewer ? "wf-viewer-hint" : undefined}
                onClick={() => void save()}
                data-testid="fanout-save"
              >
                {busy ? "Saving" : session.saved ? "Saved" : "Save draft"}
              </button>
              <button
                type="button"
                className="btn pri wf-btn wf-full"
                disabled={!draft.targets.length}
                onClick={() => navigatePath(`/create/preflight?draft=${encodeURIComponent(draft.id)}`)}
                data-testid="fanout-preflight"
              >
                Check all {draft.targets.length}
              </button>
            </div>
            {viewer && (
              <p id="wf-viewer-hint" className="wf-note">
                Viewers can check a draft but not save it.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function PlatformCard({ draft, platform, onChange }: { draft: Draft; platform: WorkflowPlatform; onChange(d: Draft): void }) {
  const target = draft.targets.find((t) => t.platform === platform)!;
  const shown = resolveTarget(draft, target);
  const over = isOverridden(target);
  const others = draft.targets.filter((t) => t.platform !== platform && !isOverridden(t)).map((t) => PLATFORM_LABEL[t.platform]);
  const edit = (field: OverrideField, value: string) => onChange(setOverride(draft, platform, field, value));
  const reset = () =>
    onChange((Object.keys(target.overrides) as OverrideField[]).reduce((d, f) => resetField(d, platform, f), draft));
  const text = (field: "cover" | "cutId") => (
    <label className="wf-field">
      <span>{FIELD_LABEL[field]}</span>
      <input
        id={fieldId(platform, field)}
        className="field-in"
        value={target.overrides[field] ?? ""}
        placeholder={field === "cover" ? "Same as the draft" : "The full video"}
        onChange={(e) => (e.target.value ? edit(field, e.target.value) : onChange(resetField(draft, platform, field)))}
      />
    </label>
  );
  return (
    <div className={`card glass wf-card${over ? " over" : ""}`} data-testid={`fanout-${platform}`}>
      <div className="wf-lbl">
        {PLATFORM_LABEL[platform]}{" "}
        {over ? (
          <span className="wf-ov" data-testid={`fanout-${platform}-overridden`}>
            Overridden
          </span>
        ) : (
          <span className="wf-from">from draft</span>
        )}
      </div>
      <label className="wf-field">
        <span>Caption</span>
        <textarea
          id={fieldId(platform, "caption")}
          className="field-in"
          rows={3}
          value={shown.caption}
          onChange={(e) => edit("caption", e.target.value)}
          data-testid={`fanout-${platform}-caption`}
        />
      </label>
      {platform === "youtube" && (
        <label className="wf-field">
          <span>Title</span>
          <input id={fieldId(platform, "title")} className="field-in" value={shown.title ?? ""} onChange={(e) => edit("title", e.target.value)} />
        </label>
      )}
      <details className="wf-more">
        <summary>Cover, cut and time</summary>
        {text("cover")}
        {text("cutId")}
        <div className="wf-field">
          <span>Post time{"postAt" in target.overrides ? "" : " (draft)"}</span>
          <GlassDateTime value={toLocalInput(shown.postAt)} onChange={(v) => edit("postAt", fromLocalInput(v))} />
        </div>
      </details>
      <button
        type="button"
        className="btn ghost wf-btn"
        onClick={() => onChange(setTargets(draft, draft.targets.map((t) => t.platform).filter((p) => p !== platform)))}
        data-testid={`fanout-${platform}-remove`}
      >
        Remove {PLATFORM_LABEL[platform]}
      </button>
      {over && (
        <div className="wf-reset">
          <p className="wf-note">
            Changed: {Object.keys(target.overrides).map((f) => FIELD_LABEL[f as OverrideField].toLowerCase()).join(", ")}.
            {others.length ? ` ${others.join(" and ")} kept the draft.` : ""}
          </p>
          <button type="button" className="btn ghost wf-btn" onClick={reset} data-testid={`fanout-${platform}-reset`}>
            Reset to draft
          </button>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- W2 preflight

export function PreflightScreen() {
  const { draft: draftId } = useRoute();
  const toast = useToast();
  const principal = usePrincipal();
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<DraftSession | null>(null);
  const saved = session?.saved ?? false;
  // An unsaved draft goes inline, with what its video brings (length, cover).
  const videos = useReadyVideos(session && !saved ? session.draft.brandId : null);
  const media = videos?.find((v) => v.id === session?.draft.videoId) ?? null;
  const inputsReady = session !== null && (saved || videos !== null);

  // The draft in hand from Fan-out, else the saved one.
  useEffect(() => {
    setSession(null);
    setResult(null);
    setError(null);
    if (!draftId) return;
    const stashed = loadStashedDraft();
    if (stashed?.draft.id === draftId) return setSession(stashed);
    api
      .get<Draft>(`/drafts/${encodeURIComponent(draftId)}`)
      .then((d) => setSession({ draft: d, saved: true }))
      .catch((err) => setError(preflightErrorText(err instanceof ApiError ? err.status : null, errText(err, "could not load the draft"), true)));
  }, [draftId]);

  const run = useCallback(async () => {
    if (!session || !inputsReady) return;
    setError(null);
    setResult(null);
    try {
      setResult(await api.post<PreflightResult>("/preflight", preflightBody(session, media)));
    } catch (err) {
      setError(preflightErrorText(err instanceof ApiError ? err.status : null, errText(err, "preflight could not run"), session.saved));
    }
  }, [session, inputsReady, media]);

  useEffect(() => {
    void run();
  }, [run]);

  // Scheduling stays in Upload & Schedule; the draft hands over its video only.
  const toSchedule = (d: Draft) =>
    navigatePath(`/create/upload?client=${encodeURIComponent(d.brandId)}&schedule=${encodeURIComponent(d.videoId)}`);

  // An override is logged against a saved draft, so an unsaved one is saved first.
  const override = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const d = session.saved ? session.draft : await api.put<Draft>(`/drafts/${encodeURIComponent(session.draft.id)}`, upsertBody(session.draft));
      stashDraft({ draft: d, saved: true });
      await api.post(`/drafts/${encodeURIComponent(d.id)}/override`, { reason: reason.trim() });
      toast.success("Override logged");
      toSchedule(d);
    } catch (err) {
      toast.fail("Could not override", err);
      setBusy(false);
    }
  };

  const summary = result && preflightSummary(result);
  const n = session?.draft.targets.length ?? 3;
  const reasonOk = OverrideRequestSchema.safeParse({ reason }).success;
  const canOverride = canOverridePreflight(principal);
  const state = !draftId ? "empty" : error ? "error" : result ? "ready" : "loading";

  const row = (issue: Issue, kind: "blocking" | "warning" | "ok", i: number) => {
    const { platform } = fixTarget(issue);
    const mark = kind === "blocking" ? "×" : kind === "warning" ? "!" : "✓";
    return (
      <li className={`wf-chk ${kind}`} key={`${kind}-${i}`} data-testid={`preflight-${kind}`}>
        <span className="wf-mark" aria-hidden="true">
          {mark}
        </span>
        <span className="wf-chktext">
          <span className="sr-only">{kind === "blocking" ? "Blocking: " : kind === "warning" ? "Warning: " : "Passed: "}</span>
          <b>{PLATFORM_LABEL[platform]}:</b> {issue.message}
        </span>
        {kind !== "ok" && (
          <a className="btn ghost wf-btn" {...pathLinkProps(fixHref(issue, draftId!, saved))}>
            {fixLabel(issue)}
          </a>
        )}
      </li>
    );
  };

  return (
    <section className="screen active wf" data-screen="preflight" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Preflight</h2>
          <p>Checks every target at once before anything posts.</p>
        </div>
        {state === "ready" && (
          <button type="button" className="btn ghost wf-btn" onClick={() => void run()}>
            Check again
          </button>
        )}
      </div>
      <div className="stage">
        {state === "empty" && <Empty screen="preflight" title="No draft to check" hint="Open a draft in Fan-out and press Check." />}
        {state === "error" && (
          <ErrorState screen="preflight" message={error} onRetry={() => (session ? void run() : navigatePath(`/create/fanout?draft=${encodeURIComponent(draftId!)}`))} />
        )}
        {state === "loading" && <Loading screen="preflight" label="Running preflight" />}
        {state === "ready" && result && summary && (
          <>
            <div className={`lfnote ${summary.blocked ? "bad" : "ok"} wf-banner`} role="status" data-testid="preflight-summary">
              <b>{summary.blocked ? "Posting blocked." : "Ready to post."}</b> {summary.text}
            </div>
            <ul className="card glass wf-card wf-list" aria-label="Preflight results">
              {result.blocking.map((i, k) => row(i, "blocking", k))}
              {result.warnings.map((i, k) => row(i, "warning", k))}
              {result.ok.map((i, k) => row(i, "ok", k))}
              {!result.blocking.length && !result.warnings.length && !result.ok.length && <li className="wf-chk ok">Nothing to check on this draft.</li>}
            </ul>
            <div className="wf-two">
              {summary.blocked && canOverride && (
                <form
                  className="card glass wf-card"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (reasonOk) void override();
                  }}
                >
                  <div className="wf-lbl">Operator override</div>
                  <label className="wf-field">
                    <span>Reason (logged, required)</span>
                    <input
                      className="field-in"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why post anyway?"
                      required
                      minLength={3}
                      maxLength={500}
                      aria-describedby="wf-reason-hint"
                      data-testid="preflight-reason"
                    />
                  </label>
                  <p id="wf-reason-hint" className="wf-note">
                    At least 3 characters. Saved with your name and the time.
                  </p>
                  <button type="submit" className="btn ghost wf-btn wf-full" disabled={!reasonOk || busy} data-testid="preflight-override">
                    {busy ? "Logging" : "Override and schedule"}
                  </button>
                </form>
              )}
              <div className="card glass wf-card">
                <div className="wf-lbl">When all clear</div>
                <button
                  type="button"
                  className="btn pri wf-btn wf-full"
                  disabled={summary.blocked || busy || !session}
                  aria-describedby="wf-clear-hint"
                  onClick={() => session && toSchedule(session.draft)}
                  data-testid="preflight-schedule"
                >
                  Schedule all {n}
                </button>
                <p id="wf-clear-hint" className="wf-note">
                  {summary.blocked
                    ? `Unlocks once every × is fixed.${canOverride ? "" : " Only the operator or Polly can override."}`
                    : "Nothing is blocking. Opens the usual schedule flow for this video."}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ----------------------------------------------------------- W3 upload queue

interface QueueLabel {
  name: string;
  client: string;
  at: string | null;
}

export function QueueScreen() {
  const { clients } = useAppState();
  const toast = useToast();
  const principal = usePrincipal();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [labels, setLabels] = useState<Map<string, QueueLabel>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const canWrite = principal.role !== "viewer";

  const load = useCallback(async () => {
    setError(null);
    try {
      const [q, posts] = await Promise.all([
        api.get<{ items: QueueItem[] }>("/queue"),
        // QueueItem carries ids only; the names and slots come from each brand's posts.
        Promise.all(clients.map((c) => api.get<PostTargetInfo[]>(`/clients/${c.id}/posts`).then((ps) => ({ c, ps }), () => ({ c, ps: [] })))),
      ]);
      const m = new Map<string, QueueLabel>();
      for (const { c, ps } of posts)
        for (const p of ps) {
          const prev = m.get(p.postId);
          if (!prev || (p.scheduledAt && (!prev.at || p.scheduledAt < prev.at))) m.set(p.postId, { name: p.assetName, client: c.name, at: p.scheduledAt });
        }
      setLabels(m);
      setItems(q.items);
    } catch (err) {
      setError(errText(err, "could not load the queue"));
    }
  }, [clients]);

  useEffect(() => {
    void load();
  }, [load]);

  const label = (id: string) => labels.get(id)?.name ?? "Post";
  const ordered = items ? queueOrder(items) : [];
  const uploading = ordered.filter((i) => i.state === "uploading");
  const next = ordered.filter((i) => i.state !== "uploading");

  const send = async (call: () => Promise<{ items: QueueItem[] }>, what: string) => {
    try {
      setItems((await call()).items);
    } catch (err) {
      toast.fail(what, err);
      void load();
    }
  };

  const reorder = (id: string, to: number) => {
    const ids = moveId(next.map((i) => i.id), id, to);
    if (ids.join() === next.map((i) => i.id).join()) return;
    setItems([...uploading, ...ids.map((x, position) => ({ ...next.find((i) => i.id === x)!, position }))]);
    setLive(`${label(id)} moved to position ${ids.indexOf(id) + 1} of ${ids.length}.`);
    void send(() => api.patch("/queue/reorder", { ids: [...uploading.map((i) => i.id), ...ids] }), "Could not reorder the queue");
  };

  const rush = (item: QueueItem) => {
    const priority = item.priority === "rush" ? "normal" : "rush";
    setLive(`${label(item.id)} ${priority === "rush" ? "marked Client rush" : "back to normal"}.`);
    void send(() => api.patch(`/queue/${item.id}/priority`, { priority }), "Could not change the priority");
  };

  const onKey = (e: KeyboardEvent, id: string, i: number) => {
    const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? next.length - 1 : null;
    if (to == null) return;
    e.preventDefault();
    reorder(id, to);
    requestAnimationFrame(() => document.getElementById(`wf-drag-${id}`)?.focus());
  };

  const when = (at: string | null) =>
    at ? new Date(at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET" : "No slot";

  const state = error && !items ? "error" : items ? "ready" : "loading";

  return (
    <section className="screen active wf" data-screen="queue" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Upload queue</h2>
          <p>Client rush jumps ahead. Drag to reorder the rest.</p>
        </div>
      </div>
      <div className="stage">
        {state === "error" && <ErrorState screen="queue" message={error} onRetry={() => void load()} />}
        {state === "loading" && <Loading screen="queue" label="Loading the queue" />}
        {state === "ready" && (
          <>
            <div className="sr-only" aria-live="polite">
              {live}
            </div>
            {uploading.length > 0 && (
              <div className="card glass wf-card">
                <div className="wf-lbl">Uploading now</div>
                {uploading.map((i) => (
                  <div key={i.id} className="wf-up">
                    <p>
                      {label(i.id)}, {labels.get(i.id)?.client ?? ""}
                    </p>
                    <div className="wf-prog" role="progressbar" aria-label={`Uploading ${label(i.id)}`}>
                      <i />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="card glass wf-card">
              <div className="wf-lbl" id="wf-next">
                Up next
              </div>
              {next.length === 0 ? (
                <p className="wf-note" data-testid="queue.empty">
                  Nothing waiting to upload.
                </p>
              ) : (
                <ol className="wf-list" aria-labelledby="wf-next">
                  {next.map((item, i) => {
                    const l = labels.get(item.id);
                    return (
                      <li
                        key={item.id}
                        className={`wf-chk wf-qrow${dragId === item.id ? " dragging" : ""}`}
                        draggable={canWrite}
                        onDragStart={(e: DragEvent) => {
                          setDragId(item.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => setDragId(null)}
                        onDragOver={(e) => dragId && e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragId) reorder(dragId, i);
                          setDragId(null);
                        }}
                        data-testid={`queue-row-${item.id}`}
                      >
                        <button
                          type="button"
                          id={`wf-drag-${item.id}`}
                          className="wf-drag"
                          disabled={!canWrite}
                          aria-label={`Reorder ${label(item.id)}, position ${i + 1} of ${next.length}. Arrow keys move it.`}
                          onKeyDown={(e) => onKey(e, item.id, i)}
                        >
                          <span aria-hidden="true">⠿</span>
                        </button>
                        <span className="wf-chktext">
                          <b>{label(item.id)}</b> {l?.client}
                          {item.priority === "rush" && <span className="wf-rush">Client rush</span>}
                          {item.state === "failed" && <span className="wf-ov">Failed</span>}
                          <small>{when(l?.at ?? null)}</small>
                        </span>
                        <span className="wf-acts">
                          <button
                            type="button"
                            className={`btn ${item.priority === "rush" ? "pri" : "ghost"} wf-btn`}
                            aria-pressed={item.priority === "rush"}
                            disabled={!canWrite}
                            onClick={() => rush(item)}
                            data-testid={`queue-rush-${item.id}`}
                          >
                            Client rush
                          </button>
                          <button type="button" className="btn ghost wf-btn" disabled={!canWrite || i === 0} onClick={() => reorder(item.id, i - 1)}>
                            Move up
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
              <p className="wf-note">Calendar and the daily counter stay as they are. This only changes upload order.</p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- W4 rollup

export function RollupScreen() {
  const { selectedClient } = useAppState();
  const { video: videoId } = useRoute();
  const videos = useReadyVideos(selectedClient?.id);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    setRollup(null);
    setError(null);
    setUnavailable(false);
    if (!videoId) return;
    try {
      setRollup(await api.get<Rollup>(`/rollup/${videoId}`));
    } catch (err) {
      // A provider outage is not this screen's failure: say the numbers are not in.
      if (err instanceof ApiError && err.status >= 500) setUnavailable(true);
      else setError(errText(err, "could not load the rollup"));
    }
  }, [videoId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!videoId && videos?.length) setQuery({ video: videos[0]!.id });
  }, [videoId, videos]);

  const video = videos?.find((v) => v.id === videoId);
  const state = !selectedClient ? "empty" : error ? "error" : unavailable || (rollup && !rollupHasData(rollup)) ? "unavailable" : rollup ? "ready" : videos?.length === 0 ? "novideo" : "loading";

  return (
    <section className="screen active wf" data-screen="rollup" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Cross-platform rollup</h2>
          <p>One video, every platform, side by side.</p>
        </div>
        {videos && videos.length > 0 && (
          <Select
            aria-label="Video"
            className="wf-select"
            value={videoId ?? ""}
            placeholder="Pick a video"
            options={videos.map((v) => ({ value: v.id, label: videoLabel(v) }))}
            onChange={(v) => setQuery({ video: v })}
          />
        )}
      </div>
      <div className="stage">
        {state === "empty" && <Empty screen="rollup" title="No brand selected" hint="Pick a brand in the dock." />}
        {state === "novideo" && <Empty screen="rollup" title="No videos yet" hint="A video shows here once it has posted." />}
        {state === "error" && <ErrorState screen="rollup" message={error} onRetry={() => void load()} />}
        {state === "loading" && <Loading screen="rollup" label="Loading the rollup" />}
        {state === "unavailable" && (
          <Empty
            screen="rollup"
            title="No numbers yet"
            hint="Zernio analytics are not available for this video right now. They show here once a platform reports them. Per-post insights are unchanged."
            action={
              <button type="button" className="tf-btn glass-z1 wf-btn" onClick={() => void load()}>
                Check again
              </button>
            }
          />
        )}
        {state === "ready" && rollup && (
          <div className="card glass wf-card" data-testid="rollup-table">
            <div className="wf-lbl">{video ? videoLabel(video) : "This video"}</div>
            <div className="wf-scroll">
              <table className="wf-table">
                <caption className="sr-only">Metrics for {video ? videoLabel(video) : "this video"} by platform</caption>
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    {WORKFLOW_PLATFORMS.map((p) => (
                      <th scope="col" key={p}>
                        {PLATFORM_LABEL[p]}
                      </th>
                    ))}
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rollup.rows.map((r) => (
                    <tr key={r.metric}>
                      <th scope="row">{METRIC_LABEL[r.metric]}</th>
                      {WORKFLOW_PLATFORMS.map((p) => (
                        <td key={p}>{fmtMetric(r.metric, r[p])}</td>
                      ))}
                      <td>
                        <b>{fmtMetric(r.metric, r.total)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="wf-note">Per-post insights pages are unchanged. Average watch is weighted by views; n/a means the platform has not reported it.</p>
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------- W5 templates

export function TemplatesScreen() {
  const { clients } = useAppState();
  const toast = useToast();
  const principal = usePrincipal();
  const canEdit = canEditTemplates(principal);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [cadence, setCadence] = useState<Record<string, CadenceSuggestions | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: TemplateForm } | null>(null);
  const [using, setUsing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { templates: list } = await api.get<{ templates: Template[] }>("/templates");
      setTemplates(list);
      const brands = [...new Set(list.map((t) => t.brandId))];
      const got = await Promise.all(
        brands.map((b) => api.get<CadenceSuggestions>(`/templates/cadence?brandId=${encodeURIComponent(b)}`).then((c) => [b, c] as const, () => [b, null] as const)),
      );
      setCadence(Object.fromEntries(got));
    } catch (err) {
      setError(errText(err, "could not load templates"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? "Brand";

  const save = async () => {
    if (!editing) return;
    const body = formToTemplate(editing.form);
    try {
      if (editing.id) await api.put(`/templates/${editing.id}`, body);
      else await api.post("/templates", body);
      toast.success("Template saved");
      setEditing(null);
      void load();
    } catch (err) {
      toast.fail("Could not save the template", err);
    }
  };

  const remove = async (t: Template) => {
    if (!window.confirm(`Delete the template "${t.name}"?`)) return;
    try {
      await api.del(`/templates/${t.id}`);
      void load();
    } catch (err) {
      toast.fail("Could not delete the template", err);
    }
  };

  const state = error && !templates ? "error" : templates ? "ready" : "loading";
  const byBrand = clients.map((c) => ({ c, list: (templates ?? []).filter((t) => t.brandId === c.id) })).filter((g) => g.list.length);

  return (
    <section className="screen active wf" data-screen="templates" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Templates</h2>
          <p>Saved upload setups per client and brand. Bots like Polly can use them too.</p>
        </div>
        {canEdit && state === "ready" && !editing && (
          <button type="button" className="btn wf-btn" onClick={() => setEditing({ id: null, form: templateToForm(blankTemplate(clients[0]?.id ?? "")) })}>
            New template
          </button>
        )}
      </div>
      <div className="stage">
        {state === "error" && <ErrorState screen="templates" message={error} onRetry={() => void load()} />}
        {state === "loading" && <Loading screen="templates" label="Loading templates" />}
        {state === "ready" && (
          <>
            {editing && <TemplateEditor editing={editing} onChange={setEditing} onSave={() => void save()} />}
            {!byBrand.length && !editing && (
              <Empty screen="templates" title="No templates yet" hint={canEdit ? "Save a brand's usual setup with New template." : "The operator or Polly can add one."} />
            )}
            {byBrand.map(({ c, list }) => (
              <div key={c.id} className="wf-group">
                <h3 className="wf-h3">{c.name}</h3>
                <div className="wf-tgrid">
                  {list.map((t) => (
                    <TemplateCard
                      key={t.id}
                      t={t}
                      brand={clientName(t.brandId)}
                      cadence={cadence[t.brandId] ?? null}
                      canEdit={canEdit}
                      using={using === t.id}
                      onUse={() => setUsing(using === t.id ? null : t.id)}
                      onEdit={() => setEditing({ id: t.id, form: templateToForm(t) })}
                      onDelete={() => void remove(t)}
                    />
                  ))}
                </div>
              </div>
            ))}
            <div className="card glass wf-card">
              <div className="wf-lbl">Bot access</div>
              <p>Polly can read, apply and edit these templates.</p>
              <p className="wf-note">Other bots can apply a template only with the templates:apply scope. Editing stays with the operator and Polly.</p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function suggestion(c: CadenceSuggestions | null): { text: string; tone: "ok" | "warn" } | null {
  if (!c) return null;
  if (c.missedSlots.length)
    return { text: `${c.missedSlots.length} regular slot${c.missedSlots.length === 1 ? "" : "s"} missed lately. Suggested: ${c.cadence}.`, tone: "warn" };
  const best = c.bestTimes[0];
  if (best) return { text: `Best slot: ${best.day} ${best.time} ET${best.avgViews != null ? `, ${Math.round(best.avgViews).toLocaleString("en-US")} average views` : ""}. Suggested: ${c.cadence}.`, tone: "ok" };
  return null;
}

function TemplateCard(props: {
  t: Template;
  brand: string;
  cadence: CadenceSuggestions | null;
  canEdit: boolean;
  using: boolean;
  onUse(): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const { t } = props;
  const s = suggestion(props.cadence);
  return (
    <div className="card glass wf-card" data-testid={`template-${t.id}`}>
      <div className="wf-lbl">
        {props.brand}, {t.name} <span className="wf-from">{t.scope === "brand" ? "brand" : "client"}</span>
      </div>
      <dl className="wf-dl">
        <dt>Platforms</dt>
        <dd>{t.platforms.map((p) => PLATFORM_LABEL[p]).join(", ")}</dd>
        <dt>Caption</dt>
        <dd>{t.captionPattern || "none"}</dd>
        <dt>Hashtags</dt>
        <dd>{t.hashtags.length ? t.hashtags.map((h) => `#${h}`).join(" ") : "none"}</dd>
        <dt>Cover</dt>
        <dd>{t.coverStyle || "none"}</dd>
        <dt>Times</dt>
        <dd>{t.postTimes.length ? t.postTimes.map((x) => `${x} ET`).join(", ") : "any"}</dd>
        <dt>Cadence</dt>
        <dd>{t.cadence || "not set"}</dd>
      </dl>
      {s && <div className={`lfnote ${s.tone}`}>Suggestion: {s.text}</div>}
      {props.using ? (
        <UseTemplate t={t} onCancel={props.onUse} />
      ) : (
        <button type="button" className="btn pri wf-btn wf-full" onClick={props.onUse} data-testid={`template-use-${t.id}`}>
          Use template
        </button>
      )}
      {props.canEdit && (
        <div className="wf-acts">
          <button type="button" className="btn ghost wf-btn" onClick={props.onEdit}>
            Edit
          </button>
          <button type="button" className="btn ghost wf-btn" onClick={props.onDelete}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/** Picks the video and time, applies the template, and opens the result in Fan-out. */
function UseTemplate({ t, onCancel }: { t: Template; onCancel(): void }) {
  const toast = useToast();
  const videos = useReadyVideos(t.brandId);
  const [videoId, setVideoId] = useState("");
  const [when, setWhen] = useState(() => {
    const [h, m] = (t.postTimes[0] ?? "18:00").split(":").map(Number);
    const d = new Date(tomorrowAt(h!));
    d.setMinutes(m!);
    return toLocalInput(d.toISOString());
  });
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      const draft = await api.post<Draft>(`/templates/${t.id}/apply`, { videoId, postAt: fromLocalInput(when) });
      stashDraft({ draft, saved: false });
      navigatePath(`/create/fanout?draft=${encodeURIComponent(draft.id)}`);
    } catch (err) {
      toast.fail("Could not apply the template", err);
      setBusy(false);
    }
  };

  return (
    <div className="wf-use">
      <div className="wf-field">
        <span>Video</span>
        <Select
          aria-label="Video"
          value={videoId}
          placeholder={videos === null ? "Loading videos" : videos.length ? "Pick a video" : "No ready videos"}
          disabled={!videos?.length}
          options={(videos ?? []).map((v) => ({ value: v.id, label: videoLabel(v) }))}
          onChange={setVideoId}
        />
      </div>
      <div className="wf-field">
        <span>Post time</span>
        <GlassDateTime value={when} onChange={setWhen} />
      </div>
      <div className="wf-acts">
        <button type="button" className="btn ghost wf-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn pri wf-btn" disabled={!videoId || busy} onClick={() => void apply()} data-testid={`template-apply-${t.id}`}>
          {busy ? "Opening" : "Open in Fan-out"}
        </button>
      </div>
    </div>
  );
}

function TemplateEditor({
  editing,
  onChange,
  onSave,
}: {
  editing: { id: string | null; form: TemplateForm };
  onChange(e: { id: string | null; form: TemplateForm } | null): void;
  onSave(): void;
}) {
  const { clients } = useAppState();
  const f = editing.form;
  const set = (patch: Partial<TemplateForm>) => onChange({ ...editing, form: { ...f, ...patch } });
  const text = (key: "name" | "captionPattern" | "hashtags" | "coverStyle" | "postTimes" | "cadence", label: string, hint?: string) => (
    <label className="wf-field">
      <span>{label}</span>
      <input className="field-in" value={f[key]} placeholder={hint} onChange={(e) => set({ [key]: e.target.value })} required={key === "name"} />
    </label>
  );
  return (
    <form
      className="card glass wf-card wf-editor"
      aria-label={editing.id ? "Edit template" : "New template"}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="wf-lbl">{editing.id ? "Edit template" : "New template"}</div>
      <div className="wf-egrid">
        {text("name", "Name", "Long-form weekly")}
        <div className="wf-field">
          <span>Brand</span>
          <Select aria-label="Brand" value={f.brandId} options={clients.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => set({ brandId: v })} />
        </div>
        <div className="wf-field">
          <span>Scope</span>
          <Select
            aria-label="Scope"
            value={f.scope}
            options={[
              { value: "client", label: "Client" },
              { value: "brand", label: "Brand" },
            ]}
            onChange={(v) => set({ scope: v as TemplateForm["scope"] })}
          />
        </div>
        <fieldset className="wf-field wf-plats">
          <legend>Platforms</legend>
          {WORKFLOW_PLATFORMS.map((p) => (
            <label key={p} className="wf-check">
              <input
                type="checkbox"
                checked={f.platforms.includes(p)}
                onChange={(e) => set({ platforms: e.target.checked ? WORKFLOW_PLATFORMS.filter((x) => x === p || f.platforms.includes(x)) : f.platforms.filter((x) => x !== p) })}
              />
              {PLATFORM_LABEL[p]}
            </label>
          ))}
        </fieldset>
        {text("captionPattern", "Caption pattern", "{car} {year}, ${price}. {hook}")}
        {text("hashtags", "Hashtags", "#bmw #carsforsale")}
        {text("coverStyle", "Cover", "black title hook")}
        {text("postTimes", "Times (ET, HH:mm)", "18:00, 12:00")}
        {text("cadence", "Cadence", "1 per week")}
      </div>
      <div className="wf-acts">
        <button type="button" className="btn ghost wf-btn" onClick={() => onChange(null)}>
          Cancel
        </button>
        <button type="submit" className="btn pri wf-btn" disabled={!f.name.trim() || !f.brandId || !f.platforms.length}>
          Save template
        </button>
      </div>
    </form>
  );
}
