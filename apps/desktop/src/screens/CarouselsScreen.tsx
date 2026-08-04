import { useCallback, useEffect, useState } from "react";
import { API_URL, api, getToken } from "../lib/api";
import Select from "../components/Select";
import { useToast } from "../components/Toasts";
import { useAppState } from "../state/AppState";

/**
 * Carousels, and the knowledge they are written from.
 *
 * The loop is: put what you know about a brand's niche in the knowledge base,
 * generate the words for a carousel from it, download the CSV, and let Canva's
 * bulk create turn each row into a design. The finished images come back in
 * through Upload and Schedule as a carousel.
 *
 * Deliberately not a Canva integration. A CSV can be read, corrected and
 * re-imported by hand, and the design template stays where the designer works.
 */

interface KnowledgeNote {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

interface Slide {
  headline: string;
  body: string;
}

interface Draft {
  id: string;
  topic: string;
  slides: Slide[];
  caption: string;
  hashtags: string[];
  createdAt: string;
}

export default function CarouselsScreen({ onUploadImages }: { onUploadImages(): void }) {
  const toast = useToast();
  const { selectedClient, setPendingCarouselDraft } = useAppState();
  const clientId = selectedClient?.id ?? null;

  const [notes, setNotes] = useState<KnowledgeNote[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [topic, setTopic] = useState("");
  const [slideCount, setSlideCount] = useState(7);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      const [n, d] = await Promise.all([
        api.get<KnowledgeNote[]>(`/clients/${clientId}/knowledge`),
        api.get<Draft[]>(`/clients/${clientId}/carousels`),
      ]);
      setNotes(n);
      setDrafts(d);
    } catch (err) {
      toast.fail("Could not load carousels", err);
      setNotes([]);
      setDrafts([]);
    }
  }, [clientId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const addNote = async () => {
    if (!clientId || !noteTitle.trim() || !noteBody.trim()) return;
    try {
      await api.post(`/clients/${clientId}/knowledge`, {
        title: noteTitle.trim(),
        body: noteBody.trim(),
      });
      setNoteTitle("");
      setNoteBody("");
      await load();
    } catch (err) {
      toast.fail("Could not save that note", err);
    }
  };

  const generate = async () => {
    if (!clientId || !topic.trim()) return;
    setWorking(true);
    try {
      await api.post(`/clients/${clientId}/carousels`, {
        topic: topic.trim(),
        slideCount,
      });
      setTopic("");
      await load();
    } catch (err) {
      toast.fail("Could not write that carousel", err);
    } finally {
      setWorking(false);
    }
  };

  /**
   * The CSV comes back as a file, so it is fetched with the operator's token
   * and handed to the browser as a download rather than opened as a page.
   */
  const downloadCsv = async (draft: Draft) => {
    try {
      const token = getToken();
      const res = await fetch(`${API_URL}/carousels/${draft.id}/csv`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`the sheet could not be built (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${draft.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.fail("Could not download the sheet", err);
    }
  };

  const remove = async (draft: Draft) => {
    try {
      await api.del(`/carousels/${draft.id}`);
      await load();
    } catch (err) {
      toast.fail("Could not delete that carousel", err);
    }
  };

  if (!clientId) {
    return (
      <section className="screen active" data-screen="carousels">
        <div className="topbar">
          <div className="h">
            <h2>Carousels</h2>
            <p>Pick a brand from the sidebar to write carousels for it.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="screen active" data-screen="carousels">
      <div className="topbar">
        <div className="h">
          <h2>Carousels</h2>
          <p>
            Write the words here, download the sheet, and let Canva bulk create turn each row
            into a slide. The finished images come back in through Upload and Schedule.
          </p>
        </div>
      </div>

      <div className="stage">
        <div className="card glass">
          <h3>Knowledge base</h3>
          <div className="sub" style={{ marginBottom: 10 }}>
            What this brand knows that nobody else does. Offers, objections, the questions
            customers actually ask. Carousels are written from this, and nothing gets invented
            that is not in it.
          </div>

          <div className="pcontact" style={{ maxWidth: 640 }}>
            <label className="cfield">
              <span className="lab">Title</span>
              <input
                className="field-in"
                value={noteTitle}
                placeholder="Common objections"
                onChange={(e) => setNoteTitle(e.target.value)}
              />
            </label>
            <label className="cfield">
              <span className="lab">What to remember</span>
              <textarea
                className="field-in"
                rows={4}
                value={noteBody}
                placeholder="They think financing at the dealer is always worse. It is not, and here is why."
                onChange={(e) => setNoteBody(e.target.value)}
              />
            </label>
            <button
              className="cbtn"
              disabled={!noteTitle.trim() || !noteBody.trim()}
              onClick={() => void addNote()}
            >
              Add to the knowledge base
            </button>
          </div>

          {notes?.length ? (
            notes.map((n) => (
              <div className="best" key={n.id}>
                <div className="l">
                  <b>{n.title}</b>
                  <div className="sub" style={{ whiteSpace: "pre-wrap" }}>
                    {n.body}
                  </div>
                </div>
                <button
                  className="dangerbtn"
                  onClick={() => {
                    void (async () => {
                      try {
                        await api.del(`/clients/${clientId}/knowledge/${n.id}`);
                        await load();
                      } catch (err) {
                        toast.fail("Could not delete that note", err);
                      }
                    })();
                  }}
                >
                  Delete
                </button>
              </div>
            ))
          ) : (
            <p className="insworking" style={{ marginTop: 10 }}>
              Nothing here yet. A carousel written from an empty knowledge base is generic, so
              add what you know first.
            </p>
          )}
        </div>

        <div className="card glass" style={{ marginTop: 16 }}>
          <div className="rowhead">
            <div>
              <h3>Write a carousel</h3>
              <div className="sub">
                Give it a topic. It uses the knowledge base above and the accounts this brand
                said they want to be like.
              </div>
            </div>
          </div>

          <div className="pcontact" style={{ maxWidth: 640, marginTop: 10 }}>
            <label className="cfield">
              <span className="lab">Topic</span>
              <input
                className="field-in"
                value={topic}
                placeholder="3 myths about financing a used truck"
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && topic.trim() && !working) void generate();
                }}
              />
            </label>
            <label className="cfield">
              <span className="lab">Slides</span>
              <Select
                value={String(slideCount)}
                onChange={(v) => setSlideCount(Number(v))}
                options={[3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
                  value: String(n),
                  label: String(n),
                }))}
              />
            </label>
            <button
              className="cbtn"
              disabled={!topic.trim() || working}
              onClick={() => void generate()}
            >
              {working ? "Writing…" : "Write it"}
            </button>
            {working && (
              <span className="sub" style={{ fontSize: 11 }}>
                This takes a few seconds. It is saved as soon as it is written, so leaving this
                screen will not lose it.
              </span>
            )}
          </div>
        </div>

        {drafts?.map((d) => (
          <div className="card glass" style={{ marginTop: 16 }} key={d.id}>
            <div className="rowhead">
              <div>
                <b style={{ fontSize: 14.5 }}>{d.topic}</b>
                <div className="sub">
                  {d.slides.length} slides · written {new Date(d.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="cbtn" onClick={() => void downloadCsv(d)}>
                  Download sheet
                </button>
                <button
                  className="cbtn"
                  title="Go to Upload and Schedule to add the finished images. The caption and hashtags written here ride along, so nothing is retyped."
                  onClick={() => {
                    setPendingCarouselDraft({ id: d.id, topic: d.topic });
                    onUploadImages();
                  }}
                >
                  Upload the images
                </button>
                <button className="dangerbtn" onClick={() => void remove(d)}>
                  Delete
                </button>
              </div>
            </div>

            {d.slides.map((s, i) => (
              <div className="best" key={i}>
                <div className="l">
                  <b>
                    {i + 1}. {s.headline}
                  </b>
                  {s.body && <div className="sub">{s.body}</div>}
                </div>
              </div>
            ))}

            {(d.caption || d.hashtags.length > 0) && (
              <p className="insworking" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>
                {d.caption}
                {d.hashtags.length > 0 && `\n\n${d.hashtags.map((h) => `#${h}`).join(" ")}`}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
