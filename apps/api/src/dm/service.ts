import type { FastifyRequest } from "fastify";
import { decryptSecret, getPrisma, signedFilePath, type DmAccount, type Prisma } from "@toreroflow/db";
import {
  DM_STAGES,
  type DmAttachmentView,
  type DmContactView,
  type DmMessageView,
  type DmStage,
  type DmStatus,
  type DmThreadView,
} from "@toreroflow/core";
import { ZernioProvider, type InboxConversation, type InboxMessage } from "@toreroflow/publishers";
import { env, missingMetaConfig } from "../env";

/**
 * The unified inbox: native Instagram rows and Zernio read-through behind one
 * shape (DmThreadView / DmMessageView in packages/core/src/dm.ts).
 *
 * Which transport an account uses: native once it has been connected through
 * our Meta app, Zernio otherwise (Instagram before that connect, Facebook
 * Messenger always). Zernio threads are mirrored here only as the list row,
 * contact, stage, tags and notes; their messages stay at Zernio and are read
 * live, because a copy without a webhook behind it goes stale.
 */

export const nativeConfigured = (): boolean => missingMetaConfig().length === 0;

let zernioClient: ZernioProvider | null | undefined;
export function zernio(): ZernioProvider | null {
  if (zernioClient === undefined) {
    zernioClient =
      env.PUBLISH_PROVIDER === "zernio" && env.PUBLISH_PROVIDER_API_KEY
        ? new ZernioProvider(env.PUBLISH_PROVIDER_API_KEY)
        : null;
  }
  return zernioClient;
}
/** Tests swap the provider. */
export function setZernio(z: ZernioProvider | null): void {
  zernioClient = z;
}

export interface ClientRow {
  id: string;
  providerProfileId: string | null;
}

export async function ownedClient(clientId: string, agencyId: string): Promise<ClientRow | null> {
  return getPrisma().client.findFirst({
    where: { id: clientId, agencyId, deletedAt: null },
    select: { id: true, providerProfileId: true },
  });
}

export const DM_PLATFORMS = ["instagram", "facebook"] as const;

/** The client's Instagram and Facebook accounts, each with its DM row if it has one. */
export async function dmSocialAccounts(clientId: string) {
  return getPrisma().socialAccount.findMany({
    where: { clientId, deletedAt: null, platform: { in: [...DM_PLATFORMS] } },
    select: {
      id: true,
      platform: true,
      handle: true,
      status: true,
      providerAccountId: true,
      dmAccount: true,
    },
    orderBy: { createdAt: "asc" },
  });
}
export type DmSocial = Awaited<ReturnType<typeof dmSocialAccounts>>[number];

export function transportOf(s: Pick<DmSocial, "dmAccount">): "native" | "zernio" {
  return s.dmAccount?.transport === "native" ? "native" : "zernio";
}

/** The account's Instagram Login token, or null when it cannot send. */
export function accountToken(account: Pick<DmAccount, "accessTokenEnc" | "status">): string | null {
  if (account.status !== "active" || !account.accessTokenEnc) return null;
  try {
    return decryptSecret(account.accessTokenEnc);
  } catch {
    return null;
  }
}

/**
 * Pull a Zernio account's threads into the mirror. Best effort per account:
 * one account Zernio cannot read must not blank the others, so failures come
 * back as warnings beside whatever the mirror already has.
 */
