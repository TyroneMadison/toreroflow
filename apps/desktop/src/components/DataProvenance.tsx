import { useMemo, useState } from "react";
import { buildProvenance, type PlatformName } from "@toreroflow/core";
import { openExternal } from "../lib/external";

/**
 * Where these numbers came from, at the foot of every screen that shows them.
 *
 * Four things a stats surface owes whoever is reading it: which platforms the
 * figures were pulled from, when, what nobody publishes so a gap is not read as
 * a zero, and whose report this is. The wording and the rules live in
 * packages/core/src/dataProvenance.ts, because the client report page has to
 * make the same claims and the two renderers must not drift.
 *
 * The unmeasured list collapses by default. It is the longest block and the
 * least urgent: an operator who looks at this screen daily does not need to
 * re-read why TikTok has no save count, but the one time they are asked by a
 * client it has to be a click away rather than a search.
 *
 * Draws nothing at all when no platform is connected. A brand with no accounts
 * yet has no data to explain the provenance of, and an empty panel about
 * nothing is worse than blank space.
 */
export default function DataProvenance({
  platforms,
  refreshedAt,
}: {
  platforms: readonly PlatformName[];
  /** Null when nothing on screen carried a timestamp. Renders no date at all. */
  refreshedAt?: Date | null;
}) {
  const [openNotes, setOpenNotes] = useState(false);
  const p = useMemo(
    () => buildProvenance(platforms, refreshedAt ?? null),
    [platforms, refreshedAt],
  );

  if (!p.sources) return null;

  return (
    <div className="prov">
      <div className="prov-row">
        <span className="prov-live" aria-hidden="true" />
        <span className="prov-src">
          Live data from <b>{p.sources}</b>
        </span>
        {p.refreshed && <span className="prov-when">Last updated {p.refreshed}</span>}
      </div>

      {p.unmeasured.length > 0 && (
        <div className="prov-notes">
          <button
            type="button"
            className="prov-toggle"
            aria-expanded={openNotes}
            onClick={() => setOpenNotes((v) => !v)}
          >
            {openNotes ? "Hide" : "Show"} what these platforms do not report
            <span className={`prov-caret${openNotes ? " open" : ""}`} aria-hidden="true" />
          </button>
          {openNotes && (
            <ul>
              {p.unmeasured.map((note) => (
                <li key={note.text}>{note.text}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="prov-foot">
        <span className="prov-brand">
          {p.brand.name} · {p.brand.tagline}
        </span>
        {p.links.length > 0 && (
          <span className="prov-links">
            {p.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={(e) => {
                  // The webview has no browser chrome, so a plain navigation
                  // would replace the app with a web page and strand the
                  // operator with no way back.
                  e.preventDefault();
                  void openExternal(link.href);
                }}
              >
                {link.label}
              </a>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
