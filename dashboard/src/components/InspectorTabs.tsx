import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { DiffPane } from "./DiffPane";
import { GoalDetail } from "./GoalDetail";
import { LiveActivity } from "./LiveActivity";
import { SessionView } from "./SessionView";
import { useStore } from "../stores/useStore";
import type { TerminalBridgeActivity } from "../../../shared/types";

type WsTab = "crew" | "diff" | "output" | "workspace" | "verdict" | "live";

/**
 * 세션 워크스페이스 우측 인스펙터 — Diff / 최근출력 / 작업공간 / 판정 / 실시간 5탭.
 * 순수 표시(REST 조회 → render). Diff·작업공간·판정은 goalId 기반, 최근출력·실시간은 agentId 기반.
 */
export function InspectorTabs({
  goalId,
  workspaceId,
  agentId,
}: {
  goalId: string | null;
  workspaceId?: string | null;
  agentId?: string | null;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<WsTab>("crew");

  const tabs: { id: WsTab; label: string }[] = [
    { id: "crew", label: t("wsTabCrew") },
    { id: "diff", label: t("wsTabDiff") },
    ...(agentId ? [
      { id: "output" as const, label: t("wsTabOutput") },
      { id: "live" as const, label: t("wsTabLive") },
    ] : []),
    { id: "workspace", label: t("wsTabWorkspace") },
    { id: "verdict", label: t("wsTabVerdict") },
  ];

  const missingContext = tab === "verdict"
    ? !goalId
    : (tab === "diff" || tab === "workspace") && !goalId && !workspaceId;

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-line-soft shrink-0 overflow-x-auto">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`shrink-0 whitespace-nowrap px-2.5 py-2 text-xs font-medium ${
              tab === tb.id
                ? "text-accent border-b-2 border-accent"
                : "text-muted hover:text-muted"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {missingContext ? (
          <div className="p-4 text-xs text-faint">{t("wsNoGoal")}</div>
        ) : tab === "crew" ? (
          <CrewdeckContext goalId={goalId} workspaceId={workspaceId} />
        ) : tab === "diff" ? (
          <DiffPane goalId={goalId} workspaceId={workspaceId} />
        ) : tab === "output" ? (
          <LiveActivity agentId={agentId!} />
        ) : tab === "live" ? (
          <SessionView agentId={agentId!} goalId={goalId} />
        ) : tab === "workspace" ? (
          <WorkspaceFiles goalId={goalId} workspaceId={workspaceId} />
        ) : (
          <GoalDetail goalId={goalId!} autoLoad className="p-2" />
        )}
      </div>
    </div>
  );
}

