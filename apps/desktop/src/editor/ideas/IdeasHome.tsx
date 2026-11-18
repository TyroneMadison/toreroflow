import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { useIsPhone } from "../../lib/phone";
import { usePhoneBar } from "../../lib/phoneBar";
import { useToast } from "../../components/Toasts";
import Modal from "../../modals/Modal";
import type { NicheProfile } from "./NicheCard";
import SuperGenerate, { PlatformDot, useSuperRun, type SuperIdea as SuperIdeaT } from "./SuperGenerate";
import IdeaList from "./IdeaList";
import SavedIdeas from "./SavedIdeas";
import ShootPlan from "./ShootPlan";
import HookLibrary from "./HookLibrary";
import FormatPicker from "./FormatPicker";
import { Avatar, IdeaCard, Masthead, hookLine } from "./coralBits";
import BrainstormModal from "./BrainstormModal";
import { CREATOR_LINK_CAP, VIDEO_FORMATS, cleanCreatorLinks, parseCreatorLink } from "@toreroflow/core";
import "@fontsource-variable/fraunces/wght.css";
import "@fontsource-variable/fraunces/wght-italic.css";
import "./IdeasHome.css";
import "./coral.css";

/**
 * The Ideas area, in two tabs (approved mockups, 2026-10-15). Generate:
 * 1 · the niche and up to 15 creator channel links, saved per client on the
 * server; 2 · the three ways to make ideas: Brainstorm, Generate ideas, and
 * Super generate. Saved ideas: everything banked, one at a time, with the
 * full table under it.
 */

/** The content styles the generator picks formats from. */
const CATEGORIES: readonly string[] = VIDEO_FORMATS;

/** Shown one at a time while the model works. Plain, not a personality. */
const LOADING_LINES = [
  "Reading this brand's knowledge base",
  "Picking formats that suit the niche",
  "Writing hooks worth stopping for",
  "Throwing out the boring ones",
];

/** One generated format with the hooks written for this brand's niche. */
interface FormatCard {
  category: string;
  name: string;
  description: string;
  hooks: string[];
}

type Tab = "generate" | "saved" | "shoot" | "hooks" | "formats";

/** The five numbered tabs, each a page of the magazine with its own cover line. */
const TABS: Array<{ id: Tab; label: string; folio: string; h: [string, string]; lede: string }> = [
  { id: "generate", label: "Generate", folio: "02", h: ["Generate", "ideas"], lede: "Fresh ideas from your niche and the creators you follow, each tagged with its funnel stage, its difficulty and what you need to shoot it." },
  { id: "saved", label: "Saved ideas", folio: "09", h: ["Saved", "ideas"], lede: "Every idea you kept, with its script, its shots and where it sits in the funnel." },
  { id: "shoot", label: "Shoot plan", folio: "05", h: ["Shoot", "plan"], lede: "Your saved ideas grouped into filming sessions, so each setup gets used for more than one video." },
  { id: "hooks", label: "Hook library", folio: "06", h: ["Hook", "library"], lede: "Opening lines worth stealing: from your own best posts, from creators you follow and from what is trending on the web." },
  { id: "formats", label: "Formats", folio: "07", h: ["Format", "picker"], lede: "Seventeen formats and where each one lands in the funnel. Pick the ones you want the next generate to use." },
];

const NICHE_CAP = 200;

