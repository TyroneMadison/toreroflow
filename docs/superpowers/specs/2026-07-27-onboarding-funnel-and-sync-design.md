# Onboarding: the torerone.com funnel, and the app noticing new brands

Date: 2026-07-27
Status: approved
Source: "List of improvments for the app.md", item 3, expanded by Tyrone's
answer during design: onboarding is driven by the website, not by extra
fields in the app's enroll popup.

## Context

Item 3 asks that the whole app recognize a newly onboarded brand and that
everything communicate automatically. Investigation found the app's context
propagation is mostly in place (Sidebar, Dashboard, Analytics, Settings
cards, and the Create section all react instantly to an enroll), with seven
concrete gaps listed under Part B.

Tyrone's design answer added the real onboarding vision: a client fills a
form on torerone.com before paying, the form reaches his inbox as a branded
email, payment happens through the existing Stripe payment links, and a
thank-you page closes the loop. The website repo is `hero-app` inside
E:\Claude Stuff\Website Stuff (its own git repo, deployed on Netlify,
publish dir dist, SPA redirect in place). Facts that shape the design:

- The five pricing cards are whole-card anchors straight to Stripe payment
  links (Starter $1,000, Growth $1,500, Scale $2,500, Premium $4,000,
  Elite $11,500), opening in a new tab today.
- The site has no forms, no serverless functions, no email service, and no
  thank-you page.
- The visual system is the `liquid-glass` class in src/index.css, Tailwind
  with one custom color (accent #FF6F61), Anton display font, Inter body.
- The existing full-screen About Me overlay is the modal precedent.
- The site makes zero fetch calls today; everything is anchors.

## Decisions

- The lead email address is `Toreronee@gmail.com` with the double e.
  Confirmed by Tyrone: the single-e address was taken. The site's existing
  mailto uses the same spelling.
- Social accounts on the form are collected as handles, not connected via
  OAuth. True website-to-app account linking needs the hosted backend
  (backlog conflict C3) and is deferred until then, per Tyrone: best
  version now, cross that road when hosted.
- The plan the visitor clicked is carried through the form and the email.
  Their monthly price is implied by the plan, so the app-side enroll needs
  no extra fields.
- Lead capture must never depend on the email service: submissions go to
  Netlify Forms first (stored in the Netlify dashboard), and the branded
  email is a layer on top.
- The branded email sends through Resend's free tier via a Netlify
  submission-created function. Until Tyrone creates the Resend account and
  adds RESEND_API_KEY in Netlify, the plain Netlify notification email is
  the fallback; no lead is ever lost either way.
- Two manual steps are Tyrone's alone: creating the Resend account and key,
  and setting each Stripe payment link's confirmation redirect to
  https://torerone.com/thank-you in the Stripe dashboard. Payment settings
  are never touched by the implementation.

## Part A: the funnel on torerone.com (hero-app repo)

### A1. Popup form on pricing click

Clicking any pricing card opens a modal instead of navigating: the page
behind dims and blurs (backdrop-blur overlay), and a liquid-glass panel in
the site's style presents the form. The chosen plan (name and price) shows
at the top of the form and travels with the submission. Fields, in order:

1. First and last name (required)
2. Email (required)
3. Phone (required)
4. The niche they are in (required)
5. Their ICP, ideal customer profile (textarea)
6. Top five inspiration accounts: five rows of name + username. At least
   one row filled; five offered.
7. "How did you hear about us?" (text)
8. "What's your end goal? What kind of results do you want?" (textarea)
9. Social handles, one field each: Facebook, Instagram, TikTok, YouTube,
   Snapchat (all optional)
10. "Is there anything else you want us to know?" (textarea, optional)

Escape and a close button dismiss the modal. Body scroll locks while open,
matching the About Me overlay behavior. Validation is inline and gentle;
required fields block submit with a visible cue, never a browser alert.

### A2. Submission path

The form is a Netlify Form (hidden static mirror in index.html so the
build-time form detection registers it). Submit posts the fields plus the
plan name and price. On success the browser navigates to the plan's Stripe
payment link in the same tab. On a failed post the modal shows an inline
error and offers retry; it never silently drops the lead or forwards to
payment without capturing.

### A3. The branded lead email

A Netlify function on the submission-created trigger renders the lead into
a dark, glass-styled HTML email consistent with the site: Torerone wordmark,
plan and price up top, then the lead's answers grouped (contact, niche and
ICP, inspiration accounts, goal, handles, notes). Subject line:
`New lead - {First} {Last} - {Plan} (${price}/mo)`. Sent to
Toreronee@gmail.com via Resend when RESEND_API_KEY is configured; the
function exits quietly when the key is absent.

