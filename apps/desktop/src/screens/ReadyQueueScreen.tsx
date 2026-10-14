import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ReadyCard, type ReadyQueue } from "../lib/api";
import { LABEL_SWATCH, COLOR_NAME, baseColor } from "../lib/labelColors";
import { clientPath, pathLinkProps, useRoute } from "../lib/routes";
import "./ReadyQueue.css";

/*
 * Cards in Trello's "Ready for posting" list, by client. One URL per client
 * (/clients/caleb/ready), stable test ids on every row, and no hover-only
 * controls, so a person or a bot finds the next thing to schedule in one step.
 */
export default function ReadyQueueScreen() {
  const { slug } = useRoute();
  const [data, setData] = useState<ReadyQueue | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<ReadyQueue>("/trello/ready"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const clients = data?.clients ?? [];
  const active = slug ? (clients.find((c) => c.slug === slug) ?? null) : null;
  const counts = useMemo(() => {
    const m = new Map<string | null, number>();
    for (const c of data?.cards ?? []) m.set(c.clientId, (m.get(c.clientId) ?? 0) + 1);
    return m;
  }, [data]);
  const cards = (data?.cards ?? []).filter((c) => (slug ? c.clientId === active?.id : true));
  const held = (data?.cards ?? []).filter((c) => c.held);
  const state = error ? "error" : !data ? "loading" : !data.configured ? "unconfigured" : cards.length ? "ready" : "empty";

  return (
    <section className="screen active rq" data-screen="ready" data-state={state} aria-label="Ready for posting">
      <div className="rq-head">
        <h2>
          Ready for posting{active ? ` · ${active.name}` : ""}
        </h2>
        <span className="rq-count" data-testid="ready-count" aria-live="polite">
          {cards.filter((c) => !c.held || !slug).length} cards
        </span>
        <button type="button" className="btn ghost" data-testid="ready-refresh" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <nav className="rq-tabs" aria-label="Client filter">
        <a
          {...pathLinkProps(clientPath(null))}
          className={`rq-tab${slug ? "" : " on"}`}
          aria-current={slug ? undefined : "page"}
          data-testid="client-tab-all"
        >
          All · {data?.cards.length ?? 0}
        </a>
        {clients.map((c) => (
          <a
            key={c.id}
            {...pathLinkProps(clientPath(c.slug))}
            className={`rq-tab${c.slug === slug ? " on" : ""}`}
            aria-current={c.slug === slug ? "page" : undefined}
            data-testid={`client-tab-${c.slug}`}
          >
            {c.name} · {counts.get(c.id) ?? 0}
          </a>
        ))}
      </nav>

      {error && (
        <div className="autherr" role="alert" data-testid="ready-error">
          Could not load the Ready queue: {error}
        </div>
      )}
      {data && !data.configured && (
        <div className="card glass empty" role="status" data-testid="trello-not-configured">
          <b>Trello not connected</b>
          <p>{data.message}</p>
        </div>
      )}
      {slug && data && !active && (
        <div className="card glass empty" role="status" data-testid="client-not-found">
          <b>No client "{slug}"</b>
          <p>Pick one of the tabs above.</p>
        </div>
      )}

      {data?.configured && (
        <div className="card glass">
          {cards.length === 0 ? (
            <div className="empty" data-testid="ready-empty">
              <b>Nothing ready for posting</b>
              <p>Cards land here when an editor moves them to "Ready for posting" in Trello.</p>
            </div>
          ) : (
            <ul className="rq-list" aria-label="Ready cards">
              {cards.map((card) => (
                <CardRow key={card.id} card={card} clients={clients} />
              ))}
            </ul>
          )}
        </div>
      )}

      {!slug && held.length > 0 && (
        <p className="rq-note" data-testid="ready-held-note">
          {held.length} held: no label, an unmapped color, or labels for two clients. Fix the label in Trello or in
          Settings › Trello labels. Held cards are never scheduled automatically.
        </p>
      )}
    </section>
  );
}

function CardRow({ card, clients }: { card: ReadyCard; clients: ReadyQueue["clients"] }) {
  const client = clients.find((c) => c.id === card.clientId) ?? null;
  return (
    <li className="rq-row" data-testid={`ready-card-${card.id}`} data-client={client?.slug ?? "held"}>
      <div className="rq-main">
        <b>{card.name}</b>
        <div className="rq-labels">
          {card.labels.map((l, i) => {
            const b = baseColor(l.color);
            return (
              <span key={i} className="rq-label" data-color={b ?? "none"}>
                <span className="rq-dot" style={{ background: b ? LABEL_SWATCH[b] : "transparent" }} aria-hidden="true" />
                {(b && COLOR_NAME[b]) || b || "no color"}
                {l.name ? ` · ${l.name}` : ""}
              </span>
            );
          })}
          <span className="rq-arrow" aria-hidden="true">→</span>
          <span data-testid="ready-card-client">{client ? client.name : `Held (${card.heldReason})`}</span>
        </div>
        <div className="rq-pipe" aria-label="Pipeline stage">
          Edited › <b>Ready for posting</b> › Scheduled
        </div>
      </div>
      <div className="rq-sop" data-testid="ready-card-sop">
        {client ? (client.hasSop ? "SOP on file" : "SOP not added yet") : ""}
      </div>
      <div className="rq-actions">
        <a className="btn ghost" href={card.url} target="_blank" rel="noreferrer" aria-label={`Open ${card.name} in Trello`}>
          Trello
        </a>
        {client && (
          <a
            {...pathLinkProps(clientPath(client.slug, card.id))}
            className="btn"
            data-testid="ready-card-schedule"
            aria-label={`Schedule ${card.name} for ${client.name}`}
          >
            Schedule
          </a>
        )}
      </div>
    </li>
  );
}
