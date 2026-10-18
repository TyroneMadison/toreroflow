import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createCanvas, GlobalFonts, type SKRSContext2D, type Canvas } from "@napi-rs/canvas";
import * as gifencNs from "gifenc";

/**
 * Code-drawn looping GIFs for an idea (approved gifs-v3 mockups): one per shot
 * showing that shot as filmed (framing, angle, pose, props, camera move, with
 * rule-of-thirds lines and a move tag) plus the hook with captions under a
 * "Say this · Hook:" label. People are drawn Black: deep brown skin, natural
 * hair. Pure drawing, no image model. Output is cached by content hash.
 */

const gifencMod = ((gifencNs as { GIFEncoder?: unknown }).GIFEncoder ? gifencNs : (gifencNs as { default: unknown }).default) as unknown;
const { GIFEncoder, quantize, applyPalette } = gifencMod as {
  GIFEncoder: () => { writeFrame: (i: Uint8Array, w: number, h: number, o: object) => void; finish: () => void; bytes: () => Uint8Array };
  quantize: (d: Uint8ClampedArray | Uint8Array, n: number) => number[][];
  applyPalette: (d: Uint8ClampedArray | Uint8Array, p: number[][]) => Uint8Array;
};

export const GIF_RENDER_VERSION = "v3-2";
export const FRAMINGS = ["close-up", "medium", "wide", "over-the-shoulder"] as const;
export const ANGLES = ["eye", "low", "high"] as const;
export const MOVES = ["push", "pull", "pan", "tilt", "static"] as const;
export const POSES = ["talk", "point", "measure", "hold", "walk"] as const;

export interface Shot {
  title: string;
  framing: (typeof FRAMINGS)[number];
  angle: (typeof ANGLES)[number];
  move: (typeof MOVES)[number];
  pose: (typeof POSES)[number];
  time: string;
  /** Short on-screen text when the shot shows a sign or overlay. */
  sign?: string;
}

const OW = 480;
const OH = 270;
const CORAL = "#FF6F61";
const SKINS = ["#623c28", "#4e2f1f", "#704530"];
const HAIR = "#16110f";
const SHIRTS = ["#282c3c", "#3b2a2a", "#22342c"];

let fontsReady = false;
function fonts() {
  if (fontsReady) return;
  fontsReady = true;
  for (const p of [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
  ]) {
    if (existsSync(p)) GlobalFonts.registerFromPath(p, "TFSans");
  }
}
const font = (px: number, bold = true) => `${bold ? "bold " : ""}${px}px TFSans, Liberation Sans, Arial, sans-serif`;

export function gifKey(kind: string, payload: unknown): string {
  return createHash("sha256").update(`${GIF_RENDER_VERSION}|${kind}|${JSON.stringify(payload)}`).digest("hex").slice(0, 40);
}

function pick<T>(list: readonly T[], seed: string): T {
  let n = 0;
  for (const c of seed) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return list[n % list.length];
}

