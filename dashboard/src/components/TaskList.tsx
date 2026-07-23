import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api, guardMutation } from "../lib/api";
import { TaskDetail } from "./TaskDetail";
import { RejectDialog } from "./RejectDialog";
import { useToast } from "../stores/useToast";

const STATUSES = ["pending_approval", "todo", "in_progress", "in_review", "done", "blocked", "skipped"];

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending_approval: "statusPendingApproval",
  todo: "statusTodo",
  in_progress: "statusInProgress",
  in_review: "statusInReview",
  done: "statusDone",
  blocked: "statusBlocked",
  skipped: "statusSkipped",
};

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  pending_approval: { color: "text-warning", bg: "bg-warning-subtle" },
  todo: { color: "text-muted", bg: "bg-sunken" },
  in_progress: { color: "text-accent", bg: "bg-accent/10" },
  in_review: { color: "text-review", bg: "bg-review-subtle" },
  done: { color: "text-success", bg: "bg-success-subtle" },
  blocked: { color: "text-danger", bg: "bg-danger-subtle" },
  // skipped = 실패도 완료도 아닌 terminal — done(성공 초록)과 시각적으로 구분되는 뉴트럴 톤
  skipped: { color: "text-muted", bg: "bg-sunken" },
};

// 로컬 착수(run 클릭) 후 서버가 태스크를 in_progress 로 넘길 때까지의 낙관적 유예(ms).
// 이 안에서는 아직 todo/blocked 여도 "실행 중" 배지를 유지하고, 넘기면 디스패치 실패로 보고 내린다.
const DISPATCH_GRACE_MS = 20000;

interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: string;
  assignee_id: string | null;
  parent_task_id?: string | null;
  origin_task_id?: string | null;
  goal_id?: string;
  depends_on?: string | null;
  verification_id: string | null;
  verification_verdict?: string | null;
  verification_issues?: string | null;
  result_summary?: string | null;
  skip_reason?: string | null;
  retry_count?: number;
  reassign_count?: number;
  retry_limit?: number;
  token_usage?: number;
  cost_usd?: number;
}

interface TaskListProps {
  tasks: TaskItem[];
  agents: Array<{ id: string; name: string; role?: string; status?: string; current_task_id?: string | null }>;
  projectId?: string;
  onUpdate?: () => void;
  autopilotMode?: string; // 'off' | 'goal' | 'full'
  onAddGoal?: () => void;
  /** 미승인 spec으로 실행이 차단됐을 때 해당 goal의 승인 화면(Blueprint)을 여는 콜백. */
  onOpenSpec?: (goalId: string) => void;
  /** 완료(반영까지 끝난) goal의 id — 소속 terminal 태스크를 기본 접힘 처리한다. */
  completedGoalIds?: Set<string>;
}

/** 미승인 spec(spec_not_approved 409)으로 실행이 막힌 태스크의 안내 정보. */
interface SpecBlock {
  goalId: string | null;
  message: string;
  currentDraftVersion: number | null;
  specStatus?: string;
}

const DONE_PREVIEW_COUNT = 5;

