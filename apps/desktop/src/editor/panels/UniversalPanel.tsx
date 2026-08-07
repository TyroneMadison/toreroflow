import { useState } from "react";
import {
  addCut,
  fillerCuts,
  removeCutsOverlapping,
  silenceCuts,
  type ColorAdjust,
  type CutRange,
  type EditDoc,
} from "@toreroflow/core";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { useEditor } from "../StudioEditor";
import { Chip, SliderRow, SubPills } from "./index";

const COLOR_CARDS: Array<{ key: keyof ColorAdjust; title: string; lab: string }> = [
  { key: "b", title: "Brightness", lab: "B" },
  { key: "s", title: "Saturation", lab: "SAT" },
  { key: "c", title: "Contrast", lab: "CON" },
  { key: "w", title: "Warmth", lab: "TMP" },
];

const SHORTEN_WINDOWS = [
  { label: "10-20s", minSec: 10, maxSec: 20 },
  { label: "20-30s", minSec: 20, maxSec: 30 },
  { label: "30-40s", minSec: 30, maxSec: 40 },
];

/** The panel shown with nothing selected: whole-video actions and colour. */
export default function UniversalPanel() {
  const { doc, update, assets, setStep, project } = useEditor();
  const toast = useToast();
  const [tab, setTab] = useState<"quick" | "colour">("quick");
  /** The window label the model is currently working on, null when idle. */
  const [thinking, setThinking] = useState<string | null>(null);

  const clipsProcessing = assets.some(
    (a) => a.kind === "clip" && (a.status === "uploaded" || a.status === "processing"),
  );

  // Applied through update() so one press is one undo step.
  const shorten = async (w: (typeof SHORTEN_WINDOWS)[number]) => {
    if (thinking) return;
    setThinking(w.label);
    try {
      const { cuts } = await api.post<{
        cuts: Array<{ assetId: string; start: number; end: number }>;
      }>(`/edit-projects/${project.id}/shorten`, { targetSec: w.minSec });
      if (cuts.length === 0) {
        toast.info("Nothing worth cutting was found.");
        return;
      }
      update((d) => {
        let next = d;
        for (const c of cuts) {
          const duration = assets.find((a) => a.id === c.assetId)?.durationSec ?? undefined;
          next = addCut(next, c.assetId, { start: c.start, end: c.end }, duration);
        }
        return next;
      });
      const total = Math.round(cuts.reduce((s, c) => s + (c.end - c.start), 0));
      toast.success(
        `Cut ${total}s across ${cuts.length} sentence${cuts.length === 1 ? "" : "s"}`,
      );
    } catch (e: unknown) {
      toast.fail("Could not shorten the video", e);
    } finally {
      setThinking(null);
    }
  };

  const tighten = (mode: "spaces" | "fillers") => {
    update((d) => {
      let next = d;
      for (const { assetId } of d.clips) {
        const asset = assets.find((a) => a.id === assetId);
        if (!asset?.words?.length) continue;
        const cuts =
          mode === "spaces" ? silenceCuts(asset.words) : fillerCuts(asset.words);
        for (const c of cuts) {
          next = addCut(next, assetId, c, asset.durationSec ?? undefined);
        }
      }
      return next;
    });
  };

  // Pure local math: put back the largest cuts first until at least the
  // low bound of the picked range has been restored.
  const addBack = (targetSec: number) => {
    update((d) => {
      const all: Array<{ assetId: string; cut: CutRange }> = [];
      for (const [assetId, list] of Object.entries(d.cuts)) {
        for (const cut of list) all.push({ assetId, cut });
      }
      all.sort((a, b) => b.cut.end - b.cut.start - (a.cut.end - a.cut.start));
      let restored = 0;
      let next: EditDoc = d;
      for (const { assetId, cut } of all) {
        if (restored >= targetSec) break;
        next = removeCutsOverlapping(next, assetId, cut);
        restored += cut.end - cut.start;
      }
      return next;
    });
  };

  const setColor = (key: keyof ColorAdjust, v: number) => {
    update((d) => ({ ...d, color: { ...d.color, [key]: v } }));
  };

  return (
    <div className="pnl">
      <h3>Universal adjustments</h3>
      <SubPills
        tabs={[
          { id: "quick", label: "Quick actions" },
          { id: "colour", label: "Universal colour" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "quick" && (
        <>
          <div className="pnl-cards">
            <div className="glass-sm pnl-card">
              <b>Tighten</b>
              <div className="pnl-chiprow">
                <span className="lab">Remove:</span>
                <Chip onClick={() => tighten("spaces")}>Spaces</Chip>
                <Chip onClick={() => tighten("fillers")}>Filler words</Chip>
              </div>
            </div>
            <div className="glass-sm pnl-card">
              <b>Shorten</b>
              <div className="pnl-chiprow">
                <span className="lab">Cut by:</span>
                {SHORTEN_WINDOWS.map((w) => (
                  <Chip
                    key={w.label}
                    disabled={clipsProcessing || (thinking !== null && thinking !== w.label)}
                    title={
                      clipsProcessing
                        ? "Waiting for the clips to finish processing"
                        : undefined
                    }
                    onClick={() => void shorten(w)}
                  >
                    {thinking === w.label ? (
                      <span className="pnl-thinking">Thinking...</span>
                    ) : (
                      w.label
                    )}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="glass-sm pnl-card">
              <b>Add more</b>
              <div className="pnl-chiprow">
                <span className="lab">Add by:</span>
                <Chip onClick={() => addBack(10)}>10-20s</Chip>
                <Chip onClick={() => addBack(20)}>20-30s</Chip>
                <Chip onClick={() => addBack(30)}>30-40s</Chip>
              </div>
            </div>
          </div>
          <button className="btn ghost pnl-wide" onClick={() => setStep(3)}>
            Adjust caption timing
          </button>
        </>
      )}

      {tab === "colour" && (
        <div className="pnl-cards">
          {COLOR_CARDS.map((c) => (
            <div key={c.key} className="glass-sm pnl-card">
              <b>{c.title}</b>
              <SliderRow
                label={c.lab}
                min={-100}
                max={100}
                value={doc.color[c.key]}
                def={0}
                onCommit={(v) => setColor(c.key, v)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