function rr(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function ell(ctx: SKRSContext2D, cx: number, cy: number, rx: number, ry: number, fill: string) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}
function thick(ctx: SKRSContext2D, x1: number, y1: number, x2: number, y2: number, w: number, c: string) {
  ctx.strokeStyle = c;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function room(ctx: SKRSContext2D, W: number, H: number, horizon: number, blur: boolean) {
  ctx.fillStyle = "#3a3430";
  ctx.fillRect(0, 0, W, horizon);
  ctx.fillStyle = "#5c4a3c";
  ctx.fillRect(0, horizon, W, H - horizon);
  ctx.globalAlpha = blur ? 0.55 : 1;
  ctx.fillStyle = "#96aabe";
  ctx.fillRect(W * 0.73, H * 0.13, W * 0.18, H * 0.36);
  ctx.fillStyle = "#3a3430";
  ctx.fillRect(W * 0.82 - 4, H * 0.13, 8, H * 0.36);
  ctx.fillRect(W * 0.73, H * 0.31 - 4, W * 0.18, 8);
  ctx.fillStyle = "#465a3c";
  ctx.fillRect(W * 0.06, H * 0.37, W * 0.13, horizon - H * 0.37);
  ctx.globalAlpha = 1;
}

interface Look { skin: string; shirt: string; hair: "afro" | "locs" | "fade" }

/** One person facing camera (or seen from behind with back=true). */
function person(ctx: SKRSContext2D, cx: number, top: number, s: number, look: Look, pose: Shot["pose"], mouth: number, back = false) {
  const hw = 70 * s;
  if (look.hair === "afro") {
    ell(ctx, cx, top + 28 * s, 108 * s, 90 * s, HAIR);
    for (let k = 0; k < 24; k++) {
      const a = Math.PI + (k / 23) * Math.PI;
      ell(ctx, cx + 100 * s * Math.cos(a), top + 28 * s + 82 * s * Math.sin(a), 13 * s, 13 * s, HAIR);
    }
  } else if (look.hair === "locs") {
    ell(ctx, cx, top + 40 * s, 92 * s, 70 * s, HAIR);
    for (let k = -4; k <= 4; k++) thick(ctx, cx + k * 20 * s, top + 40 * s, cx + k * 22 * s, top + 210 * s, 14 * s, HAIR);
  }
  const nt = top + 160 * s;
  const bt = nt + 25 * s;
  ctx.fillStyle = look.skin;
  ctx.fillRect(cx - 22 * s, nt, 44 * s, 30 * s);
  ctx.fillStyle = look.shirt;
  rr(ctx, cx - 150 * s, bt, 300 * s, 420 * s, 60 * s);
  ctx.fill();
  if (pose === "point") {
    thick(ctx, cx + 130 * s, bt + 60 * s, cx + 255 * s, bt - 55 * s, 55 * s, look.shirt);
    ell(ctx, cx + 262 * s, bt - 62 * s, 27 * s, 27 * s, look.skin);
  } else if (pose === "measure") {
    thick(ctx, cx - 140 * s, bt + 80 * s, cx - 70 * s, bt + 255 * s, 50 * s, look.shirt);
    thick(ctx, cx + 140 * s, bt + 80 * s, cx + 70 * s, bt + 255 * s, 50 * s, look.shirt);
    ctx.fillStyle = "#f0c828";
    ctx.fillRect(cx - 150 * s, bt + 250 * s, 300 * s, 22 * s);
    ctx.strokeStyle = "#1e1e1e";
    ctx.lineWidth = 2;
    for (let k = 0; k < 12; k++) {
      ctx.beginPath();
      ctx.moveTo(cx - 140 * s + k * 25 * s, bt + 250 * s);
      ctx.lineTo(cx - 140 * s + k * 25 * s, bt + 262 * s);
      ctx.stroke();
    }
  } else if (pose === "hold") {
    thick(ctx, cx - 120 * s, bt + 90 * s, cx - 30 * s, bt + 150 * s, 48 * s, look.shirt);
    thick(ctx, cx + 120 * s, bt + 90 * s, cx + 30 * s, bt + 150 * s, 48 * s, look.shirt);
    ctx.fillStyle = CORAL;
    rr(ctx, cx - 45 * s, bt + 95 * s, 90 * s, 110 * s, 12 * s);
    ctx.fill();
  } else if (pose === "walk") {
    thick(ctx, cx - 130 * s, bt + 70 * s, cx - 190 * s, bt + 230 * s, 48 * s, look.shirt);
    thick(ctx, cx + 130 * s, bt + 70 * s, cx + 170 * s, bt + 240 * s, 48 * s, look.shirt);
  }
  ell(ctx, cx - hw - 2 * s, top + 88 * s, 10 * s, 18 * s, look.skin);
  ell(ctx, cx + hw + 2 * s, top + 88 * s, 10 * s, 18 * s, look.skin);
  ell(ctx, cx, top + 85 * s, hw, 85 * s, look.skin);
  if (back) {
    ell(ctx, cx, top + 70 * s, hw + 6 * s, 82 * s, HAIR);
    return;
  }
  ctx.fillStyle = HAIR;
  ctx.beginPath();
  if (look.hair === "fade") ctx.ellipse(cx, top + 32 * s, hw * 0.98, 34 * s, 0, Math.PI, 0);
  else ctx.ellipse(cx, top + 34 * s, hw + 2, 38 * s, 0, Math.PI, 0);
  ctx.fill();
  const ey = top + 84 * s;
  for (const ex of [cx - 26 * s, cx + 26 * s]) {
    ell(ctx, ex, ey, 9 * s, 6 * s, "#f0ece6");
    ell(ctx, ex, ey, 5 * s, 5 * s, "#140e0c");
    thick(ctx, ex - 12 * s, ey - 14 * s, ex + 10 * s, ey - 16 * s, Math.max(2, 4 * s), HAIR);
  }
  thick(ctx, cx, ey + 8 * s, cx - 6 * s, ey + 30 * s, Math.max(2, 3 * s), "rgba(0,0,0,0.25)");
  const my = top + 128 * s;
  ell(ctx, cx, my, 20 * s, (4 + mouth) * s, "#46221e");
  if (mouth > 2) {
    ctx.fillStyle = "#ebe8e2";
    ctx.fillRect(cx - 12 * s, my - (mouth + 1) * s, 24 * s, 3 * s);
  }
}

function wrap(ctx: SKRSContext2D, text: string, max: number) {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > max && cur) {
      out.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

/** Draws the full scene for a shot onto a big canvas the camera moves across. */
function shotScene(shot: Shot, look: Look): { scene: Canvas; start: number[]; end: number[] } {
  const SW = 1200;
  const SH = 675;
  const wide = shot.move === "pan";
  const tall = shot.move === "tilt";
  const W = wide ? SW * 2 : SW;
  const H = tall ? SH * 2 : SH;
  const scene = createCanvas(W, H);
  const ctx = scene.getContext("2d");
  const horizon = shot.angle === "low" ? H - 200 : shot.angle === "high" ? H * 0.4 : H - 245;
  room(ctx, W, H, horizon, shot.framing === "close-up");
  const scale = { "close-up": 1.55, medium: 1.2, wide: 0.75, "over-the-shoulder": 1.3 }[shot.framing] * (shot.angle === "low" ? 1.12 : shot.angle === "high" ? 0.88 : 1);
  const subjX = wide ? W * 0.6 : shot.pose === "point" ? W * 0.36 : W / 2;
  const subjTop = shot.framing === "close-up" ? (tall ? H - SH + 100 : 100) : shot.framing === "wide" ? horizon - 600 * scale : tall ? H - SH + 120 : 90;
  if (shot.pose === "point" || shot.sign) {
    const bx = subjX + 300 * scale;
    const by = subjTop + 100 * scale;
    ctx.fillStyle = "#19191c";
    ctx.fillRect(bx, by, 330 * scale, 520 * scale);
    ctx.fillStyle = "#28282c";
    ctx.fillRect(bx + 18 * scale, by + 18 * scale, 294 * scale, 484 * scale);
    ctx.font = font(Math.round(56 * scale));
    const lines = wrap(ctx, (shot.sign || shot.title).toUpperCase(), 270 * scale).slice(0, 4);
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? CORAL : "#ffffff";
      ctx.fillText(l, bx + 32 * scale, by + 120 * scale + i * 72 * scale);
    });
  }
  let mirror = false;
  if (shot.pose === "measure" || shot.framing === "over-the-shoulder") {
    mirror = true;
    const mx = wide ? W * 0.38 : W * 0.32;
    ctx.fillStyle = "#aab9c3";
    rr(ctx, mx, 40, 700, 600, 20);
    ctx.fill();
    ctx.fillStyle = "#788796";
    rr(ctx, mx + 20, 60, 660, 560, 16);
    ctx.fill();
    ctx.save();
    rr(ctx, mx + 20, 60, 660, 560, 16);
    ctx.clip();
    person(ctx, mx + 350, 20, 1.2, look, shot.pose, 1);
    ctx.restore();
  }
  if (shot.framing === "over-the-shoulder") {
    person(ctx, wide ? W * 0.18 : W * 0.15, -60, 1.7, look, "talk", 0, true);
  } else if (!mirror || shot.pose !== "measure") {
    person(ctx, subjX, subjTop, scale, look, shot.pose, 3);
  } else {
    person(ctx, wide ? W * 0.18 : W * 0.14, -60, 1.6, look, "measure", 0, true);
  }
  const full = [0, 0, SW];
  const tight = shot.framing === "close-up" ? [SW * 0.25, 110, SW * 0.52] : [SW * 0.15, 70, SW * 0.7];
  let start = full;
  let end = tight;
  if (shot.move === "pull") [start, end] = [tight, full];
  if (shot.move === "pan") [start, end] = [[100, 0, SW], [W - SW - 100, 0, SW]];
  if (shot.move === "tilt") [start, end] = [[0, H - SH, SW], [0, 0, SW]];
  if (shot.move === "static") [start, end] = [[30, 15, SW - 60], [0, 0, SW]];
  return { scene, start, end };
}

