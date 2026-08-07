import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import NicheCard, { type NicheProfile } from "./NicheCard";
import KnowledgeSection from "./KnowledgeSection";
import IdeaList from "./IdeaList";
import BrainstormModal from "./BrainstormModal";
import "./IdeasHome.css";

/**
 * The Ideas area, read top to bottom: the brand's niche, the material the
 * writers draw on, the two ways to make new ideas, and the saved list.
 */

/** The content styles the generator picks formats from. */
const CATEGORIES = [
  "Challenge",
  "Educational",
  "Storytelling",
  "Skits",
  "Wait for it",
  "Talking head POV",
];

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

export default function IdeasHome({ clientId }: { clientId: string }) {
  const toast = useToast();
  const [profile, setProfile] = useState<NicheProfile | null>(null);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [line, setLine] = useState(0);
  const [formats, setFormats] = useState<FormatCard[]>([]);
  const [openInfo, setOpenInfo] = useState<string | null>(null);
  // One name per card in flight. A single slot cannot hold two, so starting a
  // second card re-enabled the first card's button mid request and the first
  // response to land cleared the second card's spinner.
  const [moreFor, setMoreFor] = useState<string[]>([]);
  // Hooks already banked, so a second press cannot double-save one.
  const [added, setAdded] = useState<string[]>([]);
  const [chat, setChat] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setLine((n) => (n + 1) % LOADING_LINES.length), 3000);
    return () => clearInterval(t);
  }, [loading]);

  /** Empty categories means the model picks the styles itself ("Pick for me"). */
  const generate = async (categories: string[]) => {
    setPicking(false);
    setLoading(true);
    setLine(0);
    try {
      const got = await api.post<{ formats: FormatCard[] }>(
        `/clients/${clientId}/generate-ideas`,
        { categories },
      );
      setFormats(got.formats);
      setOpenInfo(null);
    } catch (err) {
      toast.fail("Could not generate ideas", err);
    } finally {
      setLoading(false);
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

  const addIdea = async (card: FormatCard, hook: string) => {
    try {
      await api.post(`/clients/${clientId}/ideas`, {
        text: hook,
        hook,
        formatName: card.name,
        // The ideas route caps the niche at 200 characters; the profile allows 2000.
        niche: (profile?.niche ?? "").slice(0, 200),
        source: "brainstorm",
      });
      setAdded((cur) => [...cur, hook]);
      setReloadKey((n) => n + 1);
    } catch (err) {
      toast.fail("Could not save that idea", err);
    }
  };

  return (
    <div className="ideashome">
      <NicheCard clientId={clientId} onProfile={setProfile} />

      <KnowledgeSection clientId={clientId} />

      <div className="ideabuttons">
        <button className="btn ghost" onClick={() => setChat(true)}>
          Brainstorm
        </button>
        <button className="btn" disabled={loading} onClick={() => setPicking((p) => !p)}>
          Generate ideas
        </button>
      </div>

      {picking && (
        <div className="card glass ideapicker">
          <h3>Pick a content style</h3>
          <div className="sub">
            Choose the kinds of video this brand should try, or let the studio choose.
          </div>
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
          <div className="nicheactions">
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
            <button className="btn ghost" onClick={() => setPicking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

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
                      onClick={() => void addIdea(f, h)}
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

      <IdeaList clientId={clientId} niche={profile?.niche ?? ""} reloadKey={reloadKey} />

      {chat && (
        <BrainstormModal
          clientId={clientId}
          onClose={() => {
            setChat(false);
            // The chat can bank ideas of its own, so the list re-reads on close.
            setReloadKey((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
