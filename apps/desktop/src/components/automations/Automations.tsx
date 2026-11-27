import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DM_TEMPLATE_INFO, DM_TRIGGERS, type DmRunView, type DmTemplate, type DmTrigger } from "@toreroflow/core";
import Pf from "../Pf";
import Modal from "../../modals/Modal";
import { Sheet } from "../analytics/phoneBits";
import { useToast } from "../Toasts";
import { api, type ClientSummary, type DmCampaignLog } from "../../lib/api";
import { useIsPhone } from "../../lib/phone";
import { usePageHead } from "../../lib/pageHead";
import { automationPath, navigate, navigatePath, useRoute } from "../../lib/routes";
import { PF_ID } from "../../lib/platforms";
import { since } from "../../lib/automations";
import {
  folderNames,
  groupRows,
  matchesFilters,
  NO_FILTERS,
  pct,
  phoneMeta,
  rowKeywords,
  rowState,
  rowTrigger,
  sortRows,
  SORTS,
  STATE_TABS,
  TRIGGER_CHIP,
  TRIGGER_ICON,
  triggerLine,
  type AutoRow,
  type AutomationsList,
  type Filters,
  type Sort,
} from "../../lib/automations";
import { useAppState } from "../../state/AppState";
import AutomationEditor from "./AutomationEditor";
import { Acct, ConnectLine, CouldNotLoad, Dialog, Dot, I, RunRow, Skeleton, Spark, Switch } from "./parts";

/**
 * Workflows > Automations (F4): the list of a brand's DM automations, the
 * native ones and the Zernio campaigns still running beside them (round 2
 * mockup 01, desktop and phone). Opening one goes to the editor at
 * /create/workflows/automations/<id>. Viewers read only.
 */

const RETRY_MS = 15_000;
const TEMPLATE_ORDER: DmTemplate[] = ["comment_link", "comment_followers", "dm_keyword", "story_reply", "welcome", "blank"];
const n0 = (n: number) => n.toLocaleString("en-US");

