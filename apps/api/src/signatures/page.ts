/**
 * The page a signer actually sees, served by the API itself.
 *
 * Not part of the React app on purpose: the signer has no login, and this page
 * needs none of the app. Served by the API, and reached on the app's own
 * address (APP_DOMAIN), where Caddy passes /s/* and /files/* to the API, or on
 * the API's when a server has no app domain.
 *
 * Every value here comes out of the database, and some of it was typed by
 * whoever uploaded the file or named the signer. So nothing is interpolated
 * into markup or script: the text goes through `esc`, and the data the script
 * needs is handed over as JSON in a script tag it parses. A signer called
 * `<img onerror=...>` is just a name.
 */

export interface SigningPageData {
  token: string;
  title: string;
  message: string;
  senderName: string;
  status: string;
  documentUrl: string;
  expiresAt: string;
  signer: { name: string; email: string; status: string; consentAt: string | null };
  fields: { id: string; type: string; page: number; required: boolean; value: string | null }[];
  yourTurn: boolean;
}

/** HTML-escapes text. Covers attribute contexts too, hence the quotes. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JSON safe to put inside a <script> element.
 *
 * `</script>` anywhere in the data would end the element early and drop the
 * rest into the document as markup, so the slash is escaped. U+2028 and
 * U+2029 are line terminators in JavaScript but not in JSON.
 */
export function jsonForScript(value: unknown): string {
  // fromCharCode rather than a literal: a raw U+2028 written into this source
  // file is itself a line terminator, and ends the expression it sits in.
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .split("<")
    .join("\\u003c")
    .split(">")
    .join("\\u003e")
    .split(LS)
    .join("\\u2028")
    .split(PS)
    .join("\\u2029");
}

const LABELS: Record<string, string> = {
  signature: "Signature",
  initials: "Initials",
  date: "Date",
  text: "Text",
  checkbox: "Agree",
};

/** A short, honest note about what the document is doing right now. */
function headline(d: SigningPageData): string {
  if (d.status === "completed") return "Signed by everyone. Your copy is below.";
  if (d.status === "declined") return "This document was declined and is closed.";
  if (d.status === "voided") return "The sender cancelled this document.";
  if (d.signer.status === "signed") return "You have signed. Waiting on the others.";
  if (d.signer.status === "declined") return "You declined this document.";
  if (!d.yourTurn) return "Someone else has to sign before you. You will be emailed when it is your turn.";
  return "Read the document, then sign at the bottom.";
}

export function signingPage(d: SigningPageData): string {
  const done =
    d.status !== "sent" || d.signer.status === "signed" || d.signer.status === "declined" || !d.yourTurn;
  const mine = d.fields.map((f) => ({ id: f.id, type: f.type, page: f.page, required: f.required }));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(d.title)}</title>
