import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import type { TerminalActivity, TerminalDecision, TerminalReviewRequest, TerminalSession } from "../../../shared/types";
import { api, type GoalListItem } from "../lib/api";
import { useStore } from "../stores/useStore";
import { AddAgentDialog } from "./AddAgentDialog";
import { AgentDetail } from "./AgentDetail";
import { ConfirmDialog } from "./ConfirmDialog";
import GoalSpecPanel from "./GoalSpecPanel";
import { InputDialog } from "./InputDialog";
import { InspectorTabs } from "./InspectorTabs";
import { OrgChart } from "./OrgChart";
import { TerminalEvidencePanel } from "./TerminalEvidencePanel";
import { WorkspaceGoalComposer } from "./WorkspaceGoalComposer";
import { WorkspaceTaskGraph } from "./WorkspaceTaskGraph";
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
  sort_order?: number;
  depends_on?: string | null;
}

/** 터미널이 놓아주면 안 되는 진행 상태 — 이 상태의 터미널에서는 바인딩을 뺏지 않는다. */
const IN_FLIGHT_STATUSES = ["in_progress", "in_review", "blocked"];

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

function upsertReview(current: TerminalReviewRequest[], review: TerminalReviewRequest): TerminalReviewRequest[] {
  return [review, ...current.filter((item) => item.id !== review.id)];
}

