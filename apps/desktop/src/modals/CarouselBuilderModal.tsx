import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIsPhone } from "../lib/phone";
import {
  CAROUSEL_ABSOLUTE_MAX,
  carouselVerdict,
  type CarouselItemInfo,
} from "@toreroflow/core";
import Modal from "./Modal";
import { api, uploadCarousel, type MediaAssetInfo } from "../lib/api";
import { useToast } from "../components/Toasts";
import { useAppState } from "../state/AppState";

/**
 * The carousel builder: arrange, crop, caption, upload.
 *
 * The tray is a horizontal strip of numbered cards. A card is picked up with
 * the pointer and physically follows it, tilting with the drag's speed; the
 * rest of the strip parts to make room, animated with a FLIP pass so every
 * move is a transform the compositor can run. Order is position: the number
 * badges are the posting order.
 *
 * Cropping is the phone gesture set on a desktop: the frame is fixed at the
 * set's aspect ratio (the first item decides it, both platforms force every
 * item to one ratio), the picture pans under it and zooms over it, and a
 * rule-of-thirds grid sits on top. What the crop saves is a source-pixel
 * rect; the server cuts it with ffmpeg, videos included, so what is framed
 * here is exactly what posts.
 *
 * Eligibility is announced while arranging, not at publish: more than 10
 * items rules Instagram out (their API ceiling, whatever the app allows),
 * any video rules TikTok out (photo posts are images only), and a set that
 * manages both is loudly unpostable.
 */

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BuilderItem {
  id: string;
  file: File;
  url: string;
  kind: "image" | "video";
  natural: { w: number; h: number } | null;
  crop: CropRect | null;
}

interface CarouselBuilderModalProps {
  onClose(): void;
  onCreated(): void;
  initialFiles: File[];
  /** The composer's cap: 1 for an image post, 10 for a carousel. */
  maxItems?: number;
  /** Arrange only: hand the order, crops and words back instead of uploading. */
  onArranged?(items: ArrangedItem[], words: { description: string; hashtags: string[] }): void;
  initialCrops?: Array<CropRect | null>;
  initialWords?: { description: string; hashtags: string[] };
}

