import { useEffect, useRef, useState } from "react";
import { api, fileUrl, uploadCarousel, videoLabel, type MediaAssetInfo } from "../lib/api";
import { linkProps } from "../lib/routes";
import { COMPOSER_MAX, intake, waitReady } from "../lib/postDetails";
import { useAppState } from "../state/AppState";
import CarouselBuilderModal, { type CropRect } from "../modals/CarouselBuilderModal";
import { useToast } from "./Toasts";
import { usePhotoDetails } from "./PhotoDetails";

interface Item {
  file: File;
  url: string;
  crop: CropRect | null;
}

const isImage = (f: File) => f.type.startsWith("image/");

/**
 * Image and Carousel in the composer (mockup ig-05): the items on the left,
 * the post details on the right, and one Schedule press that uploads, waits
 * for processing and puts it on the calendar. Save draft uploads only, so it
 * shows under Finished carousels to pick up later, here.
 */
export default function PhotoComposer({
  type,
  finished,
  igLimitTotal,
  onDone,
  onOpenConnect,
}: {
  type: "image" | "carousel";
  /** Ready carousels not yet scheduled, to pick instead of uploading. */
  finished: MediaAssetInfo[];
  igLimitTotal: number | null;
  onDone(): void;
  onOpenConnect(): void;
}) {
  const toast = useToast();
  const { selectedClient, pendingCarouselDraft, setPendingCarouselDraft } = useAppState();
  const max = COMPOSER_MAX[type];
  const [items, setItems] = useState<Item[]>([]);
  const [picked, setPicked] = useState<MediaAssetInfo | null>(null);
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [arranging, setArranging] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const d = usePhotoDetails("pcomp", picked ? (picked.draftCopy?.hashtags ?? []) : hashtags);

  // Object URLs live as long as their item; the browser frees nothing on its own.
  const urls = useRef<string[]>([]);
  urls.current = items.map((i) => i.url);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const add = (files: File[]) => {
    if (!selectedClient) return onOpenConnect();
    // An image post holds one picture, so a new pick replaces it.
    const have = type === "image" ? 0 : items.length;
    const r = intake(type, have, files);
    if (r.notes.length) toast.fail("Some files were left out", new Error(r.notes.join(" ")));
    if (!r.accepted.length) return;
    const fresh = r.accepted.map((i) => ({ file: files[i]!, url: URL.createObjectURL(files[i]!), crop: null }));
    setPicked(null);
    setItems((list) => {
      if (type === "image") list.forEach((i) => URL.revokeObjectURL(i.url));
      return type === "image" ? fresh : [...list, ...fresh];
    });
  };
  const remove = (idx: number) =>
    setItems((list) => {
      URL.revokeObjectURL(list[idx]!.url);
      return list.filter((_, i) => i !== idx);
    });

  const count = picked ? picked.slideCount : items.length;
  const problems = [
    ...(count ? [] : [type === "image" ? "Add a picture first." : "Add photos or videos first."]),
    ...(items[0] && !isImage(items[0].file) ? ["The first item must be a picture: it sets the shape and is the cover."] : []),
    ...d.problems,
  ];
  const busy = stage !== null;

  const reset = () => {
    items.forEach((i) => URL.revokeObjectURL(i.url));
    setItems([]);
    setPicked(null);
    setHashtags([]);
    d.setCaption("");
  };

  /** Upload what is in the composer, carrying the words as its draft. */
  const upload = async (): Promise<MediaAssetInfo> => {
    setStage("Uploading…");
    const created = await uploadCarousel(
      selectedClient!.id,
      items.map((i) => i.file),
      pendingCarouselDraft?.id,
      items.map((i) => i.crop),
    );
    setPendingCarouselDraft(null);
    if (d.caption.trim() || hashtags.length) {
      await api.patch(`/media/${created.id}/draft`, {
        ...(d.caption.trim() ? { description: d.caption.trim() } : {}),
        ...(hashtags.length ? { hashtags } : {}),
      });
    }
    return created;
  };

  const saveDraft = async () => {
    if (!selectedClient || !items.length || busy) return;
    try {
      await upload();
      toast.success("Saved. It shows under Finished carousels once processed.");
      reset();
      onDone();
    } catch (err) {
      toast.fail("Could not save the draft", err);
    } finally {
      setStage(null);
    }
  };

  const schedule = async () => {
    if (!selectedClient || problems.length || d.whenError || busy) return;
    const now = d.timing === "now";
    try {
      let asset = picked;
      if (!asset) {
        const created = await upload();
        setStage("Processing…");
        asset = await waitReady(() => api.get<MediaAssetInfo>(`/media/${created.id}`));
        if (!asset) {
          toast.fail(
            "Still processing",
            new Error("it's saved under Finished carousels. Pick it there to schedule it in a minute"),
          );
          reset();
          onDone();
          return;
        }
      }
      setStage(now ? "Posting…" : "Scheduling…");
      await api.post(`/media/${asset.id}/schedule`, {
        ...d.body(),
        ...(d.caption.trim() ? { caption: d.caption } : {}),
        ...(!picked && hashtags.length ? { hashtags } : {}),
      });
      toast.success(now ? "Posting now." : "Scheduled. It's on the calendar.");
      reset();
      onDone();
    } catch (err) {
      toast.fail(now ? "Could not post" : "Could not schedule", err);
    } finally {
      setStage(null);
    }
  };

  const label = type === "image" ? "Image" : "Carousel";

  return (
    <>
      <div className="pcomp">
        <section className="pcomp-col glass-sm" aria-label={label}>
          <h4>
            {label}{" "}
            <small>
              {type === "image" ? `${count} of 1 picture` : `${count} of ${max} items`}
            </small>
          </h4>

          <input
            ref={input}
            type="file"
            accept={type === "image" ? "image/jpeg,image/png,image/webp" : "image/jpeg,image/png,image/webp,video/mp4,video/quicktime"}
            multiple={type === "carousel"}
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) add(Array.from(e.target.files));
              e.target.value = "";
            }}
          />

          {picked ? (
            <div className="pcomp-frames">
              <div className="on" style={picked.thumbUrl ? { backgroundImage: `url(${fileUrl(picked.thumbUrl)})` } : undefined}>
                <span className="pcomp-name">{videoLabel(picked)}</span>
              </div>
            </div>
          ) : items.length ? (
            <div
              className={`pcomp-frames${dragOver ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files.length) add(Array.from(e.dataTransfer.files));
              }}
            >
              {items.map((it, i) => (
                <div key={it.url} className={i === 0 ? "on" : undefined}>
                  {isImage(it.file) ? <img src={it.url} alt={`Item ${i + 1}`} /> : <video src={it.url} muted playsInline />}
                  <span className="pcomp-num">{i + 1}</span>
                  {it.crop && <span className="cbld-cropped">cropped</span>}
                  <button type="button" className="pcomp-x" aria-label={`Remove item ${i + 1}`} onClick={() => remove(i)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div
              className={`drop cbld-dropzone${dragOver ? " over" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={type === "image" ? "Add a picture" : "Add photos or videos"}
              data-testid="pcomp-drop"
              onClick={() => (selectedClient ? input.current?.click() : onOpenConnect())}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  input.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files.length) add(Array.from(e.dataTransfer.files));
              }}
            >
              <b>{type === "image" ? "Add a picture" : "Add photos or videos"}</b>
              <p>
                {type === "image"
                  ? "or drop one here. JPG, PNG or WebP."
                  : "or drop them here. Up to 10: JPG, PNG or WebP, and MP4 or MOV clips (Instagram only)."}
              </p>
            </div>
          )}

          <div className="pcomp-actions">
            {(items.length > 0 || picked) && (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => input.current?.click()}>
                {type === "image" ? "Replace picture" : "Add photo or video"}
              </button>
            )}
            {items.length > 0 && (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setArranging(true)}>
                {type === "image" ? "Crop" : "Arrange and crop"}
              </button>
            )}
            {picked && (
              <button type="button" className="btn ghost" disabled={busy} onClick={reset}>
                Clear
              </button>
            )}
          </div>

          {type === "carousel" && (
            <div className="lfnote warn">Every item is cropped to the first item's shape. Reels can't go in a carousel.</div>
          )}
          <div className="lfnote ok">
            {type === "carousel" ? "A carousel" : "An image post"} counts as 1 post toward today's
            {igLimitTotal ? ` ${igLimitTotal}` : " Instagram limit"}.
          </div>

          {type === "carousel" && finished.length > 0 && !items.length && (
            <div className="postcomposer-finished">
              <label className="flabel">
                Finished carousels<span className="hint">saved drafts and the Carousels tab</span>
              </label>
              <div className="postcomposer-picks">
                {finished.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className={`postcomposer-pick${picked?.id === a.id ? " on" : ""}`}
                    aria-pressed={picked?.id === a.id}
                    data-testid={`composer-pick-${a.id}`}
                    onClick={() => {
                      setPicked(a);
                      d.setCaption(a.draftCopy?.description ?? "");
                    }}
                  >
                    <span
                      className="postcomposer-pick-thumb"
                      style={a.thumbUrl ? { backgroundImage: `url(${fileUrl(a.thumbUrl)})` } : undefined}
                    />
                    <span className="postcomposer-pick-name">{videoLabel(a)}</span>
                    <span className="postcomposer-pick-meta">
                      {a.slideCount} item{a.slideCount === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {type === "carousel" && (
            <p className="lnote">
              <a {...linkProps("carousels")} className="link" data-testid="composer-carousels-link">
                Write a new carousel in Carousels
              </a>
            </p>
          )}
        </section>

        <section className="pcomp-col glass-sm" aria-label="Details" data-testid="pcomp-details">
          <h4>Details</h4>
          {d.fields}
        </section>
      </div>

      <div className="pcomp-foot">
        {problems[0] && count > 0 && <span className="pcomp-why">{problems[0]}</span>}
        {stage && (
          <span className="pcomp-why" role="status">
            {stage}
          </span>
        )}
        {!picked && (
          <button
            type="button"
            className="btn ghost"
            disabled={busy || !items.length}
            data-testid="pcomp-draft"
            onClick={() => void saveDraft()}
          >
            Save draft
          </button>
        )}
        <button
          type="button"
          className="cbtn pcomp-go"
          disabled={busy || problems.length > 0 || Boolean(d.whenError)}
          title={problems[0] ?? d.whenError ?? undefined}
          data-testid="pcomp-schedule"
          onClick={() => void schedule()}
        >
          {d.timing === "now" ? "Post now" : "Schedule"}
        </button>
      </div>

      {arranging && (
        <CarouselBuilderModal
          initialFiles={items.map((i) => i.file)}
          initialCrops={items.map((i) => i.crop)}
          initialWords={{ description: d.caption, hashtags }}
          maxItems={max}
          onClose={() => setArranging(false)}
          onCreated={() => {}}
          onArranged={(arranged, words) => {
            items.forEach((i) => URL.revokeObjectURL(i.url));
            setItems(arranged.map((a) => ({ ...a, url: URL.createObjectURL(a.file) })));
            d.setCaption(words.description);
            setHashtags(words.hashtags);
          }}
        />
      )}
    </>
  );
}
