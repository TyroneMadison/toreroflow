import { useEffect, useState } from "react";
import { api, fileUrl, videoLabel, type MediaAssetInfo } from "../lib/api";
import { linkProps } from "../lib/routes";
import { useAppState } from "../state/AppState";
import { useToast } from "./Toasts";
import Select from "./Select";
import { igLimitText } from "./PostDetails";
import { usePhotoDetails } from "./PhotoDetails";

/**
 * Create > Carousels, below the writing cards: post a finished carousel.
 *
 * The finished images come back through Upload & Schedule as a carousel; this
 * picks one of those, takes the post details (caption with the live checker,
 * location, collaborators, people tags, TikTok's settings) and a time, and
 * hands it to the same schedule route every post uses. Toreroflow's scheduler
 * fires it; Zernio posts it as one carousel, which counts as one post.
 */
export default function CarouselPostCard() {
  const { selectedClient } = useAppState();
  const toast = useToast();
  const [carousels, setCarousels] = useState<MediaAssetInfo[] | null>(null);
  const [assetId, setAssetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<{ used: number; total: number } | null>(null);
  const asset = carousels?.find((c) => c.id === assetId) ?? null;
  const d = usePhotoDetails("cpost", asset?.draftCopy?.hashtags ?? []);
  const tooMany = asset != null && asset.slideCount > 10 && d.platforms.includes("instagram");
  const problems = [...d.problems, ...(tooMany ? ["Instagram takes up to 10 items in a carousel."] : [])];
  const { caption, setCaption, timing } = d;
  const hasInstagram = (selectedClient?.accounts ?? []).some((a) => a.status === "connected" && a.platform === "instagram");

  useEffect(() => {
    if (!selectedClient) return;
    api
      .get<MediaAssetInfo[]>(`/clients/${selectedClient.id}/media`)
      .then((list) => {
        const ready = list.filter((a) => a.kind === "carousel" && a.status === "ready");
        setCarousels(ready);
        if (ready[0]) {
          setAssetId(ready[0].id);
          setCaption(ready[0].draftCopy?.description ?? "");
        }
      })
      .catch(() => setCarousels([]));
    if (hasInstagram) {
      api
        .get<{ limit: { used: number; total: number } | null }>(`/clients/${selectedClient.id}/instagram-limit`)
        .then((r) => setLimit(r.limit))
        .catch(() => setLimit(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClient?.id]);

  const canPost = Boolean(asset) && !problems.length && !d.whenError && !busy;

  const submit = async () => {
    if (!asset || !canPost) return;
    setBusy(true);
    try {
      const original = asset.draftCopy?.description ?? "";
      await api.post(`/media/${asset.id}/schedule`, { ...d.body(), ...(caption !== original ? { caption } : {}) });
      toast.success(timing === "now" ? "Posting the carousel now." : "Carousel scheduled. It's on the calendar.");
      setCarousels((list) => (list ?? []).filter((c) => c.id !== asset.id));
      setAssetId("");
    } catch (err) {
      toast.fail(timing === "now" ? "Could not post the carousel" : "Could not schedule the carousel", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card glass" style={{ marginTop: 16 }} data-testid="carousel-post-card">
      <div className="rowhead">
        <div>
          <h3>Post a finished carousel</h3>
          <div className="sub">
            Up to 10 items, posted through Zernio as one carousel. It counts as 1 post toward today's limit.
            {igLimitText(limit) && ` ${igLimitText(limit)}`}
          </div>
        </div>
      </div>

      {carousels === null ? (
        <p className="insworking" style={{ marginTop: 10 }}>Loading finished carousels…</p>
      ) : carousels.length === 0 ? (
        <p className="insworking" style={{ marginTop: 10 }}>
          No finished carousel yet. Bring the images in through{" "}
          <a {...linkProps("upload")} className="link">
            Upload &amp; Schedule
          </a>{" "}
          (Carousel), then post it from here.
        </p>
      ) : (
        <div className="pcontact" style={{ maxWidth: 640, marginTop: 10 }}>
          <label className="cfield">
            <span className="lab">Carousel</span>
            <Select
              value={assetId}
              aria-label="Carousel"
              onChange={(id) => {
                setAssetId(id);
                setCaption(carousels.find((c) => c.id === id)?.draftCopy?.description ?? "");
              }}
              options={carousels.map((c) => ({ value: c.id, label: `${videoLabel(c)} · ${c.slideCount} items` }))}
            />
          </label>
          {asset?.thumbUrl && (
            <img className="cpost-thumb" src={fileUrl(asset.thumbUrl) ?? undefined} alt={`First slide of ${videoLabel(asset)}`} />
          )}

          {d.fields}

          <button
            className="cbtn cpost-go"
            disabled={!canPost}
            title={problems[0] ?? d.whenError ?? undefined}
            data-testid="cpost-submit"
            onClick={() => void submit()}
          >
            {busy ? "Working…" : timing === "now" ? "Post now" : "Schedule carousel"}
          </button>
        </div>
      )}
    </div>
  );
}
