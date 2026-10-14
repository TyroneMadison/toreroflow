import { useEffect, useState } from "react";
import { api, videoLabel, type MediaAssetInfo, type ReadyQueue } from "../lib/api";
import { clientPath, pathLinkProps, useRoute } from "../lib/routes";
import { useAppState } from "../state/AppState";
import SopPanel, { sopRequired } from "../components/SopPanel";
import ScheduleModal from "../modals/ScheduleModal";
import "./ReadyQueue.css";

/*
 * /clients/:slug/schedule/:card. The page form of the schedule modal: the
 * client's SOP pinned beside it, read and ticked before anything is offered.
 */
export default function ScheduleScreen() {
  const { slug, cardId } = useRoute();
  const { clients, selectedClientId, selectClient } = useAppState();
  const client = clients.find((c) => c.slug === slug) ?? null;
  const [card, setCard] = useState<ReadyQueue["cards"][number] | null>(null);
  const [assets, setAssets] = useState<MediaAssetInfo[] | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [done, setDone] = useState(false);

  // The modal body reads the selected client, so point it at this one.
  useEffect(() => {
    if (client && selectedClientId !== client.id) selectClient(client.id);
  }, [client, selectedClientId, selectClient]);

  useEffect(() => {
    void api
      .get<ReadyQueue>("/trello/ready")
      .then((q) => setCard(q.cards.find((c) => c.id === cardId) ?? null))
      .catch(() => setCard(null));
  }, [cardId]);

  useEffect(() => {
    if (!client) return;
    void api.get<MediaAssetInfo[]>(`/clients/${client.id}/media`).then((list) => setAssets(list.filter((a) => a.status === "ready")));
  }, [client]);

  if (!client) {
    return (
      <section className="screen active rq" data-screen="schedule" data-state="client-not-found">
        <div className="card glass empty" role="status">
          <b>No client "{slug}"</b>
          <a {...pathLinkProps(clientPath(null))}>Back to the Ready queue</a>
        </div>
      </section>
    );
  }

  const asset = assets?.find((a) => a.id === assetId) ?? null;
  const gated = sopRequired(client.sop) && !ack;
  return (
    <section className="screen active rq" data-screen="schedule" data-state={done ? "scheduled" : gated ? "sop-pending" : "ready"}>
      <nav className="rq-crumbs" aria-label="Breadcrumb">
        <a {...pathLinkProps(clientPath(client.slug))} data-testid="back-to-ready">
          {client.name} · Ready
        </a>{" "}
        › <span aria-current="page">{card?.name ?? "Card"}</span>
      </nav>
      <div className="rq-sched">
        <SopPanel clientId={client.id} acknowledged={ack} onAcknowledge={setAck} editable />
        <div className="card glass" aria-label="Pick the video" data-testid="schedule-pick">
          <div className="rowhead">
            <h3>{card ? card.name : "Trello card"}</h3>
            {card && (
              <a className="btn ghost" href={card.url} target="_blank" rel="noreferrer">
                Open in Trello
              </a>
            )}
          </div>
          {done ? (
            <div className="empty" role="status" data-testid="schedule-done">
              <b>Scheduled</b>
              <p>Move the Trello card to Scheduled when you are ready.</p>
              <a className="btn" {...pathLinkProps(clientPath(client.slug))}>
                Next ready card
              </a>
            </div>
          ) : (
            <>
              <label className="flabel" htmlFor="sched-asset">
                Uploaded video for this card
              </label>
              {assets === null ? (
                <p>Loading uploads…</p>
              ) : assets.length === 0 ? (
                <p data-testid="schedule-no-assets">No processed uploads for {client.name} yet. Upload the video in Upload &amp; Schedule first.</p>
              ) : (
                <select
                  id="sched-asset"
                  data-testid="schedule-asset"
                  value={assetId ?? ""}
                  onChange={(e) => setAssetId(e.target.value || null)}
                >
                  <option value="">Choose an upload…</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {videoLabel(a)}
                    </option>
                  ))}
                </select>
              )}
              {gated && (
                <p className="sop-hint" role="status" data-testid="sop-required">
                  Read {client.name}'s SOP and tick the box to unlock scheduling.
                </p>
              )}
              {asset && !gated && (
                <ScheduleModal
                  key={asset.id}
                  asset={asset}
                  inline
                  sopAcknowledged={ack}
                  onClose={() => setAssetId(null)}
                  onScheduled={() => setDone(true)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
