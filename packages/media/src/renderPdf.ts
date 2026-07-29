import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Renders the report template to PDF using a Chromium browser already on the
 * machine.
 *
 * Deliberately avoids Puppeteer: it would pull roughly 300MB of Chromium for
 * a job the installed Chrome or Edge already does, and the reference PDF was
 * produced this way. Verified locally to match that reference exactly at six
 * Letter pages.
 */

const WINDOWS_CANDIDATES = [
  "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
  "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
  "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
  "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
  "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe",
];

const UNIX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const expand = (p: string): string =>
  p.replace(/%([^%]+)%/g, (_m, name: string) => process.env[name] ?? "");

/** First browser that exists, or null when none is installed. */
export async function findBrowser(): Promise<string | null> {
  if (process.env.CHROME_PATH) {
    try {
      await fs.access(process.env.CHROME_PATH);
      return process.env.CHROME_PATH;
    } catch {
      // configured path is wrong; fall through to discovery
    }
  }
  const candidates = process.platform === "win32" ? WINDOWS_CANDIDATES : UNIX_CANDIDATES;
  for (const raw of candidates) {
    const full = expand(raw);
    if (!full) continue;
    try {
      await fs.access(full);
      return full;
    } catch {
      // keep looking
    }
  }
  return null;
}

export class ReportRenderError extends Error {}

/**
 * Writes the template with data baked in, prints it, and returns the bytes.
 *
 * Data goes in as a `window.REPORT_DATA` assignment ahead of the template's
 * own loader, which is the documented precedence, so no fetch happens and
 * the render stays fully offline.
 */
export async function renderReportPdf(
  templateHtml: string,
  data: unknown,
): Promise<Buffer> {
  const browser = await findBrowser();
  if (!browser) {
    throw new ReportRenderError(
      "no Chrome or Edge found for PDF rendering; set CHROME_PATH to a Chromium browser",
    );
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "toreroflow-report-"));
  const htmlPath = path.join(dir, "report.html");
  const pdfPath = path.join(dir, "report.pdf");

  try {
    const injected = `<script>window.REPORT_DATA = ${JSON.stringify(data)};</script>`;
    // Ahead of </head> so it runs before the template's own loader.
    const html = templateHtml.includes("</head>")
      ? templateHtml.replace("</head>", `${injected}</head>`)
      : `${injected}${templateHtml}`;
    await fs.writeFile(htmlPath, html, "utf8");

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        browser,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          // Chromium refuses to run headless as root without this.
          "--no-sandbox",
          "--no-pdf-header-footer",
          `--print-to-pdf=${pdfPath}`,
          `file://${htmlPath.replace(/\\/g, "/")}`,
        ],
        { windowsHide: true },
      );
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      // Never let a hung browser hold the request open.
      const timer = setTimeout(() => {
        child.kill();
        reject(new ReportRenderError("PDF render timed out after 90s"));
      }, 90_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new ReportRenderError(`browser exited ${code}: ${stderr.slice(-400)}`));
      });
    });

    const bytes = await fs.readFile(pdfPath);
    if (bytes.length < 1000) {
      throw new ReportRenderError("rendered PDF was empty");
    }
    return bytes;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
