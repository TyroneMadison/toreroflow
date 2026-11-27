import { useEffect, useRef, useState, type ReactNode } from "react";
import { DM_STAGE_LABEL, type DmAttachmentView, type DmContactView, type DmMessageView, type DmStage, type DmThreadView } from "@toreroflow/core";
import Pf from "../Pf";
import { openExternal } from "../../lib/external";
import { convoState, CONVO_LABEL, PART_LABEL, tone, who } from "../../lib/inbox";

/*
 * The Inbox's small pieces (mockups round 1, 02 and 10), shared by the
 * desktop panes, the phone flow and Contacts. Class names are the mockups'
 * with an ibx- prefix, so nothing collides with the rest of the app.
 */

export function I({ name }: { name: string }) {
  return (
    <svg className="ibx-i" viewBox="0 0 24 24" aria-hidden="true">
      <use href={`#${name}`} />
    </svg>
  );
}

/** Their picture, or their initial on one of eight tones; the green dot while the reply window is open. */
export function Avatar({ contact, size, win = false }: { contact: Pick<DmContactView, "id" | "displayName" | "handle" | "avatarUrl">; size?: number; win?: boolean }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [contact.avatarUrl]);
  const name = who(contact);
  return (
    <span className={`ibx-av ${tone(contact.id)}${size ? ` s${size}` : ""}`} aria-hidden="true">
      {contact.avatarUrl && !broken ? <img src={contact.avatarUrl} alt="" onError={() => setBroken(true)} /> : name.replace(/^@/, "").charAt(0).toUpperCase()}
      {win && <span className="win" />}
    </span>
  );
}

/** The channel badge every row and header carries: IG or Messenger. */
export function Channel({ platform, label }: { platform: "instagram" | "facebook"; label?: string }) {
  return (
    <span className="ibx-ch">
      <Pf p={platform === "facebook" ? "fb" : "ig"} size="xs" />
      {label ?? (platform === "facebook" ? "Messenger" : "IG")}
    </span>
  );
}

export function Stage({ stage, dot = false }: { stage: DmStage; dot?: boolean }) {
  return (
    <span className={`ibx-stage ${stage}`}>
      {dot && <span className="ibx-sdot" />}
      {DM_STAGE_LABEL[stage]}
    </span>
  );
}

/** Paused, Flagged or Done; nothing for an active conversation. */
export function StateChip({ thread }: { thread: Pick<DmThreadView, "status" | "pausedAt"> }) {
  const s = convoState(thread);
  if (s === "active") return null;
  return <span className={`ibx-sc ${s === "flagged" ? "flag" : s}`}>{CONVO_LABEL[s]}</span>;
}

/** Bars for a voice note, the same for the same message every time. */
function bars(seed: string, n: number): number[] {
  let h = 7;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  return Array.from({ length: n }, (_, i) => 22 + (((h >> (i % 24)) ^ (i * 2654435761)) >>> 0) % 74);
}

const mmss = (s: number) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");

/** A voice note: play, the bars filling as it plays, the length, and the transcript under it. */
export function VoiceNote({ id, url, transcript, rate = 1, pos, onBroken }: { id: string; url: string | null; transcript: string | null; rate?: number; pos: string; onBroken(): void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [dur, setDur] = useState(0);
  const [at, setAt] = useState(0);
  const heights = bars(id, 24);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play().catch(onBroken);
    else a.pause();
  };
  const done = dur ? at / dur : 0;
  return (
    <div className={`ibx-bub vn ${pos}`}>
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => (setPlaying(false), setAt(0))}
          onError={onBroken}
        />
      )}
      <div className="pl">
        <button type="button" className="pb" onClick={toggle} disabled={!url} aria-label={playing ? "Pause voice message" : "Play voice message"}>
          <I name={playing ? "i-pause" : "i-play"} />
        </button>
        <span className="wave" aria-hidden="true">
          {heights.map((h, i) => (
            <i key={i} className={i / heights.length < done ? "p" : undefined} style={{ height: `${h}%` }} />
          ))}
        </span>
        <span className="dur">{mmss(playing || at ? at : dur)}</span>
      </div>
      {transcript && (
        <div className="tr">
          <b>Transcript</b>
          {transcript}
        </div>
      )}
    </div>
  );
}

/**
 * A photo through our media proxy. When Meta has expired it and the proxy
 * cannot get a fresh one, the box says so and offers to load the thread again
 * (which signs new links), rather than a broken image.
 */
function Photo({ url, sticker, onBroken, onOpen }: { url: string | null; sticker: boolean; onBroken(): void; onOpen?(): void }) {
  const [broken, setBroken] = useState(!url);
  useEffect(() => setBroken(!url), [url]);
  if (broken) {
    return (
      <button type="button" className="ibx-media gone" onClick={onBroken}>
        <I name="i-image" />
        <span>Photo unavailable. Load it again</span>
      </button>
    );
  }
  return (
    <a
      className={`ibx-media img${sticker ? " sticker" : ""}`}
      href={url!}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (onOpen) (e.preventDefault(), onOpen());
      }}
    >
      <img src={url!} alt={sticker ? "Sticker" : "Photo"} loading="lazy" onError={() => setBroken(true)} />
    </a>
  );
}

const STORY_CAP: Record<string, string> = {
  story_reply: "Replied to your story",
  story_mention: "Mentioned you in their story",
  story: "Shared a story",
};

