import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Blueprint,
  CheckCircle,
  Circle,
  GitBranch,
  Plus,
  Question,
  ShieldCheck,
  SpinnerGap,
  Target,
  TerminalWindow,
  UserFocus,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { TerminalDecision, TerminalSession } from "../../../shared/types";
import { api, type GoalListItem } from "../lib/api";
import { useStore } from "../stores/useStore";
import { AddAgentDialog } from "./AddAgentDialog";
import { AgentDetail } from "./AgentDetail";
import { ConfirmDialog } from "./ConfirmDialog";
import GoalSpecPanel from "./GoalSpecPanel";
import { InputDialog } from "./InputDialog";
import { InspectorTabs } from "./InspectorTabs";
import { OrgChart } from "./OrgChart";
import { WorkspaceGoalComposer } from "./WorkspaceGoalComposer";
import { WorkspaceTerminal } from "./WorkspaceTerminal";

interface WorkspaceTask {
  id: string;
  goal_id: string;
  project_id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  status: string;
  verification_id: string | null;
  result_summary?: string | null;
  priority?: string;
}

const STATUS_STYLES: Record<string, { dot: string; text: string }> = {
  todo: { dot: "bg-faint", text: "text-muted" },
  pending_approval: { dot: "bg-warning", text: "text-warning" },
  in_progress: { dot: "bg-accent", text: "text-accent" },
  in_review: { dot: "bg-[#a78bfa]", text: "text-[#a78bfa]" },
  done: { dot: "bg-success", text: "text-success" },
  blocked: { dot: "bg-danger", text: "text-danger" },
};

function statusIcon(status: string) {
  if (status === "done") return <CheckCircle weight="fill" className="text-success" />;
  if (status === "blocked") return <WarningCircle weight="fill" className="text-danger" />;
  if (status === "in_progress") return <SpinnerGap weight="bold" className="animate-spin text-accent" />;
  if (status === "in_review") return <ShieldCheck weight="fill" className="text-[#a78bfa]" />;
  return <Circle weight="regular" className="text-faint" />;
}

