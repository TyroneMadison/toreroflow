import { useState, type ReactNode } from "react";
import { parseHandles } from "../lib/longform";
import { captionProblems, meterLimits, TIKTOK_PRIVACY, type TikTokChoice } from "../lib/postDetails";
import type { Platform } from "../lib/platforms";
import { hashtagCount, mentionCount } from "@toreroflow/core";

/**
 * The post-details pieces from mockups ig-02 and ig-03, shared by the
 * schedule modal, the long-form wizard and the Carousels tab so a caption
 * limit or a trial explanation reads the same everywhere.
 */

/** A coral segmented control: role=radiogroup, 44px, arrow keys move. */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  value: T;
  options: ReadonlyArray<{ id: NoInfer<T>; label: string; disabled?: string | null }>;
  onChange(v: NoInfer<T>): void;
  label: string;
  testId?: string;
}) {
  return (
    <div className="lfdest pd-seg" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o, i) => (
        <button
          type="button"
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          aria-disabled={o.disabled ? true : undefined}
          title={o.disabled ?? undefined}
          tabIndex={value === o.id ? 0 : -1}
          className={value === o.id ? "on" : undefined}
          data-testid={testId ? `${testId}-${o.id}` : undefined}
          onClick={() => !o.disabled && onChange(o.id)}
          onKeyDown={(e) => {
            const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const next = options[(i + step + options.length) % options.length]!;
            if (next.disabled) return;
            onChange(next.id);
            (e.currentTarget.parentElement?.children[options.indexOf(next)] as HTMLElement | undefined)?.focus();
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Caption with the live checker: characters, hashtags and mentions against
 * the chosen platforms' limits, and the reason it cannot post when over.
 * The caller blocks submit on captionProblems(); the server refuses too.
 */
export function CaptionField({
  id,
  value,
  onChange,
  counted = value,
  platforms,
  photo = false,
  label = "Caption",
  rows = 5,
  placeholder,
}: {
  id: string;
  value: string;
  onChange(v: string): void;
  /** The words that actually post, when more than the box (a caption block, hashtags). */
  counted?: string;
  platforms: Platform[];
  photo?: boolean;
  label?: ReactNode;
  rows?: number;
  placeholder?: string;
}) {
  const limits = meterLimits(platforms, photo);
  const problems = captionProblems(platforms, counted, photo);
  const stat = (n: number, max: number | null, word: string) => (
    <div className={`pd-stat${max != null && n > max ? " over" : ""}`}>
      <b>{n.toLocaleString("en-US")}</b>
      <span>{max != null ? `of ${max.toLocaleString("en-US")} ${word}` : word}</span>
    </div>
  );
  return (
    <div className="pd-caption">
      <label className="flabel" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="field-in lfdesc"
        rows={rows}
        value={value}
        placeholder={placeholder}
        aria-invalid={problems.length > 0}
        aria-describedby={`${id}-meter`}
        onChange={(e) => onChange(e.target.value)}
      />
      {limits && (
        <div className="pd-meter" id={`${id}-meter`} aria-live="polite">
          {stat(counted.length, limits.chars, "characters")}
          {stat(hashtagCount(counted), limits.hashtags, limits.hashtags != null ? "hashtags" : "hashtags (no limit)")}
          {stat(mentionCount(counted), limits.mentions, limits.mentions != null ? "mentions" : "mentions (no limit)")}
        </div>
      )}
      {problems.map((p) => (
        <div className="lfnote bad pd-over" role="alert" key={p}>
          {p}
        </div>
      ))}
    </div>
  );
}

/** Usernames as removable chips, up to max. */
export function HandleChips({
  id,
  label,
  hint,
  max,
  value,
  onChange,
  note,
}: {
  id: string;
  label: string;
  hint?: string;
  max?: number;
  value: string[];
  onChange(v: string[]): void;
  note?: string;
}) {
  const [draft, setDraft] = useState("");
  const full = max != null && value.length >= max;
  const add = () => {
    const next = [...value];
    for (const h of parseHandles(draft)) if (!next.includes(h) && (max == null || next.length < max)) next.push(h);
    onChange(next);
    setDraft("");
  };
  return (
    <div className="pd-handles">
      <label className="flabel" htmlFor={id}>
        {label}
        {max != null && <span className="hint">{value.length} of {max}</span>}
        {hint && max == null && <span className="hint">{hint}</span>}
      </label>
      <input
        id={id}
        className="field-in"
        placeholder={full ? `That's all ${max}` : "Add a username, then Enter"}
        disabled={full}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() && add()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
      />
      {value.length > 0 && (
        <div className="pd-chips">
          {value.map((h) => (
            <button
              type="button"
              className="pd-chip"
              key={h}
              aria-label={`Remove @${h}`}
              onClick={() => onChange(value.filter((x) => x !== h))}
            >
              @{h} <span aria-hidden="true">✕</span>
            </button>
          ))}
        </div>
      )}
      {note && <p className="lnote">{note}</p>}
    </div>
  );
}

/** A Facebook place id for Instagram's location. */
export function LocationField({ id, value, onChange }: { id: string; value: string; onChange(v: string): void }) {
  const bad = value.trim() !== "" && !/^\d+$/.test(value.trim());
  return (
    <div>
      <label className="flabel" htmlFor={id}>
        Location<span className="hint">Facebook place page id</span>
      </label>
      <input
        id={id}
        className="field-in"
        inputMode="numeric"
        placeholder="e.g. 105890561436614"
        value={value}
        aria-invalid={bad}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className={bad ? "lnote pd-err" : "lnote"}>
        {bad
          ? "Use the place page's number, not its name."
          : "Only places with a location page can be tagged."}
      </p>
    </div>
  );
}

/** Rename the reel's original audio, with the once-only warning. */
export function AudioNameField({ id, value, onChange }: { id: string; value: string; onChange(v: string): void }) {
  return (
    <div>
      <label className="flabel" htmlFor={id}>
        Rename original audio<span className="hint">replaces "Original audio"</span>
      </label>
      <input
        id={id}
        className="field-in"
        maxLength={120}
        placeholder="e.g. Dud Rents original audio"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value.trim() && (
        <div className="lfnote warn" role="note">
          <span>
            <b>You can only rename this once.</b> After posting it is locked for good.
          </span>
        </div>
      )}
    </div>
  );
}

/** A switch row: label left, switch right, the whole row a 48px target. */
export function SwitchRow({
  checked,
  onChange,
  children,
  testId,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="lfswitch" data-testid={testId} onClick={() => onChange(!checked)}>
      <span>{children}</span> <i aria-hidden="true" />
    </button>
  );
}

/** Trial reel: non-followers first, then shared to followers one of two ways. */
export function TrialChoice({
  trial,
  onTrial,
  graduate,
  onGraduate,
}: {
  trial: boolean;
  onTrial(v: boolean): void;
  graduate: "MANUAL" | "SS_PERFORMANCE";
  onGraduate(v: "MANUAL" | "SS_PERFORMANCE"): void;
}) {
  return (
    <div className="pd-trial">
      <SwitchRow checked={trial} onChange={onTrial} testId="trial-switch">
        Post as a trial reel (non-followers first)
      </SwitchRow>
      {trial && (
        <>
          <label className="flabel" style={{ marginTop: 12 }}>
            Share to followers
          </label>
          <Seg
            label="Share to followers"
            value={graduate}
            onChange={onGraduate}
            testId="trial-share"
            options={[
              { id: "MANUAL", label: "Manually" },
              { id: "SS_PERFORMANCE", label: "If it performs well" },
            ]}
          />
          {graduate === "MANUAL" ? (
            <div className="lfnote warn" role="note">
              <span>
                <b>Manually:</b> someone has to tap share in the Instagram app. Toreroflow cannot do it for you.
              </span>
            </div>
          ) : (
            <div className="lfnote" role="note">
              <span>
                <b>If it performs well:</b> Instagram shares it to followers on its own.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * TikTok's post settings through Zernio: who can see it, comments, and for a
 * video duet and stitch. Location, collaborators and people tags are not
 * offered: Zernio has no TikTok field for collaborators or tags, and its
 * location only works for Business-app accounts on video posts.
 */
export function TikTokFields({
  value,
  onChange,
  photo,
}: {
  value: TikTokChoice;
  onChange(v: TikTokChoice): void;
  photo: boolean;
}) {
  return (
    <div className="pd-tiktok">
      <label className="flabel">Who can see it</label>
      <Seg
        label="TikTok privacy"
        value={value.privacyLevel}
        onChange={(privacyLevel) => onChange({ ...value, privacyLevel })}
        testId="tiktok-privacy"
        options={TIKTOK_PRIVACY.map((p) => ({ id: p.value as string, label: p.label }))}
      />
      <p className="lnote">
        If the account doesn't allow a choice, TikTok refuses the post. Business accounts post videos to Everyone only.
      </p>
      <SwitchRow checked={value.allowComment} onChange={(allowComment) => onChange({ ...value, allowComment })}>
        Allow comments
      </SwitchRow>
      {!photo && (
        <>
          <SwitchRow checked={value.allowDuet} onChange={(allowDuet) => onChange({ ...value, allowDuet })}>
            Allow duet
          </SwitchRow>
          <SwitchRow checked={value.allowStitch} onChange={(allowStitch) => onChange({ ...value, allowStitch })}>
            Allow stitch
          </SwitchRow>
        </>
      )}
    </div>
  );
}

/** The same allowance sentence the long-form checks show. */
export function igLimitText(limit: { used: number; total: number } | null): string | null {
  if (!limit || limit.total <= 0) return null;
  return `${limit.used} of ${limit.total} Instagram API posts used in the last 24 hours.`;
}
