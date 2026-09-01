import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, loadTheme } from "./lib/theme";
import "./styles.css";

// Apply persisted theme before first paint to avoid a flash of the wrong theme.
applyTheme(loadTheme());

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
 */
const tokenMatch = /[#&]token=([^&]+)/.exec(window.location.hash);
if (tokenMatch) {
  localStorage.setItem("toreroflow-token", decodeURIComponent(tokenMatch[1]!));
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
