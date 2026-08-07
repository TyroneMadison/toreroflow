import { useState } from "react";
import { useAppState } from "../state/AppState";

type EditArea = "studio" | "analyze" | "ideas";

const AREAS: { id: EditArea; label: string; title: string; sub: string }[] = [
  {
    id: "studio",
    label: "Studio",
    title: "Studio",
    sub: "Drop raw footage, tighten the cut, style the captions, and export a vertical video straight into Upload and Schedule.",
  },
  {
    id: "analyze",
    label: "Analyze",
    title: "Analyze",
    sub: "Drop any video for a second-by-second AI breakdown: hook, retention and payoff scores, what worked, and a four-step action plan.",
  },
  {
    id: "ideas",
    label: "Ideas",
    title: "Ideas",
    sub: "The brand's niche profile, generated formats and hooks, a brainstorm chat, and an ideas list that tracks each one from idea to posted.",
  },
];

export default function EditScreen() {
  const { selectedClient } = useAppState();
  const [area, setArea] = useState<EditArea>("studio");

  if (!selectedClient) {
    return (
      <section className="screen active" data-screen="edit">
        <div className="topbar">
          <div className="h">
            <h2>Edit</h2>
            <p>Pick a brand from the sidebar to edit videos for it.</p>
          </div>
        </div>
      </section>
    );
  }

  const active = AREAS.find((a) => a.id === area)!;

  return (
    <section className="screen active" data-screen="edit">
      <div className="topbar">
        <div className="h">
          <h2>Edit</h2>
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
        <div className="card glass" key={active.id}>
          <h3>{active.title}</h3>
          <div className="sub">{active.sub}</div>
        </div>
      </div>
    </section>
  );
}
