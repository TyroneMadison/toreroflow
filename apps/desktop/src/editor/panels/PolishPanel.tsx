import { useEffect, useRef, useState } from "react";
import {
  HOOK_PRESETS,
  LOOKS,
  LOWER_THIRD_DUR,
  SAFE_ZONES,
  STICKER_PACK,
  TRANSITIONS,
  TRANSITION_DUR,
  applyHookPreset,
  cleanWordList,
  edlFromDoc,
  transitionJoins,
  type EditDoc,
  type LowerThird,
  type SafePlatform,
} from "@toreroflow/core";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { useEditor } from "../StudioEditor";
import { Chip, ColorField, SliderRow, SubPills } from "./index";

type Tab = "transitions" | "text" | "censor" | "audio" | "look" | "overlays";
type FontInfo = { file: string; family: string; url: string };

const uid = () => Math.random().toString(36).slice(2, 10);

/** Phase 7 polish and effects (mock-ups 19-22). */
export default function PolishPanel() {
  const { doc, update, assets, project, outputTime } = useEditor();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("transitions");
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [wordsText, setWordsText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<{ fonts: FontInfo[] }>(`/clients/${project.clientId}/fonts`)
      .then((r) => setFonts(r.fonts))
      .catch(() => {});
    api
      .get<{ words: string[] }>(`/clients/${project.clientId}/censor-words`)
      .then((r) => setWordsText(r.words.join(", ")))
      .catch(() => {});
  }, [project.clientId]);

  const set = <K extends keyof EditDoc>(key: K, value: EditDoc[K]) => update((d) => ({ ...d, [key]: value }));

  const durations: Record<string, number> = {};
  for (const a of assets) if (a.durationSec) durations[a.id] = a.durationSec;
  const tr = doc.transitions ?? { auto: "none", dur: TRANSITION_DUR.def };
  const joins = transitionJoins({ ...tr, auto: tr.auto === "none" ? "crossfade" : tr.auto }, edlFromDoc(doc, durations));

  const censorDoc = doc.censor ?? { mask: false, audio: "off" as const, words: [] };
  // Switching censor on snapshots the client list into the doc.
  const censor = {
    ...censorDoc,
    words: censorDoc.words.length ? censorDoc.words : cleanWordList(wordsText.split(/[,\n]/)),
  };
  const enhance = doc.enhance ?? { on: false, lufs: -14 };
  const progress = doc.overlays?.progress ?? { on: false, color: "#ff5a36", position: "bottom" as const, height: 12 };

  const saveWords = async () => {
    const words = cleanWordList(wordsText.split(/[,\n]/));
    try {
      const r = await api.put<{ words: string[] }>(`/clients/${project.clientId}/censor-words`, { words });
      setWordsText(r.words.join(", "));
      // The doc keeps a snapshot so a render is the same whatever the list becomes later.
      set("censor", { ...censor, words: r.words });
      toast.success("Word list saved");
    } catch (e: unknown) {
      toast.fail("Could not save the word list", e);
    }
  };

  const uploadFont = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    try {
      const r = await api.postForm<{ font: FontInfo; fonts: FontInfo[] }>(`/clients/${project.clientId}/fonts`, form);
      setFonts(r.fonts);
      toast.success(`Added ${r.font.family}`);
    } catch (e: unknown) {
      toast.fail("Could not add the font", e);
    }
  };

  const addLowerThird = (kind: LowerThird["kind"]) => {
    const lt: LowerThird = {
      id: uid(),
      at: Math.max(0, outputTime),
      dur: LOWER_THIRD_DUR,
      kind,
      name: kind === "location" ? "Location" : "Name",
      title: kind === "nametitle" ? "Title" : undefined,
      from: "left",
      accent: "#ff5a36",
    };
    set("lowerThirds", [...(doc.lowerThirds ?? []), lt]);
  };
  const editLowerThird = (id: string, patch: Partial<LowerThird>) =>
    set(
      "lowerThirds",
      (doc.lowerThirds ?? []).map((l) => (l.id === id ? { ...l, ...patch } : l)),
    );

  return (
    <div className="pnl-cards">
      <SubPills
        tabs={[
          { id: "transitions", label: "Transitions" },
          { id: "text", label: "Text & fonts" },
          { id: "censor", label: "Censor" },
          { id: "audio", label: "Enhance" },
          { id: "look", label: "Looks" },
          { id: "overlays", label: "Overlays" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "transitions" && (
        <>
          <div className="glass-sm pnl-card">
            <b>Automatic at clip joins</b>
            <div className="pnl-chiprow" style={{ flexWrap: "wrap" }}>
              <Chip on={tr.auto === "none"} onClick={() => set("transitions", { ...tr, auto: "none" })}>
                None
              </Chip>
              {TRANSITIONS.map((t) => (
                <Chip key={t.id} on={tr.auto === t.id} onClick={() => set("transitions", { ...tr, auto: t.id })}>
                  {t.label}
                </Chip>
              ))}
            </div>
            <SliderRow
              label="SEC"
              min={TRANSITION_DUR.min}
              max={TRANSITION_DUR.max}
              step={0.05}
              digits={2}
              value={tr.dur}
              def={TRANSITION_DUR.def}
              onCommit={(v) => set("transitions", { ...tr, dur: v })}
            />
          </div>
          {joins.length > 0 && (
            <div className="glass-sm pnl-card">
              <b>Per join</b>
              {joins.map((j) => {
                const key = edlFromDoc(doc, durations)[j.seg]?.clipId ?? "";
                const cur = tr.joins?.[key];
                return (
                  <div key={key} className="pnl-chiprow">
                    <span className="lab">{j.at.toFixed(1)}s</span>
                    <select
                      value={cur === null ? "none" : (cur?.kind ?? "auto")}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = { ...(tr.joins ?? {}) };
                        if (v === "auto") delete next[key];
                        else next[key] = v === "none" ? null : { kind: v, dur: tr.dur };
                        set("transitions", { ...tr, joins: next });
                      }}
                    >
                      <option value="auto">Automatic</option>
                      <option value="none">None</option>
                      {TRANSITIONS.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "text" && (
        <>
          <div className="glass-sm pnl-card">
            <b>Hook style</b>
            <div className="pnl-chiprow">
              {HOOK_PRESETS.map((p) => (
                <Chip
                  key={p.id}
                  disabled={!doc.hook}
                  title={doc.hook ? undefined : "Add a hook first"}
                  onClick={() =>
                    update((d) => (d.hook ? { ...d, hook: { ...d.hook, style: applyHookPreset(d.hook.style, p.id) } } : d))
                  }
                >
                  {p.label}
                </Chip>
              ))}
            </div>
          </div>
          <div className="glass-sm pnl-card">
            <b>Lower thirds</b>
            <div className="pnl-chiprow">
              <Chip onClick={() => addLowerThird("nametitle")}>+ Name & title</Chip>
              <Chip onClick={() => addLowerThird("location")}>+ Location</Chip>
            </div>
            {(doc.lowerThirds ?? []).map((l) => (
              <div key={l.id} className="pnl-chiprow" style={{ flexWrap: "wrap" }}>
                <input value={l.name} onChange={(e) => editLowerThird(l.id, { name: e.target.value })} />
                {l.kind === "nametitle" && (
                  <input value={l.title ?? ""} onChange={(e) => editLowerThird(l.id, { title: e.target.value })} />
                )}
                <ColorField value={l.accent} onCommit={(c: string) => editLowerThird(l.id, { accent: c })} />
                <span className="lab">{l.at.toFixed(1)}s</span>
                <Chip
                  onClick={() =>
                    set(
                      "lowerThirds",
                      (doc.lowerThirds ?? []).filter((x) => x.id !== l.id),
                    )
                  }
                >
                  Remove
                </Chip>
              </div>
            ))}
          </div>
          <div className="glass-sm pnl-card">
            <b>Client fonts</b>
            {fonts.map((f) => (
              <div key={f.file} className="pnl-chiprow">
                <span style={{ fontFamily: `"${f.family}"` }}>{f.family}</span>
                <Chip
                  onClick={() =>
                    update((d) => ({ ...d, captions: { ...d.captions, style: { ...d.captions.style, font: f.family } } }))
                  }
                >
                  Use for captions
                </Chip>
                <Chip
                  onClick={() =>
                    void api
                      .del<{ fonts: FontInfo[] }>(`/clients/${project.clientId}/fonts/${encodeURIComponent(f.file)}`)
                      .then((r) => setFonts(r.fonts))
                  }
                >
                  Delete
                </Chip>
              </div>
            ))}
            <input
              ref={fileRef}
              type="file"
              accept=".ttf,.otf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadFont(f);
                e.target.value = "";
              }}
            />
            <button className="btn ghost pnl-wide" onClick={() => fileRef.current?.click()}>
              Upload .ttf / .otf
            </button>
          </div>
        </>
      )}

      {tab === "censor" && (
        <div className="glass-sm pnl-card">
          <b>Censor</b>
          <div className="pnl-chiprow">
            <Chip on={censor.mask} onClick={() => set("censor", { ...censor, mask: !censor.mask })}>
              Mask captions
            </Chip>
            {(["bleep", "mute", "off"] as const).map((a) => (
              <Chip key={a} on={censor.audio === a} onClick={() => set("censor", { ...censor, audio: a })}>
                {a === "off" ? "Audio as is" : a === "bleep" ? "Bleep" : "Mute"}
              </Chip>
            ))}
          </div>
          <span className="lab">Client word list (comma separated, word* matches prefixes)</span>
          <textarea rows={3} value={wordsText} onChange={(e) => setWordsText(e.target.value)} />
          <button className="btn ghost pnl-wide" onClick={() => void saveWords()}>
            Save list and apply
          </button>
        </div>
      )}

      {tab === "audio" && (
        <div className="glass-sm pnl-card">
          <b>Enhance speech</b>
          <div className="pnl-chiprow">
            <Chip on={enhance.on} onClick={() => set("enhance", { ...enhance, on: !enhance.on })}>
              {enhance.on ? "On" : "Off"}
            </Chip>
            <span className="lab">Highpass, denoise, loudness</span>
          </div>
          <SliderRow
            label="LUFS"
            min={-24}
            max={-9}
            value={enhance.lufs}
            def={-14}
            onCommit={(v) => set("enhance", { ...enhance, lufs: v })}
          />
        </div>
      )}

      {tab === "look" && (
        <div className="glass-sm pnl-card">
          <b>Looks</b>
          <div className="pnl-chiprow" style={{ flexWrap: "wrap" }}>
            {LOOKS.map((l) => (
              <Chip
                key={l.id}
                on={doc.look === l.id}
                onClick={() => update((d) => ({ ...d, look: l.id, color: { ...l.color } }))}
              >
                {l.label}
              </Chip>
            ))}
            <Chip onClick={() => update((d) => ({ ...d, look: undefined, color: { b: 0, c: 0, s: 0, w: 0 } }))}>
              Clear
            </Chip>
          </div>
        </div>
      )}

      {tab === "overlays" && (
        <>
          <div className="glass-sm pnl-card">
            <b>Progress bar</b>
            <div className="pnl-chiprow">
              <Chip
                on={progress.on}
                onClick={() => set("overlays", { ...doc.overlays, progress: { ...progress, on: !progress.on } })}
              >
                {progress.on ? "On" : "Off"}
              </Chip>
              {(["bottom", "top"] as const).map((p) => (
                <Chip
                  key={p}
                  on={progress.position === p}
                  onClick={() => set("overlays", { ...doc.overlays, progress: { ...progress, position: p } })}
                >
                  {p}
                </Chip>
              ))}
              <ColorField
                value={progress.color}
                onCommit={(c: string) => set("overlays", { ...doc.overlays, progress: { ...progress, color: c } })}
              />
            </div>
          </div>
          <div className="glass-sm pnl-card">
            <b>Stickers</b>
            <div className="pnl-chiprow" style={{ flexWrap: "wrap" }}>
              {STICKER_PACK.map((e) => (
                <Chip
                  key={e}
                  onClick={() =>
                    set("overlays", {
                      ...doc.overlays,
                      stickers: [
                        ...(doc.overlays?.stickers ?? []),
                        { id: uid(), emoji: e, at: Math.max(0, outputTime), dur: 2, x: 25, y: -25, scale: 0.15 },
                      ],
                    })
                  }
                >
                  {e}
                </Chip>
              ))}
            </div>
            {(doc.overlays?.stickers ?? []).map((s) => (
              <div key={s.id} className="pnl-chiprow">
                <span>{s.emoji}</span>
                <span className="lab">{s.at.toFixed(1)}s</span>
                <Chip
                  onClick={() =>
                    set("overlays", {
                      ...doc.overlays,
                      stickers: (doc.overlays?.stickers ?? []).filter((x) => x.id !== s.id),
                    })
                  }
                >
                  Remove
                </Chip>
              </div>
            ))}
          </div>
          <div className="glass-sm pnl-card">
            <b>Safe zones (preview only)</b>
            <div className="pnl-chiprow">
              <Chip on={!doc.safeZone} onClick={() => set("safeZone", undefined)}>
                Off
              </Chip>
              {(Object.keys(SAFE_ZONES) as SafePlatform[]).map((p) => (
                <Chip key={p} on={doc.safeZone === p} onClick={() => set("safeZone", p)}>
                  {SAFE_ZONES[p].label}
                </Chip>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
