import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "./stores/useStore";
import { useWebSocket } from "./hooks/useWebSocket";
import { api } from "./lib/api";
import { Sidebar } from "./components/Sidebar";
import { ProjectHome } from "./components/ProjectHome";
import { ThemeToggle } from "./components/ThemeToggle";
import { LanguageToggle } from "./components/LanguageToggle";
import { CommandPalette, CMD_EVENTS } from "./components/CommandPalette";
import { KeyboardShortcuts } from "./components/KeyboardShortcuts";
import { NotificationPanel } from "./components/NotificationPanel";
import { GettingStarted } from "./components/GettingStarted";
import { RateLimitBanner } from "./components/RateLimitBanner";
import { StatusBar } from "./components/StatusBar";
import { useNotifications } from "./stores/useNotifications";
import { ToastContainer } from "./components/Toast";

function App() {
  const { t, i18n } = useTranslation();
  const { setProjects, setCurrentProject, connected } = useStore();
  const currentProjectId = useStore((s) => s.currentProjectId);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [serverUp, setServerUp] = useState(true);
  const { notifications } = useNotifications();

  useWebSocket();

  // currentProject가 변경되면 가이드 닫기
  useEffect(() => {
    if (currentProjectId) setShowGuide(false);
  }, [currentProjectId]);

  // Listen for server status changes
  useEffect(() => {
    const handler = (e: Event) => {
      setServerUp((e as CustomEvent).detail.up);
    };
    const guideHandler = () => setShowGuide(true);
    const closeGuideHandler = () => setShowGuide(false);
    window.addEventListener("crewdeck:server-status", handler);
    window.addEventListener("crewdeck:show-guide", guideHandler);
    window.addEventListener("crewdeck:close-guide", closeGuideHandler);
    return () => {
      window.removeEventListener("crewdeck:server-status", handler);
      window.removeEventListener("crewdeck:show-guide", guideHandler);
      window.removeEventListener("crewdeck:close-guide", closeGuideHandler);
    };
  }, []);

  // Load projects on mount
  useEffect(() => {
    api.projects.list().then((projects) => {
      setProjects(projects);
      if (projects.length > 0) {
        const saved = localStorage.getItem("crewdeck-current-project");
        const found = saved ? projects.find((p) => p.id === saved) : null;
        setCurrentProject(found ? found.id : projects[0].id);
      }
    });
  }, [setProjects, setCurrentProject]);

  // Listen for refresh events from WebSocket
  useEffect(() => {
    const handler = () => {
      api.projects.list().then(setProjects);
    };
    window.addEventListener("crewdeck:refresh", handler);
    return () => window.removeEventListener("crewdeck:refresh", handler);
  }, [setProjects]);

  // ? key opens keyboard shortcuts help
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "?") setShowShortcuts(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // CommandPalette action handlers
  useEffect(() => {
    const onNewProject = () => {
      // Delegate to Sidebar which owns the NewProjectDialog
      window.dispatchEvent(new CustomEvent("crewdeck:open-new-project"));
    };

    const onImportLocal = () => {
      // Delegate to Sidebar which owns the import dialog
      window.dispatchEvent(new CustomEvent("crewdeck:open-import"));
    };

    const onConnectGitHub = () => {
      // Dispatch a sidebar-level event; Sidebar handles GitHub connection
      window.dispatchEvent(new CustomEvent("crewdeck:connect-github"));
    };

    const onAddAgent = () => {
      window.dispatchEvent(new CustomEvent("crewdeck:add-agent"));
    };

    const onAddGoal = () => {
      window.dispatchEvent(new CustomEvent("crewdeck:add-goal"));
    };

    const onSwitchTheme = () => {
      const root = document.documentElement;
      const isDark = root.classList.contains("dark");
      if (isDark) {
        root.classList.remove("dark");
        root.classList.add("light");
        localStorage.setItem("crewdeck-theme", "light");
      } else {
        root.classList.add("dark");
        root.classList.remove("light");
        localStorage.setItem("crewdeck-theme", "dark");
      }
    };

    const onSwitchLang = () => {
      const current = i18n.language.startsWith("ko") ? "ko" : "en";
      const next = current === "en" ? "ko" : "en";
      i18n.changeLanguage(next);
      localStorage.setItem("crewdeck-lang", next);
    };

    const onGoTab = (e: Event) => {
      const detail = (e as CustomEvent<{ tab: string }>).detail;
      window.dispatchEvent(new CustomEvent("crewdeck:go-tab", { detail }));
    };

    window.addEventListener(CMD_EVENTS.NEW_PROJECT, onNewProject);
    window.addEventListener(CMD_EVENTS.IMPORT_LOCAL, onImportLocal);
    window.addEventListener(CMD_EVENTS.CONNECT_GITHUB, onConnectGitHub);
    window.addEventListener(CMD_EVENTS.ADD_AGENT, onAddAgent);
    window.addEventListener(CMD_EVENTS.ADD_GOAL, onAddGoal);
    window.addEventListener(CMD_EVENTS.SWITCH_THEME, onSwitchTheme);
    window.addEventListener(CMD_EVENTS.SWITCH_LANG, onSwitchLang);
    window.addEventListener(CMD_EVENTS.GO_TAB, onGoTab);

    return () => {
      window.removeEventListener(CMD_EVENTS.NEW_PROJECT, onNewProject);
      window.removeEventListener(CMD_EVENTS.IMPORT_LOCAL, onImportLocal);
      window.removeEventListener(CMD_EVENTS.CONNECT_GITHUB, onConnectGitHub);
      window.removeEventListener(CMD_EVENTS.ADD_AGENT, onAddAgent);
      window.removeEventListener(CMD_EVENTS.ADD_GOAL, onAddGoal);
      window.removeEventListener(CMD_EVENTS.SWITCH_THEME, onSwitchTheme);
      window.removeEventListener(CMD_EVENTS.SWITCH_LANG, onSwitchLang);
      window.removeEventListener(CMD_EVENTS.GO_TAB, onGoTab);
    };
  }, [i18n]);

  return (
    <div className="flex h-screen bg-canvas">
      {showShortcuts && <KeyboardShortcuts onClose={() => setShowShortcuts(false)} />}
      {showNotifications && (
        <NotificationPanel onClose={() => setShowNotifications(false)} />
      )}
      <CommandPalette />
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Server down banner */}
        {!serverUp && (
          <div className="bg-red-500 text-white text-center text-sm py-2 px-4 shrink-0">
            {t("serverDown")}
          </div>
        )}
        {/* Rate limit warning */}
        <RateLimitBanner />
        {/* Top bar */}
        <header className="h-10 border-b border-line flex items-center justify-between px-4 shrink-0 bg-canvas">
          <div className="min-w-0 flex-1 overflow-x-auto no-scrollbar">
            <StatusBar />
          </div>
          <div className="flex items-center gap-3 shrink-0 pl-3">
            <LanguageToggle />
            <ThemeToggle />

            {/* Bell button */}
            <button
              onClick={() => setShowNotifications((v) => !v)}
              className="relative w-7 h-7 flex items-center justify-center rounded hover:bg-fg/5 text-faint transition-colors"
              aria-label={t("notificationBell")}
              title={t("notificationBell")}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {notifications.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5 leading-none">
                  {notifications.length > 9 ? "9+" : notifications.length}
                </span>
              )}
            </button>

            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  connected ? "bg-green-400" : "bg-red-400"
                }`}
              />
              <span className="text-[10px] text-faint">
                {connected ? t("connected") : t("disconnected")}
              </span>
            </div>
          </div>
        </header>

        {showGuide ? (
          <div className="flex-1 overflow-y-auto">
            <GettingStarted onClose={() => setShowGuide(false)} />
          </div>
        ) : (
          <ProjectHome />
        )}
      </main>
      <ToastContainer />
    </div>
  );
}

export default App;
