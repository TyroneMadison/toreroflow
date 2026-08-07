import { useEffect, useRef, useState } from "react";
import Modal from "../../modals/Modal";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import "./BrainstormModal.css";

/**
 * A chat with the brand's content strategist, and the one thing it is really
 * for: banking the hooks that come out of it.
 *
 * The thread lives in this component and nowhere else. The server is stateless,
 * so every turn carries the conversation back with it, and closing the modal
 * ends the conversation for good. That is deliberate, not a gap: a brainstorm
 * is a sitting, and what is worth keeping out of one is an idea on the board,
 * which is what the save buttons are for.
 */

/** Openers for someone who opened this and does not know where to start. */
const OPENERS = [
  "What should this brand post this week?",
  "Give me three hooks for a talking head video.",
  "What is this niche tired of seeing?",
];

interface Turn {
  role: "user" | "assistant";
  content: string;
}

/**
 * The hook inside a line, when the whole line is one, otherwise null.
 *
 * The strategist is told to write a sayable hook in quotes on its own line, so
 * a line that is nothing but a quoted string is an idea waiting to be saved. A
 * sentence that merely quotes something part way through is not, which is why
 * the quotes have to bookend the whole line and there can be none left inside
 * it. Quotes arrive straight or curly depending on the sentence they came out
 * of, and the ideas route will not take more than 500 characters.
 */
function hookOf(raw: string): string | null {
  // A bullet marker or a full stop outside the closing quote still leaves a
  // line whose entire content is the hook.
  const line = raw
    .trim()
    .replace(/^[-*•]\s*/, "")
    .replace(/[.,;:]+$/, "");
  const inner = /^["“](.+)["”]$/.exec(line)?.[1]?.trim();
  if (!inner || inner.length > 500) return null;
  return /["“”]/.test(inner) ? null : inner;
}

export default function BrainstormModal({
  clientId,
  onClose,
}: {
  clientId: string;
  onClose(): void;
}) {
  const toast = useToast();
  const [thread, setThread] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Hooks already on the board, so a second press cannot double-save one.
  const [saved, setSaved] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);

  // Whatever just arrived is the part worth reading.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, busy]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    // The server carries the last twelve turns and drops the rest, so sending
    // an afternoon of chat back would only be paying to have it thrown away.
    const history = thread.slice(-12);
    setThread((t) => [...t, { role: "user", content: message }]);
    setDraft("");
    setBusy(true);
    try {
      const got = await api.post<{ reply: string }>(`/clients/${clientId}/brainstorm`, {
        message,
        history,
      });
      const reply = got.reply.trim();
      if (!reply) throw new Error("the strategist sent nothing back");
      setThread((t) => [...t, { role: "assistant", content: reply }]);
    } catch (err) {
      // The turn never happened, so it comes back off the thread and the words
      // go back in the box rather than being retyped.
      setThread((t) => t.slice(0, -1));
      setDraft(message);
      toast.fail("Could not answer that", err);
    } finally {
      setBusy(false);
    }
  };

  /** Marked saved before the request so the button cannot be pressed twice. */
  const bank = async (hook: string) => {
    setSaved((s) => [...s, hook]);
    try {
      await api.post(`/clients/${clientId}/ideas`, { text: hook, hook, source: "brainstorm" });
      toast.success("Saved to ideas");
    } catch (err) {
      setSaved((s) => s.filter((h) => h !== hook));
      toast.fail("Could not save that idea", err);
    }
  };

  return (
    <Modal maxWidth={640} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Brainstorm</h3>
          <p>The strategist for this brand, with its knowledge base already read.</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <div className="bsthread" ref={scroller} aria-live="polite">
          {thread.length === 0 && (
            <div className="bsempty">
              <p>
                Ask about angles, formats, or what to film this week. Any hook it writes in
                quotes gets a save button, and saved hooks land in this brand's ideas.
              </p>
              <div className="bsopeners">
                {OPENERS.map((o) => (
                  <button type="button" key={o} className="mini" onClick={() => void send(o)}>
                    {o}
                  </button>
                ))}
              </div>
            </div>
          )}

          {thread.map((turn, i) => (
            <div className={`bsturn ${turn.role}`} key={i}>
              {turn.role === "user" ? (
                <p>{turn.content}</p>
              ) : (
                turn.content
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .map((line, j) => {
                    const hook = hookOf(line);
                    if (!hook) return <p key={j}>{line}</p>;
                    return (
                      <div className="bshook" key={j}>
                        <span>{hook}</span>
                        <button
                          className="cbtn"
                          disabled={saved.includes(hook)}
                          onClick={() => void bank(hook)}
                        >
                          {saved.includes(hook) ? "Added" : "+ Ideas"}
                        </button>
                      </div>
                    );
                  })
              )}
            </div>
          ))}

          {busy && (
            <div className="bsturn assistant">
              <div className="bsdots" role="status" aria-label="Thinking">
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
        </div>

        <div className="bscompose">
          <div className="cfield">
            <label className="lab" htmlFor="bsmsg">
              Your message
            </label>
            <textarea
              id="bsmsg"
              className="field-in bsbox"
              rows={3}
              maxLength={2000}
              autoFocus
              placeholder="Ask about angles, hooks, or what to film next"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
            />
          </div>
          <button
            className="btn bssend"
            disabled={busy || draft.trim().length === 0}
            onClick={() => void send(draft)}
          >
            {busy ? "Thinking..." : "Send"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
