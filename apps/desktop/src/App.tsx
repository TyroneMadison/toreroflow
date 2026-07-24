import { useCallback, useEffect, useState } from "react";
import IconDefs from "./components/IconDefs";
import Sidebar from "./components/Sidebar";
import DashboardScreen from "./screens/DashboardScreen";
import UploadSchedule from "./screens/UploadSchedule";
import CalendarScreen from "./screens/CalendarScreen";
import AnalyticsScreen from "./screens/AnalyticsScreen";
import AccountsScreen from "./screens/AccountsScreen";
import WorkflowsScreen from "./screens/WorkflowsScreen";
import SettingsScreen from "./screens/SettingsScreen";
import AuthScreen from "./screens/AuthScreen";
import ConnectClientModal from "./modals/ConnectClientModal";
import ClientInsightsModal from "./modals/ClientInsightsModal";
import PreviewModal from "./modals/PreviewModal";
import { AppStateProvider, useAppState } from "./state/AppState";
import { applyTheme, loadTheme, type Theme } from "./lib/theme";

export type ScreenId =
  | "dashboard"
  | "upload"
  | "calendar"
  | "analytics"
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

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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

  return (
    <>
      <div className="app">
        <Sidebar
          activeScreen={activeScreen}
          onNavigate={setActiveScreen}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenConnect={openConnect}
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
          {activeScreen === "analytics" && <AnalyticsScreen key="analytics" />}
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
    <AppStateProvider>
      <div className="field">
        <div className="blob b1" />
        <div className="blob b2" />
      </div>
      <div className="grain" />
      <IconDefs />
      <Shell />
    </AppStateProvider>
  );
}
