import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import ClientLabelBadge from "../components/ClientLabelBadge";
import FileDropList from "../components/FileDropList";
import {
  api,
  createTrelloCard,
  getTrelloCards,
  getTrelloLists,
  type LabelMap,
  type TrelloCardRef,
  type TrelloList,
} from "../lib/api";
import { queue, sendOne, type QueuedFile } from "../lib/trelloUpload";

interface Props {
  clients: { id: string; name: string; slug: string }[];
  /** Preselect a client (the active tab, or the card's client). */
  clientId?: string | null;
  /** Attach straight to this card (a Ready row's Upload button). */
  card?: { id: string; name: string } | null;
  onClose: () => void;
  onDone?: () => void;
}

/*
 * Toreroflow -> Trello. Pick the client and its color label comes from
 * Settings; pick the list (Ready for posting by default); new or existing
 * card; drop files. Files go one at a time; over 250 MB is linked instead.
 */
export default function TrelloUploadModal({ clients, clientId, card, onClose, onDone }: Props) {
  const [client, setClient] = useState(clientId ?? clients[0]?.id ?? "");
  const [labelMap, setLabelMap] = useState<LabelMap | null>(null);
  const [lists, setLists] = useState<TrelloList[] | null>(null);
  const [listId, setListId] = useState("");
  const [mode, setMode] = useState<"new" | "existing">(card ? "existing" : "new");
  const [existing, setExisting] = useState<TrelloCardRef[]>([]);
  const [cardId, setCardId] = useState(card?.id ?? "");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; name: string } | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    void api.get<LabelMap>("/clients/label-map").then(setLabelMap).catch(() => setLabelMap(null));
    void getTrelloLists()
      .then((r) => {
        setLists(r.lists);
        setListId(r.lists.find((l) => l.name.trim().toLowerCase() === "ready for posting")?.id ?? r.lists[0]?.id ?? "");
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (card || mode !== "existing" || !listId || !client) return;
    void getTrelloCards(listId, client)
      .then((r) => setExisting(r.cards))
      .catch(() => setExisting([]));
  }, [card, mode, listId, client]);

  const color = useMemo(() => labelMap?.entries.find((e) => e.clientId === client)?.color ?? null, [labelMap, client]);
  const clientName = clients.find((c) => c.id === client)?.name ?? "";
  const target = card?.id ?? (mode === "existing" ? cardId : createdId);
  const canStart = !busy && !!client && !!color && files.some((f) => f.status !== "done") && (card || (mode === "new" ? name.trim() && listId : cardId));
  const failed = files.filter((f) => f.status === "failed").length;

  const patch = (key: string, p: Partial<QueuedFile>) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...p } : f)));

  async function run(only?: string) {
    setBusy(true);
    setError(null);
    try {
      let id = target;
      let url = "";
      let title = card?.name ?? existing.find((c) => c.id === cardId)?.name ?? name;
      if (!id) {
        const made = await createTrelloCard({ clientId: client, listId, name: name.trim(), desc: desc.trim() || undefined });
        id = made.id;
        url = made.url;
        title = made.name;
        setCreatedId(made.id);
      }
      for (const f of files) {
        if (f.status === "done" || (only && f.key !== only)) continue;
        patch(f.key, { status: "uploading", pct: 0, error: undefined });
        try {
          await sendOne(id, client, f, (pct) => patch(f.key, { pct }));
          patch(f.key, { status: "done", pct: 100 });
        } catch (e) {
          patch(f.key, { status: "failed", error: (e as Error).message });
        }
      }
      setResult({ url: url || existing.find((c) => c.id === id)?.url || "", name: title });
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const allDone = files.length > 0 && files.every((f) => f.status === "done");
  return (
    <Modal maxWidth={640} onClose={onClose} label="Upload to Trello" testId="trello-upload-modal">
      <div className="modal-h">
        <h3>Upload to Trello</h3>
        <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="tu-sub">Torone Editor Pipeline</p>

      {allDone && result ? (
        <div role="status" data-testid="tu-success">
          <p className="tu-note ok">
            ✓ {files.length} file{files.length === 1 ? "" : "s"} on “{result.name}” for {clientName}.
          </p>
          <div className="tu-foot">
            {result.url && (
              <a className="btn" href={result.url} target="_blank" rel="noreferrer">
                Open in Trello
              </a>
            )}
            <button type="button" className="btn pri" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="tu-two">
            <div className="tu-f">
              <label className="flabel" htmlFor="tu-client">Client</label>
              <select id="tu-client" data-testid="tu-client" value={client} disabled={busy || !!card} onChange={(e) => setClient(e.target.value)}>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {labelMap && <ClientLabelBadge color={color} />}
            </div>
            {!card && (
              <div className="tu-f">
                <label className="flabel" htmlFor="tu-list">List</label>
                <select id="tu-list" data-testid="tu-list" value={listId} disabled={busy || !lists} onChange={(e) => setListId(e.target.value)}>
                  {(lists ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {card ? (
            <p className="tu-sub">Attaching to “{card.name}”</p>
          ) : (
            <>
              <div className="tu-f">
                <span className="flabel">Attach to</span>
                <div className="rq-tabs" role="tablist">
                  {(["new", "existing"] as const).map((m) => (
                    <button key={m} type="button" role="tab" aria-selected={mode === m} className={`rq-tab${mode === m ? " on" : ""}`} disabled={busy || !!createdId} onClick={() => setMode(m)}>
                      {m === "new" ? "New card" : "Existing card"}
                    </button>
                  ))}
                </div>
              </div>
              {mode === "new" ? (
                <>
                  <div className="tu-f">
                    <label className="flabel" htmlFor="tu-title">Title</label>
                    <input id="tu-title" className="sop-text" data-testid="tu-title" value={name} disabled={busy || !!createdId} onChange={(e) => setName(e.target.value)} placeholder={`${clientName} – `} />
                  </div>
                  <div className="tu-f">
                    <label className="flabel" htmlFor="tu-desc">Description</label>
                    <textarea id="tu-desc" className="sop-text" rows={3} value={desc} disabled={busy || !!createdId} onChange={(e) => setDesc(e.target.value)} placeholder="Caption draft, music note, post date…" />
                  </div>
                </>
              ) : (
                <div className="tu-f">
                  <label className="flabel" htmlFor="tu-card">Card</label>
                  <select id="tu-card" data-testid="tu-card" value={cardId} disabled={busy} onChange={(e) => setCardId(e.target.value)}>
                    <option value="">{existing.length ? "Choose a card…" : `No ${clientName} cards in this list`}</option>
                    {existing.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          <div className="tu-f">
            <span className="flabel">Files</span>
            <FileDropList
              files={files}
              disabled={busy}
              onAdd={(f) => setFiles((cur) => [...cur, ...queue(f)])}
              onRemove={(k) => setFiles((cur) => cur.filter((f) => f.key !== k))}
              onRetry={(k) => void run(k)}
            />
          </div>

          {error && (
            <p className="tu-note bad" role="alert" data-testid="tu-error">
              {error}
            </p>
          )}
          {failed > 0 && !busy && (
            <p className="tu-note bad" role="alert">
              {failed} file{failed === 1 ? "" : "s"} didn’t upload. {target ? "The card exists; retry just those." : ""}
            </p>
          )}

          <div className="tu-foot">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn pri" data-testid="tu-start" disabled={!canStart} onClick={() => void run()}>
              {busy ? `Uploading… ${files.filter((f) => f.status === "done").length + 1} of ${files.length}` : failed ? "Retry failed" : "Upload"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
