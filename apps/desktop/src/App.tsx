import { useCallback, useEffect, useState } from "react";
import IconDefs from "./components/IconDefs";
import Sidebar from "./components/Sidebar";
import DashboardScreen from "./screens/DashboardScreen";
import UploadSchedule from "./screens/UploadSchedule";
import CalendarScreen from "./screens/CalendarScreen";
import AnalyticsScreen from "./screens/AnalyticsScreen";
import ReportsScreen from "./screens/ReportsScreen";
import AccountsScreen from "./screens/AccountsScreen";
import WorkflowsScreen from "./screens/WorkflowsScreen";
import SettingsScreen from "./screens/SettingsScreen";
import AuthScreen from "./screens/AuthScreen";
import ConnectClientModal from "./modals/ConnectClientModal";
import ClientInsightsModal from "./modals/ClientInsightsModal";
import PreviewModal from "./modals/PreviewModal";
import { ToastProvider } from "./components/Toasts";
import { AppStateProvider, useAppState } from "./state/AppState";
import { api, type AlertsResponse, type SystemAlert } from "./lib/api";
import { applyTheme, loadTheme, type Theme } from "./lib/theme";

export type ScreenId =
  | "dashboard"
  | "upload"
  | "calendar"
  | "analytics"
  | "reports"
  | "accounts"
  | "workflows"
  | "settings";

type ModalState =
  | { kind: "connect" }
  | { kind: "insights"; clientId: string }
  | { kind: "preview"; name: string; url: string }
  | null;

function Shell() {
  const { authReady, user } = useAppState();
  const [activeScreen, setActiveScreen] = useState<ScreenId>("dashboard");
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
    return null;
  }

  if (!user) {
    return <AuthScreen />;
  }

  // Dismissing hides a problem from the sidebar count without deleting it, so
  // it can come back loudly if it happens again.
  const visibleAlerts = alerts.filter((a) => !a.dismissed);

  return (
    <>
      <div className="app">
        <Sidebar
          activeScreen={activeScreen}
          onNavigate={setActiveScreen}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenConnect={openConnect}
          reportNotice={reportNotice}
          alertCount={visibleAlerts.length}
          alertIsError={visibleAlerts.some((a) => a.severity === "error")}
        />
        <main className="main glass">
          {activeScreen === "dashboard" && (
            <DashboardScreen
              key="dashboard"
              onOpenInsights={openInsights}
              onOpenConnect={openConnect}
            />
          )}
          {activeScreen === "upload" && (
            <UploadSchedule key="upload" onPreview={openPreview} onOpenConnect={openConnect} />
          )}
          {activeScreen === "calendar" && (
            <CalendarScreen key="calendar" onNewPost={() => setActiveScreen("upload")} />
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
          {activeScreen === "accounts" && (
            <AccountsScreen
              key="accounts"
              onOpenConnect={openConnect}
              onOpenInsights={openInsights}
            />
          )}
          {activeScreen === "workflows" && <WorkflowsScreen key="workflows" />}
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
        <div className="field">
          <div className="blob b1" />
          <div className="blob b2" />
        </div>
        <div className="grain" />
        <IconDefs />
        <Shell />
      </AppStateProvider>
    </ToastProvider>
  );
}
