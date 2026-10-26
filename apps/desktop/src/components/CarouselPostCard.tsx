import { useEffect, useState } from "react";
import { scheduleTimeError } from "@toreroflow/core";
import { api, fileUrl, videoLabel, type MediaAssetInfo } from "../lib/api";
import { linkProps } from "../lib/routes";
import {
  captionProblems,
  igPhotoBody,
  TIKTOK_DEFAULTS,
  tiktokBody,
  tkTouched,
  type TikTokChoice,
} from "../lib/postDetails";
import type { Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import { useToast } from "./Toasts";
import GlassDateTime from "./GlassDateTime";
import Select from "./Select";
import { CaptionField, HandleChips, igLimitText, LocationField, Seg, TikTokFields } from "./PostDetails";

function localInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
  const [caption, setCaption] = useState("");
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [userTags, setUserTags] = useState<string[]>([]);
  const [locationId, setLocationId] = useState("");
  const [tk, setTk] = useState<TikTokChoice>(TIKTOK_DEFAULTS);
  const [timing, setTiming] = useState<"later" | "now">("later");
  const [when, setWhen] = useState(() => localInputValue(new Date(Date.now() + 60 * 60_000)));
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<{ used: number; total: number } | null>(null);

  const accounts = (selectedClient?.accounts ?? []).filter(
    (a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "tiktok"),
  );
  const [accountIds, setAccountIds] = useState<string[]>(() => accounts.map((a) => a.id));
  const platforms = [...new Set(accounts.filter((a) => accountIds.includes(a.id)).map((a) => a.platform))] as Platform[];
  const asset = carousels?.find((c) => c.id === assetId) ?? null;

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
    if (accounts.some((a) => a.platform === "instagram")) {
      api
        .get<{ limit: { used: number; total: number } | null }>(`/clients/${selectedClient.id}/instagram-limit`)
        .then((r) => setLimit(r.limit))
        .catch(() => setLimit(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClient?.id]);

  const tooMany = asset != null && asset.slideCount > 10 && platforms.includes("instagram");
  const whenError = timing === "later" ? scheduleTimeError(new Date(when)) : null;
  const hashtags = (asset?.draftCopy?.hashtags ?? []).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const counted = [caption, hashtags].filter(Boolean).join("\n\n");
  const problems = [
    ...captionProblems(platforms, counted, true),
    ...(locationId.trim() && !/^\d+$/.test(locationId.trim()) ? ["Location must be the number of a Facebook place page."] : []),
    ...(tooMany ? ["Instagram takes up to 10 items in a carousel."] : []),
  ];
  const canPost = Boolean(asset) && platforms.length > 0 && !problems.length && !whenError && !busy;

  const submit = async () => {
    if (!asset || !canPost) return;
    setBusy(true);
    try {
      const original = asset.draftCopy?.description ?? "";
      await api.post(`/media/${asset.id}/schedule`, {
        platforms,
        accountIds: accounts.filter((a) => accountIds.includes(a.id)).map((a) => a.id),
        scheduledAt: (timing === "now" ? new Date() : new Date(when)).toISOString(),
        ...(caption !== original ? { caption } : {}),
        ...(platforms.includes("instagram")
          ? { instagram: igPhotoBody({ collaborators, userTags, locationId }) }
          : {}),
        ...(platforms.includes("tiktok") && tkTouched(tk) ? { tiktok: tiktokBody(tk, true) } : {}),
      });
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

          <div className="cfield">
            <span className="lab">Post to</span>
            {accounts.length === 0 ? (
              <span className="sub">Connect Instagram or TikTok in Settings first. YouTube only takes videos.</span>
            ) : (
              <div className="cpost-plats">
                {accounts.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    role="switch"
                    aria-checked={accountIds.includes(a.id)}
                    className="lfswitch"
                    onClick={() =>
                      setAccountIds((ids) => (ids.includes(a.id) ? ids.filter((x) => x !== a.id) : [...ids, a.id]))
                    }
                  >
                    <span>
                      {a.platform === "instagram" ? "Instagram" : "TikTok"} · @{a.handle}
                    </span>
                    <i aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <CaptionField
            id="cpost-caption"
            value={caption}
            onChange={setCaption}
            counted={counted}
            platforms={platforms}
            photo
            label={<span className="cpost-lab">Caption</span>}
          />

          {platforms.includes("instagram") && (
            <>
              <LocationField id="cpost-loc" value={locationId} onChange={setLocationId} />
              <HandleChips
                id="cpost-collabs"
                label="Collaborators"
                max={3}
                value={collaborators}
                onChange={setCollaborators}
                note="Collaborators get an invite. The post shows on their profile once they accept."
              />
              <HandleChips id="cpost-tags" label="Tag people" hint="on the first slide" value={userTags} onChange={setUserTags} />
            </>
          )}

          {platforms.includes("tiktok") && (
            <div className="cfield">
              <span className="lab">TikTok photo post</span>
              <TikTokFields value={tk} onChange={setTk} photo />
              <span className="sub">
                TikTok gets no location, collaborators or tags here: Zernio doesn't offer them for TikTok photo posts.
              </span>
            </div>
          )}

          <div className="cfield">
            <span className="lab">Post time</span>
            <Seg
              label="Post time"
              value={timing}
              onChange={setTiming}
              testId="cpost-timing"
              options={[
                { id: "later", label: "Schedule" },
                { id: "now", label: "Post now" },
              ]}
            />
            {timing === "later" && <GlassDateTime value={when} onChange={setWhen} minDate={new Date()} />}
            {whenError && <div className="autherr">{whenError}</div>}
          </div>

          <button
            className="cbtn cpost-go"
            disabled={!canPost}
            title={problems[0] ?? whenError ?? undefined}
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
