import { useCallback, useEffect, useState } from "react";
import Pf from "./Pf";
import { PF_ID } from "../lib/platforms";
import Select from "./Select";
import { useToast } from "./Toasts";
import {
  api,
  type CatalogueVideo,
  type DmButton,
  type DmCampaign,
  type DmCampaignLog,
  type ClientSummary,
} from "../lib/api";

/**
 * Comment-to-DM campaigns for one client.
 *
 * Instagram and Facebook only, and that is Meta's limit rather than ours: they
 * are the only platforms exposing both halves, the comment webhook and the DM
 * send. A campaign on TikTok or YouTube would save, look correct, and never
 * fire once, so those accounts are not offered.
 */
export default function DmCampaigns({ client }: { client: ClientSummary }) {
  const toast = useToast();
  const [campaigns, setCampaigns] = useState<DmCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<DmCampaignLog[] | null>(null);

  // The form.
  const eligible = client.accounts.filter(
    (a) => a.status === "connected" && (a.platform === "instagram" || a.platform === "facebook"),
  );
  const [accountId, setAccountId] = useState(eligible[0]?.id ?? "");
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [excludes, setExcludes] = useState("");
  const [matchMode, setMatchMode] = useState<"exact" | "contains" | "word">("contains");
  const [dmMessage, setDmMessage] = useState("");
  const [commentReply, setCommentReply] = useState("");
  const [alsoDms, setAlsoDms] = useState(false);
  const [linkTracking, setLinkTracking] = useState(true);
  const [buttonTitle, setButtonTitle] = useState("");
  const [buttonUrl, setButtonUrl] = useState("");
  const [scope, setScope] = useState<CatalogueVideo | null>(null);
  const [videos, setVideos] = useState<CatalogueVideo[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [videoSearch, setVideoSearch] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.get<{ campaigns: DmCampaign[] }>(
        `/clients/${client.id}/dm-campaigns`,
      );
      setCampaigns(r.campaigns);
    } catch (e) {
      setCampaigns([]);
      setError(e instanceof Error ? e.message : "could not load campaigns");
    }
  }, [client.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // The video list is only needed once the form is open, and only to scope a
  // campaign to one post. A client with no catalogue simply cannot scope.
  useEffect(() => {
    if (!open || videos !== null) return;
    api
      .get<{ videos: CatalogueVideo[] }>(`/clients/${client.id}/external/youtube/videos`)
      .then((r) => setVideos(r.videos))
      .catch(() => setVideos([]));
  }, [open, videos, client.id]);

  const reset = () => {
    setName("");
    setKeywords("");
    setExcludes("");
    setDmMessage("");
    setCommentReply("");
    setButtonTitle("");
    setButtonUrl("");
    setScope(null);
    setAlsoDms(false);
    setLinkTracking(true);
  };

  const create = async () => {
    const words = keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (!accountId || !name.trim() || !dmMessage.trim() || !words.length) return;
    const buttons: DmButton[] = [];
    if (buttonTitle.trim() && buttonUrl.trim()) {
      buttons.push({ type: "url", title: buttonTitle.trim(), url: buttonUrl.trim() });
    }
    setBusy(true);
    try {
      await api.post(`/clients/${client.id}/dm-campaigns`, {
        accountId,
        name: name.trim(),
        dmMessage: dmMessage.trim(),
        keywords: words,
        matchMode,
        excludeKeywords: excludes
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        ...(scope ? { platformPostId: scope.platformVideoId, postTitle: scope.title } : {}),
        ...(buttons.length ? { buttons } : {}),
        ...(commentReply.trim() ? { commentReply: commentReply.trim() } : {}),
        alsoMatchInDms: alsoDms,
        linkTracking,
      });
      toast.success("Campaign created.");
      reset();
      setOpen(false);
      await load();
    } catch (e) {
      toast.fail("Could not create the campaign", e);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (c: DmCampaign) => {
    try {
      await api.patch(`/clients/${client.id}/dm-campaigns/${c.id}`, { isActive: !c.isActive });
      await load();
    } catch (e) {
      toast.fail("Could not change the campaign", e);
    }
  };

  const remove = async (c: DmCampaign) => {
    try {
      await api.del(`/clients/${client.id}/dm-campaigns/${c.id}`);
      toast.success("Campaign deleted.");
      await load();
    } catch (e) {
      toast.fail("Could not delete the campaign", e);
    }
  };

  const showLogs = async (c: DmCampaign) => {
    if (logsFor === c.id) {
      setLogsFor(null);
      return;
    }
    setLogsFor(c.id);
    setLogs(null);
    try {
      const r = await api.get<{ logs: DmCampaignLog[] }>(
        `/clients/${client.id}/dm-campaigns/${c.id}/logs`,
      );
      setLogs(r.logs);
    } catch {
      setLogs([]);
    }
  };

  if (!eligible.length) {
    return (
      <div className="dmsec">
        <h3>DM campaigns</h3>
        <p className="lnote">
          Comment-to-DM needs an Instagram or Facebook account. Meta is the only platform that
          exposes both the comment webhook and the DM send, so a campaign on any other account
          would save and never fire.
        </p>
      </div>
    );
  }

  return (
    <div className="dmsec">
      <div className="dmhead">
        <h3>DM campaigns</h3>
        <span className="revtoggle" onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "New campaign"}
        </span>
      </div>
      <p className="lnote">
        Someone comments your keyword and gets a DM with your link. Scope one to a video and its
        sends land on that video's numbers, in the app and on the client's report.
      </p>

      {open && (
        <div className="dmform">
          <label className="flabel">Account</label>
          <Select
            value={accountId}
            onChange={setAccountId}
            aria-label="Account"
            options={eligible.map((a) => ({
              value: a.id,
              label: `${a.handle} (${a.platform})`,
            }))}
          />
          <label className="flabel" style={{ marginTop: 12 }}>
            Name<span className="hint">yours, not the client's; it never leaves the app</span>
          </label>
          <input
            className="field-in"
            placeholder="e.g. Free detailing guide"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="flabel" style={{ marginTop: 12 }}>
            Keywords<span className="hint">comma separated; any one of them triggers it</span>
          </label>
          <input
            className="field-in"
            placeholder="e.g. GUIDE, INFO, SEND IT"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
          <div className="dmgrid">
            <div>
              <label className="flabel" style={{ marginTop: 12 }}>
                Match
              </label>
              <Select
                value={matchMode}
                onChange={(v) => setMatchMode(v as "exact" | "contains" | "word")}
                aria-label="Match mode"
                options={[
                  { value: "contains", label: "Contains the keyword" },
                  { value: "word", label: "As a whole word" },
                  { value: "exact", label: "Exactly the keyword" },
                ]}
              />
            </div>
            <div>
              <label className="flabel" style={{ marginTop: 12 }}>
                Never match<span className="hint">optional</span>
              </label>
              <input
                className="field-in"
                placeholder="e.g. scam, spam"
                value={excludes}
                onChange={(e) => setExcludes(e.target.value)}
              />
            </div>
          </div>
          <label className="flabel" style={{ marginTop: 12 }}>
            The DM<span className="hint">what the commenter receives</span>
          </label>
          <textarea
            className="field-in"
            rows={3}
            maxLength={1000}
            placeholder="Thanks for commenting! Here is the guide I promised."
            value={dmMessage}
            onChange={(e) => setDmMessage(e.target.value)}
          />
          <div className="dmgrid">
            <div>
              <label className="flabel" style={{ marginTop: 12 }}>
                Button label<span className="hint">20 characters</span>
              </label>
              <input
                className="field-in"
                placeholder="Get the guide"
                maxLength={20}
                value={buttonTitle}
                onChange={(e) => setButtonTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="flabel" style={{ marginTop: 12 }}>
                Button link
              </label>
              <input
                className="field-in"
                placeholder="https://…"
                value={buttonUrl}
                onChange={(e) => setButtonUrl(e.target.value)}
              />
            </div>
          </div>
          <label className="flabel" style={{ marginTop: 12 }}>
            Public reply<span className="hint">optional, left on the comment itself</span>
          </label>
          <input
            className="field-in"
            placeholder="Sent! Check your DMs 📩"
            maxLength={2200}
            value={commentReply}
            onChange={(e) => setCommentReply(e.target.value)}
          />
          <label className="flabel" style={{ marginTop: 12 }}>
            Scope
            <span className="hint">
              a campaign on one video is what puts DM counts on that video's stats
            </span>
          </label>
          {scope ? (
            <div className="igrow">
              <span className="revtoggle on" onClick={() => setScope(null)}>
                {scope.title.slice(0, 48)} ✕
              </span>
            </div>
          ) : (
            <>
              <span className="revtoggle" onClick={() => setPickerOpen((v) => !v)}>
                {pickerOpen ? "Close list" : "Whole account · pick a video"}
              </span>
              {pickerOpen && (
                <div style={{ marginTop: 8 }}>
                  <input
                    className="field-in"
                    placeholder="Search the catalogue"
                    value={videoSearch}
                    onChange={(e) => setVideoSearch(e.target.value)}
                  />
                  <div style={{ maxHeight: 190, overflowY: "auto", marginTop: 6 }}>
                    {(videos ?? [])
                      .filter((v) =>
                        v.title.toLowerCase().includes(videoSearch.trim().toLowerCase()),
                      )
                      .slice(0, 30)
                      .map((v) => (
                        <div
                          key={v.platformVideoId}
                          className="rrow"
                          style={{ cursor: "pointer" }}
                          onClick={() => {
                            setScope(v);
                            setPickerOpen(false);
                          }}
                        >
                          <span className="t">{v.title}</span>
                        </div>
                      ))}
                    {videos !== null && !videos.length && (
                      <p className="lnote">No catalogue yet for this client.</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          <div className="igrow" style={{ marginTop: 12 }}>
            <span
              className={`revtoggle${alsoDms ? " on" : ""}`}
              onClick={() => setAlsoDms((v) => !v)}
            >
              <span className="knob" />
              Also answer people who DM the keyword
            </span>
            <span
              className={`revtoggle${linkTracking ? " on" : ""}`}
              onClick={() => setLinkTracking((v) => !v)}
            >
              <span className="knob" />
              Track link opens
            </span>
          </div>
          <button className="btn" disabled={busy} onClick={create} style={{ marginTop: 14 }}>
            {busy ? "Creating…" : "Create campaign"}
          </button>
        </div>
      )}

      {error && <p className="lnote">{error}</p>}
      {campaigns === null && <p className="lnote">Loading…</p>}
      {campaigns?.length === 0 && !open && (
        <p className="lnote">No campaigns yet.</p>
      )}

      {campaigns?.map((c) => (
        <div className="dmcard" key={c.id}>
          <div className="dmtop">
            <Pf p={PF_ID[c.platform]} />
            <span className="dmname">{c.name}</span>
            <span
              className={`revtoggle${c.isActive ? " on" : ""}`}
              onClick={() => void toggleActive(c)}
              title={c.isActive ? "Pause this campaign" : "Resume this campaign"}
            >
              <span className="knob" />
              {c.isActive ? "Live" : "Paused"}
            </span>
          </div>
          <div className="dmwords">
            {c.keywords.map((k) => (
              <span className="kw" key={k}>
                {k}
              </span>
            ))}
            <span className="dmscope">
              {c.postTitle ? `on "${c.postTitle.slice(0, 40)}"` : "whole account"}
            </span>
          </div>
          <div className="dmstats">
            <div>
              <b>{c.stats.triggered}</b>
              <span>triggered</span>
            </div>
            <div>
              <b>{c.stats.dmsSent}</b>
              <span>DMs sent</span>
            </div>
            <div>
              <b>{c.stats.uniqueContacts}</b>
              <span>people</span>
            </div>
            {c.linkTracking && (
              <div>
                <b>{c.stats.linkClicks}</b>
                <span>link opens</span>
              </div>
            )}
            {c.stats.dmsFailed > 0 && (
              <div className="bad">
                <b>{c.stats.dmsFailed}</b>
                <span>failed</span>
              </div>
            )}
            {/*
              Instagram emits no delivery receipt, so a zero here on an
              Instagram campaign means "not reported", not "nothing arrived".
              Shown only where the number can actually be true.
            */}
            {c.platform === "facebook" && (
              <div>
                <b>{c.stats.read}</b>
                <span>read</span>
              </div>
            )}
          </div>
          <div className="igrow">
            <span className="revtoggle" onClick={() => void showLogs(c)}>
              {logsFor === c.id ? "Hide leads" : "Leads"}
            </span>
            <span className="revtoggle" onClick={() => void remove(c)}>
              Delete
            </span>
          </div>
          {logsFor === c.id && (
            <div className="dmlogs">
              {logs === null && <p className="lnote">Loading…</p>}
              {logs?.length === 0 && <p className="lnote">Nobody has triggered this yet.</p>}
              {logs?.map((l) => (
                <div className="rrow" key={l.id}>
                  <span className="t">
                    {l.commenterName ?? l.commenterId ?? "someone"}
                    {l.commentText ? ` — "${l.commentText.slice(0, 48)}"` : ""}
                  </span>
                  <span className={`v${l.status === "failed" ? " bad" : ""}`}>
                    {l.status}
                    {l.source && l.source !== "comment" ? ` · ${l.source}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
