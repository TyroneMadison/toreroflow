import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ApprovalLinkSchema,
  FailedPostListSchema,
  FailedPostRetryResultSchema,
  InsightsResponseSchema,
  PublicApprovalSchema,
  RequestFormInfoSchema,
  RequestFormLinkSchema,
  REPORT_SENDER,
  type MonthlyReport,
  type ReportJobConfig,
  type TrelloIntakeConfig,
} from "@toreroflow/contracts";
import { api, ApiError, fileUrl, videoLabel, type ClientPost, type MediaAssetInfo, type PostTargetInfo } from "../lib/api";
import {
  bestTime,
  BANDS,
  compact,
  DAYS,
  ENOUGH_POSTS,
  EXPIRY_HOURS,
  expiryLabel,
  fmtClock,
  fmtEt,
  hourLabel,
  insightTable,
  LINK_STATE_LABEL,
  linkState,
  monthLabel,
  nextRunLabel,
  publicLink,
  recentMonths,
  RETRY_OUTCOME,
  slotLabel,
  SOURCE_LABEL,
  type LinkState,
} from "../lib/ideas";
import { linkProps, navigate } from "../lib/routes";
import { openExternal } from "../lib/external";
import { PLATFORM_LABELS } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import { useToast } from "../components/Toasts";
import { Empty, ErrorState, Loading } from "../components/states";
import Select from "../components/Select";
import { Badge, KillSwitch, Lbl, Note } from "../components/ideas/IdeaBits";
import "./IdeaScreens.css";

/*
 * The ideas set on Sadie's endpoints (feat/toreroflow-ideas-be): client
 * approval links, content requests, the monthly report, merged insights with
 * best time to post, and failed posts. The no-login pages a client opens
 * (approval link, request form) live here too, so they share one look.
 */

type LinkView = ReturnType<typeof ApprovalLinkSchema.parse> & { url: string };
type PublicApproval = ReturnType<typeof PublicApprovalSchema.parse>;
type FailedList = ReturnType<typeof FailedPostListSchema.parse>;
type RetryOutcome = ReturnType<typeof FailedPostRetryResultSchema.parse>["outcome"];
type Insights = ReturnType<typeof InsightsResponseSchema.parse>;

/** Where a client opens links. VITE_PUBLIC_APP_URL in the desktop shell; the page's own origin on the web. */
export const PUBLIC_APP_URL: string =
  (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined) ??
  (typeof location !== "undefined" && location.protocol.startsWith("http") ? location.origin : "");

const errText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

async function copy(text: string, toast: ReturnType<typeof useToast>) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Link copied");
  } catch (err) {
    toast.fail("Could not copy the link", err);
  }
}

