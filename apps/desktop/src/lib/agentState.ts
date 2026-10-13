import { pageOf, type ScreenId } from "./nav";
import type { Range, SettingsSection } from "./routes";

/*
 * What an agent driving the app can read without parsing the page: html
 * data-* attributes, a frozen snapshot on window.__TOREROFLOW_STATE__ and a
 * toreroflow:state event on every change. See docs/agent-state.md.
 *
 * Built field by field from an allow-list, never by spreading app state, so a
 * token or a secret cannot end up in it by someone adding a field elsewhere.
 */

export interface AgentState {
  version: 1;
  route: string;
  /** The page slug from lib/nav.ts, e.g. "upload" or "account-overview". */
  screen: string;
  section: SettingsSection | null;
  clientId: string | null;
  clientName: string | null;
  range: Range | null;
  apiUp: boolean;
  busy: boolean;
  user: { role: string } | null;
  lastError: string | null;
}

export interface AgentStateInput {
  route: string;
  screen: ScreenId;
  section: SettingsSection | null;
  clientId: string | null;
  clientName: string | null;
  range: Range | null;
  apiUp: boolean;
  busy: boolean;
  role: string | null;
  lastError: string | null;
}

export function buildAgentState(i: AgentStateInput): Readonly<AgentState> {
  return Object.freeze({
    version: 1,
    route: i.route,
    screen: pageOf(i.screen).slug,
    section: i.section,
    clientId: i.clientId,
    clientName: i.clientName,
    range: i.range,
    apiUp: i.apiUp,
    busy: i.busy,
    user: i.role ? Object.freeze({ role: i.role }) : null,
    lastError: i.lastError,
  });
}

export function publishAgentState(s: Readonly<AgentState>): void {
  const html = document.documentElement;
  const attrs: Record<string, string | null> = {
    "data-screen": s.screen,
    "data-section": s.section,
    "data-client": s.clientId,
    "data-range": s.range == null ? null : String(s.range),
    "data-api": s.apiUp ? "up" : "down",
    "data-busy": String(s.busy),
  };
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) html.removeAttribute(k);
    else html.setAttribute(k, v);
  }
  // Read-only to page scripts: not writable, only this function redefines it.
  Object.defineProperty(window, "__TOREROFLOW_STATE__", { value: s, configurable: true, enumerable: true, writable: false });
  window.dispatchEvent(new CustomEvent("toreroflow:state", { detail: s }));
}
