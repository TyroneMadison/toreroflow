import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DM_TRIGGER_LABEL,
  DM_TRIGGERS,
  fillText,
  keywordHit,
  pickVariant,
  type DmAutomationConfig,
  type DmAutomationOverlap,
  type DmAutomationView,
  type DmTrigger,
} from "@toreroflow/core";
import Pf from "../Pf";
import { Sheet } from "../analytics/phoneBits";
import { useToast } from "../Toasts";
import { api, ApiError, type ClientSummary } from "../../lib/api";
import { useIsPhone } from "../../lib/phone";
import { usePageHead } from "../../lib/pageHead";
import { usePhoneBar } from "../../lib/phoneBar";
import { automationPath, navigate, navigatePath } from "../../lib/routes";
import { PF_ID } from "../../lib/platforms";
import { tone } from "../../lib/inbox";
import {
  dmSummary,
  matchExample,
  optionsSummary,
  pct,
  publicSummary,
  rowState,
  since,
  TRIGGER_ICON,
  whenSummary,
  type AutoAccount,
  type AutomationsList,
} from "../../lib/automations";
import { useAppState } from "../../state/AppState";
import { CouldNotLoad, Dialog, I, KwBox, PostPicker, Skeleton, StatePill } from "./parts";

/**
 * The automation editor (F4, round 2 mockup 02): four steps, only the one you
 * are on open (When, Reply in public, Send the DM, Options), with the preview,
 * Test it and the numbers beside them. Every change saves as a draft after a
 * moment; people get the published version until Publish. The phone opens the
 * DM, the post picker and Never match in sheets. Viewers read only.
 */

type StepId = 1 | 2 | 3 | 4;
const n0 = (n: number) => n.toLocaleString("en-US");
const SAVE_MS = 700;

