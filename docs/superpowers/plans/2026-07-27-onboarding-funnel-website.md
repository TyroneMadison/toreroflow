# Onboarding Funnel (torerone.com) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Part A of `E:\Claude Stuff\Toreroflow\docs\superpowers\specs\2026-07-27-onboarding-funnel-and-sync-design.md`: the pre-payment popup form on torerone.com, Netlify Forms capture, the branded lead email function, and the /thank-you page.

**Architecture:** All work happens in the WEBSITE repo at `E:\Claude Stuff\Website Stuff\hero-app` (its own git repo; NOT Toreroflow). A new OnboardingForm modal intercepts the pricing-card click and posts to Netlify Forms, then forwards the visitor to the plan's existing Stripe payment link. A `submission-created` Netlify function turns each submission into a styled HTML email via Resend when RESEND_API_KEY exists. A ThankYou component renders on the /thank-you path via the same History API pattern the site already uses for /about-me.

**Tech Stack:** Vite 8 + React 19 + TypeScript + Tailwind 3. Netlify hosting, publish dir `dist`, SPA `_redirects` already in place. No router library, no form library, no new npm dependencies (the function uses Node's global fetch).

## Global Constraints

- Working directory for every command and commit in this plan: `E:\Claude Stuff\Website Stuff\hero-app`.
- The lead email address is exactly `hello@example.com` (double e, confirmed correct).
- No new npm dependencies anywhere.
- Match the site's visual system: `liquid-glass` class, `accent` (#FF6F61), `font-display` (Anton, uppercase) for headings, Inter body, `rounded-2xl` cards, white/NN opacity ramps.
- Commit messages follow this repo's existing style: sentence case, no type prefix (see `git log`: "Add About Me page"). No AI attribution, no Co-Authored-By trailers. No em dashes anywhere.
- This repo has no test framework; the gates are `npm run lint` (oxlint) and `npm run build` (tsc -b && vite build), plus the live walk in Task 5.
- Lead capture must never depend on email: the form posts to Netlify Forms first; the email function is a layer on top and exits quietly without a key.
- Never touch the Stripe payment links' values; they are carried verbatim from Pricing.tsx.
- In `import.meta.env.DEV` the Netlify form POST is skipped (there is no Forms endpoint locally) and the flow proceeds as if captured; the skip is logged to the console.

---

### Task 1: OnboardingForm modal and Pricing wiring

**Files:**
- Create: `src/components/OnboardingForm.tsx`
- Modify: `src/sections/Pricing.tsx`

**Interfaces:**
- Produces: `export interface PlanChoice { name: string; price: string; link: string }` and `export default function OnboardingForm({ plan, onClose }: { plan: PlanChoice | null; onClose: () => void })`. Task 2 fills in the submit path (this task stubs it as a direct forward); Task 5 walks it.
- Consumes: the existing `liquid-glass` CSS class and Tailwind tokens.

- [ ] **Step 1: Create the component**

`src/components/OnboardingForm.tsx`:

```tsx
import { useEffect, useState } from 'react'

export interface PlanChoice {
  name: string
  price: string
  link: string
}

interface Handle {
  key: string
  label: string
  placeholder: string
}

const HANDLES: Handle[] = [
  { key: 'handle-facebook', label: 'Facebook', placeholder: 'facebook.com/yourpage' },
  { key: 'handle-instagram', label: 'Instagram', placeholder: '@yourhandle' },
  { key: 'handle-tiktok', label: 'TikTok', placeholder: '@yourhandle' },
  { key: 'handle-youtube', label: 'YouTube', placeholder: '@yourchannel' },
  { key: 'handle-snapchat', label: 'Snapchat', placeholder: '@yourhandle' },
]

const REQUIRED = ['first-name', 'last-name', 'email', 'phone', 'niche'] as const

const inputClass =
  'w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-white/30 focus:outline-none focus:border-accent/60 transition-colors'

const labelClass = 'block text-white/60 text-xs uppercase tracking-widest font-semibold mb-2'

function Field({
  name,
  label,
  value,
  onChange,
  missing,
  type = 'text',
  placeholder = '',
}: {
  name: string
  label: string
  value: string
  onChange: (v: string) => void
  missing?: boolean
  type?: string
  placeholder?: string
}) {
  return (
    <div>
      <label htmlFor={name} className={labelClass}>
        {label}
        {missing && <span className="text-accent normal-case tracking-normal"> · required</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} ${missing ? 'border-accent/70' : ''}`}
      />
    </div>
  )
}

