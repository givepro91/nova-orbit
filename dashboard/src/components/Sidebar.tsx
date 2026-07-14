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

  // 프로젝트별 실시간 작업 상태 — 어떤 프로젝트가 지금 일하는지 사이드바에서 한눈에.
  // DB 집계라 새로고침에도 정확. 마운트 1회 + WS refresh(디바운스) + 8s 폴백 폴링.
  const [activity, setActivity] = useState<Record<string, { state: "working" | "waiting"; activeCount: number; specPending: number }>>({});

  useEffect(() => {
    let alive = true;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const fetchActivity = () => {
      api.projects
        .activity()
        .then((a) => { if (alive) setActivity(a); })
        .catch(() => { /* 서버 미지원/오류 시 인디케이터 없음 */ });
    };
    fetchActivity();
    const onRefresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(fetchActivity, 400);
    };
    window.addEventListener("crewdeck:refresh", onRefresh);
    const poll = setInterval(fetchActivity, 8000);
    return () => {
      alive = false;
      if (debounce) clearTimeout(debounce);
      window.removeEventListener("crewdeck:refresh", onRefresh);
      clearInterval(poll);
    };
  }, []);

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

  // 실행 엔진 칩 — 이 프로젝트의 에이전트들이 해석하는 백엔드(Claude/Codex).
  // Codex는 상단 바와 동일한 sky 톤, Claude(기본 엔진)는 중립 회색으로 절제.
  const renderEngines = (p: { providers?: ("claude" | "codex")[] }) => {
    const providers = p.providers;
    if (!providers || providers.length === 0) return null;
    return (
      <span className="shrink-0 flex items-center gap-0.5">
        {providers.map((prov) => {
          const label = prov === "codex" ? "Codex" : "Claude";
          return (
            <span
              key={prov}
              className={`rounded px-1 text-[9px] font-medium leading-tight ${
                prov === "codex"
                  ? "bg-sky-50 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400"
                  : "bg-fg/5 text-muted"
              }`}
              title={t("sidebarEngine", { engine: label })}
            >
              {label}
            </span>
          );
        })}
      </span>
    );
  };

  // working = 인디고 pulse(+진행 태스크 수), waiting = 앰버(+승인 대기 수), idle = 표시 없음.
  // 기획서 승인 대기는 별도 앰버 pill(✎N)로 — 작업 중이어도 승인이 필요함을 항상 드러낸다.
  const renderActivity = (projectId: string) => {
    const act = activity[projectId];
    if (!act) return null;
    const working = act.state === "working";
    const label = working ? t("sidebarWorking") : t("sidebarWaiting");
    const specPending = act.specPending ?? 0;
    // 일반 작업/승인 신호 여부 (기획서 승인 대기는 아래 전용 칩으로 분리 표시)
    const hasGeneric = working || act.activeCount > 0;
    if (!hasGeneric && specPending === 0) return null;
    return (
      <span className="shrink-0 flex items-center gap-1">
        {specPending > 0 && (
          <span
            className="flex items-center gap-0.5 rounded bg-warning-subtle px-1 text-[10px] font-medium text-warning"
            title={t("sidebarSpecPending", { count: specPending })}
            aria-label={t("sidebarSpecPending", { count: specPending })}
          >
            <span aria-hidden="true">✎</span>
            <span className="tabular-nums">{specPending}</span>
          </span>
        )}
        {hasGeneric && (
          <span className="flex items-center gap-1" title={label} aria-label={label}>
            {act.activeCount > 0 && (
              <span
                className={`text-[10px] font-medium tabular-nums ${
                  working ? "text-accent" : "text-warning"
                }`}
              >
                {act.activeCount}
              </span>
            )}
            <span className={`w-2 h-2 rounded-full ${working ? "bg-accent animate-pulse" : "bg-warning"}`} />
          </span>
        )}
      </span>
    );
  };

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

      <aside className="hidden h-screen w-[260px] shrink-0 flex-col border-r border-line bg-sidebar sm:flex">
        {/* Logo */}
        <div className="px-4 py-3 border-b border-line">
          <h1 className="text-sm font-semibold text-fg tracking-tight">
            {t("appName")}
          </h1>
          <p className="text-xs text-faint">{t("appSubtitle")}</p>
        </div>

        {/* Project List */}
        <nav className="flex-1 overflow-y-auto py-2">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-faint font-medium">
            {t("projects")}
          </div>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => { setCurrentProject(p.id); window.dispatchEvent(new CustomEvent("crewdeck:close-guide")); }}
              className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-fg/5 transition-colors ${
                currentProjectId === p.id
                  ? "bg-fg/10 text-fg font-medium"
                  : "text-muted"
              }`}
            >
              <span className="text-base">
                {p.source === "github"
                  ? "\uD83D\uDD17"
                  : p.source === "local_import"
                    ? "\uD83D\uDCC2"
                    : "\uD83D\uDCC1"}
              </span>
              <span className="truncate flex-1 min-w-0">{p.name}</span>
              {renderEngines(p)}
              {renderActivity(p.id)}
            </button>
          ))}
        </nav>

        {/* Action Buttons */}
        <div className="p-3 border-t border-line space-y-1">
          <button
            onClick={() => setShowDialog("newProject")}
            className="w-full py-1.5 text-sm text-muted hover:text-fg hover:bg-fg/5 rounded transition-colors"
          >
            {t("newProject")}
          </button>
          <button
            onClick={() => setShowDialog("import")}
            className="w-full py-1.5 text-sm text-faint hover:text-muted hover:bg-fg/5 rounded transition-colors"
          >
            {t("importLocal")}
          </button>
          <button
            onClick={() => setShowDialog("github")}
            className="w-full py-1.5 text-sm text-faint hover:text-muted hover:bg-fg/5 rounded transition-colors"
          >
            {t("connectGitHub")}
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("crewdeck:show-guide"))}
            className={`w-full py-1.5 text-xs rounded transition-colors flex items-center gap-1.5 justify-center font-medium ${
              projects.length === 0
                ? "bg-accent/10 text-accent hover:bg-accent/20 border border-accent/25"
                : "text-accent hover:text-accent-hover hover:bg-fg/5"
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
