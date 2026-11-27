import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Instagram DMs through Torerone's own Meta app (Instagram API with Instagram
 * Login): webhook parsing, the Send API, OAuth and the conversations read.
 *
 * Ported from fewchat's src/meta.ts, src/attachments.ts and src/sync.ts
 * (MIT, Copyright (c) 2026 Jason Cooperson; see THIRD_PARTY_NOTICES.md), from
 * a Cloudflare Worker to plain Node. The parsing rules are fewchat's, which
 * learned them from Instagram in production: echoes, unsends, edits,
 * reactions, the share/ig_post double, story replies and voice notes.
 *
 * Tokens go in an Authorization header, never a query string, so they never
 * reach a log line. The two calls Meta only takes as query parameters (the
 * token exchange and refresh) are the exceptions, and only ever go to Meta.
 */

export const IG_GRAPH = "https://graph.instagram.com/v26.0";
export const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;
/** What the webhook is told to deliver for a connected account. */
export const IG_WEBHOOK_FIELDS =
  "messages,messaging_postbacks,messaging_seen,message_reactions,comments,live_comments";

export class InstagramError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
  }
  /** Meta's "this token is no good": expired, revoked, or the password changed. */
  get tokenInvalid(): boolean {
    return this.code === 190;
  }
  /** Outside the messaging window (code 10, subcode 2534022) and friends. */
  get windowClosed(): boolean {
    return this.code === 10 || /outside of allowed window/i.test(this.message);
  }
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * X-Hub-Signature-256 ("sha256=<hex>"), an HMAC of the RAW body.
 *
 * The raw bytes, not a re-serialized parse: JSON.stringify of the parsed body
 * reorders nothing but escapes differently (❤ vs the literal heart), and
 * one differing byte fails the HMAC. Constant time. Any of the given secrets
 * may match, so the Instagram app secret and the Meta app secret both work
 * while Meta's docs disagree about which one signs.
 */
export function verifyHubSignature(
  rawBody: Buffer,
  header: string | undefined,
  secrets: string[],
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const got = Buffer.from(header.slice(7), "utf8");
  return secrets.some((secret) => {
    if (!secret) return false;
    const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
    return expected.length === got.length && timingSafeEqual(expected, got);
  });
}

/**
 * Meta's signed_request on the deauthorize and data-deletion callbacks:
 * "<base64url sig>.<base64url payload>", the sig an HMAC-SHA256 of the payload.
 */
export function parseSignedRequest(signed: unknown, secrets: string[]): { userId: string } | null {
  if (typeof signed !== "string") return null;
  const [sig, payload] = signed.split(".");
  if (!sig || !payload) return null;
  const got = Buffer.from(sig, "base64url");
  const ok = secrets.some((secret) => {
    if (!secret) return false;
    const expected = createHmac("sha256", secret).update(payload).digest();
    return expected.length === got.length && timingSafeEqual(expected, got);
  });
  if (!ok) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { user_id?: string | number };
    return data.user_id ? { userId: String(data.user_id) } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message parts
// ---------------------------------------------------------------------------

export type IgPartType =
  | "image"
  | "gif"
  | "sticker"
  | "video"
  | "audio"
  | "file"
  | "post"
  | "reel"
  | "share"
  | "story"
  | "story_reply"
  | "story_mention"
  | "like"
  | "card"
  | "unsupported";

/** What a message is made of. url is Instagram's signed CDN link of the moment. */
export interface IgPart {
  type: IgPartType;
  url?: string | null;
  preview?: string | null;
  id?: string | null;
  title?: string | null;
  link?: string | null;
  mime?: string | null;
}

type RawAttachment = {
  type?: string;
  payload?: {
    url?: string;
    title?: string;
    ig_post_media_id?: string;
    reel_video_id?: string;
    sticker_id?: string | number;
    name?: string;
  };
};

interface RawMessage {
  mid?: string;
  text?: string;
  is_echo?: boolean;
  is_deleted?: boolean;
  is_unsupported?: boolean;
  attachments?: RawAttachment[];
  reply_to?: { mid?: string; story?: { url?: string; id?: string } };
}

interface RawMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: RawMessage;
  reaction?: { mid?: string; action?: string; emoji?: string };
  message_edit?: { mid?: string; text?: string };
  read?: { mid?: string };
  postback?: { mid?: string; title?: string; payload?: string };
}

interface RawPayload {
  object?: string;
  entry?: { id?: string; time?: number; messaging?: RawMessaging[]; changes?: unknown[] }[];
}

