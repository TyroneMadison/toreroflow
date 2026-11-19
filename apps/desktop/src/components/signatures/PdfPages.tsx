import { useEffect, useState, type ReactNode } from "react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
// Vite resolves this to a hashed asset URL at build time, which is how the
// worker gets loaded inside Tauri's asset protocol as well as in the browser.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Every page of a PDF, drawn to canvases, with a positioned layer over each one
 * for the field boxes.
 *
 * The canvases are rendered at a fixed pixel width and then scaled by CSS, so
 * the overlay can position boxes in percentages and nothing has to be measured
 * or re-measured when the window changes size. `onPagePointer` reports a click
 * as a fraction of the page, which is the only unit the rest of this feature
 * knows about.
 */

/** Canvas backing-store width. Enough to read 8pt type without being heavy. */
const RENDER_WIDTH = 1100;

type Page = { canvas: HTMLCanvasElement; width: number; height: number };

export default function PdfPages({
  bytes,
  overlay,
  onPagePointer,
  onError,
}: {
  /** The PDF, as read from the file input. */
  bytes: ArrayBuffer;
  /** The field boxes for a page, positioned by the caller in percentages. */
  overlay?: (page: number) => ReactNode;
  /** A click on a page, as fractions of the page, y from the top. */
  onPagePointer?: (page: number, xFrac: number, yFrac: number) => void;
  onError?: (message: string) => void;
}) {
  const [pages, setPages] = useState<Page[]>([]);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    // pdf.js transfers the buffer it is given, which would empty the copy the
    // caller still holds for the upload. Hand it a slice.
    const task = getDocument({ data: bytes.slice(0) });

    void (async () => {
      try {
        const doc = await task.promise;
        const out: Page[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const pdfPage = await doc.getPage(n);
          if (cancelled) return;
          const base = pdfPage.getViewport({ scale: 1 });
          const viewport = pdfPage.getViewport({ scale: RENDER_WIDTH / base.width });
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          await pdfPage.render({ canvas, viewport }).promise;
          if (cancelled) return;
          out.push({ canvas, width: viewport.width, height: viewport.height });
          // Publish as each page finishes: a long contract shows its first page
          // immediately instead of a blank panel until the last one is done.
          setPages([...out]);
        }
      } catch (err) {
        if (!cancelled) onError?.(err instanceof Error ? err.message : "That PDF could not be opened.");
      }
    })();

    return () => {
      cancelled = true;
      void task.destroy();
    };
    // onError is read once per load; re-running on a new identity would reload
    // the whole document for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  if (!pages.length) return <div className="sg-loading">Opening the document…</div>;

  return (
    <div className="sg-pages">
      {pages.map((p, i) => (
        <div
          key={i}
          className="sg-page"
          data-page={i}
          style={{ aspectRatio: `${p.width} / ${p.height}` }}
          onPointerDown={(e) => {
            // Only a click on the page itself, never one that started on a box.
            if (!onPagePointer || e.target !== e.currentTarget) return;
            const r = e.currentTarget.getBoundingClientRect();
            onPagePointer(i, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
          }}
        >
          {/* The canvas is a real DOM node from pdf.js, so it is adopted rather
              than described: React owns the slot, pdf.js owns the pixels. */}
          <div
            className="sg-canvas-slot"
            aria-hidden="true"
            ref={(slot) => {
              if (slot && slot.firstChild !== p.canvas) slot.replaceChildren(p.canvas);
            }}
          />
          <span className="sg-pageno">{i + 1}</span>
          {overlay?.(i)}
        </div>
      ))}
    </div>
  );
}