function Area({
  name,
  label,
  value,
  onChange,
  placeholder = '',
}: {
  name: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div>
      <label htmlFor={name} className={labelClass}>
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        rows={3}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} resize-none`}
      />
    </div>
  )
}

function OnboardingForm({ plan, onClose }: { plan: PlanChoice | null; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const open = plan !== null

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!plan) return null

  const set = (key: string) => (v: string) => setValues((prev) => ({ ...prev, [key]: v }))
  const val = (key: string) => values[key] ?? ''

  const submit = async () => {
    const gaps = new Set(REQUIRED.filter((k) => !val(k).trim()))
    const anyInspo = [1, 2, 3, 4, 5].some(
      (i) => val(`inspo-${i}-name`).trim() || val(`inspo-${i}-username`).trim(),
    )
    if (!anyInspo) gaps.add('inspo-1-name')
    setMissing(gaps)
    if (gaps.size > 0) return

    setSubmitting(true)
    setSubmitError(null)
    const ok = await captureLead(values, plan)
    if (ok) {
      window.location.assign(plan.link)
    } else {
      setSubmitting(false)
      setSubmitError('That did not go through. Please try again, nothing was lost.')
    }
  }

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto">
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-md"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative min-h-full flex items-start md:items-center justify-center p-4 md:p-8">
        <div className="liquid-glass rounded-2xl w-full max-w-2xl bg-black/60 p-6 md:p-10 relative">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute top-4 right-4 w-9 h-9 rounded-full liquid-glass text-white/70 hover:text-white text-xl leading-none"
          >
            ×
          </button>

          <div className="text-accent uppercase tracking-[0.3em] text-xs font-semibold">
            {plan.name} · {plan.price}/mo
          </div>
          <h3 className="mt-3 font-display uppercase leading-[0.95] text-3xl md:text-4xl text-white tracking-tight">
            Before we
            <br />
            get started
          </h3>
          <p className="mt-3 text-white/60 text-sm leading-relaxed">
            Tell us who you are and where you want to go. This is what we build your content
            game plan from.
          </p>

          <div className="mt-8 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field name="first-name" label="First name" value={val('first-name')} onChange={set('first-name')} missing={missing.has('first-name')} />
              <Field name="last-name" label="Last name" value={val('last-name')} onChange={set('last-name')} missing={missing.has('last-name')} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field name="email" label="Email" type="email" value={val('email')} onChange={set('email')} missing={missing.has('email')} />
              <Field name="phone" label="Phone" type="tel" value={val('phone')} onChange={set('phone')} missing={missing.has('phone')} />
            </div>
            <Field name="niche" label="What niche are you in?" value={val('niche')} onChange={set('niche')} missing={missing.has('niche')} placeholder="e.g. exotic car sales" />
            <Area name="icp" label="Who is your ideal customer?" value={val('icp')} onChange={set('icp')} placeholder="Who are you trying to reach?" />

            <div>
              <div className={labelClass}>
                Top five accounts that inspire you
                {missing.has('inspo-1-name') && (
                  <span className="text-accent normal-case tracking-normal"> · give us at least one</span>
                )}
              </div>
              <p className="text-white/40 text-xs mb-3">
                We study what already works in your lane and build from there.
              </p>
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="grid grid-cols-2 gap-2">
                    <input
                      name={`inspo-${i}-name`}
                      value={val(`inspo-${i}-name`)}
                      placeholder={`Account ${i} name`}
                      onChange={(e) => set(`inspo-${i}-name`)(e.target.value)}
                      className={`${inputClass} ${i === 1 && missing.has('inspo-1-name') ? 'border-accent/70' : ''}`}
                    />
                    <input
                      name={`inspo-${i}-username`}
                      value={val(`inspo-${i}-username`)}
                      placeholder="@username"
                      onChange={(e) => set(`inspo-${i}-username`)(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                ))}
              </div>
            </div>

            <Field name="heard-from" label="How did you hear about us?" value={val('heard-from')} onChange={set('heard-from')} />
            <Area name="end-goal" label="What is your end goal? What kind of results do you want?" value={val('end-goal')} onChange={set('end-goal')} />

            <div>
              <div className={labelClass}>Your social accounts</div>
              <p className="text-white/40 text-xs mb-3">
                Drop your handles and we connect everything with you at kickoff.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {HANDLES.map((h) => (
                  <div key={h.key} className="flex items-center gap-2">
                    <span className="text-white/50 text-xs w-20 flex-none">{h.label}</span>
                    <input
                      name={h.key}
                      value={val(h.key)}
                      placeholder={h.placeholder}
                      onChange={(e) => set(h.key)(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                ))}
              </div>
            </div>

            <Area name="notes" label="Is there anything else you want us to know?" value={val('notes')} onChange={set('notes')} />
          </div>

          {submitError && (
            <div className="mt-5 text-accent text-sm border border-accent/40 rounded-xl px-4 py-3 bg-accent/10">
              {submitError}
            </div>
          )}

          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="mt-8 w-full bg-accent text-black font-bold uppercase tracking-wide rounded-xl py-4 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {submitting ? 'One moment…' : `Continue to checkout · ${plan.price}/mo`}
          </button>
          <p className="mt-3 text-center text-white/40 text-xs">
            Next stop is secure payment through Stripe.
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Posts the lead to Netlify Forms. Returns true when captured. In dev there
 * is no Forms endpoint, so the capture is skipped and treated as success.
 * Replaced with the real implementation in the next task; this stub keeps
 * Task 1 independently walkable.
 */
async function captureLead(values: Record<string, string>, plan: PlanChoice): Promise<boolean> {
  void values
  void plan
  return true
}

export default OnboardingForm
```

- [ ] **Step 2: Wire Pricing to open the modal**

In `src/sections/Pricing.tsx`:

Replace the first line and add state. The whole file's changes:

At the top:

```tsx
import { useState } from 'react'
import Reveal from '../components/Reveal'
import OnboardingForm, { type PlanChoice } from '../components/OnboardingForm'
```

Inside `function Pricing()`, first line of the body:

```tsx
  const [selectedPlan, setSelectedPlan] = useState<PlanChoice | null>(null)
```

Replace the package card anchor (`<a href={pkg.link} target="_blank" rel="noopener noreferrer" className={...}>` through its closing `</a>`) with a button carrying the same classes and children:

```tsx
              <button
                type="button"
                onClick={() => setSelectedPlan({ name: pkg.name, price: pkg.price, link: pkg.link })}
                className={`liquid-glass rounded-2xl p-6 md:p-8 h-full block w-full text-left hover:bg-white/5 transition-colors ${
                  pkg.badge ? 'border border-accent/50' : ''
                }`}
              >
                <div className="text-accent uppercase tracking-[0.2em] text-xs font-semibold">{pkg.name}</div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="font-display text-4xl text-white">{pkg.price}</span>
                  <span className="text-white/40 text-xl">/mo</span>
                </div>
                <div className="mt-3 text-white/80 text-sm font-medium">{pkg.features[0]}</div>
                <div className="text-white/40 text-xs">{pkg.features[1]}</div>
              </button>
```

Replace the Elite anchor the same way (same classes plus `w-full text-left`), with:

```tsx
          <button
            type="button"
            onClick={() => setSelectedPlan({ name: 'Elite', price: elite.price, link: elite.link })}
            className="block w-full text-left liquid-glass rounded-2xl p-6 md:p-8 border border-accent/50 hover:bg-white/5 transition-colors"
          >
```

(keep its inner content unchanged, closing with `</button>`).

Before the closing `</section>` tag, render the modal:

```tsx
        <OnboardingForm plan={selectedPlan} onClose={() => setSelectedPlan(null)} />
```

- [ ] **Step 3: Lint and build**

Run from `E:\Claude Stuff\Website Stuff\hero-app`: `npm run lint` then `npm run build`
Expected: lint clean; build succeeds (`tsc -b && vite build`).

- [ ] **Step 4: Commit**

```bash
git add src/components/OnboardingForm.tsx src/sections/Pricing.tsx
git commit -m "Add onboarding form popup before checkout"
```

---

### Task 2: Netlify Forms capture and the Stripe forward

**Files:**
- Modify: `src/components/OnboardingForm.tsx` (the `captureLead` stub)
- Modify: `index.html` (static form mirror)

**Interfaces:**
- Consumes: Task 1's field names.
- Produces: a registered Netlify form named `onboarding` whose field set the Task 3 function reads.

- [ ] **Step 1: Real captureLead**

Replace the stub `captureLead` at the bottom of `src/components/OnboardingForm.tsx` with:

```tsx
/**
 * Posts the lead to Netlify Forms. Returns true when captured. The form
 * post is the capture of record; payment forwarding only happens after it
 * succeeds, so a lead is never lost between the form and Stripe. In dev
 * there is no Forms endpoint, so the capture is skipped and treated as
 * success (logged for honesty).
 */
async function captureLead(values: Record<string, string>, plan: PlanChoice): Promise<boolean> {
  if (import.meta.env.DEV) {
    console.info('[dev] skipping Netlify Forms post, would submit:', { ...values, plan: plan.name })
    return true
  }
  const body = new URLSearchParams()
  body.set('form-name', 'onboarding')
  for (const [key, value] of Object.entries(values)) body.set(key, value)
  body.set('plan', plan.name)
  body.set('price', plan.price)
  try {
    const res = await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    return res.ok
  } catch {
    return false
  }
}
```

- [ ] **Step 2: Static mirror in index.html**

Netlify's build-time crawler registers forms from static HTML only. In `index.html`, add inside `<body>` after the root div:

```html
    <form name="onboarding" data-netlify="true" netlify-honeypot="bot-field" hidden>
      <input name="bot-field" />
      <input name="first-name" /><input name="last-name" />
      <input name="email" /><input name="phone" />
      <input name="niche" /><textarea name="icp"></textarea>
      <input name="inspo-1-name" /><input name="inspo-1-username" />
      <input name="inspo-2-name" /><input name="inspo-2-username" />
      <input name="inspo-3-name" /><input name="inspo-3-username" />
      <input name="inspo-4-name" /><input name="inspo-4-username" />
      <input name="inspo-5-name" /><input name="inspo-5-username" />
      <input name="heard-from" /><textarea name="end-goal"></textarea>
      <input name="handle-facebook" /><input name="handle-instagram" />
      <input name="handle-tiktok" /><input name="handle-youtube" />
      <input name="handle-snapchat" /><textarea name="notes"></textarea>
      <input name="plan" /><input name="price" />
    </form>
```

- [ ] **Step 3: Lint, build, commit**

Run: `npm run lint` and `npm run build`. Expected: clean.

```bash
git add src/components/OnboardingForm.tsx index.html
git commit -m "Capture onboarding leads through Netlify Forms before Stripe"
```

---

### Task 3: netlify.toml and the branded lead email function

**Files:**
- Create: `netlify.toml`
- Create: `netlify/functions/submission-created.mjs`

**Interfaces:**
- Consumes: the `onboarding` form's field names from Task 2; env var `RESEND_API_KEY` (set by Tyrone in the Netlify UI later).
- Produces: an email to hello@example.com per submission, subject `New lead - {First} {Last} - {Plan} ({price}/mo)`.

- [ ] **Step 1: netlify.toml**

Create `netlify.toml` at the repo root with values matching the current UI settings so nothing regresses:

```toml
[build]
  command = "npm run build"
  publish = "dist"
  functions = "netlify/functions"
```

- [ ] **Step 2: The function**

Netlify invokes a function named `submission-created` for every verified form submission. Create `netlify/functions/submission-created.mjs`:

```js
// Sends the branded lead email for each onboarding form submission.
// Capture already happened (Netlify Forms stores the submission before this
// runs), so this function failing can never lose a lead. Without a
// RESEND_API_KEY it exits quietly and the plain Netlify notification email
// is the fallback.

const ACCENT = "#FF6F61";
const TO = "hello@example.com";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const row = (label, value) =>
  value && String(value).trim()
    ? `<tr>
         <td style="padding:6px 14px 6px 0;color:#ffffff99;font-size:12px;text-transform:uppercase;letter-spacing:1px;vertical-align:top;white-space:nowrap;">${esc(label)}</td>
         <td style="padding:6px 0;color:#ffffff;font-size:14px;line-height:1.5;">${esc(value)}</td>
       </tr>`
    : "";

const card = (title, inner) =>
  `<div style="background:#101014;border:1px solid #ffffff22;border-radius:16px;padding:20px 22px;margin-top:14px;">
     <div style="color:${ACCENT};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:3px;margin-bottom:10px;">${esc(title)}</div>
     <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${inner}</table>
   </div>`;

export const handler = async (event) => {
  const payload = JSON.parse(event.body ?? "{}").payload ?? {};
  const d = payload.data ?? {};
  if ((payload.form_name ?? d["form-name"]) !== "onboarding" && payload.form_name !== undefined) {
    return { statusCode: 200, body: "ignored: not the onboarding form" };
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log("RESEND_API_KEY not set; relying on the Netlify notification email");
    return { statusCode: 200, body: "no key" };
  }

  const first = d["first-name"] ?? "";
  const last = d["last-name"] ?? "";
  const plan = d["plan"] ?? "Unknown plan";
  const price = d["price"] ?? "";

  const inspo = [1, 2, 3, 4, 5]
    .map((i) => {
      const name = d[`inspo-${i}-name`];
      const user = d[`inspo-${i}-username`];
      return name || user ? row(`Account ${i}`, [name, user].filter(Boolean).join(" · ")) : "";
    })
    .join("");

  const html = `
  <div style="background:#000000;padding:32px 16px;font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;">
    <div style="max-width:600px;margin:0 auto;">
      <div style="text-align:center;padding-bottom:8px;">
        <div style="color:#ffffff;font-size:26px;font-weight:800;letter-spacing:4px;text-transform:uppercase;">Torerone</div>
        <div style="color:${ACCENT};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:3px;margin-top:6px;">New lead</div>
      </div>
      <div style="background:#101014;border:1px solid ${ACCENT}66;border-radius:16px;padding:22px;margin-top:14px;text-align:center;">
        <div style="color:#ffffff;font-size:22px;font-weight:800;">${esc(first)} ${esc(last)}</div>
        <div style="color:${ACCENT};font-size:15px;font-weight:700;margin-top:6px;">${esc(plan)} · ${esc(price)}/mo</div>
      </div>
      ${card("Contact", row("Email", d["email"]) + row("Phone", d["phone"]))}
      ${card("Niche and audience", row("Niche", d["niche"]) + row("Ideal customer", d["icp"]))}
      ${inspo ? card("Inspiration accounts", inspo) : ""}
      ${card("Goals", row("End goal", d["end-goal"]) + row("Heard about us", d["heard-from"]))}
      ${card(
        "Social handles",
        row("Facebook", d["handle-facebook"]) +
          row("Instagram", d["handle-instagram"]) +
          row("TikTok", d["handle-tiktok"]) +
          row("YouTube", d["handle-youtube"]) +
          row("Snapchat", d["handle-snapchat"]),
      )}
      ${d["notes"] ? card("Anything else", row("Notes", d["notes"])) : ""}
      <div style="text-align:center;color:#ffffff55;font-size:11px;margin-top:18px;">
        Sent by the torerone.com onboarding form
      </div>
    </div>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Torerone Leads <onboarding@resend.dev>",
      to: [TO],
      subject: `New lead - ${first} ${last} - ${plan} (${price}/mo)`.trim(),
      html,
    }),
  });
  if (!res.ok) {
    console.error("resend failed", res.status, await res.text());
    return { statusCode: 200, body: "email failed, submission already stored" };
  }
  return { statusCode: 200, body: "sent" };
};
```

Note the email approximates the site's glass look with solid dark cards and the coral accent; email clients support neither backdrop blur nor the Anton font, so the closest honest rendering wins over a broken fancy one.

- [ ] **Step 3: Lint, build, commit**

Run: `npm run lint` and `npm run build`. Expected: clean (the function is not part of the Vite build; tsc does not cover .mjs and that is fine).

```bash
git add netlify.toml netlify/functions/submission-created.mjs
git commit -m "Send a branded lead email for each onboarding submission"
```

---

### Task 4: The /thank-you page

**Files:**
- Create: `src/components/ThankYou.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: the SPA `_redirects` fallback (already present) so a full-page load of /thank-you serves the app.
- Produces: `<ThankYou />`, self-managing on `window.location.pathname === '/thank-you'`, matching the /about-me History API pattern.