/** Nov 2025 - Feb 2026 a shared post came as both "share" and "ig_post": one post, not two. */
function dedupeShares(atts: RawAttachment[]): RawAttachment[] {
  const posts = new Set(atts.filter((a) => a.type === "ig_post").map((a) => a.payload?.ig_post_media_id ?? ""));
  return atts.filter((a) => a.type !== "share" || !posts.has(a.payload?.ig_post_media_id ?? ""));
}

/** A webhook message as parts. */
export function webhookParts(m: RawMessage): IgPart[] {
  const out: IgPart[] = [];
  if (m.reply_to?.story) {
    out.push({ type: "story_reply", url: m.reply_to.story.url ?? null, id: m.reply_to.story.id ?? null });
  }
  for (const a of dedupeShares(m.attachments ?? [])) {
    const p = a.payload ?? {};
    const url = p.url ?? null;
    switch (a.type) {
      case "image":
      case "media":
        out.push({ type: p.sticker_id ? "sticker" : "image", url });
        break;
      case "video":
      case "audio":
        out.push({ type: a.type, url });
        break;
      case "file":
        out.push({ type: "file", url, title: p.name ?? null });
        break;
      case "share":
      case "ig_post":
        out.push({ type: "post", url, id: p.ig_post_media_id ?? null, title: p.title ?? null });
        break;
      case "ig_reel":
      case "reel":
        out.push({ type: "reel", url, id: p.reel_video_id ?? null, title: p.title ?? null });
        break;
      case "story_mention":
        out.push({ type: "story_mention", url });
        break;
      case "ig_story":
      case "story":
        out.push({ type: "story", url });
        break;
      case "like_heart":
        out.push({ type: "like" });
        break;
      case "template":
      case "fallback":
        break; // our own buttons: the text already says it
      default:
        out.push({ type: "unsupported", url });
    }
  }
  if (m.is_unsupported && !out.length) out.push({ type: "unsupported" });
  return out;
}

const SUMMARY: Partial<Record<IgPartType, string>> = {
  audio: "Voice note",
  image: "Photo",
  gif: "GIF",
  sticker: "Sticker",
  video: "Video",
  file: "File",
  post: "Shared a post",
  reel: "Shared a reel",
  share: "Shared a link",
  story: "Shared a story",
  story_reply: "Replied to your story",
  story_mention: "Mentioned you in their story",
  like: "❤️",
};

/** The one line a thread row shows. */
export function previewOf(text: string | null | undefined, parts: IgPart[]): string {
  if (text?.trim()) return text.trim().slice(0, 200);
  const first = parts.find((p) => p.type !== "unsupported");
  return first ? (SUMMARY[first.type] ?? "Attachment") : parts.length ? "Attachment" : "";
}

/** Instagram sends a heart as a bare U+2764, which renders as a text glyph without the emoji selector. */
export const asEmoji = (e: string): string =>
  /^(?!\p{Emoji_Presentation})\p{Extended_Pictographic}$/u.test(e) ? `${e}️` : e;

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------

/** One thing a webhook delivery says, for one connected account. */
export type IgEvent =
  | {
      kind: "message";
      /** The account's Instagram id (entry.id). */
      accountId: string;
      /** The other person's IGSID. */
      contactId: string;
      direction: "in" | "out";
      mid: string;
      text: string | null;
      parts: IgPart[];
      replyTo: string | null;
      at: Date;
    }
  | { kind: "reaction"; accountId: string; mid: string; who: "contact" | "you"; emoji: string | null }
  | { kind: "edit"; accountId: string; mid: string; text: string }
  | { kind: "unsend"; accountId: string; mid: string };

/**
 * Everything in a delivery, in order.
 *
 * An echo is our own side talking: a reply sent from this app, from the
 * Instagram app on a phone, or by another tool. Its "other person" is the
 * recipient, not the sender. A sender equal to the account itself on a
 * non-echo is the account messaging itself and is dropped, as fewchat does.
 * Comments (changes) are not messages: parseComments reads those (F4).
 */
