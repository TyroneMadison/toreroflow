import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  clearToken,
  getToken,
  setToken,
  type AuthUser,
  type ClientSummary,
  type LoginResponse,
  setUnauthorizedHandler,
} from "../lib/api";

const SELECTED_KEY = "toreroflow-selected-client";

interface AppStateValue {
  authReady: boolean;
  user: AuthUser | null;
  needsSetup: boolean;
  apiDown: boolean;
  login(email: string, password: string): Promise<void>;
  register(agencyName: string, email: string, password: string): Promise<void>;
  logout(): void;

  clients: ClientSummary[];
  refreshClients(): Promise<void>;
  selectedClientId: string | null;
  selectedClient: ClientSummary | null;
  selectClient(id: string | null): void;

  /**
   * The carousel draft (from Create > Carousels) whose finished images are
   * about to be uploaded. Set by that screen's "Upload the images" button and
   * consumed once by Upload and Schedule, which attaches the draft's caption
   * and hashtags to the uploaded carousel so nothing gets retyped.
   */
  pendingCarouselDraft: { id: string; topic: string } | null;
  setPendingCarouselDraft(draft: { id: string; topic: string } | null): void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (!value) throw new Error("useAppState outside provider");
  return value;
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [apiDown, setApiDown] = useState(false);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(
    () => localStorage.getItem(SELECTED_KEY),
  );

  const refreshClients = useCallback(async () => {
    const list = await api.get<ClientSummary[]>("/clients");
    setClients(list);
  }, []);

  /*
   * A 401 from any request ends the session here, not just at boot.
   *
   * The token has already been cleared by the api layer; this is what makes
   * the app notice. Without it an expiry mid-session left the operator on a
   * screen whose data would never arrive, with no way to tell that from an
   * empty calendar.
   */
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setClients([]);
    });
  }, []);

  // Boot: restore session if a token exists, else ask whether this is first run.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (getToken()) {
          try {
            const me = await api.get<AuthUser>("/auth/me");
            if (cancelled) return;
            setUser(me);
            await refreshClients();
          } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
              clearToken();
              const boot = await api.get<{ needsSetup: boolean }>("/auth/bootstrap");
              if (!cancelled) setNeedsSetup(boot.needsSetup);
            } else {
              throw error;
            }
          }
        } else {
          const boot = await api.get<{ needsSetup: boolean }>("/auth/bootstrap");
          if (!cancelled) setNeedsSetup(boot.needsSetup);
        }
      } catch {
        if (!cancelled) setApiDown(true);
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshClients]);

  // Keep a brand selected whenever brands exist. A missing or stale
  // selection falls back to the first brand instead of leaving every
  // client-scoped screen empty. The empty list is left alone on purpose:
  // at boot the list is empty while it loads, and clearing then would wipe
  // a valid stored selection.
  useEffect(() => {
    if (!clients.length) return;
    if (selectedClientId && clients.some((c) => c.id === selectedClientId)) return;
    const id = clients[0].id;
    setSelectedClientId(id);
    localStorage.setItem(SELECTED_KEY, id);
  }, [clients, selectedClientId]);

  const finishAuth = useCallback(
    async (response: LoginResponse) => {
      setToken(response.token);
      setUser(response.user);
      setNeedsSetup(false);
      await refreshClients();
    },
    [refreshClients],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const response = await api.post<LoginResponse>("/auth/login", { email, password });
      await finishAuth(response);
    },
    [finishAuth],
  );

  const register = useCallback(
    async (agencyName: string, email: string, password: string) => {
      const response = await api.post<LoginResponse>("/auth/register", {
        agencyName,
        email,
        password,
      });
      await finishAuth(response);
    },
    [finishAuth],
  );

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setClients([]);
  }, []);

  const selectClient = useCallback((id: string | null) => {
    setSelectedClientId(id);
    if (id) localStorage.setItem(SELECTED_KEY, id);
    else localStorage.removeItem(SELECTED_KEY);
  }, []);

  const selectedClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId) ?? null,
    [clients, selectedClientId],
  );

  const [pendingCarouselDraft, setPendingCarouselDraft] = useState<{
    id: string;
    topic: string;
  } | null>(null);

  const value = useMemo<AppStateValue>(
    () => ({
      authReady,
      user,
      needsSetup,
      apiDown,
      login,
      register,
      logout,
      clients,
      refreshClients,
      selectedClientId,
      selectedClient,
      selectClient,
      pendingCarouselDraft,
      setPendingCarouselDraft,
    }),
    [
      authReady,
      user,
      needsSetup,
      apiDown,
      login,
      register,
      logout,
      clients,
      refreshClients,
      selectedClientId,
      selectedClient,
      selectClient,
      pendingCarouselDraft,
    ],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}