/** 토큰 수를 짧게 (1.2M / 340K / 512). 태스크가 얼마나 헤맸는지의 프록시. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  return arr.reduce<Record<string, T[]>>((acc, item) => {
    const k = String(item[key]);
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}

export function TaskList({ tasks, agents, projectId, onUpdate, autopilotMode = "off", onAddGoal, onOpenSpec, completedGoalIds }: TaskListProps) {
  const isAutopilot = autopilotMode !== "off";
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [runningTasks, setRunningTasks] = useState<Set<string>>(new Set());
  const [verifyingTasks, setVerifyingTasks] = useState<Set<string>>(new Set());
  const [elapsedSeconds, setElapsedSeconds] = useState<Record<string, number>>({});
  const [assigningTaskId, setAssigningTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [rejectingTask, setRejectingTask] = useState<{ id: string; title: string } | null>(null);
  const [taskUsage, setTaskUsage] = useState<Map<string, { costUsd: number; totalTokens: number }>>(new Map());
  const [showAllDone, setShowAllDone] = useState(false);
  const [showArchivedTasks, setShowArchivedTasks] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  // 미승인 spec으로 차단된 실행 — taskId별 차단 사유 + 승인 동선
  const [specBlocks, setSpecBlocks] = useState<Record<string, SpecBlock>>({});

  const agentMap = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a])), [agents]);

  // 대기 사유 판정용 인덱스 — "병렬인데 왜 하나만 도나"를 화면이 직접 설명한다
  const taskById = useMemo(() => Object.fromEntries(tasks.map((tk) => [tk.id, tk])), [tasks]);
  const busyAgentIds = useMemo(
    () => new Set(agents.filter((a) => a.status === "working").map((a) => a.id)),
    [agents],
  );
  const activeGoalIds = useMemo(
    () =>
      new Set(
        tasks
          .filter((tk) => tk.status === "in_progress" || tk.status === "in_review")
          .map((tk) => tk.goal_id)
          .filter(Boolean),
      ),
    [tasks],
  );

  // todo 태스크가 실행되지 않는 이유 (우선순위: 선행 의존 → goal 내부 순차 → 담당자 점유)
  const waitReason = (task: TaskItem): { label: string; hint: string } | null => {
    if (task.status !== "todo") return null;
    let deps: string[] = [];
    try {
      const parsed = JSON.parse(task.depends_on ?? "[]");
      deps = Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
    } catch { /* malformed deps → 무시 */ }
    const pending = deps.map((id) => taskById[id]).filter((d) => d && d.status !== "done" && d.status !== "skipped");
    if (pending.length > 0) {
      return {
        label: t("waitDeps", { count: pending.length }),
        hint: `${t("waitDepsHint")}: ${pending.map((d) => d.title).join(", ").slice(0, 200)}`,
      };
    }
    if (task.goal_id && activeGoalIds.has(task.goal_id)) {
      return { label: t("waitGoalSerial"), hint: t("waitGoalSerialHint") };
    }
    if (task.assignee_id && busyAgentIds.has(task.assignee_id)) {
      const agentName = agentMap[task.assignee_id]?.name ?? "";
      return { label: t("waitAgentBusy"), hint: `${t("waitAgentBusyHint")} (${agentName})` };
    }
    return null;
  };

  // Separate root tasks and children — 위임 subtask(parent_task_id)와 fix task(origin_task_id)를
  // 모두 원본 밑에 묶는다. fix의 origin이 현재 목록에 없으면(필터/페이지 밖) 고아가 되지 않게 root로 둔다.
  const rootTasks = useMemo(
    () => tasks.filter((t) => !t.parent_task_id && !(t.origin_task_id && taskById[t.origin_task_id])),
    [tasks, taskById],
  );
  const subtaskMap = useMemo(() => {
    const map: Record<string, TaskItem[]> = {};
    for (const t of tasks) {
      const parent = t.parent_task_id
        ?? (t.origin_task_id && taskById[t.origin_task_id] ? t.origin_task_id : null);
      if (parent) {
        if (!map[parent]) map[parent] = [];
        map[parent].push(t);
      }
    }
    return map;
  }, [tasks, taskById]);

  // 완료(반영까지 끝난) goal의 terminal 태스크는 기본 접힘 — 지나간 목표의 결과가 개요를 덮지 않게.
  // done/skipped만 대상: 완료 goal이라도 사용자 액션이 남은 상태(in_review·pending_approval 등)는 항상 노출한다.
  const archivedTaskIds = useMemo(() => {
    const ids = new Set<string>();
    if (!completedGoalIds?.size) return ids;
    for (const t of rootTasks) {
      if ((t.status === "done" || t.status === "skipped") && t.goal_id && completedGoalIds.has(t.goal_id)) {
        ids.add(t.id);
      }
    }
    return ids;
  }, [rootTasks, completedGoalIds]);
  const visibleRootTasks = useMemo(
    () => (showArchivedTasks ? rootTasks : rootTasks.filter((t) => !archivedTaskIds.has(t.id))),
    [rootTasks, archivedTaskIds, showArchivedTasks],
  );

  const groupedTasks = useMemo(() => groupBy(visibleRootTasks, "status"), [visibleRootTasks]);

  const toggleExpand = (taskId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

  const isSearching = globalSearch.trim() !== "";
  const searchTerm = globalSearch.trim().toLowerCase();

  // Per-task interval refs for elapsed time counters
  const intervalsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  // 로컬 착수 시각(ms) — todo/blocked 상태를 "실행 중"으로 유지할 낙관적 창구를 재는 데 쓴다.
  const runStartRef = useRef<Record<string, number>>({});

  // Accumulate usage per task from WebSocket events
  useEffect(() => {
    const handler = (e: Event) => {
      const payload = (e as CustomEvent<{
        taskId: string;
        usage?: {
          totalCostUsd?: number;
          inputTokens?: number;
          outputTokens?: number;
          cacheCreationTokens?: number;
        };
        cumulative?: { totalTokens?: number; costUsd?: number } | null;
      }>).detail;
      if (!payload.taskId) return;
      const u = payload.usage;
      const roundCost = u?.totalCostUsd ?? 0;
      const roundTokens = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.cacheCreationTokens ?? 0);
      setTaskUsage((prev) => {
        const next = new Map(prev);
        if (payload.cumulative) {
          // 완료 이벤트: DB 누적 총량을 절대값으로 반영 (fix 라운드 포함)
          next.set(payload.taskId, {
            costUsd: payload.cumulative.costUsd ?? 0,
            totalTokens: payload.cumulative.totalTokens ?? 0,
          });
        } else {
          // 라운드별 이벤트: 기존값에 누적 (여러 fix 라운드가 쌓이도록)
          const cur = prev.get(payload.taskId) ?? { costUsd: 0, totalTokens: 0 };
          next.set(payload.taskId, {
            costUsd: cur.costUsd + roundCost,
            totalTokens: cur.totalTokens + roundTokens,
          });
        }
        return next;
      });
    };
    window.addEventListener("crewdeck:task-usage", handler);
    return () => window.removeEventListener("crewdeck:task-usage", handler);
  }, []);

  // Clear timers for tasks that are no longer running (status changed via WebSocket)
  useEffect(() => {
    const handler = () => {
      // When a refresh arrives, tasks prop will update — stop timers for completed tasks
      setRunningTasks((prev) => {
        const stillRunning = new Set<string>();
        prev.forEach((id) => {
          const task = tasks.find((t) => t.id === id);
          // in_progress = 실제 집행 중. todo/blocked 는 클릭 직후 서버가 아직 in_progress 로
          // 안 넘긴 낙관적 창구(DISPATCH_GRACE_MS) 안에서만 유지한다 — 그 창구를 넘겨도 여전히
          // todo/blocked 면 디스패치 실패·실패후 리셋이므로 배지·타이머를 내린다(실측: headless
          // handoff 실패로 todo 리셋된 태스크가 27분간 "실행 중 1624초" 로 남았다).
          const startedAt = runStartRef.current[id];
          const withinGrace = startedAt != null && Date.now() - startedAt < DISPATCH_GRACE_MS;
          const stillActive = !!task && (
            task.status === "in_progress"
            || ((task.status === "todo" || task.status === "blocked") && withinGrace)
          );
          if (stillActive) {
            stillRunning.add(id);
          } else {
            clearInterval(intervalsRef.current[id]);
            delete intervalsRef.current[id];
            delete runStartRef.current[id];
          }
        });
        return stillRunning;
      });
      // Clear verifying state for tasks that now have verification or changed status
      setVerifyingTasks((prev) => {
        const still = new Set<string>();
        prev.forEach((id) => {
          const task = tasks.find((t) => t.id === id);
          if (task && task.status === "in_review" && !task.verification_id) {
            still.add(id);
          }
        });
        return still;
      });
      // Drop spec-block notices once the task actually leaves todo/blocked (e.g. spec approved → running)
      setSpecBlocks((prev) => {
        const ids = Object.keys(prev);
        if (ids.length === 0) return prev;
        const next: Record<string, SpecBlock> = {};
        let changed = false;
        for (const id of ids) {
          const task = tasks.find((t) => t.id === id);
          if (task && (task.status === "todo" || task.status === "blocked")) next[id] = prev[id];
          else changed = true;
        }
        return changed ? next : prev;
      });
    };
    window.addEventListener("crewdeck:refresh", handler);
    return () => window.removeEventListener("crewdeck:refresh", handler);
  }, [tasks]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      Object.values(intervalsRef.current).forEach(clearInterval);
    };
  }, []);

  const handleTaskClick = (e: React.MouseEvent, taskId: string) => {
    const target = e.target as HTMLElement;
    if (target.closest("select") || target.closest("button")) return;
    setSelectedTaskId(taskId);
  };

  const handleStatusChange = async (taskId: string, newStatus: string) => {
    try {
      await api.tasks.update(taskId, { status: newStatus });
      onUpdate?.();
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : undefined;
      showToast(t("taskStatusUpdateFailed"), "error", detail);
    }
  };

  // 재작업: 이월된(done+fail) 태스크를 다시 열어(todo) 재실행 — 실패 이력 + 교차 백엔드 수정으로 재해결 시도.
  const handleRework = async (taskId: string) => {
    try {
      await api.tasks.update(taskId, { status: "todo" });
      showToast(t("reworkStarted"), "info");
      onUpdate?.();
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : undefined;
      showToast(t("taskStatusUpdateFailed"), "error", detail);
    }
  };

  // 실행 로컬 상태(pulse + elapsed timer)를 즉시 종료 — 서버가 실행을 시작하지 못한 경우 정리한다.
  const stopRunningLocal = (taskId: string) => {
    if (intervalsRef.current[taskId]) {
      clearInterval(intervalsRef.current[taskId]);
      delete intervalsRef.current[taskId];
    }
    delete runStartRef.current[taskId];
    setRunningTasks((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
    setElapsedSeconds((prev) => {
      if (!(taskId in prev)) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  };

  const handleRunTask = async (taskId: string) => {
    // 재실행 시 이전 차단 안내는 걷어낸다
    setSpecBlocks((prev) => {
      if (!prev[taskId]) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
    setRunningTasks((prev) => new Set(prev).add(taskId));
    runStartRef.current[taskId] = Date.now();
    setElapsedSeconds((prev) => ({ ...prev, [taskId]: 0 }));
    intervalsRef.current[taskId] = setInterval(() => {
      setElapsedSeconds((prev) => ({ ...prev, [taskId]: (prev[taskId] ?? 0) + 1 }));
    }, 1000);
    try {
      await api.orchestration.executeTask(taskId);
    } catch (err: unknown) {
      // 승인 게이트 차단(409 spec_not_approved): WebSocket 이벤트가 오지 않으므로
      // 로컬 실행 상태·타이머를 직접 정리하고 차단 사유 + 승인 동선을 노출한다.
      if (err instanceof ApiError && err.code === "spec_not_approved") {
        stopRunningLocal(taskId);
        const data = err.data ?? {};
        const goalId = (typeof data.goalId === "string" ? data.goalId : undefined) ?? taskById[taskId]?.goal_id ?? null;
        const currentDraftVersion = typeof data.currentDraftVersion === "number" ? data.currentDraftVersion : null;
        const specStatus = typeof data.specStatus === "string" ? data.specStatus : undefined;
        setSpecBlocks((prev) => ({ ...prev, [taskId]: { goalId, message: err.message, currentDraftVersion, specStatus } }));
        showToast(t("specNotApprovedToast"), "error", err.message);
        return;
      }
      // 그 외 오류는 WebSocket으로 브로드캐스트된 상태가 UI를 정리한다
    }
  };

  const handleReject = async (taskId: string, feedback: string, autoRerun: boolean) => {
    setRejectingTask(null);
    const targetTask = tasks.find((t) => t.id === taskId);
    if (targetTask?.status === "pending_approval" && projectId) {
      await api.orchestration.rejectTask(projectId, taskId, feedback || undefined);
    } else {
      await api.tasks.reject(taskId, feedback || undefined);
    }
    onUpdate?.();

    if (autoRerun) {
      setTimeout(() => handleRunTask(taskId), 500);
    }
  };

  const handleAssignSelect = async (taskId: string, agentId: string) => {
    setAssigningTaskId(null);
    if (!agentId) return;
    await api.tasks.update(taskId, { assignee_id: agentId });
    onUpdate?.();
  };

  const renderTaskRow = (task: TaskItem, isSubtask = false) => {
    const isRunning = runningTasks.has(task.id);
    const seconds = elapsedSeconds[task.id] ?? 0;
    const liveUsage = taskUsage.get(task.id);
    // 영속값(task.token_usage — 새로고침에도 유지)과 라이브 이벤트 중 큰 값
    const totalTokens = Math.max(task.token_usage ?? 0, liveUsage?.totalTokens ?? 0);
    const costUsd = Math.max(task.cost_usd ?? 0, liveUsage?.costUsd ?? 0);
    const hasUsage = totalTokens > 0;
    const config = STATUS_COLORS[task.status] ?? STATUS_COLORS.todo;
    const childTasks = subtaskMap[task.id];
    const hasChildren = childTasks && childTasks.length > 0;
    const isExpanded = expandedParents.has(task.id);
    // 위임 부모의 실제 진행 상태 — 부모 status는 위임 동안 todo/in_progress로 남아
    // "멈춘 것처럼" 보이므로, 하위 작업 집계를 부모 행에 직접 표기한다
    const childDone = hasChildren ? childTasks.filter((c) => c.status === "done").length : 0;
    const childActive = hasChildren && childTasks.some((c) => c.status === "in_progress" || c.status === "in_review");

    return (
      <div key={task.id}>
        <div
          onClick={(e) => handleTaskClick(e, task.id)}
          className={`flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
            isSubtask ? "ml-6 border-dashed" : ""
          } ${
            isRunning
              ? "border-accent animate-pulse"
              : "border-line-soft hover:border-line"
          } ${config.bg}`}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {hasChildren && (
              <button
                onClick={(e) => { e.stopPropagation(); toggleExpand(task.id); }}
                aria-label={isExpanded ? t("collapseSubtasks") : t("expandSubtasks")}
                aria-expanded={isExpanded}
                className="text-faint hover:text-muted shrink-0 w-4 h-4 flex items-center justify-center"
              >
                <svg className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            )}
            {isSubtask && (
              <span className="text-faint text-xs shrink-0">└</span>
            )}
            <span className="text-sm text-fg truncate">{task.title}</span>
          {hasChildren && task.status !== "done" && task.status !== "skipped" && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
                childActive
                  ? "bg-accent/10 text-accent animate-pulse"
                  : "bg-sunken text-muted"
              }`}
              title={t("subtaskProgressHint")}
            >
              {childActive
                ? t("subtaskProgressActive", { done: childDone, total: childTasks.length })
                : t("subtaskProgress", { done: childDone, total: childTasks.length })}
            </span>
          )}
          {task.verification_verdict ? (() => {
            // done + fail = 미해결 이슈를 최종 QA로 이월한 상태(경보 아님). blocked + fail = 실제 막힘(빨강).
            const isCarried = task.status === "done" && task.verification_verdict === "fail";
            const cls = task.verification_verdict === "pass"
              ? "bg-success-subtle text-success"
              : isCarried
                ? "bg-warning-subtle text-warning"
                : task.verification_verdict === "fail"
                  ? "bg-danger-subtle text-danger"
                  : "bg-warning-subtle text-warning";
            return (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 cursor-help ${cls}`}
                title={
                  isCarried
                    ? t("carriedClickDetail")
                    : task.verification_verdict === "fail"
                      ? t("failClickDetail")
                      : task.verification_verdict === "conditional"
                        ? t("conditionalClickDetail")
                        : ""
                }
              >
                {isCarried ? t("verdictCarried") : task.verification_verdict.toUpperCase()}
              </span>
            );
          })() : task.verification_id ? (
            <span className="text-[10px] px-1.5 py-0.5 bg-success-subtle text-success rounded shrink-0">
              {t("verified")}
            </span>
          ) : null}
          {/* skipped는 제외 — 재시도 소진 사실은 건너뜀 칩이 이미 설명한다 */}
          {task.status !== "done" && task.status !== "skipped" && ((task.retry_count ?? 0) > 0 || (task.reassign_count ?? 0) > 0) && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning-subtle text-warning shrink-0 cursor-help"
              title={t("retryBadgeHint")}
            >
              {(task.retry_count ?? 0) > 0
                ? t("retryBadge", { n: task.retry_count, max: task.retry_limit ?? 2 })
                : t("reassignedBadge")}
            </span>
          )}
          {(() => {
            const reason = waitReason(task);
            return reason ? (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-sunken text-muted shrink-0 cursor-help"
                title={reason.hint}
              >
                {reason.label}
              </span>
            ) : null;
          })()}
          {task.status === "todo" && task.description?.includes("--- Rejection Feedback ---") && (
            <span className="text-[10px] px-1.5 py-0.5 bg-danger-subtle text-danger rounded shrink-0">
              {t("rejected")}
            </span>
          )}
          {hasUsage && (
            <span
              className="text-[10px] px-1.5 py-0.5 bg-warning-subtle text-warning rounded shrink-0 cursor-help tabular-nums"
              title={`${totalTokens.toLocaleString()} tokens · $${costUsd.toFixed(2)} — 누적 토큰(재시도·fix 포함). 값이 클수록 태스크가 헤맸다는 신호`}
            >
              {formatTokens(totalTokens)}
            </span>
          )}
          {task.status === "skipped" && (
            <span className="text-[10px] px-1.5 py-0.5 bg-warning-subtle text-warning rounded shrink-0"
              title={task.skip_reason === "retry_exhausted" ? t("skipReasonRetryExhausted") : (task.result_summary ?? t("statusSkipped"))}>
              {t("statusSkipped")}
            </span>
          )}
          {(task.title ?? "").startsWith("[사전 조사]") && (
            <span className="text-[10px] px-1.5 py-0.5 bg-review-subtle text-review rounded-full shrink-0">
              {t("adversarialBadge")}
            </span>
          )}
        </div>
        {/* Active reviewer for in_review tasks — surfaces the Generator-Evaluator
            separation so users see *which* agent is currently reviewing. */}
        {(() => {
          if (task.status !== "in_review") return null;
          const reviewer = agents.find(
            (a) => a.current_task_id === task.id && a.id !== task.assignee_id,
          );
          if (!reviewer) return null;
          return (
            <span
              className="text-[10px] text-review px-1.5 py-0.5 bg-review-subtle rounded border border-review/30 shrink-0 ml-3"
              title={t("reviewingBy", { name: reviewer.name })}
            >
              {t("reviewingPrefix")} {reviewer.name}
            </span>
          );
        })()}

        <div className="flex items-center gap-1.5 shrink-0 ml-3">
          {/* Agent assignment */}
          {assigningTaskId === task.id ? (
            <select
              autoFocus
              defaultValue={task.assignee_id ?? ""}
              onChange={(e) => handleAssignSelect(task.id, e.target.value)}
              onBlur={() => setAssigningTaskId(null)}
              className="text-[10px] text-muted bg-sunken border border-accent rounded px-1 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="" disabled>{t("promptAssignAgent")}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          ) : task.assignee_id && agentMap[task.assignee_id] ? (
            <button
              onClick={() => setAssigningTaskId(task.id)}
              title={t("reassign")}
              className="text-[10px] text-faint px-1.5 py-0.5 bg-surface rounded border border-line-soft hover:border-accent hover:text-accent-hover transition-colors cursor-pointer"
            >
              {agentMap[task.assignee_id].name}
            </button>
          ) : (
            <button
              onClick={() => setAssigningTaskId(task.id)}
              aria-label={t("assign")}
              className="text-[10px] text-faint hover:text-muted px-1.5 py-0.5 border border-dashed border-line rounded"
            >
              {t("assign")}
            </button>
          )}

          {/* Status dropdown */}
          <select
            aria-label={t("taskStatus")}
            value={task.status}
            onChange={(e) => handleStatusChange(task.id, e.target.value)}
            className="text-[10px] text-faint bg-sunken border border-line rounded px-1 py-0.5 cursor-pointer"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(STATUS_LABEL_KEYS[s])}
              </option>
            ))}
          </select>

          {/* Approval Gate: Approve/Reject for pending_approval tasks */}
          {task.status === "pending_approval" && !isAutopilot && (
            <>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    if (projectId) {
                      await guardMutation(api.orchestration.approveTask(projectId, task.id));
                    } else {
                      await guardMutation(api.tasks.approve(task.id));
                    }
                  } catch {
                    return; // 실패 토스트는 guardMutation
                  }
                  onUpdate?.();
                }}
                className="text-[10px] px-2 py-0.5 rounded font-medium bg-success text-white hover:opacity-90"
              >
                {t("approve")}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setRejectingTask({ id: task.id, title: task.title }); }}
                className="text-[10px] px-2 py-0.5 rounded font-medium bg-danger-subtle text-danger hover:bg-danger/20"
              >
                {t("reject")}
              </button>
            </>
          )}
          {task.status === "pending_approval" && isAutopilot && (
            <span className="text-[10px] px-1.5 py-0.5 bg-accent/10 text-accent rounded">
              Auto
            </span>
          )}

          {/* Governance: Verify → Approve/Reject for in_review tasks */}
          {task.status === "in_review" && isAutopilot && (
            <span className="text-[10px] px-1.5 py-0.5 bg-accent/10 text-accent rounded">
              Auto
            </span>
          )}
          {task.status === "in_review" && !isAutopilot && (
            <>
              {task.verification_id ? (
                <>
                  <span className="text-[10px] px-1.5 py-0.5 bg-success-subtle text-success rounded">
                    {t("verified")}
                  </span>
                  <button
                    onClick={async () => { await api.tasks.approve(task.id); onUpdate?.(); }}
                    className="text-[10px] px-2 py-0.5 rounded font-medium bg-success text-white hover:opacity-90"
                  >
                    {t("approve")}
                  </button>
                </>
              ) : (
                <>
                  <span className="text-[10px] px-1.5 py-0.5 bg-warning-subtle text-warning rounded">
                    {t("unverified")}
                  </span>
                  <button
                    onClick={async () => {
                      setVerifyingTasks((prev) => new Set(prev).add(task.id));
                      try {
                        await api.orchestration.verifyTask(task.id);
                      } catch { /* result comes via WebSocket */ }
                    }}
                    disabled={verifyingTasks.has(task.id)}
                    className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                      verifyingTasks.has(task.id)
                        ? "bg-review-subtle text-review/60 cursor-not-allowed"
                        : "bg-review text-white hover:opacity-90"
                    }`}
                  >
                    {verifyingTasks.has(task.id) ? t("verifying") : t("verify")}
                  </button>
                </>
              )}
              <button
                onClick={() => setRejectingTask({ id: task.id, title: task.title })}
                className="text-[10px] px-2 py-0.5 rounded font-medium bg-danger-subtle text-danger hover:bg-danger/20"
              >
                {t("reject")}
              </button>
            </>
          )}

          {/* Run button — only for assigned tasks in todo/blocked */}
          {task.assignee_id &&
            (task.status === "todo" || task.status === "blocked") && (
              <button
                onClick={() => handleRunTask(task.id)}
                disabled={isRunning}
                aria-label={isRunning ? t("taskRunning", { seconds }) : t("run")}
                className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors flex items-center gap-1 ${
                  isRunning
                    ? "bg-accent/10 text-accent cursor-not-allowed"
                    : "bg-accent text-on-accent hover:bg-accent-hover"
                }`}
              >
                {isRunning ? (
                  <>
                    <svg
                      className="animate-spin w-2.5 h-2.5 shrink-0"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    {t("taskRunning", { seconds })}
                  </>
                ) : (
                  t("run")
                )}
              </button>
            )}
        </div>
        </div>
        {/* 실패 사유 한 줄 — 카드 아래 별도 행. blocked 뿐 아니라 "FAIL 후 재시도 중"
            (todo/in_progress로 돌아간 상태)에도 보여준다. flex 행 안에 넣으면 제목
            (flex-1)의 폭을 뺏어 겹쳐 보이는 레이아웃 결함이 있어 카드 밖에 둔다. */}
        {(task.status === "blocked" || task.verification_verdict === "fail") && task.verification_issues && (() => {
          try {
            const issues = JSON.parse(task.verification_issues);
            if (!Array.isArray(issues) || issues.length === 0) return null;
            const top = issues[0];
            const fileRef = top.file
              ? `${String(top.file).split("/").pop()}${top.line != null ? `:${top.line}` : ""} — `
              : "";
            // done + fail = 최종 QA로 이월된 미해결 이슈(호박색, 경보 아님). 그 외(blocked/재검증)는 실제 실패(빨강).
            const isCarried = task.status === "done" && task.verification_verdict === "fail";
            const label = isCarried
              ? t("carriedIssuesLabel")
              : task.status === "in_review" ? t("lastFailReasonReverifying") : t("lastFailReason");
            const labelCls = isCarried ? "text-warning/90 font-medium" : "text-danger/90 font-medium";
            const msgCls = isCarried ? "text-warning/70" : "text-danger/80";
            const moreCls = isCarried ? "text-warning/60" : "text-danger/60";
            return (
              <div
                onClick={() => setSelectedTaskId(task.id)}
                className={`text-[11px] pr-3 pt-0.5 truncate cursor-pointer ${isSubtask ? "pl-15" : "pl-9"}`}
                title={`${top.message ?? ""}\n\n${isCarried ? t("carriedClickDetail") : t("failClickDetail")}`}
              >
                <span className={labelCls}>{label}</span>
                <span className={msgCls}>
                  {" "}{top.severity === "critical" ? "⚠ " : ""}{fileRef}{top.message?.slice(0, 140)}
                </span>
                {issues.length > 1 && (
                  <span className={moreCls}> · {t("moreIssues", { count: issues.length - 1 })}</span>
                )}
              </div>
            );
          } catch { return null; }
        })()}
        {/* 승인 게이트 차단 안내 — 미승인 spec으로 실행이 막힘. 사유 + 현재 초안 버전 + 승인 화면 진입 */}
        {specBlocks[task.id] && (() => {
          const block = specBlocks[task.id];
          return (
            <div className={`pt-0.5 ${isSubtask ? "pl-15" : "pl-9"}`}>
              <div role="alert" className="rounded-md bg-warning-subtle px-2 py-1.5 text-[11px] text-warning">
                <span className="font-medium">{t("specNotApprovedBlocked")}</span>{" "}
                <span className="text-warning/80">{block.message}</span>
                {block.currentDraftVersion != null && (
                  <span className="text-warning/70"> · {t("specCurrentDraft", { version: block.currentDraftVersion })}</span>
                )}
                {block.goalId && onOpenSpec && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const goalId = block.goalId!;
                      setSpecBlocks((prev) => { const next = { ...prev }; delete next[task.id]; return next; });
                      onOpenSpec(goalId);
                    }}
                    className="ml-2 rounded-full bg-warning px-2 py-0.5 font-medium text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-warning"
                  >
                    {t("specOpenApproval")}
                  </button>
                )}
              </div>
            </div>
          );
        })()}
        {/* 재작업 버튼 — 이월된(done+fail) 태스크를 다시 열어 재해결 */}
        {task.status === "done" && task.verification_verdict === "fail" && (
          <div className={`pt-0.5 flex gap-1.5 ${isSubtask ? "pl-15" : "pl-9"}`}>
            <button
              onClick={(e) => { e.stopPropagation(); handleRework(task.id); }}
              className="text-[10px] px-2 py-0.5 rounded-full bg-warning-subtle text-warning hover:bg-warning/20 font-medium transition-colors"
              title={t("reworkTitle")}
            >
              ↻ {t("reworkButton")}
            </button>
            {task.assignee_id && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent("crewdeck:open-agent", {
                    detail: { agentId: task.assignee_id, taskId: task.id },
                  }));
                }}
                className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent hover:bg-accent/20 font-medium transition-colors"
                title={t("summonTitle")}
              >
                ⚡ {t("summonButton")}
              </button>
            )}
          </div>
        )}
        {/* Subtasks (expanded) */}
        {hasChildren && isExpanded && (
          <div className="space-y-1 mt-1">
            {childTasks.map((st) => renderTaskRow(st, true))}
          </div>
        )}
        {/* Subtask count badge (collapsed) */}
        {hasChildren && !isExpanded && (
          <button
            onClick={() => toggleExpand(task.id)}
            className="ml-6 mt-0.5 text-[10px] text-faint hover:text-muted"
          >
            {childTasks.length} subtask{childTasks.length > 1 ? "s" : ""}
          </button>
        )}
      </div>
    );
  };

  const modals = (
    <>
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          agents={agents}
          onClose={() => setSelectedTaskId(null)}
          onUpdate={() => { setSelectedTaskId(null); onUpdate?.(); }}
        />
      )}
      {rejectingTask && (
        <RejectDialog
          taskTitle={rejectingTask.title}
          onReject={(fb, autoRerun) => handleReject(rejectingTask.id, fb, autoRerun)}
          onCancel={() => setRejectingTask(null)}
        />
      )}
    </>
  );

  if (tasks.length === 0) {
    return (
      <div className="py-8 px-4 border border-dashed border-line rounded-lg text-center">
        <div className="text-3xl mb-2 opacity-40">📋</div>
        <p className="text-sm font-medium text-muted mb-1">
          {t("emptyTasksTitle")}
        </p>
        <p className="text-xs text-faint mb-1">
          {t("emptyTasksDesc")}
        </p>
        <p className="text-xs text-accent mb-3">
          {t("emptyTasksHint")}
        </p>
        {onAddGoal && (
          <button
            onClick={onAddGoal}
            aria-label={t("emptyTasksAddGoal")}
            className="text-xs px-3 py-1.5 bg-fg text-canvas rounded-lg hover:bg-fg/90 transition-colors"
          >
            {t("emptyTasksAddGoal")}
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {modals}
      {/* 전역 검색 바 */}
      <div className="mb-4">
        <input
          type="text"
          value={globalSearch}
          onChange={(e) => setGlobalSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setGlobalSearch(""); }}
          placeholder={t("searchAllTasks")}
          className="w-full text-sm px-3 py-2 border border-line rounded-lg bg-sunken text-muted focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
        />
      </div>

      {isSearching ? (
        (() => {
          const searchResults = tasks.filter((task) => task.title.toLowerCase().includes(searchTerm));
          return searchResults.length === 0 ? (
            <p className="text-sm text-faint text-center py-8">{t("noSearchResults")}</p>
          ) : (
            <div className="space-y-1">
              {searchResults.map((task) => renderTaskRow(task))}
            </div>
          );
        })()
      ) : (
        <div className="space-y-5">
          {STATUSES.map((status) => {
            const filtered = groupedTasks[status] ?? [];
            if (filtered.length === 0) return null;
            const config = STATUS_COLORS[status];
            const labelKey = STATUS_LABEL_KEYS[status];

            const isDone = status === "done";
            const visibleTasks = isDone && !showAllDone && filtered.length > DONE_PREVIEW_COUNT
              ? filtered.slice(0, DONE_PREVIEW_COUNT)
              : filtered;
            const hiddenCount = filtered.length - visibleTasks.length;

            return (
              <div key={status}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-xs font-medium ${config.color}`}>{t(labelKey)}</span>
                  <span className="text-[10px] text-faint">{filtered.length}</span>
                  {status === "in_review" && filtered.length > 1 && projectId && (
                    <button
                      onClick={async () => {
                        try {
                          await guardMutation(api.tasks.bulkApprove(projectId));
                        } catch {
                          return; // 실패 토스트는 guardMutation
                        }
                        onUpdate?.();
                      }}
                      className="text-[10px] px-2 py-0.5 rounded font-medium bg-success text-white hover:opacity-90 ml-auto"
                    >
                      {t("bulkApprove", { count: filtered.length })}
                    </button>
                  )}
                  {status === "pending_approval" && filtered.length > 1 && projectId && (
                    <button
                      onClick={async () => {
                        let result: { approved: number; excluded: number };
                        try {
                          result = await guardMutation(api.orchestration.approveAll(projectId));
                        } catch {
                          return; // 실패 토스트는 guardMutation
                        }
                        // fix-파생·리뷰 실패·사람 승인 필수 태스크는 bulk에서 제외 — 개별 승인 유도
                        if (result.excluded > 0) {
                          showToast(t("approveAllExcluded", { count: result.excluded }), "info");
                        }
                        onUpdate?.();
                      }}
                      className="text-[10px] px-2 py-0.5 rounded font-medium bg-warning text-white hover:opacity-90 ml-auto"
                    >
                      {t("bulkApprove", { count: filtered.length })}
                    </button>
                  )}
                </div>
                <div className="space-y-1">
                  {visibleTasks.map((task) => renderTaskRow(task))}
                </div>
                {isDone && filtered.length > DONE_PREVIEW_COUNT && (
                  <button
                    onClick={() => setShowAllDone((v) => !v)}
                    className="mt-1 text-[11px] text-faint hover:text-muted transition-colors"
                  >
                    {showAllDone
                      ? t("showLessDone")
                      : t("showMoreDone", { count: hiddenCount })}
                  </button>
                )}
              </div>
            );
          })}
          {archivedTaskIds.size > 0 && (
            <button
              onClick={() => setShowArchivedTasks((v) => !v)}
              className="flex items-center gap-2 text-xs text-faint hover:text-muted transition-colors"
            >
              <svg
                className={`w-3 h-3 transition-transform ${showArchivedTasks ? "rotate-90" : ""}`}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span>{t("completedGoalTasks", { count: archivedTaskIds.size })}</span>
            </button>
          )}
        </div>
      )}
    </>
  );
}
