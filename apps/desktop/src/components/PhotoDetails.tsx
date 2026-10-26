import { useState } from "react";
import { scheduleTimeError } from "@toreroflow/core";
import { captionProblems, igPhotoBody, TIKTOK_DEFAULTS, tiktokBody, tkTouched, type TikTokChoice } from "../lib/postDetails";
import type { Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";
import GlassDateTime from "./GlassDateTime";
import { CaptionField, HandleChips, LocationField, Seg, TikTokFields } from "./PostDetails";

function localInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The details of an image or carousel post (mockup ig-05): caption with the
 * live checker, location, collaborators, tags, post time and where it goes.
 * One hook so the composer and the Carousels tab ask the same questions and
 * send the same schedule body.
 */
export function usePhotoDetails(id: string, hashtags: string[] = []) {
  const { selectedClient } = useAppState();
  const [caption, setCaption] = useState("");
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [userTags, setUserTags] = useState<string[]>([]);
  const [locationId, setLocationId] = useState("");
  const [tk, setTk] = useState<TikTokChoice>(TIKTOK_DEFAULTS);
  const [timing, setTiming] = useState<"later" | "now">("later");
  const [when, setWhen] = useState(() => localInputValue(new Date(Date.now() + 60 * 60_000)));

  const accounts = (selectedClient?.accounts ?? []).filter(
    (a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "tiktok"),
  );
  const [accountIds, setAccountIds] = useState<string[]>(() => accounts.map((a) => a.id));
  const chosen = accounts.filter((a) => accountIds.includes(a.id));
  const platforms = [...new Set(chosen.map((a) => a.platform))] as Platform[];

  const whenError = timing === "later" ? scheduleTimeError(new Date(when)) : null;
  const tags = hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const counted = [caption, tags].filter(Boolean).join("\n\n");
  const problems = [
    ...(platforms.length ? [] : ["Pick Instagram or TikTok to post to."]),
    ...captionProblems(platforms, counted, true),
    ...(locationId.trim() && !/^\d+$/.test(locationId.trim()) ? ["Location must be the number of a Facebook place page."] : []),
  ];

  /** The schedule route's body, less the caption, which each caller decides. */
  const body = () => ({
    platforms,
    accountIds: chosen.map((a) => a.id),
    scheduledAt: (timing === "now" ? new Date() : new Date(when)).toISOString(),
    ...(platforms.includes("instagram") ? { instagram: igPhotoBody({ collaborators, userTags, locationId }) } : {}),
    ...(platforms.includes("tiktok") && tkTouched(tk) ? { tiktok: tiktokBody(tk, true) } : {}),
  });

  const fields = (
    <>
      <CaptionField
        id={`${id}-caption`}
        value={caption}
        onChange={setCaption}
        counted={counted}
        platforms={platforms}
        photo
        placeholder="Write a caption."
      />
      {tags && (
        <div className="hashrow">
          {hashtags.map((h) => (
            <span className="hash" key={h}>
              #{h.replace(/^#/, "")}
            </span>
          ))}
        </div>
      )}

      {platforms.includes("instagram") && (
        <>
          <LocationField id={`${id}-loc`} value={locationId} onChange={setLocationId} />
          <HandleChips
            id={`${id}-collabs`}
            label="Collaborators"
            max={3}
            value={collaborators}
            onChange={setCollaborators}
            note="Collaborators get an invite. The post shows on their profile once they accept."
          />
          <HandleChips id={`${id}-tags`} label="Tag people" hint="on the first item" value={userTags} onChange={setUserTags} />
        </>
      )}

      <div className="cfield">
        <span className="flabel">Post time</span>
        <Seg
          label="Post time"
          value={timing}
          onChange={setTiming}
          testId={`${id}-timing`}
          options={[
            { id: "later", label: "Schedule" },
            { id: "now", label: "Post now" },
          ]}
        />
        {timing === "later" && <GlassDateTime value={when} onChange={setWhen} minDate={new Date()} />}
        {whenError && <div className="autherr">{whenError}</div>}
      </div>

      <div className="cfield">
        <span className="flabel">Platforms</span>
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
                data-testid={`${id}-plat-${a.platform}`}
                onClick={() => setAccountIds((ids) => (ids.includes(a.id) ? ids.filter((x) => x !== a.id) : [...ids, a.id]))}
              >
                <span>
                  {a.platform === "instagram" ? "Instagram" : "TikTok"} · @{a.handle}
                </span>
                <i aria-hidden="true" />
              </button>
            ))}
            <p className="lnote">YouTube only takes videos, so it's switched off for image posts.</p>
          </div>
        )}
      </div>

      {platforms.includes("tiktok") && (
        <div className="cfield">
          <span className="flabel">TikTok photo post</span>
          <TikTokFields value={tk} onChange={setTk} photo />
          <span className="sub">
            TikTok gets no location, collaborators or tags here: Zernio doesn't offer them for TikTok photo posts.
          </span>
        </div>
      )}
    </>
  );

  return { caption, setCaption, platforms, problems, whenError, timing, body, fields };
}
