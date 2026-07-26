import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError } from "../lib/api";

export type ToastKind = "error" | "success" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Repeats collapse into one row with a count rather than stacking. */
  count: number;
}

interface ToastApi {
  error(message: string): void;
  success(message: string): void;
  info(message: string): void;
  /** Reports a caught value, turning API errors into something readable. */
  fail(what: string, error: unknown): void;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** How long a toast stays up. Errors linger; confirmations get out of the way. */
const LIFETIME: Record<ToastKind, number> = {
  error: 8000,
  success: 3500,
  info: 5000,
};

const MAX_VISIBLE = 4;

/**
 * Turns whatever was thrown into a sentence worth showing an operator.
 *
 * A failed fetch surfaces as a bare "Failed to fetch", which tells the
 * operator nothing actionable, so the common causes are named instead.
 */
export function describeError(what: string, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return `${what}: your session expired, sign in again.`;
    if (error.status === 503) return `${what}: ${error.message}`;
    return `${what}: ${error.message}`;
  }
  if (error instanceof TypeError) {
    return `${what}: the API is not reachable. Check that it is running.`;
  }
  if (error instanceof Error && error.message) return `${what}: ${error.message}`;
  return `${what}.`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      setToasts((list) => {
        // The same failure firing repeatedly (a poll that keeps missing) should
        // read as one problem, not a wall of identical rows.
        const same = list.find((t) => t.kind === kind && t.message === message);
        if (same) {
          return list.map((t) => (t.id === same.id ? { ...t, count: t.count + 1 } : t));
        }
        const id = nextId.current++;
        const timer = setTimeout(() => dismiss(id), LIFETIME[kind]);
        timers.current.set(id, timer);
        return [...list, { id, kind, message, count: 1 }].slice(-MAX_VISIBLE);
      });
    },
    [dismiss],
  );

  // Clear pending timers if the app unmounts mid-toast.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const value = useMemo<ToastApi>(
    () => ({
      error: (m) => push("error", m),
      success: (m) => push("success", m),
      info: (m) => push("info", m),
      fail: (what, error) => push("error", describeError(what, error)),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.kind}`}
            role={t.kind === "error" ? "alert" : "status"}
          >
            <span className="tdot" />
            <span className="tmsg">{t.message}</span>
            {t.count > 1 && <span className="tcount">{t.count}</span>}
            <button className="tclose" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <svg>
                <use href="#i-x" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Toasts for the current screen.
 *
 * Safe to call outside the provider: it degrades to console logging rather
 * than throwing, so a screen rendered in isolation never crashes on it.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  return (
    ctx ?? {
      error: (m) => console.error(m),
      success: (m) => console.info(m),
      info: (m) => console.info(m),
      fail: (what, error) => console.error(describeError(what, error)),
      dismiss: () => {},
    }
  );
}