export function parseWebhook(payload: unknown): IgEvent[] {
  const p = payload as RawPayload;
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return [];
  const out: IgEvent[] = [];
  for (const entry of p.entry) {
    const accountId = entry.id ? String(entry.id) : "";
    if (!accountId) continue;
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      if (ev.reaction?.mid) {
        const who = ev.sender?.id === accountId ? "you" : "contact";
        const emoji = ev.reaction.action === "unreact" ? null : asEmoji(ev.reaction.emoji ?? "❤");
        out.push({ kind: "reaction", accountId, mid: ev.reaction.mid, who, emoji });
      }
      if (ev.message_edit?.mid && typeof ev.message_edit.text === "string") {
        out.push({ kind: "edit", accountId, mid: ev.message_edit.mid, text: ev.message_edit.text });
      }
      if (!m?.mid) continue;
      if (m.is_deleted) {
        out.push({ kind: "unsend", accountId, mid: m.mid });
        continue;
      }
      const echo = Boolean(m.is_echo);
      const contactId = echo ? ev.recipient?.id : ev.sender?.id;
      if (!contactId || contactId === accountId) continue;
      const parts = webhookParts(m);
      const text = m.text?.trim() ? m.text : null;
      if (!text && !parts.length) continue;
      const to = m.reply_to?.mid;
      out.push({
        kind: "message",
        accountId,
        contactId: String(contactId),
        direction: echo ? "out" : "in",
        mid: m.mid,
        text,
        parts,
        replyTo: typeof to === "string" && to && to !== m.mid ? to : null,
        at: new Date(ev.timestamp ?? Date.now()),
      });
    }
  }
  return out;
}

/** A comment on one of the account's posts (F4), from the comments and live_comments fields. */
export interface IgComment {
  accountId: string;
  commentId: string;
  /** The commenter's IGSID. */
  contactId: string;
  username: string | null;
  mediaId: string | null;
  text: string;
  at: Date;
}

interface RawChange {
  field?: string;
  value?: { id?: string; text?: string; from?: { id?: string; username?: string }; media?: { id?: string }; created_time?: number | string };
}

/**
 * Comments in a delivery. The account's own comments (our public replies
 * included) are skipped, as fewchat does, so a public reply never triggers
 * another automation.
 */
