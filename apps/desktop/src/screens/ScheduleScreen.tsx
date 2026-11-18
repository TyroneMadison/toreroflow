import { useEffect, useState } from "react";
import { api, fileUrl, markCardUploaded, videoLabel, type MediaAssetInfo, type ReadyQueue } from "../lib/api";
import { clientPath, navigatePath, pathLinkProps, useRoute } from "../lib/routes";
import { useIsPhone } from "../lib/phone";
import { usePhoneBar } from "../lib/phoneBar";
import { mmss } from "../components/mobile/ThumbPlayer";
import BrandAvatar from "../components/BrandAvatar";
import { LABEL_SWATCH, COLOR_NAME, baseColor } from "../lib/labelColors";
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
  /** The last step: move the card to "Approved by Client/ uploaded". */
  const [move, setMove] = useState<{ state: "idle" | "moving" | "moved" | "failed"; error?: string }>({ state: "idle" });
  const isPhone = useIsPhone();
  const [showAll, setShowAll] = useState(false);
  // A deeper page on the phone: Back to the client's Ready queue, the card in Trello as the one action.
  usePhoneBar(
    isPhone
      ? {
          title: "Schedule card",
          back: () => navigatePath(clientPath(client?.slug ?? null)),
          action: card ? (
            <a className="mb-ib ghost" href={card.url} target="_blank" rel="noreferrer" aria-label="Open in Trello">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-trello" />
              </svg>
            </a>
          ) : undefined,
        }
      : null,
  );

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
  const moveCard = async (mediaId: string | null) => {
    if (!card || !client) return;
    setMove({ state: "moving" });
    try {
      await markCardUploaded(card.id, { clientId: client.id, mediaId: mediaId ?? undefined });
      setMove({ state: "moved" });
    } catch (e) {
      setMove({ state: "failed", error: (e as Error).message });
    }
  };
  // The SOP is a gentle reminder; scheduling is never held back for it.
  const remind = sopRequired(client.sop) && !ack;
  const clientIndex = clients.findIndex((c) => c.id === client.id);
  return (
    <section className={`screen active rq${isPhone ? " sdc" : ""}`} data-screen="schedule" data-state={done ? "scheduled" : "ready"}>
      {isPhone && (
        <header className="sdc-head">
          <a className="sdc-crumb" {...pathLinkProps(clientPath(client.slug))}>
            <BrandAvatar client={client} index={clientIndex} size={20} />
            {client.name} · Ready
          </a>
          <h1>{card?.name ?? "Trello card"}</h1>
          {card && (
            <div className="rqp-lbls">
              {card.labels.map((l, i) => {
                const b = baseColor(l.color);
                return (
                  <span key={i} className="rqp-lbl" style={b ? { ["--sw" as string]: LABEL_SWATCH[b] } : undefined}>
                    <i />
                    {(b && COLOR_NAME[b]) || b || "no color"}
                    {l.name ? ` · ${l.name}` : ""}
                  </span>
                );
              })}
            </div>
          )}
          <div className="sdc-pipe" aria-label="Pipeline stage">
            Edited › <b>{done ? "Scheduled" : "Ready for posting"}</b>
            {done ? "" : " › Scheduled"}
          </div>
        </header>
      )}
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
              {!card ? (
                <p>No Trello card to move.</p>
              ) : move.state === "moved" ? (
                <p className="tu-note ok rq-moved" data-testid="card-moved">
                  ✓ Card moved: Ready for posting → Approved by Client/ uploaded
                </p>
              ) : move.state === "failed" ? (
                <p className="tu-note warn rq-moved" role="alert" data-testid="card-move-failed">
                  Scheduled, but the card is still in Ready for posting ({move.error}).{" "}
                  <button type="button" className="btn ghost" onClick={() => void moveCard(assetId)}>
                    Retry move
                  </button>
                </p>
              ) : (
                <p className="tu-sub">Moving the Trello card…</p>
              )}
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
              ) : isPhone ? (
                <div className="sdc-list" role="radiogroup" aria-label="Uploaded video for this card" data-testid="schedule-asset">
                  {(showAll ? assets : assets.slice(0, 3)).map((a) => (
                    <label key={a.id} className={`sdc-vid${a.id === assetId ? " on" : ""}`}>
                      <span className="wfo-thumb">
                        {a.thumbUrl && <img src={fileUrl(a.thumbUrl) ?? undefined} alt="" />}
                        {a.durationSec ? <small>{mmss(a.durationSec)}</small> : null}
                      </span>
                      <span className="mb-lt">
                        <b>{videoLabel(a)}</b>
                        <small>Uploaded {new Date(a.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small>
                      </span>
                      <input type="radio" name="sched-asset" checked={a.id === assetId} onChange={() => setAssetId(a.id)} />
                    </label>
                  ))}
                  {assets.length > 3 && !showAll && (
                    <button type="button" className="mb-btn text sdc-more" onClick={() => setShowAll(true)}>
                      Show all {assets.length} uploads
                    </button>
                  )}
                </div>
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
              {remind && (
                <p className="sop-hint" role="status" data-testid="sop-reminder">
                  Reminder: check {client.name}'s SOP.
                </p>
              )}
              {asset && (
                <ScheduleModal
                  key={asset.id}
                  asset={asset}
                  inline
                  sopAcknowledged={ack}
                  onClose={() => setAssetId(null)}
                  onScheduled={() => {
                    setDone(true);
                    void moveCard(asset.id);
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
