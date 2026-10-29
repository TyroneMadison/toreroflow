import { useEffect, useMemo, useState } from "react";
import {
  addCut,
  edlFromDoc,
  outputWordRefs,
  HOOK_DUR,
  HOOK_STYLE,
  ZOOM_CURVES,
  zoomItemFor,
  type BrollSpotSuggestion,
  type CleanupItem,
  type CleanupScan,
  type EditDoc,
  type HighlightSuggestion,
  type HookSuggestion,
  type ZoomSuggestion,
} from "@toreroflow/core";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { useEditor } from "../StudioEditor";
import { Chip, SliderRow } from "./index";

/** Ids of items the auto passes add, so a re-run replaces its own and no others. */
const AUTO_ZOOM = "az-";
const AUTO_BROLL = "ab-";

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/**
 * Phase 5 AI editing passes. Every pass asks the API for word-index
 * suggestions over the live doc, then applies them in one update() so a
 * pass is one undo step, and says what it changed.
 */
interface StockHit {
  id: number;
  page: string;
  thumb: string;
  by: string;
}

export default function AiPanel() {
  const { doc, update, assets, project, refreshAssets } = useEditor();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const call = async <T,>(pass: string, body: Record<string, unknown> = {}): Promise<T | null> => {
    setBusy(pass);
    try {
      return await api.post<T>(`/edit-projects/${project.id}/ai/${pass}`, { doc, ...body });
    } catch (e: unknown) {
      toast.fail(`Could not run ${pass}`, e);
      return null;
    } finally {
      setBusy(null);
    }
  };

  /* ---- speech cleanup ---- */
  const [pauseSec, setPauseSec] = useState(0.6);
  const [scan, setScan] = useState<CleanupScan | null>(null);
  const [offLabels, setOffLabels] = useState<Set<string>>(new Set());
  const [keptTakes, setKeptTakes] = useState<Set<string>>(new Set());
  const [pausesOn, setPausesOn] = useState(true);

  const rescan = async (p = pauseSec) => {
    const r = await call<CleanupScan>("cleanup", { pauseSec: p });
    if (r) setScan(r);
  };
  // Rescan whenever the cut changes, so the counts always match the edit.
  const cutsKey = JSON.stringify(doc.cuts) + JSON.stringify(doc.clips);
  useEffect(() => {
    if (scan) void rescan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutsKey]);

  const fillerChips = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of scan?.fillers ?? []) m.set(f.label, (m.get(f.label) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [scan]);

  const chosen: CleanupItem[] = scan
    ? [
        ...scan.fillers.filter((f) => !offLabels.has(f.label)),
        ...(pausesOn ? scan.pauses : []),
        ...scan.badTakes.filter((b) => !keptTakes.has(b.id)),
      ]
    : [];
  const chosenSec = chosen.reduce((s, c) => s + (c.end - c.start), 0);

  const applyCleanup = () => {
    if (!chosen.length) return;
    update((d) => {
      let next = d;
      for (const c of chosen) {
        const dur = assets.find((a) => a.id === c.assetId)?.durationSec ?? undefined;
        next = addCut(next, c.assetId, { start: c.start, end: c.end }, dur);
      }
      return next;
    });
    const n = (k: CleanupItem["kind"]) => chosen.filter((c) => c.kind === k).length;
    toast.success(
      `Removed ${n("filler")} fillers, ${n("pause")} pauses, ${n("badtake")} bad takes (${chosenSec.toFixed(1)}s). Undo puts them back.`,
    );
  };

  /* ---- hook ---- */
  const [hooks, setHooks] = useState<HookSuggestion[]>([]);
  const genHook = async () => {
    const r = await call<{ hooks: HookSuggestion[] }>("hook");
    if (!r) return;
    setHooks(r.hooks);
    if (!r.hooks.length) return toast.info("No headline found in the transcript.");
    setHook(r.hooks[0].text);
    toast.success(`Hook set: "${r.hooks[0].text}" for the first ${HOOK_DUR}s.`);
  };
  const setHook = (text: string) =>
    update((d) => ({
      ...d,
      hook: { text, dur: d.hook?.dur ?? HOOK_DUR, style: d.hook?.style ?? HOOK_STYLE },
    }));

  /* ---- highlights ---- */
  const hlCount = (h: EditDoc["captions"]["highlight"]) => ({
    k: Object.values(h?.keywords ?? {}).reduce((s, m) => s + Object.keys(m).length, 0),
    e: Object.values(h?.emojis ?? {}).reduce((s, m) => s + Object.keys(m).length, 0),
  });
  const applyHighlights = async () => {
    const r = await call<HighlightSuggestion>("highlights");
    if (!r) return;
    update((d) => ({ ...d, captions: { ...d.captions, enabled: true, highlight: r } }));
    const c = hlCount(r);
    toast.success(`Highlighted ${c.k} keywords and placed ${c.e} emojis.`);
  };

  /* ---- zooms ---- */
  const autoZooms = doc.zooms.filter((z) => z.id.startsWith(AUTO_ZOOM));
  const applyZooms = async () => {
    const r = await call<{ zooms: ZoomSuggestion[] }>("zooms");
    if (!r) return;
    update((d) => ({
      ...d,
      zooms: [
        ...d.zooms.filter((z) => !z.id.startsWith(AUTO_ZOOM)),
        ...r.zooms.map((s, k) => zoomItemFor(s, `${AUTO_ZOOM}${Date.now().toString(36)}${k}`)),
      ].sort((a, b) => a.at - b.at),
    }));
    toast.success(`Added ${r.zooms.length} face zooms on emphasis words.`);
  };

  /* ---- b-roll spots ---- */
  const [stockOk, setStockOk] = useState(false);
  const [stock, setStock] = useState<Record<string, StockHit[]>>({});
  const [importing, setImporting] = useState<number | null>(null);
  const spots = doc.brollSpots ?? [];
  const findSpots = async () => {
    const r = await call<{ spots: BrollSpotSuggestion[]; stock: boolean }>("broll-spots");
    if (!r) return;
    setStockOk(r.stock);
    update((d) => ({
      ...d,
      brollSpots: r.spots.map((s) => ({
        id: s.id,
        label: s.label,
        keywords: s.keywords,
        word: s.word,
        dur: Math.round(s.dur * 10) / 10,
      })),
    }));
    toast.success(`Marked ${r.spots.length} b-roll spots.`);
  };
  const mainIds = new Set(doc.clips.map((c) => c.assetId));
  const uploads = assets.filter((a) => a.kind === "clip" && !mainIds.has(a.id) && a.status === "ready");
  // Each spot's current output time, from its word anchor.
  const spotTimes = useMemo(() => {
    const words: Record<string, { word: string; start: number; end: number }[]> = {};
    const durations: Record<string, number> = {};
    for (const a of assets) {
      if (a.words) words[a.id] = a.words;
      if (a.durationSec) durations[a.id] = a.durationSec;
    }
    const refs = outputWordRefs(edlFromDoc(doc, durations), words);
    return new Map(refs.map((r) => [`${r.assetId}:${r.i}`, r.start]));
  }, [doc, assets]);
  const spotAt = (s: { word: { assetId: string; i: number } }) =>
    spotTimes.get(`${s.word.assetId}:${s.word.i}`) ?? 0;
  const fillSpot = (spotId: string, assetId: string) => {
    update((d) => {
      const s = (d.brollSpots ?? []).find((x) => x.id === spotId);
      if (!s) return d;
      return {
        ...d,
        brollSpots: (d.brollSpots ?? []).filter((x) => x.id !== spotId),
        broll: [
          ...d.broll,
          {
            id: `${AUTO_BROLL}${Date.now().toString(36)}`,
            assetId,
            at: 0, // reanchorDoc moves it onto its word in this same update
            dur: s.dur,
            x: 0,
            y: 0,
            scale: 1,
            shape: "full",
            volume: 0,
            fadeIn: 0.2,
            fadeOut: 0.2,
            word: s.word,
          },
        ],
      };
    });
  };
  /** Phase 8: download the Pexels file into the project, then fill the spot with it. */
  const importStock = async (spotId: string, hit: StockHit) => {
    setImporting(hit.id);
    try {
      const portrait = doc.output.aspect === "9:16" || doc.output.aspect === "4:5";
      const r = await api.post<{ asset: { id: string }; credit: string | null }>(
        `/edit-projects/${project.id}/broll/stock-import`,
        { pexelsId: hit.id, portrait },
      );
      await refreshAssets();
      fillSpot(spotId, r.asset.id);
      setStock((m) => ({ ...m, [spotId]: [] }));
      toast.success(`B-roll placed. Video by ${r.credit ?? "a Pexels creator"} on Pexels.`);
    } catch (e: unknown) {
      toast.fail("Importing the stock clip", e);
    } finally {
      setImporting(null);
    }
  };
  const searchStock = async (spotId: string, q: string) => {
    try {
      const r = await api.get<{ results: StockHit[] }>(
        `/broll/stock?q=${encodeURIComponent(q)}`,
      );
      setStock((m) => ({ ...m, [spotId]: r.results.slice(0, 3) }));
    } catch (e: unknown) {
      toast.fail("Stock search failed", e);
    }
  };

  const thinking = (p: string, label: string) =>
    busy === p ? <span className="pnl-thinking">Thinking...</span> : label;

  return (
    <div className="pnl-cards ai-pnl">
      <div className="glass-sm pnl-card">
        <b>Speech cleanup</b>
        <span className="sub">Every change is word-based and undoable.</span>
        {!scan ? (
          <div className="pnl-chiprow">
            <Chip disabled={busy !== null} onClick={() => void rescan()}>
              {thinking("cleanup", "Scan speech")}
            </Chip>
          </div>
        ) : (
          <>
            <div className="ai-lab">Filler words · {scan.fillers.length}</div>
            <div className="pnl-chiprow">
              {fillerChips.length === 0 && <span className="sub">None found.</span>}
              {fillerChips.map(([label, n]) => (
                <Chip
                  key={label}
                  on={!offLabels.has(label)}
                  onClick={() =>
                    setOffLabels((s) => {
                      const x = new Set(s);
                      if (x.has(label)) x.delete(label);
                      else x.add(label);
                      return x;
                    })
                  }
                >
                  {label} ×{n}
                </Chip>
              ))}
            </div>
            <div className="ai-lab">
              <label>
                <input type="checkbox" checked={pausesOn} onChange={(e) => setPausesOn(e.target.checked)} />{" "}
                Pauses longer than · {scan.pauses.length} ·{" "}
                {scan.pauses.reduce((s, p) => s + (p.end - p.start), 0).toFixed(1)}s
              </label>
            </div>
            <SliderRow
              min={0.3}
              max={2}
              step={0.1}
              digits={1}
              value={pauseSec}
              def={0.6}
              onCommit={(v) => {
                setPauseSec(v);
                void rescan(v);
              }}
            />
            <div className="ai-lab">Bad takes · {scan.badTakes.length}</div>
            {scan.badTakes.map((b) => {
              const kept = keptTakes.has(b.id);
              return (
                <div key={b.id} className="ai-take">
                  <span>
                    <s>{b.label}</s> keep <b>{b.keep}</b>
                  </span>
                  <Chip
                    on={!kept}
                    onClick={() =>
                      setKeptTakes((s) => {
                        const x = new Set(s);
                        if (x.has(b.id)) x.delete(b.id);
                        else x.add(b.id);
                        return x;
                      })
                    }
                  >
                    {kept ? "Keep" : "Remove"}
                  </Chip>
                </div>
              );
            })}
            <button className="btn primary pnl-wide" disabled={!chosen.length} onClick={applyCleanup}>
              Remove {chosen.length} ({chosenSec.toFixed(1)}s)
            </button>
          </>
        )}
      </div>

      <div className="glass-sm pnl-card">
        <b>Hook headline</b>
        {doc.hook && (
          <input
            className="ai-hook"
            value={doc.hook.text}
            onChange={(e) => {
              const text = e.target.value;
              update((d) => (d.hook ? { ...d, hook: { ...d.hook, text } } : d));
            }}
          />
        )}
        <div className="pnl-chiprow">
          <Chip disabled={busy !== null} onClick={() => void genHook()}>
            {thinking("hook", doc.hook ? "Regenerate" : "Generate hook")}
          </Chip>
          {doc.hook && (
            <>
              <span className="lab">0-{doc.hook.dur}s</span>
              <Chip onClick={() => update((d) => ({ ...d, hook: undefined }))}>Remove</Chip>
            </>
          )}
        </div>
        {hooks.length > 1 && (
          <div className="pnl-chiprow">
            {hooks.map((h) => (
              <Chip key={h.text} on={doc.hook?.text === h.text} onClick={() => setHook(h.text)}>
                {h.text}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div className="glass-sm pnl-card">
        <b>Keywords + emojis</b>
        <span className="sub">
          {hlCount(doc.captions.highlight).k} keywords · {hlCount(doc.captions.highlight).e} emojis
          {doc.captions.style.animation === "karaoke" ? " · karaoke on: keyword colors show without it" : ""}
        </span>
        <div className="pnl-chiprow">
          <Chip disabled={busy !== null} onClick={() => void applyHighlights()}>
            {thinking("highlights", "Highlight keywords")}
          </Chip>
          {doc.captions.highlight && (
            <Chip onClick={() => update((d) => ({ ...d, captions: { ...d.captions, highlight: undefined } }))}>
              Clear
            </Chip>
          )}
        </div>
      </div>

      <div className="glass-sm pnl-card">
        <b>Auto zoom · {autoZooms.length} moments</b>
        {autoZooms.map((z) => (
          <div key={z.id} className="ai-take">
            <span>
              <b>{fmt(z.at)}</b>{" "}
              {z.curve && z.curve[1]?.t === ZOOM_CURVES.slow_push[1].t ? "slow push" : "punch in"}
            </span>
            <span className="sub">on face</span>
          </div>
        ))}
        <div className="pnl-chiprow">
          <Chip disabled={busy !== null} onClick={() => void applyZooms()}>
            {thinking("zooms", autoZooms.length ? "Redo zooms" : "Add zooms")}
          </Chip>
          {autoZooms.length > 0 && (
            <Chip
              onClick={() => update((d) => ({ ...d, zooms: d.zooms.filter((z) => !z.id.startsWith(AUTO_ZOOM)) }))}
            >
              Clear
            </Chip>
          )}
        </div>
      </div>

      <div className="glass-sm pnl-card">
        <b>B-roll spots · {spots.length}</b>
        {spots.map((s) => (
          <div key={s.id} className="ai-spot">
            <div className="ai-take">
              <b>{s.label}</b>
              <span className="sub">{fmt(spotAt(s))}</span>
            </div>
            <span className="sub">keywords: {s.keywords.join(", ")}</span>
            <div className="pnl-chiprow">
              <select
                className="ai-sel"
                disabled={!uploads.length}
                title={uploads.length ? undefined : "Upload a b-roll clip first"}
                value=""
                onChange={(e) => e.target.value && fillSpot(s.id, e.target.value)}
              >
                <option value="">From uploads</option>
                {uploads.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.originalName}
                  </option>
                ))}
              </select>
              {stockOk && <Chip onClick={() => void searchStock(s.id, s.keywords.join(" "))}>Stock</Chip>}
            </div>
            {stock[s.id]?.map((r) => (
              <div key={r.page} className="ai-stock">
                <a href={r.page} target="_blank" rel="noreferrer">
                  <img src={r.thumb} alt="" /> Pexels · {r.by}
                </a>
                <Chip disabled={importing !== null} onClick={() => void importStock(s.id, r)}>
                  {importing === r.id ? "Importing..." : "Use"}
                </Chip>
              </div>
            ))}
          </div>
        ))}
        <div className="pnl-chiprow">
          <Chip disabled={busy !== null} onClick={() => void findSpots()}>
            {thinking("broll-spots", spots.length ? "Find again" : "Find b-roll spots")}
          </Chip>
        </div>
      </div>
    </div>
  );
}
