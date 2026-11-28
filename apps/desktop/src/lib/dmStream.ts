import { useEffect, useRef, useState } from "react";
import { api, API_URL } from "./api";
import { reconnectDelay, type DmLiveEvent, type LiveState } from "./inbox";

/**
 * The Inbox's live stream (H1): one EventSource for the brand on screen.
 *
 * EventSource cannot send our Authorization header, so each connect first
 * asks for a one-use, 60 second ticket. Any error (a dropped connection, the
 * server restarting, a 503 while its database listener is down) closes the
 * stream and reconnects with a fresh ticket after a backoff; meanwhile the
 * Inbox polls (pollEvery). Each successful (re)connect calls onEvent("resync"):
 * whatever happened while it was down is reread rather than replayed.
 *
 * "off": no brand, no EventSource in this webview. An older server that has
 * no stream route stays "reconnecting" and keeps backing off to 30 seconds.
 */
export function useDmStream(clientId: string | null, onEvent: (e: DmLiveEvent | "resync") => void): LiveState {
  const [state, setState] = useState<LiveState>("off");
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    if (!clientId || typeof EventSource === "undefined") {
      setState("off");
      return;
    }
    let es: EventSource | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let stopped = false;

    const retry = () => {
      if (stopped) return;
      setState("reconnecting");
      timer = window.setTimeout(() => void connect(), reconnectDelay(attempt++));
    };
    const connect = async () => {
      if (stopped) return;
      let ticket: string;
      try {
        ticket = (await api.post<{ ticket: string }>(`/clients/${clientId}/dm/stream-ticket`)).ticket;
      } catch {
        return retry();
      }
      if (stopped) return;
      es = new EventSource(`${API_URL}/clients/${clientId}/dm/stream?ticket=${encodeURIComponent(ticket)}`);
      es.addEventListener("ready", () => {
        attempt = 0;
        setState("live");
        cb.current("resync");
      });
      es.addEventListener("dm", (m) => {
        try {
          cb.current(JSON.parse((m as MessageEvent<string>).data) as DmLiveEvent);
        } catch {
          // A garbled event: the next one, or the poll, catches up.
        }
      });
      // The ticket is spent, so EventSource's own retry would only be refused: start over.
      es.onerror = () => {
        es?.close();
        es = null;
        retry();
      };
    };

    setState("connecting");
    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      es?.close();
    };
  }, [clientId]);

  return state;
}
