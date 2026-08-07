import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import Modal from "../../modals/Modal";

/**
 * The saved ideas table: every idea this brand has banked, wherever it came
 * from, with the status it is at and the script once one has been written.
 */

/**
 * The script the route writes onto the row. A beat and a shot are each a pair,
 * what it is for and what to do about it, because a bare line tells the person
 * holding the phone nothing about why they are saying it.
 */
/**
 * Whether a script is worth opening.
 *
 * A schema-valid but entirely empty script still arrives as an object, and
 * treating the object itself as proof would swap the write button for a view
 * button on a row that has nothing to view and no way back.
 */
function hasScript(s: IdeaScript | null): boolean {
  return Boolean(s && (s.hook || s.beats?.length || s.shotList?.length || s.caption));
}

interface IdeaScript {
  hook?: string;
  beats?: Array<{ label: string; line: string }>;
  shotList?: Array<{ shot: string; note: string }>;
  caption?: string;
}

interface IdeaRow {
  id: string;
  niche: string;
  formatName: string | null;
  text: string;
  hook: string | null;
  script: IdeaScript | null;
  status: string;
  source: string;
  createdAt: string;
}

const STATUSES: Array<{ id: string; label: string }> = [
  { id: "idea", label: "Idea" },
  { id: "scripting", label: "Scripting" },
  { id: "ready", label: "Ready to film" },
  { id: "posted", label: "Posted" },
  { id: "analyzed", label: "Analyzed" },
];

const SOURCES: Array<{ id: string; label: string }> = [
  { id: "brainstorm", label: "Brainstorm" },
  { id: "analysis", label: "Analysis" },
  { id: "overview", label: "Game plan" },
  { id: "custom", label: "Written by hand" },
];

/** The whole script as one block of text, for the Copy button. */
function scriptText(idea: IdeaRow): string {
  const s = idea.script ?? {};
  const parts = [idea.text];
  if (s.hook) parts.push(`Hook: ${s.hook}`);
  if (s.beats?.length) {
    parts.push(`Beats:\n${s.beats.map((b, i) => `${i + 1}. ${b.label}: ${b.line}`).join("\n")}`);
  }
  if (s.shotList?.length) {
    parts.push(`Shot list:\n${s.shotList.map((v) => `- ${v.shot}: ${v.note}`).join("\n")}`);
  }
  if (s.caption) parts.push(`Caption:\n${s.caption}`);
  return parts.join("\n\n");
}

