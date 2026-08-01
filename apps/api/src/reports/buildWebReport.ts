/**
 * Wraps the report template into a shareable web page carrying several
 * months at once, with a switcher the client uses to move between them.
 *
 * The core template is left untouched. It already exposes
 * `window.renderReport(data)`, so this only injects the period data plus a
 * small switcher that calls it. PDF rendering keeps using the single-period
 * path, which means one design serves both without branching.
 */

export interface WebReportPeriod {
  /** e.g. "June 2026", or "28 Jul - 3 Aug" for a week. */
  label: string;
  /**
   * Sorts the group it belongs to, newest first. "YYYY-MM" for a month and
   * the week's start date for a week, so both sort as plain strings.
   */
  key: string;
  /**
   * Which row of the switcher this belongs on. Months and weeks answer
   * different questions and a flat row of seven buttons mixing "July 2026"
   * with "28 Jul - 3 Aug" reads as one broken list.
   */
  group: "month" | "week";
  data: unknown;
}

const SWITCHER_CSS = `
<style id="tf-switch-css">
  /* The wrapper is what sticks, so the monthly and weekly rows travel
     together instead of stacking on top of each other as you scroll. */
  .tf-switchwrap{
    position:sticky; top:0; z-index:99;
    background:rgba(5,5,6,.86);
    -webkit-backdrop-filter:blur(18px); backdrop-filter:blur(18px);
    border-bottom:1px solid rgba(255,255,255,.08);
  }
  .tf-switch{
    display:flex; align-items:center; gap:10px; flex-wrap:wrap;
    padding:12px 18px;
  }
  .tf-switch + .tf-switch{ padding-top:0; }
  .tf-switch-lbl{ min-width:62px; }
  .tf-switch-lbl{
    font-size:9.5px; font-weight:700; letter-spacing:2px; text-transform:uppercase;
    color:#a2a6ad; margin-right:2px;
  }
  .tf-switch button{
    font:inherit; cursor:pointer;
    font-size:12px; font-weight:600; letter-spacing:.3px;
    padding:7px 15px; border-radius:999px;
    color:#a2a6ad; background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.10);
    transition:.16s;
  }
  .tf-switch button:hover{ color:#fff; background:rgba(255,255,255,.09); }
  .tf-switch button[aria-selected="true"]{
    color:#0b0b0e; background:#fff; border-color:#fff;
  }
  /* The switcher is for the web only; a printed copy is one period. */
  @media print{ .tf-switchwrap{ display:none !important; } }
</style>`;

/** Escapes text destined for an HTML text node. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Retitles the document.
 *
 * The vendored template ships titled "Torerone Performance Report Template",
 * which is what a client would see in their browser tab and in any bookmark
 * they keep. Naming the brand instead makes a saved link identifiable months
 * later, and keeps the word "Template" off something being sent out.
 */
export function withDocumentTitle(html: string, title: string): string {
  const safe = escapeHtml(title);
  // Function replacement, so a "$&" in a brand name is not read as a
  // backreference by String.replace.
  return html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${safe}</title>`);
}

/**
 * Escapes the JSON so a "</script>" inside any string cannot terminate the
 * script block early, which would break the page.
 */
function safeJson(value: unknown): string {
  // Inside a JSON script block the only sequence that can terminate the
  // element early is "</". Escaping the slash keeps the JSON valid while
  // making that impossible. Nothing else needs encoding here.
  return JSON.stringify(value).split("</").join("<" + String.fromCharCode(92) + "/");
}

export function buildWebReport(
  templateHtml: string,
  periods: WebReportPeriod[],
): string {
  if (!periods.length) throw new Error("a web report needs at least one period");

  const payload = safeJson({
    periods: periods.map((p) => ({
      label: p.label,
      key: p.key,
      group: p.group ?? "month",
      data: p.data,
    })),
  });

  const script = `
<script id="tf-periods" type="application/json">${payload}</script>
<script>
(function () {
  var raw = document.getElementById('tf-periods');
  var cfg;
  try { cfg = JSON.parse(raw.textContent); } catch (e) { return; }
  var periods = (cfg && cfg.periods) || [];
  if (!periods.length) return;

  // Months first and newest first inside each group, so the report opens on
  // the most recent month and the weekly row reads left to right as recent to
  // older, the same direction as the monthly one.
  periods.sort(function (a, b) {
    if (a.group !== b.group) return a.group === 'month' ? -1 : 1;
    return a.key < b.key ? 1 : -1;
  });

  function paint(i) {
    if (typeof window.renderReport !== 'function') return;
    window.renderReport(periods[i].data);
    // renderReport rewrites the body, so the bar is re-attached after it.
    mount(i);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function row(title, items, active) {
    if (!items.length) return null;
    var bar = document.createElement('div');
    bar.className = 'tf-switch';
    bar.setAttribute('role', 'tablist');

    var lbl = document.createElement('span');
    lbl.className = 'tf-switch-lbl';
    lbl.textContent = title;
    bar.appendChild(lbl);

    items.forEach(function (entry) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = entry.p.label;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', entry.i === active ? 'true' : 'false');
      b.addEventListener('click', function () { if (entry.i !== active) paint(entry.i); });
      bar.appendChild(b);
    });
    return bar;
  }

  function mount(active) {
    var old = document.querySelectorAll('.tf-switch');
    for (var k = 0; k < old.length; k++) old[k].remove();
    if (periods.length < 2) return;

    var months = [];
    var weeks = [];
    periods.forEach(function (p, i) {
      (p.group === 'week' ? weeks : months).push({ p: p, i: i });
    });

    var wrap = document.createElement('div');
    wrap.className = 'tf-switchwrap';
    var m = row('Monthly', months, active);
    var w = row('Weekly', weeks, active);
    if (m) wrap.appendChild(m);
    if (w) wrap.appendChild(w);
    document.body.insertBefore(wrap, document.body.firstChild);
  }

  function start() {
    window.REPORT_DATA = periods[0].data;
    if (typeof window.renderReport === 'function') {
      window.renderReport(periods[0].data);
      mount(0);
    } else {
      // Template script has not run yet; wait for it.
      setTimeout(start, 40);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
</script>`;

  // Keep client numbers out of search results. The path is deliberately short
  // and guessable, so this meta tag is the only thing standing between one
  // client's numbers and a search for a brand name.
  const noIndex = `<meta name="robots" content="noindex, nofollow, noarchive">`;

  // Switcher styles go in the head; the script goes last so the template's
  // own renderer is already defined when it runs.
  let html = templateHtml;
  html = html.includes("</head>")
    ? html.replace("</head>", `${noIndex}${SWITCHER_CSS}</head>`)
    : `${noIndex}${SWITCHER_CSS}${html}`;
  html = html.includes("</body>")
    ? html.replace("</body>", `${script}</body>`)
    : `${html}${script}`;
  return html;
}