function CrewdeckContext({ goalId, workspaceId }: { goalId: string | null; workspaceId?: string | null }) {
  const { t } = useTranslation();
  const { currentProjectId, agents, goals, tasks } = useStore();
  const [activity, setActivity] = useState<TerminalBridgeActivity[]>([]);
  const projectAgents = agents.filter((agent) => agent.project_id === currentProjectId);
  const projectGoals = goals.filter((goal) => goal.project_id === currentProjectId);
  const selectedGoal = projectGoals.find((goal) => goal.id === goalId) ?? null;
  const selectedTasks = tasks.filter((task) => task.goal_id === selectedGoal?.id);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (!workspaceId || !goalId) {
        setActivity([]);
        return;
      }
      api.terminalBridge.events(workspaceId, goalId)
        .then((events) => { if (alive) setActivity(events); })
        .catch(() => { if (alive) setActivity([]); });
    };
    const onBridge = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (detail.workspaceId === workspaceId) load();
    };
    load();
    window.addEventListener("crewdeck:terminal-bridge", onBridge);
    return () => {
      alive = false;
      window.removeEventListener("crewdeck:terminal-bridge", onBridge);
    };
  }, [goalId, workspaceId]);

  return (
    <div className="space-y-5 p-4">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-faint">{t("workspaceCrewTitle")}</h3>
          <span className="text-[10px] text-muted">{t("agentCount", { count: projectAgents.length })}</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {projectAgents.map((agent) => (
            <div key={agent.id} className="rounded border border-line-soft bg-elevated px-2.5 py-2">
              <div className="flex items-center gap-2 text-xs text-fg">
                <span className={`h-1.5 w-1.5 rounded-full ${agent.status === "working" ? "bg-success" : "bg-faint"}`} />
                <span className="truncate">{agent.name}</span>
              </div>
              <div className="mt-1 truncate pl-3.5 text-[9px] text-faint">{agent.role} · {agent.status}</div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-faint">{t("workspaceGoalTasks")}</div>
        {!selectedGoal ? (
          <div className="rounded border border-dashed border-line p-3 text-xs text-faint">{t("workspaceSelectGoal")}</div>
        ) : (
          <div>
            <div className="mb-2 text-sm font-semibold text-fg">{selectedGoal.title || selectedGoal.description}</div>
            <div className="space-y-1">
              {selectedTasks.map((task) => (
                <div key={task.id} className="flex items-start gap-2 rounded border border-line-soft px-2.5 py-2 text-xs">
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${task.status === "done" ? "bg-success" : task.status === "in_progress" ? "bg-accent" : task.status === "blocked" ? "bg-danger" : "bg-faint"}`} />
                  <span className="min-w-0 flex-1 text-muted">{task.title}</span>
                  <span className="shrink-0 text-[9px] text-faint">{task.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      {selectedGoal && (
        <section>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-faint">{t("workspacePhaseActivity")}</div>
          {activity.length === 0 ? (
            <div className="rounded border border-dashed border-line p-3 text-xs text-faint">{t("workspaceNoPhaseActivity")}</div>
          ) : (
            <div className="space-y-1.5">
              {activity.map((event) => (
                <div key={event.id} className="rounded border border-line-soft bg-elevated px-2.5 py-2">
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className={`h-1.5 w-1.5 rounded-full ${event.status === "done" ? "bg-success" : event.status === "blocked" ? "bg-danger" : event.status === "in_review" ? "bg-warning" : "bg-accent"}`} />
                    <span className="min-w-0 flex-1 truncate text-muted">
                      {event.kind === "goal_created" ? t("workspaceGoalCreated") : event.taskTitle}
                    </span>
                    <span className="shrink-0 font-mono text-faint">{event.status ?? event.kind}</span>
                  </div>
                  {event.summary && <div className="mt-1 text-[10px] text-faint">{event.summary}</div>}
                  {event.evidence && event.evidence.changedFiles.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {event.evidence.changedFiles.slice(0, 6).map((file) => (
                        <span key={file} className="max-w-full truncate rounded bg-fg/5 px-1.5 py-0.5 font-mono text-[9px] text-faint">{file}</span>
                      ))}
                    </div>
                  )}
                  <div className="mt-1 font-mono text-[9px] text-faint">{event.createdAt.slice(11, 16)} · {event.terminalSessionId?.slice(0, 6) ?? "—"}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** 작업 공간 탭 — worktree 파일 목록(평면). */
function WorkspaceFiles({ goalId, workspaceId }: { goalId: string | null; workspaceId?: string | null }) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    const request = workspaceId
      ? api.workspaces.getFiles(workspaceId)
      : api.goals.getFiles(goalId!);
    request
      .then((r) => { if (alive) setFiles(r.files); })
      .catch(() => { if (alive) setFiles([]); });
    return () => { alive = false; };
  }, [goalId, workspaceId]);
  if (files === null) return <div className="p-4 text-xs text-faint">{t("loading")}</div>;
  if (files.length === 0) return <div className="p-4 text-xs text-faint">{t("wsNoFiles")}</div>;
  return (
    <div className="text-xs font-mono p-2">
      {files.map((f) => (
        <div key={f} className="px-2 py-0.5 text-muted hover:bg-fg/5 truncate">
          {f}
        </div>
      ))}
    </div>
  );
}
