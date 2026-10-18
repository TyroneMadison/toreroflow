import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { normalizeUrl, scrubToken } from "./lib/routes";
import { applyTheme, initAutomation, loadTheme } from "./lib/theme";
import { applyGlassLevel, loadGlassLevel } from "./lib/glass";
import { markShell } from "./lib/windowGlass";
// Tokens first so styles.css can point its old variables at them; frame.css
// last so the dock layout wins over the old sidebar one.
import "./styles/tokens.css";
import "./styles.css";
import "./styles/frame.css";
import "./styles/liquid.css";
import "./styles/glass-pages.css";
import "./styles/solid.css";

// Apply persisted theme before first paint to avoid a flash of the wrong theme.
applyTheme(loadTheme());
initAutomation();
markShell();
applyGlassLevel(loadGlassLevel());

/*
 * Web-hosted sign-in for automations: #token=... in the URL becomes the
 * session, then leaves the address bar.
 *
 * A bot driving the app in a browser has no way to answer the login screen
 * without holding the operator's password, which is exactly what a scoped bot
 * token exists to avoid. So the token rides the URL fragment once: fragments
 * never reach the server or its logs, and it is scrubbed immediately so it is
 * not left sitting in the location bar, a screenshot, or browser history.
 * Harmless in the desktop shell, where nothing ever navigates with a fragment.
 *
 * Runs before the router, on any path: /create/upload#token=... signs in and
 * opens Upload. routes.check.ts covers it.
 */
const scrubbed = scrubToken(window.location.href);
if (scrubbed) {
  localStorage.setItem("toreroflow-token", scrubbed.token);
  history.replaceState(null, "", scrubbed.url);
}
// "/" and unknown paths become /dashboard, without a history entry.
normalizeUrl();

// Dev-only placeholder demo of the Ideas area (src/demo). import.meta.env.DEV
// is false in production builds, so this branch and its chunk are dropped.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("demo") === "coral") {
  void import("./demo/coralDemo");
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
