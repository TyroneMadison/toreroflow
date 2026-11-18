import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ReadyCard, type ReadyQueue } from "../lib/api";
import { LABEL_SWATCH, COLOR_NAME, baseColor } from "../lib/labelColors";
import { clientPath, linkProps, pathLinkProps, useRoute } from "../lib/routes";
import TrelloUploadModal from "../modals/TrelloUploadModal";
import BrandAvatar from "../components/BrandAvatar";
import { useIsPhone } from "../lib/phone";
import { useAppState } from "../state/AppState";
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
  const [upload, setUpload] = useState<{ card: ReadyCard | null } | null>(null);
  const isPhone = useIsPhone();
  const { clients: brands } = useAppState();

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

  if (isPhone) {
    // The phone (mobile pass): cards grouped by client with the client's SOP
    // state and label colour in the group head, held cards last in their own
    // group, and Upload to Trello as the sticky action.
    const avatar = (id: string, size: number) => {
      const i = brands.findIndex((b) => b.id === id);
      return i >= 0 ? <BrandAvatar client={brands[i]!} index={i} size={size} /> : null;
    };
    const groups = clients
      .map((c) => ({ c, list: cards.filter((k) => !k.held && k.clientId === c.id) }))
      .filter((g) => g.list.length > 0);
    const heldCards = cards.filter((k) => k.held);
    const plural = (n: number) => `${n} card${n === 1 ? "" : "s"}`;
    return (
      <section className="screen active rqp" data-screen="ready" data-state={state} aria-label="Ready for posting">
        <div className="rqp-tools">
          <span className="mb-lab">Ready for posting{active ? ` · ${active.name}` : ""}</span>
          <span className="rqp-count" data-testid="ready-count" aria-live="polite">
            {plural(cards.filter((c) => !c.held || !slug).length)}
          </span>
          <button type="button" className="mb-ib ghost" aria-label="Refresh" data-testid="ready-refresh" onClick={() => void load()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-refresh" />
            </svg>
          </button>
        </div>
        <nav className="mb-chips rqp-chips" aria-label="Client filter">
          <a
            {...pathLinkProps(clientPath(null))}
            className={`mb-chip${slug ? " out" : " on"}`}
            aria-current={slug ? undefined : "page"}
            data-testid="client-tab-all"
          >
            All <span className="rqp-ct">{data?.cards.length ?? 0}</span>
          </a>
          {clients.map((c) => (
            <a
              key={c.id}
              {...pathLinkProps(clientPath(c.slug))}
              className={`mb-chip rqp-cchip${c.slug === slug ? " on" : " out"}`}
              aria-current={c.slug === slug ? "page" : undefined}
              data-testid={`client-tab-${c.slug}`}
            >
              {avatar(c.id, 26)}
              {c.name} <span className="rqp-ct">{counts.get(c.id) ?? 0}</span>
            </a>
          ))}
        </nav>
        <div className="rqp-pipe" aria-label="Pipeline stage">
          <span className="done">
            <i />
            Edited
          </span>
          <span className="ln" />
          <span className="now">
            <i />
            Ready for posting
          </span>
          <span className="ln" />
          <span>
            <i />
            Scheduled
          </span>
        </div>
        {error && (
          <div className="mb-banner bad" role="alert" data-testid="ready-error">
            Could not load the Ready queue: {error}
          </div>
        )}
        {data && !data.configured && (
          <div className="mb-empty" role="status" data-testid="trello-not-configured">
            <b>Trello not connected</b>
            <p>{data.message}</p>
          </div>
        )}
        {slug && data && !active && (
          <div className="mb-empty" role="status" data-testid="client-not-found">
            <b>No client "{slug}"</b>
            <p>Pick one of the chips above.</p>
          </div>
        )}
        {data?.configured && cards.length === 0 && (
          <div className="mb-empty" data-testid="ready-empty">
            <b>Nothing ready for posting</b>
            <p>Cards land here when an editor moves them to "Ready for posting" in Trello.</p>
          </div>
        )}
        {groups.map(({ c, list }) => {
          const color = baseColor(list[0]?.labels[0]?.color ?? null);
          return (
            <section key={c.id} className="mb-card rqp-grp" aria-label={c.name}>
              <div className="rqp-gh">
                {avatar(c.id, 40)}
                <span className="mb-lt">
                  <b>{c.name}</b>
                  <small>
                    {plural(list.length)}
                    <span className={c.hasSop ? "ok" : "warn"}>{c.hasSop ? "SOP on file" : "SOP not added yet"}</span>
                  </small>
                </span>
                {color && (
                  <span className="rqp-lbl" style={{ ["--sw" as string]: LABEL_SWATCH[color] }}>
                    <i />
                    {COLOR_NAME[color] || color}
                  </span>
                )}
              </div>
              {list.map((card) => (
                <PhoneCardRow key={card.id} card={card} client={c} onUpload={() => setUpload({ card })} />
              ))}
            </section>
          );
        })}
        {heldCards.length > 0 && (
          <section className="mb-card rqp-grp rqp-held" aria-label="Held">
            <div className="rqp-gh">
              <span className="mb-lic warn">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-pause" />
                </svg>
              </span>
              <span className="mb-lt">
                <b>Held</b>
                <small>{plural(heldCards.length)}, never scheduled automatically</small>
              </span>
            </div>
            <p className="rqp-hb" data-testid="ready-held-note">
              No label, an unmapped color, or labels for two clients. Fix the label in Trello or in{" "}
              <a {...linkProps("settings", "trello")}>Settings › Trello labels</a>.
            </p>
            {heldCards.map((card) => (
              <PhoneCardRow key={card.id} card={card} client={null} onUpload={() => setUpload({ card })} />
            ))}
          </section>
        )}
        {data?.configured && (
          <div className="mb-actionbar">
            <button type="button" className="mb-btn pri" data-testid="ready-upload" onClick={() => setUpload({ card: null })}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-trello" />
              </svg>
              Upload to Trello
            </button>
          </div>
        )}
        {upload && (
          <TrelloUploadModal
            clients={clients}
            clientId={upload.card?.clientId ?? active?.id ?? null}
            card={upload.card}
            onClose={() => setUpload(null)}
            onDone={() => void load()}
          />
        )}
      </section>
    );
  }

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
        {data?.configured && (
          <button type="button" className="btn pri" data-testid="ready-upload" onClick={() => setUpload({ card: null })}>
            Upload to Trello
          </button>
        )}
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
                <CardRow key={card.id} card={card} clients={clients} onUpload={() => setUpload({ card })} />
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
      {upload && (
        <TrelloUploadModal
          clients={clients}
          clientId={upload.card?.clientId ?? active?.id ?? null}
          card={upload.card}
          onClose={() => setUpload(null)}
          onDone={() => void load()}
        />
      )}
    </section>
  );
}

