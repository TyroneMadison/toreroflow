import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DmRunView } from "@toreroflow/core";
import Pf from "../Pf";
import Modal from "../../modals/Modal";
import { Sheet } from "../analytics/phoneBits";
import { useToast } from "../Toasts";
import { startInstagramConnect } from "../DmConnect";
import { api } from "../../lib/api";
import { PF_ID } from "../../lib/platforms";
import { ago, clock, tone } from "../../lib/inbox";
import { addKeywords, RUN_PILL, runLine, spark, type AutoPost, type RowState } from "../../lib/automations";
import "../inbox/inbox.css";
import "./automations.css";

/** Small shared pieces of the Automations list and editor (F4). */

export const I = ({ name, className }: { name: string; className?: string }) => (
  <svg className={`ibx-i${className ? ` ${className}` : ""}`} viewBox="0 0 24 24" aria-hidden="true">
    <use href={`#${name}`} />
  </svg>
);

export const Dot = ({ state }: { state: RowState }) => (
  <span className={`au-dot ${state}`} role="img" aria-label={state === "live" ? "Live" : state === "draft" ? "Draft" : "Off"} title={state === "live" ? "Live" : state === "draft" ? "Draft" : "Off"} />
);

export const StatePill = ({ state }: { state: RowState }) => <span className={`au-st ${state}`}>{state === "live" ? "LIVE" : state === "draft" ? "DRAFT" : "OFF"}</span>;

export function Switch({ on, label, disabled, onChange, className }: { on: boolean; label: string; disabled?: boolean; onChange(v: boolean): void; className?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={className ?? "au-swbtn"} onClick={() => onChange(!on)}>
      <span className={`au-tog${on ? " on" : ""}`} aria-hidden="true" />
    </button>
  );
}

export const Acct = ({ platform, handle }: { platform: "instagram" | "facebook"; handle: string }) => (
  <span className="au-acct">
    <Pf p={PF_ID[platform]} size="xs" />
    {platform === "facebook" ? handle : `@${handle.replace(/^@/, "")}`}
  </span>
);

export function Spark({ values }: { values: number[] }) {
  const s = spark(values);
  if (!s) return null;
  return (
    <svg className={`au-spark${s.trend === "flat" ? "" : ` ${s.trend}`}`} viewBox="0 0 72 22" aria-hidden="true">
      <path d={s.d} />
    </svg>
  );
}

export function RunPill({ status }: { status: string }) {
  const p = RUN_PILL[status] ?? { cls: "", label: status };
  return <span className={`au-pill${p.cls ? ` ${p.cls}` : ""}`}>{p.label}</span>;
}

/** One recent comment (round 2 mockup, Recent comments). */
export function RunRow({ r, phone }: { r: DmRunView; phone?: boolean }) {
  const name = r.username ? `@${r.username.replace(/^@/, "")}` : "Instagram user";
  return (
    <div className={phone ? "mb-lrow au-lrow" : "au-crow"} data-testid="automations.run">
      <span className={`ibx-av ${phone ? "s36" : ""} ${tone(r.username ?? r.id)}`}>{(r.username ?? "?").replace(/^@/, "").slice(0, 1).toUpperCase()}</span>
      <span className={phone ? "mb-lt" : "t"}>
        <b>{name}</b>
        <small>{runLine(r)}</small>
      </span>
      <span className={phone ? "mb-tr" : "r"}>
        <RunPill status={r.status} />
        {!phone && ago(r.createdAt)}
      </span>
    </div>
  );
}

/** A keyword box: chips with a remove button, Enter or a comma adds. */
export function KwBox({ value, onChange, placeholder, disabled, label, phone }: { value: string[]; onChange(v: string[]): void; placeholder: string; disabled?: boolean; label: string; phone?: boolean }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (!draft.trim()) return;
    onChange(addKeywords(value, draft));
    setDraft("");
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className={phone ? "au-kwbox ph" : "au-kwbox"}>
      {value.map((k) => (
        <span className="au-kw" key={k}>
          {k}
          {!disabled && (
            <button type="button" aria-label={`Remove ${k}`} onClick={() => onChange(value.filter((x) => x !== k))}>
              <I name="i-x" />
            </button>
          )}
        </span>
      ))}
      {!disabled && value.length < 20 && (
        <input aria-label={label} value={draft} placeholder={value.length ? (phone ? "Add a keyword" : "Add a keyword, then press Enter") : placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={key} onBlur={commit} />
      )}
    </div>
  );
}

