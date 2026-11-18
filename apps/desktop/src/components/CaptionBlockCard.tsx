import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useIsPhone } from "../lib/phone";
import { useAppState } from "../state/AppState";
import BrandAvatar from "./BrandAvatar";
import { useToast } from "./Toasts";
import SwipeRow from "./mobile/SwipeRow";
import { Ic, PickSheet, Sheet } from "./analytics/phoneBits";

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
  const isPhone = useIsPhone();
  const toast = useToast();
  /** The phone's open edit sheet: the block itself or one keyword line. */
  const [edit, setEdit] = useState<"block" | number | null>(null);
  const [pickClient, setPickClient] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  // Stable keys for the phone's swipeable rules: an index key would hand a
  // swiped-away row's (hidden) element to the row after it.
  const keys = useRef(new WeakMap<KeywordLine, number>());
  const nextKey = useRef(0);
  const keyOf = (l: KeywordLine) => {
    let k = keys.current.get(l);
    if (k === undefined) keys.current.set(l, (k = ++nextKey.current));
    return k;
  };

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
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setLine = (i: number, patch: Partial<KeywordLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  if (isPhone) {
    const idx = clients.findIndex((c) => c.id === clientId);
    const dirty =
      !!client &&
      (block !== (client.captionBlock ?? "") ||
        on !== (client.captionBlockOn ?? true) ||
        JSON.stringify(lines) !== JSON.stringify(client.captionKeywords ?? []));
    const editing = typeof edit === "number" ? lines[edit] : undefined;
    // Removed here, kept until Save: Undo puts it back where it was.
    const removeLine = (i: number) => {
      const gone = lines[i]!;
      setLines((ls) => ls.filter((_, j) => j !== i));
      toast.success("Keyword line removed.", {
        label: "Undo",
        run: () => setLines((ls) => [...ls.slice(0, i), gone, ...ls.slice(i)]),
      });
    };
    return (
      <>
        <div className="st-sech">
          <h2>Caption block</h2>
          {client && (
            <button
              type="button"
              className="st-to"
              aria-haspopup="dialog"
              aria-label={`Client: ${client.name}`}
              onClick={() => setPickClient(true)}
              data-testid="caption-client"
            >
              <BrandAvatar client={client} index={idx} size={26} />
              <span>{client.name}</span>
              <Ic name="i-chev" />
            </button>
          )}
        </div>
        {error && <p className="mb-err">{error}</p>}
        {client && (
          <>
            <div className="st-rules">
              <button type="button" className="st-rule" onClick={() => setEdit("block")} data-testid="caption-block">
                <span className="st-ruleh">
                  <span className="mb-lab">Under every caption</span>
                  <span className={`mb-pill nodot${on ? " ok" : ""}`}>{on ? "On by default" : "Off by default"}</span>
                </span>
                <span className={`st-line clamp${block ? "" : " st-faint"}`}>{block || "No caption block yet."}</span>
              </button>
              <p className="st-help">
                Lines added to captions by keyword: the first one whose keyword appears in the video title, Trello card
                or caption goes between the caption and the block.
              </p>
              {lines.map((l, i) => {
                const words = l.keywords.map((k) => k.trim()).filter(Boolean);
                return (
                  <SwipeRow key={keyOf(l)} onLeft={() => removeLine(i)} testId={`caption-kw-${i}`}>
                    <button type="button" className="st-rule" onClick={() => setEdit(i)}>
                      <span className="st-kw">
                        {words.length ? words.map((k, j) => <span key={j}>{k}</span>) : <span className="st-faint">No keywords yet</span>}
                      </span>
                      <span className={`st-line${l.line ? "" : " st-faint"}`}>{l.line || "No line yet."}</span>
                    </button>
                  </SwipeRow>
                );
              })}
            </div>
            <button
              type="button"
              className="mb-btn ghost block"
              onClick={() => {
                setLines((ls) => [...ls, { keywords: [], line: "" }]);
                setEdit(lines.length);
              }}
            >
              <Ic name="i-plus" />
              Add keyword line
            </button>
            <div className="mb-actionbar">
              <button type="button" className="mb-btn pri" disabled={busy || !dirty} onClick={() => void save()} data-testid="caption-save">
                {busy ? (
                  "Saving"
                ) : !dirty && justSaved ? (
                  <>
                    <Ic name="i-check" />
                    Saved
                  </>
                ) : (
                  "Save"
                )}
              </button>
            </div>
          </>
        )}

        {edit === "block" && client && (
          <Sheet
            label="Caption block"
            title="Caption block"
            sub={client.name}
            onClose={() => setEdit(null)}
            className="st-sheet"
            foot={
              <button type="button" className="mb-btn pri" onClick={() => setEdit(null)}>
                Done
              </button>
            }
          >
            <p className="st-help">
              Added directly under every caption for this client, on every platform, with no blank line or divider.
              Line breaks are kept exactly. The YouTube title is never changed.
            </p>
            <textarea
              className="mb-input"
              rows={8}
              aria-label="Caption block"
              value={block}
              onChange={(e) => {
                setBlock(e.target.value);
                setSaved(false);
              }}
              placeholder="e.g. Hey, if we haven’t met…"
            />
            <button type="button" className="st-opt" role="switch" aria-checked={on} onClick={() => setOn(!on)} data-testid="caption-block-on">
              <span className="mb-lt">
                <b>On by default</b>
                <small>{block.length} chars</small>
              </span>
              <span className={`mb-tog${on ? " on" : ""}`} aria-hidden="true" />
            </button>
          </Sheet>
        )}
        {typeof edit === "number" && editing && (
          <Sheet
            label="Keyword line"
            title="Keyword line"
            sub={client?.name}
            onClose={() => setEdit(null)}
            className="st-sheet"
            foot={
              <>
                <button
                  type="button"
                  className="mb-btn danger"
                  onClick={() => {
                    setEdit(null);
                    removeLine(edit);
                  }}
                >
                  Remove
                </button>
                <button type="button" className="mb-btn pri" onClick={() => setEdit(null)}>
                  Done
                </button>
              </>
            }
          >
            <label className="mb-field">
              <span className="mb-flab">Keywords, comma separated</span>
              <input
                className="mb-input"
                placeholder="BMW, GLE"
                autoCapitalize="none"
                value={editing.keywords.join(", ")}
                onChange={(e) => setLine(edit, { keywords: e.target.value.split(",") })}
              />
            </label>
            <label className="mb-field">
              <span className="mb-flab">Line to add</span>
              <input
                className="mb-input"
                placeholder="another successful transaction ✅"
                value={editing.line}
                onChange={(e) => setLine(edit, { line: e.target.value })}
              />
            </label>
            <p className="st-help">
              The first line whose keyword appears in the video title, Trello card or caption (any case) goes between
              the caption and the block.
            </p>
          </Sheet>
        )}
        {pickClient && (
          <PickSheet
            label="Caption block for"
            value={clientId}
            options={clients.map((c, i) => ({ value: c.id, label: c.name, lead: <BrandAvatar client={c} index={i} size={32} /> }))}
            onPick={setClientId}
            onClose={() => setPickClient(false)}
          />
        )}
      </>
    );
  }

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
