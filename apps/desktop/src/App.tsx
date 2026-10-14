import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import IconDefs from "./components/IconDefs";
import GlassFilter from "./components/GlassFilter";
import Dock from "./components/Dock";
import PageHeader from "./components/PageHeader";
import DashboardScreen from "./screens/DashboardScreen";
import UploadSchedule from "./screens/UploadSchedule";
import EditScreen from "./screens/EditScreen";
import CalendarScreen from "./screens/CalendarScreen";
import AnalyticsScreen from "./screens/AnalyticsScreen";
import ReportsScreen from "./screens/ReportsScreen";
import AccountOverviewScreen from "./screens/AccountOverviewScreen";
import FinancialsScreen from "./screens/FinancialsScreen";
import CarouselsScreen from "./screens/CarouselsScreen";
import WorkflowsScreen from "./screens/WorkflowsScreen";
import SettingsScreen from "./screens/SettingsScreen";
import ReadyQueueScreen from "./screens/ReadyQueueScreen";
import ScheduleScreen from "./screens/ScheduleScreen";
import AuthScreen from "./screens/AuthScreen";
import ConnectClientModal from "./modals/ConnectClientModal";
import ClientInsightsModal from "./modals/ClientInsightsModal";
import PreviewModal from "./modals/PreviewModal";
import { ToastProvider } from "./components/Toasts";
import { AppStateProvider, useAppState } from "./state/AppState";
import AlertDock from "./components/AlertDock";
import UpdateBanner from "./components/UpdateBanner";
import { useApiStatus } from "./components/ApiStatus";
import { api, getActivity, subscribeActivity, type AlertsResponse, type SystemAlert } from "./lib/api";
import { buildAgentState, publishAgentState } from "./lib/agentState";
import { navigate, pathFor, useRoute } from "./lib/routes";
import { applyTheme, loadTheme, type Theme } from "./lib/theme";

// The screen list lives in lib/nav.ts beside the section map; re-exported
// here for the files that already import it from App.
export type { ScreenId } from "./lib/nav";

type ModalState =
  | { kind: "connect" }
  | { kind: "insights"; clientId: string }
  | { kind: "preview"; name: string; url: string }
  | null;

/** Publishes the agent-readable state. Renders nothing, so the busy flag
 *  flipping on every request re-renders only this. */
function AgentStateSync({ apiUp }: { apiUp: boolean }) {
  const { screen, section, range } = useRoute();
  const { user, selectedClient } = useAppState();
  const { busy, lastError } = useSyncExternalStore(subscribeActivity, getActivity);
  const clientId = selectedClient?.id ?? null;
  const clientName = selectedClient?.name ?? null;
  const role = user?.role ?? null;
  useEffect(() => {
    const route = pathFor(screen, section);
    publishAgentState(
      buildAgentState({ route, screen, section, clientId, clientName, range, apiUp, busy, role, lastError }),
    );
  }, [screen, section, clientId, clientName, range, apiUp, busy, role, lastError]);
  return null;
}

