import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAppState } from "../state/AppState";

type KeywordLine = { keywords: string[]; line: string };

/*
 * Settings › Caption block. Text added directly under every caption for a
 * client on every platform (no blank line, no divider), plus optional keyword
 * lines added when the title, card or caption mentions a keyword. YouTube's
 * title is never changed.
 */
export default function CaptionBlockCard() {
  const { clients, refreshClients } = useAppState();
  const [clientId, setClientId] = useState<string>(clients[0]?.id ?? "");
  const client = clients.find((c) => c.id === clientId) ?? null;
  const [block, setBlock] = useState("");
  const [on, setOn] = useState(true);
  const [lines, setLines] = useState<KeywordLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!clientId && clients[0]) setClientId(clients[0].id);
  }, [clients, clientId]);
  useEffect(() => {
    setBlock(client?.captionBlock ?? "");
    setOn(client?.captionBlockOn ?? true);
    setLines(client?.captionKeywords ?? []);
    setSaved(false);
  }, [client?.id, client?.captionBlock, client?.captionBlockOn, client?.captionKeywords]);

  async function save() {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`/clients/${client.id}/caption-block`, {
        captionBlock: block.trim() ? block : null,
        captionBlockOn: on,
        captionKeywords: lines
          .map((l) => ({ keywords: l.keywords.map((k) => k.trim()).filter(Boolean), line: l.line.trim() }))
          .filter((l) => l.keywords.length && l.line),
      });
      await refreshClients();
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setLine = (i: number, patch: Partial<KeywordLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="card glass setsec" id="settings-caption" data-section="caption" aria-label="Caption block">
      <div className="rowhead">
        <div>
          <h3>Caption block</h3>
          <div className="sub">
            Added directly under every caption for this client, on every platform, with no blank line or
            divider. Line breaks are kept exactly. The YouTube title is never changed.
          </div>
        </div>
        <select aria-label="Client" data-testid="caption-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="autherr">{error}</div>}
      {client && (
        <>
          <label className="flabel" style={{ marginTop: 12 }}>
            Caption block
          </label>
          <textarea
            data-testid="caption-block"
            value={block}
            onChange={(e) => {
              setBlock(e.target.value);
              setSaved(false);
            }}
            rows={12}
            style={{ width: "100%", whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.45 }}
            placeholder="e.g. Hey, if we haven’t met…"
          />
          <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={() => setOn(!on)} data-testid="caption-block-on">
            <span className={`switch${on ? " on" : ""}`} style={{ marginRight: 8 }} />
            {on ? "On by default" : "Off by default"} · {block.length} chars
          </button>

          <label className="flabel" style={{ marginTop: 16 }}>
            Keyword lines (optional)
          </label>
          <div className="sub" style={{ marginBottom: 8 }}>
            The first line whose keyword appears in the video title, Trello card or caption (any case) goes
            between the caption and the block.
          </div>
          {lines.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }} data-testid={`caption-kw-${i}`}>
              <input
                aria-label="Keywords, comma separated"
                placeholder="BMW, GLE"
                value={l.keywords.join(", ")}
                onChange={(e) => setLine(i, { keywords: e.target.value.split(",") })}
                style={{ flex: 1 }}
              />
              <input
                aria-label="Line to add"
                placeholder="another successful transaction ✅"
                value={l.line}
                onChange={(e) => setLine(i, { line: e.target.value })}
                style={{ flex: 2 }}
              />
              <button type="button" className="btn ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn ghost" onClick={() => setLines((ls) => [...ls, { keywords: [], line: "" }])}>
              + Add keyword line
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void save()} data-testid="caption-save" style={{ marginLeft: "auto" }}>
              {busy ? "Saving…" : saved ? "Saved ✓" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
