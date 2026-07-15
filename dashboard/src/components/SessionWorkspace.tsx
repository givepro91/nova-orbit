import { useTranslation } from "react-i18next";
import { InspectorTabs } from "./InspectorTabs";
import { useStore } from "../stores/useStore";
import { WorkspaceTerminal } from "./WorkspaceTerminal";
import { useEffect, useState } from "react";

/**
 * Orca형 3-pane 워크스페이스 — 탐색 / 실제 로컬 PTY / Crewdeck 인스펙터.
 */
export function SessionWorkspace({
  agentId,
  agentName,
  goalId,
  workspaceId,
  workspaceName,
  worktreeBranch,
  onClose,
}: {
  agentId?: string | null;
  agentName?: string;
  goalId: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
  workspaceName?: string;
  worktreeBranch?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [selectedGoalId, setSelectedGoalId] = useState(goalId);
  const { projects, currentProjectId, agents, goals, tasks } = useStore();
  const project = projects.find((item) => item.id === currentProjectId);
  const projectAgents = agents.filter((item) => item.project_id === currentProjectId);
  const projectGoals = goals.filter((item) => item.project_id === currentProjectId);
  useEffect(() => {
    const onBridge = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string; goal?: { id?: string } }>).detail;
      if (detail.workspaceId === workspaceId && detail.goal?.id) setSelectedGoalId(detail.goal.id);
    };
    window.addEventListener("crewdeck:terminal-bridge", onBridge);
    return () => window.removeEventListener("crewdeck:terminal-bridge", onBridge);
  }, [workspaceId]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas" onClick={onClose}>
      <div
        className="bg-surface w-full h-full flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-line-soft bg-elevated shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-bold text-fg truncate">◈ {project?.name ?? t("wsTitle")}</span>
            <span className="text-faint">/</span>
            <span className="text-xs text-muted truncate">{workspaceName ?? t("wsTitle")}</span>
            {worktreeBranch && (
              <span className="rounded bg-sunken px-2 py-0.5 font-mono text-[10px] text-muted truncate max-w-56">
                {worktreeBranch}
              </span>
            )}
            <span className="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent shrink-0">
              {agentName ?? t("workspaceLocalShell")}
            </span>
            <span className="flex items-center gap-1 text-[10px] text-success shrink-0">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              {t("workspaceTerminalReady")}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("crewdeck:open-help"))}
              className="text-faint hover:text-muted text-sm font-bold leading-none px-1"
              title={t("helpTitle")}
              aria-label={t("helpTitle")}
            >
              ?
            </button>
            <button
              onClick={onClose}
              className="text-faint hover:text-muted text-lg leading-none"
              aria-label={t("close")}
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 flex min-h-0">
          <aside className="hidden w-[224px] shrink-0 flex-col border-r border-line-soft bg-elevated lg:flex">
            <div className="border-b border-line-soft px-3 py-2">
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-faint">{t("workspaces")}</div>
              <div className="flex items-center gap-2 rounded bg-fg/5 px-2 py-1.5 text-xs text-fg">
                <span className="h-2 w-2 rounded-full bg-success" />
                <span className="min-w-0 flex-1 truncate">{workspaceName ?? t("wsTitle")}</span>
              </div>
            </div>
            <div className="border-b border-line-soft px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between text-[9px] font-semibold uppercase tracking-widest text-faint">
                <span>{t("agents")}</span><span>{projectAgents.length}</span>
              </div>
              <div className="space-y-0.5">
                {projectAgents.slice(0, 8).map((agent) => (
                  <div key={agent.id} className="flex items-center gap-2 rounded px-2 py-1 text-[11px] text-muted">
                    <span className={`h-1.5 w-1.5 rounded-full ${agent.status === "working" ? "bg-success" : "bg-faint"}`} />
                    <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                    <span className="truncate text-[9px] text-faint">{agent.role}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between text-[9px] font-semibold uppercase tracking-widest text-faint">
                <span>{t("goals")}</span><span>{projectGoals.length}</span>
              </div>
              <div className="space-y-1">
                {projectGoals.map((goal) => {
                  const goalTasks = tasks.filter((task) => task.goal_id === goal.id);
                  const complete = goalTasks.filter((task) => task.status === "done").length;
                  return (
                    <button
                      key={goal.id}
                      type="button"
                      onClick={() => setSelectedGoalId(goal.id)}
                      className={`w-full rounded px-2 py-1.5 text-left ${selectedGoalId === goal.id ? "bg-accent/10 text-fg" : "text-muted hover:bg-fg/5"}`}
                    >
                      <div className="truncate text-[11px]">{goal.title || goal.description}</div>
                      <div className="mt-1 flex items-center gap-2 text-[9px] text-faint">
                        <div className="h-1 flex-1 overflow-hidden rounded bg-line-soft">
                          <div className="h-full bg-accent" style={{ width: `${goalTasks.length ? (complete / goalTasks.length) * 100 : 0}%` }} />
                        </div>
                        <span>{complete}/{goalTasks.length}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>
          <main className="min-w-0 flex-1 border-r border-line-soft">
            {workspaceId ? (
              <WorkspaceTerminal workspaceId={workspaceId} />
            ) : (
              <div className="flex h-full items-center justify-center bg-terminal text-xs text-terminal-muted">{t("terminalWorkspaceRequired")}</div>
            )}
          </main>
          <div className="w-[38%] min-w-[360px] max-w-[560px] min-h-0 flex flex-col">
            <InspectorTabs goalId={selectedGoalId} workspaceId={workspaceId} agentId={agentId} />
          </div>
        </div>
      </div>
    </div>
  );
}