export function useBrandVideos(clientId: string | null | undefined) {
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

/** The brand's post targets, for names behind the ids other routes answer with. */
function useBrandPosts(clientId: string | null | undefined) {
  const [posts, setPosts] = useState<PostTargetInfo[] | null>(null);
  useEffect(() => {
    setPosts(null);
    if (!clientId) return;
    api
      .get<PostTargetInfo[]>(`/clients/${clientId}/posts`)
      .then(setPosts)
      .catch(() => setPosts([]));
  }, [clientId]);
  return posts;
}

function Screen({ id, state, title, sub, children }: { id: string; state: string; title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="screen active id" data-screen={id} data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>{title}</h2>
          <p>{sub}</p>
        </div>
      </div>
      <div className="stage">{children}</div>
    </section>
  );
}

const NO_BRAND = (screen: string, hint: string) => <Empty screen={screen} title="No brand selected" hint={hint} />;

// ------------------------------------------------------- 1. client approval

const STATE_TONE: Record<LinkState, "ok" | "warn" | "bad" | undefined> = {
  pending: undefined,
  approved: "ok",
  changes_requested: "warn",
  expired: "bad",
  revoked: "bad",
};

export function ApprovalsScreen() {
  const { selectedClient } = useAppState();
  const toast = useToast();
  const videos = useBrandVideos(selectedClient?.id);
  const [picked, setPicked] = useState("");
  const [hours, setHours] = useState<number>(168);
  const [links, setLinks] = useState<LinkView[] | null>(null);
  const [preview, setPreview] = useState<PublicApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const versionId = picked || videos?.[0]?.id || "";
  const video = videos?.find((v) => v.id === versionId);

  const load = useCallback(async () => {
    if (!versionId) return;
    try {
      const r = await api.get<{ links: LinkView[] }>(`/approval-links?versionId=${encodeURIComponent(versionId)}`);
      setLinks(r.links);
      setError(null);
    } catch (err) {
      setError(errText(err, "could not load approval links"));
    }
  }, [versionId]);

  useEffect(() => {
    setLinks(null);
    void load();
  }, [load]);

  const live = links?.find((l) => !["expired", "revoked"].includes(linkState(l)));

  // What the client sees on the live link, comments included.
  useEffect(() => {
    setPreview(null);
    if (!live) return;
    api.get<PublicApproval>(`/a/${live.token}`).then(setPreview).catch(() => setPreview(null));
  }, [live?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setBusy(true);
    try {
      await api.post("/approval-links", { versionId, expiresInHours: hours });
      await load();
    } catch (err) {
      toast.fail("Could not make the link", err);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await api.del(`/approval-links/${id}`);
      await load();
    } catch (err) {
      toast.fail("Could not turn the link off", err);
    } finally {
      setBusy(false);
    }
  };

  const state = !selectedClient ? "empty" : error ? "error" : videos === null || (versionId && links === null) ? "loading" : "ready";
  const url = live ? publicLink(PUBLIC_APP_URL, live.url) : "";

  return (
    <Screen id="approvals" state={state} title="Client approval link" sub="Send a no-login link. The client approves or asks for changes.">
      {state === "empty" && NO_BRAND("approvals", "Pick a brand in the dock to share a video with it.")}
      {state === "error" && <ErrorState screen="approvals" message={error} onRetry={() => void load()} />}
      {state === "loading" && <Loading screen="approvals" label="Loading approval links" />}
      {state === "ready" && !videos!.length && (
        <Empty screen="approvals" title="No videos to share" hint="Upload a video in Upload & Schedule first." />
      )}
      {state === "ready" && video && (
        <div className="id-two">
          <div className="card glass id-card" data-testid="approvals.operator">
            <Lbl>Operator</Lbl>
            <h3 className="id-h3">
              {selectedClient!.name}, {videoLabel(video)}
              {video.isRevision ? " (revision)" : ""}
            </h3>
            {videos!.length > 1 && (
              <label className="id-field">
                <span>Video version</span>
                <Select
                  aria-label="Video version"
                  value={versionId}
                  options={videos!.map((v) => ({ value: v.id, label: videoLabel(v), hint: v.isRevision ? "revision" : undefined }))}
                  onChange={setPicked}
                />
              </label>
            )}
            {live ? (
              <>
                <label className="id-field">
                  <span>Link</span>
                  <input className="field-in" readOnly value={url || live.url} onFocus={(e) => e.currentTarget.select()} />
                </label>
                {!PUBLIC_APP_URL && <Note tone="warn">Set VITE_PUBLIC_APP_URL so the link opens the web app, not this desktop shell.</Note>}
                <button type="button" className="btn pri id-full" onClick={() => void copy(url || live.url, toast)}>
                  Copy link
                </button>
                <button type="button" className="btn ghost id-full" disabled={busy} onClick={() => void revoke(live.id)}>
                  Turn this link off
                </button>
                <p className="id-note">Expires {fmtEt(live.expiresAt)}. Downloads are not offered on the client page.</p>
              </>
            ) : (
              <>
                <label className="id-field">
                  <span>Link expires</span>
                  <Select
                    aria-label="Link expires"
                    value={String(hours)}
                    options={EXPIRY_HOURS.map((h) => ({ value: String(h), label: expiryLabel(h) }))}
                    onChange={(v) => setHours(Number(v))}
                  />
                </label>
                <button type="button" className="btn pri id-full" disabled={busy} onClick={() => void create()}>
                  Make approval link
                </button>
              </>
            )}
            <Lbl>Status</Lbl>
            {links!.length === 0 ? (
              <p className="id-note">No links for this version yet.</p>
            ) : (
              <ul className="id-stack" aria-label="Approval links">
                {links!.map((l) => {
                  const s = linkState(l);
                  const n = l.id === live?.id && preview ? preview.comments.length : null;
                  return (
                    <li key={l.id}>
                      <Note tone={STATE_TONE[s]}>
                        <b>{LINK_STATE_LABEL[s]}</b>{" "}
                        {n != null && n > 0 ? `${n} ${n === 1 ? "comment" : "comments"}. ` : ""}
                        {s === "revoked" ? "Turned off." : `${s === "expired" ? "Expired" : "Expires"} ${fmtEt(l.expiresAt)}.`}
                      </Note>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="card glass id-card" data-testid="approvals.client">
            <Lbl>Client view, no login</Lbl>
            {preview ? (
              <ApprovalView data={preview} />
            ) : (
              <p className="id-note">Make a link to see exactly what the client sees.</p>
            )}
          </div>
        </div>
      )}
    </Screen>
  );
}

/** The video, comments pinned to moments, and (with a token) Approve or Request changes. */
function ApprovalView({ data, token, onChange }: { data: PublicApproval; token?: string; onChange?: (d: PublicApproval) => void }) {
  const toast = useToast();
  const ref = useRef<HTMLVideoElement>(null);
  const [at, setAt] = useState(0);
  const [dur, setDur] = useState(data.video.durationSec ?? 0);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const pinned = data.comments.filter((c) => c.atMs != null);
  const seek = (ms: number) => {
    if (ref.current) ref.current.currentTime = ms / 1000;
  };

  const send = async (decision?: "approved" | "changes_requested") => {
    if (!token) return;
    setBusy(true);
    try {
      let next = data;
      if (body.trim()) {
        const c = await api.post<PublicApproval["comments"][number]>(`/a/${token}/comments`, { atMs: Math.round(at * 1000), body: body.trim() });
        next = { ...next, comments: [...next.comments, c].sort((a, b) => (a.atMs ?? -1) - (b.atMs ?? -1)) };
        setBody("");
      }
      if (decision) next = await api.post<PublicApproval>(`/a/${token}/decision`, { decision });
      onChange?.(next);
    } catch (err) {
      toast.fail("Could not send that", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="id-approve">
      <video
        ref={ref}
        className="id-player"
        src={fileUrl(data.video.url) ?? undefined}
        controls
        preload="metadata"
        aria-label={`Video, ${data.video.name}`}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || dur)}
      />
      {dur > 0 && pinned.length > 0 && (
        <div className="id-marks" aria-label="Comment moments">
          {pinned.map((c) => (
            <button
              key={c.id}
              type="button"
              className="id-mark"
              style={{ left: `${Math.min(100, (c.atMs! / 1000 / dur) * 100)}%` }}
              aria-label={`Jump to ${fmtClock(c.atMs!)}`}
              onClick={() => seek(c.atMs!)}
            />
          ))}
        </div>
      )}
      <ul className="id-cmts" aria-label="Comments">
        {data.comments.map((c) => (
          <li key={c.id}>
            {c.atMs != null ? (
              <button type="button" className="id-cmt" onClick={() => seek(c.atMs!)}>
                <b>{fmtClock(c.atMs)}</b> {c.body}
              </button>
            ) : (
              <span className="id-cmt">{c.body}</span>
            )}
          </li>
        ))}
        {data.comments.length === 0 && <li className="id-note">No comments yet.</li>}
      </ul>
      {token && data.status !== "approved" && (
        <>
          <label className="id-field">
            <span>Comment at {fmtClock(at * 1000)}</span>
            <textarea className="field-in" rows={2} value={body} maxLength={2000} placeholder="What should change?" onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="id-acts">
            <button type="button" className="btn ghost" disabled={busy || !body.trim()} onClick={() => void send()}>
              Add comment
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void send("changes_requested")}>
              Request changes
            </button>
            <button type="button" className="btn pri" disabled={busy} onClick={() => void send("approved")}>
              Approve
            </button>
          </div>
        </>
      )}
      {data.status === "approved" && <Note tone="ok">Approved. Thank you.</Note>}
      {token && data.status === "changes_requested" && <Note tone="warn">Changes requested. The editor has your notes.</Note>}
    </div>
  );
}

function PublicShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="id id-public">
      <header className="id-pubhead">
        <h1>{title}</h1>
        <p>From Torerone. No account needed.</p>
      </header>
      <div className="card glass id-card">{children}</div>
    </main>
  );
}

/** /a/:token, opened by the client. */
export function PublicApprovalPage({ token }: { token: string }) {
  const [data, setData] = useState<PublicApproval | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<PublicApproval>(`/a/${encodeURIComponent(token)}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? "This link does not exist." : errText(err, "could not open this link")));
  }, [token]);
  return (
    <PublicShell title={data ? `Review: ${data.video.name}` : "Review a video"}>
      {error ? <Note tone="bad">{error}</Note> : data ? <ApprovalView data={data} token={token} onChange={setData} /> : <Loading screen="approval" />}
      {data && <p className="id-note">This link expires {fmtEt(data.expiresAt)}.</p>}
    </PublicShell>
  );
}

// ------------------------------------------------------ 5. content requests

type FormInfo = ReturnType<typeof RequestFormInfoSchema.parse>;
type FormLink = ReturnType<typeof RequestFormLinkSchema.parse>;

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, o: { sitekey: string; callback(t: string): void; "expired-callback"(): void }): string;
      reset(id?: string): void;
    };
  }
}

/** Cloudflare Turnstile, drawn only when the server has it on. */
function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let gone = false;
    const draw = () => {
      if (!gone && ref.current && window.turnstile && !ref.current.childElementCount)
        window.turnstile.render(ref.current, { sitekey: siteKey, callback: onToken, "expired-callback": () => onToken("") });
    };
    if (window.turnstile) draw();
    else {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = draw;
      document.head.appendChild(s);
    }
    return () => {
      gone = true;
    };
  }, [siteKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={ref} className="id-captcha" />;
}

const EMPTY_FORM = { what: "", dueDate: "", footageUrl: "", notes: "", website: "" };

/** The form a client fills. Posts to /r/:token; the brand comes from the signed link. */
function RequestForm({ token, info, onSent }: { token: string; info: FormInfo; onSent?: () => void }) {
  const [f, setF] = useState(EMPTY_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [captcha, setCaptcha] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const tooBig = file != null && file.size > info.maxFileBytes;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Empty fields are left off: the form schema is strict and dueDate must be a date.
      const fields = Object.entries({
        what: f.what.trim(),
        dueDate: f.dueDate,
        footageUrl: f.footageUrl.trim(),
        notes: f.notes.trim(),
        website: f.website,
        turnstileToken: captcha,
      }).filter(([, v]) => v);
      const path = `/r/${encodeURIComponent(token)}`;
      if (file) {
        const form = new FormData();
        for (const [k, v] of fields) form.append(k, v);
        form.append("file", file, file.name);
        await api.postForm(path, form);
      } else {
        await api.post(path, Object.fromEntries(fields));
      }
      setF(EMPTY_FORM);
      setFile(null);
      setSent(true);
      onSent?.();
    } catch (err) {
      setError(errText(err, "could not send the request"));
      window.turnstile?.reset();
      setCaptcha("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} onChange={() => setSent(false)}>
      <label className="id-field">
        <span>What do you need?</span>
        <input className="field-in" required maxLength={2000} value={f.what} onChange={set("what")} placeholder="Walkaround of the new Urus" />
      </label>
      <label className="id-field">
        <span>Due date</span>
        <input className="field-in" type="date" value={f.dueDate} onChange={set("dueDate")} />
      </label>
      <label className="id-field">
        <span>Footage link</span>
        <input
          className="field-in"
          type="url"
          pattern="https?://.+"
          maxLength={2000}
          value={f.footageUrl}
          onChange={set("footageUrl")}
          placeholder="https://drive.google.com/..."
        />
      </label>
      <label className="id-field">
        <span>Notes</span>
        <textarea className="field-in" rows={3} maxLength={4000} value={f.notes} onChange={set("notes")} placeholder="Show the interior first." />
      </label>
      <label className="id-field">
        <span>File, optional (up to {Math.round(info.maxFileBytes / 1024 / 1024)} MB)</span>
        <input className="field-in" type="file" accept={info.fileTypes.join(",")} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      {tooBig && <Note tone="bad">That file is too big.</Note>}
      {/* Bots fill every field; people never see this one. */}
      <div className="id-hp" aria-hidden="true">
        <label>
          Website
          <input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} />
        </label>
      </div>
      {info.turnstileSiteKey && <Turnstile siteKey={info.turnstileSiteKey} onToken={setCaptcha} />}
      <button
        type="submit"
        className="btn pri id-full"
        disabled={busy || !f.what.trim() || tooBig || (!!info.turnstileSiteKey && !captcha)}
      >
        {busy ? "Sending..." : "Send request"}
      </button>
      {error && <Note tone="bad">{error}</Note>}
      {sent && <Note tone="ok">Request sent. The editor team has it.</Note>}
    </form>
  );
}

interface ContentRequestRow {
  id: string;
  clientId: string;
  what: string;
  dueDate: string | null;
  status: string;
  trelloUrl: string | null;
  error: string | null;
  createdAt: string;
}

const dueLabel = (d: string | null) =>
  d ? `due ${new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "no due date";

export function RequestsScreen() {
  const { selectedClient, clients } = useAppState();
  const toast = useToast();
  const [rows, setRows] = useState<ContentRequestRow[] | null>(null);
  const [config, setConfig] = useState<TrelloIntakeConfig | null>(null);
  const [links, setLinks] = useState<FormLink[] | null>(null);
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([
        api.get<{ requests: ContentRequestRow[] }>("/requests"),
        api.get<TrelloIntakeConfig>("/trello/intake-config").catch(() => null),
      ]);
      setRows(r.requests);
      setConfig(c);
      setError(null);
    } catch (err) {
      setError(errText(err, "could not load requests"));
    }
  }, []);

  const loadLinks = useCallback(async () => {
    if (!selectedClient) return setLinks(null);
    try {
      setLinks((await api.get<{ links: FormLink[] }>(`/request-links?brandId=${encodeURIComponent(selectedClient.id)}`)).links);
    } catch {
      setLinks([]);
    }
  }, [selectedClient]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadLinks();
  }, [loadLinks]);

  const live = links?.find((l) => !l.revokedAt);
  useEffect(() => {
    setInfo(null);
    if (live) api.get<FormInfo>(`/r/${encodeURIComponent(live.token)}`).then(setInfo).catch(() => setInfo(null));
  }, [live?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (key: string, run: () => Promise<unknown>, fail: string) => {
    setBusy(key);
    try {
      await run();
    } catch (err) {
      toast.fail(fail, err);
    } finally {
      setBusy(null);
    }
  };
  const retry = (id: string) => act(id, () => api.post(`/requests/${id}/retry`).then(load), "Trello retry failed");
  const makeLink = () => act("link", () => api.post("/request-links", { brandId: selectedClient!.id }).then(loadLinks), "Could not make the form link");
  const rotate = (id: string) => act("link", () => api.post(`/request-links/${id}/rotate`).then(loadLinks), "Could not replace the link");
  const revoke = (id: string) => act("link", () => api.del(`/request-links/${id}`).then(loadLinks), "Could not turn the link off");

  const nameOf = (id: string) => clients.find((c) => c.id === id)?.name ?? "Unknown brand";
  const where = config ? `${config.boardName.replace(/^Torone /, "")}, ${config.listName}` : "Editor Pipeline, To edit";
  const state = error ? "error" : rows === null ? "loading" : "ready";
  const formLink = live ? publicLink(PUBLIC_APP_URL, live.url) : "";

  return (
    <Screen id="requests" state={state} title="Content requests" sub="Clients ask. A Trello card lands in the editor pipeline.">
      {state === "error" && <ErrorState screen="requests" message={error} onRetry={() => void load()} />}
      {state === "loading" && <Loading screen="requests" label="Loading requests" />}
      {state === "ready" && (
        <div className="id-two">
          <div className="card glass id-card" data-testid="requests.form">
            <Lbl>Client form, no login</Lbl>
            {!selectedClient ? (
              <p className="id-note">Pick a brand in the dock to share its form.</p>
            ) : links === null ? (
              <Loading screen="requests-links" />
            ) : !live ? (
              <>
                <p className="id-note">
                  {selectedClient.name} has no live form link. Each link is signed for one brand and can be turned off at any time.
                </p>
                <button type="button" className="btn pri id-full" disabled={busy === "link"} onClick={() => void makeLink()}>
                  Make form link
                </button>
              </>
            ) : (
              <>
                {info ? <RequestForm token={live.token} info={info} onSent={() => void load()} /> : <Loading screen="requests-form" />}
                <label className="id-field">
                  <span>{selectedClient.name}'s form link</span>
                  <input className="field-in id-mono" readOnly value={formLink || live.url} onFocus={(e) => e.currentTarget.select()} />
                </label>
                <div className="id-acts">
                  <button type="button" className="btn ghost" onClick={() => void copy(formLink || live.url, toast)}>
                    Copy link
                  </button>
                  <button type="button" className="btn ghost" disabled={busy === "link"} onClick={() => void rotate(live.id)}>
                    Replace link
                  </button>
                  <button type="button" className="btn ghost" disabled={busy === "link"} onClick={() => void revoke(live.id)}>
                    Turn off
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="card glass id-card" data-testid="requests.list">
            <Lbl>Operator list</Lbl>
            {rows!.length === 0 ? (
              <p className="id-note">No requests yet. They show here the moment a client sends one.</p>
            ) : (
              <ul className="id-list">
                {rows!.map((r) => (
                  <li className="id-row" key={r.id}>
                    <div className="id-rowtext">
                      <b>{r.what.split("\n")[0]}</b> {nameOf(r.clientId)}, {dueLabel(r.dueDate)}
                      <small>
                        {r.status === "created" ? (
                          <>
                            <Badge>Trello card created</Badge> {where}
                          </>
                        ) : r.status === "failed" ? (
                          <>Card failed. {r.error ?? "Trello did not answer."}</>
                        ) : (
                          <>Sending to Trello</>
                        )}
                      </small>
                    </div>
                    {r.status === "created" && r.trelloUrl && (
                      <button type="button" className="btn ghost" onClick={() => void openExternal(r.trelloUrl!)}>
                        Open card
                      </button>
                    )}
                    {r.status === "failed" && (
                      <button type="button" className="btn ghost" disabled={busy === r.id} onClick={() => void retry(r.id)}>
                        {busy === r.id ? "Retrying..." : "Retry"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Screen>
  );
}

/** /r/:token, opened by the client. */
export function PublicRequestPage({ token }: { token: string }) {
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<FormInfo>(`/r/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 404
            ? "This form link does not exist."
            : err instanceof ApiError && err.status === 410
              ? "This form link was turned off. Ask for a new one."
              : errText(err, "could not open this form"),
        ),
      );
  }, [token]);
  return (
    <PublicShell title={info ? `Request content for ${info.brandName}` : "Request content"}>
      {error ? <Note tone="bad">{error}</Note> : info ? <RequestForm token={token} info={info} /> : <Loading screen="request" />}
    </PublicShell>
  );
}

// ------------------------------------------------------ 4. monthly report

export function MonthlyReportScreen() {
  const { selectedClient } = useAppState();
  const months = useMemo(() => recentMonths(6), []);
  const [month, setMonth] = useState(months[0]!);
  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [config, setConfig] = useState<ReportJobConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const posts = useBrandPosts(selectedClient?.id);

  const load = useCallback(async () => {
    if (!selectedClient) return;
    setReport(null);
    try {
      const [r, c] = await Promise.all([
        api.get<MonthlyReport>(`/reports/monthly/${selectedClient.id}/${month}`),
        api.get<ReportJobConfig>("/reports/job-config"),
      ]);
      setReport(r);
      setConfig(c);
      setError(null);
    } catch (err) {
      setError(errText(err, "could not build the report"));
    }
  }, [selectedClient, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const top = report?.topPostId ? posts?.find((p) => p.postId === report.topPostId)?.assetName : null;
  const state = !selectedClient ? "empty" : error ? "error" : report && config ? "ready" : "loading";

  return (
    <Screen id="monthly" state={state} title="Monthly client report" sub="Preview first. The job builds every report on the 1st.">
      {state === "empty" && NO_BRAND("monthly", "Pick a brand in the dock to preview its report.")}
      {state === "error" && <ErrorState screen="monthly" message={error} onRetry={() => void load()} />}
      {state === "loading" && <Loading screen="monthly" label="Building the report" />}
      {state === "ready" && report && config && (
        <div className="id-two">
          <div className="card glass id-card" data-testid="report.preview">
            <div className="id-cardhead">
              <Lbl>
                Preview, {selectedClient!.name}, {monthLabel(report.month)}
              </Lbl>
              <Select
                aria-label="Report month"
                className="id-month"
                value={month}
                options={months.map((m) => ({ value: m, label: monthLabel(m) }))}
                onChange={setMonth}
              />
            </div>
            <div className="id-stats">
              <div className="id-stat">
                <b>{compact(report.views)}</b>
                <span>Views</span>
              </div>
              <div className="id-stat">
                <b>{report.followersGained >= 0 ? "+" : ""}{report.followersGained.toLocaleString("en-US")}</b>
                <span>Followers</span>
              </div>
              <div className="id-stat">
                <b>{report.posts}</b>
                <span>Posts</span>
              </div>
            </div>
            <p className="id-line">
              <b>Top post:</b> {report.topPostId ? (top ?? "a post from this month") : "none this month"}.
            </p>
            <p className="id-line">
              <b>Next month:</b> {report.nextMonthPlan.length ? report.nextMonthPlan.join(", ") : "nothing scheduled yet"}.
            </p>
            {report.sentAt && <Note tone="ok">Sent {fmtEt(report.sentAt)}.</Note>}
          </div>
          <div className="card glass id-card" data-testid="report.schedule">
            <Lbl>Schedule</Lbl>
            <dl className="id-dl">
              <dt>Runs</dt>
              <dd>The 1st of every month, ET. Next: {nextRunLabel()}</dd>
              <dt>From</dt>
              <dd>{REPORT_SENDER}</dd>
              <dt>To</dt>
              <dd>
                Every email on the client profile.{" "}
                {selectedClient!.contactEmail ? `For ${selectedClient!.name}: ${selectedClient!.contactEmail}` : `${selectedClient!.name} has no email on the profile yet.`}
              </dd>
              <dt>Covers</dt>
              <dd>The month that just ended</dd>
            </dl>
            <KillSwitch on={config.killSwitch} />
            <Note tone={config.killSwitch ? "ok" : "warn"}>
              {config.killSwitch
                ? "Sending is on. Each brand gets one email per month."
                : "Sending is off. Nothing leaves this app until the kill switch is turned on at the server."}
            </Note>
          </div>
        </div>
      )}
    </Screen>
  );
}

// ------------------------------------------- 3 + 6. insights and best time

export function InsightsScreen() {
  const { selectedClient } = useAppState();
  const targets = useBrandPosts(selectedClient?.id);
  const [history, setHistory] = useState<ClientPost[] | null>(null);
  const [postId, setPostId] = useState("");
  const [insights, setInsights] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHistory(null);
    if (!selectedClient) return;
    api
      .get<{ posts: ClientPost[] }>(`/clients/${selectedClient.id}/analytics/posts`)
      .then((r) => setHistory(r.posts))
      .catch(() => setHistory([]));
  }, [selectedClient]);

  const posted = useMemo(() => {
    const seen = new Map<string, PostTargetInfo>();
    for (const t of targets ?? []) if (t.status === "posted" && !seen.has(t.postId)) seen.set(t.postId, t);
    return [...seen.values()].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  }, [targets]);
  const current = postId || posted[0]?.postId || "";

  useEffect(() => {
    setInsights(null);
    setError(null);
    if (!current) return;
    api
      .get<Insights>(`/insights/${current}`)
      .then(setInsights)
      .catch((err) => setError(errText(err, "could not load insights")));
  }, [current]);

  const bt = useMemo(() => (history ? bestTime(history.map((p) => ({ publishedAt: p.publishedAt, views: p.views }))) : null), [history]);
  const table = insights ? insightTable(insights.insights) : [];
  const platforms = [...new Set(insights?.insights.map((i) => i.platform ?? "total"))].sort((a, b) => (a === "total" ? 1 : b === "total" ? -1 : a.localeCompare(b)));
  const state = !selectedClient ? "empty" : targets === null || history === null ? "loading" : "ready";

  return (
    <Screen id="insights" state={state} title="Insights" sub="Every number from every source, merged once, with where it came from.">
      {state === "empty" && NO_BRAND("insights", "Pick a brand in the dock to see its numbers.")}
      {state === "loading" && <Loading screen="insights" label="Loading insights" />}
      {state === "ready" && (
        <>
          <div className="card glass id-card" data-testid="insights.merged">
            <div className="id-cardhead">
              <Lbl>Merged insights, one post</Lbl>
              {posted.length > 0 && (
                <Select
                  aria-label="Post"
                  className="id-month"
                  value={current}
                  options={posted.map((t) => ({ value: t.postId, label: t.assetName, hint: t.publishedAt ? fmtEt(t.publishedAt) : undefined }))}
                  onChange={setPostId}
                />
              )}
            </div>
            {posted.length === 0 ? (
              <p className="id-note">Nothing has posted for {selectedClient!.name} yet.</p>
            ) : error ? (
              <Note tone="bad">{error}</Note>
            ) : !insights ? (
              <Loading screen="insights-post" />
            ) : table.length === 0 ? (
              <p className="id-note">No source has reported numbers for this post yet.</p>
            ) : (
              <div className="id-scroll">
                <table className="id-table">
                  <caption className="sr-only">Numbers by metric and platform, with their source</caption>
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      {platforms.map((p) => (
                        <th scope="col" key={p}>
                          {p === "total" ? "Total" : (PLATFORM_LABELS as Record<string, string>)[p] ?? p}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.map((r) => (
                      <tr key={r.metric}>
                        <th scope="row">{r.metric}</th>
                        {platforms.map((p) => {
                          const c = r.cells[p];
                          return (
                            <td key={p}>
                              {c ? (
                                <>
                                  {c.value.toLocaleString("en-US")}
                                  <small>
                                    {SOURCE_LABEL[c.chosenSource]}
                                    {c.sources.length > 1 ? `, also ${c.sources.filter((s) => s !== c.chosenSource).map((s) => SOURCE_LABEL[s]).join(", ")}` : ""}
                                  </small>
                                </>
                              ) : (
                                <span aria-label="not reported">-</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {insights?.unavailable.map((u) => (
              <Note tone="warn" key={u.source}>
                {SOURCE_LABEL[u.source]} could not answer: {u.reason}
              </Note>
            ))}
          </div>
          {bt && <BestTimeCard bt={bt} brand={selectedClient!.name} />}
        </>
      )}
    </Screen>
  );
}

function BestTimeCard({ bt, brand }: { bt: ReturnType<typeof bestTime>; brand: string }) {
  return (
    <div className="id-two">
      <div className="card glass id-card" data-testid="besttime.heatmap">
        <Lbl>Views per post by hour, ET</Lbl>
        <div className="id-scroll">
          <table className="id-heat">
            <caption className="sr-only">Average views per post for {brand}, by day and three-hour band, last 90 days, Eastern time</caption>
            <thead>
              <tr>
                <td />
                {DAYS.map((d) => (
                  <th scope="col" key={d}>
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {BANDS.map((b, bi) => (
                <tr key={b}>
                  <th scope="row">{hourLabel(b).replace(" AM", "a").replace(" PM", "p")}</th>
                  {DAYS.map((d, di) => {
                    const v = bt.grid[di]![bi];
                    const k = v == null || !bt.max ? 0 : Math.max(0.12, v / bt.max);
                    return (
                      <td key={d}>
                        <span className="id-cell" style={{ ["--k" as string]: k }} title={v == null ? "No posts" : `${compact(v)} views per post`}>
                          <span className="sr-only">{v == null ? "no posts" : `${compact(v)} views per post`}</span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="id-note">Darker coral means more views per post. Last 90 days, every platform.</p>
      </div>
      <div className="card glass id-card" data-testid="besttime.slots">
        <Lbl>Suggested slots</Lbl>
        {bt.slots.length === 0 ? (
          <p className="id-note">No slot beats the average yet.</p>
        ) : (
          <ul className="id-list">
            {bt.slots.map((s) => (
              <li className="id-row" key={`${s.day}-${s.band}`}>
                <div className="id-rowtext">
                  <b>{slotLabel(s)}</b>
                  <small>
                    +{s.uplift}% views vs average, {s.posts} posts
                  </small>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Note tone={bt.enough ? undefined : "warn"}>
          {bt.enough
            ? `Based on ${bt.count} posts.`
            : `Not enough data: ${bt.count} of ${ENOUGH_POSTS} posts in the last 90 days. Treat these as hints.`}
        </Note>
      </div>
    </div>
  );
}

// ------------------------------------------------------- 7. failed posts

/** Fired after a retry or remove so the app-wide banner recounts now, not in two minutes. */
const FAILED_CHANGED = "toreroflow:failed-posts-changed";

export function FailedPostsScreen() {
  const { clients } = useAppState();
  const toast = useToast();
  const [list, setList] = useState<FailedList | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, RetryOutcome>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const l = await api.get<FailedList>("/failed-posts");
      setList(l);
      setError(null);
      // Names come from each brand's posts; the failed list only carries ids.
      const brands = [...new Set(l.items.map((i) => i.brandId))];
      const all = await Promise.all(brands.map((b) => api.get<PostTargetInfo[]>(`/clients/${b}/posts`).catch(() => [])));
      setNames(Object.fromEntries(all.flat().map((t) => [t.id, t.assetName])));
    } catch (err) {
      setError(errText(err, "could not load failed posts"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (id: string) => {
    setBusy(id);
    try {
      const r = await api.post<{ outcome: RetryOutcome }>(`/failed-posts/${id}/retry`);
      setDone((d) => ({ ...d, [id]: r.outcome }));
      setPicked((s) => new Set([...s].filter((p) => p !== id)));
      toast.success(RETRY_OUTCOME[r.outcome]);
      window.dispatchEvent(new Event(FAILED_CHANGED));
    } catch (err) {
      toast.fail("Retry did not go through", err);
    } finally {
      setBusy(null);
    }
  };

  const brandName = (id: string) => clients.find((c) => c.id === id)?.name ?? "Unknown brand";
  // Still failed: not retried, or retried into "reconnect first".
  const openIds = list ? list.items.filter((i) => !done[i.postTargetId] || done[i.postTargetId] === "needs_reconnect").map((i) => i.postTargetId) : [];
  const open = openIds.length;
  const allPicked = open > 0 && openIds.every((id) => picked.has(id));
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const state = error ? "error" : list === null ? "loading" : list.items.length === 0 ? "empty" : "ready";

  // Removing hides the failure notice only; the post and its media stay put.
  const remove = async (ids: string[] | "all") => {
    if (ids === "all" && !window.confirm(`Remove all ${open} failure notices? The posts themselves are not deleted.`)) return;
    setBusy("remove");
    try {
      const r = await (ids === "all"
        ? api.post<{ dismissed: number }>("/failed-posts/dismiss", { all: true })
        : ids.length === 1
          ? api.post<{ dismissed: number }>(`/failed-posts/${ids[0]}/dismiss`)
          : api.post<{ dismissed: number }>("/failed-posts/dismiss", { postTargetIds: ids }));
      const gone = new Set(ids === "all" ? openIds : ids);
      setList((l) => l && { count: Math.max(0, l.count - gone.size), items: l.items.filter((i) => !gone.has(i.postTargetId)) });
      setPicked(new Set());
      toast.success(`Removed ${gone.size} ${gone.size === 1 ? "notice" : "notices"}. The posts are untouched.`);
      window.dispatchEvent(new Event(FAILED_CHANGED));
    } catch (err) {
      toast.fail("Remove did not go through", err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen id="failed" state={state} title="Failed posts" sub="Every failure with the reason, and one tap to retry. Nothing retries on its own.">
      {state === "error" && <ErrorState screen="failed" message={error} onRetry={() => void load()} />}
      {state === "loading" && <Loading screen="failed" label="Loading failed posts" />}
      {state === "empty" && <Empty screen="failed" title="Nothing failed" hint="Every scheduled post went out." />}
      {state === "ready" && (
        <>
          {open > 0 && (
            <div className="id-alert id-fail-bar" role="region" aria-label="Failed posts actions">
              <label className="id-check">
                <input
                  type="checkbox"
                  checked={allPicked}
                  ref={(el) => {
                    if (el) el.indeterminate = picked.size > 0 && !allPicked;
                  }}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(openIds))}
                  aria-label={allPicked ? "Clear selection" : "Select all failed posts"}
                />
                <span>Select all</span>
              </label>
              <span className="id-fail-count" role="status">
                <b>
                  {open} {open === 1 ? "post" : "posts"} failed.
                </b>{" "}
                {picked.size ? `${picked.size} selected.` : "Fix and retry below."}
              </span>
              <span className="id-fail-acts">
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!picked.size || busy === "remove"}
                  onClick={() => void remove([...picked])}
                  aria-label={`Remove ${picked.size} selected failure ${picked.size === 1 ? "notice" : "notices"}`}
                >
                  Remove selected{picked.size ? ` (${picked.size})` : ""}
                </button>
                <button type="button" className="btn ghost" disabled={busy === "remove"} onClick={() => void remove("all")} aria-label="Remove all failure notices">
                  Remove all
                </button>
              </span>
            </div>
          )}
          <div className="card glass id-card">
            <ul className="id-list">
              {list!.items.map((i) => {
                const outcome = done[i.postTargetId];
                const reconnect = i.action === "reconnect" || outcome === "needs_reconnect";
                const stillFailed = !outcome || outcome === "needs_reconnect";
                const name = names[i.postTargetId] ?? "A post";
                return (
                  <li className={`id-row${picked.has(i.postTargetId) ? " picked" : ""}`} key={i.postTargetId}>
                    {stillFailed && (
                      <input
                        type="checkbox"
                        className="id-rowcheck"
                        checked={picked.has(i.postTargetId)}
                        onChange={() => toggle(i.postTargetId)}
                        aria-label={`Select ${name}, ${PLATFORM_LABELS[i.platform]}`}
                      />
                    )}
                    <div className="id-rowtext">
                      <b>{name}</b> {brandName(i.brandId)}, {PLATFORM_LABELS[i.platform]}
                      {i.scheduledAt ? `, ${fmtEt(i.scheduledAt)}` : ""}
                      {outcome && outcome !== "needs_reconnect" && (
                        <>
                          {" "}
                          <Badge tone="ok">{outcome === "already_live" ? "Already live" : "Queued"}</Badge>
                        </>
                      )}
                      <small>
                        {outcome ? RETRY_OUTCOME[outcome] : `${i.reason}. ${i.advice}`}
                      </small>
                      {!outcome && i.error && <small className="id-err">Platform said: {i.error}</small>}
                    </div>
                    {reconnect ? (
                      <a className="btn ghost" {...linkProps("settings", "accounts")}>
                        Reconnect
                      </a>
                    ) : (
                      !outcome && (
                        <button type="button" className="btn ghost" disabled={busy === i.postTargetId} onClick={() => void retry(i.postTargetId)}>
                          {busy === i.postTargetId ? "Checking..." : "Retry"}
                        </button>
                      )
                    )}
                    {stillFailed && (
                      <button
                        type="button"
                        className="iconbtn id-dismiss"
                        disabled={busy === "remove"}
                        onClick={() => void remove([i.postTargetId])}
                        aria-label={`Remove the failure notice for ${name}, ${PLATFORM_LABELS[i.platform]}`}
                        title="Remove from this list. The post is not deleted."
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </Screen>
  );
}

/** The app-wide alert: a failed post shows on every screen until it is dealt with. */
export function FailedPostBanner() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const poll = () =>
      void api
        .get<FailedList>("/failed-posts")
        .then((l) => setCount(l.count))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 2 * 60 * 1000);
    window.addEventListener(FAILED_CHANGED, poll);
    return () => {
      clearInterval(t);
      window.removeEventListener(FAILED_CHANGED, poll);
    };
  }, []);
  if (!count) return null;
  return (
    <div className="id-alert id-alert-global" role="status" data-testid="failed.banner">
      <span>
        <b>
          {count} {count === 1 ? "post" : "posts"} failed.
        </b>{" "}
        Nothing retries on its own.
      </span>
      <button type="button" className="btn ghost" onClick={() => navigate("failed")}>
        See failed posts
      </button>
    </div>
  );
}
