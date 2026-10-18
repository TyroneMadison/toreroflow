import { useEffect, useRef, useState } from "react";
import { VIDEO_FORMATS } from "@toreroflow/core";
import { Icon } from "./coralBits";

const FUNNEL = ["All stages", "Top of funnel", "Middle of funnel", "Bottom of funnel"];
const SOURCES = ["All sources", "Our posts", "Inspiration", "Web trending"];

function Chips({ items, on, set }: { items: readonly string[]; on: string; set: (v: string) => void }) {
  return (
    <div className="co-chips">
      {items.map((x) => (
        <button type="button" key={x} className={`co-chip${x === on ? " on" : ""}`} aria-pressed={x === on} onClick={() => set(x)}>{x}</button>
      ))}
    </div>
  );
}

/**
 * Hook library. There is no hook store yet (planned for 0.3.34, once post
 * performance is linked), so this is the search and filters over an honest
 * empty state: no made-up hooks.
 */
export default function HookLibrary() {
  const [q, setQ] = useState("");
  const [format, setFormat] = useState("All formats");
  const [stage, setStage] = useState(FUNNEL[0]!);
  const [source, setSource] = useState(SOURCES[0]!);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="co-hooks">
      <label className="co-search">
        <Icon n="search" s={20} />
        <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search hooks, try “fees” or “weekend”" aria-label="Search hooks" />
        <kbd>/</kbd>
      </label>
      <div className="co-filt">
        <span className="co-lab">Format</span><Chips items={["All formats", ...VIDEO_FORMATS]} on={format} set={setFormat} />
        <span className="co-lab">Funnel</span><Chips items={FUNNEL} on={stage} set={setStage} />
        <span className="co-lab">Source</span><Chips items={SOURCES} on={source} set={setSource} />
      </div>
      <div className="co-empty big">
        <span className="co-q" aria-hidden="true">&#8220;</span>
        <h3 className="co-d">No hooks in the library yet.</h3>
        <p>
          Hooks will appear here once post performance is linked: the opening lines of your own best posts, lines from the
          creators you follow, and what is trending on the web. Each one will show where it came from and how it did.
        </p>
        <p className="co-muted">Until then, every saved idea keeps its own Say this · Hook: line in Saved ideas.</p>
      </div>
    </div>
  );
}