/** Orca형 실제 로컬 터미널 + Crewdeck goal-bound control plane. */
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
  const [selectedTerminal, setSelectedTerminal] = useState<TerminalSession | null>(null);
  const [contextState, setContextState] = useState<TerminalSession["contextState"]>("unknown");
  const [decisions, setDecisions] = useState<TerminalDecision[]>([]);
  const [showGoalComposer, setShowGoalComposer] = useState(false);
  const [specGoalId, setSpecGoalId] = useState<string | null>(null);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [showOrgChart, setShowOrgChart] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showAddTask, setShowAddTask] = useState(false);
  const [rightPane, setRightPane] = useState<"decisions" | "inspector">("decisions");
  const [confirmRedecompose, setConfirmRedecompose] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { projects, currentProjectId, agents, goals, tasks, workspaces, setGoals, setTasks } = useStore();
  const project = projects.find((item) => item.id === currentProjectId);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const projectAgents = agents.filter((item) => item.project_id === currentProjectId);
  const projectGoals = goals.filter((item) => item.project_id === currentProjectId);
  const selectedGoal = projectGoals.find((item) => item.id === selectedGoalId) ?? null;
  const selectedGoalTasks = tasks.filter((item) => item.goal_id === selectedGoalId) as WorkspaceTask[];
  const selectedAgent = projectAgents.find((item) => item.id === selectedAgentId) ?? null;
  const boundTask = selectedGoalTasks.find((item) => item.id === selectedTerminal?.activeTaskId) ?? null;
  const boundTaskStatus = boundTask?.status ?? selectedTerminal?.activeTaskStatus ?? null;
  const blockedTasks = selectedGoalTasks.filter((item) => item.status === "blocked");
  // 관찰 대상 — 터미널에 바인딩된 에이전트가 우선, 없으면 바인딩된 태스크의 담당자.
  // 오케스트레이션 세션의 session:stream은 담당자 agentId 스코프로 흐른다.
  const observedAgentId = selectedTerminal?.agentId ?? boundTask?.assignee_id ?? agentId ?? null;
  const completedCount = selectedGoalTasks.filter((item) => item.status === "done").length;
  const progress = selectedGoalTasks.length ? Math.round((completedCount / selectedGoalTasks.length) * 100) : 0;

  const taskOrder = useMemo(() => [...selectedGoalTasks].sort((a, b) => {
    const rank: Record<string, number> = { blocked: 0, in_progress: 1, in_review: 2, todo: 3, pending_approval: 4, done: 5 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
  }), [selectedGoalTasks]);

  const refresh = () => window.dispatchEvent(new CustomEvent("crewdeck:refresh"));

  const syncTerminal = async (terminalId: string) => {
    const terminal = await api.terminals.get(terminalId);
    setSelectedTerminal(terminal);
    window.dispatchEvent(new CustomEvent("crewdeck:terminal-binding", { detail: terminal }));
    return terminal;
  };

  useEffect(() => {
    if (selectedGoalId && projectGoals.some((item) => item.id === selectedGoalId)) return;
    setSelectedGoalId(
      goalId
      ?? workspace?.activeGoalId
      ?? workspace?.goalId
      ?? projectGoals.find((item) => item.progress < 100)?.id
      ?? projectGoals[0]?.id
      ?? null,
    );
  }, [goalId, projectGoals, selectedGoalId, workspace?.activeGoalId, workspace?.goalId]);

  useEffect(() => {
    if (!selectedTerminal) {
      setDecisions([]);
      return;
    }
    void api.terminals.decisions(selectedTerminal.id, selectedGoalId).then(setDecisions).catch(() => setDecisions([]));
  }, [selectedGoalId, selectedTerminal]);

  useEffect(() => {
    const onBridge = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string; goal?: { id?: string } }>).detail;
      if (detail.workspaceId === workspaceId && detail.goal?.id) setSelectedGoalId(detail.goal.id);
    };
    const onDecision = (event: Event) => {
      const decision = (event as CustomEvent<TerminalDecision>).detail;
      if (decision.workspaceId === workspaceId) setDecisions((current) => [decision, ...current.filter((item) => item.id !== decision.id)]);
    };
    window.addEventListener("crewdeck:terminal-bridge", onBridge);
    window.addEventListener("crewdeck:terminal-decision", onDecision);
    return () => {
      window.removeEventListener("crewdeck:terminal-bridge", onBridge);
      window.removeEventListener("crewdeck:terminal-decision", onDecision);
    };
  }, [workspaceId]);

  const selectGoal = async (nextGoalId: string) => {
    setSelectedGoalId(nextGoalId);
    setActionError(null);
    if (!workspaceId) return;
    try {
      await api.workspaces.selectGoal(workspaceId, nextGoalId);
      if (selectedTerminal?.status === "active") {
        const terminal = await api.terminals.bind(selectedTerminal.id, { goalId: nextGoalId, taskId: null });
        setSelectedTerminal(terminal);
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalContextFailed"));
    }
  };

  const bindAgent = async (nextAgentId: string) => {
    if (!selectedTerminal) return;
    setActionBusy(`agent-${nextAgentId}`);
    setActionError(null);
    try {
      const terminal = await api.terminals.bind(selectedTerminal.id, { goalId: selectedGoalId, agentId: nextAgentId });
      setSelectedTerminal(terminal);
      window.dispatchEvent(new CustomEvent("crewdeck:terminal-binding", { detail: terminal }));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
    } finally {
      setActionBusy(null);
    }
  };

  const bindTask = async (task: WorkspaceTask, focus = false) => {
    if (!selectedTerminal) {
      setActionError(t("workspaceTerminalRequiredForTask"));
      return;
    }
    setActionBusy(`task-${task.id}`);
    setActionError(null);
    try {
      const terminal = await api.terminals.bind(selectedTerminal.id, {
        goalId: task.goal_id,
        taskId: task.id,
        agentId: task.assignee_id ?? selectedTerminal.agentId ?? agentId ?? null,
      });
      setSelectedTerminal(terminal);
      window.dispatchEvent(new CustomEvent("crewdeck:terminal-binding", { detail: terminal }));
      if (focus) window.dispatchEvent(new CustomEvent("crewdeck:terminal-focus", { detail: { terminalId: terminal.id } }));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
    } finally {
      setActionBusy(null);
    }
  };

  const claimNext = async () => {
    if (!selectedTerminal || !selectedGoalId) return;
    setActionBusy("claim");
    setActionError(null);
    try {
      const result = await api.terminals.claimNext(selectedTerminal.id, {
        goalId: selectedGoalId,
        agentId: selectedTerminal.agentId ?? agentId ?? null,
        provider: selectedTerminal.provider,
      });
      if (result.terminal) {
        setSelectedTerminal(result.terminal);
        window.dispatchEvent(new CustomEvent("crewdeck:terminal-binding", { detail: result.terminal }));
      }
      refresh();
      window.dispatchEvent(new CustomEvent("crewdeck:terminal-focus", { detail: { terminalId: selectedTerminal.id } }));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceNoReadyTask"));
    } finally {
      setActionBusy(null);
    }
  };

  const requestCompletion = async () => {
    if (!selectedTerminal || !boundTask) return;
    setActionBusy("completion");
    setActionError(null);
    try {
      await api.terminals.requestCompletion(selectedTerminal.id, t("workspaceCompletionSummary", { task: boundTask.title }));
      await syncTerminal(selectedTerminal.id);
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
    } finally {
      setActionBusy(null);
    }
  };

  const runQualityGate = async () => {
    if (!selectedTerminal?.activeTaskId) return;
    setActionBusy("verify");
    setActionError(null);
    try {
      await api.orchestration.verifyTask(selectedTerminal.activeTaskId);
      await syncTerminal(selectedTerminal.id);
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
    } finally {
      setActionBusy(null);
    }
  };

  const handleGoalCreated = (goal: GoalListItem, blueprintStarted: boolean) => {
    if (!goals.some((item) => item.id === goal.id)) setGoals([...goals, goal]);
    setSelectedGoalId(goal.id);
    setShowGoalComposer(false);
    refresh();
    if (blueprintStarted) setSpecGoalId(goal.id);
  };

  const decomposeGoal = async () => {
    if (!selectedGoal) return;
    if (selectedGoal.spec_approval_required === 1 && !selectedGoal.execution_spec_version_id) {
      setActionError(t("specNotApprovedToast"));
      setSpecGoalId(selectedGoal.id);
      return;
    }
    if (selectedGoalTasks.length > 0 && !confirmRedecompose) {
      setConfirmRedecompose(true);
      return;
    }
    setConfirmRedecompose(false);
    setActionBusy("decompose");
    try {
      await api.orchestration.decomposeGoal(selectedGoal.id);
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
    } finally {
      setActionBusy(null);
    }
  };

  const addTask = async (title: string) => {
    if (!selectedGoal || !currentProjectId) return;
    setShowAddTask(false);
    setActionBusy("task");
    try {
      const task = await api.tasks.create({ goal_id: selectedGoal.id, project_id: currentProjectId, title });
      setTasks([...tasks, task]);
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
    } finally {
      setActionBusy(null);
    }
  };

  const refreshAgents = () => {
    setSelectedAgentId(null);
    refresh();
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas" onClick={onClose}>
        <div className="flex h-full w-full flex-col overflow-hidden bg-surface" onClick={(event) => event.stopPropagation()}>
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-line-soft bg-elevated px-3">
            <div className="flex min-w-0 items-center gap-2">
              <Target size={17} weight="duotone" className="shrink-0 text-accent" />
              <span className="truncate text-sm font-semibold text-fg">{project?.name ?? t("wsTitle")}</span>
              <span className="text-faint">/</span>
              <span className="max-w-52 truncate text-xs text-muted">{workspaceName ?? t("wsTitle")}</span>
              {worktreeBranch && (
                <span className="hidden max-w-60 items-center gap-1 rounded bg-sunken px-2 py-0.5 font-mono text-[10px] text-muted xl:flex">
                  <GitBranch size={12} /> <span className="truncate">{worktreeBranch}</span>
                </span>
              )}
              <span className={`flex shrink-0 items-center gap-1 text-[10px] ${contextState === "connected" ? "text-success" : contextState === "mismatch" ? "text-danger" : "text-faint"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${contextState === "connected" ? "bg-success" : contextState === "mismatch" ? "bg-danger" : "bg-faint"}`} />
                {t(`terminalContext_${contextState}`)}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("crewdeck:open-help"))} aria-label={t("helpTitle")} className="rounded p-1.5 text-faint hover:bg-fg/5 hover:text-fg"><Question size={16} /></button>
              <button type="button" onClick={onClose} aria-label={t("close")} className="rounded p-1.5 text-faint hover:bg-fg/5 hover:text-fg"><X size={17} /></button>
            </div>
          </header>

          <div className="flex min-h-0 flex-1">
            <aside className="hidden w-[286px] shrink-0 flex-col border-r border-line-soft bg-elevated lg:flex">
              <div className="border-b border-line-soft p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint"><Target size={13} />{t("workspaceExecutionMap")}</div>
                  <button type="button" onClick={() => setShowGoalComposer(true)} className="rounded p-1 text-accent hover:bg-accent/10" aria-label={t("workspaceNewGoal")}><Plus size={14} weight="bold" /></button>
                </div>
                <select
                  value={selectedGoalId ?? ""}
                  onChange={(event) => void selectGoal(event.target.value)}
                  className="w-full rounded-md border border-line bg-sunken px-2.5 py-2 text-xs text-fg outline-none focus:border-accent"
                  aria-label={t("goals")}
                >
                  {projectGoals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title || goal.description}</option>)}
                </select>
                <div className="mt-3 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line-soft"><div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} /></div>
                  <span className="font-mono text-[10px] text-muted">{completedCount}/{selectedGoalTasks.length}</span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1">
                  <button type="button" onClick={() => selectedGoal && setSpecGoalId(selectedGoal.id)} className="flex items-center justify-center gap-1 rounded border border-line px-1 py-1.5 text-[9px] text-muted hover:border-accent hover:text-accent"><Blueprint size={12} />{t("workspacePlan")}</button>
                  <button type="button" onClick={() => void decomposeGoal()} disabled={!selectedGoal || actionBusy !== null} className="rounded border border-line px-1 py-1.5 text-[9px] text-muted hover:border-accent hover:text-accent disabled:opacity-40">{t("workspaceSplitTasks")}</button>
                  <button type="button" onClick={() => setShowAddTask(true)} disabled={!selectedGoal || actionBusy !== null} className="flex items-center justify-center gap-1 rounded border border-line px-1 py-1.5 text-[9px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"><Plus size={11} />{t("workspaceTask")}</button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                <div className="space-y-1.5">
                  {taskOrder.map((task, index) => {
                    const assignee = projectAgents.find((item) => item.id === task.assignee_id);
                    const bound = selectedTerminal?.activeTaskId === task.id;
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => void bindTask(task)}
                        className={`group w-full rounded-md border px-2.5 py-2 text-left transition-colors ${bound ? "border-accent/60 bg-accent/10" : "border-transparent bg-fg/[0.025] hover:border-line hover:bg-fg/[0.04]"}`}
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 text-sm">{statusIcon(task.status)}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5"><span className="font-mono text-[9px] text-faint">{String(index + 1).padStart(2, "0")}</span><span className="truncate text-[11px] font-medium text-fg">{task.title}</span></div>
                            <div className="mt-1 flex items-center justify-between gap-2">
                              <span className="truncate text-[9px] text-faint">{assignee?.name ?? t("workspaceUnassigned")}</span>
                              <span className={`text-[9px] ${STATUS_STYLES[task.status]?.text ?? "text-muted"}`}>{t(`taskStatus_${task.status}`)}</span>
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {taskOrder.length === 0 && <div className="rounded-md border border-dashed border-line p-4 text-center text-[10px] leading-5 text-faint">{t("workspaceNoTasksHint")}</div>}
                </div>
              </div>

              <div className="border-t border-line-soft p-2.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[10px] font-semibold text-muted"><UsersThree size={14} />{t("workspaceAgentTeam")}</span>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setShowOrgChart(true)} className="rounded px-1.5 py-1 text-[9px] text-muted hover:bg-fg/5 hover:text-fg">{t("workspaceOrgEdit")}</button>
                    <button type="button" onClick={() => setShowAddAgent(true)} className="rounded p-1 text-accent hover:bg-accent/10" aria-label={t("workspaceAgentAdd")}><Plus size={12} weight="bold" /></button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {projectAgents.slice(0, 6).map((agent) => (
                    <button key={agent.id} type="button" onClick={() => void bindAgent(agent.id)} className={`rounded border px-2 py-1.5 text-left ${selectedTerminal?.agentId === agent.id ? "border-accent/50 bg-accent/10" : "border-line-soft hover:border-line"}`}>
                      <div className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${agent.status === "working" ? "bg-success" : "bg-faint"}`} /><span className="truncate text-[10px] text-fg">{agent.name}</span></div>
                      <div className="mt-0.5 truncate pl-3 text-[8px] text-faint">{agent.role}</div>
                    </button>
                  ))}
                </div>
              </div>
            </aside>

            <main className="flex min-w-0 flex-1 flex-col border-r border-line-soft">
              <div className="flex h-[58px] shrink-0 items-center gap-3 border-b border-line-soft bg-surface px-3">
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <span className="rounded bg-accent/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-accent">Goal</span>
                  <span className="max-w-[26%] truncate text-[11px] text-muted">{selectedGoal?.title ?? t("workspaceSelectGoal")}</span>
                  <ArrowRight size={12} className="shrink-0 text-faint" />
                  <span className="rounded bg-[#a78bfa]/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-[#a78bfa]">Task</span>
                  <span className="max-w-[32%] truncate text-[11px] font-medium text-fg">{selectedTerminal?.activeTaskTitle ?? t("workspaceNoBoundTask")}</span>
                  <ArrowRight size={12} className="shrink-0 text-faint" />
                  <span className="rounded bg-success/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-success">Agent</span>
                  <span className="truncate text-[11px] text-muted">{selectedTerminal?.agentName ?? agentName ?? t("workspaceUnassigned")}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {boundTaskStatus === "in_progress" && <button type="button" onClick={() => void requestCompletion()} disabled={actionBusy !== null} className="rounded-md border border-[#a78bfa]/40 px-2.5 py-1.5 text-[10px] font-medium text-[#a78bfa] hover:bg-[#a78bfa]/10 disabled:opacity-40">{t("workspaceRequestReview")}</button>}
                  {boundTaskStatus === "in_review" && <button type="button" onClick={() => void runQualityGate()} disabled={actionBusy !== null} className="flex items-center gap-1 rounded-md bg-[#a78bfa] px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-[#9271ee] disabled:opacity-40"><ShieldCheck size={13} />{t("workspaceRunQualityGate")}</button>}
                  {(!selectedTerminal?.activeTaskId || boundTaskStatus === "done") && <button type="button" onClick={() => void claimNext()} disabled={!selectedTerminal || !selectedGoalId || actionBusy !== null} className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-accent-hover disabled:opacity-40">{actionBusy === "claim" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowRight size={13} />}{t("workspaceClaimNext")}</button>}
                </div>
              </div>
              {actionError && <div role="alert" className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-[10px] text-danger">{actionError}</div>}
              <div className="min-h-0 flex-1">
                {workspaceId ? (
                  <WorkspaceTerminal
                    workspaceId={workspaceId}
                    activeGoalId={selectedGoalId}
                    onContextStateChange={setContextState}
                    onSessionChange={setSelectedTerminal}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center bg-terminal text-xs text-terminal-muted">{t("terminalWorkspaceRequired")}</div>
                )}
              </div>
            </main>

            {/* 인스펙터는 6탭이라 330px에서는 탭 라벨이 줄바꿈된다 — 관찰 모드에서만 폭을 넓힌다. */}
            <aside className={`hidden shrink-0 flex-col bg-elevated xl:flex ${rightPane === "inspector" ? "w-[400px]" : "w-[330px]"}`}>
              <div className="flex shrink-0 border-b border-line-soft">
                <button
                  type="button"
                  onClick={() => setRightPane("decisions")}
                  className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-[10px] font-medium ${rightPane === "decisions" ? "border-b-2 border-accent text-accent" : "text-muted hover:text-fg"}`}
                >
                  <WarningCircle size={13} weight="duotone" className={blockedTasks.length ? "text-danger" : undefined} />
                  {t("workspaceDecisionInbox")}
                  <span className={`rounded-full px-1.5 py-0.5 font-mono text-[8px] ${blockedTasks.length ? "bg-danger/10 text-danger" : "bg-fg/5 text-faint"}`}>{blockedTasks.length}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRightPane("inspector")}
                  className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-[10px] font-medium ${rightPane === "inspector" ? "border-b-2 border-accent text-accent" : "text-muted hover:text-fg"}`}
                >
                  <UserFocus size={13} />
                  {t("workspaceObserveTab")}
                </button>
              </div>

              {rightPane === "inspector" ? (
                <div className="min-h-0 flex-1">
                  <InspectorTabs goalId={selectedGoalId} workspaceId={workspaceId} agentId={observedAgentId} />
                </div>
              ) : (
              <>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <p className="mb-2.5 text-[9px] leading-4 text-faint">{t("workspaceDecisionInboxHelp")}</p>
                <div className="space-y-2">
                  {blockedTasks.map((task) => {
                    const assignee = projectAgents.find((item) => item.id === task.assignee_id);
                    return (
                      <article key={task.id} className="rounded-lg border border-danger/25 bg-danger/[0.04] p-3">
                        <div className="flex items-start gap-2"><WarningCircle size={15} weight="fill" className="mt-0.5 shrink-0 text-danger" /><div className="min-w-0"><h3 className="text-[11px] font-semibold text-fg">{task.title}</h3><p className="mt-1 text-[9px] leading-4 text-muted">{task.result_summary || task.description || t("workspaceBlockedFallback")}</p></div></div>
                        <div className="mt-2 flex items-center justify-between border-t border-danger/15 pt-2"><span className="text-[9px] text-faint">{assignee?.name ?? t("workspaceUnassigned")}</span><button type="button" onClick={() => void bindTask(task, true)} className="flex items-center gap-1 rounded-md bg-danger px-2 py-1.5 text-[9px] font-semibold text-white hover:bg-danger/90"><TerminalWindow size={12} />{t("workspaceResolveWithAgent")}</button></div>
                      </article>
                    );
                  })}
                  {blockedTasks.length === 0 && (
                    <div className="rounded-lg border border-dashed border-line p-5 text-center"><CheckCircle size={24} weight="duotone" className="mx-auto text-success" /><p className="mt-2 text-[10px] font-medium text-muted">{t("workspaceNoDecisions")}</p><p className="mt-1 text-[9px] leading-4 text-faint">{t("workspaceNoDecisionsHelp")}</p></div>
                  )}
                </div>

                <div className="mt-5">
                  <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-muted"><UserFocus size={14} />{t("workspaceDecisionHistory")}</div>
                  <div className="space-y-1.5">
                    {decisions.slice(0, 8).map((decision) => {
                      const task = selectedGoalTasks.find((item) => item.id === decision.taskId);
                      return <div key={decision.id} className="rounded-md border border-line-soft bg-surface px-2.5 py-2"><div className="truncate text-[9px] text-faint">{task?.title ?? t("workspaceDecision")}</div><p className="mt-1 text-[10px] leading-4 text-muted">{decision.message}</p></div>;
                    })}
                    {decisions.length === 0 && <p className="rounded-md border border-dashed border-line-soft px-3 py-3 text-center text-[9px] text-faint">{t("workspaceNoDecisionHistory")}</p>}
                  </div>
                </div>
              </div>

              <div className="border-t border-line-soft p-3">
                <div className="rounded-md bg-sunken p-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-fg"><TerminalWindow size={13} className="text-accent" />{t("workspaceNativeTerminal")}</div>
                  <p className="mt-1 text-[9px] leading-4 text-faint">{t("workspaceNativeTerminalHelp")}</p>
                </div>
              </div>
              </>
              )}
            </aside>
          </div>
        </div>
      </div>

      {showGoalComposer && currentProjectId && <WorkspaceGoalComposer projectId={currentProjectId} onCreated={handleGoalCreated} onClose={() => setShowGoalComposer(false)} />}
      {specGoalId && <GoalSpecPanel goalId={specGoalId} goalTitle={projectGoals.find((item) => item.id === specGoalId)?.title} onClose={() => { setSpecGoalId(null); refresh(); }} />}
      {showAddTask && <InputDialog title={t("workspaceAddTask")} onSubmit={(value) => void addTask(value)} onCancel={() => setShowAddTask(false)} />}
      {confirmRedecompose && <ConfirmDialog message={t("reDecomposeConfirm", { count: selectedGoalTasks.length })} onConfirm={() => void decomposeGoal()} onCancel={() => setConfirmRedecompose(false)} />}
      {showAddAgent && currentProjectId && <AddAgentDialog projectId={currentProjectId} mission={project?.mission} existingAgents={projectAgents} onCreated={refresh} onClose={() => { setShowAddAgent(false); refresh(); }} />}
      {showOrgChart && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4" onClick={() => setShowOrgChart(false)}>
          <section className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <header className="flex items-center justify-between border-b border-line px-5 py-3"><h2 className="text-sm font-semibold text-fg">{t("workspaceOrgTitle")}</h2><button type="button" onClick={() => setShowOrgChart(false)} aria-label={t("close")} className="rounded p-1 text-faint hover:bg-fg/5"><X size={16} /></button></header>
            <div className="min-h-0 flex-1 overflow-auto p-4"><OrgChart agents={projectAgents} tasks={tasks} onAddAgent={() => setShowAddAgent(true)} onAgentDeleted={refreshAgents} onAgentKilled={refreshAgents} /></div>
          </section>
        </div>
      )}
      {selectedAgent && <AgentDetail agent={selectedAgent} agents={projectAgents} tasks={tasks} onClose={() => setSelectedAgentId(null)} onKill={refreshAgents} onDeleted={refreshAgents} />}
    </>
  );
}