export default function Automations({ client }: { client: ClientSummary }) {
  const { item } = useRoute();
  const isPhone = useIsPhone();
  const toast = useToast();
  const { user } = useAppState();
  const viewer = user?.role === "viewer";
  const [data, setData] = useState<AutomationsList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null);
  const [trash, setTrash] = useState(false);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<Sort>("runs");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<AutoRow | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [folderFor, setFolderFor] = useState<AutoRow | null>(null);
  const [leadsFor, setLeadsFor] = useState<AutoRow | null>(null);
  const [delZernio, setDelZernio] = useState<AutoRow | null>(null);
  const [basicOpen, setBasicOpen] = useState(false);
  const [runs, setRuns] = useState<{ runs: DmRunView[]; total: number } | null>(null);
  const [allRuns, setAllRuns] = useState(false);
  const hideKey = `tf-au-zernio-notice:${client.id}`;
  const [hideZernio, setHideZernio] = useState(() => sessionStorage.getItem(hideKey) === "1");
  const zernioGroup = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<AutomationsList>(`/clients/${client.id}/dm/automations${trash ? "?trash=1" : ""}`);
      setData(r);
      setErr(null);
      setLastLoaded(new Date());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not load automations");
    }
  }, [client.id, trash]);
  useEffect(() => {
    setData(null);
    setErr(null);
    if (!item) void load();
  }, [load, item]);
  // Could not load at all: try again every 15 seconds on its own (mockup 10d).
  useEffect(() => {
    if (data || !err) return;
    const t = window.setTimeout(() => void load(), RETRY_MS);
    return () => window.clearTimeout(t);
  }, [data, err, load]);
  useEffect(() => {
    if (item || trash) return;
    let live = true;
    api
      .get<{ runs: DmRunView[]; total: number }>(`/clients/${client.id}/dm/automations/runs?trigger=comment&limit=${allRuns ? 50 : isPhone ? 3 : 5}`)
      .then((r) => live && setRuns(r))
      .catch(() => live && setRuns({ runs: [], total: 0 }));
    return () => {
      live = false;
    };
  }, [client.id, allRuns, isPhone, item, trash, data]);

  const rows: AutoRow[] = useMemo(() => (data ? [...data.automations, ...(trash ? [] : data.campaigns)] : []), [data, trash]);
  const shown = useMemo(() => sortRows(rows.filter((r) => matchesFilters(r, filters)), sort), [rows, filters, sort]);
  const groups = useMemo(() => groupRows(shown), [shown]);
  const counts = useMemo(() => {
    const c = { all: 0, live: 0, draft: 0, off: 0 };
    for (const r of rows) if (matchesFilters(r, filters, "all")) (c.all++, c[rowState(r)]++);
    return c;
  }, [rows, filters]);
  const folders = useMemo(() => folderNames(rows), [rows]);
  const accounts = data?.accounts ?? [];
  const nativeAcc = accounts.filter((a) => a.native);
  const firstIg = accounts.find((a) => a.platform === "instagram");
  const activeZernio = (data?.campaigns ?? []).filter((c) => c.isActive);
  const liveCount = rows.filter((r) => rowState(r) === "live").length;

  // Desktop header: the account filter and New automation (mockup 01).
  usePageHead(
    !item && !isPhone
      ? {
          controls: (
            <>
              {accounts.length > 1 && (
                <label className="au-hsel">
                  {(() => {
                    const a = accounts.find((x) => x.accountId === filters.accountId);
                    return <Pf p={PF_ID[a?.platform ?? "instagram"]} size="xs" />;
                  })()}
                  <select aria-label="Account" value={filters.accountId ?? ""} onChange={(e) => setFilters((f) => ({ ...f, accountId: e.target.value || null }))} data-testid="automations.account">
                    <option value="">All accounts</option>
                    {accounts.map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {a.platform === "facebook" ? `${a.handle} (Messenger)` : `@${a.handle}`}
                      </option>
                    ))}
                  </select>
                  <svg className="chev" viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-chev" />
                  </svg>
                </label>
              )}
              {!viewer && (
                <button type="button" className="au-hbtn pri" onClick={() => setNewOpen(true)} disabled={!accounts.length} data-testid="automations.new">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <use href="#i-plus" />
                  </svg>
                  New automation
                </button>
              )}
            </>
          ),
        }
      : null,
  );

  if (item) return <AutomationEditor client={client} id={item} />;

  const open = (r: AutoRow) => (r.source === "native" ? navigatePath(automationPath(r.id)) : setLeadsFor(r));

  const toggle = async (r: AutoRow, on: boolean) => {
    try {
      if (r.source === "zernio") await api.patch(`/clients/${client.id}/dm-campaigns/${r.id}`, { isActive: on });
      else if (r.status === "draft") return open(r);
      else await api.post(`/clients/${client.id}/dm/automations/${r.id}/status`, { status: on ? "live" : "paused" });
      await load();
    } catch (e) {
      toast.fail(`Could not ${on ? "turn on" : "turn off"} ${r.name}`, e);
    }
  };
  const duplicate = async (r: AutoRow) => {
    try {
      const out = await api.post<{ automation: { id: string } }>(`/clients/${client.id}/dm/automations/${r.id}/duplicate`);
      navigatePath(automationPath(out.automation.id));
    } catch (e) {
      toast.fail("Could not duplicate it", e);
    }
  };
  const remove = async (r: AutoRow) => {
    try {
      await api.del(`/clients/${client.id}/dm/automations/${r.id}`);
      await load();
      toast.success(`${r.name} is in the trash.`, {
        label: "Undo",
        run: () => void api.post(`/clients/${client.id}/dm/automations/${r.id}/restore`).then(load),
      });
    } catch (e) {
      toast.fail("Could not delete it", e);
    }
  };
  const restore = async (r: AutoRow) => {
    try {
      await api.post(`/clients/${client.id}/dm/automations/${r.id}/restore`);
      await load();
      toast.success(`${r.name} is back, turned off.`);
    } catch (e) {
      toast.fail("Could not restore it", e);
    }
  };
  const testCode = async (r: AutoRow) => {
    try {
      const out = await api.post<{ code: string; note: string | null }>(`/clients/${client.id}/dm/automations/${r.id}/test-code`);
      const handle = r.source === "native" ? r.accountHandle : "";
      await navigator.clipboard.writeText(out.code).catch(() => undefined);
      toast.success(out.note ?? `DM ${out.code} to @${handle} within 15 minutes to run the draft. Copied.`);
    } catch (e) {
      toast.fail("Could not get a test code", e);
    }
  };
  const moveToNative = async (r: AutoRow) => {
    try {
      const out = await api.post<{ automation: { id: string } }>(`/clients/${client.id}/dm/automations/move`, { campaignId: r.id });
      toast.success(`${r.name} is here as a draft. Check it, then publish. The Zernio campaign keeps running until you pause it.`);
      navigatePath(automationPath(out.automation.id));
    } catch (e) {
      toast.fail("Could not move it", e);
    }
  };
  const deleteZernio = async (r: AutoRow) => {
    try {
      await api.del(`/clients/${client.id}/dm-campaigns/${r.id}`);
      await load();
      toast.success(`${r.name} was deleted at Zernio.`);
    } catch (e) {
      toast.fail("Could not delete the campaign", e);
    }
  };
  const kill = async (accountId: string, paused: boolean) => {
    try {
      await api.post(`/clients/${client.id}/dm/automations/kill`, { accountId, paused });
      await load();
    } catch (e) {
      toast.fail(paused ? "Could not pause the automations" : "Could not turn the automations back on", e);
    }
  };
  const pauseOverlap = async (campaignId: string, name: string) => {
    try {
      await api.patch(`/clients/${client.id}/dm-campaigns/${campaignId}`, { isActive: false });
      await load();
      toast.success(`${name} is paused at Zernio.`);
    } catch (e) {
      toast.fail("Could not pause the Zernio campaign", e);
    }
  };

  const menuItems = (r: AutoRow): Array<{ icon: string; label: string; sub?: string; run(): void; bad?: boolean; disabled?: boolean; toggle?: boolean }> => {
    if (r.source === "zernio") {
      return [
        { icon: "i-users", label: "Leads", sub: "Who triggered it", run: () => setLeadsFor(r) },
        { icon: "i-bolt", label: r.isActive ? "Live" : "Off", sub: r.isActive ? "Turn off to stop replying" : "Turn on at Zernio", run: () => void toggle(r, !r.isActive), toggle: r.isActive },
        {
          icon: "i-arrow-r",
          label: "Move to native",
          sub: r.platform === "facebook" ? "Messenger stays at Zernio" : r.canMove ? "Recreate it here as a draft" : "Connect Instagram first",
          run: () => void moveToNative(r),
          disabled: !r.canMove,
        },
        { icon: "i-trash", label: "Delete at Zernio", run: () => setDelZernio(r), bad: true },
      ];
    }
    if (trash) return [{ icon: "i-refresh", label: "Restore", run: () => void restore(r) }];
    const st = rowState(r);
    return [
      { icon: "i-pencil", label: st === "draft" ? "Finish" : "Edit", run: () => open(r) },
      ...(st !== "draft"
        ? [{ icon: "i-bolt", label: st === "live" ? "Live" : "Off", sub: st === "live" ? "Replying to new comments" : "Not replying", run: () => void toggle(r, st !== "live"), toggle: st === "live" }]
        : []),
      { icon: "i-beaker", label: "Test with a code", sub: r.testCode ? `DM ${r.testCode} to @${r.accountHandle}` : `DM a code to @${r.accountHandle}`, run: () => void testCode(r) },
      { icon: "i-copy", label: "Duplicate", run: () => void duplicate(r) },
      { icon: "i-folder", label: "Move to folder", run: () => setFolderFor(r) },
      { icon: "i-trash", label: "Delete", run: () => void remove(r), bad: true },
    ];
  };

  const basic = (() => {
    const of = (t: DmTrigger) => data?.automations.find((a) => a.config.trigger === t) ?? null;
    const w = of("welcome");
    const m = of("story_mention");
    const s = (a: typeof w) => (!a ? "Not set up" : rowState(a) === "live" ? "On" : "Off");
    return {
      on: [w, m].filter((a) => a && rowState(a) === "live").length,
      rows: [
        { icon: "i-spark", label: "Default reply", status: "AI replies", ok: false, note: "Set up in AI replies", run: () => navigate("workflows", "ai-replies") },
        { icon: "i-hand", label: "Welcome message", status: s(w), ok: !!w && rowState(w) === "live", run: () => (w ? open(w) : void create(firstIg?.accountId ?? "", "welcome")) },
        { icon: "i-help", label: "Conversation starters", status: "Later", ok: false, run: null },
        { icon: "i-menu", label: "Main menu", status: "Not set up", ok: false, run: null },
        { icon: "i-at", label: "Story mention reply", status: s(m), ok: !!m && rowState(m) === "live", run: () => (m ? open(m) : void create(firstIg?.accountId ?? "", "story_mention")) },
      ],
    };
  })();

  async function create(accountId: string, template: DmTemplate, folder?: string | null) {
    if (!accountId) return toast.error("Connect an Instagram account first.");
    try {
      const out = await api.post<{ automation: { id: string } }>(`/clients/${client.id}/dm/automations`, {
        socialAccountId: accountId,
        template,
        ...(folder ? { folder } : {}),
      });
      navigatePath(automationPath(out.automation.id));
    } catch (e) {
      toast.fail("Could not create the automation", e);
    }
  }

  // ---------------------------------------------------------------------------
  // States
  // ---------------------------------------------------------------------------
  const wrap = isPhone ? "ibx-wrap ph au" : "ibx-wrap au";
  if (!data) {
    return (
      <div className={wrap} data-testid="automations" data-state={err ? "error" : "loading"}>
        {err ? <CouldNotLoad phone={isPhone} lastLoaded={lastLoaded} onRetry={() => void load()} what="automations" /> : <Skeleton phone={isPhone} label="Loading automations" />}
      </div>
    );
  }
  const noAccounts = !accounts.length;
  const empty = !trash && !rows.length;

  const notices = (
    <>
      {data.warnings.map((w) => (
        <div key={w} className={isPhone ? "au-slim warn" : "au-notice warn"}>
          <I name="i-alert" />
          <span className="grow">{w}</span>
        </div>
      ))}
      {!trash && !nativeAcc.length && firstIg && <ConnectLine accountId={viewer ? null : firstIg.accountId} configured={data.nativeConfigured} phone={isPhone} />}
      {!trash &&
        data.overlaps
          .filter((o) => data.automations.some((a) => a.id === o.automationId && a.status === "live"))
          .map((o) => {
            const a = data.automations.find((x) => x.id === o.automationId)!;
            return (
              <div key={`${o.automationId}:${o.campaignId}`} className={isPhone ? "au-slim warn" : "au-notice warn"} data-testid="automations.overlap">
                <I name="i-alert" />
                <span className="grow">
                  <b>{o.keywords.length ? o.keywords.join(", ") : "Every comment"} gets two replies.</b> {a.name} and the Zernio campaign {o.campaignName} both answer it.
                </span>
                {!viewer && (
                  <button type="button" className={isPhone ? "mb-btn sm" : "ibx-btn"} onClick={() => void pauseOverlap(o.campaignId, o.campaignName)}>
                    Pause the Zernio one
                  </button>
                )}
              </div>
            );
          })}
      {!trash && activeZernio.length > 0 && !hideZernio && (
        isPhone ? (
          <button type="button" className="au-slim info" onClick={() => zernioGroup.current?.scrollIntoView({ block: "start", behavior: "smooth" })} data-testid="automations.zernio-notice">
            <I name="i-info" />
            <span className="grow">
              <b>
                {activeZernio.length} DM {activeZernio.length === 1 ? "campaign still runs" : "campaigns still run"} at Zernio
              </b>
              Move them here so one keyword does not reply twice
            </span>
            <I name="i-chev-r" className="go" />
          </button>
        ) : (
          <div className="au-notice info" data-testid="automations.zernio-notice">
            <I name="i-info" />
            <span className="grow">
              <b>
                {activeZernio.length} DM {activeZernio.length === 1 ? "campaign still runs" : "campaigns still run"} at Zernio.
              </b>{" "}
              Move them here so one keyword does not reply twice.
            </span>
            <button type="button" className="ibx-btn" onClick={() => zernioGroup.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>
              Review and move
            </button>
            <button
              type="button"
              className="ibx-btn icon ghost"
              aria-label="Hide for now"
              onClick={() => {
                sessionStorage.setItem(hideKey, "1");
                setHideZernio(true);
              }}
            >
              <I name="i-x" />
            </button>
          </div>
        )
      )}
    </>
  );

  const emptyState = (
    <section className={isPhone ? "mb-card ibx-empty" : "au-card ibx-empty"} data-testid="automations.empty">
      <span className="ei">
        <I name="i-bolt" />
      </span>
      <h3>{noAccounts ? "Connect Instagram first" : "No automations yet"}</h3>
      <p>
        {noAccounts
          ? `Automations answer comments and DMs on ${client.name}'s Instagram. Connect an Instagram account in Connected Accounts to start.`
          : "Reply to a comment keyword with a DM, welcome first-time messages, or thank people for story replies. Start from a template."}
      </p>
      {!viewer && !noAccounts && (
        <div className="acts">
          <button type="button" className={isPhone ? "mb-btn pri block" : "ibx-btn"} onClick={() => setNewOpen(true)}>
            <I name="i-plus" />
            New automation
          </button>
        </div>
      )}
    </section>
  );

  // The filter controls: one body for the desktop popover and the phone sheet.
  const filterBody = (
    <>
      {isPhone && (
        <div className="mb-field">
          <span className="mb-flab">State</span>
          <div className="ibx-seg ph" role="tablist" aria-label="State">
            {STATE_TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={filters.tab === t.id} className={filters.tab === t.id ? "on" : undefined} onClick={() => setFilters((f) => ({ ...f, tab: t.id }))}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={isPhone ? "mb-field" : undefined}>
        <div className={isPhone ? "mb-flab" : "flab"}>Trigger</div>
        <div className={isPhone ? "au-wchips" : "ibx-chips"}>
          {DM_TRIGGERS.map((t) => {
            const on = filters.triggers.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                className={`ibx-chip${on ? " on" : ""}`}
                onClick={() => setFilters((f) => ({ ...f, triggers: on ? f.triggers.filter((x) => x !== t) : [...f.triggers, t] }))}
              >
                <I name={TRIGGER_ICON[t]} />
                {TRIGGER_CHIP[t]}
              </button>
            );
          })}
        </div>
      </div>
      {(isPhone || accounts.length > 1) && (
        <div className={isPhone ? "mb-field" : undefined}>
          <div className={isPhone ? "mb-flab" : "flab"}>Account</div>
          <div className={isPhone ? "mb-card list au-optlist" : "au-optlist"} role="radiogroup" aria-label="Account">
            {[{ accountId: null as string | null, platform: "instagram" as const, handle: "" }, ...accounts].map((a) => {
              const on = filters.accountId === a.accountId;
              return (
                <button key={a.accountId ?? "all"} type="button" role="radio" aria-checked={on} className={isPhone ? "mb-optrow au-opt" : "au-opt"} onClick={() => setFilters((f) => ({ ...f, accountId: a.accountId }))}>
                  <span className={`au-radio${on ? " on" : ""}`} aria-hidden="true" />
                  {a.accountId && <Pf p={PF_ID[a.platform]} size="xs" />}
                  <span className="lt">
                    <b>{!a.accountId ? "All accounts" : a.platform === "facebook" ? "Messenger" : `@${a.handle}`}</b>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {folders.length > 0 && (
        <div className={isPhone ? "mb-field" : undefined}>
          <div className={isPhone ? "mb-flab" : "flab"}>Folder</div>
          <div className={isPhone ? "au-wchips" : "ibx-chips"}>
            {[null, ...folders].map((f) => (
              <button key={f ?? "all"} type="button" aria-pressed={filters.folder === f} className={`ibx-chip${filters.folder === f ? " on" : ""}`} onClick={() => setFilters((x) => ({ ...x, folder: f }))}>
                {f ?? "All folders"}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
  const nFilters = filters.triggers.length + (filters.accountId ? 1 : 0) + (filters.folder ? 1 : 0);

  const zernioLeads = leadsFor && <Leads clientId={client.id} row={leadsFor} phone={isPhone} onClose={() => setLeadsFor(null)} />;
  const dialogs = (
    <>
      {newOpen && <NewAutomation client={client} accounts={accounts} folders={folders} phone={isPhone} onClose={() => setNewOpen(false)} onCreate={(a, t, f) => void create(a, t, f)} />}
      {folderFor && folderFor.source === "native" && (
        <FolderDialog
          phone={isPhone}
          name={folderFor.name}
          current={folderFor.folder}
          folders={folders}
          onClose={() => setFolderFor(null)}
          onSave={async (folder) => {
            try {
              await api.patch(`/clients/${client.id}/dm/automations/${folderFor.id}`, { folder });
              setFolderFor(null);
              await load();
            } catch (e) {
              toast.fail("Could not move it", e);
            }
          }}
        />
      )}
      {zernioLeads}
      {delZernio && (
        <Dialog
          phone={isPhone}
          title="Delete this campaign?"
          sub={`${delZernio.name} stops answering comments at Zernio. This cannot be undone.`}
          onClose={() => setDelZernio(null)}
          foot={
            <>
              <button type="button" className={isPhone ? "mb-btn" : "au-hbtn"} onClick={() => setDelZernio(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={isPhone ? "mb-btn danger" : "au-hbtn pri"}
                onClick={() => {
                  const r = delZernio;
                  setDelZernio(null);
                  void deleteZernio(r);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p className="au-help">Its counts stay on the videos they were scoped to.</p>
        </Dialog>
      )}
    </>
  );

  // ---------------------------------------------------------------------------
  // Phone (round 2 mockup 01-automations-phone)
  // ---------------------------------------------------------------------------
  if (isPhone) {
    return (
      <div className={wrap} data-testid="automations" data-state={empty ? "empty" : "ready"}>
        <div className="au-toolrow">
          <label className="ibx-input round">
            <I name="i-search" />
            <input type="search" placeholder="Search automations" aria-label="Search automations" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
          </label>
          <button type="button" className={`mb-ib${nFilters || filters.tab !== "all" ? " on" : ""}`} aria-label="Filter by state, trigger, account and folder" onClick={() => setFilterOpen(true)} data-testid="automations.filter">
            <I name="i-filter" />
          </button>
        </div>
        {notices}
        {empty ? (
          emptyState
        ) : (
          <>
            <div className="au-rowsb">
              <span className="small muted">
                {trash ? `${rows.length} in the trash` : `${rows.length} ${rows.length === 1 ? "automation" : "automations"}, ${liveCount} live`}
              </span>
              {!viewer && !trash && (
                <button type="button" className="mb-btn pri sm" onClick={() => setNewOpen(true)} disabled={noAccounts} data-testid="automations.new">
                  <I name="i-plus" />
                  New
                </button>
              )}
            </div>
            <section className="au-rlist" aria-label="Automations">
              {!shown.length && <p className="ibx-nomatch">Nothing matches. Try another search or filter.</p>}
              {groups.map((g) => (
                <div key={g.key} ref={g.zernio ? zernioGroup : undefined} className="au-rgroup">
                  <div className="au-rlh">
                    <I name={g.zernio ? "i-link" : "i-folder"} />
                    {g.label} <small>{g.rows.length}</small>
                  </div>
                  {g.rows.map((r) => {
                    const kws = rowKeywords(r);
                    return (
                      <div key={r.id} className="au-ar" data-testid={`automations.row.${r.id}`}>
                        <Dot state={rowState(r)} />
                        <button type="button" className="t" onClick={() => open(r)}>
                          <b>
                            {r.name}
                            {r.source === "zernio" && <span className="au-src">Zernio</span>}
                          </b>
                          <small>
                            <I name={TRIGGER_ICON[rowTrigger(r)]} />
                            {kws.slice(0, 2).map((k) => (
                              <span className="au-kw" key={k}>
                                {k}
                              </span>
                            ))}
                            <span className="grow">{phoneMeta(r, r.source === "native" ? since(r.updatedAt) : "")}</span>
                          </small>
                        </button>
                        {!viewer && (
                          <button type="button" className="mb-ib ghost" aria-label={`More for ${r.name}`} onClick={() => setMenuFor(r)}>
                            <I name="i-dots-h" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </section>
            {data.trashCount > 0 && (
              <button type="button" className="au-trashlink" onClick={() => setTrash((t) => !t)}>
                {trash ? "Back to automations" : `Trash: ${data.trashCount}`}
              </button>
            )}
          </>
        )}

        {!trash && (
          <>
            <div className="au-sech">
              <h2>Recent comments</h2>
              <span className="small muted">
                {data.sentLastHour} of {data.budget} an hour
              </span>
            </div>
            <section className="mb-card list au-runs">
              {!runs ? (
                <p className="ibx-nomatch">Loading...</p>
              ) : !runs.runs.length ? (
                <p className="ibx-nomatch">No comments yet. They show up here once Instagram is connected through Torerone's Meta app.</p>
              ) : (
                runs.runs.map((r) => <RunRow key={r.id} r={r} phone />)
              )}
              {runs && runs.total > runs.runs.length && (
                <button type="button" className="au-showmore" onClick={() => setAllRuns(true)}>
                  Show {Math.min(runs.total, 50) - runs.runs.length} more
                  <I name="i-chev" />
                </button>
              )}
            </section>
            <section className="mb-card list">
              <button type="button" className="mb-lrow au-basicrow" onClick={() => setBasicOpen(true)}>
                <span className="au-lic">
                  <I name="i-hand" />
                </span>
                <span className="mb-lt">
                  <b>Basic replies</b>
                  <small>Welcome, starters, menu, story mentions: {basic.on} of 5 on</small>
                </span>
                <I name="i-chev-r" />
              </button>
            </section>
          </>
        )}

        {filterOpen && (
          <Sheet
            label="Filter automations"
            title="Filter"
            onClose={() => setFilterOpen(false)}
            className="au-sheet"
            foot={
              <>
                <button type="button" className="mb-btn" onClick={() => setFilters((f) => ({ ...NO_FILTERS, search: f.search }))}>
                  Reset
                </button>
                <button type="button" className="mb-btn pri" onClick={() => setFilterOpen(false)}>
                  Show {shown.length}
                </button>
              </>
            }
          >
            {filterBody}
          </Sheet>
        )}
        {menuFor && (
          <Sheet label={menuFor.name} title={menuFor.name} sub={menuSub(menuFor)} onClose={() => setMenuFor(null)} className="au-sheet" foot={<button type="button" className="mb-btn block" onClick={() => setMenuFor(null)}>Cancel</button>}>
            <ActionList items={menuItems(menuFor)} onDone={() => setMenuFor(null)} />
          </Sheet>
        )}
        {basicOpen && (
          <Sheet label="Basic replies" title="Basic replies" sub={`${basic.on} of 5 on`} onClose={() => setBasicOpen(false)} className="au-sheet">
            <div className="au-am">
              {basic.rows.map((b) => (
                <button key={b.label} type="button" disabled={!b.run || viewer} onClick={() => (setBasicOpen(false), b.run?.())}>
                  <I name={b.icon} />
                  <span className="grow">
                    {b.label}
                    {b.note && <small>{b.note}</small>}
                  </span>
                  <span className={`au-bs${b.ok ? " okc" : ""}`}>{b.status}</span>
                </button>
              ))}
            </div>
          </Sheet>
        )}
        {dialogs}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Desktop and web (round 2 mockup 01-automations-desktop)
  // ---------------------------------------------------------------------------
  return (
    <div className={wrap} data-testid="automations" data-state={empty ? "empty" : "ready"}>
      {notices}
      {empty ? (
        emptyState
      ) : (
        <div className="au-grid">
          <section className="au-card p0" aria-label="Automations">
            <div className="au-tool">
              <div className="ibx-seg" role="tablist" aria-label="State">
                {STATE_TABS.map((t) => (
                  <button key={t.id} type="button" role="tab" aria-selected={filters.tab === t.id} className={filters.tab === t.id ? "on" : undefined} onClick={() => setFilters((f) => ({ ...f, tab: t.id }))} data-testid={`automations.tab.${t.id}`}>
                    {t.label} {t.id === "all" ? <span className="cnt">{counts.all}</span> : counts[t.id]}
                  </button>
                ))}
              </div>
              <label className="ibx-input round">
                <I name="i-search" />
                <input type="search" placeholder="Search automations" aria-label="Search automations" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
              </label>
              <span className="sp" />
              <button type="button" className={`ibx-btn ghost${nFilters ? " on" : ""}`} aria-expanded={filterOpen} onClick={() => setFilterOpen((v) => !v)} data-testid="automations.filter">
                <I name="i-filter" />
                Filters{nFilters ? ` ${nFilters}` : ""}
              </button>
              <button type="button" className="ibx-btn ghost" onClick={() => setSort((s) => SORTS[(SORTS.findIndex((x) => x.id === s) + 1) % SORTS.length]!.id)} title="Change the order">
                <I name="i-sort" />
                {SORTS.find((s) => s.id === sort)!.label}
              </button>
              {filterOpen && (
                <Popover onClose={() => setFilterOpen(false)} className="au-pop filters" style={{ right: 14, top: 54 }} label="Filter automations">
                  {filterBody}
                  <div className="acts">
                    <button type="button" className="ibx-btn ghost" onClick={() => setFilters((f) => ({ ...NO_FILTERS, search: f.search, tab: f.tab }))}>
                      Reset
                    </button>
                    <button type="button" className="ibx-btn on" onClick={() => setFilterOpen(false)}>
                      Show {shown.length}
                    </button>
                  </div>
                </Popover>
              )}
            </div>

            {!shown.length && <p className="au-nomatch">{trash ? "The trash is empty." : "Nothing matches. Try another search or filter."}</p>}
            {groups.map((g) => {
              const isOpen = !collapsed.has(g.key);
              return (
                <div key={g.key} ref={g.zernio ? zernioGroup : undefined}>
                  <button
                    type="button"
                    className="au-lgh"
                    aria-expanded={isOpen}
                    onClick={() => setCollapsed((c) => (c.has(g.key) ? new Set([...c].filter((x) => x !== g.key)) : new Set([...c, g.key])))}
                  >
                    <I name={g.zernio ? "i-link" : "i-folder"} />
                    {g.label} <small>{g.rows.length}</small>
                    <I name="i-chev" className="chv" />
                  </button>
                  {isOpen && g.rows.map((r) => <DesktopRow key={r.id} r={r} viewer={viewer} trash={trash} menuOpen={menuFor?.id === r.id} onOpen={() => open(r)} onToggle={(on) => void toggle(r, on)} onMenu={() => setMenuFor(menuFor?.id === r.id ? null : r)} menu={menuFor?.id === r.id ? <Popover onClose={() => setMenuFor(null)} className="au-pop" style={{ right: 14, top: 46 }} label={`More for ${r.name}`}><ActionList items={menuItems(r)} onDone={() => setMenuFor(null)} desktop /></Popover> : null} />)}
                </div>
              );
            })}
            <div className="au-foot">
              <span>Runs: people who entered. CTR: share of them who tapped or opened anything.</span>
              <span>
                {trash ? `${rows.length} in the trash` : `${rows.length} ${rows.length === 1 ? "automation" : "automations"}, ${liveCount} live`}
                {(data.trashCount > 0 || trash) && (
                  <>
                    {" · "}
                    <button type="button" className="au-lnk" onClick={() => setTrash((t) => !t)} data-testid="automations.trash">
                      {trash ? "Back to automations" : `Trash ${data.trashCount}`}
                    </button>
                  </>
                )}
              </span>
            </div>
          </section>

          <aside className="au-side">
            <section className="au-card">
              <div className="sb">
                <div className="sect-t">
                  <h3>Recent comments</h3>
                </div>
                {runs && runs.total > runs.runs.length && (
                  <button type="button" className="au-lnk" onClick={() => setAllRuns(true)}>
                    See all
                  </button>
                )}
              </div>
              <div className="au-meter">
                <div className="sb">
                  <span>Private replies this hour</span>
                  <span>
                    <b>{data.sentLastHour}</b> of {data.budget}
                  </span>
                </div>
                <div className="au-prog">
                  <i style={{ width: `${Math.min(100, Math.round((data.sentLastHour / data.budget) * 100))}%` }} />
                </div>
              </div>
              {nativeAcc.map((a) => (
                <div key={a.accountId} className="au-kill" data-testid="automations.kill">
                  <span>
                    @{a.handle}: <b>{a.paused ? "paused" : "sending"}</b>
                  </span>
                  {!viewer && (
                    <button type="button" className="au-lnk" onClick={() => void kill(a.accountId, !a.paused)}>
                      {a.paused ? "Turn back on" : "Pause all"}
                    </button>
                  )}
                </div>
              ))}
              {!runs ? (
                <p className="au-empty-side">Loading...</p>
              ) : !runs.runs.length ? (
                <p className="au-empty-side">No comments yet. They show up here once Instagram is connected through Torerone's Meta app.</p>
              ) : (
                runs.runs.map((r) => <RunRow key={r.id} r={r} />)
              )}
            </section>
            <section className="au-card">
              <div className="sb" style={{ marginBottom: 6 }}>
                <div className="sect-t">
                  <h3>Basic replies</h3>
                  <small>{basic.on} of 5 on</small>
                </div>
              </div>
              {basic.rows.map((b) => (
                <button key={b.label} type="button" className="au-brow" disabled={!b.run || viewer} onClick={() => b.run?.()} title={b.note}>
                  <I name={b.icon} />
                  <span className="grow">{b.label}</span>
                  <span className={`s${b.ok ? " okc" : ""}`}>{b.status}</span>
                </button>
              ))}
            </section>
          </aside>
        </div>
      )}
      {dialogs}
    </div>
  );
}

function menuSub(r: AutoRow): string {
  if (r.source === "zernio") return `Zernio campaign${r.accountHandle ? ` on @${r.accountHandle}` : ""}`;
  const t = TRIGGER_CHIP[r.config.trigger];
  return `${t} ${r.config.trigger === "comment" || r.config.trigger === "dm_keyword" ? "keyword " : ""}on @${r.accountHandle}`;
}

function DesktopRow({
  r,
  viewer,
  trash,
  menuOpen,
  onOpen,
  onToggle,
  onMenu,
  menu,
}: {
  r: AutoRow;
  viewer: boolean;
  trash: boolean;
  menuOpen: boolean;
  onOpen(): void;
  onToggle(on: boolean): void;
  onMenu(): void;
  menu: React.ReactNode;
}) {
  const st = rowState(r);
  const line = triggerLine(r);
  const waiting = r.source === "native" ? r.waiting : null;
  const handle = r.source === "native" ? r.accountHandle : (r.accountHandle ?? "Zernio");
  return (
    <div className={`au-row${waiting ? " waiting" : ""}`} style={{ position: "relative" }} data-testid={`automations.row.${r.id}`}>
      <Dot state={st} />
      <button type="button" className="nm" onClick={onOpen}>
        <b>
          <span>{r.name}</span>
          {r.source === "zernio" && <span className="au-src">Zernio</span>}
        </b>
        <span className="au-trg">
          <I name={TRIGGER_ICON[rowTrigger(r)]} />
          {line.lead}
          {line.keywords.slice(0, 3).map((k) => (
            <span className="au-kw" key={k}>
              {k}
            </span>
          ))}
          {line.keywords.length > 3 && <span>+{line.keywords.length - 3}</span>}
          {line.tail}
        </span>
      </button>
      <Acct platform={r.platform} handle={handle} />
      <div className="stt">
        {st === "draft" && r.source === "native" ? (
          <span>
            <b>Draft</b>Edited {since(r.updatedAt)}
          </span>
        ) : waiting ? (
          <span title={waiting}>
            <b>{n0(r.stats.runs)}</b>
            <span>Waiting for Instagram</span>
          </span>
        ) : (
          <>
            {r.source === "native" && st === "live" && <Spark values={r.spark} />}
            <span>
              <b>{n0(r.stats.runs)}</b>
              {st === "off" ? (r.source === "native" ? `Off, edited ${since(r.updatedAt)}` : "Off") : pct(r.stats.ctr) ? `${pct(r.stats.ctr)} CTR` : "No link"}
            </span>
          </>
        )}
      </div>
      {trash ? (
        <span />
      ) : st === "draft" ? (
        <button type="button" className="pub" onClick={onOpen}>
          Finish
        </button>
      ) : (
        <Switch on={st === "live"} label={st === "live" ? `${r.name} is on` : `${r.name} is off`} disabled={viewer} onChange={onToggle} />
      )}
      {viewer && !trash ? (
        <span />
      ) : (
        <button type="button" className="more" aria-label={`More for ${r.name}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={onMenu}>
          <I name="i-dots-h" />
        </button>
      )}
      {menu}
    </div>
  );
}

/** A positioned popover that closes on Escape and on a click outside. */
function Popover({ children, onClose, className, style, label }: { children: React.ReactNode; onClose(): void; className: string; style: React.CSSProperties; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[aria-expanded='true']")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => (document.removeEventListener("mousedown", down), document.removeEventListener("keydown", key));
  }, [onClose]);
  return (
    <div ref={ref} className={className} style={style} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

function ActionList({ items, onDone, desktop }: { items: ReturnType<() => Array<{ icon: string; label: string; sub?: string; run(): void; bad?: boolean; disabled?: boolean; toggle?: boolean }>>; onDone(): void; desktop?: boolean }) {
  const main = items.filter((i) => !i.bad);
  const bad = items.filter((i) => i.bad);
  const btn = (i: (typeof items)[number]) => (
    <button
      key={i.label}
      type="button"
      className={desktop ? `pi${i.bad ? " bad" : ""}` : i.bad ? "bad" : undefined}
      role={i.toggle !== undefined ? "switch" : desktop ? "menuitem" : undefined}
      aria-checked={i.toggle !== undefined ? i.toggle : undefined}
      disabled={i.disabled}
      onClick={() => {
        onDone();
        i.run();
      }}
    >
      <I name={i.icon} />
      <span className="grow">
        {i.label}
        {!desktop && i.sub && <small>{i.sub}</small>}
      </span>
      {desktop && i.sub && i.toggle === undefined && <small>{i.sub.length > 22 ? "" : i.sub}</small>}
      {i.toggle !== undefined && <span className={`au-tog${i.toggle ? " on" : ""}`} aria-hidden="true" />}
    </button>
  );
  if (desktop) {
    return (
      <div role="menu">
        {main.map(btn)}
        {bad.length > 0 && <div className="sepl" />}
        {bad.map(btn)}
      </div>
    );
  }
  return (
    <>
      <div className="au-am">{main.map(btn)}</div>
      {bad.length > 0 && <div className="au-am">{bad.map(btn)}</div>}
    </>
  );
}

/** Who triggered a Zernio campaign (its logs): what the old DM campaigns card called Leads. */
function Leads({ clientId, row, phone, onClose }: { clientId: string; row: AutoRow; phone: boolean; onClose(): void }) {
  const [logs, setLogs] = useState<DmCampaignLog[] | null>(null);
  useEffect(() => {
    api
      .get<{ logs: DmCampaignLog[] }>(`/clients/${clientId}/dm-campaigns/${row.id}/logs`)
      .then((r) => setLogs(r.logs))
      .catch(() => setLogs([]));
  }, [clientId, row.id]);
  return (
    <Dialog phone={phone} title={row.name} sub="Zernio campaign: who triggered it and whether their DM went" onClose={onClose} testId="automations.leads" foot={<button type="button" className={phone ? "mb-btn block" : "au-hbtn"} onClick={onClose}>Close</button>}>
      {row.source === "zernio" && (
        <div className="au-stats3">
          <div>
            <div className="k">Runs</div>
            <div className="v">{n0(row.stats.runs)}</div>
          </div>
          <div>
            <div className="k">DMs sent</div>
            <div className="v">{n0(row.stats.sent)}</div>
          </div>
          <div>
            <div className="k">Link opens</div>
            <div className="v">{n0(row.stats.clicks)}</div>
          </div>
        </div>
      )}
      {logs === null ? (
        <p className="au-help">Loading...</p>
      ) : !logs.length ? (
        <p className="au-help">Nobody has triggered it yet.</p>
      ) : (
        <div>
          {logs.map((l) => (
            <div key={l.id} className="au-crow">
              <span className="t">
                <b>{l.commenterName ?? l.commenterId ?? "Someone"}</b>
                <small>{l.commentText ? `"${l.commentText.slice(0, 80)}"` : l.error ?? ""}</small>
              </span>
              <span className="r">
                <span className={`au-pill${l.status === "sent" ? " ok" : l.status === "failed" ? " bad" : l.status === "pending" ? " info" : ""}`}>{l.status === "sent" ? "DM sent" : l.status}</span>
                {l.source && l.source !== "comment" ? l.source.replace("_", " ") : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function FolderDialog({ phone, name, current, folders, onClose, onSave }: { phone: boolean; name: string; current: string | null; folders: string[]; onClose(): void; onSave(folder: string | null): void }) {
  const [v, setV] = useState(current ?? "");
  return (
    <Dialog
      phone={phone}
      title="Move to folder"
      sub={name}
      onClose={onClose}
      foot={
        <>
          <button type="button" className={phone ? "mb-btn" : "au-hbtn"} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={phone ? "mb-btn pri" : "au-hbtn pri"} onClick={() => onSave(v.trim() || null)}>
            Move
          </button>
        </>
      }
    >
      <div className="au-field">
        <label htmlFor="au-folder">Folder</label>
        <input id="au-folder" className={phone ? "mb-input" : "au-input"} list="au-folders" maxLength={40} placeholder="e.g. Lead magnets" value={v} onChange={(e) => setV(e.target.value)} />
        <datalist id="au-folders">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <p className="au-help">Leave it empty for No folder.</p>
      </div>
    </Dialog>
  );
}

/** New automation (round 1 mockup 04a): where it runs and a starting template. */
function NewAutomation({
  client,
  accounts,
  folders,
  phone,
  onClose,
  onCreate,
}: {
  client: ClientSummary;
  accounts: AutomationsList["accounts"];
  folders: string[];
  phone: boolean;
  onClose(): void;
  onCreate(accountId: string, template: DmTemplate, folder: string | null): void;
}) {
  const ig = accounts.filter((a) => a.platform === "instagram");
  const [accountId, setAccountId] = useState((ig[0] ?? accounts[0])?.accountId ?? "");
  const [folder, setFolder] = useState("");
  const [tpl, setTpl] = useState<DmTemplate>("comment_link");
  const acc = accounts.find((a) => a.accountId === accountId);
  const fb = acc?.platform === "facebook";
  const allowed = (t: DmTemplate) => !fb || t === "comment_link" || t === "blank";
  useEffect(() => {
    if (!allowed(tpl)) setTpl("comment_link");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fb]);
  const body = (
    <>
      <div className={phone ? "au-new-fields" : "au-two"}>
        <div className="au-field">
          <label htmlFor="au-new-acc">Account</label>
          <span className="au-select">
            {acc && <Pf p={PF_ID[acc.platform]} size="xs" />}
            <select id="au-new-acc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.platform === "facebook" ? `${a.handle} (Messenger, runs at Zernio)` : `@${a.handle}`}
                </option>
              ))}
            </select>
            <I name="i-chev" className="chev" />
          </span>
        </div>
        <div className="au-field">
          <label htmlFor="au-new-folder">Folder</label>
          <span className="au-select">
            <select id="au-new-folder" value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">No folder</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <I name="i-chev" className="chev" />
          </span>
        </div>
      </div>
      <div className="lbl">Start from a template</div>
      <div className={phone ? "au-tpls ph" : "au-tpls"} role="radiogroup" aria-label="Template">
        {TEMPLATE_ORDER.map((t) => {
          const info = DM_TEMPLATE_INFO[t];
          return (
            <button key={t} type="button" role="radio" aria-checked={tpl === t} className="au-tpl" disabled={!allowed(t)} onClick={() => setTpl(t)} data-testid={`automations.template.${t}`}>
              <span className="ic">
                <I name={info.icon} />
              </span>
              {tpl === t && (
                <span className="ck">
                  <I name="i-check" />
                </span>
              )}
              <b>{info.name}</b>
              <p>{info.blurb}</p>
              <span className="au-pill nodot">{info.tag}</span>
            </button>
          );
        })}
      </div>
      <p className="au-help">
        {fb ? "Messenger automations answer comments, and run at Zernio." : `Templates open in the simple editor for ${client.name}. Delays and branches come with the flow builder.`}
      </p>
    </>
  );
  const go = () => {
    onClose();
    onCreate(accountId, tpl, folder || null);
  };
  if (phone) {
    return (
      <Sheet
        label="New automation"
        title="New automation"
        sub="Pick where it runs and a starting point."
        onClose={onClose}
        className="au-sheet full"
        testId="automations.new-sheet"
        foot={
          <>
            <button type="button" className="mb-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="mb-btn pri" onClick={go} disabled={!accountId}>
              Use template
            </button>
          </>
        }
      >
        <div className="au-new">{body}</div>
      </Sheet>
    );
  }
  return (
    <Modal maxWidth={880} onClose={onClose} label="New automation" testId="automations.new-modal">
      <div className="ibx-wrap au au-modal">
        <div className="mh">
          <div className="grow">
            <h2>New automation</h2>
            <p>Pick where it runs and a starting point. You can change everything after.</p>
          </div>
          <button type="button" className="ibx-btn icon ghost" aria-label="Close" onClick={onClose}>
            <I name="i-x" />
          </button>
        </div>
        <div className="mb">{body}</div>
        <div className="mf">
          <button type="button" className="au-hbtn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="au-hbtn pri" onClick={go} disabled={!accountId} data-testid="automations.use-template">
            Use template
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <use href="#i-arrow-r" />
            </svg>
          </button>
        </div>
      </div>
    </Modal>
  );
}
