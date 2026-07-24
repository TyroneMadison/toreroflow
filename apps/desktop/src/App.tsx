import { useCallback, useEffect, useState } from "react";
import IconDefs from "./components/IconDefs";
import Sidebar from "./components/Sidebar";
import UploadSchedule from "./screens/UploadSchedule";
import CalendarScreen from "./screens/CalendarScreen";
import AnalyticsScreen from "./screens/AnalyticsScreen";
import AccountsScreen from "./screens/AccountsScreen";
import ConnectClientModal from "./modals/ConnectClientModal";
import ComposerModal from "./modals/ComposerModal";
import { applyTheme, loadTheme, type Theme } from "./lib/theme";

export type ScreenId = "upload" | "calendar" | "analytics" | "accounts";
export type ModalId = "connect" | "composer" | null;

export default function App() {
  const [activeScreen, setActiveScreen] = useState<ScreenId>("upload");
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [openModal, setOpenModal] = useState<ModalId>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "light" ? "dark" : "light"));
  }, []);

  const openConnect = useCallback(() => setOpenModal("connect"), []);
  const openComposer = useCallback(() => setOpenModal("composer"), []);
  const closeModal = useCallback(() => setOpenModal(null), []);

  return (
    <>
      <div className="field">
        <div className="blob b1" />
        <div className="blob b2" />
      </div>
      <div className="grain" />
      <IconDefs />

      <div className="app">
        <Sidebar
          activeScreen={activeScreen}
          onNavigate={setActiveScreen}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <main className="main glass">
          {activeScreen === "upload" && (
            <UploadSchedule key="upload" onOpenComposer={openComposer} />
          )}
          {activeScreen === "calendar" && (
            <CalendarScreen key="calendar" onOpenComposer={openComposer} />
          )}
          {activeScreen === "analytics" && <AnalyticsScreen key="analytics" />}
          {activeScreen === "accounts" && (
            <AccountsScreen key="accounts" onOpenConnect={openConnect} />
          )}
        </main>
      </div>

      {openModal === "connect" && <ConnectClientModal onClose={closeModal} />}
      {openModal === "composer" && <ComposerModal onClose={closeModal} />}
    </>
  );
}