export interface ArrangedItem {
  file: File;
  crop: CropRect | null;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime"]);

let nextId = 1;
const makeItem = (file: File): BuilderItem | null => {
  const kind = IMAGE_TYPES.has(file.type)
    ? ("image" as const)
    : VIDEO_TYPES.has(file.type)
      ? ("video" as const)
      : null;
  if (!kind) return null;
  return {
    id: `bi-${nextId++}`,
    file,
    url: URL.createObjectURL(file),
    kind,
    natural: null,
    crop: null,
  };
};

/** The set's aspect ratio: the first item's, clamped to what platforms take. */
const setRatio = (items: BuilderItem[]): number => {
  const first = items[0];
  const natural =
    first?.natural && first.natural.w > 0 && first.natural.h > 0
      ? first.natural.w / first.natural.h
      : 4 / 5;
  return Math.min(1.91, Math.max(9 / 16, natural));
};

export default function CarouselBuilderModal({
  onClose,
  onCreated,
  initialFiles,
  maxItems = CAROUSEL_ABSOLUTE_MAX,
  onArranged,
  initialCrops,
  initialWords,
}: CarouselBuilderModalProps) {
  const toast = useToast();
  const { selectedClient, pendingCarouselDraft, setPendingCarouselDraft } = useAppState();
  const [items, setItems] = useState<BuilderItem[]>(() =>
    initialFiles
      .map((f, i) => {
        const item = makeItem(f);
        return item && { ...item, crop: initialCrops?.[i] ?? null };
      })
      .filter((i): i is BuilderItem => i !== null),
  );
  const [description, setDescription] = useState(initialWords?.description ?? "");
  const [hashtags, setHashtags] = useState<string[]>(initialWords?.hashtags ?? []);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const isPhone = useIsPhone();

  // Object URLs live as long as the modal; the browser frees nothing on its own.
  useEffect(() => {
    return () => {
      for (const item of items) URL.revokeObjectURL(item.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Measure each item once so crops and the set ratio have real dimensions. */
  const measured = (id: string, w: number, h: number) =>
    setItems((list) =>
      list.map((i) => (i.id === id && !i.natural ? { ...i, natural: { w, h } } : i)),
    );

  const verdict = useMemo(
    () =>
      carouselVerdict(items.map((i): CarouselItemInfo => ({ kind: i.kind }))),
    [items],
  );
  const ratio = setRatio(items);

  const addFiles = (files: FileList | File[]) => {
    const incoming = Array.from(files).map(makeItem).filter((i): i is BuilderItem => i !== null);
    if (!incoming.length) return;
    setItems((list) => {
      const room = maxItems - list.length;
      if (incoming.length > room) {
        toast.fail(
          "Too many items",
          new Error(`this post takes ${maxItems}; the first ${Math.max(0, room)} were added`),
        );
      }
      return [...list, ...incoming.slice(0, Math.max(0, room))];
    });
  };

  const removeItem = (id: string) =>
    setItems((list) => {
      const gone = list.find((i) => i.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return list.filter((i) => i.id !== id);
    });

  /* ---- drag to reorder ---- */

  const drag = useRef<{
    id: string;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    lastX: number;
    lastT: number;
    tilt: number;
    active: boolean;
  } | null>(null);
  const [, forceRender] = useState(0);

  /**
   * FLIP: siblings glide to their new slots instead of teleporting. Rects are
   * recorded before the reorder, the inverted delta is applied as a transform,
   * and releasing it on the next frame lets the transition play. Transform
   * only, so the glass cards never re-blur mid-move.
   */
  const flip = (mutate: () => void) => {
    const before = new Map<string, DOMRect>();
    for (const [id, el] of cardRefs.current) before.set(id, el.getBoundingClientRect());
    mutate();
    requestAnimationFrame(() => {
      for (const [id, el] of cardRefs.current) {
        if (drag.current?.id === id) continue;
        const prev = before.get(id);
        if (!prev) continue;
        const now = el.getBoundingClientRect();
        const dx = prev.left - now.left;
        if (dx === 0) continue;
        el.style.transition = "none";
        el.style.transform = `translateX(${dx}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform .28s cubic-bezier(.22,1,.36,1)";
          el.style.transform = "";
        });
      }
    });
  };

  const onCardPointerDown = (e: React.PointerEvent, id: string) => {
    // Buttons on the card keep their own clicks.
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers (tests, automation) have no capturable id; the
      // drag still works from the move events alone.
    }
    drag.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      dy: 0,
      lastX: e.clientX,
      lastT: performance.now(),
      tilt: 0,
      active: false,
    };
  };

  const onCardPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.dx = e.clientX - d.startX;
    d.dy = e.clientY - d.startY;
    // A click is not a drag until it has moved enough to mean it.
    if (!d.active && Math.hypot(d.dx, d.dy) > 6) d.active = true;
    if (!d.active) return;

    // The ragdoll tilt: rotation follows horizontal velocity and eases back.
    const now = performance.now();
    const vx = (e.clientX - d.lastX) / Math.max(1, now - d.lastT);
    d.tilt = Math.max(-11, Math.min(11, d.tilt * 0.8 + vx * 26));
    d.lastX = e.clientX;
    d.lastT = now;

    // Crossing a neighbour's midpoint swaps places, FLIP easing the rest.
    const el = cardRefs.current.get(d.id);
    if (el) {
      const mine = el.getBoundingClientRect();
      const center = mine.left + mine.width / 2;
      const idx = items.findIndex((i) => i.id === d.id);
      const left = items[idx - 1] ? cardRefs.current.get(items[idx - 1]!.id) : null;
      const right = items[idx + 1] ? cardRefs.current.get(items[idx + 1]!.id) : null;
      if (left) {
        const r = left.getBoundingClientRect();
        if (center < r.left + r.width / 2) {
          flip(() =>
            setItems((list) => {
              const next = [...list];
              [next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!];
              // The pickup point travels with the card across the swap.
              d.startX -= r.width;
              d.dx += r.width;
              return next;
            }),
          );
        }
      }
      if (right) {
        const r = right.getBoundingClientRect();
        if (center > r.left + r.width / 2) {
          flip(() =>
            setItems((list) => {
              const next = [...list];
              [next[idx + 1], next[idx]] = [next[idx]!, next[idx + 1]!];
              d.startX += r.width;
              d.dx -= r.width;
              return next;
            }),
          );
        }
      }
    }
    forceRender((n) => n + 1);
  };

  const onCardPointerUp = () => {
    if (!drag.current) return;
    const wasDrag = drag.current.active;
    const id = drag.current.id;
    drag.current = null;
    forceRender((n) => n + 1);
    // A press that never became a drag opens the crop editor instead.
    if (!wasDrag) setEditingId(id);
  };

  /* ---- crop editor ---- */

  const editing = items.find((i) => i.id === editingId) ?? null;

  /* ---- caption ---- */

  const generateCaption = async () => {
    if (!selectedClient) return;
    const imageItems = items.filter((i) => i.kind === "image").slice(0, 4);
    if (!imageItems.length) {
      toast.fail("Nothing to read", new Error("add at least one image first"));
      return;
    }
    setGenerating(true);
    try {
      // Downscaled client-side: the model reads layout and words, not pixels,
      // and a 4K design as base64 is spend without signal.
      const form = new FormData();
      for (const item of imageItems) {
        const blob = await downscale(item, 800);
        form.append("slides", blob, "slide.jpg");
      }
      const out = await api.postForm<{ description: string; hashtags: string[] }>(
        `/clients/${selectedClient.id}/carousel-caption`,
        form,
      );
      if (out.description.trim()) setDescription(out.description);
      setHashtags(out.hashtags);
      toast.success("Caption written from the slides. Read it, then upload.");
    } catch (err) {
      toast.fail("Could not write the caption", err);
    } finally {
      setGenerating(false);
    }
  };

  /* ---- upload ---- */

  const upload = async () => {
    if (!selectedClient || !items.length) return;
    if (onArranged) {
      onArranged(items.map((i) => ({ file: i.file, crop: i.crop })), { description, hashtags });
      onClose();
      return;
    }
    if (items[0]!.kind !== "image") {
      toast.fail(
        "The first item must be an image",
        new Error("it sets the ratio for the whole carousel and becomes its cover"),
      );
      return;
    }
    setUploading(true);
    const draft = pendingCarouselDraft;
    try {
      const created = await uploadCarousel(
        selectedClient.id,
        items.map((i) => i.file),
        draft?.id,
        items.map((i) => i.crop),
      );
      setPendingCarouselDraft(null);
      // The words written here win over a Create-tab draft's, because they
      // are the ones the operator was just looking at.
      if (description.trim() || hashtags.length) {
        await api.patch<MediaAssetInfo>(`/media/${created.id}/draft`, {
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(hashtags.length ? { hashtags } : {}),
        });
      }
      toast.success(
        `Carousel added with ${items.length} item${items.length === 1 ? "" : "s"}. It appears in the list when the slides finish processing.`,
      );
      onCreated();
      onClose();
    } catch (err) {
      toast.fail("Could not upload the carousel", err);
    } finally {
      setUploading(false);
    }
  };

  const scrollTray = (dir: -1 | 1) => {
    const tray = trayRef.current;
    if (!tray) return;
    const card = tray.querySelector(".cbld-card");
    const step = card ? card.getBoundingClientRect().width + 14 : 200;
    tray.scrollBy({ left: dir * step * 2, behavior: "smooth" });
  };

  const d = drag.current;

  if (isPhone) {
    // Phone sheet (mobile pass): the picked slide is cropped right here under
    // a fixed frame (drag to move, slide to zoom, Reset, Remove with Undo),
    // the strip shows every slide with its number, Cover and Cropped tags and
    // a grip handle to hold and drag into order, "Can post to" says where the
    // set can go, and Cancel and Done sit in a sticky footer.
    const picked = items.find((i) => i.id === editingId) ?? items[0] ?? null;
    const pickedIdx = picked ? items.indexOf(picked) : -1;
    const ratioLabel = Math.abs(ratio - 0.8) < 0.01 ? "4:5" : Math.abs(ratio - 1) < 0.01 ? "1:1" : Math.abs(ratio - 9 / 16) < 0.01 ? "9:16" : `${ratio.toFixed(2)}:1`;
    const removePicked = () => {
      if (!picked) return;
      const at = items.indexOf(picked);
      setItems((list) => list.filter((i) => i.id !== picked.id));
      setEditingId(null);
      toast.success(`Slide ${at + 1} removed`, {
        label: "Undo",
        run: () =>
          setItems((list) => {
            const next = [...list];
            next.splice(Math.min(at, next.length), 0, picked);
            return next;
          }),
      });
    };
    return (
      <Modal maxWidth={980} onClose={onClose} label={maxItems === 1 ? "Image post" : "Build the carousel"} testId="carousel-builder">
        <div className="modal-head">
          <div>
            <h3>{maxItems === 1 ? "Image post" : "Build the carousel"}</h3>
            <p>
              {maxItems === 1
                ? "Move and zoom the picture inside the frame. That is the shape that posts."
                : "Tap a slide to crop it. Hold its handle to drag it into order. The first item sets the shape of every slide."}
            </p>
          </div>
          <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
            <svg>
              <use href="#i-x" />
            </svg>
          </button>
        </div>
        <div className="modal-body mb-cb">
          {picked ? (
            <>
              <InlineCrop
                key={picked.id}
                item={picked}
                ratio={ratio}
                label={`Slide ${pickedIdx + 1} of ${items.length}`}
                shape={`${ratioLabel} from slide 1`}
                onChange={(crop) => setItems((list) => list.map((i) => (i.id === picked.id ? { ...i, crop } : i)))}
                onRemove={removePicked}
              />
              <p className="mb-help">
                Drag to move the picture, pinch or slide to zoom. The grid is the frame that posts: every slide in this carousel is cut to this
                same shape.
              </p>
            </>
          ) : (
            <div className="mb-empty">
              <span className="mb-ei">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-image" />
                </svg>
              </span>
              <h3>No slides yet</h3>
              <p>Add photos or a video to start the set.</p>
            </div>
          )}

          <div className="mb-cardh flat">
            <span className="mb-lab">Slides</span>
            <small>
              {items.length} of {maxItems}
            </small>
          </div>
          <div className="mb-bstrip" ref={trayRef}>
            {items.map((item, idx) => {
              const dragging = d?.active && d.id === item.id;
              return (
                <div
                  key={item.id}
                  className={`mb-bcard${picked?.id === item.id ? " on" : ""}${dragging ? " dragging" : ""}`}
                  ref={(el) => {
                    if (el) cardRefs.current.set(item.id, el);
                    else cardRefs.current.delete(item.id);
                  }}
                  style={dragging ? { transform: `translate(${d!.dx}px, 0) scale(1.05)` } : undefined}
                >
                  <button type="button" className="mb-bthumb" aria-label={`Slide ${idx + 1}${idx === 0 ? ", cover" : ""}`} onClick={() => setEditingId(item.id)}>
                    {item.kind === "video" ? (
                      <video src={item.url} muted playsInline onLoadedMetadata={(e) => measured(item.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />
                    ) : (
                      <img src={item.url} alt="" draggable={false} onLoad={(e) => measured(item.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
                    )}
                    {item.crop && <span className="mb-shape" aria-hidden="true" />}
                    <span className="mb-sn">{idx + 1}</span>
                    {idx === 0 ? <span className="mb-btag">Cover</span> : item.crop ? <span className="mb-btag">Cropped</span> : item.kind === "video" ? <span className="mb-btag">Video</span> : null}
                  </button>
                  <button
                    type="button"
                    className="mb-handle"
                    aria-label={`Hold and drag slide ${idx + 1}`}
                    style={{ touchAction: "none" }}
                    onPointerDown={(e) => onCardPointerDown(e, item.id)}
                    onPointerMove={onCardPointerMove}
                    onPointerUp={onCardPointerUp}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-grip" />
                    </svg>
                  </button>
                </div>
              );
            })}
            {items.length < maxItems && (
              <button type="button" className="mb-badd" aria-label="Add more images or video" onClick={() => addInput.current?.click()}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-plus" />
                </svg>
              </button>
            )}
          </div>
          <input
            ref={addInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          <div className="mb-verd">
            <span className="mb-lab">Can post to</span>
            <span className={`mb-pill ${verdict.instagram.eligible ? "ok" : "bad"}`}>Instagram</span>
            <span className={`mb-pill ${verdict.tiktok.eligible ? "ok" : "bad"}`}>TikTok</span>
          </div>
          {!verdict.instagram.eligible && items.length > 0 && <p className="mb-err">{verdict.instagram.reason}</p>}
          {!verdict.tiktok.eligible && items.length > 0 && <p className="mb-err">{verdict.tiktok.reason}</p>}
          {verdict.unpostable && <p className="mb-err">As it stands nothing can take this set. Fix one of the two above first.</p>}
          {pendingCarouselDraft && (
            <p className="mb-help">The caption and hashtags from "{pendingCarouselDraft.topic}" ride along unless you write over them below.</p>
          )}

          <div className="mb-field">
            <div className="mb-cardh flat">
              <label htmlFor="cb-desc" className="mb-flab">
                Description
              </label>
              <button type="button" className="mb-aibtn" disabled={generating} onClick={() => void generateCaption()}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-spark" />
                </svg>
                {generating ? "Reading the slides" : "Generate caption with AI"}
              </button>
            </div>
            <p className="mb-help">
              The caption on Instagram and TikTok. Generate reads the slides themselves and writes from what is on them. It is the only thing here
              that spends AI credit, and only when pressed.
            </p>
            <textarea id="cb-desc" className="mb-input" rows={4} value={description} placeholder="Write a description." onChange={(e) => setDescription(e.target.value)} />
            {hashtags.length > 0 && (
              <div className="mb-hashrow">
                {hashtags.map((h) => (
                  <span key={h}>#{h.replace(/^#/, "")}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="mb-btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="mb-btn pri" disabled={uploading || items.length === 0 || verdict.unpostable} onClick={() => void upload()} data-testid="carousel-builder.done">
            {onArranged ? (
              <>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <use href="#i-check" />
                </svg>
                Done
              </>
            ) : uploading ? (
              "Uploading"
            ) : (
              `Upload ${items.length || ""} item${items.length === 1 ? "" : "s"}`
            )}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal maxWidth={980} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>{maxItems === 1 ? "Image post" : "Build the carousel"}</h3>
          <p>
            Drag the cards into order, press one to crop it. The first item sets the shape of
            every slide.
          </p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        {editing ? (
          <CropEditor
            item={editing}
            ratio={ratio}
            onDone={(crop) => {
              setItems((list) =>
                list.map((i) => (i.id === editing.id ? { ...i, crop } : i)),
              );
              setEditingId(null);
            }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <>
            <div
              className="cbld-tray"
              ref={trayRef}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
              }}
            >
              {items.map((item, idx) => {
                const dragging = d?.active && d.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={`cbld-card${dragging ? " dragging" : ""}`}
                    ref={(el) => {
                      if (el) cardRefs.current.set(item.id, el);
                      else cardRefs.current.delete(item.id);
                    }}
                    style={
                      dragging
                        ? {
                            transform: `translate(${d!.dx}px, ${d!.dy}px) rotate(${d!.tilt.toFixed(1)}deg) scale(1.05)`,
                          }
                        : undefined
                    }
                    onPointerDown={(e) => onCardPointerDown(e, item.id)}
                    onPointerMove={onCardPointerMove}
                    onPointerUp={onCardPointerUp}
                  >
                    <span className="cbld-num">{idx + 1}</span>
                    {item.kind === "video" ? (
                      <>
                        <video
                          src={item.url}
                          muted
                          loop
                          autoPlay
                          playsInline
                          onLoadedMetadata={(e) =>
                            measured(item.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight)
                          }
                        />
                        <span className="cbld-kind">video</span>
                      </>
                    ) : (
                      <img
                        src={item.url}
                        alt=""
                        draggable={false}
                        onLoad={(e) =>
                          measured(item.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
                        }
                      />
                    )}
                    {item.crop && <span className="cbld-cropped">cropped</span>}
                    <button
                      className="cbld-remove"
                      title="Remove this item"
                      onClick={() => removeItem(item.id)}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}

              {items.length < maxItems && (
                <button
                  className="cbld-add"
                  title="Add more images or video"
                  onClick={() => addInput.current?.click()}
                >
                  +
                </button>
              )}
            </div>

            <div className="cbld-arrows">
              <button className="cbld-arrow" title="Earlier slides" onClick={() => scrollTray(-1)}>
                ‹
              </button>
              <span className="cbld-count">
                {items.length} / {maxItems}
              </span>
              <button className="cbld-arrow" title="Later slides" onClick={() => scrollTray(1)}>
                ›
              </button>
            </div>

            <input
              ref={addInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {/* Where this set can go, decided live while arranging. */}
            <div className="cbld-verdicts">
              <span className={`revtoggle${verdict.instagram.eligible ? " on" : ""}`}>
                Instagram{verdict.instagram.eligible ? "" : ": no"}
              </span>
              <span className={`revtoggle${verdict.tiktok.eligible ? " on" : ""}`}>
                TikTok{verdict.tiktok.eligible ? "" : ": no"}
              </span>
            </div>
            {!verdict.instagram.eligible && items.length > 0 && (
              <p className="warnline" style={{ marginTop: 8 }}>
                {verdict.instagram.reason}
              </p>
            )}
            {!verdict.tiktok.eligible && items.length > 0 && (
              <p className="warnline" style={{ marginTop: 8 }}>
                {verdict.tiktok.reason}
              </p>
            )}
            {verdict.unpostable && (
              <p className="insfailed" style={{ marginTop: 8 }}>
                As it stands nothing can take this set. Fix one of the two above before
                uploading.
              </p>
            )}

            {pendingCarouselDraft && (
              <p className="insworking" style={{ marginTop: 10 }}>
                The caption and hashtags from "{pendingCarouselDraft.topic}" ride along unless
                you write over them below.
              </p>
            )}

            <label className="flabel withact" style={{ marginTop: 14 }}>
              Description
              <span className="hint">the caption on Instagram and TikTok</span>
              <span
                className={`revtoggle${generating ? " on" : ""}`}
                style={{ marginLeft: "auto" }}
                title="Reads the slides themselves and writes a caption from what is on them. The only thing that spends AI credit, and only when pressed."
                onClick={() => {
                  if (!generating) void generateCaption();
                }}
              >
                {generating ? "Reading the slides…" : "Generate caption with AI"}
              </span>
            </label>
            <div className="captionbox">
              <textarea
                value={description}
                placeholder="Write a description."
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {hashtags.length > 0 && (
              <div className="hashrow">
                {hashtags.map((h) => (
                  <span className="hash" key={h}>
                    #{h.replace(/^#/, "")}
                  </span>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button
                className="btn"
                disabled={uploading || items.length === 0 || verdict.unpostable}
                onClick={() => void upload()}
              >
                {onArranged
                  ? "Done"
                  : uploading
                  ? "Uploading…"
                  : `Upload ${items.length || ""} item${items.length === 1 ? "" : "s"}`}
              </button>
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Downscale an image item to a small JPEG for the caption model. */
async function downscale(item: BuilderItem, maxSide: number): Promise<Blob> {
  const img = new Image();
  img.src = item.url;
  await img.decode();
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode"))), "image/jpeg", 0.8),
  );
}

/**
 * Pan and zoom under a fixed frame, the way a phone crops.
 *
 * The frame is the set's ratio and never moves; the picture slides beneath it
 * and scales over it, clamped so it always covers the frame. What leaves here
 * is a rect in source pixels, which is the only coordinate space the server's
 * ffmpeg pass shares with this screen.
 */
function CropEditor({
  item,
  ratio,
  onDone,
  onCancel,
}: {
  item: BuilderItem;
  ratio: number;
  onDone(crop: CropRect | null): void;
  onCancel(): void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pan = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);

  const natural = item.natural ?? { w: 1080, h: 1080 };

  /** The media's rendered size at the current zoom, in frame pixels. */
  const geometry = () => {
    const frame = frameRef.current?.getBoundingClientRect();
    const fw = frame?.width ?? 640;
    const fh = frame?.height ?? 640 / ratio;
    const cover = Math.max(fw / natural.w, fh / natural.h);
    const s = cover * zoom;
    return { fw, fh, s, mw: natural.w * s, mh: natural.h * s };
  };

  const clampOffset = (x: number, y: number) => {
    const { fw, fh, mw, mh } = geometry();
    return {
      x: Math.min(0, Math.max(fw - mw, x)),
      y: Math.min(0, Math.max(fh - mh, y)),
    };
  };

  // Zooming keeps the frame center fixed, which is what the thumb expects.
  const applyZoom = (z: number) => {
    const { fw, fh, s } = geometry();
    const next = Math.min(3, Math.max(1, z));
    const factor = next / zoom;
    const cx = fw / 2 - offset.x;
    const cy = fh / 2 - offset.y;
    void s;
    setZoom(next);
    setOffset((o) => clampOffsetAt(next, fw / 2 - cx * factor, fh / 2 - cy * factor) ?? o);
  };
  const clampOffsetAt = (z: number, x: number, y: number) => {
    const frame = frameRef.current?.getBoundingClientRect();
    const fw = frame?.width ?? 640;
    const fh = frame?.height ?? 640 / ratio;
    const cover = Math.max(fw / natural.w, fh / natural.h);
    const s = cover * z;
    return {
      x: Math.min(0, Math.max(fw - natural.w * s, x)),
      y: Math.min(0, Math.max(fh - natural.h * s, y)),
    };
  };

  const commit = () => {
    const { fw, fh, s } = geometry();
    const crop: CropRect = {
      x: Math.max(0, -offset.x / s),
      y: Math.max(0, -offset.y / s),
      width: Math.min(natural.w, fw / s),
      height: Math.min(natural.h, fh / s),
    };
    // An untouched editor means no crop: let the server center-cut, which is
    // the same picture without carrying a rect around.
    const untouched = zoom === 1 && offset.x === 0 && offset.y === 0 && item.crop === null;
    onDone(untouched ? null : crop);
  };

  const { s } = geometry();

  return (
    <div className="cbld-cropwrap">
      <div
        className="cbld-frame"
        ref={frameRef}
        style={{ aspectRatio: String(ratio) }}
        onPointerDown={(e) => {
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {
            // Synthetic pointers have no capturable id; panning still works.
          }
          pan.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e) => {
          if (!pan.current) return;
          setOffset(
            clampOffset(
              pan.current.ox + (e.clientX - pan.current.startX),
              pan.current.oy + (e.clientY - pan.current.startY),
            ),
          );
        }}
        onPointerUp={() => (pan.current = null)}
        onWheel={(e) => applyZoom(zoom - Math.sign(e.deltaY) * 0.12)}
      >
        {item.kind === "video" ? (
          <video
            src={item.url}
            muted
            loop
            autoPlay
            playsInline
            style={{
              width: natural.w * s,
              height: natural.h * s,
              transform: `translate(${offset.x}px, ${offset.y}px)`,
            }}
          />
        ) : (
          <img
            src={item.url}
            alt=""
            draggable={false}
            style={{
              width: natural.w * s,
              height: natural.h * s,
              transform: `translate(${offset.x}px, ${offset.y}px)`,
            }}
          />
        )}
        {/* The rule-of-thirds grid, drawn over everything, catching no clicks. */}
        <div className="cbld-grid" aria-hidden="true">
          <span /><span /><span /><span />
        </div>
      </div>

      <div className="cbld-cropbar">
        <span className="lab">Zoom</span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => applyZoom(Number(e.target.value))}
        />
        <button
          className="btn ghost"
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          Reset
        </button>
        <button className="btn" onClick={commit}>
          Done
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Back
        </button>
      </div>
      <p className="lnote" style={{ marginLeft: 0, marginTop: 8 }}>
        Drag to move the picture, scroll or slide to zoom. The grid is the frame that posts:
        every slide in this carousel is cut to this same shape.
      </p>
    </div>
  );
}

/**
 * Phone: the picked slide cropped in place (mobile pass). Same maths as
 * CropEditor, but every move is kept as it happens (no separate Done), an
 * existing crop is restored when the slide is picked again, and Reset and
 * Remove sit beside the zoom.
 */
function InlineCrop({
  item,
  ratio,
  label,
  shape,
  onChange,
  onRemove,
}: {
  item: BuilderItem;
  ratio: number;
  label: string;
  shape: string;
  onChange(crop: CropRect | null): void;
  onRemove(): void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [, setTick] = useState(0);
  const pan = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const natural = item.natural ?? { w: 1080, h: 1080 };
  const dims = () => {
    const r = frameRef.current?.getBoundingClientRect();
    const fw = r?.width || 272;
    const fh = r?.height || fw / ratio;
    return { fw, fh, cover: Math.max(fw / natural.w, fh / natural.h) };
  };
  const clampAt = (z: number, x: number, y: number) => {
    const { fw, fh, cover } = dims();
    const s = cover * z;
    return { x: Math.min(0, Math.max(fw - natural.w * s, x)), y: Math.min(0, Math.max(fh - natural.h * s, y)) };
  };
  const emit = (z: number, o: { x: number; y: number }) => {
    const { fw, fh, cover } = dims();
    const s = cover * z;
    const untouched = z === 1 && o.x === 0 && o.y === 0;
    onChange(untouched ? null : { x: Math.max(0, -o.x / s), y: Math.max(0, -o.y / s), width: Math.min(natural.w, fw / s), height: Math.min(natural.h, fh / s) });
  };
  // Re-render once the frame has a size, and put back a crop made earlier.
  useLayoutEffect(() => {
    setTick((t) => t + 1);
    const c = item.crop;
    if (!c) return;
    const { fw, cover } = dims();
    const z = Math.min(3, Math.max(1, fw / (c.width * cover)));
    const s = cover * z;
    setZoom(z);
    setOffset({ x: -c.x * s, y: -c.y * s });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.natural?.w]);
  const applyZoom = (want: number) => {
    const { fw, fh } = dims();
    const next = Math.min(3, Math.max(1, want));
    const factor = next / zoom;
    const o = clampAt(next, fw / 2 - (fw / 2 - offset.x) * factor, fh / 2 - (fh / 2 - offset.y) * factor);
    setZoom(next);
    setOffset(o);
    emit(next, o);
  };
  const s = dims().cover * zoom;
  const media = { width: natural.w * s, height: natural.h * s, transform: `translate(${offset.x}px, ${offset.y}px)` };
  return (
    <>
      <div className="mb-stage">
        <div
          className="mb-frame"
          ref={frameRef}
          style={{ ["--r" as string]: String(ratio), touchAction: "none" }}
          onPointerDown={(e) => {
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Synthetic pointers have no capturable id; panning still works.
            }
            pan.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y };
          }}
          onPointerMove={(e) => {
            if (!pan.current) return;
            setOffset(clampAt(zoom, pan.current.ox + (e.clientX - pan.current.startX), pan.current.oy + (e.clientY - pan.current.startY)));
          }}
          onPointerUp={() => {
            if (pan.current) emit(zoom, offset);
            pan.current = null;
          }}
        >
          {item.kind === "video" ? <video src={item.url} muted loop autoPlay playsInline style={media} /> : <img src={item.url} alt="" draggable={false} style={media} />}
          <div className="cbld-grid" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <span className="mb-stlab l">{label}</span>
        <span className="mb-stlab r">{shape}</span>
      </div>
      <div className="mb-zoomrow">
        <span className="mb-lab">Zoom</span>
        <input type="range" min={1} max={3} step={0.01} value={zoom} aria-label="Zoom" onChange={(e) => applyZoom(Number(e.target.value))} style={{ ["--p" as string]: `${((zoom - 1) / 2) * 100}%` }} />
        <button
          type="button"
          className="mb-btn sm ghost"
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
            onChange(null);
          }}
        >
          Reset
        </button>
        <button type="button" className="mb-btn sm ghost mb-rm" onClick={onRemove}>
          Remove
        </button>
      </div>
    </>
  );
}
