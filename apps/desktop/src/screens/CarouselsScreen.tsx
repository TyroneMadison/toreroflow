import { useCallback, useEffect, useState } from "react";
import { API_URL, api, getToken } from "../lib/api";
import Select from "../components/Select";
import { useToast } from "../components/Toasts";
import { useAppState } from "../state/AppState";
import { Empty, ErrorState, Loading } from "../components/states";
import CarouselPostCard from "../components/CarouselPostCard";
import SunraCarouselCard from "../components/SunraCarouselCard";
import { useIsPhone } from "../lib/phone";
import { Ic, Sheet } from "../components/analytics/phoneBits";
import { JumpChips, Stepper, SwipeDel, useSoftDelete } from "../components/mobile/FlowBits";
import SwipeRow from "../components/mobile/SwipeRow";
import ConfirmSheet from "../components/mobile/ConfirmSheet";
import { PhoneMenu } from "../editor/phoneBits";

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const isPhone = useIsPhone();
  // Phone: the written carousel shown open (null is the newest), and the sheets.
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<Draft | null>(null);
  const [confirmDel, setConfirmDel] = useState<Draft | null>(null);
  const [reading, setReading] = useState<KnowledgeNote | null>(null);
  const [adding, setAdding] = useState(false);

  // A failed refresh after an edit keeps what is on screen and toasts; only a
  // first load with nothing to show turns into the error state.
  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      const [n, d] = await Promise.all([
        api.get<KnowledgeNote[]>(`/clients/${clientId}/knowledge`),
        api.get<Draft[]>(`/clients/${clientId}/carousels`),
      ]);
      setNotes(n);
      setDrafts(d);
      setLoadError(null);
    } catch (err) {
      toast.fail("Could not load carousels", err);
      setLoadError(err instanceof Error ? err.message : "could not load carousels");
    }
  }, [clientId, toast]);

  useEffect(() => {
    setNotes(null);
    setDrafts(null);
    setLoadError(null);
    void load();
  }, [load]);

  const state = !clientId ? "empty" : notes === null ? (loadError ? "error" : "loading") : "ready";

  const addNote = async () => {
    if (!clientId || !noteTitle.trim() || !noteBody.trim()) return false;
    try {
      await api.post(`/clients/${clientId}/knowledge`, {
        title: noteTitle.trim(),
        body: noteBody.trim(),
      });
      setNoteTitle("");
      setNoteBody("");
      await load();
      return true;
    } catch (err) {
      toast.fail("Could not save that note", err);
      return false;
    }
  };

  // Phone: a swiped note goes at once and is deleted after the Undo toast.
  const { hidden, del: delNote } = useSoftDelete(async (id) => {
    try {
      await api.del(`/clients/${clientId}/knowledge/${id}`);
      await load();
    } catch (err) {
      toast.fail("Could not delete that note", err);
      throw err;
    }
  });

  const generate = async () => {
    if (!clientId || !topic.trim()) return;
    setWorking(true);
    try {
      await api.post(`/clients/${clientId}/carousels`, {
        topic: topic.trim(),
        slideCount,
      });
      setTopic("");
      setOpenDraft(null);
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
      const name = `${draft.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}.csv`;
      // The phone hands the sheet to its share sheet (Save to Files, or Canva);
      // where that is refused it falls through to the download.
      const file = isPhone && typeof navigator.canShare === "function" ? new File([blob], name, { type: "text/csv" }) : null;
      if (file && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: draft.topic });
          return;
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
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

  if (isPhone) {
    // Phone (mobile pass): one page with area chips. Write leads, the written
    // carousels follow as cards (older ones folded to a row, Delete in the ...
    // menu), then Sunra, posting, and the knowledge base it all reads from at
    // the bottom: tap a note to read it, swipe it left to delete with Undo,
    // and add one in a small sheet.
    const shown = (notes ?? []).filter((n) => !hidden.has(n.id));
    const count = shown.length;
    const openId = openDraft ?? drafts?.[0]?.id;
    const day = (iso: string) => {
      const d = new Date(iso);
      return d.toDateString() === new Date().toDateString() ? "today" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    };
    return (
      <section className="screen active mb-page fl-page" data-screen="carousels" data-state={state}>
        <p className="mb-sub mb-subonly">Write the words, make the slides in Canva or with Sunra, then post the finished set.</p>
        {state === "empty" ? (
          <Empty screen="carousels" title="No brand selected" hint="Pick a brand in the dock to write carousels for it." />
        ) : state === "error" ? (
          <ErrorState
            screen="carousels"
            message={loadError}
            onRetry={() => {
              setLoadError(null);
              void load();
            }}
          />
        ) : state === "loading" ? (
          <Loading screen="carousels" />
        ) : (
          <>
            <JumpChips
              label="Carousel areas"
              items={[
                { id: "fl-write", label: "Write" },
                { id: "fl-sunra", label: "Sunra" },
                { id: "fl-post", label: "Post" },
                {
                  id: "fl-kb",
                  label: (
                    <>
                      Knowledge base <small>{count}</small>
                    </>
                  ),
                },
              ]}
            />

            <section id="fl-write" className="mb-card fl-card" aria-label="Write a carousel">
              <h3 className="fl-h3">Write a carousel</h3>
              <p className="fl-cardsub">
                Give it a topic. It uses the knowledge base and the accounts {selectedClient?.name ?? "this brand"} wants to be like.
              </p>
              <div className="mb-field">
                <label htmlFor="fl-topic">Topic</label>
                <input
                  id="fl-topic"
                  className="mb-input"
                  value={topic}
                  placeholder="3 myths about financing a used truck"
                  enterKeyHint="go"
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && topic.trim() && !working) void generate();
                  }}
                />
              </div>
              <div className="fl-steprow">
                <span className="mb-lt">
                  <b>Slides</b>
                  <small>3 to 10</small>
                </span>
                <Stepper label="Slides" value={slideCount} min={3} max={10} onChange={setSlideCount} />
              </div>
              <button
                type="button"
                className="mb-btn pri block"
                disabled={!topic.trim() || working}
                data-testid="carousels.generate"
                onClick={() => void generate()}
              >
                <Ic name="i-wand" />
                {working ? "Writing…" : "Write it"}
              </button>
              <p className="fl-help">
                {working
                  ? "This takes a few seconds. It is saved as soon as it is written, so leaving this screen will not lose it."
                  : count
                    ? `Written from ${count} ${count === 1 ? "note" : "notes"}. Saved the moment it is written.`
                    : "The knowledge base is empty, so it comes out generic. Add what you know first."}
              </p>
            </section>

            {!!drafts?.length && (
              <div className="fl-labrow">
                <span className="mb-lab">Written carousels</span>
                <span className="mb-lab">{drafts.length}</span>
              </div>
            )}
            {drafts?.map((d) =>
              d.id === openId ? (
                <article
                  key={d.id}
                  className="mb-card fl-card fl-draft"
                  data-testid={`carousel-draft-${d.id}`}
                  aria-label={`Carousel draft: ${d.topic}`}
                >
                  <div className="fl-dh">
                    <span className="mb-grow">
                      <b>{d.topic}</b>
                      <small>
                        {d.slides.length} slides, written {day(d.createdAt)}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="mb-ib ghost"
                      aria-label={`More for ${d.topic}`}
                      data-testid="carousels.draft-menu"
                      onClick={() => setMenuFor(d)}
                    >
                      <Ic name="i-dots-h" />
                    </button>
                  </div>
                  <ol className="fl-slides">
                    {d.slides.map((s, i) => (
                      <li key={i}>
                        <span className="fl-sn">{i + 1}</span>
                        <span>
                          <b>{s.headline}</b>
                          {s.body && <small>{s.body}</small>}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {(d.caption || d.hashtags.length > 0) && (
                    <div className="fl-cap">
                      <span className="mb-lab">Caption</span>
                      {d.caption && <p>{d.caption}</p>}
                      {d.hashtags.length > 0 && <p className="fl-tags">{d.hashtags.map((h) => `#${h}`).join(" ")}</p>}
                    </div>
                  )}
                  <div className="fl-tiles">
                    <button type="button" data-testid="carousels.download-sheet" onClick={() => void downloadCsv(d)}>
                      <Ic name="i-dl" />
                      Download sheet
                    </button>
                    <button
                      type="button"
                      data-testid="carousels.upload-images"
                      onClick={() => {
                        setPendingCarouselDraft({ id: d.id, topic: d.topic });
                        onUploadImages();
                      }}
                    >
                      <Ic name="i-upload" />
                      Upload the images
                    </button>
                  </div>
                </article>
              ) : (
                <button
                  key={d.id}
                  type="button"
                  className="mb-card fl-fold"
                  data-testid={`carousel-draft-${d.id}`}
                  aria-expanded={false}
                  onClick={() => setOpenDraft(d.id)}
                >
                  <span className="fl-fic">
                    <Ic name="i-list" />
                  </span>
                  <span className="mb-lt">
                    <b>{d.topic}</b>
                    <small>
                      {d.slides.length} slides, written {day(d.createdAt)}
                    </small>
                  </span>
                  <Ic name="i-chev" />
                </button>
              ),
            )}

            <SunraCarouselCard />

            <CarouselPostCard />

            <section id="fl-kb" className="mb-card fl-card" aria-label="Knowledge base">
              <div className="fl-cardh">
                <h3 className="fl-h3">Knowledge base</h3>
                <small>
                  {count} {count === 1 ? "note" : "notes"}
                </small>
              </div>
              <p className="fl-cardsub">
                What this brand knows that nobody else does. Offers, objections, the questions customers actually ask. Carousels are written
                from this, and nothing gets invented that is not in it.
              </p>
              {count ? (
                <div className="fl-rows">
                  {shown.map((n) => (
                    <div key={n.id} className="fl-swwrap">
                      <SwipeDel />
                      <SwipeRow className="fl-swrow" onLeft={() => delNote(n.id, n.title)}>
                        <button type="button" className="fl-krow" onClick={() => setReading(n)}>
                          <span className="mb-grow">
                            <b>{n.title}</b>
                            <small>{n.body}</small>
                          </span>
                          <Ic name="i-chev-r" />
                        </button>
                      </SwipeRow>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="fl-help">
                  Nothing here yet. A carousel written from an empty knowledge base is generic, so add what you know first.
                </p>
              )}
              <button type="button" className="fl-addrow" onClick={() => setAdding(true)}>
                <Ic name="i-plus" />
                Add to the knowledge base
              </button>
              {count > 0 && <p className="fl-help">Tap a note to read it. Swipe one left to delete it.</p>}
            </section>
          </>
        )}

        {reading && (
          <Sheet
            label={reading.title}
            title={reading.title}
            onClose={() => setReading(null)}
            foot={
              <>
                <button
                  type="button"
                  className="mb-btn danger"
                  onClick={() => {
                    delNote(reading.id, reading.title);
                    setReading(null);
                  }}
                >
                  <Ic name="i-trash" />
                  Delete
                </button>
                <button type="button" className="mb-btn" onClick={() => setReading(null)}>
                  Done
                </button>
              </>
            }
          >
            <p className="mb-p fl-note">{reading.body}</p>
          </Sheet>
        )}
        {adding && (
          <Sheet
            label="Add to the knowledge base"
            title="Add to the knowledge base"
            sub="Carousels are written from what is here."
            onClose={() => setAdding(false)}
            foot={
              <>
                <button type="button" className="mb-btn" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="mb-btn pri"
                  disabled={!noteTitle.trim() || !noteBody.trim()}
                  data-testid="carousels.add-note"
                  onClick={() => void addNote().then((ok) => ok && setAdding(false))}
                >
                  Add
                </button>
              </>
            }
          >
            <div className="mb-field">
              <label htmlFor="fl-ntitle">Title</label>
              <input id="fl-ntitle" className="mb-input" value={noteTitle} placeholder="Common objections" onChange={(e) => setNoteTitle(e.target.value)} />
            </div>
            <div className="mb-field">
              <label htmlFor="fl-nbody">What to remember</label>
              <textarea
                id="fl-nbody"
                className="mb-input fl-ta"
                rows={5}
                value={noteBody}
                placeholder="They think financing at the dealer is always worse. It is not, and here is why."
                onChange={(e) => setNoteBody(e.target.value)}
              />
            </div>
          </Sheet>
        )}
        {menuFor && (
          <PhoneMenu
            title={menuFor.topic}
            items={[{ label: "Delete", danger: true, run: () => setConfirmDel(menuFor) }]}
            onClose={() => setMenuFor(null)}
          />
        )}
        {confirmDel && (
          <ConfirmSheet
            title="Delete this carousel?"
            body={`"${confirmDel.topic}" and its slides and caption are deleted. This cannot be undone.`}
            confirm="Delete"
            danger
            onConfirm={() => {
              const d = confirmDel;
              setConfirmDel(null);
              void remove(d);
            }}
            onClose={() => setConfirmDel(null)}
          />
        )}
      </section>
    );
  }

  if (state !== "ready") {
    return (
      <section className="screen active" data-screen="carousels" data-state={state}>
        <div className="topbar">
          <div className="h">
            <h2>Carousels</h2>
          </div>
        </div>
        <div className="stage">
          {state === "empty" ? (
            <Empty
              screen="carousels"
              title="No brand selected"
              hint="Pick a brand in the dock to write carousels for it."
            />
          ) : state === "error" ? (
            <ErrorState
              screen="carousels"
              message={loadError}
              onRetry={() => {
                setLoadError(null);
                void load();
              }}
            />
          ) : (
            <Loading screen="carousels" />
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="screen active" data-screen="carousels" data-state={state}>
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
              data-testid="carousels.add-note"
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
              data-testid="carousels.generate"
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

        <SunraCarouselCard />

        <CarouselPostCard />

        {drafts?.map((d) => (
          <div className="card glass" style={{ marginTop: 16 }} key={d.id} data-testid={`carousel-draft-${d.id}`} aria-label={`Carousel draft: ${d.topic}`}>
            <div className="rowhead">
              <div>
                <b style={{ fontSize: 14.5 }}>{d.topic}</b>
                <div className="sub">
                  {d.slides.length} slides · written {new Date(d.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="cbtn" data-testid="carousels.download-sheet" onClick={() => void downloadCsv(d)}>
                  Download sheet
                </button>
                <button
                  className="cbtn"
                  data-testid="carousels.upload-images"
                  title="Go to Upload and Schedule to add the finished images. The caption and hashtags written here ride along, so nothing is retyped."
                  onClick={() => {
                    setPendingCarouselDraft({ id: d.id, topic: d.topic });
                    onUploadImages();
                  }}
                >
                  Upload the images
                </button>
                <button className="dangerbtn" aria-label={`Delete draft ${d.topic}`} data-testid="carousels.delete-draft" onClick={() => void remove(d)}>
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
