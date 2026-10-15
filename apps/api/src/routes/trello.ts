import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "@toreroflow/db";
import { env } from "../env";
import { requireAuth } from "../plugins/requireAuth";
import { baseColor, buildLabelMap, clientSlug, DEFAULT_LABEL_MAP, resolveCard } from "../trello/labelMap";

/** The list on the editor pipeline board that holds finished, unposted cards. */
const READY_LIST = "ready for posting";
/** Where a card goes once its video is uploaded and scheduled. */
const UPLOADED_LIST = "approved by client/ uploaded";
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const NOT_CONFIGURED =
  "Trello is not connected. Set TRELLO_KEY and TRELLO_TOKEN on the API server (and TRELLO_BOARD_ID, or keep the board named Torone Editor Pipeline).";

interface TrelloLabel { id: string; name: string; color: string | null }
interface TrelloCard { id: string; name: string; shortUrl: string; idList: string; labels: TrelloLabel[]; dateLastActivity: string }

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
      const cards = await trello<TrelloCard[]>(`/lists/${ready.id}/cards?fields=name,shortUrl,idList,labels,dateLastActivity`);
      const map = buildLabelMap(clients);
      return {
        configured: true,
        message: null,
        clients: clientOut,
        cards: cards.map((card) => {
          const r = resolveCard(card.labels.map((l) => l.color), map);
          return {
            id: card.id,
            name: card.name,
            url: card.shortUrl,
            list: "Ready for posting",
            labels: card.labels.map((l) => ({ name: l.name, color: l.color })),
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
      const card = await trello<TrelloCard & { idBoard: string }>(`/cards/${request.params.id}?fields=name,shortUrl,idList,idBoard,labels`);
      const lists = await trello<{ id: string; name: string }[]>(`/boards/${card.idBoard}/lists?fields=name&filter=open`);
      const ready = lists.find((l) => norm(l.name) === READY_LIST);
      const done = lists.find((l) => norm(l.name) === UPLOADED_LIST);
      if (!done) return reply.status(409).send({ error: 'board has no "Approved by Client/ uploaded" list' });
      if (card.idList === done.id) return { ok: true, alreadyMoved: true, url: card.shortUrl };
      if (!ready || card.idList !== ready.id) return reply.status(409).send({ error: "card is not in Ready for posting" });
      const r = resolveCard(card.labels.map((l) => l.color), buildLabelMap(clients));
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