export default function AutomationEditor({ client, id }: { client: ClientSummary; id: string }) {
  const isPhone = useIsPhone();
  const toast = useToast();
  const { user } = useAppState();
  const viewer = user?.role === "viewer";
  const [a, setA] = useState<DmAutomationView | null>(null);
  const [cfg, setCfg] = useState<DmAutomationConfig | null>(null);
  const [overlaps, setOverlaps] = useState<DmAutomationOverlap[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [meta, setMeta] = useState<Pick<AutomationsList, "accounts" | "nativeConfigured" | "zernioConfigured"> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "error">("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [step, setStep] = useState<StepId | 0>(1);
  const [sheet, setSheet] = useState<null | "dm" | "posts" | "never" | "test" | "actions" | "rename" | "folder" | "publish">(null);
  const [neverOpen, setNeverOpen] = useState(false);
  const [pvTab, setPvTab] = useState<"post" | "dms">("dms");
  const [tryText, setTryText] = useState("");
  const [tryRes, setTryRes] = useState<{ matched: boolean; keyword: string | null; reason: string | null } | null>(null);
  const [menu, setMenu] = useState(false);
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<number | null>(null);
  const tryInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [one, list] = await Promise.all([
        api.get<{ automation: DmAutomationView; overlaps: DmAutomationOverlap[]; problems: string[] }>(`/clients/${client.id}/dm/automations/${id}`),
        api.get<AutomationsList>(`/clients/${client.id}/dm/automations`),
      ]);
      setA(one.automation);
      setCfg(one.automation.config);
      setOverlaps(one.overlaps);
      setProblems(one.problems);
      setMeta({ accounts: list.accounts, nativeConfigured: list.nativeConfigured, zernioConfigured: list.zernioConfigured });
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 404 ? "gone" : e instanceof Error ? e.message : "could not load the automation");
    }
  }, [client.id, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const body = pending.current;
    if (!Object.keys(body).length) return true;
    pending.current = {};
    setSaving("saving");
    try {
      const r = await api.patch<{ automation: DmAutomationView; problems: string[] }>(`/clients/${client.id}/dm/automations/${id}`, body);
      setA(r.automation);
      setProblems(r.problems);
      setSaving("idle");
      setSavedAt(new Date());
      return true;
    } catch (e) {
      setSaving("error");
      toast.fail("Could not save the draft", e);
      return false;
    }
  }, [client.id, id, toast]);
  // Leaving the editor saves what is left.
  useEffect(() => () => void flush(), [flush]);

  /** A change: on screen now, saved as a draft a moment later. */
  const edit = (patch: Partial<DmAutomationConfig> & { name?: string; folder?: string | null; socialAccountId?: string }) => {
    if (viewer) return;
    const { name, folder, socialAccountId, ...c } = patch;
    if (Object.keys(c).length) setCfg((x) => (x ? { ...x, ...c } : x));
    if (name !== undefined || folder !== undefined || socialAccountId !== undefined) setA((x) => (x ? { ...x, ...(name !== undefined ? { name } : {}), ...(folder !== undefined ? { folder } : {}), ...(socialAccountId ? { socialAccountId } : {}) } : x));
    pending.current = { ...pending.current, ...patch };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_MS);
  };

  const accounts: AutoAccount[] = meta?.accounts ?? [];
  const acc = a ? accounts.find((x) => x.accountId === a.socialAccountId) : undefined;
  const handle = a?.accountHandle ?? acc?.handle ?? "";
  const state = a ? rowState(a) : "draft";
  const step0 = cfg?.steps[0] ?? { type: "message" as const, text: "", button: null };
  const isComment = cfg?.trigger === "comment";
  const needsKw = cfg ? cfg.trigger === "comment" || cfg.trigger === "dm_keyword" || cfg.trigger === "story_reply" : false;

  const setStep0 = (p: Partial<typeof step0>) => edit({ steps: [{ ...step0, ...p }] });

  const getCode = async () => {
    try {
      const r = await api.post<{ code: string; expiresAt: string; note: string | null }>(`/clients/${client.id}/dm/automations/${id}/test-code`);
      setA((x) => (x ? { ...x, testCode: r.code, testCodeExpiresAt: r.expiresAt } : x));
      if (r.note) toast.success(r.note);
    } catch (e) {
      toast.fail("Could not get a test code", e);
    }
  };
  const dryRun = async () => {
    if (!cfg) return;
    await flush();
    try {
      const kind = cfg.trigger === "comment" ? "comment" : cfg.trigger === "story_reply" ? "story_reply" : cfg.trigger === "story_mention" ? "story_mention" : cfg.trigger === "welcome" ? "first_dm" : "dm";
      setTryRes(await api.post(`/clients/${client.id}/dm/automations/${id}/test`, { kind, text: tryText }));
    } catch (e) {
      toast.fail("Could not run the test", e);
    }
  };
  const setStatus = async (status: "live" | "paused") => {
    try {
      const r = await api.post<{ automation: DmAutomationView }>(`/clients/${client.id}/dm/automations/${id}/status`, { status });
      setA(r.automation);
    } catch (e) {
      toast.fail(status === "live" ? "Could not turn it on" : "Could not turn it off", e);
    }
  };
  const duplicate = async () => {
    await flush();
    try {
      const r = await api.post<{ automation: { id: string } }>(`/clients/${client.id}/dm/automations/${id}/duplicate`);
      navigatePath(automationPath(r.automation.id));
    } catch (e) {
      toast.fail("Could not duplicate it", e);
    }
  };
  const remove = async () => {
    try {
      await api.del(`/clients/${client.id}/dm/automations/${id}`);
      toast.success(`${a?.name ?? "It"} is in the trash.`, { label: "Undo", run: () => void api.post(`/clients/${client.id}/dm/automations/${id}/restore`) });
      navigate("workflows", "automations");
    } catch (e) {
      toast.fail("Could not delete it", e);
    }
  };
  const startPublish = async () => {
    if (!(await flush())) return;
    const fresh = await api.get<{ automation: DmAutomationView; overlaps: DmAutomationOverlap[]; problems: string[] }>(`/clients/${client.id}/dm/automations/${id}`).catch(() => null);
    if (fresh) {
      setA(fresh.automation);
      setOverlaps(fresh.overlaps);
      setProblems(fresh.problems);
      if (fresh.problems.length) {
        toast.error(fresh.problems[0]!);
        setStep(fresh.problems[0]!.startsWith("Write the DM") ? 3 : fresh.problems[0]!.includes("public") ? 2 : 1);
        if (isPhone && fresh.problems[0]!.startsWith("Write the DM")) setSheet("dm");
        return;
      }
    }
    setSheet("publish");
  };
  const publish = async (engine: "native" | "zernio", pauseCampaignIds: string[]) => {
    setSheet(null);
    try {
      const r = await api.post<{ automation?: DmAutomationView; movedTo?: string }>(`/clients/${client.id}/dm/automations/${id}/publish`, { engine, pauseCampaignIds });
      if (r.movedTo === "zernio") {
        toast.success(`${a?.name} now runs at Zernio. Move it here once Instagram is connected.`);
        navigate("workflows", "automations");
        return;
      }
      setA(r.automation!);
      setStep(0);
      toast.success(pauseCampaignIds.length ? "Published, and the Zernio campaign is paused." : "Published.");
    } catch (e) {
      toast.fail("Could not publish", e);
    }
  };

  // Header: name and state, then More, Test it, Publish (mockup 02).
  const publishLabel = !a ? "Publish" : a.status === "draft" ? "Publish" : a.hasUnpublished ? "Publish changes" : a.status === "paused" ? "Turn on" : "Published";
  const publishDisabled = !a || viewer || (a.status === "live" && !a.hasUnpublished);
  const onPublishClick = () => (a && a.status === "paused" && !a.hasUnpublished ? void setStatus("live") : void startPublish());
  const sub = !a
    ? ""
    : saving === "saving"
      ? "Saving..."
      : saving === "error"
        ? "Not saved. Check the connection and change something to try again."
        : a.status === "draft"
          ? `Draft${savedAt ? `, saved ${since(savedAt.toISOString())}` : `, edited ${since(a.updatedAt)}`}. Nothing sends until you publish.`
          : a.hasUnpublished
            ? `Changes saved as a draft ${since((savedAt ?? new Date(a.updatedAt)).toISOString())}. People still get the live version until you publish.`
            : a.status === "paused"
              ? "Off. Nobody gets it until you turn it on."
              : (a.waiting ?? "Live. People get this version.");
  usePageHead(
    a
      ? isPhone
        ? { title: a.name, crumb: "Automations" }
        : {
            crumb: "Automations",
            title: (
              <>
                {a.name} <StatePill state={state} />
              </>
            ),
            sub,
            controls: (
              <>
                <span style={{ position: "relative" }}>
                  <button type="button" className="au-hbtn icon" aria-label="More: duplicate, turn off, folder, rename, delete" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} data-testid="automation.more">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <use href="#i-dots-h" />
                    </svg>
                  </button>
                  {menu && <EditorMenu viewer={viewer} a={a} onClose={() => setMenu(false)} onRename={() => setSheet("rename")} onFolder={() => setSheet("folder")} onDuplicate={() => void duplicate()} onStatus={(s) => void setStatus(s)} onDelete={() => void remove()} />}
                </span>
                <button
                  type="button"
                  className="au-hbtn"
                  onClick={() => {
                    tryInput.current?.focus();
                    tryInput.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-beaker" />
                  </svg>
                  Test it
                </button>
                {!viewer && (
                  <button type="button" className="au-hbtn pri" disabled={publishDisabled} onClick={onPublishClick} data-testid="automation.publish">
                    {publishLabel}
                  </button>
                )}
              </>
            ),
          }
      : null,
  );
  usePhoneBar(isPhone ? { title: "Automation", back: () => navigate("workflows", "automations") } : null);

  const wrap = isPhone ? "ibx-wrap ph au au-ed" : "ibx-wrap au au-ed";
  if (err === "gone") {
    return (
      <div className={wrap} data-testid="automation-editor" data-state="gone">
        <section className={isPhone ? "mb-card ibx-empty" : "au-card ibx-empty"}>
          <span className="ei">
            <I name="i-bolt" />
          </span>
          <h3>This automation is gone</h3>
          <p>It was deleted, or it belongs to another brand.</p>
          <div className="acts">
            <button type="button" className={isPhone ? "mb-btn block" : "ibx-btn"} onClick={() => navigate("workflows", "automations")}>
              Back to Automations
            </button>
          </div>
        </section>
      </div>
    );
  }
  if (!a || !cfg) {
    return (
      <div className={wrap} data-testid="automation-editor" data-state={err ? "error" : "loading"}>
        {err ? <CouldNotLoad phone={isPhone} lastLoaded={null} onRetry={() => void load()} what="the automation" /> : <Skeleton phone={isPhone} label="Loading the automation" />}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Pieces shared by desktop and phone
  // ---------------------------------------------------------------------------
  const triggerOptions = DM_TRIGGERS.filter((t) => acc?.platform !== "facebook" || t === "comment");
  const stepOneBody = (
    <>
      <div className={isPhone ? "au-fields" : "au-two"}>
        <div className="au-field">
          <label htmlFor="au-acc">Account</label>
          <span className="au-select">
            {acc && <Pf p={PF_ID[acc.platform]} size="xs" />}
            <select id="au-acc" value={a.socialAccountId} disabled={viewer || a.status !== "draft"} title={a.status !== "draft" ? "A published automation stays on its account. Duplicate it to use another." : undefined} onChange={(e) => edit({ socialAccountId: e.target.value, scope: "all", postIds: [] })}>
              {accounts.map((x) => (
                <option key={x.accountId} value={x.accountId}>
                  {x.platform === "facebook" ? `${x.handle} (Messenger)` : `@${x.handle}`}
                </option>
              ))}
            </select>
            <I name="i-chev" className="chev" />
          </span>
        </div>
        <div className="au-field">
          <label htmlFor="au-trig">Trigger</label>
          <span className="au-select">
            <I name={TRIGGER_ICON[cfg.trigger]} />
            <select
              id="au-trig"
              value={cfg.trigger}
              disabled={viewer}
              onChange={(e) => {
                const t = e.target.value as DmTrigger;
                edit({ trigger: t, ...(t === "welcome" || t === "story_mention" ? { matchMode: "any" } : t === "dm_keyword" && cfg.matchMode === "any" ? { matchMode: "contains" } : {}) });
              }}
            >
              {triggerOptions.map((t) => (
                <option key={t} value={t}>
                  {DM_TRIGGER_LABEL[t]}
                </option>
              ))}
            </select>
            <I name="i-chev" className="chev" />
          </span>
        </div>
      </div>
      {needsKw && (
        <>
          <div className="au-field">
            <span className="flab">{cfg.trigger === "comment" ? "Comment contains" : cfg.trigger === "dm_keyword" ? "DM contains" : "Story reply contains (optional)"}</span>
            <KwBox value={cfg.keywords} disabled={viewer} phone={isPhone} label="Add a keyword" placeholder={cfg.trigger === "story_reply" ? "Leave empty to answer every story reply" : "Add a keyword, then press Enter"} onChange={(keywords) => edit({ keywords, ...(keywords.length && cfg.matchMode === "any" ? { matchMode: "contains" } : {}) })} />
            <p className="au-help">{isPhone ? "Capital letters do not matter." : "Capital letters do not matter. Up to 20 keywords."}</p>
          </div>
          <div className={isPhone ? "au-field" : "au-matchrow"}>
            {isPhone && <span className="flab">Match</span>}
            <div className={isPhone ? "ibx-seg ph" : "ibx-seg"} role="radiogroup" aria-label="Match">
              {(
                [
                  ["contains", "Contains"],
                  ["word", "Whole word"],
                  ["exact", "Exact"],
                  ...(cfg.trigger === "dm_keyword" ? [] : [["any", "Any"]]),
                ] as Array<[DmAutomationConfig["matchMode"], string]>
              ).map(([m, label]) => (
                <button key={m} type="button" role="radio" aria-checked={cfg.matchMode === m} className={cfg.matchMode === m ? "on" : undefined} disabled={viewer} onClick={() => edit({ matchMode: m })}>
                  {label}
                </button>
              ))}
            </div>
            {!isPhone && <span className="au-help">{matchExample(cfg)}</span>}
          </div>
        </>
      )}
      {(isComment || needsKw) && (
        <div>
          {isComment &&
            (isPhone ? (
              <button type="button" className="au-linkrow" onClick={() => setSheet("posts")} disabled={viewer || acc?.platform !== "instagram"}>
                <span className="k">Which posts</span>
                <span className="v">{scopeLabel(cfg)}</span>
                <I name="i-chev-r" className="chev" />
              </button>
            ) : (
              <div className="au-inl">
                <span className="k">Which posts</span>
                <span className="v">{scopeText(cfg)}</span>
                {!viewer && acc?.platform === "instagram" && (
                  <button type="button" className="ibx-btn ghost" onClick={() => setSheet("posts")} data-testid="automation.change-posts">
                    Change
                  </button>
                )}
              </div>
            ))}
          {needsKw &&
            (isPhone ? (
              <button type="button" className="au-linkrow" onClick={() => setSheet("never")} disabled={viewer}>
                <span className="k">Never match</span>
                <span className="v">{cfg.excludeKeywords.length ? cfg.excludeKeywords.map((k) => <span className="au-kw" key={k}>{k}</span>) : <span className="muted">Nothing</span>}</span>
                <I name="i-chev-r" className="chev" />
              </button>
            ) : (
              <>
                <div className="au-inl">
                  <span className="k">Never match</span>
                  <span className="v">
                    {cfg.excludeKeywords.length ? cfg.excludeKeywords.map((k) => <span className="au-kw" key={k}>{k}</span>) : <span className="t3">Nothing</span>}
                  </span>
                  {!viewer && (
                    <button type="button" className="ibx-btn ghost" onClick={() => setNeverOpen((v) => !v)} aria-expanded={neverOpen}>
                      {neverOpen ? "Done" : "Edit"}
                    </button>
                  )}
                </div>
                {neverOpen && (
                  <div className="au-field">
                    <KwBox value={cfg.excludeKeywords} label="Add a word" placeholder="Add a word" onChange={(excludeKeywords) => edit({ excludeKeywords })} />
                    <p className="au-help">Comments with these words are skipped, even if a keyword matches.</p>
                  </div>
                )}
              </>
            ))}
        </div>
      )}
    </>
  );

  const publicBody = (
    <>
      <button type="button" className="au-optrow" role="switch" aria-checked={cfg.publicReplyOn} disabled={viewer || !isComment} onClick={() => edit({ publicReplyOn: !cfg.publicReplyOn, ...(!cfg.publicReplyOn && !cfg.publicReplies.length ? { publicReplies: ["Sent! Check your DMs"] } : {}) })}>
        <span className="lt">
          <b>Public reply under the comment</b>
          <small>{isComment ? "Tells everyone reading that the DM went out." : "Only comment automations reply in public."}</small>
        </span>
        <span className={`au-tog${cfg.publicReplyOn ? " on" : ""}`} aria-hidden="true" />
      </button>
      {cfg.publicReplyOn && isComment && (
        <>
          {cfg.publicReplies.map((v, i) => (
            <div key={i} className="au-variant">
              <span className="n">{i + 1}</span>
              <input
                className={isPhone ? "mb-input" : "au-input"}
                aria-label={`Public reply ${i + 1}`}
                maxLength={300}
                value={v}
                disabled={viewer}
                onChange={(e) => edit({ publicReplies: cfg.publicReplies.map((x, j) => (j === i ? e.target.value : x)) })}
                onBlur={() => edit({ publicReplies: cfg.publicReplies.map((x) => x.trim()).filter(Boolean) })}
              />
              {!viewer && cfg.publicReplies.length > 1 && (
                <button type="button" className={isPhone ? "mb-ib ghost" : "ibx-btn icon ghost"} aria-label={`Remove reply ${i + 1}`} onClick={() => edit({ publicReplies: cfg.publicReplies.filter((_, j) => j !== i) })}>
                  <I name="i-x" />
                </button>
              )}
            </div>
          ))}
          <div className="au-rowsb">
            <p className="au-help">One is picked at random each time, so the replies do not look copied.</p>
            {!viewer && cfg.publicReplies.length < 5 && (
              <button type="button" className="au-lnk" onClick={() => edit({ publicReplies: [...cfg.publicReplies, ""] })}>
                Add a variant
              </button>
            )}
          </div>
        </>
      )}
    </>
  );

  const dmFields = (
    <>
      <div className="au-field">
        <label htmlFor="au-msg">Message</label>
        <textarea id="au-msg" className={isPhone ? "mb-input au-text" : "au-text"} maxLength={1000} rows={isPhone ? 5 : 3} disabled={viewer} placeholder="Here is the guide I promised. Tap below and it opens right away." value={step0.text} onChange={(e) => setStep0({ text: e.target.value })} />
        <div className="au-rowsb">
          <span className="au-help">Plain text. Emoji are fine. {"{first_name}"} and {"{username}"} fill in.</span>
          <span className="au-count">{step0.text.length} of 1000</span>
        </div>
        {!viewer && (
          <div className="au-vars">
            <button type="button" className="ibx-btn ghost" onClick={() => setStep0({ text: `${step0.text}${step0.text && !step0.text.endsWith(" ") ? " " : ""}{first_name}` })}>
              + First name
            </button>
            <button type="button" className="ibx-btn ghost" onClick={() => setStep0({ text: `${step0.text}${step0.text && !step0.text.endsWith(" ") ? " " : ""}{username}` })}>
              + Username
            </button>
          </div>
        )}
      </div>
      <div className={isPhone ? "au-fields" : "au-two"}>
        <div className="au-field">
          <label htmlFor="au-btitle">Button label</label>
          <input
            id="au-btitle"
            className={isPhone ? "mb-input" : "au-input"}
            maxLength={20}
            placeholder="Open the guide"
            disabled={viewer}
            value={step0.button?.title ?? ""}
            onChange={(e) => setStep0({ button: e.target.value || step0.button?.url ? { title: e.target.value, url: step0.button?.url ?? "" } : null })}
          />
        </div>
        <div className="au-field">
          <label htmlFor="au-burl">Button link</label>
          <input
            id="au-burl"
            className={isPhone ? "mb-input mono" : "au-input mono"}
            type="url"
            inputMode="url"
            placeholder="https://"
            disabled={viewer}
            value={step0.button?.url ?? ""}
            onChange={(e) => setStep0({ button: e.target.value || step0.button?.title ? { title: step0.button?.title ?? "", url: e.target.value } : null })}
          />
        </div>
      </div>
      {step0.button && (!step0.button.title.trim() || !/^https:\/\/\S+\.\S+/.test(step0.button.url)) && <p className="au-help warn">A button needs a label and a link that starts with https://. Leave both empty for no button.</p>}
    </>
  );

  const optionRows = (
    <>
      {isComment && <OptRow label="Only send the link to followers" sub="Others are asked to follow first, then comment again" on={cfg.followersOnly} disabled={viewer} onChange={(v) => edit({ followersOnly: v })} />}
      <OptRow label="Track link opens" sub="Uses a short tracked link, so opens show up in the numbers" on={cfg.trackLinks} disabled={viewer} onChange={(v) => edit({ trackLinks: v })} />
      {isComment && <OptRow label="Also answer people who DM the keyword" sub={`Someone who sends ${cfg.keywords[0] ?? "the keyword"} in a DM gets the same message`} on={cfg.alsoDmKeyword} disabled={viewer || cfg.matchMode === "any"} onChange={(v) => edit({ alsoDmKeyword: v })} />}
      <OptRow label="Once per person" sub="Someone who triggers it again does not get it twice" on={cfg.oncePerContact} disabled={viewer} onChange={(v) => edit({ oncePerContact: v })} />
    </>
  );

  // A step done: it has what it needs.
  const done: Record<StepId, boolean> = {
    1: !needsKw || cfg.matchMode === "any" || cfg.keywords.length > 0 || cfg.trigger === "story_reply",
    2: !isComment || !cfg.publicReplyOn || cfg.publicReplies.some((x) => x.trim()),
    3: !!step0.text.trim(),
    4: true,
  };
  const steps: Array<{ id: StepId; title: string; summary: string; body: ReactNode; sheet?: "dm" }> = [
    { id: 1, title: "When this happens", summary: whenSummary(cfg, handle), body: stepOneBody },
    { id: 2, title: "Reply in public", summary: publicSummary(cfg), body: publicBody },
    { id: 3, title: "Send the DM", summary: dmSummary(cfg), body: dmFields, sheet: "dm" },
    { id: 4, title: "Options", summary: optionsSummary(cfg), body: optionRows },
  ];

  const sampleKw = cfg.keywords[0] ?? "GUIDE";
  const sampleText = fillText(step0.text || "Your message shows here.", { name: "Maya Rivera", username: "maya.sample" });
  const preview = (
    <section className="au-card" aria-label="Preview">
      <div className="sb">
        <div className="sect-t">
          <h3>Preview</h3>
        </div>
        {isComment && (
          <div className="ibx-seg" role="tablist" aria-label="Preview">
            <button type="button" role="tab" aria-selected={pvTab === "post"} className={pvTab === "post" ? "on" : undefined} onClick={() => setPvTab("post")}>
              On the post
            </button>
            <button type="button" role="tab" aria-selected={pvTab === "dms"} className={pvTab === "dms" ? "on" : undefined} onClick={() => setPvTab("dms")}>
              In their DMs
            </button>
          </div>
        )}
      </div>
      <div className="au-pv" data-testid="automation.preview">
        <div className="au-pv-h">
          <span className={`ibx-av ${tone(client.id)}`}>{client.name.slice(0, 2).toUpperCase()}</span>
          <b>{handle || client.name}</b>
          <small>{acc?.platform === "facebook" ? "Messenger" : "Instagram"}</small>
        </div>
        <div className="au-pv-b">
          {isComment && pvTab === "post" ? (
            <>
              <div className="au-cmt">
                <span className="ibx-av c2">M</span>
                <span>
                  <b>maya.sample</b>
                  {sampleKw} please!
                  <small>2m · Reply</small>
                </span>
              </div>
              {cfg.publicReplyOn && cfg.publicReplies.length > 0 ? (
                <div className="au-cmt reply">
                  <span className={`ibx-av ${tone(client.id)}`}>{client.name.slice(0, 2).toUpperCase()}</span>
                  <span>
                    <b>{handle}</b>
                    <span className="auth">Author</span>
                    {pickVariant(cfg.publicReplies, 0)}
                    <small>Just now · Reply</small>
                  </span>
                </div>
              ) : (
                <span className="au-pvcap">No public reply: the comment gets only the DM.</span>
              )}
            </>
          ) : (
            <>
              <div className="au-bq">
                <small>{cfg.trigger === "comment" ? "You commented on a reel" : cfg.trigger === "story_reply" ? "Replied to your story" : cfg.trigger === "story_mention" ? "Mentioned you in their story" : "You"}</small>
                {cfg.trigger === "comment" ? `${sampleKw} please!` : cfg.trigger === "dm_keyword" ? `${sampleKw.toLowerCase()} please` : cfg.trigger === "welcome" ? "Hi!" : cfg.trigger === "story_reply" ? "This is great" : "Story"}
              </div>
              <div className="au-dmcard">
                <p>{sampleText}</p>
                {step0.button?.title && <span className="btnl">{step0.button.title}</span>}
              </div>
              <span className="au-pvcap">{isComment ? "Sent as a private reply to the comment" : "Sent as a DM, inside their 24 hour window"}</span>
            </>
          )}
        </div>
      </div>
      <p className="au-help" style={{ marginTop: 10 }}>
        Buttons show in the Instagram app. On a computer people see the link as text.
      </p>
    </section>
  );

  const codeLive = a.testCode && a.testCodeExpiresAt && new Date(a.testCodeExpiresAt) > new Date();
  const testCard = (
    <section className="au-card" aria-label="Test it" data-testid="automation.test">
      <div className="sb">
        <div className="sect-t">
          <h3>Test it</h3>
        </div>
        {a.lastTestAt && <span className="au-pill ok">Last test worked</span>}
      </div>
      <p className="au-help" style={{ marginTop: 6, fontSize: 12.5, color: "var(--text-2)" }}>
        DM this code to @{handle} from any account. It runs the draft{isComment ? " without a comment" : ""}, as often as you like for 15 minutes.
      </p>
      <div className="au-code">
        {codeLive ? (
          <>
            <span className="digits" aria-label={`Code ${a.testCode}`}>
              {a.testCode!.split("").map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </span>
            <button type="button" className="ibx-btn ghost" onClick={() => void navigator.clipboard.writeText(a.testCode!).then(() => toast.success("Code copied."))}>
              <I name="i-copy" />
              Copy
            </button>
          </>
        ) : (
          !viewer && (
            <button type="button" className="ibx-btn" onClick={() => void getCode()} data-testid="automation.get-code">
              <I name="i-beaker" />
              Get a code
            </button>
          )
        )}
        <span className="when">{a.lastTestAt ? `Tested ${since(a.lastTestAt)}` : "Not tested yet"}</span>
      </div>
      {!viewer && (
        <>
          <div className="au-try">
            <input
              ref={tryInput}
              className={isPhone ? "mb-input" : "au-input"}
              aria-label={isComment ? "Try a comment" : "Try a message"}
              placeholder={isComment ? `Try a comment, like "can I get the ${sampleKw.toLowerCase()}"` : "Try a message"}
              value={tryText}
              onChange={(e) => (setTryText(e.target.value), setTryRes(null))}
              onKeyDown={(e) => e.key === "Enter" && void dryRun()}
            />
            <button type="button" className={isPhone ? "mb-btn sm" : "ibx-btn"} onClick={() => void dryRun()} data-testid="automation.dry-run">
              Check
            </button>
          </div>
          {tryRes ? (
            <p className={`au-tryres${tryRes.matched ? "" : " no"}`} role="status">
              {tryRes.matched ? (
                <>
                  <b>Matches{tryRes.keyword ? ` ${tryRes.keyword}` : ""}.</b> It would send the DM above. Nothing was sent.
                </>
              ) : (
                <>
                  <b>No match</b> ({tryRes.reason}). Nothing would be sent.
                </>
              )}
            </p>
          ) : (
            tryText && keywordHit(cfg, tryText) !== null && cfg.trigger === "comment" && <p className="au-tryres">Looks like a match. Check to be sure.</p>
          )}
        </>
      )}
    </section>
  );

  const stats = (
    <div className={isPhone ? "au-mstats" : "au-stats3"}>
      <div>
        <div className="k">Runs</div>
        <div className="v">{n0(a.stats.runs)}</div>
      </div>
      <div>
        <div className="k">Link opens</div>
        <div className="v">{n0(a.stats.clicks)}</div>
      </div>
      <div>
        <div className="k">CTR</div>
        <div className="v">{pct(a.stats.ctr) ?? "n/a"}</div>
      </div>
    </div>
  );

  const overlapNote = overlaps.length > 0 && (
    <div className={isPhone ? "au-slim warn" : "au-notice warn"} data-testid="automation.overlap">
      <I name="i-alert" />
      <span className="grow">
        <b>Also answered at Zernio.</b> {overlaps.map((o) => o.campaignName).join(", ")} {overlaps.length === 1 ? "answers" : "answer"} {overlaps[0]!.keywords.length ? overlaps[0]!.keywords.join(", ") : "every comment"} too. Publishing offers to pause it.
      </span>
    </div>
  );
  const viewerNote = viewer && (
    <div className={isPhone ? "au-slim info" : "au-notice info"}>
      <I name="i-info" />
      <span className="grow">You are signed in as a viewer, so this is read-only.</span>
    </div>
  );
  const waitingNote = a.status === "live" && a.waiting && !a.hasUnpublished && (
    <div className={isPhone ? "au-slim warn" : "au-notice warn"}>
      <I name="i-info" />
      <span className="grow">
        <b>Live, but not answering yet.</b> {a.waiting}.
      </span>
    </div>
  );

  const dialogs = (
    <>
      {sheet === "posts" && acc && (
        <PostPicker clientId={client.id} accountId={acc.accountId} handle={acc.handle} scope={cfg.scope} postIds={cfg.postIds} phone={isPhone} onClose={() => setSheet(null)} onPick={(scope, postIds) => edit({ scope, postIds })} />
      )}
      {sheet === "publish" && acc && (
        <PublishDialog
          phone={isPhone}
          a={a}
          acc={acc}
          overlaps={overlaps}
          nativeConfigured={meta?.nativeConfigured ?? false}
          zernioPossible={(meta?.zernioConfigured ?? false) && isComment}
          onClose={() => setSheet(null)}
          onPublish={(engine, ids) => void publish(engine, ids)}
        />
      )}
      {(sheet === "rename" || sheet === "folder") && (
        <TextDialog
          phone={isPhone}
          title={sheet === "rename" ? "Rename" : "Move to folder"}
          label={sheet === "rename" ? "Name" : "Folder"}
          initial={sheet === "rename" ? a.name : (a.folder ?? "")}
          max={sheet === "rename" ? 120 : 40}
          help={sheet === "folder" ? "Leave it empty for No folder." : undefined}
          allowEmpty={sheet === "folder"}
          onClose={() => setSheet(null)}
          onSave={(v) => {
            setSheet(null);
            if (sheet === "rename") edit({ name: v });
            else edit({ folder: v || null });
          }}
        />
      )}
    </>
  );

  // ---------------------------------------------------------------------------
  // Phone (round 2 mockup 02-automation-editor-phone)
  // ---------------------------------------------------------------------------
  if (isPhone) {
    return (
      <div className={wrap} data-testid="automation-editor" data-state="ready">
        <div className="au-rowsb">
          <span className="au-hstack">
            <StatePill state={state} />
            <span className="small muted">{saving === "saving" ? "Saving..." : a.hasUnpublished ? `Draft saved ${since((savedAt ?? new Date(a.updatedAt)).toISOString())}` : a.status === "draft" ? `Draft, edited ${since(a.updatedAt)}` : a.status === "live" ? "People get this version" : "Off"}</span>
          </span>
          <button type="button" className="mb-ib" aria-label="More: duplicate, test, turn off, delete" onClick={() => setSheet("actions")} data-testid="automation.more">
            <I name="i-dots-h" />
          </button>
        </div>
        {viewerNote}
        {waitingNote}
        {overlapNote}
        {stats}
        {steps.map((s) => {
          const isOpen = step === s.id && !s.sheet;
          return (
            <section key={s.id} className={`au-pstep${isOpen ? " open" : ""}${done[s.id] ? " done" : ""}`}>
              <button type="button" className="au-pstep-h" aria-expanded={s.sheet ? undefined : isOpen} onClick={() => (s.sheet ? setSheet(s.sheet) : setStep(isOpen ? 0 : s.id))} data-testid={`automation.step.${s.id}`}>
                <span className="au-pstep-n">{done[s.id] && s.id !== 4 ? <I name="i-check" /> : s.id}</span>
                <span className="t">
                  <b>{s.title}</b>
                  <small>{s.summary}</small>
                </span>
                <I name={s.sheet ? "i-chev-r" : "i-chev"} className="chv" />
              </button>
              {isOpen && <div className="au-pstep-b">{s.body}</div>}
            </section>
          );
        })}
        {problems.length > 0 && a.status === "draft" && (
          <ul className="au-problems" aria-label="Before it can publish">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="au-actionbar">
          <button type="button" className="mb-btn" onClick={() => setSheet("test")}>
            <I name="i-beaker" />
            Test it
          </button>
          {!viewer && (
            <button type="button" className="mb-btn pri" disabled={publishDisabled} onClick={onPublishClick} data-testid="automation.publish">
              {publishLabel === "Publish changes" ? "Publish" : publishLabel}
            </button>
          )}
        </div>

        {sheet === "dm" && (
          <Sheet
            label="Edit the DM"
            title="The DM"
            sub={isComment ? "Sent as a private reply to the comment" : "Sent as a DM"}
            onClose={() => setSheet(null)}
            className="au-sheet full"
            testId="automation.dm-sheet"
            foot={
              <>
                <button type="button" className="mb-btn" onClick={() => setSheet(null)}>
                  Cancel
                </button>
                <button type="button" className="mb-btn pri" onClick={() => (void flush(), setSheet(null))}>
                  Save
                </button>
              </>
            }
          >
            <div className="au-sheetform">
              {dmFields}
              <div className="mb-card list au-optlist">
                {isComment && <OptRow phone label="Only send the link to followers" sub="Others are asked to follow first" on={cfg.followersOnly} disabled={viewer} onChange={(v) => edit({ followersOnly: v })} />}
                <OptRow phone label="Track link opens" sub="Shows opens in the numbers" on={cfg.trackLinks} disabled={viewer} onChange={(v) => edit({ trackLinks: v })} />
              </div>
              <span className="mb-flab">Preview</span>
              <div className="au-pvb">
                <p>{sampleText}</p>
                {step0.button?.title && <span>{step0.button.title}</span>}
              </div>
            </div>
          </Sheet>
        )}
        {sheet === "never" && (
          <Sheet label="Never match" title="Never match" sub="Comments with these words are skipped" onClose={() => setSheet(null)} className="au-sheet" foot={<button type="button" className="mb-btn pri block" onClick={() => setSheet(null)}>Done</button>}>
            <KwBox value={cfg.excludeKeywords} phone label="Add a word" placeholder="Add a word" onChange={(excludeKeywords) => edit({ excludeKeywords })} />
          </Sheet>
        )}
        {sheet === "test" && (
          <Sheet label="Test it" title="Test it" onClose={() => setSheet(null)} className="au-sheet">
            {testCard}
          </Sheet>
        )}
        {sheet === "actions" && (
          <Sheet label={`More for ${a.name}`} title={a.name} sub={`${state === "live" ? "Live" : state === "draft" ? "Draft" : "Off"} on @${handle}`} onClose={() => setSheet(null)} className="au-sheet" foot={<button type="button" className="mb-btn block" onClick={() => setSheet(null)}>Cancel</button>}>
            <div className="au-am">
              <button type="button" disabled={viewer} onClick={() => (setSheet(null), void getCode().then(() => setSheet("test")))}>
                <I name="i-beaker" />
                <span className="grow">
                  Test with a code
                  <small>{codeLive ? `DM ${a.testCode} to @${handle}` : `DM a code to @${handle}`}</small>
                </span>
              </button>
              <button type="button" disabled={viewer} onClick={() => (setSheet(null), void duplicate())}>
                <I name="i-copy" />
                <span className="grow">Duplicate</span>
              </button>
              <button type="button" disabled={viewer} onClick={() => setSheet("rename")}>
                <I name="i-pencil" />
                <span className="grow">Rename</span>
              </button>
              <button type="button" disabled={viewer} onClick={() => setSheet("folder")}>
                <I name="i-folder" />
                <span className="grow">Move to folder</span>
              </button>
              <button type="button" disabled>
                <I name="i-desktop" />
                <span className="grow">
                  Open in flow builder
                  <small>Delays, conditions and branches come with the flow builder</small>
                </span>
              </button>
              {a.status !== "draft" && (
                <button type="button" role="switch" aria-checked={a.status === "live"} disabled={viewer} onClick={() => (setSheet(null), void setStatus(a.status === "live" ? "paused" : "live"))}>
                  <I name="i-bolt" />
                  <span className="grow">
                    {a.status === "live" ? "Live" : "Off"}
                    <small>{a.status === "live" ? "Turn off to stop replying" : "Turn on to start replying"}</small>
                  </span>
                  <span className={`au-tog${a.status === "live" ? " on" : ""}`} aria-hidden="true" />
                </button>
              )}
            </div>
            {!viewer && (
              <div className="au-am">
                <button type="button" className="bad" onClick={() => (setSheet(null), void remove())}>
                  <I name="i-trash" />
                  <span className="grow">Delete</span>
                </button>
              </div>
            )}
          </Sheet>
        )}
        {dialogs}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Desktop and web (round 2 mockup 02-automation-editor-desktop)
  // ---------------------------------------------------------------------------
  return (
    <div className={wrap} data-testid="automation-editor" data-state="ready">
      {viewerNote}
      {waitingNote}
      {overlapNote}
      <div className="au-egrid">
        <div className="au-steps">
          {steps.map((s) => {
            const isOpen = step === s.id;
            return (
              <section key={s.id} className={`au-step${isOpen ? " open" : ""}${done[s.id] && s.id !== 4 ? " done" : ""}`}>
                <button type="button" className="au-step-h" aria-expanded={isOpen} onClick={() => setStep(isOpen ? 0 : s.id)} data-testid={`automation.step.${s.id}`}>
                  <span className="au-step-n">{done[s.id] && s.id !== 4 ? <I name="i-check" /> : s.id}</span>
                  <span className="lt">
                    <b>{s.title}</b>
                    <small>{s.summary}</small>
                  </span>
                  <I name="i-chev" className="chv" />
                </button>
                {isOpen && <div className="au-step-b">{s.body}</div>}
              </section>
            );
          })}
          {problems.length > 0 && a.status === "draft" && (
            <ul className="au-problems" aria-label="Before it can publish">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="au-flowhint">
            <I name="i-branch" />
            Need a delay, a condition or a second message? That comes with the flow builder, next.
          </div>
        </div>
        <aside className="au-right">
          {preview}
          {testCard}
          <section className="au-card">{stats}</section>
        </aside>
      </div>
      {dialogs}
    </div>
  );
}

const scopeLabel = (c: DmAutomationConfig) => (c.scope === "all" ? "Any post or reel" : c.scope === "next" ? (c.postIds.length ? "The post it locked onto" : "Next post or reel") : c.postIds.length ? "One post or reel" : "Pick a post");
function scopeText(c: DmAutomationConfig): ReactNode {
  if (c.scope === "all")
    return (
      <>
        <b>Any post or reel</b>, old and new
      </>
    );
  if (c.scope === "next")
    return c.postIds.length ? (
      <>
        <b>Locked onto</b> the post published after it went live
      </>
    ) : (
      <>
        <b>Next post or reel</b>, locks on when you publish one
      </>
    );
  return c.postIds.length ? (
    <>
      <b>One post or reel</b> <span className="t3">({c.postIds[0]})</span>
    </>
  ) : (
    <b>Pick a post</b>
  );
}

function OptRow({ label, sub, on, disabled, onChange, phone }: { label: string; sub: string; on: boolean; disabled?: boolean; onChange(v: boolean): void; phone?: boolean }) {
  return (
    <button type="button" className={phone ? "mb-optrow au-optrow" : "au-optrow"} role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="lt">
        <b>{label}</b>
        <small>{sub}</small>
      </span>
      <span className={`au-tog${on ? " on" : ""}`} aria-hidden="true" />
    </button>
  );
}

function EditorMenu({
  viewer,
  a,
  onClose,
  onRename,
  onFolder,
  onDuplicate,
  onStatus,
  onDelete,
}: {
  viewer: boolean;
  a: DmAutomationView;
  onClose(): void;
  onRename(): void;
  onFolder(): void;
  onDuplicate(): void;
  onStatus(s: "live" | "paused"): void;
  onDelete(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-testid='automation.more']") && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => (document.removeEventListener("mousedown", down), document.removeEventListener("keydown", key));
  }, [onClose]);
  const item = (icon: string, label: string, run: () => void, opts: { bad?: boolean; disabled?: boolean; sub?: string } = {}) => (
    <button type="button" role="menuitem" className={`pi${opts.bad ? " bad" : ""}`} disabled={opts.disabled} onClick={() => (onClose(), run())}>
      <I name={icon} />
      {label}
      {opts.sub && <small>{opts.sub}</small>}
    </button>
  );
  return (
    <div ref={ref} className="ibx-wrap au au-pop" style={{ right: 0, top: 44, width: 240 }} role="menu" aria-label="More">
      {item("i-branch", "Open in flow builder", () => undefined, { disabled: true, sub: "Next" })}
      {item("i-copy", "Duplicate", onDuplicate, { disabled: viewer })}
      {a.status !== "draft" && item("i-bolt", a.status === "live" ? "Turn off" : "Turn on", () => onStatus(a.status === "live" ? "paused" : "live"), { disabled: viewer })}
      {item("i-pencil", "Rename", onRename, { disabled: viewer })}
      {item("i-folder", "Move to folder", onFolder, { disabled: viewer })}
      <div className="sepl" />
      {item("i-trash", "Delete", onDelete, { bad: true, disabled: viewer })}
    </div>
  );
}

/**
 * Before it goes live: where it runs (our Meta app, or Zernio while Instagram
 * is not connected that way), and the Zernio campaigns that answer the same
 * keyword, each paused only when ticked here. Never silently.
 */
function PublishDialog({
  phone,
  a,
  acc,
  overlaps,
  nativeConfigured,
  zernioPossible,
  onClose,
  onPublish,
}: {
  phone: boolean;
  a: DmAutomationView;
  acc: AutoAccount;
  overlaps: DmAutomationOverlap[];
  nativeConfigured: boolean;
  zernioPossible: boolean;
  onClose(): void;
  onPublish(engine: "native" | "zernio", pauseCampaignIds: string[]): void;
}) {
  const messenger = acc.platform === "facebook";
  const [engine, setEngine] = useState<"native" | "zernio">(messenger ? "zernio" : "native");
  const [pause, setPause] = useState<string[]>([]);
  const btn = phone ? "mb-btn" : "au-hbtn";
  return (
    <Dialog
      phone={phone}
      title={a.status === "draft" ? "Publish this automation?" : "Publish the changes?"}
      sub={messenger ? "Messenger automations run at Zernio." : acc.native ? `It starts answering on @${acc.handle} right away.` : undefined}
      onClose={onClose}
      testId="automation.publish-dialog"
      foot={
        <>
          <button type="button" className={btn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`${btn} pri`} onClick={() => onPublish(engine, engine === "native" ? pause : [])} data-testid="automation.publish-confirm">
            {engine === "zernio" ? "Publish at Zernio" : pause.length ? "Publish and pause it" : "Publish"}
          </button>
        </>
      }
    >
      {!messenger && !acc.native && (
        <>
          <p className="au-help" style={{ fontSize: 13, color: "var(--text-2)" }}>
            @{acc.handle} is not connected through Torerone's Meta app{nativeConfigured ? "" : ", and the app is not switched on for this server yet"}. Pick how it runs:
          </p>
          <div role="radiogroup" aria-label="Where it runs">
            <button type="button" role="radio" aria-checked={engine === "native"} className={phone ? "mb-optrow au-opt" : "au-opt"} onClick={() => setEngine("native")}>
              <span className={`au-radio${engine === "native" ? " on" : ""}`} aria-hidden="true" />
              <span className="lt">
                <b>Publish here, it waits</b>
                <small>Goes live the moment Instagram is connected. Nothing sends before.</small>
              </span>
            </button>
            {zernioPossible && (
              <button type="button" role="radio" aria-checked={engine === "zernio"} className={phone ? "mb-optrow au-opt" : "au-opt"} onClick={() => setEngine("zernio")}>
                <span className={`au-radio${engine === "zernio" ? " on" : ""}`} aria-hidden="true" />
                <span className="lt">
                  <b>Run it at Zernio for now</b>
                  <small>Starts answering comments today as a Zernio campaign. Move it here later.</small>
                </span>
              </button>
            )}
          </div>
        </>
      )}
      {engine === "native" && overlaps.length > 0 && (
        <>
          <p className="au-help" style={{ fontSize: 13, color: "var(--text-2)" }}>
            These Zernio campaigns answer the same comments, so people would get two DMs. Pause them?
          </p>
          {overlaps.map((o) => {
            const on = pause.includes(o.campaignId);
            return (
              <button key={o.campaignId} type="button" role="checkbox" aria-checked={on} className="au-check" onClick={() => setPause((p) => (on ? p.filter((x) => x !== o.campaignId) : [...p, o.campaignId]))} data-testid="automation.pause-zernio">
                <span className="box">{on && <I name="i-check" />}</span>
                Pause {o.campaignName} at Zernio{o.keywords.length ? ` (${o.keywords.join(", ")})` : ""}
              </button>
            );
          })}
        </>
      )}
      {engine === "native" && !overlaps.length && acc.native && <p className="au-help">People who trigger it from now on get this version.</p>}
    </Dialog>
  );
}

function TextDialog({ phone, title, label, initial, max, help, allowEmpty, onClose, onSave }: { phone: boolean; title: string; label: string; initial: string; max: number; help?: string; allowEmpty?: boolean; onClose(): void; onSave(v: string): void }) {
  const [v, setV] = useState(initial);
  return (
    <Dialog
      phone={phone}
      title={title}
      onClose={onClose}
      foot={
        <>
          <button type="button" className={phone ? "mb-btn" : "au-hbtn"} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={phone ? "mb-btn pri" : "au-hbtn pri"} disabled={!allowEmpty && !v.trim()} onClick={() => onSave(v.trim())}>
            Save
          </button>
        </>
      }
    >
      <div className="au-field">
        <label htmlFor="au-textdlg">{label}</label>
        <input id="au-textdlg" className={phone ? "mb-input" : "au-input"} maxLength={max} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
        {help && <p className="au-help">{help}</p>}
      </div>
    </Dialog>
  );
}
