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
import { useEditor } from "../StudioEditor";
import { Chip, SliderRow, SubPills } from "./index";

const COLOR_CARDS: Array<{ key: keyof ColorAdjust; title: string; lab: string }> = [
  { key: "b", title: "Brightness", lab: "B" },
  { key: "s", title: "Saturation", lab: "SAT" },
  { key: "c", title: "Contrast", lab: "CON" },
  { key: "w", title: "Warmth", lab: "TMP" },
];

/** The panel shown with nothing selected: whole-video actions and colour. */
export default function UniversalPanel() {
  const { doc, update, assets, setStep } = useEditor();
  const [tab, setTab] = useState<"quick" | "colour">("quick");

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
                {["10-20s", "20-30s", "30-40s"].map((r) => (
                  <Chip
                    key={r}
                    disabled
                    title="AI shorten lands with the caption milestone"
                  >
                    {r}
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