function Shell() {
  const { authReady, user, selectedClientId } = useAppState();
  // The URL decides the screen (lib/routes.ts); the dock and tabs are links.
  const activeScreen = useRoute().screen;
  const apiStatus = useApiStatus();
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [modal, setModal] = useState<ModalState>(null);
  const [reportNotice, setReportNotice] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  /**
   * Month-end report notification.
   *
   * The API only counts reports for a month that has actually finished, so
   * building one ad hoc mid-month never lights the bell. Polled hourly
   * because the thing being waited on changes once a month.
   */
  const refreshReportNotice = useCallback(() => {
    void api
      .get<{ message: string | null }>("/reports/unseen")
      .then((r) => setReportNotice(r.message))
      .catch(() => setReportNotice(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshReportNotice();
    const t = setInterval(refreshReportNotice, 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [user, refreshReportNotice]);

  /**
   * Background failures.
   *
   * Polled every couple of minutes rather than hourly like the report bell,
   * because this answers "is something broken right now" and the app is
   * usually opened straight after something went wrong. Failures that
   * happened while the app was closed are waiting here on the next poll,
   * which is the whole point of storing them.
   */
  const refreshAlerts = useCallback(() => {
    void api
      .get<AlertsResponse>("/alerts")
      .then((r) => setAlerts(r.alerts))
      .catch(() => {
        // The API being unreachable already shows in the sidebar; adding a
        // second alarm for it would be noise.
      });
  }, []);

  useEffect(() => {
    if (!user) return;
    refreshAlerts();
    const t = setInterval(refreshAlerts, 2 * 60 * 1000);
    return () => clearInterval(t);
  }, [user, refreshAlerts]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "light" ? "dark" : "light"));
  }, []);

  const openConnect = useCallback(() => setModal({ kind: "connect" }), []);
  const openInsights = useCallback(
    (clientId: string) => setModal({ kind: "insights", clientId }),
    [],
  );
  const openPreview = useCallback(
    (name: string, url: string) => setModal({ kind: "preview", name, url }),
    [],
  );
  const closeModal = useCallback(() => setModal(null), []);

  if (!authReady) {
    return <AgentStateSync apiUp={apiStatus.online} />;
  }

  if (!user) {
    return (
      <>
        <AgentStateSync apiUp={apiStatus.online} />
        <AuthScreen />
      </>
    );
  }

  // Dismissing hides a problem from the sidebar count without deleting it, so
  // it can come back loudly if it happens again.
  const visibleAlerts = alerts.filter((a) => !a.dismissed);

  return (
    <>
      <AgentStateSync apiUp={apiStatus.online} />
      <UpdateBanner />
      <AlertDock alerts={alerts} onChanged={refreshAlerts} />
      <div className="app">
        <Dock
          activeScreen={activeScreen}
          api={apiStatus}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenConnect={openConnect}
          reportNotice={reportNotice}
          alertCount={visibleAlerts.length}
          alertIsError={visibleAlerts.some((a) => a.severity === "error")}
        />
        <main className="main">
          {/* The Dashboard draws its own header with its controls; the screens
              not yet restyled get the shared one above their old topbar. */}
          {activeScreen !== "dashboard" && activeScreen !== "analytics" && (
            <PageHeader screen={activeScreen} />
          )}
          {activeScreen === "dashboard" && (
            <DashboardScreen key="dashboard" onOpenInsights={openInsights} onOpenConnect={openConnect} />
          )}
          {activeScreen === "upload" && (
            <UploadSchedule
              key={`upload-${selectedClientId ?? "none"}`}
              onPreview={openPreview}
              onOpenConnect={openConnect}
            />
          )}
          {activeScreen === "edit" && (
            <EditScreen key={`edit-${selectedClientId ?? "none"}`} />
          )}
          {activeScreen === "calendar" && (
            <CalendarScreen
              key={`calendar-${selectedClientId ?? "none"}`}
              onNewPost={() => navigate("upload")}
            />
          )}
          {activeScreen === "analytics" && (
            <AnalyticsScreen key="analytics" onOpenConnect={openConnect} />
          )}
          {activeScreen === "reports" && (
            <ReportsScreen
              key="reports"
              onSeen={refreshReportNotice}
              alerts={alerts}
              onAlertsChanged={refreshAlerts}
            />
          )}
          {activeScreen === "overview" && (
            <AccountOverviewScreen
              key="overview"
              onOpenConnect={openConnect}
              onOpenInsights={openInsights}
            />
          )}
          {activeScreen === "financials" && <FinancialsScreen key="financials" />}
          {activeScreen === "carousels" && (
            <CarouselsScreen
              key={`carousels-${selectedClientId ?? "none"}`}
              onUploadImages={() => navigate("upload")}
            />
          )}
          {activeScreen === "workflows" && (
            <WorkflowsScreen key={`workflows-${selectedClientId ?? "none"}`} />
          )}
          {activeScreen === "ready" && <ReadyQueueScreen key="ready" />}
          {activeScreen === "schedule" && <ScheduleScreen key="schedule" />}
          {activeScreen === "settings" && (
            <SettingsScreen key="settings" onOpenConnect={openConnect} />
          )}
        </main>
      </div>

      {modal?.kind === "connect" && <ConnectClientModal onClose={closeModal} />}
      {modal?.kind === "insights" && (
        <ClientInsightsModal clientId={modal.clientId} onClose={closeModal} />
      )}
      {modal?.kind === "preview" && (
        <PreviewModal name={modal.name} url={modal.url} onClose={closeModal} />
      )}
    </>
  );
}

export default function App() {
  return (
    // Toasts wrap the state provider so a failure raised while the app is
    // still loading its own data still has somewhere to surface.
    <ToastProvider>
      <AppStateProvider>
        <div className="tf-bg" aria-hidden="true" />
        <div className="tf-vig" aria-hidden="true" />
        <IconDefs />
        <GlassFilter />
        <Shell />
      </AppStateProvider>
    </ToastProvider>
  );
}