- [ ] **Step 1: The component**

`src/components/ThankYou.tsx`:

```tsx
import { useEffect, useState } from 'react'
import Reveal from './Reveal'

const PATH = '/thank-you'

function ThankYou() {
  const [open, setOpen] = useState(() => window.location.pathname === PATH)

  useEffect(() => {
    const onPop = () => setOpen(window.location.pathname === PATH)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null

  const goHome = () => {
    window.history.replaceState(null, '', '/')
    setOpen(false)
    window.scrollTo(0, 0)
  }

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-black flex items-center justify-center px-6">
      <div className="max-w-2xl text-center py-16">
        <Reveal>
          <div className="text-accent uppercase tracking-[0.3em] text-xs md:text-sm font-semibold">
            Thank you
          </div>
        </Reveal>
        <Reveal delay={80}>
          <h1 className="mt-4 font-display uppercase leading-[0.95] text-5xl md:text-7xl text-white tracking-tight">
            You just made
            <br />
            the right move
          </h1>
          <div className="mt-6 w-16 h-1 bg-accent rounded-full mx-auto" />
        </Reveal>
        <Reveal delay={140}>
          <p className="mt-8 text-white/70 text-base md:text-lg leading-relaxed">
            Your purchase went through, and we are genuinely glad you chose to take this next
            step in your business with us. We already have everything you shared, and we are
            getting to work on it. Expect to hear from us soon with your kickoff.
          </p>
        </Reveal>
        <Reveal delay={200}>
          <button
            type="button"
            onClick={goHome}
            className="mt-10 liquid-glass rounded-full px-8 py-4 text-white font-semibold hover:bg-white/5 transition-colors"
          >
            Back to torerone.com
          </button>
        </Reveal>
      </div>
    </div>
  )
}

export default ThankYou
```