/** One attachment, drawn the way the mockups draw its kind. */
export function Part({ a, m, pos, accountHandle, rate, onBroken }: { a: DmAttachmentView; m: DmMessageView; pos: string; accountHandle: string; rate: number; onBroken(): void }) {
  const t = a.type;
  if (t === "image" || t === "gif" || t === "sticker") return <Photo url={a.url} sticker={t === "sticker"} onBroken={onBroken} />;
  if (t === "video") {
    return a.url ? (
      <video className="ibx-media vid" src={a.url} controls preload="metadata" onError={onBroken} />
    ) : (
      <span className="ibx-bub muted">Video</span>
    );
  }
  if (t === "audio") return <VoiceNote id={m.id} url={a.url} transcript={m.transcript} rate={rate} pos={pos} onBroken={onBroken} />;
  if (t in STORY_CAP) {
    return (
      <div className="ibx-story">
        <span className="ibx-thumb g1">{a.url && <img src={a.url} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}</span>
        <span className="cap">{STORY_CAP[t]}</span>
      </div>
    );
  }
  if (t === "post" || t === "reel" || t === "share" || t === "card") {
    const href = a.link ?? (t === "share" ? a.url : null);
    const body = (
      <>
        <span className="ibx-thumb g3">
          {a.url && t !== "share" && <img src={a.url} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
          {t === "reel" && <I name="i-play" />}
        </span>
        <span className="st2">
          <b>{t === "reel" ? (m.direction === "out" ? `Reel by @${accountHandle}` : "Shared a reel") : PART_LABEL[t]}</b>
          {a.title && <span>{a.title}</span>}
        </span>
      </>
    );
    return href ? (
      <button type="button" className="ibx-share" onClick={() => void openExternal(href)} aria-label={`${PART_LABEL[t]}, open on Instagram`}>
        {body}
      </button>
    ) : (
      <div className="ibx-share">{body}</div>
    );
  }
  if (t === "like") return <span className="ibx-like" role="img" aria-label="Heart">❤️</span>;
  if (t === "file") {
    return a.url ? (
      <a className={`ibx-bub file ${pos}`} href={a.url} target="_blank" rel="noreferrer">
        <I name="i-dl" />
        {a.title ?? "File"}
      </a>
    ) : (
      <span className={`ibx-bub muted ${pos}`}>File</span>
    );
  }
  return <span className={`ibx-bub muted ${pos}`}>{PART_LABEL.unsupported}</span>;
}

/** Their reaction and ours under a bubble. */
export function Reactions({ r }: { r: Record<string, string> | null }) {
  const list = r ? Object.values(r).filter(Boolean) : [];
  if (!list.length) return null;
  return (
    <span className="ibx-rx" aria-label={`Reactions: ${list.join(" ")}`}>
      {list.join("")}
    </span>
  );
}

/** One message: the replied-to quote, its parts, its text, reactions and what went wrong. */
export function Message({
  m,
  pos,
  avatar,
  contact,
  quote,
  accountHandle,
  rate,
  actions,
  onBroken,
  onLongPress,
}: {
  m: DmMessageView;
  pos: string;
  avatar: boolean;
  contact: DmContactView;
  quote: string | null;
  accountHandle: string;
  rate: number;
  actions?: ReactNode;
  onBroken(): void;
  onLongPress?(): void;
}) {
  const timer = useRef<number | null>(null);
  const press = onLongPress
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.pointerType === "mouse") return;
          timer.current = window.setTimeout(() => {
            timer.current = null;
            onLongPress();
          }, 450);
        },
        onPointerUp: () => timer.current && (clearTimeout(timer.current), (timer.current = null)),
        onPointerLeave: () => timer.current && (clearTimeout(timer.current), (timer.current = null)),
        onContextMenu: (e: React.MouseEvent) => (e.preventDefault(), onLongPress()),
      }
    : {};
  const hasText = !!m.text?.trim() && !m.unsent;
  return (
    <div className={`ibx-m ${m.direction}`} data-testid="dm-message" {...press}>
      {m.direction === "in" && (avatar ? <Avatar contact={contact} /> : <span className="avsp" />)}
      <div className="stk">
        {quote && (
          <div className="ibx-quote">
            <I name="i-reply" />
            <small>Replied to:</small>
            <span>{quote}</span>
          </div>
        )}
        {m.unsent ? (
          <div className={`ibx-bub muted unsent ${pos}`}>Unsent a message</div>
        ) : (
          <>
            {m.attachments.map((a, i) => (
              <Part key={i} a={a} m={m} pos={hasText ? "first" : pos} accountHandle={accountHandle} rate={rate} onBroken={onBroken} />
            ))}
            {hasText && (
              <div className={`ibx-bub ${m.attachments.length ? "last" : pos}${m.status === "failed" ? " failed" : ""}`}>
                {m.text}
                <Reactions r={m.reactions} />
              </div>
            )}
            {!hasText && m.attachments.length > 0 && <Reactions r={m.reactions} />}
          </>
        )}
        {(m.edited || m.status === "failed") && (
          <span className={`ibx-meta${m.status === "failed" ? " bad" : ""}`}>
            {m.status === "failed" ? `Not sent: ${m.error ?? "Instagram refused it"}` : "Edited"}
          </span>
        )}
      </div>
      {actions}
    </div>
  );
}

/** The emoji the composer offers: the six reactions first, then a few common ones. */
export const EMOJI = ["❤️", "😂", "😮", "😢", "👍", "🔥", "🙏", "😊", "😍", "🎉", "👏", "🙌", "✅", "👀", "💯", "✨", "📅", "📍"];

export function EmojiPop({ onPick, onClose }: { onPick(e: string): void; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = box.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("mousedown", off), window.removeEventListener("keydown", esc));
  }, [onClose]);
  return (
    <div className="ibx-emoji" ref={box} role="dialog" aria-label="Emoji">
      {EMOJI.map((e) => (
        <button key={e} type="button" onClick={() => onPick(e)} aria-label={`Add ${e}`}>
          {e}
        </button>
      ))}
    </div>
  );
}
