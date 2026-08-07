import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";

/**
 * The brand's niche profile: one card that shows what this brand is about, and
 * expands into the form that sets it.
 *
 * Everything the studio writes (formats, hooks, scripts, the analyzer's
 * spin-offs) is grounded on this, so it sits at the top of the Ideas area and
 * asks for itself when it is empty.
 */

export interface NicheProfile {
  niche: string;
  audience?: string;
  outcome?: string;
  voiceTags?: string[];
  filming?: string[];
  faceless?: boolean;
}

/** The eleven voices a brand can pick from, at most three at once. */
const VOICE_TAGS = [
  "Funny",
  "Educational",
  "Relatable",
  "Authentic",
  "Aspirational",
  "Edgy",
  "Wholesome",
  "Honest",
  "Casual",
  "Polished",
  "Conversational",
];
const VOICE_CAP = 3;

const FILMING = [
  "Just you",
  "You and a partner",
  "You and family",
  "You and a friend",
  "Nobody on camera",
];

/** Starters for a brand that has written nothing yet. Filling the field beats a blank page. */
const EXAMPLES = [
  "Home cooking for people who hate cooking",
  "Truck detailing, before and after",
  "First-time home buyers in Texas",
  "Strength training for busy parents",
];

/** A niche shorter than this is not enough for the writer to work from. */
const NICHE_MIN = 20;

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export default function NicheCard({
  clientId,
  onProfile,
}: {
  clientId: string;
  /** Called on load and after every save. Must be stable, e.g. a useState setter. */
  onProfile(profile: NicheProfile | null): void;
}) {
  const toast = useToast();
  const [profile, setProfile] = useState<NicheProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<NicheProfile>({ niche: "" });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const got = await api.get<{ nicheProfile: NicheProfile | null }>(
          `/clients/${clientId}/niche-profile`,
        );
        if (!live) return;
        setProfile(got.nicheProfile);
        onProfile(got.nicheProfile);
        setFailed(false);
      } catch (err) {
        if (live) {
          setFailed(true);
          toast.fail("Could not load the niche", err);
        }
      } finally {
        if (live) setLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [clientId, onProfile, toast, attempt]);

  const open = (niche?: string) => {
    setForm(niche !== undefined ? { ...(profile ?? {}), niche } : (profile ?? { niche: "" }));
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.put<{ nicheProfile: NicheProfile | null }>(
        `/clients/${clientId}/niche-profile`,
        {
          niche: form.niche.trim(),
          audience: form.audience?.trim() || undefined,
          outcome: form.outcome?.trim() || undefined,
          voiceTags: form.voiceTags ?? [],
          filming: form.filming ?? [],
          faceless: form.faceless ?? false,
        },
      );
      setProfile(saved.nicheProfile);
      onProfile(saved.nicheProfile);
      setEditing(false);
      toast.success("Niche saved");
    } catch (err) {
      toast.fail("Could not save the niche", err);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return <div className="skel nicheskel" />;

  // A load that failed is not a brand without a niche. Falling through to the
  // empty state would invite an edit, and a save sends the whole record, so a
  // form seeded from nothing would write over the audience, voice and filming
  // that are sitting in the database perfectly intact.
  if (failed) {
    return (
      <div className="card glass nichecard">
        <div className="nicherow">
          <div className="nichetext">
            <span className="lab">Your niche</span>
            <div className="sub">This did not load, so it is not safe to edit yet.</div>
          </div>
          <button className="btn ghost" type="button" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!editing) {
    const tags = profile?.voiceTags ?? [];
    return (
      <div className="card glass nichecard">
        <div className="nicherow">
          <div className="nichetext">
            <span className="lab">Your niche</span>
            {profile?.niche ? (
              <b>{profile.niche}</b>
            ) : (
              <div className="sub">Tell the studio what this brand is about.</div>
            )}
            {tags.length > 0 && (
              <div className="nichechips small">
                {tags.map((t) => (
                  <span className="nchip on" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button className="iconbtn" title="Edit the niche" onClick={() => open()}>
            <svg viewBox="0 0 24 24" className="nicheicon">
              <use href="#i-pencil" />
            </svg>
          </button>
        </div>
        {!profile?.niche && (
          <div className="nichechips exchips">
            {EXAMPLES.map((e) => (
              <button className="nchip" type="button" key={e} onClick={() => open(e)}>
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const nicheLen = form.niche.trim().length;
  const voice = form.voiceTags ?? [];
  const filming = form.filming ?? [];

  return (
    <div className="card glass nicheedit">
      <div className="rowhead">
        <div>
          <h3>Your niche</h3>
          <div className="sub">
            Everything the studio writes for this brand starts from what you put here.
          </div>
        </div>
        <button className="iconbtn" title="Close" onClick={() => setEditing(false)}>
          <svg viewBox="0 0 24 24" className="nicheicon">
            <use href="#i-x" />
          </svg>
        </button>
      </div>

      <div className="cfield">
        <span className="lab">Niche</span>
        <textarea
          className="field-in nichearea"
          maxLength={2000}
          value={form.niche}
          placeholder="What this brand posts about, and who it is for."
          onChange={(e) => setForm({ ...form, niche: e.target.value })}
        />
        <div className="nichecount">
          <span className={nicheLen >= NICHE_MIN ? "ok" : ""}>
            {nicheLen >= NICHE_MIN ? "Looks good" : `At least ${NICHE_MIN} characters`}
          </span>
          <span>{form.niche.length}/2000</span>
        </div>
      </div>

      <div className="cfield nichegap">
        <span className="lab">Who it is for</span>
        <input
          className="field-in"
          maxLength={2000}
          value={form.audience ?? ""}
          placeholder="The people this brand is talking to."
          onChange={(e) => setForm({ ...form, audience: e.target.value })}
        />
      </div>

      <div className="cfield nichegap">
        <span className="lab">What viewers get</span>
        <input
          className="field-in"
          maxLength={2000}
          value={form.outcome ?? ""}
          placeholder="What someone walks away with after watching."
          onChange={(e) => setForm({ ...form, outcome: e.target.value })}
        />
      </div>

      <div className="cfield nichegap">
        <span className="lab">Voice</span>
        <div className="nichechips">
          {VOICE_TAGS.map((t) => {
            const on = voice.includes(t);
            // At the cap the unpicked ones stop being choices, rather than
            // failing silently when a fourth is clicked.
            const capped = !on && voice.length >= VOICE_CAP;
            return (
              <button
                type="button"
                key={t}
                className={`nchip${on ? " on" : ""}${capped ? " off" : ""}`}
                disabled={capped}
                onClick={() => setForm({ ...form, voiceTags: toggle(voice, t) })}
              >
                {t}
              </button>
            );
          })}
        </div>
        <span className="nichenote">Pick up to three.</span>
      </div>

      <div className="cfield nichegap">
        <span className="lab">Who films with you</span>
        <div className="nichechips">
          {FILMING.map((f) => (
            <button
              type="button"
              key={f}
              className={`nchip${filming.includes(f) ? " on" : ""}`}
              onClick={() => setForm({ ...form, filming: toggle(filming, f) })}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="toggles">
        <div
          className={`pt${form.faceless ? " on" : ""}`}
          onClick={() => setForm({ ...form, faceless: !form.faceless })}
        >
          <span className="switch" />
          <div className="info">
            <b>Nobody is on camera</b>
            <span>Voiceover, screen recordings and b-roll only.</span>
          </div>
        </div>
      </div>

      <div className="nicheactions">
        <button className="btn" disabled={saving || nicheLen < NICHE_MIN} onClick={() => void save()}>
          {saving ? "Saving..." : "Save niche"}
        </button>
        <button className="btn ghost" disabled={saving} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
