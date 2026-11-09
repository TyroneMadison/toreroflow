import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma, getPrisma } from "@toreroflow/db";
import {
  driveAccountIds,
  isDriveId,
  MAX_DRIVE_ACCOUNTS,
  parseDriveLink,
  readDriveSource,
  type DriveSource,
} from "@toreroflow/core";
import { DriveError, listFolderVideos } from "@toreroflow/publishers";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";

/**
 * Drive auto-post settings: a client's "Anyone with the link" Drive folder,
 * watched by the worker and posted to each ticked Instagram account as trial reels.
 *
 * Operator-only. None of these paths are on the bot whitelist
 * (auth/botAccess.ts), because Live mode posts to a client's account with no
 * one looking.
 */

const bad = (detail: string, error = "that request was not right") => ({ error, detail });

const NOT_SHOWN = "Drive would not show this folder. Set its sharing to Anyone with the link.";
const NOT_FOLDER = "That is not a Drive folder link. Open the folder in Drive and copy its link, the one with /folders/ in it.";

/** The folder id in a pasted link, or null when it is not a folder link. */
function folderIdOf(link: string): string | null {
  const ref = parseDriveLink(link);
  return ref?.kind === "folder" && isDriveId(ref.id) ? ref.id : null;
}

const saveBody = z.object({
  link: z.string().trim().max(500),
  socialAccountIds: z
    .array(z.string().max(40))
    .max(MAX_DRIVE_ACCOUNTS, `Tick at most ${MAX_DRIVE_ACCOUNTS} Instagram accounts.`)
    .optional(),
  /** Sent by apps from before several accounts could be ticked. */
  socialAccountId: z.string().trim().max(40).optional(),
  graduation: z.enum(["MANUAL", "SS_PERFORMANCE"]),
  mode: z.enum(["dryrun", "live"]),
  on: z.boolean(),
});

const checkBody = z.object({ link: z.string().trim().max(500).optional() });

/**
 * The one account an app from before several accounts could be ticked is
 * shown. Never empty while any id is stored: such an app preselects an
 * account only when it is sent none, and that account may be one nobody ticked.
 */
const legacyAccountId = (ids: string[], eligible: Set<string>) => ids.find((id) => eligible.has(id)) ?? ids[0] ?? "";

export async function driveSourceRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);
  const isViewer = (user: unknown) => (user as { role?: string }).role === "viewer";

  const ownedClient = (id: string, agencyId: string) =>
    prisma.client.findFirst({ where: { id, agencyId, deletedAt: null }, select: { id: true, driveSource: true } });
  // The same test the publish worker uses to send through the provider.
  const instagramAccounts = (clientId: string) =>
    prisma.socialAccount.findMany({
      where: { clientId, platform: "instagram", status: "connected", deletedAt: null, tokensEncrypted: "provider:zernio" },
      select: { id: true, handle: true },
      orderBy: { connectedAt: "asc" },
    });

  const view = async (clientId: string, settings: DriveSource) => {
    const [imports, accounts] = await Promise.all([
      prisma.driveImport.findMany({
        where: { clientId },
        orderBy: { createdAt: "desc" },
        take: 20,
        // detail (the dry-run payload) stays out: the list shows status and reason.
        select: { id: true, fileId: true, name: true, status: true, reason: true, assetId: true, postId: true, createdAt: true, updatedAt: true },
      }),
      instagramAccounts(clientId),
    ]);
    const legacy = legacyAccountId(settings.socialAccountIds, new Set(accounts.map((a) => a.id)));
    // socialAccountId is for apps still installed from before the list. Shown only, never stored.
    return { settings: { ...settings, socialAccountId: legacy }, keyReady: !!env.GOOGLE_DRIVE_API_KEY, imports, instagramAccounts: accounts };
  };

  app.get<{ Params: { clientId: string } }>("/clients/:clientId/drive-source", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    return view(client.id, readDriveSource(client.driveSource));
  });

  app.put<{ Params: { clientId: string } }>("/clients/:clientId/drive-source", async (request, reply) => {
    if (isViewer(request.user)) return reply.status(403).send(bad("Viewers cannot change this.", "not allowed"));
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    const parsed = saveBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the settings."));
    const { socialAccountIds, socialAccountId, ...b } = parsed.data;

    const folderId = b.link ? folderIdOf(b.link) : "";
    if (folderId === null) return reply.status(400).send(bad(NOT_FOLDER, "not a folder link"));
    if (b.on && !folderId) return reply.status(400).send(bad("Paste the Drive folder link first.", "no folder"));
    // Only accounts that can post now. One stored earlier that has since
    // disconnected is dropped by leaving it out, never kept by a save.
    const eligible = new Set((await instagramAccounts(client.id)).map((a) => a.id));
    const prev = readDriveSource(client.driveSource);

    let ids = driveAccountIds(socialAccountIds);
    const legacy = socialAccountIds === undefined && socialAccountId !== undefined;
    if (legacy) {
      // An app from before the list sees one account of it. Sending back the one
      // it was shown keeps the whole list. It cannot see the others, so it may
      // only replace a list of one.
      const kept = prev.socialAccountIds.filter((id) => eligible.has(id));
      if (socialAccountId === legacyAccountId(prev.socialAccountIds, eligible)) ids = kept;
      else if (kept.length > 1) {
        return reply
          .status(400)
          .send(bad("Several Instagram accounts are ticked for this folder. Update the app to change the Drive accounts.", "update the app"));
      } else ids = driveAccountIds([socialAccountId]);
    }
    if (ids.some((id) => !eligible.has(id))) {
      return reply
        .status(400)
        .send(bad("An Instagram account ticked is not connected to this brand. Untick it, then save again.", "account not found"));
    }
    if (b.on && !ids.length) {
      return reply
        .status(400)
        .send(
          bad(
            legacy ? "Pick the Instagram account the trial reels post to." : "Tick at least one Instagram account for the trial reels to post to.",
            "no account",
          ),
        );
    }

    // Switching on or changing folder starts the clock: files already in the folder never post.
    const restart = (b.on && (!prev.on || !prev.linkedAt)) || folderId !== prev.folderId;
    const next: DriveSource = {
      ...prev,
      ...b,
      socialAccountIds: ids,
      folderId,
      linkedAt: restart ? new Date().toISOString() : prev.linkedAt,
    };
    await prisma.client.update({ where: { id: client.id }, data: { driveSource: next as unknown as Prisma.InputJsonValue } });
    return view(client.id, next);
  });

  /** Lists the folder once. Takes the pasted link when sent, so a folder can be tried before saving. */
  app.post<{ Params: { clientId: string } }>("/clients/:clientId/drive-source/check", async (request, reply) => {
    const client = await ownedClient(request.params.clientId, request.user.agencyId);
    if (!client) return reply.status(404).send(bad("No such brand.", "brand not found"));
    const parsed = checkBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(bad(parsed.error.issues[0]?.message ?? "Check the link."));
    const link = parsed.data.link;
    const folderId = link ? folderIdOf(link) : readDriveSource(client.driveSource).folderId;
    if (!folderId) return { ok: false, reason: link ? NOT_FOLDER : "Paste the Drive folder link first." };
    try {
      const files = await listFolderVideos(folderId, { apiKey: env.GOOGLE_DRIVE_API_KEY, base: env.DRIVE_API_BASE });
      return { ok: true, videos: files.length, sample: files.slice(0, 5).map((f) => f.name) };
    } catch (e) {
      if (!(e instanceof DriveError)) throw e;
      return { ok: false, reason: e.status === 403 || e.status === 404 ? NOT_SHOWN : e.message };
    }
  });
}
