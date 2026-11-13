/**
 * Dev-only Ideas demo: `vite` then open /?demo=coral (add &theme=light,
 * &run=single). Stubs fetch with placeholder data so the real Ideas
 * components render without an API or a login. main.tsx only loads this
 * behind import.meta.env.DEV, so production builds never contain it.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { ToastProvider } from "../components/Toasts";
import IdeasHome from "../editor/ideas/IdeasHome";
import { applyTheme } from "../lib/theme";
import { DEMO_CREATORS, DEMO_HOOKS, DEMO_REMIX, DEMO_RUN, DEMO_SAVED } from "./coralDemoData";

const params = new URLSearchParams(location.search);
applyTheme(params.get("theme") === "light" ? "light" : "dark");
const single = params.get("run") === "single";
// The app shell scrolls inside its own frame; the demo has no shell, so the page scrolls.
document.documentElement.style.overflow = "auto";
document.body.style.overflow = "visible";
document.documentElement.style.height = document.body.style.height = "auto";
document.body.style.padding = window.innerWidth <= 640 ? "12px" : "24px";

let saved = [...DEMO_SAVED];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (path.endsWith("/niche-profile")) return json({ nicheProfile: { niche: "Car rentals in Lakeview", audience: "", outcome: "", voiceTags: [], filming: [], faceless: false } });
  if (path.endsWith("/idea-creators")) return json({ creators: single ? [DEMO_CREATORS[2]] : DEMO_CREATORS, capCents: 200 });
  if (path.endsWith("/super-generate") && method === "GET") return json({ run: DEMO_RUN(single), youtubeReady: true, modelReady: true });
  if (/\/ideas\/[^/]+\/remix$/.test(path)) {
    await new Promise((r) => setTimeout(r, 300));
    return json({ clientId: "demo", variants: DEMO_REMIX });
  }
  if (path.endsWith("/clients/demo/ideas") && method === "GET") return json(saved);
  if (path.endsWith("/clients/demo/ideas") && method === "POST") return json({ id: `n${Date.now()}` }, 201);
  if (/\/ideas\/[^/]+$/.test(path) && method === "DELETE") {
    saved = saved.filter((i) => !path.endsWith(`/${i.id}`));
    return json({ ok: true });
  }
  if (/\/ideas\/[^/]+$/.test(path) && method === "PATCH") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { completed?: boolean };
    saved = saved.map((i) => (path.endsWith(`/${i.id}`) ? { ...i, ...body } : i));
    return json({ ok: true });
  }
  if (path.includes("/idea-feedback")) return json({ ok: true });
  if (path.endsWith("/clients/demo/hooks")) {
    const p = url.searchParams;
    const q = (p.get("q") ?? "").toLowerCase();
    const hooks = DEMO_HOOKS.filter((h) =>
      (!p.get("source") || h.sourceType === p.get("source")) &&
      (!p.get("stage") || h.funnelStage === p.get("stage")) &&
      (!p.get("format") || h.format === p.get("format")) &&
      (!q || `${h.text} ${h.reworded ?? ""}`.toLowerCase().includes(q)));
    return json({ hooks, total: DEMO_HOOKS.length });
  }
  if (path.endsWith("/hooks/refresh")) return json({ own: 0, web: 0, creator: 0, webStatus: "skipped" });
  if (/\/hooks\/[^/]+\/use$/.test(path)) {
    const h = DEMO_HOOKS.find((x) => path.includes(`/hooks/${x.id}/`))!;
    const line = h.reworded || h.text;
    saved = [{ ...saved[0]!, id: `u${Date.now()}`, source: "custom", text: line, hook: line, formatName: h.format, funnelStage: h.funnelStage, creator: h.sourceAccount ?? "", scriptText: "", whyItWorks: "", needs: [], gifs: [], completed: false }, ...saved];
    return json({ id: saved[0]!.id }, 201);
  }
  if (path.includes("/idea-gifs/")) return realFetch(input, init);
  return json({ error: "not in the demo" }, 404);
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <IdeasHome clientId="demo" />
    </ToastProvider>
  </React.StrictMode>,
);