export default function IdeasHome({ clientId, focusSuper = false }: { clientId: string; focusSuper?: boolean }) {
  const toast = useToast();
  const superRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (focusSuper) superRef.current?.scrollIntoView({ block: "center" });
  }, [focusSuper]);
  const [tab, setTab] = useState<Tab>("generate");
  const [profile, setProfile] = useState<NicheProfile | null>(null);
  const [niche, setNiche] = useState("");
  const [creators, setCreators] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [capCents, setCapCents] = useState(200);
  const [chosen, setChosen] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [line, setLine] = useState(0);
  const [formats, setFormats] = useState<FormatCard[]>([]);
  const [openInfo, setOpenInfo] = useState<string | null>(null);
  // One name per card in flight, so two cards can each load more hooks at once.
  const [moreFor, setMoreFor] = useState<string[]>([]);
  // Hooks already banked, so a second press cannot double-save one.
  const [added, setAdded] = useState<string[]>([]);
  const [chat, setChat] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<"formats" | "super">("formats");
  const [starting, setStarting] = useState(false);
  const [savedFolio, setSavedFolio] = useState("09");
  const sg = useSuperRun(clientId);
  // Phones: the niche and creators edit in a sheet behind a summary card, the
  // format chips fold after seven, and a Super generate run is a deeper page.
  const isPhone = useIsPhone();
  const [editNiche, setEditNiche] = useState(false);
  const [allFormats, setAllFormats] = useState(false);

  useEffect(() => {
    let live = true;
    setDraft("");
    void (async () => {
      try {
        const [p, c] = await Promise.all([
          api.get<{ nicheProfile: NicheProfile | null }>(`/clients/${clientId}/niche-profile`),
          api.get<{ creators: string[]; capCents: number }>(`/clients/${clientId}/idea-creators`),
        ]);
        if (!live) return;
        setProfile(p.nicheProfile);
        setNiche((p.nicheProfile?.niche ?? "").slice(0, NICHE_CAP));
        setCreators(c.creators);
        setCapCents(c.capCents);
      } catch (err) {
        if (live) toast.fail("Could not load the niche and creators", err);
      }
    })();
    return () => {
      live = false;
    };
  }, [clientId, toast]);

  /** The niche is the niche profile's niche: one place, merged from the old card. */
  const saveNiche = async () => {
    const t = niche.trim();
    if (!t || t === (profile?.niche ?? "").trim()) return;
    try {
      const saved = await api.put<{ nicheProfile: NicheProfile | null }>(
        `/clients/${clientId}/niche-profile`,
        {
          niche: t,
          audience: profile?.audience?.trim() || undefined,
          outcome: profile?.outcome?.trim() || undefined,
          voiceTags: profile?.voiceTags ?? [],
          filming: profile?.filming ?? [],
          faceless: profile?.faceless ?? false,
        },
      );
      setProfile(saved.nicheProfile);
    } catch (err) {
      toast.fail("Could not save the niche", err);
    }
  };

  const saveCreators = async (next: string[], cap?: number) => {
    const clean = cleanCreatorLinks(next);
    setCreators(clean);
    try {
      const got = await api.put<{ creators: string[]; capCents: number }>(
        `/clients/${clientId}/idea-creators`,
        cap !== undefined ? { creators: clean, capCents: cap } : { creators: clean },
      );
      setCreators(got.creators);
      setCapCents(got.capCents);
    } catch (err) {
      toast.fail("Could not save the creators", err);
    }
  };

  const commitDraft = () => {
    if (!draft.trim()) return;
    const parts = draft.split(/[\s,]+/).filter(Boolean);
    void saveCreators([...creators, ...parts]);
    setDraft("");
  };

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setLine((n) => (n + 1) % LOADING_LINES.length), 3000);
    return () => clearInterval(t);
  }, [loading]);

  /**
   * Empty categories means the model picks the styles itself ("Pick for me").
   * Brainstorm sends the niche and creators along; the other buttons send
   * exactly what they always did.
   */
  const generate = async (
    categories: string[],
    extra?: { niche: string; inspirations: string[] },
  ) => {
    setLoading(true);
    setLine(0);
    setView("formats");
    try {
      const got = await api.post<{ formats: FormatCard[] }>(
        `/clients/${clientId}/generate-ideas`,
        extra ? { categories, ...extra } : { categories },
      );
      setFormats(got.formats);
      setOpenInfo(null);
    } catch (err) {
      toast.fail("Could not generate ideas", err);
    } finally {
      setLoading(false);
    }
  };

  const brainstorm = () => {
    void saveNiche();
    const handles = creators.map((c) => parseCreatorLink(c)?.handle ?? c).slice(0, 12);
    void generate(chosen, { niche: niche.trim(), inspirations: handles });
  };

  const superGenerate = async (creator?: string) => {
    setStarting(true);
    try {
      if (draft.trim()) {
        const parts = draft.split(/[\s,]+/).filter(Boolean);
        setDraft("");
        await saveCreators([...creators, ...parts]);
      }
      void saveNiche();
      const got = await api.post<{ run: SuperRunT }>(`/clients/${clientId}/super-generate`, creator ? { creator } : {});
      sg.setRun(got.run);
      setView("super");
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        toast.fail("Super generate needs a YouTube API key", err);
      } else {
        toast.fail("Could not start Super generate", err);
      }
    } finally {
      setStarting(false);
    }
  };

  const cancelSuper = async () => {
    if (!sg.run) return;
    try {
      const got = await api.post<{ run: SuperRunT }>(`/super-generate/${sg.run.id}/cancel`, {});
      sg.setRun(got.run);
    } catch (err) {
      toast.fail("Could not cancel", err);
    }
  };

  /** More hooks for one format only; the existing ones go along so they are not repeated. */
  const moreHooks = async (card: FormatCard) => {
    setMoreFor((cur) => [...cur, card.name]);
    try {
      const got = await api.post<{ formats: FormatCard[] }>(
        `/clients/${clientId}/generate-ideas`,
        {
          formatId: card.name,
          categories: card.category ? [card.category] : [],
          exclude: card.hooks,
        },
      );
      const extra = got.formats[0]?.hooks ?? [];
      setFormats((cur) =>
        cur.map((c) =>
          c.name === card.name
            ? { ...c, hooks: [...c.hooks, ...extra.filter((h) => !c.hooks.includes(h))] }
            : c,
        ),
      );
    } catch (err) {
      toast.fail("Could not write more hooks", err);
    } finally {
      setMoreFor((cur) => cur.filter((n) => n !== card.name));
    }
  };

  const bank = async (hook: string, formatName: string, source: string, scriptText?: string, creator?: string, shots?: Array<Record<string, string>>, funnelStage?: string, whyItWorks?: string, difficulty?: string, needs?: Array<{ type: string; label: string }>) => {
    try {
      await api.post(`/clients/${clientId}/ideas`, {
        text: hook,
        hook,
        formatName,
        // The ideas route caps the niche at 200 characters; the profile allows 2000.
        niche: (niche || profile?.niche || "").slice(0, 200),
        source,
        ...(scriptText ? { scriptText: scriptText.slice(0, 4000) } : {}),
        ...(creator ? { creator: creator.slice(0, 120) } : {}),
        ...(shots?.length ? { shots: shots.slice(0, 8) } : {}),
        ...(funnelStage === "top" || funnelStage === "middle" || funnelStage === "bottom" ? { funnelStage } : {}),
        ...(whyItWorks ? { whyItWorks: whyItWorks.slice(0, 400) } : {}),
        ...(difficulty === "easy" || difficulty === "medium" || difficulty === "hard" ? { difficulty } : {}),
        ...(needs?.length ? { needs: needs.slice(0, 4).map((n) => ({ type: n.type, label: n.label.slice(0, 40) })) } : {}),
      });
      setAdded((cur) => [...cur, hook]);
      setReloadKey((n) => n + 1);
      toast.success("Added to Saved ideas");
    } catch (err) {
      toast.fail("Could not save that idea", err);
    }
  };

  /* Quiet save vs skip feedback: a batch replaced by a new run counts its unsaved ideas as skipped. */
  const sendFeedback = (runId: string, ideas: SuperIdeaT[], saved: boolean) => {
    if (!ideas.length) return;
    void api.post(`/clients/${clientId}/idea-feedback`, {
      runId,
      events: ideas.slice(0, 40).map((i) => ({
        text: i.text.slice(0, 500),
        ...(i.format ? { format: i.format } : {}),
        ...(i.funnelStage ? { funnelStage: i.funnelStage } : {}),
        ...(i.label ? { hookStyle: i.label.slice(0, 120) } : {}),
        ...(i.creator ? { creator: i.creator.slice(0, 120) } : {}),
        saved,
      })),
    }).catch(() => undefined);
  };
  const lastBatch = useRef<{ id: string; ideas: SuperIdeaT[] } | null>(null);
  const addedRef = useRef<string[]>([]);
  addedRef.current = added;
  useEffect(() => {
    const r = sg.run;
    if (!r || r.status !== "ready") return;
    const prev = lastBatch.current;
    if (prev && prev.id !== r.id) {
      sendFeedback(prev.id, prev.ideas.filter((i) => !addedRef.current.includes(i.text)), false);
    }
    lastBatch.current = { id: r.id, ideas: r.ideas ?? [] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sg.run?.id, sg.run?.status]);

  const superBlocked = !sg.youtubeReady;
  const ytCount = creators.filter((c) => parseCreatorLink(c)?.platform === "youtube").length;

  const page = TABS.find((t) => t.id === tab)!;
  const phoneSuper = isPhone && tab === "generate" && view === "super" && !!sg.run;
  usePhoneBar(
    phoneSuper
      ? {
          title: "Super generate",
          back: () => setView("formats"),
          action: superBlocked ? undefined : (
            <button
              type="button"
              className="mb-btn sm text"
              disabled={starting || sg.run?.status === "running"}
              onClick={() => void superGenerate()}
            >
              Run again
            </button>
          ),
        }
      : null,
  );

  // The niche, the creators and the spending cap: the desktop's step 1 card,
  // and the phone's Edit sheet behind its summary card.
  const nicheForm = (
    <>
      <div className="cfield nichegap">
        <span className="lab">Niche</span>
        <input
          className="field-in"
          maxLength={NICHE_CAP}
          value={niche}
          placeholder="e.g. Exotic car rentals in New Jersey"
          onChange={(e) => setNiche(e.target.value)}
          onBlur={() => void saveNiche()}
        />
      </div>
      <div className="cfield nichegap">
        <span className="lab">Creators that inspire you</span>
        <div className="creatorlinks">
          {creators.map((c) => {
            const l = parseCreatorLink(c);
            return (
              <div className="creatorlink" key={c}>
                <PlatformDot platform={l?.platform ?? "other"} />
                <span className="creatorurl">{c}</span>
                {l?.platform !== "youtube" && <span className="creatornote">YouTube only for Super generate</span>}
                {l?.platform === "youtube" && !superBlocked && (
                  <button
                    type="button"
                    className="creatorgen"
                    title={`Study ${l.handle} and write ideas from them alone`}
                    disabled={starting || sg.run?.status === "running"}
                    onClick={() => void superGenerate(c)}
                  >
                    {sg.run?.status === "running" && sg.run.creators.length === 1 && sg.run.creators[0]?.url === c
                      ? "Generating..."
                      : "Generate"}
                  </button>
                )}
                <button
                  type="button"
                  className="chipx"
                  title={`Remove ${c}`}
                  onClick={() => void saveCreators(creators.filter((v) => v !== c))}
                >
                  ×
                </button>
              </div>
            );
          })}
          {creators.length < CREATOR_LINK_CAP && (
            <input
              className="field-in"
              value={draft}
              placeholder={`Paste creator channel link (${creators.length + 1} of ${CREATOR_LINK_CAP})`}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDraft();
                }
              }}
            />
          )}
          <span className="nichenote">
            {creators.length >= CREATOR_LINK_CAP ? `That is the most (${CREATOR_LINK_CAP})` : `+ Add creator · up to ${CREATOR_LINK_CAP}`}
          </span>
        </div>
      </div>
    </>
  );
  const capField = (
    <label className="sgcap">
      <span className="sub">Spending cap per run $</span>
      <input
        className="field-in"
        type="number"
        min={0.1}
        max={50}
        step={0.5}
        value={(capCents / 100).toFixed(2)}
        onChange={(e) => setCapCents(Math.round(Number(e.target.value) * 100) || 0)}
        onBlur={() => {
          const cap = Math.min(5000, Math.max(10, capCents));
          setCapCents(cap);
          void saveCreators(creators, cap);
        }}
      />
    </label>
  );

  // Phone Generate tab: the niche as one summary card (Edit opens a sheet),
  // then the ways to make ideas ranked, then the newest run's ideas.
  const ytCreators = creators.filter((c) => parseCreatorLink(c)?.platform === "youtube");
  const fmtShown = allFormats ? CATEGORIES : CATEGORIES.slice(0, 7);
  const capText = `${(capCents / 100).toFixed(2)} cap`;
  const phoneMake = (
    <>
      <section className="mb-card mb-niche" aria-label="Your niche and inspiration">
        <div className="mb-fhead">
          <span className="mb-lab">1 · Your niche and inspiration</span>
          <button type="button" className="mb-btn text" onClick={() => setEditNiche(true)}>
            {niche.trim() || creators.length ? "Edit" : "Add"}
          </button>
        </div>
        <b className="mb-nichet">{niche.trim() || "Add your niche and the creators you follow. Everything below writes from this."}</b>
        {creators.length > 0 && (
          <div className="mb-creators">
            <span className="mb-avs" aria-hidden="true">
              {creators.slice(0, 5).map((c) => (
                <Avatar key={c} handle={parseCreatorLink(c)?.handle ?? c} small />
              ))}
            </span>
            <small>
              {creators.length} {creators.length === 1 ? "creator" : "creators"}
              {ytCreators.length ? ` · ${ytCreators.length} on YouTube` : ""}
            </small>
          </div>
        )}
      </section>
      <section className="mb-card mb-make" aria-label="Make ideas">
        <span className="mb-lab">2 · Make ideas</span>
        <div className="mb-bigact">
          <button type="button" className="mb-btn pri" disabled={loading || !niche.trim()} onClick={brainstorm}>
            <span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-spark" />
              </svg>
              Brainstorm
            </span>
            <small>Quick ideas</small>
          </button>
          <button type="button" className="mb-btn" onClick={() => setChat(true)}>
            <span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-comment" />
              </svg>
              Chat
            </span>
            <small>Open brainstorm chat</small>
          </button>
        </div>
        <span ref={superRef} />
        {superBlocked ? (
          <div className="mb-banner warn">
            <span className="mb-bt">
              <b>Super generate needs a YouTube API key.</b> Add YOUTUBE_API_KEY on the server to turn it on.
            </span>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="mb-btn ghost block sgstart"
              disabled={starting || ytCount === 0 || sg.run?.status === "running"}
              onClick={() => void superGenerate()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <use href="#i-shuffle" />
              </svg>
              {sg.run?.status === "running" ? "Running..." : "Super generate"}
              <small>{ytCount === 0 ? "Add a YouTube channel first" : `${ytCount} ${ytCount === 1 ? "creator" : "creators"}, $${capText}`}</small>
            </button>
            {sg.run && (
              <button type="button" className="mb-btn text mb-lastrun" onClick={() => setView("super")}>
                Show last run
              </button>
            )}
          </>
        )}
        <div className="mb-fhead">
          <span className="mb-flab">Or pick a format</span>
          <button type="button" className="mb-btn text" disabled={loading} onClick={() => void generate([])}>
            Pick for me
          </button>
        </div>
        <div className="mb-fmts">
          {fmtShown.map((c) => (
            <button
              type="button"
              key={c}
              className={`mb-chip${chosen.includes(c) ? " on" : ""}`}
              aria-pressed={chosen.includes(c)}
              onClick={() => setChosen((cur) => (cur.includes(c) ? cur.filter((v) => v !== c) : [...cur, c]))}
            >
              {c}
            </button>
          ))}
          {!allFormats && CATEGORIES.length > 7 && (
            <button type="button" className="mb-chip out" onClick={() => setAllFormats(true)}>
              + {CATEGORIES.length - 7} more
            </button>
          )}
        </div>
        {chosen.length > 0 && (
          <button type="button" className="mb-btn block" disabled={loading} onClick={() => void generate(chosen)}>
            Find formats for {chosen.length} {chosen.length === 1 ? "pick" : "picks"}
          </button>
        )}
      </section>
      {editNiche && (
        <Modal maxWidth={520} onClose={() => setEditNiche(false)} label="Your niche and inspiration">
          <div className="modal-head">
            <div className="mb-ttl">
              <h3>Your niche</h3>
              <p>Everything Ideas writes starts here. Saved per client.</p>
            </div>
            <button type="button" className="modal-x" aria-label="Close" onClick={() => setEditNiche(false)}>
              <svg>
                <use href="#i-x" />
              </svg>
            </button>
          </div>
          <div className="modal-body mb-nicheform">
            {nicheForm}
            {capField}
          </div>
          <div className="modal-foot">
            <button
              type="button"
              className="mb-btn pri"
              onClick={() => {
                commitDraft();
                void saveNiche();
                setEditNiche(false);
              }}
            >
              Done
            </button>
          </div>
        </Modal>
      )}
    </>
  );
  const fresh = isPhone && !loading && formats.length === 0 && sg.run?.status === "ready" && sg.run.ideas.length > 0 ? sg.run.ideas : null;
  /** Banks a Super generate idea and counts it as saved for the run's feedback. */
  const addSuperIdea = (i: SuperIdeaT) => {
    sendFeedback(sg.run?.id ?? "", [i], true);
    void bank(i.text, i.format ? `${i.format} · ${i.label}` : i.label, "analysis", i.script, i.creator, i.shots, i.funnelStage, i.whyItWorks, i.difficulty, i.needs);
  };

  return (
    <div className="ideashome coral">
      {!phoneSuper && (
      <Masthead
        folio={tab === "saved" ? savedFolio : page.folio}
        word1={tab === "generate" && view === "super" && sg.run && sg.run.creators.length > 1 ? "Super" : page.h[0]}
        word2={tab === "generate" && view === "super" && sg.run && sg.run.creators.length > 1 ? "generate" : page.h[1]}
        lede={tab === "generate" && view === "super" && sg.run && sg.run.creators.length > 1
          ? "Ideas split evenly across all your creators, balanced across the funnel. Or let us pick one for you."
          : page.lede}
      />
      )}
      {!phoneSuper && (
      <nav className="co-tabs" role="tablist">
        {TABS.map((t, k) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "on" : ""}
            onClick={() => setTab(t.id)}
          >
            <small>{String(k + 1).padStart(2, "0")}</small>
            {t.label}
            {t.id === "saved" && added.length > 0 ? ` (+${added.length})` : ""}
          </button>
        ))}
      </nav>
      )}

      {tab === "hooks" ? (
        <HookLibrary clientId={clientId} onUsed={() => { setReloadKey((n) => n + 1); setTab("saved"); }} />
      ) : tab === "formats" ? (
        <FormatPicker chosen={chosen} setChosen={setChosen} onUse={() => setTab("generate")} />
      ) : tab === "shoot" ? (
        <ShootPlan clientId={clientId} reloadKey={reloadKey} />
      ) : tab === "saved" ? (
        <>
          <SavedIdeas clientId={clientId} reloadKey={reloadKey} onFolio={setSavedFolio} />
          <IdeaList clientId={clientId} niche={profile?.niche ?? ""} reloadKey={reloadKey} />
        </>
      ) : (
        <>
          {isPhone ? (
            !phoneSuper && phoneMake
          ) : (
          <div className="ideagrid">
            <div className="card glass ideacontext">
              <h3>1 · Your niche &amp; inspiration</h3>
              <div className="sub">Everything below writes from this. Saved per client.</div>
              {nicheForm}
            </div>

            <div className="card glass ideapicker">
              <h3>2 · Make ideas</h3>
              <div className="sub">Three ways in. Pick whichever fits.</div>

              <span className="lab sectlab">Brainstorm</span>
              <div className="sub">Quick ideas from your niche + creator names.</div>
              <div className="nicheactions tight">
                <button className="btn" disabled={loading || !niche.trim()} onClick={brainstorm}>
                  Brainstorm
                </button>
                <button className="btn ghost" onClick={() => setChat(true)}>
                  Open brainstorm chat
                </button>
              </div>

              <span className="lab sectlab">Generate ideas</span>
              <div className="nichechips">
                {CATEGORIES.map((c) => (
                  <button
                    type="button"
                    key={c}
                    className={`nchip${chosen.includes(c) ? " on" : ""}`}
                    onClick={() =>
                      setChosen((cur) =>
                        cur.includes(c) ? cur.filter((v) => v !== c) : [...cur, c],
                      )
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
              <div className="nicheactions tight">
                <button
                  className="btn"
                  disabled={loading || chosen.length === 0}
                  onClick={() => void generate(chosen)}
                >
                  Find formats
                </button>
                <button className="btn ghost" disabled={loading} onClick={() => void generate([])}>
                  Pick for me
                </button>
              </div>

              <span className="lab sectlab" ref={superRef}>Super generate</span>
              <div className="sub">
                Studies the last ~100 videos of every YouTube creator above (hook, framing,
                structure, script), then writes ideas in your niche.
              </div>
              {superBlocked ? (
                <div className="sgneedkey">
                  <b>Super generate needs a YouTube API key</b>
                  <span className="sub">Add YOUTUBE_API_KEY on the server to turn it on.</span>
                </div>
              ) : (
                <div className="nicheactions tight sgstart">
                  <button
                    className="btn sgbtn"
                    disabled={starting || ytCount === 0 || sg.run?.status === "running"}
                    onClick={() => void superGenerate()}
                  >
                    {sg.run?.status === "running" ? "✦ Running..." : "✦ Super generate"}
                  </button>
                  <span className="sub">
                    {ytCount === 0
                      ? "Add a YouTube channel link first"
                      : `${ytCount} creator${ytCount === 1 ? "" : "s"} · a few min first run, cached after`}
                  </span>
                  {sg.run && view !== "super" && (
                    <button className="mini" onClick={() => setView("super")}>
                      Show last run
                    </button>
                  )}
                </div>
              )}
              {capField}
            </div>
          </div>
          )}

          {view === "super" && sg.run ? (
            <SuperGenerate
              run={sg.run}
              onCancel={() => void cancelSuper()}
              onAdd={addSuperIdea}
              added={added}
              busy={starting || sg.run?.status === "running"}
              onRerun={(c) => void superGenerate(c)}
            />
          ) : (
            <>
              {loading && (
                <div className="card glass ideaload">
                  <b>{LOADING_LINES[line]}</b>
                  <div className="sub">Usually takes 15 to 30 seconds.</div>
                  <div className="skel ideabar" />
                </div>
              )}

              {formats.length > 0 && (
                <div className="stagger">
                  {formats.map((f) => (
                    <div className="fcard glass-sm" key={f.name}>
                      <div className="fhead">
                        <div className="fheadl">
                          <span className="chip fcat">{f.category}</span>
                          <b>{f.name}</b>
                        </div>
                        <button
                          className="mini"
                          onClick={() => setOpenInfo((cur) => (cur === f.name ? null : f.name))}
                        >
                          {openInfo === f.name ? "Less info" : "More info"}
                        </button>
                      </div>
                      {openInfo === f.name && <div className="fdesc">{f.description}</div>}
                      <div className="fhooks">
                        <span className="lab">Hooks for your niche</span>
                        {f.hooks.map((h) => (
                          <div className="hookrow" key={h}>
                            <span>{h}</span>
                            <button
                              className="cbtn"
                              disabled={added.includes(h)}
                              onClick={() => void bank(h, f.name, "brainstorm")}
                            >
                              {added.includes(h) ? "Added" : "+ Ideas"}
                            </button>
                          </div>
                        ))}
                        <button
                          className="btn ghost fmore"
                          disabled={moreFor.includes(f.name)}
                          onClick={() => void moreHooks(f)}
                        >
                          {moreFor.includes(f.name) ? "Writing..." : "Generate more hooks"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {fresh && (
                <>
                  <div className="mb-sechd">
                    <h2 className="mb-h2">From your last run</h2>
                    <small>
                      {fresh.length} {fresh.length === 1 ? "idea" : "ideas"}
                    </small>
                  </div>
                  {fresh.slice(0, 6).map((i, k) => (
                    <IdeaCard
                      key={i.text}
                      no={k + 1}
                      idea={{ title: i.text, creator: i.creator, funnelStage: i.funnelStage, difficulty: i.difficulty, needs: i.needs, hook: hookLine(i.script), why: i.whyItWorks, format: i.format || i.label }}
                      saved={added.includes(i.text)}
                      onSave={() => addSuperIdea(i)}
                    />
                  ))}
                  {fresh.length > 6 && (
                    <button type="button" className="mb-btn ghost block" onClick={() => setView("super")}>
                      See all {fresh.length} ideas from the run
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}

      {chat && (
        <BrainstormModal
          clientId={clientId}
          onClose={() => {
            setChat(false);
            setReloadKey((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

type SuperRunT = import("./SuperGenerate").SuperRun;
