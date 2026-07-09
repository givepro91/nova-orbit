import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../stores/useStore";
import { api, getApiKey } from "../lib/api";
import { NewProjectDialog } from "./NewProjectDialog";
import { InputDialog } from "./InputDialog";
import { DirectoryPicker } from "./DirectoryPicker";
import { Toast } from "./Toast";

export function Sidebar() {
  const { t } = useTranslation();
  const { projects, currentProjectId, setCurrentProject, setProjects } = useStore();

  const [showDialog, setShowDialog] = useState<"newProject" | "import" | "github" | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Listen for CommandPalette delegation events
  useEffect(() => {
    const onOpenNewProject = () => setShowDialog("newProject");
    const onOpenImport = () => setShowDialog("import");
    const onConnectGitHub = () => setShowDialog("github");
    window.addEventListener("crewdeck:open-new-project", onOpenNewProject);
    window.addEventListener("crewdeck:open-import", onOpenImport);
    window.addEventListener("crewdeck:connect-github", onConnectGitHub);
    return () => {
      window.removeEventListener("crewdeck:open-new-project", onOpenNewProject);
      window.removeEventListener("crewdeck:open-import", onOpenImport);
      window.removeEventListener("crewdeck:connect-github", onConnectGitHub);
    };
  }, []);

  const showToast = (msg: string) => setToast(msg);

  const handleNewProject = async (name: string, mission: string, workdir: string, autoAgents: boolean) => {
    setShowDialog(null);
    const project = await api.projects.create({ name, mission, workdir, source: "new" });
    setProjects([...projects, project]);
    setCurrentProject(project.id);

    // Auto-create domain-specialized agents based on mission
    if (autoAgents && mission) {
      try {
        await api.agents.suggestAndCreate(project.id, mission);
      } catch {
        // Silently fail — user can add agents manually
      }
    }
  };

  const handleImportProject = async (path: string) => {
    setShowDialog(null);
    try {
      const key = getApiKey();
      const res = await fetch("/api/projects/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ path, name: path.split("/").pop() }),
      });

      if (!res.ok) {
        const err = await res.json();
        showToast(`${t("errorImportFailed")}: ${err.error}`);
        return;
      }

      const data = await res.json();
      const updatedProjects = await api.projects.list();
      setProjects(updatedProjects);
      setCurrentProject(data.project.id);

      showToast(t("importedSuccess"));
    } catch (err: any) {
      showToast(`${t("errorImportFailed")}: ${err.message}`);
    }
  };

  const handleConnectGitHub = async (url: string) => {
    setShowDialog(null);
    try {
      const key = getApiKey();
      const res = await fetch("/api/projects/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const err = await res.json();
        showToast(`${t("errorGitHubFailed")}: ${err.error}`);
        return;
      }

      const data = await res.json();
      const updatedProjects = await api.projects.list();
      setProjects(updatedProjects);
      setCurrentProject(data.project.id);

      showToast(t("connectedSuccess"));
    } catch (err: any) {
      showToast(`${t("errorGitHubFailed")}: ${err.message}`);
    }
  };

  return (
    <>
      {showDialog === "newProject" && (
        <NewProjectDialog
          onSubmit={handleNewProject}
          onCancel={() => setShowDialog(null)}
        />
      )}
      {showDialog === "import" && (
        <DirectoryPicker
          onSubmit={handleImportProject}
          onCancel={() => setShowDialog(null)}
        />
      )}
      {showDialog === "github" && (
        <InputDialog
          title={t("promptGitHubUrl")}
          placeholder={t("promptGitHubUrlHint")}
          onSubmit={handleConnectGitHub}
          onCancel={() => setShowDialog(null)}
        />
      )}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}

      <aside className="w-[260px] h-screen border-r border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-[#16162a] flex flex-col shrink-0">
        {/* Logo */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-200 tracking-tight">
            {t("appName")}
          </h1>
          <p className="text-xs text-gray-400 dark:text-gray-500">{t("appSubtitle")}</p>
        </div>

        {/* Project List */}
        <nav className="flex-1 overflow-y-auto py-2">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium">
            {t("projects")}
          </div>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => { setCurrentProject(p.id); window.dispatchEvent(new CustomEvent("crewdeck:close-guide")); }}
              className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${
                currentProjectId === p.id
                  ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-medium"
                  : "text-gray-600 dark:text-gray-300"
              }`}
            >
              <span className="text-base">
                {p.source === "github"
                  ? "\uD83D\uDD17"
                  : p.source === "local_import"
                    ? "\uD83D\uDCC2"
                    : "\uD83D\uDCC1"}
              </span>
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </nav>

        {/* Action Buttons */}
        <div className="p-3 border-t border-gray-200 dark:border-gray-700 space-y-1">
          <button
            onClick={() => setShowDialog("newProject")}
            className="w-full py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
          >
            {t("newProject")}
          </button>
          <button
            onClick={() => setShowDialog("import")}
            className="w-full py-1.5 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
          >
            {t("importLocal")}
          </button>
          <button
            onClick={() => setShowDialog("github")}
            className="w-full py-1.5 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
          >
            {t("connectGitHub")}
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("crewdeck:show-guide"))}
            className={`w-full py-1.5 text-xs rounded transition-colors flex items-center gap-1.5 justify-center font-medium ${
              projects.length === 0
                ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/50 border border-blue-200 dark:border-blue-800"
                : "text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-gray-100 dark:hover:bg-gray-800"
            }`}
          >
            <span>📖</span>
            {t("gettingStarted")}
          </button>
        </div>
      </aside>
    </>
  );
}
