import { Suspense, lazy, useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { SignatureFieldType } from "@toreroflow/contracts";
import Modal from "../../modals/Modal";

/**
 * pdf.js is about a megabyte, and it is needed only once this modal is open.
 * Imported statically it rode in the entry chunk, so every screen in the app
 * paid for it at startup to show a card with three numbers on it.
 */
const PdfPages = lazy(() => import("./PdfPages"));
import { useToast } from "../Toasts";
import { api, type SignatureRequest } from "../../lib/api";
import {
  boxStyle,
  dropBox,
  moveBox,
  resizeBox,
  sendBlockers,
  type FieldDraft,
  type SignerDraft,
} from "../../lib/signatures";
import { useAppState } from "../../state/AppState";
import "./signatures.css";

/**
 * Upload a contract, say who signs it, drag their boxes onto the pages, send.
 *
 * The draft lives here and goes to the server in one PATCH, which replaces the
 * whole set. That is deliberate: deleting a signer has to take their fields
 * with them, and reconciling two lists across a network is how a field ends up
 * assigned to somebody who is no longer on the document.
 */

const FIELD_TYPES: { type: SignatureFieldType; label: string; hint: string }[] = [
  { type: "signature", label: "Signature", hint: "Drawn or typed" },
  { type: "initials", label: "Initials", hint: "For initialling a clause" },
  { type: "date", label: "Date signed", hint: "Filled in on signing" },
  { type: "text", label: "Text", hint: "A name, title, address" },
  { type: "checkbox", label: "Checkbox", hint: "Agree, opt in" },
];

/** Colour per signer, so whose box is whose is readable at a glance. */
const SIGNER_COLORS = ["#7b2d8e", "#1f6feb", "#0f8f6a", "#b4530a", "#9a1750", "#4a5568"];
export const signerColor = (i: number) => SIGNER_COLORS[i % SIGNER_COLORS.length]!;

let keySeq = 0;

export default function SignatureBuilder({ onClose, onSent }: { onClose(): void; onSent(r: SignatureRequest): void }) {
  const toast = useToast();
  const { clients } = useAppState();

  const [file, setFile] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const [uploaded, setUploaded] = useState<SignatureRequest | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [clientId, setClientId] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [signers, setSigners] = useState<SignerDraft[]>([{ email: "", name: "", order: 1 }]);
  const [fields, setFields] = useState<FieldDraft[]>([]);
  const [activeSigner, setActiveSigner] = useState(0);
  const [tool, setTool] = useState<SignatureFieldType>("signature");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"upload" | "send" | null>(null);

  const pageCount = uploaded?.pageCount ?? 0;
  const blockers = useMemo(
    () => sendBlockers(title, signers, fields, pageCount),
    [title, signers, fields, pageCount],
  );

  /* ---- upload ---- */
  const pick = useCallback(
    async (f: File) => {
      if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
        toast.fail("That has to be a PDF", new Error("Only PDF documents can be signed."));
        return;
      }
      setBusy("upload");
      try {
        const bytes = await f.arrayBuffer();
        const form = new FormData();
        form.append("file", f, f.name);
        const created = await api.postForm<SignatureRequest>("/signature-requests", form);
        setUploaded(created);
        setTitle(created.title);
        setFile({ name: f.name, bytes });
      } catch (err) {
        toast.fail("Could not upload the document", err);
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  /* ---- placing boxes ---- */
  const addField = (page: number, xFrac: number, yFrac: number) => {
    if (!signers.length) return;
    // PdfPages already reports the click as fractions, so the "rendered size"
    // dropBox divides by is 1: it centres and clamps, and converts nothing.
    const box = dropBox(tool, page, xFrac, yFrac, { width: 1, height: 1 });
    const key = `f${++keySeq}`;
    setFields((prev) => [...prev, { ...box, key, signerIndex: activeSigner, type: tool, required: true }]);
    setSelected(key);
  };

  // Drag state in a ref: a pointer move must not wait on a render, and reading
  // `fields` from the render closure is how a fast drag loses its first moves.
  const drag = useRef<{ key: string; mode: "move" | "resize"; x: number; y: number; rect: DOMRect } | null>(null);

  const onBoxDown = (e: ReactPointerEvent<HTMLElement>, key: string, mode: "move" | "resize") => {
    e.stopPropagation();
    const page = (e.currentTarget as HTMLElement).closest(".sg-page");
    if (!page) return;
    drag.current = { key, mode, x: e.clientX, y: e.clientY, rect: page.getBoundingClientRect() };
    setSelected(key);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onBoxMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    const rendered = { width: d.rect.width, height: d.rect.height };
    setFields((prev) =>
      prev.map((f) =>
        f.key !== d.key ? f : { ...f, ...(d.mode === "move" ? moveBox(f, dx, dy, rendered) : resizeBox(f, dx, dy, rendered)) },
      ),
    );
  };

  const onBoxUp = () => {
    drag.current = null;
  };

  /* ---- signers ---- */
  const setSigner = (i: number, patch: Partial<SignerDraft>) =>
    setSigners((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const removeSigner = (i: number) => {
    setSigners((prev) => prev.filter((_, j) => j !== i));
    // Their boxes go with them, and everyone after them shifts down one.
    setFields((prev) =>
      prev.filter((f) => f.signerIndex !== i).map((f) => (f.signerIndex > i ? { ...f, signerIndex: f.signerIndex - 1 } : f)),
    );
    setActiveSigner((a) => (a >= i && a > 0 ? a - 1 : a));
  };

  /* ---- send ---- */
  const send = async () => {
    if (!uploaded || blockers.length) return;
    setBusy("send");
    try {
      await api.patch<SignatureRequest>(`/signature-requests/${uploaded.id}`, {
        title: title.trim(),
        message: message.trim(),
        clientId: clientId || null,
        expiresInDays,
        signers: signers.map((s) => ({ email: s.email.trim(), name: s.name.trim(), order: s.order })),
        fields: fields.map((f) => ({
          signerIndex: f.signerIndex,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required,
        })),
      });
      const sent = await api.post<SignatureRequest>(`/signature-requests/${uploaded.id}/send`);
      toast.success(
        sent.emailed === false
          ? "Ready to sign. Email is off on this server, so copy the signing link and send it yourself."
          : `Sent to ${signers.length === 1 ? signers[0]!.email.trim() : `${signers.length} people`}`,
      );
      onSent(sent);
      onClose();
    } catch (err) {
      toast.fail("Could not send the document", err);
    } finally {
      setBusy(null);
    }
  };

  /* ---- the picker, before a file is chosen ---- */
  if (!uploaded || !file) {
    return (
      <Modal maxWidth={520} onClose={onClose} label="Send a document for signature" testId="signature-builder">
        <div className="modal-head">
          <div>
            <h3>Send for signature</h3>
            <p>Upload the contract. You place the signature boxes next.</p>
          </div>
          <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
            <svg>
              <use href="#i-x" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <label
            className="sg-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) void pick(f);
            }}
          >
            <input
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pick(f);
              }}
              data-testid="signature-builder.file"
            />
            <svg aria-hidden="true">
              <use href="#i-upload" />
            </svg>
            <b>{busy === "upload" ? "Reading the document…" : "Choose a PDF, or drop one here"}</b>
            <small>Up to 25 MB. The original is never altered; signatures go onto a copy.</small>
          </label>
        </div>
      </Modal>
    );
  }

  /* ---- the builder ---- */
  const current = fields.find((f) => f.key === selected);

  return (
    <Modal maxWidth={1180} onClose={onClose} label={`Place fields on ${title}`} testId="signature-builder">
      <div className="modal-head">
        <div>
          <h3>Place the fields</h3>
          <p>
            Pick a signer, pick a field, then click the page to drop it. Drag to move, drag the corner to
            resize.
          </p>
        </div>
        <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </button>
      </div>

      <div className="modal-body sg-build">
        <div className="sg-doc">
          <Suspense fallback={<div className="sg-loading">Opening the document…</div>}>
          <PdfPages
            bytes={file.bytes}
            onPagePointer={addField}
            onError={(m) => toast.fail("Could not show the document", new Error(m))}
            overlay={(page) => (
              <>
                {fields
                  .filter((f) => f.page === page)
                  .map((f) => (
                    <div
                      key={f.key}
                      className={`sg-box${f.key === selected ? " on" : ""}`}
                      style={{ ...boxStyle(f), borderColor: signerColor(f.signerIndex), color: signerColor(f.signerIndex) }}
                      data-testid={`signature-builder.box-${f.key}`}
                      onPointerDown={(e) => onBoxDown(e, f.key, "move")}
                      onPointerMove={onBoxMove}
                      onPointerUp={onBoxUp}
                      onPointerCancel={onBoxUp}
                    >
                      <span className="sg-box-tag">
                        {FIELD_TYPES.find((t) => t.type === f.type)?.label}
                        {!f.required && " (optional)"}
                      </span>
                      <button
                        type="button"
                        className="sg-box-x"
                        aria-label="Remove this field"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          setFields((prev) => prev.filter((x) => x.key !== f.key));
                          setSelected(null);
                        }}
                      >
                        ×
                      </button>
                      <span
                        className="sg-box-grip"
                        aria-hidden="true"
                        onPointerDown={(e) => onBoxDown(e, f.key, "resize")}
                        onPointerMove={onBoxMove}
                        onPointerUp={onBoxUp}
                        onPointerCancel={onBoxUp}
                      />
                    </div>
                  ))}
              </>
            )}
          />
          </Suspense>
        </div>

        <aside className="sg-side">
          <div className="sg-field">
            <label htmlFor="sg-title">Title</label>
            <input id="sg-title" className="mb-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </div>

          <div className="sg-field">
            <label htmlFor="sg-msg">Message to the signers</label>
            <textarea
              id="sg-msg"
              className="mb-input"
              rows={2}
              value={message}
              maxLength={2000}
              placeholder="Optional. Goes in the email with their link."
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          <div className="tf-lbl">Signers</div>
          <div className="sg-signers">
            {signers.map((s, i) => (
              <div key={i} className={`sg-signer${i === activeSigner ? " on" : ""}`} onClick={() => setActiveSigner(i)}>
                <span className="sg-dot" style={{ background: signerColor(i) }} aria-hidden="true" />
                <div className="sg-signer-in">
                  <input
                    className="mb-input"
                    placeholder="name@example.com"
                    type="email"
                    value={s.email}
                    onChange={(e) => setSigner(i, { email: e.target.value })}
                    data-testid={`signature-builder.email-${i}`}
                  />
                  <input
                    className="mb-input"
                    placeholder="Name (optional)"
                    value={s.name}
                    onChange={(e) => setSigner(i, { name: e.target.value })}
                  />
                </div>
                <label className="sg-order" title="Signers with the same number are asked together">
                  #
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={s.order}
                    onChange={(e) => setSigner(i, { order: Math.max(1, Number(e.target.value) || 1) })}
                  />
                </label>
                <span className="sg-count">{fields.filter((f) => f.signerIndex === i).length}</span>
                {signers.length > 1 && (
                  <button type="button" className="sg-box-x" aria-label={`Remove signer ${i + 1}`} onClick={() => removeSigner(i)}>
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="tf-btn"
              onClick={() => setSigners((prev) => [...prev, { email: "", name: "", order: prev.length + 1 }])}
              data-testid="signature-builder.add-signer"
            >
              + Add a signer
            </button>
          </div>

          <div className="tf-lbl">Field to place</div>
          <div className="sg-tools">
            {FIELD_TYPES.map((t) => (
              <button
                key={t.type}
                type="button"
                className={`sg-tool${t.type === tool ? " on" : ""}`}
                title={t.hint}
                onClick={() => setTool(t.type)}
                data-testid={`signature-builder.tool-${t.type}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {current && (
            <label className="sg-req">
              <input
                type="checkbox"
                checked={current.required}
                onChange={(e) =>
                  setFields((prev) => prev.map((f) => (f.key === current.key ? { ...f, required: e.target.checked } : f)))
                }
              />
              This field is required
            </label>
          )}

          <div className="sg-row2">
            <div className="sg-field">
              <label htmlFor="sg-client">Brand</label>
              <select id="sg-client" className="mb-input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Not tied to a brand</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="sg-field">
              <label htmlFor="sg-exp">Expires in</label>
              <select
                id="sg-exp"
                className="mb-input"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
              >
                {[7, 14, 30, 60, 90].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </div>
          </div>

          {blockers.length > 0 && (
            <ul className="sg-blockers" data-testid="signature-builder.blockers">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <div className="modal-foot">
        <span className="sg-foot-note">
          {fields.length} field{fields.length === 1 ? "" : "s"} on {pageCount} page{pageCount === 1 ? "" : "s"}
        </span>
        <button type="button" className="mb-btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="mb-btn pri"
          disabled={busy !== null || blockers.length > 0}
          onClick={() => void send()}
          data-testid="signature-builder.send"
        >
          {busy === "send" ? "Sending…" : "Send for signature"}
        </button>
      </div>
    </Modal>
  );
}
