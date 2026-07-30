import { formatCents } from "@toreroflow/core";

export interface InvoiceLine {
  title: string;
  publishedAt: string | null;
}

export interface InvoiceData {
  number: string;
  issuedAt: string;
  periodLabel: string;
  business: { legalName: string; ein: string | null; address: string | null };
  client: { name: string; contactName: string | null; contactEmail: string | null };
  amountCents: number;
  lines: InvoiceLine[];
}

/** Escapes text destined for an HTML text node. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The invoice document.
 *
 * A document, not a charge: nothing here can take money. It exists so the
 * client has a record of what they paid for, itemised by what actually
 * shipped in the cycle.
 */
export function buildInvoiceHtml(data: InvoiceData): string {
  const lines = data.lines.length
    ? data.lines
        .map(
          (l) =>
            `<tr><td>${esc(l.title)}</td><td class="r">${
              l.publishedAt ? new Date(l.publishedAt).toLocaleDateString("en-US") : ""
            }</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="2" class="muted">No videos recorded for this period.</td></tr>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Invoice ${esc(data.number)}</title>
<style>
  body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#111;margin:0;padding:48px 56px}
  h1{font-size:26px;margin:0 0 4px}
  .muted{color:#777}
  .head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:34px}
  .box{font-size:13px;line-height:1.6}
  table{width:100%;border-collapse:collapse;margin-top:22px;font-size:13px}
  th,td{text-align:left;padding:9px 0;border-bottom:1px solid #e6e6e6}
  th{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#888}
  td.r,th.r{text-align:right}
  .total{margin-top:26px;font-size:20px;font-weight:700;text-align:right}
  .foot{margin-top:40px;font-size:11px;color:#888;line-height:1.6}
</style>
</head>
<body>
<div class="head">
  <div>
    <h1>Invoice ${esc(data.number)}</h1>
    <div class="muted">${esc(data.periodLabel)}</div>
  </div>
  <div class="box" style="text-align:right">
    <b>${esc(data.business.legalName)}</b><br>
    ${data.business.address ? `${esc(data.business.address).replace(/\n/g, "<br>")}<br>` : ""}
    ${data.business.ein ? `EIN ${esc(data.business.ein)}<br>` : ""}
    Issued ${esc(new Date(data.issuedAt).toLocaleDateString("en-US"))}
  </div>
</div>
<div class="box">
  <b>Billed to</b><br>
  ${esc(data.client.name)}<br>
  ${data.client.contactName ? `${esc(data.client.contactName)}<br>` : ""}
  ${data.client.contactEmail ? `${esc(data.client.contactEmail)}` : ""}
</div>
<table>
  <tr><th>Delivered</th><th class="r">Published</th></tr>
  ${lines}
</table>
<div class="total">${esc(formatCents(data.amountCents))}</div>
<div class="foot">Issued by ${esc(data.business.legalName)}. This document is a record of work delivered and payment agreed, not a payment request.</div>
</body>
</html>`;
}