/** The thumbnail of one post, or a gradient when Instagram's link has expired. */
function Thumb({ p, i }: { p: AutoPost; i: number }) {
  const [broken, setBroken] = useState(false);
  const g = ["#7a3a2c", "#7a5a2c", "#2c4a7a", "#2c7a5a", "#5a2c7a", "#7a2c4a"][i % 6];
  return (
    <span className="thumb" style={{ ["--g" as string]: g }}>
      {p.thumbnail && !broken && <img src={p.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />}
      {p.reel && <I name="i-play" />}
    </span>
  );
}

export const postDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Post");

/**
 * "Which posts": any post, the next one, or one picked from THIS Instagram
 * account's posts (never YouTube: the list comes from the account's own
 * Instagram media). A modal on desktop, a sheet on the phone (mockup 02 posts).
 */
export function PostPicker({
  clientId,
  accountId,
  handle,
  scope,
  postIds,
  phone,
  onClose,
  onPick,
}: {
  clientId: string;
  accountId: string;
  handle: string;
  scope: "all" | "next" | "posts";
  postIds: string[];
  phone: boolean;
  onClose(): void;
  onPick(scope: "all" | "next" | "posts", postIds: string[]): void;
}) {
  const [mode, setMode] = useState(scope);
  const [pick, setPick] = useState<string | null>(postIds[0] ?? null);
  const [posts, setPosts] = useState<AutoPost[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<{ posts: AutoPost[] }>(`/clients/${clientId}/dm/automations/posts?accountId=${encodeURIComponent(accountId)}`)
      .then((r) => live && setPosts(r.posts))
      .catch((e: unknown) => live && (setPosts([]), setErr(e instanceof Error ? e.message : "could not load the posts")));
    return () => {
      live = false;
    };
  }, [clientId, accountId]);
  const chosen = posts?.find((p) => p.id === pick);
  const opts: Array<{ id: "all" | "next" | "posts"; b: string; s: string }> = [
    { id: "all", b: "Any post or reel", s: phone ? "Old and new" : `Every post and reel on @${handle}, old and new.` },
    { id: "next", b: "Next post or reel", s: phone ? "Locks onto the next one you publish" : "Locks onto the next one you publish." },
    { id: "posts", b: "A specific post or reel", s: phone ? `Pick one from @${handle}` : `Recent posts and reels from @${handle} on Instagram.` },
  ];
  const body = (
    <div className="au-picker" data-testid="automations.posts">
      <div role="radiogroup" aria-label="Which posts">
        {opts.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={mode === o.id} className={phone ? "mb-optrow au-opt" : "au-opt"} onClick={() => setMode(o.id)}>
            <span className={`au-radio${mode === o.id ? " on" : ""}`} aria-hidden="true" />
            <span className="lt">
              <b>{o.b}</b>
              <small>{o.s}</small>
            </span>
          </button>
        ))}
      </div>
      {mode === "posts" &&
        (posts === null ? (
          <p className="au-help">Loading the posts from @{handle}...</p>
        ) : !posts.length ? (
          <p className="au-help">{err ?? `No Instagram posts from @${handle} yet. They show up here once the app has synced the account, or once it is connected through Torerone's Meta app.`}</p>
        ) : (
          <div className={phone ? "au-thumbs ph" : "au-thumbs"} role="radiogroup" aria-label={`Posts from @${handle}`}>
            {posts.map((p, i) => (
              <button key={p.id} type="button" role="radio" aria-checked={pick === p.id} className="au-tpick" title={p.caption ?? undefined} onClick={() => setPick(p.id)} data-testid="automations.post">
                {pick === p.id && (
                  <span className="ok">
                    <I name="i-check" />
                  </span>
                )}
                <Thumb p={p} i={i} />
                <span className="cap">{postDate(p.at)}</span>
              </button>
            ))}
          </div>
        ))}
    </div>
  );
  const can = mode !== "posts" || !!pick;
  const use = () => {
    if (!can) return;
    onPick(mode, mode === "posts" && pick ? [pick] : []);
    onClose();
  };
  const cta = mode === "posts" ? (chosen?.reel === false ? "Use this post" : "Use this reel") : "Use this";
  if (phone) {
    return (
      <Sheet label="Which posts" title="Which posts" onClose={onClose} className="au-sheet" foot={<button type="button" className="mb-btn pri block" disabled={!can} onClick={use}>{cta}</button>}>
        {body}
      </Sheet>
    );
  }
  return (
    <Modal maxWidth={760} onClose={onClose} label="Which posts" testId="automations.posts-modal">
      <div className="ibx-wrap au au-modal">
        <div className="mh">
          <div className="grow">
            <h2>Which posts</h2>
            <p>Only Instagram posts and reels from @{handle}.</p>
          </div>
          <button type="button" className="ibx-btn icon ghost" aria-label="Close" onClick={onClose}>
            <I name="i-x" />
          </button>
        </div>
        <div className="mb">{body}</div>
        <div className="mf">
          <button type="button" className="au-hbtn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="au-hbtn pri" disabled={!can} onClick={use}>
            {cta}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The connection line: automations send through Torerone's Meta app, so until
 * an Instagram account is connected that way they wait (drafts and Live alike).
 * Dark-launched servers say so and keep the button off.
 */
export function ConnectLine({ accountId, configured, phone }: { accountId: string | null; configured: boolean; phone: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className={phone ? "au-slim warn" : "au-notice warn"} data-testid="automations.connect">
      <I name="i-info" />
      <span className="grow">
        <b>Automations here send through Torerone's Meta app.</b>{" "}
        {configured ? "Connect Instagram and they start answering. Until then nothing sends." : "It is not switched on for this server yet, so they wait. Your Zernio campaigns keep running."}
      </span>
      {accountId && (
        <button
          type="button"
          className={phone ? "mb-btn sm" : "ibx-btn"}
          disabled={!configured || busy}
          onClick={async () => {
            setBusy(true);
            await startInstagramConnect(accountId, toast);
            setBusy(false);
          }}
        >
          Connect Instagram
        </button>
      )}
    </div>
  );
}

export function CouldNotLoad({ phone, lastLoaded, onRetry, what }: { phone: boolean; lastLoaded: Date | null; onRetry(): void; what: string }) {
  return (
    <section className={phone ? "mb-card ibx-empty" : "au-card ibx-empty"} role="alert" data-testid="automations.error">
      <span className="ei bad">
        <I name="i-wifi-off" />
      </span>
      <h3>Could not load {what}</h3>
      <p>Toreroflow could not reach its server. Automations keep running on the server, and will show here once it is back.</p>
      <div className="acts">
        <button type="button" className={phone ? "mb-btn block" : "ibx-btn"} onClick={onRetry} data-testid="automations.retry">
          <I name="i-refresh" />
          Retry
        </button>
      </div>
      <p className="help">Trying again on its own every 15 seconds.{lastLoaded ? ` Last loaded ${clock(lastLoaded)}.` : ""}</p>
    </section>
  );
}

export function Skeleton({ phone, label }: { phone: boolean; label: string }) {
  return (
    <div className={phone ? "mb-card ibx-skel" : "au-card ibx-skel"} aria-busy="true" role="status" aria-label={label} data-testid="automations.loading">
      <span className="skel" style={{ width: "40%" }} />
      <span className="skel" />
      <span className="skel" style={{ width: "75%" }} />
      <span className="skel" style={{ width: "60%" }} />
    </div>
  );
}

/** A small confirm or text-entry dialog: Modal on desktop, Sheet on the phone. */
export function Dialog({ phone, title, sub, children, foot, onClose, testId }: { phone: boolean; title: string; sub?: string; children: ReactNode; foot: ReactNode; onClose(): void; testId?: string }) {
  if (phone) {
    return (
      <Sheet label={title} title={title} sub={sub} onClose={onClose} foot={foot} className="au-sheet" testId={testId}>
        {children}
      </Sheet>
    );
  }
  return (
    <Modal maxWidth={520} onClose={onClose} label={title} testId={testId}>
      <div className="ibx-wrap au au-modal">
        <div className="mh">
          <div className="grow">
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
          <button type="button" className="ibx-btn icon ghost" aria-label="Close" onClick={onClose}>
            <I name="i-x" />
          </button>
        </div>
        <div className="mb">{children}</div>
        <div className="mf">{foot}</div>
      </div>
    </Modal>
  );
}
