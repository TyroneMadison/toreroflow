# Client report integration plan

Written 2026-07-26, assessing the dynamic Torerone report template against
what Toreroflow can actually supply.

## What already works, verified

**HTML to PDF needs no new dependency.** The template was exported with
headless Chrome, and the Chrome already installed on this machine reproduces
it exactly: 6 pages, 8.50 x 11.00in Letter, ~3.3MB, matching the reference
PDF. So no Puppeteer, no ~300MB Chromium download.

```
chrome --headless=new --disable-gpu --no-pdf-header-footer
       --print-to-pdf=out.pdf file:///path/report.html
```

**The template is genuinely self-contained.** No external fonts, no remote
images, only an inline SVG background. It prints offline, which matters
because a client report should never depend on a CDN being up.

**Its print CSS is already correct**: `@page { size: Letter; margin: 0.42in }`
and `break-inside: avoid` on every card, so nothing splits across a page
boundary.

## Field-by-field: what we can fill today

The template's sample data asks for six headline KPIs and eight metrics per
platform. Here is the honest state of each.

### Headline KPIs

| Field | Status | Source |
| --- | --- | --- |
| Total Views | **Ready** | post analytics + lifetime YouTube |
| Total Engagement | **Ready** | likes + comments + shares |
| Posts Published | **Ready** | post count in period |
| Accounts Reached | **Partial** | provider `reach`, sparsely populated |
| New Followers | **Blocked** | needs two months of snapshots, see below |
| Watch Time | **Partial** | Instagram reels only, see below |

### Per-platform metrics

| Field | Status |
| --- | --- |
| Views, Likes, Comments, Shares, Engagement | **Ready** |
| Subscribers + (the change) | **Blocked**, same snapshot gap |
| Avg View, Watch Time | **Partial**, Instagram reels only |

### Other sections

| Section | Status |
| --- | --- |
| `meta` (client, period, prepared by, account count) | **Ready** |
| `platforms[]` with brand keys, share % | **Ready**, our platform enum maps to yt/ig/tiktok/fb/snap |
| `trends.weekly` 4 week bars | **Ready**, bucketed from publish dates |
| `trends.engagement` Likes/Shares/Saves/Comments | **Ready** |
| `topContent` top videos across platforms | **Ready** |
| `plan` action items | **Ready**, the existing Claude suggestions endpoint fits this exactly |
| `highlight` headline change | Depends on deltas, see below |
| `footer.contactHtml` | **Needs input**: what contact details go on client-facing reports |

## The two real gaps

### 1. Month-over-month deltas

Every KPI in the template carries a change indicator ("up 38%"). Those need
a previous period to compare against.

- **Views, engagement, posts published: fine.** These come from post publish
  dates, and that history runs back to April 2026 for Instagram and 2025 for
  YouTube. June versus May is computable today.
- **Followers and subscribers: not yet.** Those are point-in-time snapshots
  and we only started recording them on 2026-07-25. A follower delta needs
  two months of snapshots, so the first honest month-over-month follower
  figure arrives end of September.

Options: omit the follower delta until the history exists, or show the
current count with no arrow. I would not fabricate a comparison.

### 2. Watch time and average view duration

The template gives these prominent placement, and we can only partly fill
them.

- **Instagram reels** report average watch time, so those are real.
- **YouTube does not.** The Data API exposes view counts but not watch time
  or average view duration; those live in the separate YouTube **Analytics**
  API, which needs OAuth as the channel owner rather than an API key.

Tyrone already has an OAuth client created (`120149926299-...`), so this is
achievable, but it is its own build: consent flow, token storage, refresh
handling. Until then, watch time is an estimate derived from views times
average watch, and should be labelled as such on a client-facing document.

## Proposed build

1. **Template into the repo** at `assets/report-template.html`, so reports
   never depend on a file in Downloads.
2. **Data adapter** in the API: real analytics to the template's JSON shape.
   This is the bulk of the work and the part worth doing carefully.
3. **PDF renderer**: write JSON + template to a temp dir, invoke the local
   Chrome headless, save the PDF into storage per client per month.
4. **Replace the current pdfkit report.** The existing one is a logo, KPI
   boxes and a table; this template is a different class of document.
5. **Reports screen**: a per-client list of generated reports by month, with
   preview, regenerate, and open. Currently there is only an Export button
   on Analytics.
6. **Monthly automation**: a scheduled job that generates each client's
   report shortly after month end so it is waiting rather than requested.

## What is needed from Tyrone

1. **Footer contact details** for client-facing reports (email, phone, site).
2. **Decide on the follower delta**: omit until September, or show counts
   without a change arrow.
3. **Decide on watch time**: label it as estimated for now, or hold that KPI
   back until the YouTube Analytics OAuth work is done.
4. **Confirm month-end behaviour**: generate and save silently for review, or
   generate and notify. Emailing clients directly is a bigger decision and
   should not be automatic without an explicit sign-off.