export async function syncZernioThreads(client: ClientRow, socials: DmSocial[]): Promise<string[]> {
  const z = zernio();
  const targets = socials.filter((s) => transportOf(s) === "zernio" && s.providerAccountId && s.status === "connected");
  if (!targets.length) return [];
  if (!z || !client.providerProfileId) return ["Zernio is not connected for this client, so its DMs cannot be read."];
  const prisma = getPrisma();
  const warnings: string[] = [];
  for (const s of targets) {
    let conversations: InboxConversation[];
    try {
      conversations = await z.conversations(client.providerProfileId, { accountId: s.providerAccountId! });
    } catch (e) {
      warnings.push(`Zernio could not read @${s.handle}: ${e instanceof Error ? e.message : "request failed"}`);
      continue;
    }
    const account =
      s.dmAccount ??
      (await prisma.dmAccount.upsert({
        where: { socialAccountId: s.id },
        create: { clientId: client.id, socialAccountId: s.id, platform: s.platform, transport: "zernio", username: s.handle },
        update: {},
      }));
    const ids = conversations.map((c) => c.id).filter(Boolean);
    const existing = new Map(
      (
        await prisma.dmThread.findMany({
          where: { dmAccountId: account.id, externalId: { in: ids } },
          include: { contact: true },
        })
      ).map((t) => [t.externalId!, t]),
    );
    for (const c of conversations) {
      if (!c.id) continue;
      const at = c.updatedTime ? new Date(c.updatedTime) : null;
      const have = existing.get(c.id);
      // Read here after their last message: Zernio still counts it unread, we do not.
      const unread = have?.readAt && at && have.readAt >= at ? 0 : c.unreadCount;
      if (have) {
        const moved = (at?.getTime() ?? 0) !== (have.lastMessageAt?.getTime() ?? 0);
        if (moved || unread !== have.unread || (c.lastMessage ?? null) !== have.lastPreview) {
          await prisma.dmThread.update({
            where: { id: have.id },
            data: {
              lastMessageAt: at,
              lastPreview: c.lastMessage?.slice(0, 200) ?? null,
              unread,
              ...(moved && have.status === "done" ? { status: "open" } : {}),
            },
          });
        }
        if (c.participantPicture !== have.contact.avatarUrl || (c.participantName && c.participantName !== have.contact.displayName)) {
          await prisma.dmContact.update({
            where: { id: have.contactId },
            data: { avatarUrl: c.participantPicture, displayName: c.participantName ?? have.contact.displayName },
          });
        }
        continue;
      }
      const externalId = c.participantId ?? `conv:${c.id}`;
      const contact = await prisma.dmContact.upsert({
        where: { dmAccountId_externalId: { dmAccountId: account.id, externalId } },
        create: {
          dmAccountId: account.id,
          externalId,
          displayName: c.participantName,
          avatarUrl: c.participantPicture,
        },
        update: { displayName: c.participantName ?? undefined, avatarUrl: c.participantPicture },
      });
      await prisma.dmThread.upsert({
        where: { dmAccountId_contactId: { dmAccountId: account.id, contactId: contact.id } },
        create: {
          dmAccountId: account.id,
          contactId: contact.id,
          source: "zernio",
          externalId: c.id,
          lastMessageAt: at,
          lastPreview: c.lastMessage?.slice(0, 200) ?? null,
          unread,
        },
        update: { externalId: c.id, lastMessageAt: at, lastPreview: c.lastMessage?.slice(0, 200) ?? null, unread },
      });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const threadInclude = {
  contact: { include: { tags: { include: { tag: { select: { name: true } } } } } },
  dmAccount: { select: { platform: true, transport: true, status: true, socialAccount: { select: { id: true, handle: true } } } },
} satisfies Prisma.DmThreadInclude;
type ThreadRow = Prisma.DmThreadGetPayload<{ include: typeof threadInclude }>;
type ContactRow = ThreadRow["contact"];

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const stageOf = (s: string): DmStage => ((DM_STAGES as readonly string[]).includes(s) ? (s as DmStage) : "new");

export function contactView(c: ContactRow): DmContactView {
  return {
    id: c.id,
    displayName: c.displayName,
    handle: c.handle,
    avatarUrl: c.avatarUrl,
    stage: stageOf(c.stage),
    tags: c.tags.map((t) => t.tag.name).sort(),
    notes: c.notes,
    optIn: c.optIn,
    lastSeenAt: iso(c.lastSeenAt),
  };
}

export function threadView(t: ThreadRow): DmThreadView {
  const native = t.source === "native";
  return {
    id: t.id,
    source: native ? "native" : "zernio",
    platform: t.dmAccount.platform === "facebook" ? "facebook" : "instagram",
    accountId: t.dmAccount.socialAccount.id,
    accountHandle: t.dmAccount.socialAccount.handle,
    status: (["open", "waiting", "done"].includes(t.status) ? t.status : "open") as DmStatus,
    unread: t.unread,
    pausedAt: iso(t.pausedAt),
    lastMessageAt: iso(t.lastMessageAt),
    lastPreview: t.lastPreview,
    lastDirection: t.lastDirection === "in" || t.lastDirection === "out" ? t.lastDirection : null,
    windowEndsAt: native ? iso(t.windowEndsAt) : null,
    // A thread only exists once they wrote, so a reply is always into an existing conversation.
    canReply: native ? t.dmAccount.status === "active" && t.dmAccount.transport === "native" : !!t.externalId,
    contact: contactView(t.contact),
  };
}

/**
 * The API's own public origin for this request, so media links are absolute
 * and work from the web app, the desktop app and an older desktop build that
 * draws whatever URL it is given.
 */
export function originOf(request: FastifyRequest): string {
  // Both public doors (Caddy and the Tailscale Funnel) are HTTPS only, and the
  // Funnel does not promise an X-Forwarded-Proto, so production is always https.
  const proto = env.IS_PRODUCTION
    ? "https"
    : String(request.headers["x-forwarded-proto"] ?? request.protocol).split(",")[0]!.trim();
  return `${proto}://${request.host}`;
}

/** A signed link to our media proxy. The signature is the whole permission. */
export function mediaLink(origin: string, key: string): string {
  return origin + signedFilePath(key, env.JWT_SECRET).replace(/^\/files\//, "/dm/media/");
}

/**
 * Original Zernio attachment URLs, remembered for an hour so a fresh image is
 * one hop. Past that, or after a restart, the proxy asks Zernio for a new
 * one (attachmentUrl), which is what makes old threads draw.
 * ponytail: per-process and capped at 5000; a shared cache if this ever runs
 * as more than one API process.
 */
const zernioHints = new Map<string, { url: string; at: number }>();
const HINT_TTL_MS = 60 * 60 * 1000;
export function rememberZernioUrl(key: string, url: string): void {
  zernioHints.delete(key);
  zernioHints.set(key, { url, at: Date.now() });
  if (zernioHints.size > 5000) zernioHints.delete(zernioHints.keys().next().value!);
}
export function zernioHint(key: string): string | null {
  const hit = zernioHints.get(key);
  return hit && Date.now() - hit.at < HINT_TTL_MS ? hit.url : null;
}

export const zernioMediaKey = (socialAccountId: string, conversationId: string, messageId: string, i: number) =>
  `z/${socialAccountId}/${conversationId}/${messageId}/${i}`;

/** Zernio attachments as proxy links; the original goes in the hint cache. */
export function zernioAttachments(
  origin: string,
  socialAccountId: string,
  conversationId: string,
  m: InboxMessage,
): DmAttachmentView[] {
  return m.attachments.map((a, i) => {
    const key = zernioMediaKey(socialAccountId, conversationId, m.id, i);
    if (a.url) rememberZernioUrl(key, a.url);
    // Linked even without a URL: the proxy can still ask Zernio for a fresh one.
    return { type: a.type ?? "file", url: mediaLink(origin, key) };
  });
}

export function zernioMessageView(origin: string, socialAccountId: string, conversationId: string, m: InboxMessage): DmMessageView {
  return {
    id: m.id,
    externalId: m.id,
    direction: m.direction === "outgoing" ? "out" : "in",
    text: m.message || null,
    attachments: zernioAttachments(origin, socialAccountId, conversationId, m),
    replyTo: null,
    reactions: null,
    unsent: false,
    edited: false,
    transcript: null,
    status: "sent",
    error: null,
    sentAt: m.createdAt,
  };
}

type MessageRow = Prisma.DmMessageGetPayload<object>;
type StoredPart = { type?: string; url?: string | null; preview?: string | null; title?: string | null; link?: string | null };

export function nativeMessageView(origin: string, m: MessageRow): DmMessageView {
  const parts = Array.isArray(m.attachments) ? (m.attachments as StoredPart[]) : [];
  return {
    id: m.id,
    externalId: m.externalId,
    direction: m.direction === "out" ? "out" : "in",
    text: m.text,
    attachments: parts.map((p, i) => ({
      type: p.type ?? "file",
      url: p.url ? mediaLink(origin, `n/${m.id}/${i}`) : null,
      title: p.title ?? null,
      // instagram.com permalinks are pages, not media: passed as links, never proxied.
      link: p.link ?? null,
    })),
    replyTo: m.replyToExternalId,
    reactions: (m.reactions as Record<string, string> | null) ?? null,
    unsent: !!m.unsentAt,
    edited: !!m.editedAt,
    transcript: m.transcript,
    status: m.status === "failed" ? "failed" : "sent",
    error: m.error,
    sentAt: iso(m.sentAt),
  };
}

/** Replace a contact's tags with exactly this set, creating the client's tags on first use. */
export async function setContactTags(clientId: string, contactId: string, names: string[]): Promise<void> {
  const prisma = getPrisma();
  const wanted = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const tags = await Promise.all(
    wanted.map((name) =>
      prisma.dmTag.upsert({ where: { clientId_name: { clientId, name } }, create: { clientId, name }, update: {} }),
    ),
  );
  await prisma.dmContactTag.deleteMany({ where: { contactId, tagId: { notIn: tags.map((t) => t.id) } } });
  if (tags.length) {
    await prisma.dmContactTag.createMany({ data: tags.map((t) => ({ contactId, tagId: t.id })), skipDuplicates: true });
  }
}
