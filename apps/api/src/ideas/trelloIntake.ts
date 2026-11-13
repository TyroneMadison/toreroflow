import { getPrisma } from "@toreroflow/db";
import { TrelloIntakeConfigSchema, type TrelloIntakeConfig } from "@toreroflow/contracts";
import { env } from "../env";
import { NOT_CONFIGURED, trello } from "../routes/trello";
import { baseColor, buildLabelMap } from "../trello/labelMap";
import { readSetting, writeSetting } from "./settings";

/**
 * Client content requests become cards on the editor pipeline's "To edit"
 * list. The board and list are found by name at runtime and the ids kept in
 * the agency's "trello_intake" setting; a stale id is dropped on a Trello 404
 * so the next try finds them again. The label per brand comes from
 * labelByBrand, else the board label in the brand's routing color.
 */

export const TRELLO_INTAKE_SETTING = "trello_intake";
export const DEFAULT_TRELLO_INTAKE: TrelloIntakeConfig = {
  boardName: "Torone Editor Pipeline",
  listName: "To edit",
  boardId: null,
  listId: null,
  labelByBrand: {},
};

export function readIntakeConfig(agencyId: string): Promise<TrelloIntakeConfig> {
  return readSetting(agencyId, TRELLO_INTAKE_SETTING, TrelloIntakeConfigSchema, DEFAULT_TRELLO_INTAKE);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Board and list ids, discovered by name when the setting has none yet. */
export async function resolveIntake(agencyId: string): Promise<TrelloIntakeConfig & { boardId: string; listId: string }> {
  const config = await readIntakeConfig(agencyId);
  if (config.boardId && config.listId) return config as TrelloIntakeConfig & { boardId: string; listId: string };
  const boards = await trello<{ id: string; name: string }[]>("/members/me/boards", "GET", { fields: "name", filter: "open" });
  const board = boards.find((b) => same(b.name, config.boardName));
  if (!board) throw new Error(`No open Trello board named "${config.boardName}".`);
  const lists = await trello<{ id: string; name: string }[]>(`/boards/${board.id}/lists`, "GET", { fields: "name", filter: "open" });
  const list = lists.find((l) => same(l.name, config.listName));
  if (!list) throw new Error(`The board has no "${config.listName}" list.`);
  const found = { ...config, boardId: board.id, listId: list.id };
  await writeSetting(agencyId, TRELLO_INTAKE_SETTING, found);
  return found;
}

export function cardText(r: { what: string; dueDate: string | null; footageUrl: string | null; notes: string | null }) {
  const name = r.what.split("\n")[0]!.trim().slice(0, 120);
  const desc = [
    r.what,
    r.dueDate ? `Due: ${r.dueDate}` : null,
    r.footageUrl ? `Footage: ${r.footageUrl}` : null,
    r.notes ? `Notes: ${r.notes}` : null,
    "From the client request form.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { name, desc };
}

/**
 * Make the Trello card for one stored request and record the outcome on it.
 * Never throws: a failure is stored as status "failed" with the reason.
 */
export async function pushRequestToTrello(requestId: string): Promise<{ status: string; error: string | null }> {
  const prisma = getPrisma();
  const req = await prisma.contentRequest.findUnique({ where: { id: requestId }, include: { client: true } });
  if (!req) return { status: "failed", error: "request not found" };
  if (req.status === "created") return { status: "created", error: null };
  const agencyId = req.client.agencyId;
  let result: { status: string; error: string | null; trelloCardId?: string; trelloUrl?: string };
  if (!env.TRELLO_KEY || !env.TRELLO_TOKEN) {
    result = { status: "failed", error: NOT_CONFIGURED };
  } else {
    try {
      const intake = await resolveIntake(agencyId);
      let idLabel: string | undefined = intake.labelByBrand[req.clientId];
      if (!idLabel) {
        const clients = await prisma.client.findMany({
          where: { agencyId, deletedAt: null },
          select: { id: true, name: true, slug: true, trelloLabels: true },
        });
        const color = [...buildLabelMap(clients).entries()].find(([, id]) => id === req.clientId)?.[0];
        if (color) {
          const labels = await trello<{ id: string; color: string | null }[]>(`/boards/${intake.boardId}/labels`, "GET", { fields: "name,color", limit: "1000" });
          idLabel = labels.find((l) => baseColor(l.color) === color)?.id;
        }
      }
      const { name, desc } = cardText(req);
      const params: Record<string, string> = { idList: intake.listId, name, desc, pos: "top" };
      if (idLabel) params.idLabels = idLabel;
      if (req.dueDate) params.due = new Date(`${req.dueDate}T17:00:00Z`).toISOString();
      try {
        const card = await trello<{ id: string; shortUrl: string }>("/cards", "POST", params);
        result = { status: "created", error: null, trelloCardId: card.id, trelloUrl: card.shortUrl };
      } catch (e) {
        // A list or board that moved: forget the ids so the retry looks again.
        if (e instanceof Error && /Trello 404/.test(e.message)) {
          await writeSetting(agencyId, TRELLO_INTAKE_SETTING, { ...intake, boardId: null, listId: null });
        }
        throw e;
      }
    } catch (e) {
      result = { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  }
  await prisma.contentRequest.update({ where: { id: req.id }, data: result });
  return { status: result.status, error: result.error };
}