export function parseComments(payload: unknown): IgComment[] {
  const p = payload as { object?: string; entry?: { id?: string; time?: number; changes?: RawChange[] }[] };
  if (p?.object !== "instagram" || !Array.isArray(p.entry)) return [];
  const out: IgComment[] = [];
  for (const entry of p.entry) {
    const accountId = entry.id ? String(entry.id) : "";
    for (const ch of entry.changes ?? []) {
      const v = ch.value;
      if ((ch.field !== "comments" && ch.field !== "live_comments") || !v?.id || !v.from?.id || !v.text) continue;
      if (!accountId || String(v.from.id) === accountId) continue;
      const t = typeof v.created_time === "number" ? v.created_time * 1000 : v.created_time ? Date.parse(v.created_time) : (entry.time ?? 0) * 1000;
      out.push({
        accountId,
        commentId: String(v.id),
        contactId: String(v.from.id),
        username: v.from.username ?? null,
        mediaId: v.media?.id ? String(v.media.id) : null,
        text: v.text,
        at: new Date(Number.isFinite(t) && t > 0 ? t : Date.now()),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Messages read back from the API (the sync, and media refresh)
// ---------------------------------------------------------------------------

/** Rich fields first; Instagram answers code 100 when one is not allowed, then the plain set. */
export const IG_MSG_FIELDS =
  "id,created_time,from,to,message,attachments{id,mime_type,name,file_url,image_data,video_data,generic_template},shares{link,name,description,id},story,reactions,is_unsupported";

interface ApiAttachment {
  id?: string;
  mime_type?: string;
  name?: string;
  file_url?: string;
  image_data?: { url?: string; preview_url?: string; animated_gif_url?: string; render_as_sticker?: boolean };
  video_data?: { url?: string; preview_url?: string };
  generic_template?: { title?: string; subtitle?: string; image_url?: string };
}

export interface IgApiMessage {
  id: string;
  created_time?: string;
  from?: { id?: string; username?: string };
  to?: { data?: { id?: string; username?: string }[] };
  message?: string;
  attachments?: { data?: ApiAttachment[] };
  shares?: { data?: { link?: string; name?: string; description?: string; id?: string }[] };
  story?: { reply_to?: { link?: string; id?: string }; mention?: { link?: string; id?: string } };
  is_unsupported?: boolean;
}

const isPermalink = (u?: string | null) => Boolean(u && /^https:\/\/(www\.)?instagram\.com\//.test(u));

export function partsFromApi(m: IgApiMessage): IgPart[] {
  const parts: IgPart[] = [];
  if (m.story?.reply_to) parts.push({ type: "story_reply", url: m.story.reply_to.link ?? null, id: m.story.reply_to.id ?? null });
  if (m.story?.mention) parts.push({ type: "story_mention", url: m.story.mention.link ?? null, id: m.story.mention.id ?? null });
  for (const a of m.attachments?.data ?? []) {
    const mime = a.mime_type ?? "";
    const base = { id: a.id ?? null, mime: mime || null };
    if (a.generic_template) {
      const g = a.generic_template;
      parts.push({ ...base, type: "card", title: [g.title, g.subtitle].filter(Boolean).join("\n") || null, preview: g.image_url ?? null });
    } else if (a.image_data) {
      const i = a.image_data;
      const type: IgPartType = i.render_as_sticker ? "sticker" : i.animated_gif_url ? "gif" : "image";
      parts.push({ ...base, type, url: i.animated_gif_url ?? i.url ?? null, preview: i.preview_url ?? null });
    } else if (a.video_data) {
      // Voice notes come back as video_data with an audio mime type.
      parts.push({ ...base, type: mime.startsWith("audio") ? "audio" : "video", url: a.video_data.url ?? null, preview: a.video_data.preview_url ?? null });
    } else if (a.file_url) {
      const type: IgPartType = mime.startsWith("audio") ? "audio" : mime.startsWith("video") ? "video" : mime.startsWith("image") ? "image" : "file";
      parts.push({ ...base, type, url: a.file_url, title: a.name ?? null });
    } else {
      parts.push({ ...base, type: "unsupported" });
    }
  }
  for (const s of m.shares?.data ?? []) {
    const link = isPermalink(s.link) ? s.link! : null;
    parts.push({
      type: /\/reels?\//.test(s.link ?? "") ? "reel" : "post",
      id: s.id ?? null,
      url: link ? null : (s.link ?? null),
      link,
      title: s.description || s.name || null,
    });
  }
  if (m.is_unsupported && !parts.length) parts.push({ type: "unsupported" });
  return parts;
}

// ---------------------------------------------------------------------------
// Graph calls
// ---------------------------------------------------------------------------

async function graph<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const url = path.startsWith("https://") ? path : `${IG_GRAPH}${path}`;
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok || body.error) {
    const code = typeof body.error?.code === "number" ? body.error.code : null;
    throw new InstagramError(`Instagram: ${body.error?.message ?? `request failed (${res.status})`}`, res.status, code);
  }
  return body;
}

const json = (body: object): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface IgAppCreds {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export function igAuthUrl(creds: IgAppCreds, state: string): string {
  const q = new URLSearchParams({
    client_id: creds.appId,
    redirect_uri: creds.redirectUri,
    response_type: "code",
    scope: IG_SCOPES.join(","),
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

/** code -> short-lived token -> 60-day token. */
export async function igExchangeCode(
  creds: IgAppCreds,
  code: string,
): Promise<{ token: string; expiresAt: Date; scopes: string[] }> {
  const res = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: creds.appId,
      client_secret: creds.appSecret,
      grant_type: "authorization_code",
      redirect_uri: creds.redirectUri,
      code,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const short = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    permissions?: string[] | string;
    error_message?: string;
  };
  if (!short.access_token) {
    throw new InstagramError(`Instagram: ${short.error_message ?? "the authorization code was refused"}`, res.status, null);
  }
  const long = await graph<{ access_token?: string; expires_in?: number }>(
    `https://graph.instagram.com/access_token?${new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: creds.appSecret,
      access_token: short.access_token,
    })}`,
    null,
  );
  if (!long.access_token) throw new InstagramError("Instagram: no long-lived token came back", 502, null);
  const perms = Array.isArray(short.permissions)
    ? short.permissions
    : typeof short.permissions === "string"
      ? short.permissions.split(",")
      : [...IG_SCOPES];
  return {
    token: long.access_token,
    expiresAt: new Date(Date.now() + (long.expires_in ?? 60 * 86400) * 1000),
    scopes: perms.map((s) => s.trim()).filter(Boolean),
  };
}

/** A fresh 60 days. Works once the token is a day old and until it expires. */
export async function igRefreshToken(token: string): Promise<{ token: string; expiresAt: Date }> {
  const body = await graph<{ access_token?: string; expires_in?: number }>(
    `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token })}`,
    null,
  );
  if (!body.access_token) throw new InstagramError("Instagram: the refresh returned no token", 502, null);
  return { token: body.access_token, expiresAt: new Date(Date.now() + (body.expires_in ?? 60 * 86400) * 1000) };
}

/**
 * Who the token belongs to. user_id is the professional account id that
 * webhooks and conversations use; OAuth's own user_id is app-scoped and
 * arrives as a lossy JSON number, so it is never used.
 */
export async function igMe(token: string): Promise<{ userId: string; username: string | null; name: string | null }> {
  const me = await graph<{ user_id?: string | number; username?: string; name?: string }>(
    "/me?fields=user_id,username,name",
    token,
  );
  if (!me.user_id) throw new InstagramError("Instagram: the account id was missing", 502, null);
  return { userId: String(me.user_id), username: me.username ?? null, name: me.name ?? null };
}

export async function igSubscribe(token: string): Promise<void> {
  await graph(`/me/subscribed_apps?${new URLSearchParams({ subscribed_fields: IG_WEBHOOK_FIELDS })}`, token, { method: "POST" });
}

/**
 * Send one message. HUMAN_AGENT is Meta's tag for a person answering after the
 * 24h window (up to 7 days), only for apps approved for it.
 */
export async function igSend(
  token: string,
  input: {
    recipientId: string;
    text?: string;
    media?: { type: "image" | "video" | "audio" | "file"; url: string };
    replyTo?: string;
    tag?: "HUMAN_AGENT" | null;
  },
): Promise<string> {
  const message = input.media
    ? { attachment: { type: input.media.type, payload: { url: input.media.url } } }
    : { text: input.text ?? "" };
  const body = await graph<{ message_id?: string }>(
    "/me/messages",
    token,
    json({
      recipient: { id: input.recipientId },
      message,
      ...(input.replyTo ? { reply_to: { mid: input.replyTo } } : {}),
      // Untagged is a plain reply inside the window, which is what fewchat sends.
      ...(input.tag ? { messaging_type: "MESSAGE_TAG", tag: input.tag } : {}),
    }),
  );
  if (!body.message_id) throw new InstagramError("Instagram: the send returned no message id", 502, null);
  return body.message_id;
}

/**
 * An automation's message (F4): to a comment (a private reply, one per
 * comment, within 7 days) or to a person in an open window. A link button is
 * a button template. Meta only documents text for private replies, so a
 * refused template is retried once as text with the link inline: a failed
 * call does not use up the comment's one reply (fewchat learned this).
 */
export async function igAutomationSend(
  token: string,
  to: { commentId: string } | { recipientId: string },
  text: string,
  button?: { title: string; url: string } | null,
): Promise<{ messageId: string; recipientId: string | null; asText: boolean }> {
  const recipient = "commentId" in to ? { comment_id: to.commentId } : { id: to.recipientId };
  const post = (message: object) =>
    graph<{ message_id?: string; recipient_id?: string }>("/me/messages", token, json({ recipient, message }));
  let body: { message_id?: string; recipient_id?: string };
  let asText = !button;
  try {
    body = await post(
      button
        ? { attachment: { type: "template", payload: { template_type: "button", text, buttons: [{ type: "web_url", url: button.url, title: button.title }] } } }
        : { text },
    );
  } catch (e) {
    // Only a refused template falls back; a rate limit or an outage is retried later as it was.
    const throttled = e instanceof InstagramError && (e.status === 429 || e.status >= 500 || [1, 2, 4, 17, 32, 613].includes(e.code ?? -1));
    if (!button || !(e instanceof InstagramError) || e.tokenInvalid || throttled) throw e;
    body = await post({ text: `${text}\n${button.url}` });
    asText = true;
  }
  if (!body.message_id) throw new InstagramError("Instagram: the send returned no message id", 502, null);
  return { messageId: body.message_id, recipientId: body.recipient_id ?? null, asText };
}

/** A public reply under a comment. */
export async function igCommentReply(token: string, commentId: string, text: string): Promise<string | null> {
  const body = await graph<{ id?: string }>(`/${encodeURIComponent(commentId)}/replies?${new URLSearchParams({ message: text })}`, token, { method: "POST" });
  return body.id ?? null;
}

export interface IgMedia {
  id: string;
  caption: string | null;
  permalink: string | null;
  thumbnail: string | null;
  mediaType: string | null;
  productType: string | null;
  at: Date | null;
}

/** The account's newest posts and reels: the post picker, and what "next post" locks onto. Ads are left out. */
export async function igRecentMedia(token: string, limit = 24): Promise<IgMedia[]> {
  const q = new URLSearchParams({ fields: "id,caption,permalink,timestamp,media_type,media_product_type,thumbnail_url,media_url", limit: String(limit) });
  const page = await graph<{ data?: Array<Record<string, string | undefined>> }>(`/me/media?${q}`, token);
  return (page.data ?? [])
    .filter((m) => m.id && m.media_product_type !== "AD")
    .map((m) => ({
      id: String(m.id),
      caption: m.caption ?? null,
      permalink: m.permalink ?? null,
      thumbnail: m.thumbnail_url ?? (m.media_type === "VIDEO" ? null : (m.media_url ?? null)),
      mediaType: m.media_type ?? null,
      productType: m.media_product_type ?? null,
      at: m.timestamp ? new Date(m.timestamp) : null,
    }));
}

/** Whether this person follows the account, for followers-only links. Null when Instagram will not say. */
export async function igFollowsBusiness(token: string, igsid: string): Promise<boolean | null> {
  try {
    const p = await graph<{ is_user_follow_business?: boolean }>(`/${encodeURIComponent(igsid)}?fields=is_user_follow_business`, token);
    return typeof p.is_user_follow_business === "boolean" ? p.is_user_follow_business : null;
  } catch {
    return null;
  }
}

export async function igMarkSeen(token: string, recipientId: string): Promise<void> {
  await graph("/me/messages", token, json({ recipient: { id: recipientId }, sender_action: "mark_seen" }));
}

/** The typing dots in their chat (AI replies, F5). Instagram clears them on the next message. */
export async function igTyping(token: string, recipientId: string, on = true): Promise<void> {
  await graph("/me/messages", token, json({ recipient: { id: recipientId }, sender_action: on ? "typing_on" : "typing_off" }));
}

export async function igProfile(
  token: string,
  igsid: string,
): Promise<{ username: string | null; name: string | null; pic: string | null }> {
  try {
    const p = await graph<{ username?: string; name?: string; profile_pic?: string }>(
      `/${encodeURIComponent(igsid)}?fields=name,username,profile_pic`,
      token,
    );
    return { username: p.username ?? null, name: p.name ?? null, pic: p.profile_pic ?? null };
  } catch {
    return { username: null, name: null, pic: null };
  }
}

/** One message read back by id: fresh media URLs for an expired attachment. */
export async function igMessage(token: string, mid: string): Promise<IgApiMessage> {
  return graph<IgApiMessage>(`/${encodeURIComponent(mid)}?fields=${encodeURIComponent(IG_MSG_FIELDS)}`, token);
}

export interface IgConversation {
  id: string;
  updated_time: string;
  participants?: { data?: { id: string; username?: string }[] };
  messages?: { data?: IgApiMessage[] };
}

/** Recently active conversations, newest first, each with its last 20 messages. */
export async function igConversations(
  token: string,
  next?: string,
): Promise<{ data: IgConversation[]; next: string | null }> {
  const fields = `id,participants,updated_time,messages.limit(20){${IG_MSG_FIELDS}}`;
  const page = await graph<{ data?: IgConversation[]; paging?: { next?: string } }>(
    next ?? `/me/conversations?platform=instagram&limit=25&fields=${encodeURIComponent(fields)}`,
    token,
  );
  // Meta puts the token in its own paging links; drop it so it never leaves this function.
  const nextUrl = page.paging?.next ? page.paging.next.replace(/([?&])access_token=[^&]*&?/, "$1") : null;
  return { data: page.data ?? [], next: nextUrl };
}

// ---------------------------------------------------------------------------
// The media proxy's fetch
// ---------------------------------------------------------------------------

/** Only Meta's (and Zernio's) media hosts: the proxy is never a general fetcher. */
const MEDIA_HOSTS = /(^|\.)(fbcdn\.net|fbsbx\.com|cdninstagram\.com|instagram\.com|facebook\.com|zernio\.com)$/i;

export function isMediaHost(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && MEDIA_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Fetch media bytes from an allowed host, or null when it is gone or expired.
 * Redirects are followed by hand so each hop is checked against the list.
 */
export async function pullMedia(url: string | null | undefined, range?: string): Promise<Response | null> {
  let current = url ?? null;
  for (let hop = 0; hop < 4 && current; hop++) {
    if (!isMediaHost(current)) return null;
    const headers: Record<string, string> = {
      // Instagram's CDN answers a request without a browser UA with a web page.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    };
    if (range) headers.Range = range;
    const res = await fetch(current, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      current = loc ? new URL(loc, current).toString() : null;
      continue;
    }
    return res.ok || res.status === 206 ? res : null;
  }
  return null;
}