function metadataStrings(metadata: Record<string, unknown>, keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    if (Array.isArray(value)) {
      values.push(...value.filter((item): item is string => typeof item === "string" && item.trim().length > 0));
    }
  }
  return values;
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
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [contextState, setContextState] = useState<TerminalSession["contextState"]>("unknown");
  const [decisions, setDecisions] = useState<TerminalDecision[]>([]);
  const [activities, setActivities] = useState<TerminalActivity[]>([]);
  const [reviews, setReviews] = useState<TerminalReviewRequest[]>([]);
  const [showGoalComposer, setShowGoalComposer] = useState(false);
  const [specGoalId, setSpecGoalId] = useState<string | null>(null);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [showOrgChart, setShowOrgChart] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showAddTask, setShowAddTask] = useState(false);
  const [rightPane, setRightPane] = useState<"decisions" | "inspector">("decisions");
  const [showTaskGraph, setShowTaskGraph] = useState(false);
  const [compactPanel, setCompactPanel] = useState<"execution" | "decisions" | null>(null);
  const [confirmRedecompose, setConfirmRedecompose] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const workspaceDialogRef = useRef<HTMLDivElement>(null);
  const workspaceCloseRef = useRef<HTMLButtonElement>(null);
  const executionTriggerRef = useRef<HTMLButtonElement>(null);
  const decisionTriggerRef = useRef<HTMLButtonElement>(null);
  const executionCloseRef = useRef<HTMLButtonElement>(null);
  const decisionCloseRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previousCompactPanelRef = useRef<typeof compactPanel>(null);
  const { projects, currentProjectId, agents, goals, tasks, workspaces, setGoals, setTasks } = useStore();
  const project = projects.find((item) => item.id === currentProjectId);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const projectAgents = agents.filter((item) => item.project_id === currentProjectId);
  const projectGoals = goals.filter((item) => item.project_id === currentProjectId);
  const selectedGoal = projectGoals.find((item) => item.id === selectedGoalId) ?? null;
  const selectedGoalTasks = tasks.filter((item) => item.goal_id === selectedGoalId) as WorkspaceTask[];
  const selectedAgent = projectAgents.find((item) => item.id === selectedAgentId) ?? null;
  const selectedTerminalId = selectedTerminal?.id ?? null;
  const activeSessions = terminalSessions.filter((item) => item.status === "active");
  const taskTerminals = new Map(
    activeSessions
      .filter((item) => item.activeTaskId)
      .map((item) => [item.activeTaskId as string, item]),
  );
  const boundTask = selectedGoalTasks.find((item) => item.id === selectedTerminal?.activeTaskId) ?? null;
  const boundTaskStatus = boundTask?.status ?? selectedTerminal?.activeTaskStatus ?? null;
  const currentReview = reviews.find((item) => item.taskId === selectedTerminal?.activeTaskId) ?? null;
  const blockedTasks = selectedGoalTasks.filter((item) => item.status === "blocked");
  const completedCount = selectedGoalTasks.filter((item) => item.status === "done").length;
  const progress = selectedGoalTasks.length ? Math.round((completedCount / selectedGoalTasks.length) * 100) : 0;
  const canStartOrContinue = !selectedTerminal?.activeTaskId
    || ["todo", "done", "in_progress", "blocked"].includes(String(boundTaskStatus));
  const isContinuingTask = Boolean(selectedTerminal?.activeTaskId && ["in_progress", "blocked"].includes(String(boundTaskStatus)));

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
    if (!workspaceId || !selectedTerminalId) {
      setActivities([]);
      setReviews([]);
      return;
    }
    let cancelled = false;
    setActivities([]);
    setReviews([]);
    void Promise.allSettled([
      api.terminalActivities.list(workspaceId, {
        goalId: selectedGoalId,
        terminalSessionId: selectedTerminalId,
        limit: 50,
      }),
      api.terminals.reviews(selectedTerminalId),
    ]).then(([activityResult, reviewResult]) => {
      if (cancelled) return;
      if (activityResult.status === "fulfilled") setActivities(activityResult.value.items);
      if (reviewResult.status === "fulfilled") setReviews(reviewResult.value);
    });
    return () => { cancelled = true; };
  }, [selectedGoalId, selectedTerminalId, workspaceId]);

  useEffect(() => {
    const onBridge = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string; goal?: { id?: string } }>).detail;
      if (detail.workspaceId === workspaceId && detail.goal?.id) setSelectedGoalId(detail.goal.id);
    };
    const onDecision = (event: Event) => {
      const decision = (event as CustomEvent<TerminalDecision>).detail;
      if (decision.workspaceId === workspaceId) setDecisions((current) => [decision, ...current.filter((item) => item.id !== decision.id)]);
    };
    const onActivity = (event: Event) => {
      const activity = (event as CustomEvent<TerminalActivity>).detail;
      if (activity.workspaceId !== workspaceId || activity.terminalSessionId !== selectedTerminalId) return;
      setActivities((current) => [activity, ...current.filter((item) => item.id !== activity.id)].slice(0, 50));
    };
    const onReview = (event: Event) => {
      const review = (event as CustomEvent<TerminalReviewRequest>).detail;
      if (review.workspaceId !== workspaceId || review.terminalSessionId !== selectedTerminalId) return;
      setReviews((current) => upsertReview(current, review));
    };
    window.addEventListener("crewdeck:terminal-bridge", onBridge);
    window.addEventListener("crewdeck:terminal-decision", onDecision);
    window.addEventListener("crewdeck:terminal-activity", onActivity);
    window.addEventListener("crewdeck:terminal-review", onReview);
    return () => {
      window.removeEventListener("crewdeck:terminal-bridge", onBridge);
      window.removeEventListener("crewdeck:terminal-decision", onDecision);
      window.removeEventListener("crewdeck:terminal-activity", onActivity);
      window.removeEventListener("crewdeck:terminal-review", onReview);
    };
  }, [selectedTerminalId, workspaceId]);

  const selectGoal = async (nextGoalId: string) => {
    setSelectedGoalId(nextGoalId);
    setActionError(null);
    if (!workspaceId) return;
    try {
      await api.workspaces.selectGoal(workspaceId, nextGoalId);
      // 진행 중 태스크가 물린 터미널의 바인딩은 목표 전환으로 풀지 않는다 — 보기만 바꾼다.
      const busy = selectedTerminal?.activeTaskId
        && IN_FLIGHT_STATUSES.includes(selectedTerminal.activeTaskStatus ?? "");
      if (selectedTerminal?.status === "active" && !busy) {
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

  /** 태스크를 물릴 터미널을 고른다 — 진행 중 태스크가 있는 터미널은 절대 뺏지 않고,
   *  담당 에이전트가 다른 터미널도 재사용하지 않는다(구현·검증 분리 유지). desiredAgentId가
   *  현재/free 터미널과 안 맞으면 새 터미널을 띄워 그 에이전트로 착수하게 한다. */
  const resolveTargetTerminal = async (desiredAgentId?: string | null): Promise<TerminalSession> => {
    const inFlight = (session: TerminalSession) =>
      session.activeTaskId !== null && IN_FLIGHT_STATUSES.includes(session.activeTaskStatus ?? "");
    // 미배정 태스크(desiredAgentId 없음)이거나 터미널이 미바인딩이면 어느 에이전트든 호환.
    const agentFits = (session: TerminalSession) =>
      !desiredAgentId || !session.agentId || session.agentId === desiredAgentId;
    if (selectedTerminal?.status === "active" && !inFlight(selectedTerminal) && agentFits(selectedTerminal)) return selectedTerminal;
    const free = activeSessions.find(
      (session) => session.id !== selectedTerminal?.id
        && (!session.activeTaskId || session.activeTaskStatus === "done")
        && agentFits(session),
    );
    if (free) return free;
    if (!workspaceId) throw new Error(t("workspaceTerminalRequiredForTask"));
    const created = await api.terminals.create({ workspaceId, cols: 120, rows: 32, forceNew: true });
    window.dispatchEvent(new CustomEvent("crewdeck:terminal-opened", { detail: created }));
    return created;
  };

  const bindTask = async (task: WorkspaceTask) => {
    setActionError(null);
    // 이미 다른 터미널에 물린 태스크는 바인딩을 뺏지 않고 그 탭으로 이동한다.
    const holder = activeSessions.find((session) => session.activeTaskId === task.id);
    if (holder) {
      window.dispatchEvent(new CustomEvent("crewdeck:terminal-focus", { detail: { terminalId: holder.id } }));
      return;
    }
    setActionBusy(`task-${task.id}`);
    try {
      const target = await resolveTargetTerminal(task.assignee_id);
      const terminal = await api.terminals.bind(target.id, {
        goalId: task.goal_id,
        taskId: task.id,
        agentId: task.assignee_id ?? target.agentId ?? agentId ?? null,
      });
      setSelectedTerminal(terminal);
      window.dispatchEvent(new CustomEvent("crewdeck:terminal-binding", { detail: terminal }));
      window.dispatchEvent(new CustomEvent("crewdeck:terminal-focus", { detail: { terminalId: terminal.id } }));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
    } finally {
      setActionBusy(null);
    }
  };

  /** 목록에서 지목한 태스크를 곧바로 착수한다 — 수임 + provider 실행이 한 호출(start-next)로 끝난다. */
  const startTask = async (task: WorkspaceTask) => {
    setActionError(null);
    setActionBusy(`start-${task.id}`);
    try {
      const holder = activeSessions.find((session) => session.activeTaskId === task.id);
      const target = holder ?? await resolveTargetTerminal(task.assignee_id);
      const result = await api.terminals.startNext(target.id, {
        taskId: task.id,
        goalId: task.goal_id,
        agentId: task.assignee_id ?? target.agentId ?? agentId ?? null,
        provider: target.provider,
      });
      if (result.terminal) {
        setSelectedTerminal(result.terminal);
        window.dispatchEvent(new CustomEvent("crewdeck:terminal-binding", { detail: result.terminal }));
      }
      refresh();
      window.dispatchEvent(new CustomEvent("crewdeck:terminal-focus", { detail: { terminalId: target.id } }));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceNoReadyTask"));
    } finally {
      setActionBusy(null);
    }
  };

  /** goal에서 지금 착수 가능한 다음 태스크 — 서버 우선순위 큐와 같은 순서(priority→sort_order),
   *  의존성 충족·다른 터미널에 안 물린 todo만. 담당 에이전트 라우팅은 startTask가 처리한다. */
  const nextReadyTask = (): WorkspaceTask | null => {
    const byId = new Map(selectedGoalTasks.map((task) => [task.id, task]));
    const depsDone = (task: WorkspaceTask): boolean => {
      let deps: string[] = [];
      try {
        const parsed = JSON.parse(task.depends_on ?? "[]");
        if (Array.isArray(parsed)) deps = parsed.filter((value): value is string => typeof value === "string");
      } catch { return false; }
      return deps.every((id) => {
        const dep = byId.get(id);
        return !dep || dep.status === "done" || dep.status === "skipped";
      });
    };
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return [...selectedGoalTasks]
      .filter((task) => task.status === "todo" && !taskTerminals.has(task.id) && depsDone(task))
      .sort((a, b) => (rank[a.priority ?? "medium"] ?? 2) - (rank[b.priority ?? "medium"] ?? 2)
        || (a.sort_order ?? 0) - (b.sort_order ?? 0))[0] ?? null;
  };

  const startOrContinue = async () => {
    if (!selectedGoalId) return;
    // 진행 중/blocked 태스크가 이 터미널에 물려 있으면 같은 대화를 이어간다(터미널 유지).
    if (isContinuingTask && selectedTerminal) {
      if (contextState !== "connected") {
        setActionError(t("terminalContextMismatch"));
        return;
      }
      setActionBusy("start");
      setActionError(null);
      try {
        const result = await api.terminals.startNext(selectedTerminal.id, {
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
      return;
    }
    // 새로 시작 — goal의 다음 ready 태스크를 담당 에이전트 터미널로 라우팅한다.
    // startTask가 resolveTargetTerminal로 호환 터미널 재사용/새 터미널 spawn을 결정한다.
    const next = nextReadyTask();
    if (!next) {
      setActionError(t("workspaceNoReadyTask"));
      return;
    }
    await startTask(next);
  };

  const executeReview = async (review: TerminalReviewRequest, retry: boolean) => {
    if (!selectedTerminal) return;
    setActionBusy("verify");
    setActionError(null);
    setReviews((current) => upsertReview(current, { ...review, status: "running" }));
    try {
      const result = await api.terminals.verifyReview(selectedTerminal.id, review.id, retry);
      setReviews((current) => upsertReview(current, result.review));
      await syncTerminal(selectedTerminal.id);
      refresh();
    } catch (cause) {
      setReviews((current) => upsertReview(current, review));
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
    } finally {
      setActionBusy(null);
    }
  };

  const requestCompletion = async () => {
    if (!selectedTerminal || !boundTask) return;
    setActionBusy("completion");
    setActionError(null);
    try {
      const taskActivities = activities.filter((activity) => activity.taskId === boundTask.id);
      const changedFiles = [...new Set(taskActivities
        .filter((activity) => activity.kind === "file_changed")
        .flatMap((activity) => metadataStrings(activity.metadata, ["path", "file", "files", "changedFiles"])))];
      const verificationCommands = [...new Set(taskActivities
        .filter((activity) => activity.kind === "verification_run")
        .flatMap((activity) => metadataStrings(activity.metadata, ["command", "commands"])))];
      const result = await api.terminals.requestCompletion(selectedTerminal.id, {
        summary: t("workspaceCompletionSummary", { task: boundTask.title }),
        changedFiles,
        verificationCommands,
        idempotencyKey: `completion:${boundTask.id}:${boundTask.verification_id ?? "initial"}`,
      });
      setReviews((current) => upsertReview(current, result.review));
      refresh();
      await executeReview(result.review, false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("workspaceGoalActionFailed"));
      setActionBusy(null);
    }
  };

  const runQualityGate = async () => {
    if (!currentReview) {
      setActionError(t("workspaceReviewMissing"));
      return;
    }
    await executeReview(currentReview, ["conditional", "error", "timeout"].includes(currentReview.status));
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

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => workspaceCloseRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const previousPanel = previousCompactPanelRef.current;
    previousCompactPanelRef.current = compactPanel;
    if (compactPanel) {
      const frame = window.requestAnimationFrame(() => {
        (compactPanel === "execution" ? executionCloseRef.current : decisionCloseRef.current)?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (previousPanel) {
      const frame = window.requestAnimationFrame(() => {
        (previousPanel === "execution" ? executionTriggerRef.current : decisionTriggerRef.current)?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [compactPanel]);

  const handleWorkspaceKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (compactPanel) setCompactPanel(null);
      else onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusRoot = compactPanel === "execution"
      ? executionCloseRef.current?.closest<HTMLElement>("#workspace-execution-panel")
      : compactPanel === "decisions"
        ? decisionCloseRef.current?.closest<HTMLElement>("#workspace-decision-panel")
        : workspaceDialogRef.current;
    const focusable = Array.from(focusRoot?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-workspace-title"
        ref={workspaceDialogRef}
        className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-canvas"
        onClick={onClose}
        onKeyDown={handleWorkspaceKeyDown}
      >
        <div className="flex h-full w-full flex-col overflow-hidden bg-surface" onClick={(event) => event.stopPropagation()}>
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-line-soft bg-elevated px-3">
            <div className="flex min-w-0 items-center gap-2">
              <Target size={17} weight="duotone" className="shrink-0 text-accent" />
              <span id="session-workspace-title" className="truncate text-sm font-semibold text-fg">{project?.name ?? t("wsTitle")}</span>
              <span className="hidden text-faint sm:inline">/</span>
              <span className="hidden max-w-52 truncate text-xs text-muted sm:inline">{workspaceName ?? t("wsTitle")}</span>
              {worktreeBranch && (
                <span className="hidden max-w-60 items-center gap-1 rounded bg-sunken px-2 py-0.5 font-mono text-[10px] text-muted xl:flex">
                  <GitBranch size={12} /> <span className="truncate">{worktreeBranch}</span>
                </span>
              )}
              <span role="status" aria-live="polite" className={`flex shrink-0 items-center gap-1 text-[10px] ${contextState === "connected" ? "text-success" : contextState === "mismatch" ? "text-danger" : "text-faint"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${contextState === "connected" ? "bg-success" : contextState === "mismatch" ? "bg-danger" : "bg-faint"}`} />
                {t(`terminalContext_${contextState}`)}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("crewdeck:open-help"))} aria-label={t("helpTitle")} className="rounded p-1.5 text-faint hover:bg-fg/5 hover:text-fg"><Question size={16} /></button>
              <button ref={workspaceCloseRef} type="button" onClick={onClose} aria-label={t("close")} className="rounded p-1.5 text-faint hover:bg-fg/5 hover:text-fg"><X size={17} /></button>
            </div>
          </header>

          <nav aria-label={t("wsTitle")} className="flex h-10 shrink-0 items-center justify-end gap-2 border-b border-line-soft bg-elevated px-3 xl:hidden">
            <button
              ref={executionTriggerRef}
              type="button"
              aria-expanded={compactPanel === "execution"}
              aria-controls="workspace-execution-panel"
              onClick={() => setCompactPanel((current) => current === "execution" ? null : "execution")}
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[10px] font-medium text-muted hover:border-accent hover:text-accent lg:hidden"
            >
              <Target size={13} />{t("workspaceExecutionMap")}
            </button>
            <button
              ref={decisionTriggerRef}
              type="button"
              aria-expanded={compactPanel === "decisions"}
              aria-controls="workspace-decision-panel"
              onClick={() => setCompactPanel((current) => current === "decisions" ? null : "decisions")}
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[10px] font-medium text-muted hover:border-accent hover:text-accent"
            >
              <WarningCircle size={13} />{t("workspaceDecisionInbox")}
              {blockedTasks.length > 0 && <span className="rounded-full bg-danger/10 px-1.5 font-mono text-[9px] text-danger">{blockedTasks.length}</span>}
            </button>
          </nav>

          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {compactPanel && (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={() => setCompactPanel(null)}
                className="absolute inset-0 z-10 bg-black/55 xl:hidden"
              />
            )}
            <aside
              id="workspace-execution-panel"
              role={compactPanel === "execution" ? "dialog" : undefined}
              aria-modal={compactPanel === "execution" ? "true" : undefined}
              aria-label={t("workspaceExecutionMap")}
              className={`${compactPanel === "execution" ? "absolute inset-y-0 left-0 z-20 flex w-[min(88vw,286px)] shadow-2xl" : "hidden"} shrink-0 flex-col border-r border-line-soft bg-elevated lg:static lg:z-auto lg:flex lg:w-[286px] lg:shadow-none`}
            >
              <div className="border-b border-line-soft p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint"><Target size={13} />{t("workspaceExecutionMap")}</div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setShowGoalComposer(true)} className="rounded p-1 text-accent hover:bg-accent/10" aria-label={t("workspaceNewGoal")}><Plus size={14} weight="bold" /></button>
                    <button ref={executionCloseRef} type="button" onClick={() => setCompactPanel(null)} aria-label={`${t("close")} ${t("workspaceExecutionMap")}`} className="rounded p-1 text-faint hover:bg-fg/5 hover:text-fg lg:hidden"><X size={14} /></button>
                  </div>
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
                <div className="mt-2 grid grid-cols-2 gap-1">
                  <button type="button" onClick={() => selectedGoal && setSpecGoalId(selectedGoal.id)} className="flex items-center justify-center gap-1 rounded border border-line px-1 py-1.5 text-[9px] text-muted hover:border-accent hover:text-accent"><Blueprint size={12} />{t("workspacePlan")}</button>
                  <button type="button" onClick={() => setShowTaskGraph(true)} disabled={!selectedGoal} className="flex items-center justify-center gap-1 rounded border border-line px-1 py-1.5 text-[9px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"><GitBranch size={12} />{t("workspaceTaskGraph")}</button>
                  <button type="button" onClick={() => void decomposeGoal()} disabled={!selectedGoal || actionBusy !== null} className="rounded border border-line px-1 py-1.5 text-[9px] text-muted hover:border-accent hover:text-accent disabled:opacity-40">{t("workspaceSplitTasks")}</button>
                  <button type="button" onClick={() => setShowAddTask(true)} disabled={!selectedGoal || actionBusy !== null} className="flex items-center justify-center gap-1 rounded border border-line px-1 py-1.5 text-[9px] text-muted hover:border-accent hover:text-accent disabled:opacity-40"><Plus size={11} />{t("workspaceTask")}</button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                <div className="space-y-1.5">
                  {taskOrder.map((task, index) => {
                    const assignee = projectAgents.find((item) => item.id === task.assignee_id);
                    const boundSession = taskTerminals.get(task.id) ?? null;
                    const boundToSelected = boundSession !== null && boundSession.id === selectedTerminal?.id;
                    return (
                      <div
                        key={task.id}
                        className={`group flex w-full items-stretch rounded-md border transition-colors ${boundToSelected ? "border-accent/60 bg-accent/10" : boundSession ? "border-line bg-fg/[0.04]" : "border-transparent bg-fg/[0.025] hover:border-line hover:bg-fg/[0.04]"}`}
                      >
                        <button
                          type="button"
                          onClick={() => { setCompactPanel(null); void bindTask(task); }}
                          title={boundSession ? t("workspaceTaskBoundTab", { tab: t("terminalTab", { count: boundSession.tabNumber }) }) : undefined}
                          className="min-w-0 flex-1 px-2.5 py-2 text-left"
                        >
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 text-sm">{statusIcon(task.status)}</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[9px] text-faint">{String(index + 1).padStart(2, "0")}</span>
                                <span className="truncate text-[11px] font-medium text-fg">{task.title}</span>
                                {boundSession && (
                                  <span className={`flex shrink-0 items-center gap-0.5 rounded px-1 font-mono text-[8px] ${boundToSelected ? "bg-accent/15 text-accent" : "bg-fg/10 text-muted"}`}>
                                    <TerminalWindow size={9} />{boundSession.tabNumber}
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-2">
                                <span className="truncate text-[9px] text-faint">{assignee?.name ?? t("workspaceUnassigned")}</span>
                                <span className={`text-[9px] ${STATUS_STYLES[task.status]?.text ?? "text-muted"}`}>{t(`taskStatus_${task.status}`)}</span>
                              </div>
                            </div>
                          </div>
                        </button>
                        {task.status === "todo" && (
                          <button
                            type="button"
                            onClick={() => void startTask(task)}
                            disabled={actionBusy !== null}
                            className="mr-2 hidden shrink-0 items-center gap-1 self-center rounded-md border border-accent/40 px-2 py-1 text-[9px] font-medium text-accent hover:bg-accent/10 disabled:opacity-40 group-hover:flex"
                          >
                            {actionBusy === `start-${task.id}` ? <SpinnerGap size={10} className="animate-spin" /> : t("workspaceStartTask")}
                          </button>
                        )}
                      </div>
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
              <div className="flex min-h-[58px] shrink-0 flex-col gap-2 border-b border-line-soft bg-surface px-3 py-2 sm:h-[58px] sm:flex-row sm:items-center sm:gap-3 sm:py-0">
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
                <div className="flex shrink-0 items-center justify-end gap-1.5">
                  {boundTaskStatus === "in_progress" && <button type="button" onClick={() => void requestCompletion()} disabled={actionBusy !== null} className="rounded-md border border-[#a78bfa]/40 px-2.5 py-1.5 text-[10px] font-medium text-[#a78bfa] hover:bg-[#a78bfa]/10 disabled:opacity-40">{t("workspaceRequestReview")}</button>}
                  {boundTaskStatus === "in_review" && <button type="button" onClick={() => void runQualityGate()} disabled={actionBusy !== null || currentReview?.status === "running"} className="flex items-center gap-1 rounded-md bg-[#a78bfa] px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-[#9271ee] disabled:opacity-40">{actionBusy === "verify" || currentReview?.status === "running" ? <SpinnerGap size={13} className="animate-spin" /> : <ShieldCheck size={13} />}{currentReview && ["conditional", "error", "timeout"].includes(currentReview.status) ? t("workspaceRetryQualityGate") : currentReview?.status === "running" ? t("workspaceReviewRunning") : t("workspaceRunQualityGate")}</button>}
                  {canStartOrContinue && <button type="button" onClick={() => void startOrContinue()} disabled={!selectedTerminal || !selectedGoalId || contextState !== "connected" || actionBusy !== null} className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-accent-hover disabled:opacity-40">{actionBusy === "start" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowRight size={13} />}{isContinuingTask ? t("workspaceContinueTask") : t("workspaceClaimNext")}</button>}
                </div>
              </div>
              {actionError && <div role="alert" aria-live="assertive" className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-2 text-[10px] text-danger">{actionError}</div>}
              <div className="min-h-0 flex-1">
                {workspaceId ? (
                  <WorkspaceTerminal
                    workspaceId={workspaceId}
                    activeGoalId={selectedGoalId}
                    onContextStateChange={setContextState}
                    onSessionChange={setSelectedTerminal}
                    onSessionsChange={setTerminalSessions}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center bg-terminal text-xs text-terminal-muted">{t("terminalWorkspaceRequired")}</div>
                )}
              </div>
            </main>

            {/* 인스펙터는 6탭이라 330px에서는 탭 라벨이 줄바꿈된다 — 관찰 모드에서만 폭을 넓힌다. */}
            <aside
              id="workspace-decision-panel"
              role={compactPanel === "decisions" ? "dialog" : undefined}
              aria-modal={compactPanel === "decisions" ? "true" : undefined}
              aria-label={t("workspaceDecisionInbox")}
              className={`${compactPanel === "decisions" ? "absolute inset-y-0 right-0 z-20 flex w-[min(90vw,330px)] shadow-2xl" : "hidden"} shrink-0 flex-col bg-elevated xl:static xl:z-auto xl:flex ${rightPane === "inspector" ? "xl:w-[400px]" : "xl:w-[330px]"} xl:shadow-none`}
            >
              <div className="flex shrink-0 items-center border-b border-line-soft">
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
                <button ref={decisionCloseRef} type="button" onClick={() => setCompactPanel(null)} aria-label={`${t("close")} ${t("workspaceDecisionInbox")}`} className="mr-1 shrink-0 rounded p-1 text-faint hover:bg-fg/5 hover:text-fg xl:hidden"><X size={14} /></button>
              </div>

              {rightPane === "inspector" ? (
                <div className="min-h-0 flex-1">
                  <InspectorTabs
                    goalId={selectedGoalId}
                    workspaceId={workspaceId}
                    projectId={currentProjectId}
                    onSelectGoal={setSelectedGoalId}
                  />
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
                        <div className="mt-2 flex items-center justify-between border-t border-danger/15 pt-2"><span className="text-[9px] text-faint">{assignee?.name ?? t("workspaceUnassigned")}</span><button type="button" onClick={() => { setCompactPanel(null); void bindTask(task); }} className="flex items-center gap-1 rounded-md bg-danger px-2 py-1.5 text-[9px] font-semibold text-white hover:bg-danger/90"><TerminalWindow size={12} />{t("workspaceResolveWithAgent")}</button></div>
                      </article>
                    );
                  })}
                  {blockedTasks.length === 0 && (
                    <div className="rounded-lg border border-dashed border-line p-5 text-center"><CheckCircle size={24} weight="duotone" className="mx-auto text-success" /><p className="mt-2 text-[10px] font-medium text-muted">{t("workspaceNoDecisions")}</p><p className="mt-1 text-[9px] leading-4 text-faint">{t("workspaceNoDecisionsHelp")}</p></div>
                  )}
                </div>

                <div className="mt-5">
                  <TerminalEvidencePanel activities={activities} review={currentReview} />
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
      {showTaskGraph && selectedGoal && (
        <WorkspaceTaskGraph
          goalId={selectedGoal.id}
          agents={projectAgents}
          onClose={() => setShowTaskGraph(false)}
          onOpenBlueprint={() => { setShowTaskGraph(false); setSpecGoalId(selectedGoal.id); }}
          onChanged={refresh}
        />
      )}
      {specGoalId && <GoalSpecPanel goalId={specGoalId} goalTitle={projectGoals.find((item) => item.id === specGoalId)?.title} onClose={() => { setSpecGoalId(null); refresh(); }} />}
      {showAddTask && <InputDialog title={t("workspaceAddTask")} onSubmit={(value) => void addTask(value)} onCancel={() => setShowAddTask(false)} />}
      {confirmRedecompose && <ConfirmDialog message={t("reDecomposeConfirm", { count: selectedGoalTasks.length })} onConfirm={() => void decomposeGoal()} onCancel={() => setConfirmRedecompose(false)} />}
      {showAddAgent && currentProjectId && <AddAgentDialog projectId={currentProjectId} mission={project?.mission} goal={selectedGoal ? { id: selectedGoal.id, title: selectedGoal.title, description: selectedGoal.description } : null} existingAgents={projectAgents} onCreated={refresh} onClose={() => { setShowAddAgent(false); refresh(); }} />}
      {showOrgChart && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4" onClick={() => setShowOrgChart(false)}>
          <section role="dialog" aria-modal="true" aria-labelledby="workspace-org-title" className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <header className="flex items-center justify-between border-b border-line px-5 py-3"><h2 id="workspace-org-title" className="text-sm font-semibold text-fg">{t("workspaceOrgTitle")}</h2><button type="button" onClick={() => setShowOrgChart(false)} aria-label={t("close")} className="rounded p-1 text-faint hover:bg-fg/5"><X size={16} /></button></header>
            <div className="min-h-0 flex-1 overflow-auto p-4"><OrgChart agents={projectAgents} tasks={tasks} onAddAgent={() => setShowAddAgent(true)} onAgentDeleted={refreshAgents} onAgentKilled={refreshAgents} /></div>
          </section>
        </div>
      )}
      {selectedAgent && <AgentDetail agent={selectedAgent} agents={projectAgents} tasks={tasks} onClose={() => setSelectedAgentId(null)} onKill={refreshAgents} onDeleted={refreshAgents} />}
    </>
  );
}