<style>
  :root { color-scheme: light dark; --ink:#13131a; --bg:#f4f4f7; --card:#fff; --line:#e3e3ea; --muted:#5c5c68; --accent:#7b2d8e; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#f2f2f6; --bg:#101014; --card:#1a1a21; --line:#2c2c36; --muted:#9a9aa8; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:0 16px 56px; background:var(--bg); color:var(--ink);
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; }
  header { padding: 28px 0 16px; }
  h1 { margin:0 0 6px; font-size:22px; line-height:1.25; }
  .sub { margin:0; color:var(--muted); font-size:13px; }
  .card { margin:16px 0; padding:18px; background:var(--card); border:1px solid var(--line); border-radius:14px; }
  /* Shorter than it wants to be: the PDF viewer swallows the wheel, so a tall
     frame on a narrow window traps a signer inside the document with the form
     below it out of reach. The skip link above covers the rest. */
  .doc { height: min(58vh, 680px); width:100%; border:1px solid var(--line); border-radius:12px; background:#fff; }
  .skip { display:inline-block; margin-top:10px; font-size:13px; font-weight:600; color:var(--accent); }
  @media (prefers-color-scheme: dark) { .skip { color:#c98fdb; } }
  label { display:block; font-weight:600; font-size:13px; margin-bottom:6px; }
  input[type=text], input[type=date] { width:100%; padding:10px 12px; font:inherit; color:inherit;
    background:var(--bg); border:1px solid var(--line); border-radius:10px; }
  .row { margin-bottom:16px; }
  .pad { width:100%; height:150px; background:#fff; border:1px dashed #9a9aa8; border-radius:10px; touch-action:none; cursor:crosshair; }
  .padbar { display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap; }
  button { padding:11px 18px; font:inherit; font-weight:600; border:0; border-radius:10px; cursor:pointer; }
  .pri { background:var(--accent); color:#fff; }
  .pri[disabled] { opacity:.45; cursor:not-allowed; }
  .ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
  .consent { display:flex; gap:10px; align-items:flex-start; font-size:13px; line-height:1.5; }
  .consent input { margin-top:3px; flex:none; width:18px; height:18px; }
  .note { font-size:12px; color:var(--muted); }
  .err { margin:12px 0 0; padding:10px 12px; border-radius:10px; background:#fee2e2; color:#7f1d1d; font-size:13px; }
  .ok { margin:12px 0 0; padding:10px 12px; border-radius:10px; background:#dcfce7; color:#14532d; font-size:13px; }
  @media (prefers-color-scheme: dark) {
    .err { background:#3f1414; color:#fecaca; } .ok { background:#10291a; color:#bbf7d0; }
    .pad { background:#fff; }
  }
  .hide { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(d.title)}</h1>
    <p class="sub">From ${esc(d.senderName)} &middot; for ${esc(d.signer.name || d.signer.email)} &middot; ${esc(headline(d))}</p>
    ${done ? "" : `<a class="skip" href="#f">Skip to signing &darr;</a>`}
  </header>

  ${d.message ? `<div class="card"><div class="note">Message from the sender</div><p style="margin:6px 0 0">${esc(d.message)}</p></div>` : ""}

  <iframe class="doc" src="${esc(d.documentUrl)}" title="${esc(d.title)}"></iframe>

  <form id="f" class="card${done ? " hide" : ""}">
    <div class="row">
      <label class="consent">
        <input type="checkbox" id="consent" ${d.signer.consentAt ? "checked disabled" : ""}>
        <span>I agree to sign this document electronically, and that my electronic signature is as
        binding as a signature on paper. I can ask ${esc(d.senderName)} for a paper copy instead.</span>
      </label>
    </div>
    <div id="fields"></div>
    <div class="row">
      <button type="submit" class="pri" id="go" disabled>Sign and send back</button>
      <button type="button" class="ghost" id="no">Decline</button>
    </div>
    <p class="note">
      Your name, email, the time, your IP address and your browser are recorded with the signature and
      printed on the certificate attached to the signed document. Link valid until ${esc(d.expiresAt.slice(0, 10))}.
    </p>
  </form>

  <div id="msg"></div>
</div>

<script type="application/json" id="data">${jsonForScript({ token: d.token, fields: mine, labels: LABELS, done })}</script>
<script>
(function () {
  var D = JSON.parse(document.getElementById("data").textContent);
  var msg = document.getElementById("msg");
  function say(kind, text) { msg.innerHTML = ""; var p = document.createElement("div"); p.className = kind; p.textContent = text; msg.appendChild(p); }
  if (D.done) return;

  var host = document.getElementById("fields");
  var pads = {};

  D.fields.forEach(function (f) {
    var row = document.createElement("div");
    row.className = "row";
    var label = document.createElement("label");
    label.textContent = (D.labels[f.type] || f.type) + " \\u2014 page " + (f.page + 1) + (f.required ? "" : " (optional)");
    label.htmlFor = "i-" + f.id;
    row.appendChild(label);
    /* Attached before anything inside it is measured. A canvas that is not in
       the document has a zero-sized box, so sizing the pad from it gives a
       0x0 backing store: the pad looks right and draws nothing at all. */
    host.appendChild(row);

    if (f.type === "signature" || f.type === "initials") {
      var c = document.createElement("canvas");
      c.className = "pad"; c.id = "i-" + f.id;
      row.appendChild(c);
      var bar = document.createElement("div");
      bar.className = "padbar";
      var clear = document.createElement("button");
      clear.type = "button"; clear.className = "ghost"; clear.textContent = "Clear";
      bar.appendChild(clear);
      var hint = document.createElement("span");
      hint.className = "note"; hint.textContent = "Draw with a finger, a stylus or the mouse.";
      bar.appendChild(hint);
      row.appendChild(bar);
      pads[f.id] = startPad(c, clear);
    } else if (f.type === "checkbox") {
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.id = "i-" + f.id;
      cb.addEventListener("change", refresh);
      row.appendChild(cb);
    } else if (f.type === "date") {
      var dt = document.createElement("input");
      dt.type = "date"; dt.id = "i-" + f.id;
      /* The signer's own date, not UTC's. toISOString would date a contract
         signed on the evening of the 18th in New York as the 19th. */
      var now = new Date();
      dt.value = now.getFullYear() + "-" +
        String(now.getMonth() + 1).padStart(2, "0") + "-" +
        String(now.getDate()).padStart(2, "0");
      dt.addEventListener("input", refresh);
      row.appendChild(dt);
    } else {
      var tx = document.createElement("input");
      tx.type = "text"; tx.id = "i-" + f.id; tx.maxLength = 500;
      tx.addEventListener("input", refresh);
      row.appendChild(tx);
    }
  });

  /* A signature pad. Scaled for the device so the drawn line is not a blur. */
  function startPad(canvas, clearBtn) {
    var ratio = Math.min(window.devicePixelRatio || 1, 3);
    var rect = canvas.getBoundingClientRect();
    /* A floor, in case this is ever measured while hidden. A zero-width
       backing store accepts every stroke and saves a blank image, which is
       the worst possible failure here: it looks signed and is not. */
    var w = rect.width || 320;
    var h = rect.height || 150;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    var ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#13131a";
    /* dirty flips only once ink has actually been laid down, NOT on
       pointerdown. beginPath/moveTo paint nothing, so a signer who merely taps
       the pad would otherwise arm the Sign button and submit a fully
       transparent PNG: a contract that comes back marked signed with an empty
       signature box. The server checks for ink too; this is the half that
       stops an honest signer doing it by accident. */
    var drawing = false, dirty = false;
    function at(e) { var r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    canvas.addEventListener("pointerdown", function (e) {
      drawing = true; canvas.setPointerCapture(e.pointerId);
      var p = at(e); ctx.beginPath(); ctx.moveTo(p[0], p[1]);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drawing) return;
      var p = at(e); ctx.lineTo(p[0], p[1]); ctx.stroke();
      if (!dirty) { dirty = true; refresh(); }
    });
    canvas.addEventListener("pointerup", function () { drawing = false; });
    canvas.addEventListener("pointercancel", function () { drawing = false; });
    clearBtn.addEventListener("click", function () {
      ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; refresh();
    });
    return { drawn: function () { return dirty; }, data: function () { return dirty ? canvas.toDataURL("image/png") : null; } };
  }

  function valueOf(f) {
    if (f.type === "signature" || f.type === "initials") return pads[f.id].data();
    var el = document.getElementById("i-" + f.id);
    if (f.type === "checkbox") return el.checked ? "true" : null;
    return el.value ? el.value : null;
  }

  var consent = document.getElementById("consent");
  var go = document.getElementById("go");
  function refresh() {
    var ready = consent.checked || consent.disabled;
    D.fields.forEach(function (f) { if (f.required && !valueOf(f)) ready = false; });
    go.disabled = !ready;
  }
  consent.addEventListener("change", refresh);
  refresh();

  async function post(path, body) {
    var res = await fetch("/s/" + encodeURIComponent(D.token) + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "That did not go through. Try again.");
    return data;
  }

  document.getElementById("f").addEventListener("submit", async function (e) {
    e.preventDefault();
    go.disabled = true;
    try {
      if (!consent.disabled) await post("/consent", { agreed: true });
      var values = {};
      D.fields.forEach(function (f) { var v = valueOf(f); if (v !== null) values[f.id] = v; });
      var out = await post("/sign", { values: values, intent: true });
      document.getElementById("f").classList.add("hide");
      say("ok", out.status === "completed"
        ? "Signed. Everyone has now signed, and the completed copy is on its way to you by email."
        : "Signed. We will email you the completed copy once everyone else has signed.");
    } catch (err) {
      say("err", err.message);
      refresh();
    }
  });

  document.getElementById("no").addEventListener("click", async function () {
    var reason = window.prompt("Decline this document? Tell them why, if you like:");
    if (reason === null) return;
    try {
      await post("/decline", { reason: reason.slice(0, 500) });
      document.getElementById("f").classList.add("hide");
      say("ok", "Declined. The sender has been told.");
    } catch (err) { say("err", err.message); }
  });
})();
</script>
</body>
</html>`;
}
