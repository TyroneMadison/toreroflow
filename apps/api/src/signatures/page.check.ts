// The signing page is the one place in this app that builds HTML by hand, and
// everything in it came out of a database. So: nothing a sender types can
// become markup or script, and the page still works for the person signing.
import assert from "node:assert/strict";
import { esc, jsonForScript, signingPage, type SigningPageData } from "./page";

/* ---- escaping ---- */
assert.equal(esc(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
assert.equal(esc("a & b"), "a &amp; b");
assert.equal(esc("it's"), "it&#39;s");
assert.equal(esc(null), "");
assert.equal(esc(undefined), "");
// The ampersand must be escaped first, or "&lt;" becomes "&amp;lt;" and back.
assert.equal(esc("<"), "&lt;");
assert.equal(esc("&lt;script&gt;"), "&amp;lt;script&amp;gt;");

/* ---- the JSON handed to the script ---- */
// A closing tag inside the data would end the script element early and spill
// the rest into the document as live markup.
const nasty = jsonForScript({ t: "</script><script>alert(1)</script>" });
assert.equal(nasty.includes("</script>"), false, "no closing tag survives");
assert.equal(nasty.includes("<"), false);
assert.equal(nasty.includes(">"), false);
assert.deepEqual(JSON.parse(nasty), { t: "</script><script>alert(1)</script>" }, "and it still parses back");

// U+2028 and U+2029 are line terminators to a JavaScript parser but legal
// inside a JSON string, which is the classic way a valid JSON blob becomes a
// syntax error (or worse) once it is inlined.
const sep = jsonForScript({ t: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c` });
assert.equal(sep.includes(String.fromCharCode(0x2028)), false);
assert.equal(sep.includes(String.fromCharCode(0x2029)), false);
assert.equal(JSON.parse(sep).t.length, 5, "escaped, not deleted");

/* ---- the page ---- */
const data: SigningPageData = {
  token: "sgn1.abc",
  title: `Service <Agreement> & "Terms"`,
  message: "<b>Please read clause 4</b>",
  senderName: "Torerone",
  status: "sent",
  documentUrl: "/files/signatures/req1/source.pdf?e=1&s=sig",
  expiresAt: "2026-12-18T00:00:00.000Z",
  signer: { name: `Dana <script>alert(1)</script>`, email: "dana@example.com", status: "viewed", consentAt: null },
  fields: [
    { id: "f1", type: "signature", page: 0, required: true, value: null },
    { id: "f2", type: "date", page: 1, required: false, value: null },
  ],
  yourTurn: true,
};

const html = signingPage(data);

// Nothing the sender typed reaches the document as markup.
assert.equal(html.includes("<script>alert(1)</script>"), false, "a signer's name is text, not script");
assert.equal(html.includes("<b>Please read clause 4</b>"), false, "the message is text too");
assert.ok(html.includes("&lt;b&gt;Please read clause 4&lt;/b&gt;"));
assert.ok(html.includes("Service &lt;Agreement&gt; &amp; &quot;Terms&quot;"));
// Exactly the two script elements the page owns: the data and the behaviour.
assert.equal(html.split("<script").length - 1, 2, "no third script element got in");

// The document is shown, and the signed file link is passed through intact:
// its own signature is in that query string, so mangling it 404s the PDF.
assert.ok(html.includes(`src="/files/signatures/req1/source.pdf?e=1&amp;s=sig"`), "the file link survives escaping");

// The form is present and the fields are described to the script by id alone.
assert.ok(html.includes('<form id="f"'));
assert.ok(!html.includes('class="card hide"'), "a signer whose turn it is gets the form");
const blob = JSON.parse(html.split('id="data">')[1]!.split("</script>")[0]!);
assert.deepEqual(blob.fields.map((f: { id: string }) => f.id), ["f1", "f2"]);
assert.equal(blob.done, false);
assert.equal(blob.token, "sgn1.abc");

// The date field must pre-fill the SIGNER's date, not UTC's. toISOString would
// date a contract signed at 8pm in New York as the following day.
assert.equal(/toISOString\(\)\.slice\(0, 10\)/.test(html), false, "no UTC date in the date field");
assert.ok(html.includes("now.getFullYear()"), "built from the local date instead");

// The signature pad is sized from its box, so the row has to be in the
// document before the pad is built. Measured detached it gets a 0x0 backing
// store: every stroke is accepted and the saved image is blank. It looks
// signed and is not, which is the worst way this page could fail.
const script = html.split("<script>")[1]!;
assert.ok(
  script.indexOf("host.appendChild(row)") < script.indexOf("startPad(c, clear)"),
  "the row is attached before the pad is measured",
);
assert.ok(/rect\.width \|\| \d+/.test(script), "and the pad has a size floor even so");

// The PDF viewer swallows the wheel, so a signer who scrolls inside the frame
// never reaches the form. The way past it has to be on the page.
assert.ok(html.includes('href="#f"'), "a way to reach the form without scrolling the PDF");
assert.ok(/\.doc \{ height: min\(5\d vh|\.doc \{ height: min\(58vh/.test(html), "the frame leaves room below it");

// ESIGN: the consent wording is on the page, and the page says plainly what is
// recorded. Without those a signature is not defensible.
assert.ok(/agree to sign this document electronically/i.test(html));
assert.ok(/as\s+binding as a signature on paper/i.test(html));
assert.ok(/paper copy/i.test(html));
assert.ok(/IP address/i.test(html));
assert.ok(html.includes("noindex"), "a contract must not be indexed");

/* ---- the states where there is nothing to do ---- */
for (const [over, why] of [
  [{ status: "completed" }, /Signed by everyone/],
  [{ status: "voided" }, /cancelled this document/],
  [{ status: "declined" }, /declined and is closed/],
  [{ signer: { ...data.signer, status: "signed" } }, /You have signed/],
  [{ yourTurn: false }, /Someone else has to sign before you/],
] as const) {
  const page = signingPage({ ...data, ...(over as object) });
  assert.match(page, why, JSON.stringify(over));
  assert.ok(page.includes('class="card hide"'), `the form is hidden: ${JSON.stringify(over)}`);
  assert.equal(page.includes('href="#f"'), false, "and no skip link to a form that is not there");
  assert.equal(JSON.parse(page.split('id="data">')[1]!.split("</script>")[0]!).done, true);
}

// Consent already given: the box is checked and locked, not asked for twice.
const second = signingPage({ ...data, signer: { ...data.signer, consentAt: "2026-11-18T10:00:00.000Z" } });
assert.ok(second.includes('id="consent" checked disabled'));

// No message means no empty message card.
assert.equal(signingPage({ ...data, message: "" }).includes("Message from the sender"), false);

console.log("signatures/page ok");
