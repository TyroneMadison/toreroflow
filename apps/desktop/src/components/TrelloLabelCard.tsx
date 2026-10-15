import { useEffect, useState } from "react";
import { api, type LabelMap, type ReadyQueue } from "../lib/api";
import { COLOR_NAME, LABEL_SWATCH } from "../lib/labelColors";
import { clientPath, pathLinkProps } from "../lib/routes";
import { useAppState } from "../state/AppState";

const COLORS = ["red", "black", "yellow", "green", "orange", "purple", "blue", "sky", "lime", "pink"];

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