export default function IdeaList({
  clientId,
  niche,
  reloadKey,
}: {
  clientId: string;
  /** The brand's niche, stamped on ideas written by hand here. */
  niche: string;
  /** Bumped by the parent when something outside this list saved an idea. */
  reloadKey: number;
}) {
  const toast = useToast();
  const [ideas, setIdeas] = useState<IdeaRow[] | null>(null);
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [q, setQ] = useState("");
  const [scripting, setScripting] = useState<string | null>(null);
  const [viewing, setViewing] = useState<IdeaRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ text: "", hook: "" });
  const [savingNew, setSavingNew] = useState(false);
  // Two-press delete, the same shape as the Studio project rows.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIdeas(await api.get<IdeaRow[]>(`/clients/${clientId}/ideas`));
    } catch (err) {
      toast.fail("Could not load the ideas", err);
      setIdeas([]);
    }
  }, [clientId, toast]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  /*
   * Filtered here rather than on the server: the list is capped at 200 rows,
   * and the search box promises niche and format, which the route's `q` does
   * not cover. One fetch, three filters, no refetch per keystroke.
   */
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (ideas ?? []).filter((i) => {
      if (status && i.status !== status) return false;
      if (source && i.source !== source) return false;
      if (!needle) return true;
      return [i.text, i.hook, i.niche, i.formatName]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [ideas, status, source, q]);

  const patch = async (id: string, body: Partial<IdeaRow>) => {
    // The status select is controlled, so without an immediate write React puts
    // the old value straight back into the DOM and the change reads as
    // rejected until the request lands. The catch below reloads, which rolls
    // this back if the write really did fail.
    setIdeas((cur) => (cur ? cur.map((i) => (i.id === id ? { ...i, ...body } : i)) : cur));
    try {
      const updated = await api.patch<IdeaRow>(`/ideas/${id}`, body);
      setIdeas((cur) => (cur ? cur.map((i) => (i.id === id ? updated : i)) : cur));
    } catch (err) {
      toast.fail("Could not save that change", err);
      void load();
    }
  };

  const writeScript = async (idea: IdeaRow) => {
    setScripting(idea.id);
    try {
      const updated = await api.post<IdeaRow>(`/ideas/${idea.id}/script`);
      setIdeas((cur) => (cur ? cur.map((i) => (i.id === idea.id ? updated : i)) : cur));
      setViewing(updated);
    } catch (err) {
      toast.fail("Could not write that script", err);
    } finally {
      setScripting(null);
    }
  };

  const remove = async (id: string) => {
    setConfirmId(null);
    try {
      await api.del(`/ideas/${id}`);
      setIdeas((cur) => (cur ? cur.filter((i) => i.id !== id) : cur));
    } catch (err) {
      toast.fail("Could not delete that idea", err);
    }
  };

  const addOwn = async () => {
    setSavingNew(true);
    try {
      const created = await api.post<IdeaRow>(`/clients/${clientId}/ideas`, {
        text: draft.text.trim(),
        hook: draft.hook.trim() || undefined,
        // The route caps the niche at 200; the profile's own field allows 2000.
        niche: niche.slice(0, 200),
        source: "custom",
      });
      setIdeas((cur) => (cur ? [created, ...cur] : [created]));
      setAdding(false);
      setDraft({ text: "", hook: "" });
    } catch (err) {
      toast.fail("Could not save that idea", err);
    } finally {
      setSavingNew(false);
    }
  };

  const copyScript = async (idea: IdeaRow) => {
    try {
      await navigator.clipboard.writeText(scriptText(idea));
      toast.success("Script copied");
    } catch {
      toast.error("Could not reach the clipboard. Select the text and press Ctrl+C.");
    }
  };

  return (
    <div className="idealist">
      <div className="rowhead">
        <div>
          <h3>Saved ideas</h3>
          <div className="sub">Every idea for this brand, from first line to posted.</div>
        </div>
        <button className="btn ghost" onClick={() => setAdding(true)}>
          + Add your own idea
        </button>
      </div>

      <div className="ideafilters">
        <select className="field-in" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option value={s.id} key={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select className="field-in" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Any source</option>
          {SOURCES.map((s) => (
            <option value={s.id} key={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          className="field-in ideasearch"
          value={q}
          placeholder="Search ideas by word, niche or format"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {ideas === null ? (
        <div className="stagger">
          <div className="skel ideaskel" />
          <div className="skel ideaskel" />
          <div className="skel ideaskel" />
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          {ideas.length === 0
            ? "No ideas yet. Generate some, or write one down."
            : "No ideas match those filters."}
        </div>
      ) : (
        <div className="stagger">
          {shown.map((i) => (
            <div className="card glass idearow" key={i.id}>
              <div className="ideal">
                <div className="ideafmt">
                  <svg viewBox="0 0 24 24" className="ideaicon">
                    <use href="#i-bolt" />
                  </svg>
                  {i.formatName ?? "Written by hand"}
                </div>
                <b className="ideatext">{i.text}</b>
                <div className="sub">
                  Niche: {i.niche || "not set"} &nbsp; Added:{" "}
                  {new Date(i.createdAt).toLocaleDateString()}
                </div>
                {i.hook && <div className="ideahook">{`"${i.hook}"`}</div>}
              </div>
              <div className="idear">
                <select
                  className="field-in ideastatus"
                  value={i.status}
                  onChange={(e) => void patch(i.id, { status: e.target.value })}
                >
                  {STATUSES.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  className="cbtn"
                  disabled={scripting === i.id}
                  onClick={() => (hasScript(i.script) ? setViewing(i) : void writeScript(i))}
                >
                  {hasScript(i.script)
                    ? "View script"
                    : scripting === i.id
                      ? "Writing..."
                      : "Write the script"}
                </button>
                <button
                  className="dangerbtn"
                  title={confirmId === i.id ? "Click again to delete" : "Delete this idea"}
                  onClick={() => {
                    if (confirmId === i.id) void remove(i.id);
                    else {
                      setConfirmId(i.id);
                      setTimeout(() => setConfirmId((c) => (c === i.id ? null : c)), 3000);
                    }
                  }}
                >
                  {confirmId === i.id ? "Sure?" : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <Modal maxWidth={480} onClose={() => setAdding(false)}>
          <div className="rowhead">
            <h3>Add your own idea</h3>
            <button className="iconbtn" title="Close" onClick={() => setAdding(false)}>
              <svg viewBox="0 0 24 24" className="ideaicon">
                <use href="#i-x" />
              </svg>
            </button>
          </div>
          <div className="cfield">
            <span className="lab">The idea</span>
            <textarea
              className="field-in ideaarea"
              maxLength={500}
              value={draft.text}
              placeholder="One line saying what the video is."
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </div>
          <div className="cfield nichegap">
            <span className="lab">Hook, if you have one</span>
            <input
              className="field-in"
              maxLength={500}
              value={draft.hook}
              placeholder="The first line you would say out loud."
              onChange={(e) => setDraft({ ...draft, hook: e.target.value })}
            />
          </div>
          <div className="nicheactions">
            <button
              className="btn"
              disabled={savingNew || !draft.text.trim()}
              onClick={() => void addOwn()}
            >
              {savingNew ? "Saving..." : "Save idea"}
            </button>
            <button className="btn ghost" disabled={savingNew} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {viewing && (
        <Modal maxWidth={620} onClose={() => setViewing(null)}>
          <div className="rowhead">
            <div>
              <h3>Script</h3>
              <div className="sub">{viewing.text}</div>
            </div>
            <button className="iconbtn" title="Close" onClick={() => setViewing(null)}>
              <svg viewBox="0 0 24 24" className="ideaicon">
                <use href="#i-x" />
              </svg>
            </button>
          </div>
          {viewing.script?.hook && (
            <div className="scriptsec">
              <span className="lab">Hook</span>
              <p>{viewing.script.hook}</p>
            </div>
          )}
          {viewing.script?.beats?.length ? (
            <div className="scriptsec">
              <span className="lab">Beats</span>
              <ol>
                {viewing.script.beats.map((b, n) => (
                  <li key={n}>
                    <b>{b.label}</b> {b.line}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {viewing.script?.shotList?.length ? (
            <div className="scriptsec">
              <span className="lab">Shot list</span>
              <ul>
                {viewing.script.shotList.map((s, n) => (
                  <li key={n}>
                    <b>{s.shot}</b> {s.note}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {viewing.script?.caption && (
            <div className="scriptsec">
              <span className="lab">Caption</span>
              <p>{viewing.script.caption}</p>
            </div>
          )}
          <div className="nicheactions">
            <button className="btn" onClick={() => void copyScript(viewing)}>
              Copy
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
