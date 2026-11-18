import { useEffect, useState } from "react";
import { api, type LabelMap, type ReadyQueue } from "../lib/api";
import { COLOR_NAME, LABEL_SWATCH } from "../lib/labelColors";
import { useIsPhone } from "../lib/phone";
import { clientPath, pathLinkProps } from "../lib/routes";
import { useAppState } from "../state/AppState";
import BrandAvatar from "./BrandAvatar";
import { Ic, PickSheet } from "./analytics/phoneBits";

export const COLORS = ["red", "black", "yellow", "green", "orange", "purple", "blue", "sky", "lime", "pink"];

/** "gray/black" as "Gray or black", for the phone's rows. */
const colorLabel = (c: string) => {
  const n = (COLOR_NAME[c] ?? c).replace("/", " or ");
  return n.charAt(0).toUpperCase() + n.slice(1);
};

/*
 * Settings › Trello labels. Which card cover color on the Torone Editor
 * Pipeline board routes a card to which client (label color is only a fallback
 * for cards with no cover). Uncolored or unmapped cards are held.
 */
export default function TrelloLabelCard() {
  const { clients, refreshClients } = useAppState();
  const [map, setMap] = useState<LabelMap | null>(null);
  const [status, setStatus] = useState<Pick<ReadyQueue, "configured" | "message"> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPhone = useIsPhone();
  /** The color whose client sheet is open (phone). */
  const [pick, setPick] = useState<string | null>(null);

  const load = async () => {
    setMap(await api.get<LabelMap>("/clients/label-map"));
  };
  useEffect(() => {
    void load();
    void api.get<ReadyQueue>("/trello/ready").then((q) => setStatus(q)).catch(() => setStatus(null));
  }, []);

  async function assign(color: string, clientId: string) {
    setBusy(color);
    setError(null);
    try {
      // Take the color off whoever had it explicitly, then give it to the new client.
      for (const c of clients) {
        if (c.id !== clientId && c.trelloLabels.includes(color)) {
          await api.put(`/clients/${c.id}/trello-labels`, { colors: c.trelloLabels.filter((x) => x !== color) });
        }
      }
      const target = clients.find((c) => c.id === clientId);
      if (target) {
        // A client's first explicit color replaces its defaults, so keep the
        // ones it already resolves to.
        const current = map?.entries.filter((e) => e.clientId === clientId).map((e) => e.color) ?? [];
        const colors = [...new Set([...target.trelloLabels, ...current, color])];
        await api.put(`/clients/${clientId}/trello-labels`, { colors });
      }
      await refreshClients();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (isPhone) {
    // Routed colors first, each group in the desktop's order.
    const rows = COLORS.map((color) => ({ color, entry: map?.entries.find((e) => e.color === color) ?? null })).sort(
      (a, b) => Number(!!b.entry) - Number(!!a.entry),
    );
    const routed = rows.filter((r) => r.entry).length;
    const picked = pick ? (rows.find((r) => r.color === pick)?.entry ?? null) : null;
    return (
      <>
        <p className="st-intro">
          Each card cover color on the Torone Editor Pipeline board sends a card to one client. A label color counts
          only when the card has no cover. Cards with no color, or a color not listed, are held and never scheduled
          automatically.
        </p>
        {map && (
          <div className="st-pills">
            <span className="mb-pill ok">
              {routed} {routed === 1 ? "color" : "colors"} routed
            </span>
            <span className="mb-pill paused">{rows.length - routed} held</span>
          </div>
        )}
        {status && !status.configured && (
          <div className="mb-banner warn st-ban" role="status" data-testid="trello-not-configured">
            <Ic name="i-alert" />
            <span className="mb-bt">
              <b>Trello is not connected</b>
              {status.message}
            </span>
          </div>
        )}
        {error && <p className="mb-err">{error}</p>}
        <section className="mb-card st-cmap" aria-label="Trello cover color mapping">
          {rows.map(({ color, entry }) => {
            const name = colorLabel(color);
            const text = (
              <>
                <b>{name}</b>
                <small>{entry ? `Ready queue: ${entry.clientName}` : "Held, never scheduled"}</small>
              </>
            );
            const i = entry ? clients.findIndex((c) => c.id === entry.clientId) : -1;
            return (
              <div className="st-cm" key={color} data-testid={`label-map-${color}`}>
                <span className="st-sw" style={{ background: LABEL_SWATCH[color] }} aria-hidden="true" />
                {entry ? (
                  <a className="st-cmt" {...pathLinkProps(clientPath(entry.clientSlug))}>
                    {text}
                  </a>
                ) : (
                  <span className="st-cmt">{text}</span>
                )}
                <button
                  type="button"
                  className={`st-to${entry ? "" : " held"}`}
                  aria-haspopup="dialog"
                  aria-label={`Client for ${name} cover: ${entry ? entry.clientName : "held"}`}
                  disabled={busy !== null}
                  onClick={() => setPick(color)}
                  data-testid={`label-map-${color}-client`}
                >
                  {entry && i >= 0 && <BrandAvatar client={clients[i]!} index={i} size={26} />}
                  <span>{busy === color ? "Saving" : entry ? entry.clientName : "Held"}</span>
                  <Ic name="i-chev" />
                </button>
              </div>
            );
          })}
        </section>
        {pick && (
          <PickSheet
            label={`${colorLabel(pick)} cover goes to`}
            value={picked?.clientId ?? ""}
            options={[
              { value: "", label: "Held (no client)", hint: "Never scheduled automatically" },
              ...clients.map((c, i) => ({
                value: c.id,
                label: c.name,
                lead: <BrandAvatar client={c} index={i} size={32} />,
              })),
            ]}
            onPick={(v) => {
              // As on desktop, a color leaves a client only by going to another one.
              if (v && v !== picked?.clientId) void assign(pick, v);
            }}
            onClose={() => setPick(null)}
            testId="settings.trello.pick"
          />
        )}
      </>
    );
  }

  return (
    <div className="card glass setsec" id="settings-trello" data-section="trello" aria-label="Trello cover color mapping">
      <h3>Trello cover colors</h3>
      <div className="sub" style={{ marginBottom: 12 }}>
        Each card cover color on the Torone Editor Pipeline board sends a card to one client (a label color is used only if the card has no cover). Cards with no color, or a
        color not listed, are held and never scheduled automatically.
      </div>
      {status && !status.configured && (
        <div className="autherr" role="status" data-testid="trello-not-configured">
          {status.message}
        </div>
      )}
      {error && <div className="autherr">{error}</div>}
      <table className="rq-map" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th scope="col">Cover color</th>
            <th scope="col">Toreroflow client</th>
            <th scope="col">Ready queue</th>
          </tr>
        </thead>
        <tbody>
          {COLORS.map((color) => {
            const entry = map?.entries.find((e) => e.color === color) ?? null;
            return (
              <tr key={color} data-testid={`label-map-${color}`}>
                <td>
                  <span className="rq-label">
                    <span className="rq-dot" style={{ background: LABEL_SWATCH[color] }} aria-hidden="true" />
                    {COLOR_NAME[color] ?? color}
                  </span>
                </td>
                <td>
                  <select
                    aria-label={`Client for ${COLOR_NAME[color] ?? color} cover`}
                    data-testid={`label-map-${color}-client`}
                    value={entry?.clientId ?? ""}
                    disabled={busy !== null}
                    onChange={(e) => e.target.value && void assign(color, e.target.value)}
                  >
                    <option value="">Held (no client)</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{entry ? <a {...pathLinkProps(clientPath(entry.clientSlug))}>/clients/{entry.clientSlug}/ready</a> : "Held"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
