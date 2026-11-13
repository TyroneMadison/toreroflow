import { emptyDoc } from "./editDoc";
import {
  aggregatePerformance, commentMarkers, edlToFcpxml, edlToPremiereXml, fillBrollSpot, isPexelsMediaUrl,
  newUploads, openCommentCount, parseDriveLink, pickPexelsFile, readAutoImport, safeFileName, threadComments,
  toTsQuery, uploadsPlaylistId, watchedPlaylists, xmlEscape,
} from "./collab";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

// comments
const c = (id: string, parentId: string | null, atSec: number | null, t: number, resolved = false) => ({
  id, parentId, atSec, body: id, authorName: "a", authorKind: "team",
  resolvedAt: resolved ? new Date(0).toISOString() : null, createdAt: new Date(t).toISOString(),
});
const th = threadComments([c("r2", "x", null, 5), c("b", null, 10, 1), c("a", null, 2, 2, true), c("n", null, null, 0), c("r1", "b", null, 9), c("r0", "b", null, 3), c("orph", "zz", null, 1)]);
eq(th.map((t) => t.id), ["a", "b", "n"], "roots in timeline order, untimed last");
eq(th[1]!.replies.map((r) => r.id), ["r0", "r1"], "replies oldest first, orphans dropped");
eq(openCommentCount(th), 2, "open count skips resolved");
eq(commentMarkers(th, 8).map((m) => [m.id, m.at, m.count, m.resolved]), [["a", 2, 1, true], ["b", 8, 1, false]], "markers clamped");
const near = threadComments([c("p", null, 1, 0, true), c("q", null, 1.2, 1)]);
eq(commentMarkers(near, 10).map((m) => [m.id, m.count, m.resolved]), [["p", 2, false]], "close markers merge");

// xml
const x = {
  name: "Ep <1> & co", fps: 30, width: 1080, height: 1920,
  segments: [{ assetId: "a1", srcIn: 1, srcOut: 3 }, { assetId: "a1", srcIn: 5, srcOut: 5.5 }],
  assets: { a1: { name: "talk.mp4", durationSec: 10 } },
};
const px = edlToPremiereXml(x);
eq(px.includes("<name>Ep &lt;1&gt; &amp; co</name>"), true, "name escaped");
eq((px.match(/<clipitem id="clip-/g) ?? []).length, 2, "two video clipitems");
eq(px.includes("<start>60</start><end>75</end><in>150</in><out>165</out>"), true, "second clip frames");
eq(px.includes("<duration>75</duration>"), true, "sequence duration");
eq((px.match(/<pathurl>/g) ?? []).length, 1, "file declared once");
const fx = edlToFcpxml(x);
eq(fx.includes('offset="60/30s" start="150/30s" duration="15/30s"'), true, "fcpxml second clip");
eq(fx.includes('<sequence format="r1" duration="75/30s"'), true, "fcpxml duration");
eq(xmlEscape(`"'`), "&quot;&apos;", "quotes escaped");

// perf
const p = aggregatePerformance([
  { platform: "youtube", views: 100, likes: 5, comments: 1, shares: 2, saves: 3, avgWatchSec: 10 },
  { platform: "tiktok", views: 300, likes: 1, comments: 0, shares: 0, saves: 1, avgWatchSec: 20 },
  { platform: "tiktok", views: -4, likes: 0, comments: 0, shares: 0, saves: 0 },
], 25);
eq([p.views, p.saves, p.avgWatchSec, p.avgWatchPct, p.posts, p.platforms], [400, 4, 17.5, 0.7, 3, ["tiktok", "youtube"]], "perf aggregate");
eq(aggregatePerformance([], 10).avgWatchPct, null, "no watch data");

// auto-import
const ch = "UC" + "a".repeat(22);
const s = readAutoImport({ on: true, channelId: ch, playlists: ["PLabcdefghijk", "bad id", "PLabcdefghijk"], recipeId: "r" });
eq(s.on && s.uploads, true, "defaults on uploads");
eq(watchedPlaylists(s), [uploadsPlaylistId(ch), "PLabcdefghijk"], "uploads first, deduped");
eq(readAutoImport({ channelId: "nope" }).channelId, null, "bad channel id dropped");
const feed = [
  { videoId: "v3", title: "", publishedAt: "2026-10-03T00:00:00Z" },
  { videoId: "v1", title: "", publishedAt: "2026-10-01T00:00:00Z" },
  { videoId: "v2", title: "", publishedAt: "2026-10-02T00:00:00Z" },
  { videoId: "v2", title: "", publishedAt: "2026-10-02T00:00:00Z" },
];
eq(newUploads(feed, new Set(["v1"]), null, false).map((v) => v.videoId), ["v2", "v3"], "unseen oldest first");
eq(newUploads(feed, new Set(), "2026-10-01T12:00:00Z", true).map((v) => v.videoId), ["v2", "v3"], "first run only after since");
eq(newUploads(feed, new Set(), null, true), [], "first run without since imports nothing");

// drive
eq(parseDriveLink("https://drive.google.com/file/d/1AbCdEfGhIjK_lm/view?usp=sharing"), { kind: "file", id: "1AbCdEfGhIjK_lm" }, "file link");
eq(parseDriveLink("https://drive.google.com/drive/u/0/folders/0BxYz123456789"), { kind: "folder", id: "0BxYz123456789" }, "folder link");
eq(parseDriveLink("https://drive.google.com/open?id=1AbCdEfGhIjK_lm"), { kind: "file", id: "1AbCdEfGhIjK_lm" }, "open link");
eq(parseDriveLink("https://evil.example/file/d/1AbCdEfGhIjK_lm"), null, "other hosts refused");
eq(safeFileName("../a/b:c.mp4"), "_a_b_c.mp4", "safe file name");

// pexels
eq(isPexelsMediaUrl("https://videos.pexels.com/x.mp4"), true, "pexels host");
eq(isPexelsMediaUrl("https://pexels.com.evil.io/x.mp4"), false, "lookalike host");
eq(isPexelsMediaUrl("http://videos.pexels.com/x.mp4"), false, "http refused");
const files = [
  { link: "https://videos.pexels.com/a.mp4", width: 2160, height: 3840, file_type: "video/mp4" },
  { link: "https://videos.pexels.com/b.mp4", width: 1080, height: 1920, file_type: "video/mp4" },
  { link: "https://videos.pexels.com/c.mp4", width: 1920, height: 1080, file_type: "video/mp4" },
  { link: "https://evil.io/d.mp4", width: 1080, height: 1920 },
];
eq(pickPexelsFile(files)?.link, "https://videos.pexels.com/b.mp4", "portrait 1080p");
eq(pickPexelsFile(files, false)?.link, "https://videos.pexels.com/c.mp4", "landscape");
eq(pickPexelsFile([files[3]!]), null, "foreign host never picked");

// search
eq(toTsQuery("  Money's   TIPS!! tips "), "money:* & s:* & tips:*", "tsquery terms");
eq(toTsQuery("&|!():*"), "", "operators only");

// spots
const doc = { ...emptyDoc(["a"]), brollSpots: [{ id: "s1", label: "l", keywords: [], word: { assetId: "a", i: 3 }, dur: 2.5 }] };
const filled = fillBrollSpot(doc, "s1", "b1", "ab-1", 1.5);
eq([filled.brollSpots?.length, filled.broll.length, filled.broll[0]?.dur, filled.broll[0]?.word], [0, 1, 1.5, { assetId: "a", i: 3 }], "spot filled, capped by asset");
eq(fillBrollSpot(doc, "nope", "b1", "x"), doc, "unknown spot");

console.log("collab.check ok");