### A4. Thank-you page

A `/thank-you` route in the SPA (History API, same mechanism as /about-me,
already covered by the _redirects SPA fallback). Site-styled gratitude page:
thanks for the purchase, this was the right next step for their business,
we will reach out soon. Linked nowhere on the site; it is the Stripe
post-payment landing target.

### A5. Deployment note

hero-app builds with `tsc -b && vite build`; commits stay local like the
app repo, Tyrone pushes and deploys. Netlify Forms and the function only
take effect once deployed; local verification covers the modal, validation,
navigation wiring, and the thank-you page.

## Part B: the app notices new brands (Toreroflow repo)

Fixes for the seven propagation gaps:

1. Account Overview refreshes itself when the client list changes and
   whenever a client is added mid-session (it currently fetches exactly
   once per mount).
2. FinancialsScreen refreshes its month payload when the client list
   changes, so the totals, donut, and charts stay in step with the
   RevenueSection rows that already update from context.
3. RevenueSection's savePrice also refreshes the client list, so the
   delete button's resurrect guard sees the new standing price immediately
   (today it wrongly shows delete right after pricing).
4. Settings auto-sync no longer latches once per mount: a client added
   while Settings is open gets its provider accounts synced too.
5. ReportsScreen re-reads publishing state when the client list changes,
   so a new brand's report link (assigned at create on purpose) shows
   without a remount.
6. Returning from a real platform connect refreshes the client list
   without requiring the manual "Sync connected" click, so connected
   accounts appear everywhere as soon as the connect completes.
7. Quota honesty for fulfilment billing: a client with billingMode
   on_fulfilment and no quota targets is treated as NOT delivered (today
   the absence of targets counts as always-met, which shows the Invoice
   button before any work exists). The month payload's quotaMet becomes
   false for target-less on_fulfilment clients; calendar-mode clients are
   unaffected.

## Out of scope, recorded so it is not lost

- True website-to-app provisioning and OAuth on the form: unlocked by the
  hosted backend decision (C3).
- Editing the `plan` label in-app (write-once at create today).
- The dead ScheduleSlot table: schema-only, zero code references; left in
  place, noted for a future schema cleanup.
- The quota-target editor stays on the Upload screen's quota card only.

## Verification

Part A, locally on the dev server: every pricing card opens the modal with
the right plan; required-field validation blocks; Escape and close work
with scroll restored; a submitted form navigates to the correct Stripe
link; /thank-you renders styled; the static form mirror matches the posted
field names; typecheck and build pass. After Tyrone deploys: one real
test submission lands in Netlify Forms and, once the key exists, the
branded email arrives.

Part B, live walk in the app: onboard a throwaway brand while sitting on
Account Overview and watch it appear without navigation; watch Financials
totals move when the brand gets priced from the unpriced row, and confirm
the delete button does not appear on the freshly priced row; confirm the
new brand's report link shows on Reports without remount; flip a client to
on_fulfilment with no targets and confirm no Invoice button and a
not-delivered state; delete the throwaway brand and confirm totals return.
All checks and typechecks across both repos pass.