- [ ] **Step 2: Mount it in App.tsx**

In `src/App.tsx`, add the import and render it last inside the root div:

```tsx
import ThankYou from './components/ThankYou'
```

```tsx
      <Contact />
      <ThankYou />
    </div>
```

- [ ] **Step 3: Lint, build, commit**

Run: `npm run lint` and `npm run build`. Expected: clean.

```bash
git add src/components/ThankYou.tsx src/App.tsx
git commit -m "Add the thank-you page for the post-payment landing"
```

---

### Task 5: Local verification walk

**Files:** none. Runs against the dev server (`.claude/launch.json` in E:\Claude Stuff\Website Stuff defines `hero-app-dev`, `npm run dev`, port 5173).

- [ ] **Step 1:** Open the site locally, scroll to Pricing. Click each of the five cards: the modal opens over a blurred, dimmed page, titled with the right plan name and price each time. Escape and the close button both dismiss it, and page scroll returns.
- [ ] **Step 2:** Click Continue with everything empty: the five required fields and the inspiration block flag inline, no navigation happens, no browser alert appears.
- [ ] **Step 3:** Fill the required fields plus one inspiration row and submit: the console logs the dev-mode capture skip and the browser navigates to the plan's exact buy.stripe.com URL. Do not pay; navigate back.
- [ ] **Step 4:** Visit /thank-you directly: the page renders in site style; Back to torerone.com returns to the homepage cleanly.
- [ ] **Step 5:** `npm run lint`, `npm run build`, and `git status` (clean tree, all work committed).

---

## After the plan: Tyrone's manual steps plus deploy

Recorded here so they are not lost; none can be done by the implementation:

1. BLOCKING, before the deploy: in the Netlify dashboard under Forms, turn
   ON form detection for the site. This site has never had forms, so it is
   almost certainly off. With detection off, the deploy never registers the
   form, the browser's POST falls through the SPA redirect with a 200, and
   every lead is silently lost while the visitor still reaches Stripe and
   pays. The first deploy MUST be followed by a real test submission that
   shows up under Forms before the funnel is trusted.
2. Create a free resend.com account USING hello@example.com as the
   account address (Resend's shared onboarding@resend.dev sender only
   delivers to the account owner's own address; a different account address
   means the branded email silently never arrives). Then in Netlify site
   settings add the environment variable `RESEND_API_KEY`. Until then every
   lead still lands in Netlify Forms; also enable the plain email
   notification for the `onboarding` form in the Netlify Forms settings,
   pointed at hello@example.com, as the always-on fallback.
3. In the Stripe dashboard, edit each of the five payment links and set the
   after-payment confirmation page to `https://torerone.com/thank-you`.
4. Push hero-app and deploy on Netlify as usual. Forms registration and the
   function only take effect after a deploy.
