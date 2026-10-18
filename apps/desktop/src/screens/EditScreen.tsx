import { useState } from "react";
import { useAppState } from "../state/AppState";
import { setQuery, useRoute } from "../lib/routes";
import StudioHome from "../editor/StudioHome";
import StudioEditor from "../editor/StudioEditor";
import AnalyzeHome from "../editor/analyze/AnalyzeHome";
import AnalysisDetail from "../editor/analyze/AnalysisDetail";
import IdeasHome from "../editor/ideas/IdeasHome";
import { Empty } from "../components/states";

type EditArea = "studio" | "analyze" | "ideas";

const AREAS: { id: EditArea; label: string }[] = [
  { id: "studio", label: "Edit" },
  { id: "analyze", label: "Analyze" },
  { id: "ideas", label: "Ideas" },
];

export default function EditScreen() {
  const { selectedClient } = useAppState();
  // The open area lives in ?area so the phone tab bar can link straight to Ideas.
  const routeArea = useRoute().area;
  // "super" is Ideas scrolled to Super generate (the phone Create sheet).
  const area: EditArea = routeArea === "super" ? "ideas" : AREAS.find((a) => a.id === routeArea)?.id ?? "studio";
  const setArea = (a: EditArea) => setQuery({ area: a === "studio" ? null : a });
  // The Studio project being edited. The screen remounts per brand (keyed in
  // App.tsx), so a project never survives a brand switch.
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  // The analysis being read. Same rule: brand-keyed, so it never survives a
  // brand switch.
  const [openAnalysisId, setOpenAnalysisId] = useState<string | null>(null);

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
        <div className="seg" style={{ display: "inline-flex", marginBottom: 16 }}>
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
        {area === "studio" ? (
          openProjectId ? (
            <StudioEditor
              projectId={openProjectId}
              onClose={() => setOpenProjectId(null)}
            />
          ) : (
            <StudioHome clientId={selectedClient.id} onOpen={setOpenProjectId} />
          )
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
          <IdeasHome clientId={selectedClient.id} focusSuper={routeArea === "super"} />
        )}
      </div>
    </section>
  );
}
