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
  /** e.g. "June 2026" */
  label: string;
  /** "YYYY-MM", used as the switcher's value. */
  key: string;
  data: unknown;
}

const SWITCHER_CSS = `
<style id="tf-switch-css">
  .tf-switch{
    position:sticky; top:0; z-index:99;
    display:flex; align-items:center; gap:10px; flex-wrap:wrap;
    padding:14px 18px; margin:0 0 4px;
    background:rgba(5,5,6,.86);
    -webkit-backdrop-filter:blur(18px); backdrop-filter:blur(18px);
    border-bottom:1px solid rgba(255,255,255,.08);
  }
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
  /* The switcher is for the web only; a printed copy is one month. */
  @media print{ .tf-switch{ display:none !important; } }
</style>`;

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
    periods: periods.map((p) => ({ label: p.label, key: p.key, data: p.data })),
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

  // Newest first, so the report opens on the most recent month.
  periods.sort(function (a, b) { return a.key < b.key ? 1 : -1; });

  function paint(i) {
    if (typeof window.renderReport !== 'function') return;
    window.renderReport(periods[i].data);
    // renderReport rewrites the body, so the bar is re-attached after it.
    mount(i);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function mount(active) {
    var old = document.querySelector('.tf-switch');
    if (old) old.remove();
    if (periods.length < 2) return;

    var bar = document.createElement('div');
    bar.className = 'tf-switch';
    bar.setAttribute('role', 'tablist');

    var lbl = document.createElement('span');
    lbl.className = 'tf-switch-lbl';
    lbl.textContent = 'Reporting period';
    bar.appendChild(lbl);

    periods.forEach(function (p, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.label;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', i === active ? 'true' : 'false');
      b.addEventListener('click', function () { if (i !== active) paint(i); });
      bar.appendChild(b);
    });

    document.body.insertBefore(bar, document.body.firstChild);
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

  // Keep client numbers out of search results. The link's privacy rests on
  // being unguessable, which is undone the moment a crawler indexes it.
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
