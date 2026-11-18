import { useState } from "react";
import { useAppState } from "../state/AppState";
import { setQuery, useRoute } from "../lib/routes";
import { useIsPhone } from "../lib/phone";
import StudioHome from "../editor/StudioHome";
import StudioEditor from "../editor/StudioEditor";
import AnalyzeHome from "../editor/analyze/AnalyzeHome";
import AnalysisDetail from "../editor/analyze/AnalysisDetail";
import IdeasHome from "../editor/ideas/IdeasHome";
import ClipsHome from "../editor/clips/ClipsHome";
import ClipJobView from "../editor/clips/ClipJobView";
import { Empty } from "../components/states";
import { AssetsArea, BrandKitArea, RepurposeCard } from "./StudioIdeas";

type EditArea = "studio" | "clips" | "analyze" | "ideas" | "kit" | "assets";

const AREAS: { id: EditArea; label: string }[] = [
  { id: "studio", label: "Edit" },
  { id: "clips", label: "Clips" },
  { id: "analyze", label: "Analyze" },
  { id: "ideas", label: "Ideas" },
  { id: "kit", label: "Brand kit" },
  { id: "assets", label: "Assets" },
];

/** The phone head's one line under each area's title (mobile pass). Ideas brings its own masthead. */
const PHONE_SUB: Record<Exclude<EditArea, "ideas">, (brand: string) => string> = {
  studio: (b) => `Cut, score and plan videos for ${b}.`,
  clips: () => "One long video in, the best short clips out.",
  analyze: () => "Scores the words, the pace and the frames. Never claims platform numbers.",
  kit: (b) => `Fonts, colors, logo and voice for ${b}.`,
  assets: () => "Logos, stills, templates and audio the editor can use.",
};

export default function EditScreen() {
  const { selectedClient } = useAppState();
  // The open area lives in ?area so the phone tab bar can link straight to Ideas.
  const routeArea = useRoute().area;
  // "super" is Ideas scrolled to Super generate (the phone Create sheet).
  const area: EditArea = routeArea === "super" ? "ideas" : AREAS.find((a) => a.id === routeArea)?.id ?? "studio";
  const setArea = (a: EditArea) => setQuery({ area: a === "studio" ? null : a });
  const isPhone = useIsPhone();
  // The Studio project being edited. The screen remounts per brand (keyed in
  // App.tsx), so a project never survives a brand switch.
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  // The analysis being read. Same rule: brand-keyed, so it never survives a
  // brand switch.
  const [openAnalysisId, setOpenAnalysisId] = useState<string | null>(null);
  // The clip job being read. Brand-keyed like the two above.
  const [openClipJobId, setOpenClipJobId] = useState<string | null>(null);
  const deeper =
    (area === "studio" && !!openProjectId) || (area === "clips" && !!openClipJobId) || (area === "analyze" && !!openAnalysisId);

  if (!selectedClient) {
    return (
      <section className="screen active" data-screen="edit" data-state="empty">
        <div className="topbar">
          <div className="h">
            <h2>Studio</h2>
          </div>
        </div>
        <div className="stage">
          <Empty
            screen="edit"
            title="No brand selected"
            hint="Pick a brand in the dock to edit videos for it."
          />
        </div>
      </section>
    );
  }

  return (
    <section className="screen active" data-screen="edit" data-state="ready">
      <div className="topbar">
        <div className="h">
          <h2>Studio</h2>
          <p>Cut, score, and plan videos for {selectedClient.name}.</p>
        </div>
      </div>
      <div className="stage">
        {/* Phones: one head (eyebrow, the area's title, one line) and the area
            chips, both gone on a deeper page (editor, clip job, analysis),
            which brings its own bar. The shared page head is hidden here. */}
        {isPhone && !deeper && area !== "ideas" && (
          <header className="mb-head mb-studiohead">
            <div>
              <div className="mb-eyebrow">Studio</div>
              <h1 className="mb-h1">{AREAS.find((a) => a.id === area)!.label}</h1>
              <p className="mb-sub">{PHONE_SUB[area](selectedClient.name)}</p>
            </div>
          </header>
        )}
        {/* Ideas has its own tab in the phone tab bar, so no area chips there either. */}
        {!(isPhone && (deeper || area === "ideas")) && (
        <div className="seg areas" style={{ display: "inline-flex", marginBottom: 16 }}>
          {AREAS.map((a) => (
            <span
              key={a.id}
              className={area === a.id ? "on" : ""}
              onClick={() => setArea(a.id)}
            >
              {a.label}
            </span>
          ))}
        </div>
        )}
        {area === "studio" ? (
          openProjectId ? (
            <StudioEditor
              projectId={openProjectId}
              onClose={() => setOpenProjectId(null)}
            />
          ) : (
            <>
              <RepurposeCard brandId={selectedClient.id} />
              <StudioHome clientId={selectedClient.id} onOpen={setOpenProjectId} />
            </>
          )
        ) : area === "clips" ? (
          openClipJobId ? (
            <ClipJobView
              jobId={openClipJobId}
              onBack={() => setOpenClipJobId(null)}
              onOpenProject={(id) => {
                setOpenProjectId(id);
                setArea("studio");
              }}
            />
          ) : (
            <ClipsHome clientId={selectedClient.id} onOpen={setOpenClipJobId} />
          )
        ) : area === "kit" ? (
          <BrandKitArea brandId={selectedClient.id} brandName={selectedClient.name} />
        ) : area === "assets" ? (
          <AssetsArea />
        ) : area === "analyze" ? (
          openAnalysisId ? (
            <AnalysisDetail
              analysisId={openAnalysisId}
              onBack={() => setOpenAnalysisId(null)}
            />
          ) : (
            <AnalyzeHome clientId={selectedClient.id} onOpen={setOpenAnalysisId} />
          )
        ) : (
          // Phones reach Ideas from its own tab, so no area switch rides in its masthead.
          <IdeasHome clientId={selectedClient.id} focusSuper={routeArea === "super"} />
        )}
      </div>
    </section>
  );
}
