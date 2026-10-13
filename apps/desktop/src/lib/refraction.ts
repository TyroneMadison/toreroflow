/*
 * Per-panel edge bending.
 *
 * Each large glass panel gets its own SVG filter whose displacement map is
 * drawn from the panel's rounded rectangle: near the rim the backdrop is
 * pulled inward along the edge normal, so the wallpaper visibly bends around
 * the curve, with a soft ripple across the middle. Maps are only rebuilt when
 * a panel's size changes (ResizeObserver) and are shared between panels of
 * the same size, so scrolling costs nothing extra. Strength follows the
 * Settings slider. Chromium only (WebView2, Chrome); elsewhere, in
 * automation mode, or with reduced transparency, panels keep plain blur.
 */
const SEL = ".glass-z1,.dock,.card.glass";
const MIN_W = 110;
const MIN_H = 40;
const MAX_PANELS = 40;

type Entry = { id: string; key: string };
const panels = new Map<Element, Entry>();
const maps = new Map<string, string>();
let layer: SVGSVGElement | null = null;
let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let scale = 0;
let seq = 0;

/** Pure: the inward edge normal and lens strength at (x,y) of a w*h rect with radius r. */
export function lensAt(x: number, y: number, w: number, h: number, r: number, band = 70): [number, number] {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const ix = x - cx;
  const iy = y - cy;
  const inCorner = ix !== 0 || iy !== 0;
  let d: number, nx: number, ny: number;
  if (inCorner) {
    const len = Math.hypot(ix, iy) || 1;
    d = Math.max(0, r - len);
    nx = -ix / len;
    ny = -iy / len;
  } else {
    const dx = Math.min(x, w - x);
    const dy = Math.min(y, h - y);
    d = Math.min(dx, dy);
    nx = dx < dy ? (x < w / 2 ? 1 : -1) : 0;
    ny = dx < dy ? 0 : y < h / 2 ? 1 : -1;
  }
  const b = Math.min(band, Math.min(w, h) / 3);
  const k = Math.pow(Math.max(0, 1 - d / b), 1.6);
  return [nx * k + 0, ny * k + 0];
}

function buildMap(w: number, h: number, r: number): string {
  const key = `${w}x${h}r${r}`;
  const hit = maps.get(key);
  if (hit) return hit;
  // Drawn at quarter resolution and scaled up by feImage: the map is smooth.
  const s = 4;
  const cw = Math.max(2, Math.ceil(w / s));
  const ch = Math.max(2, Math.ceil(h / s));
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(cw, ch);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const x = i * s;
      const y = j * s;
      const [lx, ly] = lensAt(x, y, w, h, r);
      // a gentle poured-glass ripple, weaker than the rim
      const rx = 0.18 * Math.sin(y / 46 + Math.sin(x / 90) * 2);
      const ry = 0.16 * Math.sin(x / 58 + Math.cos(y / 80) * 2);
      const o = (j * cw + i) * 4;
      img.data[o] = Math.round(128 + 127 * Math.max(-1, Math.min(1, lx * 0.85 + rx)));
      img.data[o + 1] = Math.round(128 + 127 * Math.max(-1, Math.min(1, ly * 0.85 + ry)));
      img.data[o + 2] = 128;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL();
  if (maps.size > 60) maps.clear();
  maps.set(key, url);
  return url;
}

function ensureLayer(): SVGSVGElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  layer.setAttribute("width", "0");
  layer.setAttribute("height", "0");
  layer.setAttribute("aria-hidden", "true");
  layer.style.position = "absolute";
  document.body.appendChild(layer);
  return layer;
}

function writeFilter(el: HTMLElement, e: Entry, w: number, h: number, r: number) {
  const NS = "http://www.w3.org/2000/svg";
  let f = document.getElementById(e.id) as SVGFilterElement | null;
  if (!f) {
    f = document.createElementNS(NS, "filter") as SVGFilterElement;
    f.id = e.id;
    f.setAttribute("color-interpolation-filters", "sRGB");
    f.innerHTML =
      '<feImage result="map" preserveAspectRatio="none"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G" result="dr"/>' +
      '<feColorMatrix in="dr" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="r"/>' +
      '<feColorMatrix in="d" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0" result="gb"/>' +
      '<feBlend in="r" in2="gb" mode="screen"/>';
    ensureLayer().appendChild(f);
  }
  f.setAttribute("x", "0");
  f.setAttribute("y", "0");
  f.setAttribute("width", String(w));
  f.setAttribute("height", String(h));
  f.setAttribute("filterUnits", "userSpaceOnUse");
  f.setAttribute("primitiveUnits", "userSpaceOnUse");
  const im = f.querySelector("feImage")!;
  im.setAttribute("href", buildMap(w, h, r));
  im.setAttribute("x", "0");
  im.setAttribute("y", "0");
  im.setAttribute("width", String(w));
  im.setAttribute("height", String(h));
  const [d, dr] = f.querySelectorAll("feDisplacementMap");
  d!.setAttribute("scale", String(scale));
  dr!.setAttribute("scale", String(Math.round(scale * 1.08))); // red bends a touch more: chromatic rim
  el.style.setProperty("--lens", `url(#${e.id})`);
  el.setAttribute("data-lens", "");
}

function measure(el: Element) {
  const h = el as HTMLElement;
  const w = Math.round(h.offsetWidth);
  const ht = Math.round(h.offsetHeight);
  if (w < MIN_W || ht < MIN_H || !enabled()) {
    detach(el);
    return;
  }
  const r = Math.round(parseFloat(getComputedStyle(h).borderTopLeftRadius) || 20);
  let e = panels.get(el);
  if (!e) {
    if (panels.size >= MAX_PANELS) return;
    e = { id: `tf-lens-${++seq}`, key: "" };
    panels.set(el, e);
  }
  const key = `${w}x${ht}r${r}s${scale}`;
  if (e.key === key) return;
  e.key = key;
  writeFilter(h, e, w, ht, r);
}

function detach(el: Element) {
  const e = panels.get(el);
  if (!e) return;
  document.getElementById(e.id)?.remove();
  (el as HTMLElement).style.removeProperty("--lens");
  el.removeAttribute("data-lens");
  panels.delete(el);
}

function enabled(): boolean {
  const html = document.documentElement;
  if (html.getAttribute("data-glass") === "low") return false;
  if (window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches) return false;
  const ua = navigator.userAgent;
  if (!/Chrome\/|Edg\//.test(ua)) return false;
  return scale > 2;
}

function scan() {
  if (!ro) return;
  document.querySelectorAll(SEL).forEach((el) => {
    if (!panels.has(el)) ro!.observe(el);
  });
  for (const el of [...panels.keys()]) if (!el.isConnected) { ro.unobserve(el); detach(el); }
}

let scanQueued = false;
function queueScan() {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    scan();
  });
}

/** Called by lib/glass.ts whenever the slider moves. */
export function setRefraction(px: number): void {
  scale = px;
  if (!ro) return;
  if (!enabled()) {
    for (const el of [...panels.keys()]) detach(el);
  }
  document.querySelectorAll(SEL).forEach((el) => measure(el));
}

export function startRefraction(): () => void {
  if (ro || typeof ResizeObserver === "undefined") return () => {};
  ro = new ResizeObserver((entries) => entries.forEach((en) => measure(en.target)));
  mo = new MutationObserver(queueScan);
  mo.observe(document.body, { childList: true, subtree: true });
  scan();
  return () => {
    ro?.disconnect();
    mo?.disconnect();
    ro = mo = null;
    for (const el of [...panels.keys()]) detach(el);
  };
}