function overlay(ctx: SKRSContext2D, label: string, tag: string) {
  ctx.strokeStyle = "rgba(255,255,255,0.24)";
  ctx.lineWidth = 1;
  for (const k of [1, 2]) {
    ctx.beginPath();
    ctx.moveTo((OW * k) / 3, 0);
    ctx.lineTo((OW * k) / 3, OH);
    ctx.moveTo(0, (OH * k) / 3);
    ctx.lineTo(OW, (OH * k) / 3);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2;
  for (const [x, y, dx, dy] of [[10, 10, 1, 1], [OW - 10, 10, -1, 1], [10, OH - 10, 1, -1], [OW - 10, OH - 10, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x + 18 * dx, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + 18 * dy);
    ctx.stroke();
  }
  ctx.font = font(12);
  const lw = Math.min(OW - 140, ctx.measureText(label).width);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  rr(ctx, 16, 16, lw + 20, 24, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(label, 26, 32, OW - 160);
  const tw = ctx.measureText(tag).width;
  ctx.fillStyle = CORAL;
  rr(ctx, OW - 16 - tw - 20, 16, tw + 20, 24, 8);
  ctx.fill();
  ctx.fillStyle = "#000";
  ctx.fillText(tag, OW - 26 - tw, 32);
  ell(ctx, OW - 25, OH - 23, 5, 5, "#ff3b30");
  ctx.fillStyle = "#fff";
  ctx.font = font(11);
  ctx.fillText("REC", OW - 62, OH - 19);
}

function encode(frames: Array<{ data: Uint8ClampedArray; delay: number }>): Buffer {
  const gif = GIFEncoder();
  for (const f of frames) {
    const palette = quantize(f.data, 128);
    gif.writeFrame(applyPalette(f.data, palette), OW, OH, { palette, delay: f.delay });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

const MOVE_TAG: Record<Shot["move"], string> = { push: "PUSH IN", pull: "PULL OUT", pan: "PAN", tilt: "TILT UP", static: "LOCKED OFF" };
const FRAMING_LABEL: Record<Shot["framing"], string> = { "close-up": "Close-up", medium: "Medium", wide: "Wide", "over-the-shoulder": "Over the shoulder" };
const ANGLE_LABEL: Record<Shot["angle"], string> = { eye: "eye level", low: "low angle", high: "high angle" };

export function lookFor(seed: string): Look {
  return { skin: pick(SKINS, seed), shirt: pick(SHIRTS, `${seed}s`), hair: pick(["afro", "locs", "fade"] as const, `${seed}h`) };
}

/** Caption pages: the line wrapped to the safe width, two lines per page. */
export function captionPages(ctx: SKRSContext2D, text: string, max: number): string[][] {
  const lines = wrap(ctx, text.trim(), max);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 2) pages.push(lines.slice(i, i + 2));
  return pages;
}

/**
 * Burned-in caption: bold white with a dark outline on a dark box, at most two
 * lines, in the lower safe area above the REC tag and below the move tag.
 */
function caption(ctx: SKRSContext2D, lines: string[]) {
  if (!lines.length) return;
  const max = OW - 120;
  ctx.font = font(17);
  const lh = 21;
  const w = Math.min(max, Math.max(...lines.map((l) => ctx.measureText(l).width)));
  const boxH = lines.length * lh + 12;
  const bottom = OH - 40;
  ctx.fillStyle = "rgba(0,0,0,0.62)";
  rr(ctx, OW / 2 - w / 2 - 10, bottom - boxH, w + 20, boxH, 8);
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.fillStyle = "#fff";
  lines.forEach((l, k) => {
    const lw = Math.min(max, ctx.measureText(l).width);
    const y = bottom - boxH + 6 + lh * (k + 1) - 5;
    ctx.strokeText(l, OW / 2 - lw / 2, y, max);
    ctx.fillText(l, OW / 2 - lw / 2, y, max);
  });
}

/** The spoken line for a shot: shot 1 SETUP, 2 PAYOFF, 3 CTA, else the shot's action. */
export function shotLine(script: string | null | undefined, shot: Shot, index: number): string {
  const order = ["SETUP", "PAYOFF", "CTA"];
  const want = order[index];
  const line = want ? (script ?? "").split(/\n+/).find((l) => new RegExp(`^\\s*${want}\\s*:`, "i").test(l)) : undefined;
  return (line ? line.replace(/^\s*[A-Z]+\s*:\s*/i, "") : shot.title).trim();
}

export function renderShotGif(shot: Shot, index: number, seed: string, line = ""): Buffer {
  fonts();
  const look = lookFor(seed);
  const { scene, start, end } = shotScene(shot, look);
  const out = createCanvas(OW, OH);
  const ctx = out.getContext("2d");
  const n = 18;
  const frames: Array<{ data: Uint8ClampedArray; delay: number }> = [];
  const label = `Shot ${index + 1} \u00b7 ${FRAMING_LABEL[shot.framing]} \u00b7 ${ANGLE_LABEL[shot.angle]} \u00b7 ${shot.time}`;
  // Ping-pong camera over 2n-2 frames, drawn out so captions keep moving forward.
  ctx.font = font(17);
  const pages = line ? captionPages(ctx, line, OW - 120) : [];
  const total = 2 * n - 2;
  for (let f = 0; f < total; f++) {
    const i = f < n ? f : 2 * n - 2 - f;
    const t = (1 - Math.cos((Math.PI * i) / (n - 1))) / 2;
    const [x, y, w] = start.map((a, k) => a + (end[k] - a) * t);
    const h = (w * OH) / OW;
    ctx.drawImage(scene, x, y, w, h, 0, 0, OW, OH);
    overlay(ctx, label, MOVE_TAG[shot.move]);
    if (pages.length) caption(ctx, pages[Math.min(pages.length - 1, Math.floor((f * pages.length) / total))]!);
    frames.push({ data: ctx.getImageData(0, 0, OW, OH).data, delay: pages.length > 1 ? 110 : 90 });
  }
  return encode(frames);
}

export function renderHookGif(hook: string, seed: string): Buffer {
  fonts();
  const look = lookFor(seed);
  const words = hook.split(/\s+/).filter(Boolean).slice(0, 30);
  const bg = createCanvas(1200, 675);
  const b = bg.getContext("2d");
  room(b, 1200, 675, 430, true);
  const out = createCanvas(OW, OH);
  const ctx = out.getContext("2d");
  const frames: Array<{ data: Uint8ClampedArray; delay: number }> = [];
  for (let i = 0; i < words.length + 5; i++) {
    const sc = createCanvas(1200, 675);
    const s = sc.getContext("2d");
    s.drawImage(bg, 0, 0);
    person(s, 600, 90, 1.45, look, "talk", i % 2 === 0 && i < words.length ? 5 : 1);
    ctx.drawImage(sc, 200, 70, 800, 450, 0, 0, OW, OH);
    const end = Math.min(i + 1, words.length);
    const txt = words.slice(Math.max(0, end - 4), end).join(" ");
    ctx.font = font(22);
    const tw = Math.min(OW - 40, ctx.measureText(txt).width);
    ctx.fillStyle = "rgba(0,0,0,0.68)";
    rr(ctx, OW / 2 - tw / 2 - 12, OH - 62, tw + 24, 34, 10);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(txt, OW / 2 - tw / 2, OH - 38, OW - 40);
    const lab = "Say this \u00b7 Hook:";
    ctx.font = font(12);
    const lw = ctx.measureText(lab).width;
    ctx.fillStyle = CORAL;
    rr(ctx, 16, 16, lw + 20, 24, 8);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.fillText(lab, 26, 32);
    ctx.fillStyle = "#fff";
    ctx.font = font(11);
    ctx.fillText("Medium close-up", OW - 120, 32);
    frames.push({ data: ctx.getImageData(0, 0, OW, OH).data, delay: i < words.length ? 300 : 500 });
  }
  return encode(frames);
}

/** Pulls the hook line out of a HOOK:/SETUP:/... script. */
export function hookFromScript(script: string | null | undefined, fallback: string): string {
  const line = (script ?? "").split(/\n+/).find((l) => /^\s*HOOK\s*:/i.test(l));
  return (line ? line.replace(/^\s*HOOK\s*:\s*/i, "") : fallback).trim();
}

/** Coerces model output to a valid shot. */
export function cleanShot(raw: Partial<Shot>, i: number): Shot {
  const one = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
  return {
    title: String(raw.title ?? `Shot ${i + 1}`).slice(0, 120),
    framing: one(raw.framing, FRAMINGS, i === 0 ? "close-up" : "medium"),
    angle: one(raw.angle, ANGLES, "eye"),
    move: one(raw.move, MOVES, i === 0 ? "push" : "pan"),
    pose: one(raw.pose, POSES, "talk"),
    time: String(raw.time ?? "").slice(0, 30),
    ...(raw.sign ? { sign: String(raw.sign).slice(0, 40) } : {}),
  };
}