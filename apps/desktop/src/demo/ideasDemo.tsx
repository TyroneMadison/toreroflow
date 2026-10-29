/**
 * Dev-only ideas demo: `vite` then open any app path with ?demo=ideas (add
 * &theme=light, &sunra=off for the not-connected state). Stubs fetch with
 * placeholder data so the real App renders the ideas screens without an API
 * or a login. main.tsx only loads this behind import.meta.env.DEV, so
 * production builds never contain it.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../App";
import { THEME_STORAGE_KEY } from "../lib/theme";

const params = new URLSearchParams(location.search);
localStorage.setItem(THEME_STORAGE_KEY, params.get("theme") === "light" ? "light" : "dark");
localStorage.setItem("toreroflow-token", "demo");
localStorage.setItem("toreroflow-selected-client", "caleb");
const sunraOn = params.get("sunra") !== "off";

const now = Date.now();
const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString();
const DAY = 86_400_000;
const svg = (fill: string, label: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${fill}"/><text x="200" y="165" font-family="Arial" font-size="44" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`)}`;

const brand = (id: string, name: string, email: string | null) => ({
  id,
  name,
  avatarSeed: id,
  plan: null,
  contactName: null,
  contactEmail: email,
  contactPhone: null,
  handles: null,
  monthlyPriceCents: null,
  billingMode: "calendar",
  createdAt: iso(-200 * DAY),
  workflowCount: 0,
  slug: id,
  sop: null,
  sopUpdatedAt: null,
  trelloLabels: [],
  captionBlock: null,
  captionBlockOn: false,
  captionKeywords: [],
  totalFollowers: 18400,
  accounts: [],
});
const CLIENTS = [brand("caleb", "Caleb", "caleb@cacvmotors.com"), brand("dudley", "Dudley", null), brand("jacoby", "Jacoby", "jr@jacoby.co")];

const video = (id: string, name: string, durationSec: number) => ({
  id,
  clientId: "caleb",
  name,
  kind: "video",
  slideCount: 0,
  durationSec,
  width: 1080,
  height: 1920,
  status: "ready",
  hasTranscript: true,
  draftCopy: null,
  format: null,
  isRevision: false,
  revisionOfId: null,
  createdAt: iso(-3 * DAY),
  thumbUrl: null,
  coverOffsetMs: null,
  videoUrl: null,
});
const MEDIA = [video("v1", "Urus walkaround.mp4", 42), video("v2", "Dudley track day.mp4", 842)];

const target = (id: string, postId: string, assetName: string, platform: string, status: string, at: number) => ({
  id,
  postId,
  platform,
  status,
  scheduledAt: iso(at),
  publishedAt: status === "posted" ? iso(at) : null,
  error: null,
  remotePostId: null,
  remoteUrl: null,
  assetName,
});
const POSTS = [
  target("t1", "p1", "2021 M3 Competition", "instagram", "posted", -2 * DAY),
  target("t2", "p2", "Urus walkaround", "tiktok", "posted", -5 * DAY),
  target("t3", "p3", "Price drop Friday", "instagram", "failed", -1 * DAY),
];

// 26 posts over the last 90 days, Thursday evenings ahead.
const HISTORY = Array.from({ length: 26 }, (_, i) => {
  const d = new Date(now - (i * 3 + 1) * DAY);
  d.setUTCHours([22, 23, 16, 1, 14][i % 5]!, 0, 0, 0);
  return { id: `h${i}`, mediaType: "video", title: `Post ${i}`, publishedAt: d.toISOString(), thumbnailUrl: null, url: null, platforms: ["instagram"], views: 4000 + ((i * 7919) % 9000) + (i % 5 === 0 ? 12000 : 0), likes: 0, comments: 0, shares: 0 };
});

let links = [
  { id: "l1", versionId: "v1", token: "demo1.Ab_c-9xYzQw12345", url: "/a/demo1.Ab_c-9xYzQw12345", expiresAt: iso(6 * DAY), revokedAt: null as string | null, status: "pending" },
  { id: "l0", versionId: "v1", token: "demo0.Zx_c-9xYzQw12345", url: "/a/demo0.Zx_c-9xYzQw12345", expiresAt: iso(-1 * DAY), revokedAt: null, status: "changes_requested" },
];
const PUBLIC_APPROVAL = {
  status: "pending",
  expiresAt: iso(6 * DAY),
  video: { name: "Urus walkaround.mp4", url: "/files/demo.mp4", durationSec: 42 },
  comments: [
    { id: "c1", atMs: 5000, body: "Can the price show earlier?", createdAt: iso(-3600_000) },
    { id: "c2", atMs: 22000, body: "Love this shot, keep it.", createdAt: iso(-1800_000) },
  ],
};

const kit = {
  brandId: "caleb",
  fonts: [
    { family: "Archivo Black", weights: [400] },
    { family: "Inter", weights: [400, 700] },
  ],
  colors: ["#C8102E", "#111111", "#F2F2F2"],
  logoAssetId: "a1",
  logoUrl: svg("none", "CACV") as string | null,
  voiceNotes: "Short and direct. Price in first line. One emoji max. No hashtag walls.",
};

const asset = (id: string, brandId: string | null, type: string, name: string, fill: string) => ({ id, brandId, type, name, url: svg(fill, name.split(" ")[0]!), createdAt: iso(-DAY) });
const ASSETS = [
  asset("a1", "caleb", "logo", "Caleb logo", "#C8102E"),
  asset("a2", null, "video", "Miami b-roll", "#2B3A55"),
  asset("a3", "caleb", "template", "Price card", "#5A2A2A"),
  asset("a4", null, "audio", "Whoosh SFX", "#333"),
  asset("a5", "dudley", "video", "Dud intro", "#444"),
  asset("a6", null, "template", "Lower third", "#3A3A55"),
  asset("a7", "jacoby", "image", "JR thumbnail", "#7A5A10"),
  asset("a8", null, "audio", "Beat 120bpm", "#2A2A2A"),
];

const FONTS = ["Inter", "Archivo Black", "Bebas Neue", "Montserrat", "Anton", "Poppins", "Oswald"].map((family) => ({ family, category: "sans-serif", weights: [400, 700, 900] }));

const MODELS = [
  { id: "nano-banana-2", label: "Nano Banana 2", provider: "Google", creditsPerImage: 7, supportedAspectRatios: ["4:5", "9:16", "1:1"], supportedSizes: [], supportedResolutions: [], maxRefImages: 4 },
  { id: "nano-banana-pro", label: "Nano Banana Pro", provider: "Google", creditsPerImage: 14, supportedAspectRatios: ["4:5", "9:16"], supportedSizes: [], supportedResolutions: [], maxRefImages: 8 },
  { id: "seedream-4", label: "Seedream 4", provider: "ByteDance", creditsPerImage: 6, supportedAspectRatios: ["9:16"], supportedSizes: [], supportedResolutions: [], maxRefImages: 2 },
];

const requestLinks = [{ id: "rl1", brandId: "caleb", token: "rl1.sig_DemoTokenAbc123", url: "/r/rl1.sig_DemoTokenAbc123", revokedAt: null, createdAt: iso(-10 * DAY) }];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function route(path: string, method: string): Response | null {
  if (path === "/auth/me") return json({ id: "u1", email: "toreronee@gmail.com", role: "owner", agencyId: "ag", agencyName: "Torerone" });
  if (path === "/clients") return json(CLIENTS);
  if (/^\/clients\/[^/]+\/media$/.test(path)) return json(MEDIA);
  if (/^\/clients\/[^/]+\/posts$/.test(path)) return json(POSTS);
  if (/^\/clients\/[^/]+\/analytics\/posts$/.test(path)) return json({ posts: HISTORY });
  if (/^\/clients\/[^/]+\/edit-projects$/.test(path))
    return json([{ id: "ep1", name: "Urus walkaround cut", status: "draft", clipCount: 4, durationSec: 38, updatedAt: iso(-3600_000) }]);
  if (path === "/approval-links" && method === "GET") return json({ links });
  if (path.startsWith("/approval-links/") && method === "DELETE") {
    links = links.map((l) => (path.endsWith(l.id) ? { ...l, revokedAt: iso(0) } : l));
    return json({ ok: true });
  }
  if (path.startsWith("/a/")) return json(PUBLIC_APPROVAL);
  if (path === "/requests")
    return json({
      requests: [
        { id: "q1", clientId: "caleb", what: "Walkaround of the new Urus", dueDate: "2026-11-02", status: "created", trelloUrl: "https://trello.com/c/x", error: null, createdAt: iso(-DAY) },
        { id: "q2", clientId: "dudley", what: "Track day recap", dueDate: null, status: "failed", trelloUrl: null, error: "Trello answered 401, check the key.", createdAt: iso(-2 * DAY) },
        { id: "q3", clientId: "jacoby", what: "Spring sale teaser", dueDate: "2026-11-09", status: "created", trelloUrl: "https://trello.com/c/y", error: null, createdAt: iso(-3 * DAY) },
      ],
    });
  if (path === "/trello/intake-config") return json({ boardName: "Torone Editor Pipeline", listName: "To edit", boardId: null, listId: null, labelByBrand: {} });
  if (path === "/request-links") return json({ links: requestLinks });
  if (path.startsWith("/r/")) return json({ brandName: "Caleb", turnstileSiteKey: null, maxFileBytes: 10 * 1024 * 1024, fileTypes: ["image/png", "image/jpeg", "image/webp", "application/pdf"] });
  if (path.startsWith("/reports/monthly/") && path !== "/reports/monthly/preflight")
    return json({ id: "r1", brandId: "caleb", month: "2026-09", views: 212400, followersGained: 1380, posts: 18, topPostId: "p1", nextMonthPlan: ["M3 launch week", "Two walkarounds", "Price drop Friday"], sentAt: null });
  if (path === "/reports/job-config") return json({ runDay: 1, sender: "Toreronee@gmail.com", recipients: "all_client_profile_emails", killSwitch: false });
  if (path.startsWith("/insights/"))
    return json({
      insights: [
        { dedupeKey: "1", metric: "views", value: 48210, sources: ["instagram", "zernio"], chosenSource: "instagram", platform: "instagram" },
        { dedupeKey: "2", metric: "views", value: 31040, sources: ["tiktok"], chosenSource: "tiktok", platform: "tiktok" },
        { dedupeKey: "3", metric: "views", value: 79250, sources: ["toreroflow"], chosenSource: "toreroflow", platform: "total" },
        { dedupeKey: "4", metric: "likes", value: 3120, sources: ["instagram"], chosenSource: "instagram", platform: "instagram" },
        { dedupeKey: "5", metric: "likes", value: 2210, sources: ["tiktok", "zernio"], chosenSource: "tiktok", platform: "tiktok" },
        { dedupeKey: "6", metric: "likes", value: 5330, sources: ["toreroflow"], chosenSource: "toreroflow", platform: "total" },
      ],
      unavailable: [{ source: "zernio", reason: "the Analytics add-on is not on this Zernio plan" }],
    });
  if (path === "/failed-posts")
    return json({
      count: 3,
      items: [
        { postTargetId: "t1", brandId: "caleb", platform: "youtube", error: "Publishing failed due to max retries reached", reason: "YouTube did not take the upload", action: "retry", advice: "Retry now", scheduledAt: iso(-2 * DAY) },
        { postTargetId: "t3", brandId: "caleb", platform: "instagram", error: "OAuthException 190", reason: "The Instagram login expired", action: "reconnect", advice: "Reconnect Instagram, then retry", scheduledAt: iso(-DAY) },
        { postTargetId: "t2", brandId: "caleb", platform: "tiktok", error: "spam_risk_too_many_posts", reason: "TikTok paused uploads for today", action: "retry", advice: "Retry after 6 PM ET", scheduledAt: iso(-5 * DAY) },
      ],
    });
  if (/^\/failed-posts\/[^/]+\/retry$/.test(path)) return json({ outcome: "already_live" });
  if (/^\/failed-posts\/[^/]+\/dismiss$/.test(path)) return json({ dismissed: 1 });
  if (path === "/failed-posts/dismiss") return json({ dismissed: 2 });
  if (path === "/brand-kit/fonts") return json({ fonts: FONTS });
  if (/^\/brands\/[^/]+\/kit$/.test(path)) return json(kit);
  if (path === "/assets") return json({ assets: ASSETS });
  if (path === "/repurpose" && method === "POST") return json({ id: "job1", sourceVideoId: "v2", step: "cut", state: "running" }, 201);
  if (path.startsWith("/repurpose/")) return json({ id: "job1", sourceVideoId: "v2", step: "cut", state: "running" });
  if (path === "/sunra/settings") return json({ generationEnabled: false, connected: sunraOn });
  if (path === "/carousels/sunra/models") return json({ models: MODELS });
  if (path === "/sunra/carousel/quote")
    return json({ quoteId: "sq1", modelId: "nano-banana-2", slides: 5, creditsPerImage: 7, credits: 35, width: 1080, height: 1350, aspectRatio: "4:5", requiresApproval: true, expiresAt: iso(15 * 60_000) });
  if (path === "/alerts") return json({ alerts: [] });
  if (path === "/reports/unseen") return json({ message: null });
  return null;
}

// Run with VITE_API_URL= (empty) so the API is this origin and data: images
// survive fileUrl(); Vite's own requests still pass through.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (/^\/(src|node_modules|@)/.test(url.pathname)) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/health") return json({ status: "ok" });
  // Anything else gets an empty answer, so screens outside the ideas set stay quiet.
  return route(url.pathname, method) ?? json(method === "GET" ? [] : { ok: true });
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