/** One Ready card on the phone: the name, its labels, then Schedule, Upload and Trello (held cards: Trello only). */
function PhoneCardRow({ card, client, onUpload }: { card: ReadyCard; client: ReadyQueue["clients"][number] | null; onUpload: () => void }) {
  const trello = (
    <a className={`mb-ib${client ? "" : " ghost rqp-tr"}`} href={card.url} target="_blank" rel="noreferrer" aria-label={`Open ${card.name} in Trello`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <use href="#i-trello" />
      </svg>
    </a>
  );
  return (
    <div className="rqp-row" data-testid={`ready-card-${card.id}`} data-client={client?.slug ?? "held"}>
      <div className="rqp-main">
        <b>{card.name}</b>
        <div className="rqp-lbls">
          {card.labels.length === 0 && (
            <span className="rqp-lbl none">
              <i />
              no label
            </span>
          )}
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
          {!client && <span data-testid="ready-card-client">→ Held ({card.heldReason})</span>}
        </div>
      </div>
      {client ? (
        <div className="rqp-acts">
          <a
            {...pathLinkProps(clientPath(client.slug, card.id))}
            className="mb-btn sm"
            data-testid="ready-card-schedule"
            aria-label={`Schedule ${card.name} for ${client.name}`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-cal" />
            </svg>
            Schedule
          </a>
          <button type="button" className="mb-btn sm ghost" data-testid="ready-card-upload" aria-label={`Upload files to ${card.name}`} onClick={onUpload}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-upload" />
            </svg>
            Upload
          </button>
          {trello}
        </div>
      ) : (
        trello
      )}
    </div>
  );
}

function CardRow({ card, clients, onUpload }: { card: ReadyCard; clients: ReadyQueue["clients"]; onUpload: () => void }) {
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
          <button type="button" className="btn ghost" data-testid="ready-card-upload" aria-label={`Upload files to ${card.name}`} onClick={onUpload}>
            Upload
          </button>
        )}
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
