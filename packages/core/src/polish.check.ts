import { existsSync, readFileSync } from "node:fs";
import { EMOJI_DICT } from "./aiPasses";
import { emptyDoc } from "./editDoc";
import { textsWithHook } from "./aiPasses";
import {
  HOOK_PRESETS,
  LOOKS,
  SAFE_ZONES,
  STICKER_PACK,
  TRANSITIONS,
  applyHookPreset,
  captionEmojiOverlays,
  censorSpans,
  cleanWordList,
  emojiFile,
  enhanceChain,
  estimateTextWidth,
  faceCenterAt,
  fontFamilyName,
  fontFileName,
  isCensored,
  lowerThirdTexts,
  maskText,
  maskWord,
  pointInFrame,
  roundedBoxSize,
  roundedRectPath,
  stickerOverlays,
  textOn,
  transitionAt,
  transitionCss,
  transitionJoins,
} from "./polish";

function ok(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

// Transitions: ~30 unique presets; joins only between clips.
ok(TRANSITIONS.length >= 30, "about 30 presets");
ok(new Set(TRANSITIONS.map((t) => t.id)).size === TRANSITIONS.length, "unique ids");
const edl = [
  { clipId: "c1", assetId: "a", srcIn: 0, srcOut: 4 },
  { clipId: "c1", assetId: "a", srcIn: 5, srcOut: 8 },
  { clipId: "c2", assetId: "b", srcIn: 0, srcOut: 2 },
  { clipId: "c3", assetId: "b", srcIn: 2, srcOut: 2.1 },
];
ok(transitionJoins(undefined, edl).length === 0, "no settings, no joins");
const j = transitionJoins({ auto: "crossfade", dur: 0.5 }, edl);
ok(j.length === 1 && j[0].seg === 2 && j[0].at === 7 && j[0].xfade === "fade" && j[0].dur === 0.5, "auto at the clip join only, too-short incoming skipped");
const j2 = transitionJoins({ auto: "crossfade", dur: 3, joins: { c2: { kind: "dipblack", dur: 3 } } }, edl);
ok(j2[0].xfade === "fadeblack" && j2[0].dur === 1.5, "override wins, dur clamped to max");
ok(transitionJoins({ auto: "crossfade", dur: 0.4, joins: { c2: null } }, edl).length === 0, "null override removes");
ok(transitionJoins({ auto: "none", dur: 0.4 }, edl).length === 0, "auto none");
ok(transitionAt(j, 7.25)?.p === 0.5 && transitionAt(j, 7.6) === null, "transitionAt");
ok(transitionCss("crossfade", 0.5).opacity === 0.5, "fade css");
ok(transitionCss("dipblack", 0.25).dip?.opacity === 0.75, "dip css");
ok(transitionCss("pushleft", 0).transform === "translateX(100%)", "push css");

// Lower thirds ride the text path.
const lt = lowerThirdTexts({ id: "x", at: 1, dur: 3, kind: "nametitle", name: "Caleb", title: "Founder", from: "left", accent: "#ff6b5b" });
ok(lt.length === 2 && lt[0].style.background.shape === "rounded" && lt[1].content === "Founder", "name + title");
ok(lowerThirdTexts({ id: "y", at: 0, dur: 3, kind: "location", name: "Atlanta, GA", from: "fade", accent: "#fff" }).length === 1, "location single line");
const d = emptyDoc([]);
ok(textsWithHook(d).length === 0, "no lower thirds by default");
ok(textsWithHook({ ...d, lowerThirds: [{ id: "x", at: 1, dur: 3, kind: "nametitle", name: "A", title: "B", from: "left", accent: "#000000" }] }).length === 2, "textsWithHook includes lower thirds");
ok(textOn("#ffffff") === "#111111" && textOn("#000000") === "#ffffff", "textOn");

// Hook presets.
ok(HOOK_PRESETS.map((h) => h.id).join() === "whitebox,coralbar,outline,yellow", "hook presets");
const hs = applyHookPreset(d.captions.style, "whitebox");
ok(hs.background.on && hs.background.shape === "rounded" && hs.color === "#111111" && hs.font === d.captions.style.font, "preset merges");

// Censor.
ok(maskWord("Shit,") === "S---,", "maskWord keeps first letter and punctuation");
ok(isCensored("DAMN!", ["damn"]) && !isCensored("damned", ["damn"]) && isCensored("damned", ["damn*"]), "isCensored");
ok(maskText("well damn that", ["damn"]) === "well d--- that", "maskText");
const sp = censorSpans(
  [
    { word: "oh", start: 0, end: 0.2 },
    { word: "damn", start: 0.3, end: 0.6 },
    { word: "hell", start: 0.62, end: 0.9 },
    { word: "ok", start: 1, end: 1.2 },
  ],
  ["damn", "hell"],
);
ok(sp.length === 1 && sp[0].start === 0.26 && sp[0].end === 0.94, "spans merged and padded");
ok(cleanWordList([" Damn ", "damn", 3, "Hell"]).join() === "damn,hell", "cleanWordList");

// Looks, enhance, safe zones.
ok(LOOKS.length === 4 && LOOKS.some((l) => l.label === "Dud Rents gloss"), "looks");
ok(enhanceChain(undefined).length === 0 && enhanceChain({ on: true, lufs: -14 }).at(-1) === "loudnorm=I=-14:TP=-1.5:LRA=11", "enhance chain");
ok(enhanceChain({ on: true, lufs: -40 }).at(-1)!.startsWith("loudnorm=I=-24"), "lufs clamped");
ok(Object.keys(SAFE_ZONES).length === 4, "safe zones");

// Emoji files exist for the sticker pack and render as a row above captions.
ok(emojiFile("❤️") === "2764.png" && emojiFile("👨‍👩‍👧") === "1f468-200d-1f469-200d-1f467.png", "emojiFile");
const emo = captionEmojiOverlays(
  [{ start: 1, end: 2, text: "big money", emojis: ["💰", "🔥"] }, { start: 2, end: 3, text: "no emoji" }],
  d.captions,
  1080,
  1920,
);
ok(emo.length === 2 && emo[0].start === 1 && emo[0].x < emo[1].x && emo[0].y === emo[1].y, "emoji row");
ok(captionEmojiOverlays([{ start: 0, end: 1, text: "x", emojis: ["💰"] }], { ...d.captions, enabled: false }, 1080, 1920).length === 0, "captions off, no emoji");
const st = stickerOverlays([{ id: "s", emoji: "🔥", at: 1, dur: 2, x: 0, y: 0, scale: 0.2 }], 1080, 1920);
ok(st[0].size === 216 && st[0].x === 432 && st[0].y === 852 && st[0].end === 3, "sticker overlay centred");

// Rounded boxes.
ok(roundedRectPath(100, 40, 10).startsWith("m 10 0 l 90 0 b"), "rounded path");
ok(roundedRectPath(100, 40, 99).startsWith("m 20 0"), "radius clamped");
ok(estimateTextWidth("HELLO", { ...d.captions.style, font: "Anton" }) < estimateTextWidth("HELLO", { ...d.captions.style, font: "Montserrat" }), "anton narrower");
const box = roundedBoxSize("two\nlines", d.captions.style);
ok(box.h > d.captions.style.size * 2 && box.w > 0 && box.r <= box.h / 2, "box size");

// Face anchor.
const track = { fps: 2, w: 1920, h: 1080, frames: [{ t: 0, faces: [] }, { t: 1, faces: [{ x: 0.6, y: 0.2, w: 0.1, h: 0.2, score: 1, mouth: 0 }] }] };
const fc = faceCenterAt(track, 0.8);
ok(fc !== null && Math.abs(fc.x - 0.65) < 1e-9 && Math.abs(fc.y - 0.3) < 1e-9, "face centre");
ok(faceCenterAt(track, 5) === null && faceCenterAt(null, 0) === null, "no face far away");
const inCrop = pointInFrame({ x: 0.65, y: 0.3 }, { x: 0.5, y: 0, w: 0.3, h: 1 }, 16 / 9, 9 / 16);
ok(inCrop.x === 0.5 && inCrop.y === 0.3, "face in crop");
const lb = pointInFrame({ x: 0.5, y: 0.1 }, null, 16 / 9, 9 / 16);
ok(lb.y === 0.373 && lb.x === 0.5, "letterbox maps into the band");
ok(pointInFrame({ x: 0.99, y: 0.5 }, { x: 0, y: 0, w: 1, h: 1 }, 1, 1).x === 0.85, "edge clamps");

// Fonts.
const ttf = readFileSync(new URL("../../../assets/fonts/Anton-Regular.ttf", import.meta.url));
ok(fontFamilyName(new Uint8Array(ttf)) === "Anton", "font family from name table");
ok(fontFamilyName(new Uint8Array([1, 2, 3])) === null, "junk is null");
ok(fontFileName("My Brand Font!.TTF") === "My-Brand-Font.ttf" && fontFileName("x.woff") === null, "fontFileName");

for (const e of new Set([...Object.values(EMOJI_DICT), ...STICKER_PACK])) {
  ok(existsSync(new URL(`../../../assets/emoji/${emojiFile(e)}`, import.meta.url)), `emoji file for ${e}`);
}

console.log("polish.check: all assertions passed");
