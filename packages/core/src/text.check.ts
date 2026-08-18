// decodeEscapes runs on every caption the app shows and every one it sends, so
// a mistake here is visible on a client's channel. It was left uncovered when
// this file's original subject (the watch-next link) was removed; the function
// itself is still live and is the harder half.
import assert from "node:assert/strict";
import { decodeEscapes } from "./text";

// A literal escape sequence becomes the character it names.
assert.equal(decodeEscapes("nice \u0041 car"), "nice A car");

// A surrogate pair written as two escapes rebuilds one emoji, rather than
// being mistaken for two lone halves and deleted.
assert.equal(decodeEscapes("\ud83d\ude08"), "\u{1F608}");

// Half a pair is not a character. Dropped rather than rendered as a box.
assert.equal(decodeEscapes("hi \ud83d there"), "hi  there", "a stray high surrogate goes");
assert.equal(decodeEscapes("hi \ude08 there"), "hi  there", "so does a stray low one");
assert.equal(decodeEscapes("\ude08 leading"), " leading", "including at the very start");

// Real emoji already in the text survive untouched, which is the common case.
assert.equal(decodeEscapes("ship it 🚀"), "ship it 🚀");
assert.equal(decodeEscapes("family 👨‍👩‍👧 here"), "family 👨‍👩‍👧 here", "zwj sequences survive");

// Ordinary text is returned unchanged, backslashes that name nothing included.
assert.equal(decodeEscapes(""), "");
assert.equal(decodeEscapes("C:\Users\path"), "C:\Users\path", "a non-escape backslash stays");

console.log("text helpers: all checks passed");
