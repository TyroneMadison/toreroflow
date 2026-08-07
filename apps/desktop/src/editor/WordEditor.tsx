import { useMemo, useState, type ReactNode } from "react";
import {
  edlFromDoc,
  removeCutsOverlapping,
  sentencesFromWords,
  toOutputTime,
  toggleWordRemoved,
  type CutRange,
  type Sentence,
  type SentenceWord,
} from "@toreroflow/core";
import { useEditor, type EditAssetInfo } from "./StudioEditor";
import "./WordEditor.css";

type Mode = "remove" | "restore" | "edit";

const MODES: { id: Mode; label: string; helper: string }[] = [
  { id: "remove", label: "Remove words", helper: "Select words to remove from the cut" },
  { id: "restore", label: "Restore words", helper: "Tap struck words to bring them back" },
  { id: "edit", label: "Edit words", helper: "Click a word to fix what the transcript heard" },
];

/** A word is removed when its [start, end] sits fully inside a cut. */
function isRemoved(cuts: CutRange[], start: number, end: number): boolean {
  return cuts.some((c) => c.start <= start && c.end >= end);
}

/**
 * The Word editor: transcript-driven cutting. Sentence rows per clip in
 * doc.clips order; each word toggles removal, revives, or edits depending
 * on the active mode.
 */
export default function WordEditor() {
  const { doc, update, assets, seek, setPlaying } = useEditor();
  const [mode, setMode] = useState<Mode>("remove");
  const [editing, setEditing] = useState<{ assetId: string; index: number } | null>(null);

  const byId = useMemo(() => {
    const m: Record<string, EditAssetInfo> = {};
    for (const a of assets) m[a.id] = a;
    return m;
  }, [assets]);

  const durations = useMemo(() => {
    const d: Record<string, number> = {};
    for (const a of assets) {
      if (a.kind === "clip" && a.durationSec !== null) d[a.id] = a.durationSec;
    }
    return d;
  }, [assets]);

  const edl = useMemo(() => edlFromDoc(doc, durations), [doc, durations]);

  /** Seeks the preview to the first kept word of the sentence and plays. */
  const playSentence = (assetId: string, s: Sentence) => {
    for (const w of s.words) {
      const t = toOutputTime(edl, assetId, w.start);
      if (t !== null) {
        seek(t);
        setPlaying(true);
        return;
      }
    }
  };

  const onWord = (assetId: string, w: SentenceWord, removed: boolean) => {
    if (mode === "edit") {
      setEditing({ assetId, index: w.index });
      return;
    }
    if (mode === "remove" && !removed) {
      update((d) => toggleWordRemoved(d, assetId, w.start, w.end));
    }
    if (mode === "restore" && removed) {
      update((d) => removeCutsOverlapping(d, assetId, { start: w.start, end: w.end }));
    }
  };

  const commitEdit = (assetId: string, index: number, original: string, value: string) => {
    setEditing(null);
    const next = value.trim();
    const current = doc.wordEdits[assetId]?.[index] ?? original;
    if (next === current) return;
    update((d) => {
      const forAsset = { ...(d.wordEdits[assetId] ?? {}) };
      if (!next || next === original) delete forAsset[index];
      else forAsset[index] = next;
      const wordEdits = { ...d.wordEdits };
      if (Object.keys(forAsset).length === 0) delete wordEdits[assetId];
      else wordEdits[assetId] = forAsset;
      return { ...d, wordEdits };
    });
  };

  const rows: ReactNode[] = [];
  for (const { assetId } of doc.clips) {
    const a = byId[assetId];
    if (!a) continue;

    if (a.status === "uploaded" || a.status === "processing") {
      rows.push(
        <div key={a.id} className="wed-row glass-sm">
          <div className="skel wed-skel" />
        </div>,
      );
      continue;
    }

    const words = a.words ?? [];
    if (words.length === 0) {
      rows.push(
        <div key={a.id} className="wed-row glass-sm">
          <span className="wed-none">No speech found in {a.originalName}.</span>
        </div>,
      );
      continue;
    }

    const cuts = doc.cuts[a.id] ?? [];
    const edits = doc.wordEdits[a.id] ?? {};
    sentencesFromWords(words).forEach((s, si) => {
      rows.push(
        <div key={`${a.id}-${si}`} className="wed-row glass-sm">
          <button
            className="iconbtn wed-play"
            title="Play this sentence"
            onClick={() => playSentence(a.id, s)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-play" />
            </svg>
          </button>
          <div className="wed-words">
            {s.words.map((w) => {
              const removed = isRemoved(cuts, w.start, w.end);
              const replaced = edits[w.index];
              if (editing && editing.assetId === a.id && editing.index === w.index) {
                return (
                  <WordInput
                    key={w.index}
                    initial={replaced ?? w.word}
                    onCommit={(v) => commitEdit(a.id, w.index, w.word, v)}
                    onCancel={() => setEditing(null)}
                  />
                );
              }
              const actionable =
                mode === "edit" || (mode === "remove" ? !removed : removed);
              return (
                <span
                  key={w.index}
                  className={`wed-w${removed ? " cut" : ""}${replaced ? " edited" : ""}${actionable ? " act" : ""}`}
                  onClick={() => onWord(a.id, w, removed)}
                >
                  {replaced ?? w.word}
                </span>
              );
            })}
          </div>
        </div>,
      );
    });
  }

  const helper = MODES.find((m) => m.id === mode)?.helper ?? "";

  return (
    <div className="wed">
      <div className="wed-modes glass-sm">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`wed-mode${mode === m.id ? " on" : ""}`}
            onClick={() => {
              setMode(m.id);
              setEditing(null);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="wed-helper">{helper}</div>
      {rows.length === 0 ? (
        <div className="empty">Add clips in Auto cut to start editing words.</div>
      ) : (
        <div className="wed-rows stagger">{rows}</div>
      )}
    </div>
  );
}

/** The tiny inline word editor. Enter commits, Escape or blur cancels. */
function WordInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="wed-input"
      value={value}
      autoFocus
      size={Math.max(3, value.length)}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={onCancel}
    />
  );
}
