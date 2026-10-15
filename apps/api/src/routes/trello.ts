import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { createWriteStream, promises as fs, openAsBlob } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileLink } from "../files/link";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import { baseColor, buildLabelMap, clientSlug, DEFAULT_LABEL_MAP, resolveCard, resolveCardByCover } from "../trello/labelMap";

/** The list on the editor pipeline board that holds finished, unposted cards. */
const READY_LIST = "ready for posting";
/** Where a card goes once its video is uploaded and scheduled. */
const UPLOADED_LIST = "approved by client/ uploaded";
/** Trello refuses attachments over this; bigger files go as a Toreroflow link. */
export const TRELLO_MAX_BYTES = 250 * 1024 * 1024;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const NOT_CONFIGURED =
  "Trello is not connected. Set TRELLO_KEY and TRELLO_TOKEN on the API server (and TRELLO_BOARD_ID, or keep the board named Torone Editor Pipeline).";

interface TrelloLabel { id: string; name: string; color: string | null }
interface TrelloCard { id: string; name: string; shortUrl: string; idList: string; labels: TrelloLabel[]; cover?: { color: string | null } | null; dateLastActivity: string }

async function trello<T>(path: string, method: "GET" | "PUT" | "POST" = "GET", params: Record<string, string> = {}): Promise<T> {
  const u = new URL(`https://api.trello.com/1${path}`);
  u.searchParams.set("key", env.TRELLO_KEY);
  u.searchParams.set("token", env.TRELLO_TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { method, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Trello ${res.status}`);
  return (await res.json()) as T;
}

export async function trelloRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  const loadClients = (agencyId: string) =>
    prisma.client.findMany({
      where: { agencyId, deletedAt: null },
      select: { id: true, name: true, slug: true, trelloLabels: true, sop: true, sopUpdatedAt: true },
      orderBy: { createdAt: "asc" },
    });

  /** color -> client, for the settings card and for bots. */
  app.get("/clients/label-map", async (request) => {
    const clients = await loadClients(request.user.agencyId);
    const map = buildLabelMap(clients);
    return {
      defaults: DEFAULT_LABEL_MAP,
      entries: [...map.entries()].map(([color, clientId]) => {
        const c = clients.find((x) => x.id === clientId)!;
        return { color, clientId, clientName: c.name, clientSlug: clientSlug(c) };
      }),
      unlabeled: "held",
    };
  });

  /** Set the colors that route to a client. Empty restores the defaults. */
  app.put<{ Params: { id: string } }>("/clients/:id/trello-labels", async (request, reply) => {
    const body = z.object({ colors: z.array(z.string().min(1).max(30)).max(10) }).parse(request.body);
    const client = await prisma.client.findFirst({ where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null } });
    if (!client) return reply.status(404).send({ error: "client not found" });
    const colors = [...new Set(body.colors.map(baseColor).filter((c): c is string => !!c))];
    await prisma.client.update({ where: { id: client.id }, data: { trelloLabels: colors } });
    return { ok: true, colors };
  });

  /** The client's SOP. Null when none is added; never generated. */
  app.get<{ Params: { id: string } }>("/clients/:id/sop", async (request, reply) => {
    const c = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true, name: true, sop: true, sopUpdatedAt: true },
    });
    if (!c) return reply.status(404).send({ error: "client not found" });
    return { clientId: c.id, sop: c.sop?.trim() ? c.sop : null, updatedAt: c.sopUpdatedAt };
  });

  app.put<{ Params: { id: string } }>("/clients/:id/sop", async (request, reply) => {
    const body = z.object({ sop: z.string().max(20_000).nullable() }).parse(request.body);
    const c = await prisma.client.findFirst({ where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null } });
    if (!c) return reply.status(404).send({ error: "client not found" });
    const sop = body.sop?.trim() ? body.sop.trim() : null;
    const updated = await prisma.client.update({
      where: { id: c.id },
      data: { sop, sopUpdatedAt: sop ? new Date() : null },
      select: { sop: true, sopUpdatedAt: true },
    });
    return { clientId: c.id, sop: updated.sop, updatedAt: updated.sopUpdatedAt };
  });

  /**
   * Cards in the board's Ready for posting list, each routed to a client by
   * label. Answers 200 with configured:false when Trello is not set up, so the
   * screen can say why rather than show an error.
   */
  app.get("/trello/ready", async (request, reply) => {
    const clients = await loadClients(request.user.agencyId);
    const clientOut = clients.map((c) => ({
      id: c.id,
      name: c.name,
      slug: clientSlug(c),
      hasSop: Boolean(c.sop?.trim()),
    }));
    if (!env.TRELLO_KEY || !env.TRELLO_TOKEN) {
      return { configured: false, message: NOT_CONFIGURED, clients: clientOut, cards: [] };
    }
    try {
      let boardId = env.TRELLO_BOARD_ID;
      if (!boardId) {
        const boards = await trello<{ id: string; name: string }[]>("/members/me/boards?fields=name&filter=open");
        boardId = boards.find((b) => b.name.trim().toLowerCase() === env.TRELLO_BOARD_NAME.toLowerCase())?.id ?? "";
        if (!boardId) {
          return { configured: false, message: `No open Trello board named "${env.TRELLO_BOARD_NAME}".`, clients: clientOut, cards: [] };
        }
      }
      const lists = await trello<{ id: string; name: string }[]>(`/boards/${boardId}/lists?fields=name&filter=open`);
      const ready = lists.find((l) => l.name.trim().toLowerCase() === READY_LIST);
      if (!ready) {
        return { configured: false, message: 'The board has no "Ready for posting" list.', clients: clientOut, cards: [] };
      }
      const cards = await trello<TrelloCard[]>(`/lists/${ready.id}/cards?fields=name,shortUrl,idList,labels,cover,dateLastActivity`);
      const map = buildLabelMap(clients);
      return {
        configured: true,
        message: null,
        clients: clientOut,
        cards: cards.map((card) => {
          const r = resolveCardByCover(card.cover?.color, card.labels.map((l) => l.color), map);
          return {
            id: card.id,
            name: card.name,
            url: card.shortUrl,
            list: "Ready for posting",
            labels: card.labels.map((l) => ({ name: l.name, color: l.color })),
            coverColor: card.cover?.color ?? null,
            matchedBy: r.source,
            clientId: r.clientId,
            held: r.clientId === null,
            heldReason: r.clientId === null ? r.reason : null,
            lastActivity: card.dateLastActivity,
          };
        }),
      };
    } catch (err) {
      request.log.warn({ err }, "trello ready fetch failed");
      return reply.status(502).send({ error: "trello unavailable", detail: (err as Error).message });
    }
  });

  /** Viewers read; only the operator (and, for the card move, bots) write. */
  const isViewer = (request: { user: object }) => (request.user as { role?: string }).role === "viewer";
  const configured = () => Boolean(env.TRELLO_KEY && env.TRELLO_TOKEN);

  let boardCache: { id: string; lists: { id: string; name: string }[]; at: number } | null = null;
  /** The pipeline board and its open lists, cached a minute to spare Trello's rate limit. */
  async function board(): Promise<{ id: string; lists: { id: string; name: string }[] }> {
    if (boardCache && Date.now() - boardCache.at < 60_000) return boardCache;
    let id = env.TRELLO_BOARD_ID;
    if (!id) {
      const boards = await trello<{ id: string; name: string }[]>("/members/me/boards?fields=name&filter=open");
      id = boards.find((b) => norm(b.name) === norm(env.TRELLO_BOARD_NAME))?.id ?? "";
      if (!id) throw Object.assign(new Error(`No open Trello board named "${env.TRELLO_BOARD_NAME}".`), { status: 409 });
    }
    const lists = await trello<{ id: string; name: string }[]>(`/boards/${id}/lists?fields=name&filter=open`);
    boardCache = { id, lists, at: Date.now() };
    return boardCache;
  }
  const fail = (request: { log: { warn: (o: object, m: string) => void } }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) => {
    const e = err as Error & { status?: number };
    request.log.warn({ err: e.message }, "trello call failed");
    return reply.status(e.status ?? 502).send({ error: e.status ? e.message : "trello unavailable", detail: e.message });
  };

  /** The board's open lists, for the upload modal's list picker. */
  app.get("/trello/lists", async (request, reply) => {
    if (!configured()) return reply.status(503).send({ error: "trello not configured", detail: NOT_CONFIGURED });
    try {
      const b = await board();
      return { boardId: b.id, lists: b.lists.map((l) => ({ id: l.id, name: l.name })) };
    } catch (err) {
      return fail(request, reply, err);
    }
  });

  /** Cards in one list that route to one client, for "attach to existing card". */
  app.get<{ Querystring: { listId?: string; clientId?: string } }>("/trello/cards", async (request, reply) => {
    const q = z.object({ listId: z.string().regex(/^[a-f0-9]{24}$/), clientId: z.string().min(1) }).parse(request.query);
    if (!configured()) return reply.status(503).send({ error: "trello not configured", detail: NOT_CONFIGURED });
    try {
      const b = await board();
      if (!b.lists.some((l) => l.id === q.listId)) return reply.status(404).send({ error: "list not on the pipeline board" });
      const clients = await loadClients(request.user.agencyId);
      const map = buildLabelMap(clients);
      const cards = await trello<TrelloCard[]>(`/lists/${q.listId}/cards?fields=name,shortUrl,idList,labels,cover,dateLastActivity`);
      return {
        cards: cards
          .filter((c) => resolveCardByCover(c.cover?.color, c.labels.map((l) => l.color), map).clientId === q.clientId)
          .map((c) => ({ id: c.id, name: c.name, url: c.shortUrl })),
      };
    } catch (err) {
      return fail(request, reply, err);
    }
  });

  /** Find (or make) the board label for a client's first routing color. */
  async function labelFor(boardId: string, client: { name: string; slug: string | null; trelloLabels: string[]; id: string }, clients: MappableClientRow[]): Promise<string> {
    const map = buildLabelMap(clients);
    const color = [...map.entries()].find(([, id]) => id === client.id)?.[0];
    if (!color) throw Object.assign(new Error(`${client.name} has no Trello label color. Set one in Settings.`), { status: 409 });
    const labels = await trello<TrelloLabel[]>(`/boards/${boardId}/labels?fields=name,color&limit=1000`);
    const hit = labels.find((l) => baseColor(l.color) === color && norm(l.name) === norm(client.name)) ?? labels.find((l) => baseColor(l.color) === color);
    if (hit) return hit.id;
    const made = await trello<TrelloLabel>(`/labels`, "POST", { idBoard: boardId, name: client.name, color });
    return made.id;
  }
  type MappableClientRow = Awaited<ReturnType<typeof loadClients>>[number];

  /** New card in a pipeline list, labelled with the client's color. */
  app.post("/trello/cards", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change Trello" });
    const body = z.object({ clientId: z.string().min(1), listId: z.string().regex(/^[a-f0-9]{24}$/), name: z.string().trim().min(1).max(300), desc: z.string().max(10_000).optional() }).parse(request.body);
    if (!configured()) return reply.status(503).send({ error: "trello not configured", detail: NOT_CONFIGURED });
    const clients = await loadClients(request.user.agencyId);
    const client = clients.find((c) => c.id === body.clientId);
    if (!client) return reply.status(404).send({ error: "client not found" });
    try {
      const b = await board();
      if (!b.lists.some((l) => l.id === body.listId)) return reply.status(404).send({ error: "list not on the pipeline board" });
      const idLabel = await labelFor(b.id, client, clients);
      const card = await trello<{ id: string; name: string; shortUrl: string }>(`/cards`, "POST", { idList: body.listId, name: body.name, desc: body.desc ?? "", idLabels: idLabel, pos: "top" });
      return reply.status(201).send({ id: card.id, name: card.name, url: card.shortUrl });
    } catch (err) {
      return fail(request, reply, err);
    }
  });

  /** A card on the pipeline board that routes to this agency's client, or an error status. */
  async function ownCard(agencyId: string, cardId: string) {
    const card = await trello<TrelloCard & { idBoard: string }>(`/cards/${cardId}?fields=name,shortUrl,idList,idBoard,labels,cover`);
    const b = await board();
    if (card.idBoard !== b.id) throw Object.assign(new Error("card is not on the pipeline board"), { status: 404 });
    const clients = await loadClients(agencyId);
    const r = resolveCardByCover(card.cover?.color, card.labels.map((l) => l.color), buildLabelMap(clients));
    if (!r.clientId) throw Object.assign(new Error(`card has no client label (${r.reason})`), { status: 409 });
    return { card, clientId: r.clientId };
  }

  /**
   * One file onto a card. Streamed to a temp file (never held in memory), then
   * sent to Trello. Over 250 MB answers 413 with fallback:"link" so the app
   * stores it in Toreroflow and attaches a link instead.
   */
  app.post<{ Params: { id: string } }>("/trello/cards/:id/attachments", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change Trello" });
    if (!configured()) return reply.status(503).send({ error: "trello not configured", detail: NOT_CONFIGURED });
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > TRELLO_MAX_BYTES + 1024 * 1024) return reply.status(413).send({ error: "file over Trello's 250 MB limit", fallback: "link" });
    let tmp: string | null = null;
    try {
      const { card } = await ownCard(request.user.agencyId, request.params.id);
      const file = await request.file({ limits: { fileSize: TRELLO_MAX_BYTES } });
      if (!file) return reply.status(400).send({ error: "no file uploaded" });
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trello-"));
      tmp = path.join(dir, "upload");
      await pipeline(file.file, createWriteStream(tmp));
      if (file.file.truncated) return reply.status(413).send({ error: "file over Trello's 250 MB limit", fallback: "link" });
      const form = new FormData();
      form.set("file", await openAsBlob(tmp, { type: file.mimetype }), file.filename || "upload");
      form.set("name", file.filename || "upload");
      const u = new URL(`https://api.trello.com/1/cards/${card.id}/attachments`);
      u.searchParams.set("key", env.TRELLO_KEY);
      u.searchParams.set("token", env.TRELLO_TOKEN);
      const res = await fetch(u, { method: "POST", body: form, headers: { Accept: "application/json" } });
      if (res.status === 429) return reply.status(429).send({ error: "Trello is rate limiting; try again shortly", retryAfter: res.headers.get("retry-after") });
      if (!res.ok) throw new Error(`Trello ${res.status}`);
      const att = (await res.json()) as { id: string; name: string; url: string };
      return reply.status(201).send({ id: att.id, name: att.name, url: att.url });
    } catch (err) {
      return fail(request, reply, err);
    } finally {
      if (tmp) await fs.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  /** The large-file fallback: a signed Toreroflow link to an uploaded media asset. */
  app.post<{ Params: { id: string } }>("/trello/cards/:id/attachments/link", async (request, reply) => {
    if (isViewer(request)) return reply.status(403).send({ error: "viewers cannot change Trello" });
    const body = z.object({ mediaId: z.string().min(1) }).parse(request.body);
    if (!configured()) return reply.status(503).send({ error: "trello not configured", detail: NOT_CONFIGURED });
    try {
      const { card, clientId } = await ownCard(request.user.agencyId, request.params.id);
      const asset = await prisma.mediaAsset.findFirst({ where: { id: body.mediaId, clientId, client: { agencyId: request.user.agencyId } } });
      if (!asset || asset.storageKey === "pending") return reply.status(404).send({ error: "upload not found for this card's client" });
      const base = (env.OAUTH_REDIRECT_BASE || `${request.protocol}://${request.hostname}`).replace(/\/+$/, "");
      const att = await trello<{ id: string; name: string; url: string }>(`/cards/${card.id}/attachments`, "POST", { url: `${base}${fileLink(asset.storageKey)}`, name: `${asset.originalName} (Toreroflow)` });
      return reply.status(201).send({ id: att.id, name: att.name, url: att.url });
    } catch (err) {
      return fail(request, reply, err);
    }
  });

  /**
   * After a Ready card's video is uploaded and scheduled, move the card to
   * "Approved by Client/ uploaded" and leave a comment. Only a card that is in
   * Ready for posting and whose label maps to the given client moves, so a bot
   * cannot use this to shuffle the rest of the board.
   */
  app.post<{ Params: { id: string } }>("/trello/cards/:id/uploaded", async (request, reply) => {
    const body = z.object({ clientId: z.string().min(1), mediaId: z.string().min(1).optional(), note: z.string().max(500).optional() }).parse(request.body ?? {});
    if (!env.TRELLO_KEY || !env.TRELLO_TOKEN) return reply.status(503).send({ error: "trello not configured" });
    const clients = await loadClients(request.user.agencyId);
    if (!clients.some((c) => c.id === body.clientId)) return reply.status(404).send({ error: "client not found" });
    try {
      const card = await trello<TrelloCard & { idBoard: string }>(`/cards/${request.params.id}?fields=name,shortUrl,idList,idBoard,labels,cover`);
      const lists = await trello<{ id: string; name: string }[]>(`/boards/${card.idBoard}/lists?fields=name&filter=open`);
      const ready = lists.find((l) => norm(l.name) === READY_LIST);
      const done = lists.find((l) => norm(l.name) === UPLOADED_LIST);
      if (!done) return reply.status(409).send({ error: 'board has no "Approved by Client/ uploaded" list' });
      if (card.idList === done.id) return { ok: true, alreadyMoved: true, url: card.shortUrl };
      if (!ready || card.idList !== ready.id) return reply.status(409).send({ error: "card is not in Ready for posting" });
      const r = resolveCardByCover(card.cover?.color, card.labels.map((l) => l.color), buildLabelMap(clients));
      if (r.clientId !== body.clientId) return reply.status(409).send({ error: "card label does not match this client", reason: r.reason });
      await trello(`/cards/${card.id}`, "PUT", { idList: done.id, pos: "top" });
      const text = [`Uploaded and scheduled in Toreroflow${body.mediaId ? ` (media ${body.mediaId})` : ""}.`, body.note].filter(Boolean).join(" ");
      await trello(`/cards/${card.id}/actions/comments`, "POST", { text }).catch((err) => request.log.warn({ err }, "trello comment failed"));
      return { ok: true, alreadyMoved: false, url: card.shortUrl, list: done.name };
    } catch (err) {
      request.log.warn({ err }, "trello card move failed");
      return reply.status(502).send({ error: "trello unavailable", detail: (err as Error).message });
    }
  });
}