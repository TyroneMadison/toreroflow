import { useState } from "react";
import WordEditor from "../WordEditor";
import Timeline from "../Timeline";
import "./EditStep.css";

const VIEWS = [
  { id: "words", label: "Word editor" },
  { id: "timeline", label: "Timeline" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

/** Step 2: Edit. A dark segmented toggle picks the Word editor or the Timeline. */
export default function EditStep() {
  const [view, setView] = useState<ViewId>("words");

  return (
    <div className="edstep">
      <div className="edstep-toggle glass-sm">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={`edstep-pill${view === v.id ? " on" : ""}`}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === "words" ? <WordEditor /> : <Timeline />}
    </div>
  );
}
