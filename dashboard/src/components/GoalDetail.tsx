import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityLog, type SteeringStepLink } from "./ActivityLog";
import { RecoveryHistory } from "./RecoveryHistory";
import {
  type GoalStatus,
  type GoalStatusResponse,
  useGoalStatusStore,
} from "../stores/goals";
import { useLiveSessionStore } from "../stores/liveSession";
import { useStore } from "../stores/useStore";
import type {
  VerificationIssueStatus,
  VerificationRoundVerdict,
  VerificationTimelineRound,
  VerificationTimelineStatus,
} from "../lib/api";

interface GoalDetailProps {
  goalId: string;
  title?: string;
  initialStatus?: GoalStatusResponse | null;
  autoLoad?: boolean;
  className?: string;
  onStatusChange?: (status: GoalStatusResponse) => void;
}

const COPY = {
  en: {
    status: {
      running: "Running",
      failed: "Failed",
      pending_approval: "Pending Approval",
      pr_open: "PR in review",
      completed: "Completed",
    },
    activity: "Activity",
    failedStage: "Failed stage",
    isolatedWorkspace: "Isolated workspace",
    savePoint: "Save point",
    evaluator: "Evaluator",
    loadFailed: "Could not load goal status",
    timeline: "Quality decision timeline",
    round: "Round",
    dimensions: "Quality dimensions",
    issues: "Issues",
    noIssues: "No issues found",
    noRounds: "No quality decisions yet",
    reason: "End reason",
    assignee: "Owner",
    fixTask: "Fix task",
    execution: "Agent run details",
    implementationAgent: "Implementation agent",
    evaluatorAgent: "Evaluation agent",
    fixAgents: "Fix agents",
    timelineLoadFailed: "Could not load quality decisions",
  },
  ko: {
    status: {
      running: "진행 중",
      failed: "실패",
      pending_approval: "목표 반영 대기 중",
      pr_open: "PR 머지 대기",
      completed: "완료",
    },
    activity: "활동",
    failedStage: "실패 단계",
    isolatedWorkspace: "독립된 작업 공간",
    savePoint: "저장 지점",
    evaluator: "검증 에이전트",
    loadFailed: "목표 상태를 불러오지 못했습니다",
    timeline: "품질 판정 타임라인",
    round: "라운드",
    dimensions: "품질 항목",
    issues: "발견된 문제",
    noIssues: "발견된 문제가 없습니다",
    noRounds: "아직 품질 판정이 없습니다",
    reason: "종료 이유",
    assignee: "담당자",
    fixTask: "수정 작업",
    execution: "에이전트 실행 정보",
    implementationAgent: "구현 에이전트",
    evaluatorAgent: "검증 에이전트",
    fixAgents: "수정 에이전트",
    timelineLoadFailed: "품질 판정을 불러오지 못했습니다",
  },
};

const TIMELINE_STATUS_LABELS: Record<VerificationTimelineStatus, { en: string; ko: string }> = {
  passed: { en: "Passed", ko: "통과" },
  fixing: { en: "Fixing", ko: "수정 중" },
  stopped: { en: "Stopped", ko: "중단" },
  manual_approval: { en: "Needs review", ko: "확인 필요" },
};

const VERDICT_LABELS: Record<VerificationRoundVerdict, { en: string; ko: string }> = {
  pass: { en: "Passed", ko: "통과" },
  fail: { en: "Failed", ko: "실패" },
  stopped: { en: "Stopped", ko: "중단" },
  manual_approval: { en: "Needs review", ko: "확인 필요" },
};

const ISSUE_STATUS_LABELS: Record<VerificationIssueStatus, { en: string; ko: string }> = {
  open: { en: "Open", ko: "미해결" },
  resolved: { en: "Resolved", ko: "해결됨" },
  regression: { en: "Regression", ko: "재발" },
};

const DIMENSION_LABELS: Record<string, { en: string; ko: string }> = {
  functionality: { en: "Functionality", ko: "기능" },
  dataFlow: { en: "Data flow", ko: "데이터 흐름" },
  designAlignment: { en: "Design fit", ko: "설계 일치" },
  craft: { en: "Completeness", ko: "완성도" },
  edgeCases: { en: "Edge cases", ko: "예외 상황" },
};

const TIMELINE_STATUS_TONES: Record<VerificationTimelineStatus, string> = {
  passed: "bg-success-subtle text-success",
  fixing: "bg-accent/10 text-accent",
  stopped: "bg-danger-subtle text-danger",
  manual_approval: "bg-warning-subtle text-warning",
};

const VERDICT_TONES: Record<VerificationRoundVerdict, string> = {
  pass: "bg-success-subtle text-success",
  fail: "bg-danger-subtle text-danger",
  stopped: "bg-sunken text-muted",
  manual_approval: "bg-warning-subtle text-warning",
};

const ISSUE_STATUS_TONES: Record<VerificationIssueStatus, string> = {
  open: "bg-danger-subtle text-danger",
  resolved: "bg-success-subtle text-success",
  regression: "bg-warning-subtle text-warning",
};

const VERDICT_DOT_TONES: Record<VerificationRoundVerdict, string> = {
  pass: "bg-success",
  fail: "bg-danger",
  stopped: "bg-faint",
  manual_approval: "bg-warning",
};

interface TimelineTaskGroup {
  taskId: string;
  taskTitle: string;
  rounds: VerificationTimelineRound[];
  latest: VerificationTimelineRound;
}

// 라운드(재시도 포함)를 task 단위로 묶는다 — auto-fix 루프가 같은 task를 여러 번 재시도해
// 라운드 행이 폭증하는 문제를 완화. task별 등장 순서 유지, 라운드는 round 번호 오름차순.
function groupRoundsByTask(rounds: VerificationTimelineRound[]): TimelineTaskGroup[] {
  const byTask = new Map<string, VerificationTimelineRound[]>();
  const order: string[] = [];
  for (const round of rounds) {
    if (!byTask.has(round.task_id)) {
      byTask.set(round.task_id, []);
      order.push(round.task_id);
    }
    byTask.get(round.task_id)!.push(round);
  }
  return order.map((taskId) => {
    const grouped = [...byTask.get(taskId)!].sort((a, b) => a.round - b.round);
    const latest = grouped[grouped.length - 1];
    return { taskId, taskTitle: latest.task_title, rounds: grouped, latest };
  });
}

function attemptsLabel(count: number, ko: boolean): string {
  return ko ? `${count}회 시도` : `×${count}`;
}

function getCopy(language: string) {
  return language.startsWith("ko") ? COPY.ko : COPY.en;
}

function getStatusTone(status: GoalStatus): {
  chip: string;
  dot: string;
  panel: string;
} {
  switch (status) {
    case "pending_approval":
      return {
        chip: "bg-warning-subtle text-warning",
        dot: "bg-warning",
        panel: "border-warning bg-warning-subtle",
      };
    case "failed":
      return {
        chip: "bg-danger-subtle text-danger",
        dot: "bg-danger",
        panel: "border-danger bg-danger-subtle",
      };
    case "completed":
      return {
        chip: "bg-success-subtle text-success",
        dot: "bg-success",
        panel: "border-success bg-success-subtle",
      };
    case "running":
      return {
        chip: "bg-accent/10 text-accent",
        dot: "bg-accent",
        panel: "border-accent/25 bg-accent/10",
      };
    case "pr_open":
      // PR 생성됨, origin 머지 대기 — 대기 톤(앰버)
      return {
        chip: "bg-warning-subtle text-warning",
        dot: "bg-warning",
        panel: "border-warning bg-warning-subtle",
      };
  }
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.slice(-2).join("/");
}

function readableCode(value: string): string {
  return value.replaceAll("_", " ");
}

export function GoalDetail({
  goalId,
  title,
  initialStatus = null,
  autoLoad = true,
  className = "",
  onStatusChange,
}: GoalDetailProps) {
  const { t, i18n } = useTranslation();
  const copy = getCopy(i18n.language);
  const [localError, setLocalError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    goalId: string;
    openTaskId: string | null;
    roundByTask: Record<string, string>;
  } | null>(null);
  const storeStatus = useGoalStatusStore((state) => state.byGoalId[goalId]);
  const loading = useGoalStatusStore((state) => Boolean(state.loadingByGoalId[goalId]));
  const storeError = useGoalStatusStore((state) => state.errorByGoalId[goalId]);
  const setGoalStatus = useGoalStatusStore((state) => state.setGoalStatus);
  const fetchGoalStatus = useGoalStatusStore((state) => state.fetchGoalStatus);
  const timeline = useGoalStatusStore((state) => state.timelineByGoalId[goalId]);
  const timelineLoading = useGoalStatusStore((state) => Boolean(state.timelineLoadingByGoalId[goalId]));
  const timelineError = useGoalStatusStore((state) => state.timelineErrorByGoalId[goalId]);
  const fetchVerificationTimeline = useGoalStatusStore((state) => state.fetchVerificationTimeline);
  const steeringNotes = useLiveSessionStore((state) => state.notesByGoalId[goalId]);
  const fetchSteeringNotes = useLiveSessionStore((state) => state.fetchNotes);
  const status = storeStatus ?? initialStatus;
  const lang = i18n.language.startsWith("ko") ? "ko" : "en";

  const groups = useMemo(
    () => groupRoundsByTask(timeline?.rounds ?? []),
    [timeline],
  );
  const timelineStatus = timeline?.status;
  // 기본으로 펼칠 task = 현재 수정 중(가장 최신 라운드를 가진 그룹). 전부 끝났으면 마지막이 실패일 때만.
  const activeTaskId = (() => {
    if (groups.length === 0) return null;
    if (timelineStatus === "fixing" || timelineStatus === "manual_approval") {
      return groups.reduce((a, b) => (b.latest.round > a.latest.round ? b : a)).taskId;
    }
    const last = groups[groups.length - 1];
    return last.latest.verdict === "fail" ? last.taskId : null;
  })();
  const sel = selection?.goalId === goalId ? selection : null;
  const openTaskId = sel ? sel.openTaskId : activeTaskId;
  const roundByTask = sel?.roundByTask ?? {};
  const totalTasks = groups.length;
  const passedTasks = groups.filter((g) => g.latest.verdict === "pass").length;
  const fixingTasks = groups.filter((g) => g.latest.verdict === "fail").length;

  const toggleTask = (taskId: string) =>
    setSelection({
      goalId,
      openTaskId: openTaskId === taskId ? null : taskId,
      roundByTask,
    });
  const selectRound = (taskId: string, verificationId: string) =>
    setSelection({
      goalId,
      openTaskId: taskId,
      roundByTask: { ...roundByTask, [taskId]: verificationId },
    });

  // 조향 노트의 injectedStep(session id) → 검증 타임라인의 task/round. 반영 스텝 링크 클릭 시
  // 해당 task 라운드를 펼치고 스크롤한다.
  const stepLinkTargets = useMemo(() => {
    const map = new Map<string, { taskId: string; verificationId: string; taskTitle: string }>();
    for (const round of timeline?.rounds ?? []) {
      const target = { taskId: round.task_id, verificationId: round.verification_id, taskTitle: round.task_title };
      if (round.implementation_session_id) map.set(round.implementation_session_id, target);
      for (const sessionId of round.fix_session_ids) map.set(sessionId, target);
    }
    return map;
  }, [timeline]);

  const resolveSteeringStep = (injectedStep: string): SteeringStepLink | null => {
    const target = stepLinkTargets.get(injectedStep);
    if (!target) return null;
    return {
      taskTitle: target.taskTitle,
      onClick: () => {
        selectRound(target.taskId, target.verificationId);
        document.getElementById(`verification-round-${target.taskId}`)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      },
    };
  };

  useEffect(() => {
    fetchSteeringNotes(goalId).catch(() => undefined);
  }, [goalId, fetchSteeringNotes]);

  useEffect(() => {
    if (initialStatus) setGoalStatus(initialStatus);
  }, [initialStatus, setGoalStatus]);

  useEffect(() => {
    if (!autoLoad) return;
    const load = () => {
      fetchGoalStatus(goalId)
        .then((next) => {
          setLocalError(null);
          onStatusChange?.(next);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : copy.loadFailed;
          setLocalError(message);
        });
      fetchVerificationTimeline(goalId).catch(() => undefined);
    };
    load();
    const onRefresh = (e: Event) => {
      // 다른 프로젝트로 스코프된 refresh는 스킵 — 이 goal 상세는 현 프로젝트 컨텍스트
      const scoped = (e as CustomEvent<{ projectId?: string }>).detail?.projectId;
      const current = useStore.getState().currentProjectId;
      if (scoped && current && scoped !== current) return;
      load();
    };
    window.addEventListener("crewdeck:refresh", onRefresh);
    return () => window.removeEventListener("crewdeck:refresh", onRefresh);
  }, [autoLoad, copy.loadFailed, fetchGoalStatus, fetchVerificationTimeline, goalId, onStatusChange]);

  const statusTone = useMemo(
    () => (status ? getStatusTone(status.status) : getStatusTone("running")),
    [status],
  );

  const activityEvents = (status?.activity_events ?? []).filter(
    (event) => event.type !== "steering_injected",
  );
  const errorMessage = localError ?? storeError;

  return (
    <section
      className={`rounded-lg border border-line bg-surface p-3 ${className}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          {title && (
            <h3 className="truncate text-sm font-semibold text-fg">
              {title}
            </h3>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone.chip}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${statusTone.dot}`} />
              {status ? copy.status[status.status] : t("loading")}
            </span>
            {loading && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-[10px] text-faint">
                <svg className="h-2.5 w-2.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                {t("loading")}
              </span>
            )}
          </div>
        </div>
      </div>

      {status && (
        <div className={`mt-3 rounded-lg border px-3 py-2 ${statusTone.panel}`}>
          <div className="grid gap-2 text-[11px] text-muted sm:grid-cols-3">
            {status.worktree_path && (
              <div className="min-w-0">
                <span className="block font-medium text-faint">
                  {copy.isolatedWorkspace}
                </span>
                <span className="block truncate font-mono" title={status.worktree_path}>
                  {shortPath(status.worktree_path)}
                </span>
              </div>
            )}
            {status.worktree_branch && (
              <div className="min-w-0">
                <span className="block font-medium text-faint">
                  {copy.savePoint}
                </span>
                <span className="block truncate font-mono" title={status.worktree_branch}>
                  {status.worktree_branch}
                </span>
              </div>
            )}
            {status.evaluator_session_id && (
              <div className="min-w-0">
                <span className="block font-medium text-faint">
                  {copy.evaluator}
                </span>
                <span className="block truncate font-mono" title={status.evaluator_session_id}>
                  {status.evaluator_session_id.slice(0, 8)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="mt-3 rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">
          {errorMessage}
        </div>
      )}

      {(timeline || timelineLoading || timelineError) && (
        <div className="mt-3 border-t border-line-soft pt-3" data-testid="verification-timeline">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {copy.timeline}
            </h4>
            <div className="flex items-center gap-1.5">
              {timelineLoading && (
                <span className="text-[10px] text-faint">{t("loading")}</span>
              )}
              {timeline && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TIMELINE_STATUS_TONES[timeline.status]}`}>
                  {TIMELINE_STATUS_LABELS[timeline.status][i18n.language.startsWith("ko") ? "ko" : "en"]}
                </span>
              )}
            </div>
          </div>

          {timeline && totalTasks > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
              <span className="font-semibold text-muted tabular-nums">
                {passedTasks}/{totalTasks} {TIMELINE_STATUS_LABELS.passed[lang]}
              </span>
              {fixingTasks > 0 && (
                <span className="inline-flex items-center gap-1 text-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  {fixingTasks} {TIMELINE_STATUS_LABELS.fixing[lang]}
                </span>
              )}
            </div>
          )}

          {timeline && timeline.reason && (
            <div className="mt-1 flex min-w-0 items-start gap-1.5 text-[10px] text-faint">
              <span className="shrink-0">{copy.reason}</span>
              <span className="min-w-0 break-words">{readableCode(timeline.reason)}</span>
            </div>
          )}

          {timelineError && (
            <div className="mt-2 rounded border border-danger bg-danger-subtle px-2.5 py-2 text-[11px] text-danger">
              {copy.timelineLoadFailed}: {timelineError}
            </div>
          )}

          {timeline && timeline.rounds.length === 0 && (
            <p className="mt-2 text-[11px] text-faint">{copy.noRounds}</p>
          )}

          {timeline && groups.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {groups.map((group) => {
                const isOpen = openTaskId === group.taskId;
                const isActiveFixing =
                  activeTaskId === group.taskId &&
                  (timelineStatus === "fixing" || timelineStatus === "manual_approval");
                const showFixing = isActiveFixing && group.latest.verdict === "fail";
                const badgeLabel = showFixing
                  ? TIMELINE_STATUS_LABELS.fixing[lang]
                  : VERDICT_LABELS[group.latest.verdict][lang];
                const badgeTone = showFixing
                  ? TIMELINE_STATUS_TONES.fixing
                  : VERDICT_TONES[group.latest.verdict];
                const shownId = roundByTask[group.taskId] ?? group.latest.verification_id;
                const shown = group.rounds.find((r) => r.verification_id === shownId) ?? group.latest;
                return (
                  <div
                    key={group.taskId}
                    id={`verification-round-${group.taskId}`}
                    className="overflow-hidden rounded-md border border-line"
                  >

                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={`verification-task-${group.taskId}`}
                      onClick={() => toggleTask(group.taskId)}
                      className="flex w-full min-w-0 items-center gap-2 bg-sunken px-2.5 py-2 text-left hover:bg-fg/5 focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <svg
                        className={`h-3 w-3 shrink-0 text-faint transition-transform ${isOpen ? "rotate-90" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        aria-hidden="true"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-muted" title={group.taskTitle}>
                        {group.taskTitle}
                      </span>
                      <span className="hidden shrink-0 items-center gap-1 sm:flex" aria-hidden="true">
                        {group.rounds.map((r) => (
                          <span
                            key={r.verification_id}
                            className={`h-1.5 w-1.5 rounded-full ${VERDICT_DOT_TONES[r.verdict]}`}
                            title={`${copy.round} ${r.round}`}
                          />
                        ))}
                      </span>
                      {group.rounds.length > 1 && (
                        <span className="shrink-0 text-[10px] tabular-nums text-faint">
                          {attemptsLabel(group.rounds.length, lang === "ko")}
                        </span>
                      )}
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badgeTone}`}>
                        {badgeLabel}
                      </span>
                    </button>

                    {isOpen && (
                      <div id={`verification-task-${group.taskId}`} className="space-y-3 px-2.5 py-2.5">
                        {group.rounds.length > 1 && (
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="mr-0.5 text-[10px] text-faint">{copy.round}</span>
                            {group.rounds.map((r) => {
                              const active = r.verification_id === shown.verification_id;
                              return (
                                <button
                                  key={r.verification_id}
                                  type="button"
                                  onClick={() => selectRound(group.taskId, r.verification_id)}
                                  aria-pressed={active}
                                  className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] tabular-nums focus-visible:ring-2 focus-visible:ring-accent ${
                                    active
                                      ? "border-accent bg-accent/10 text-accent"
                                      : "border-line text-muted hover:border-line"
                                  }`}
                                >
                                  <span className={`h-1.5 w-1.5 rounded-full ${VERDICT_DOT_TONES[r.verdict]}`} />
                                  {r.round}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {shown.reason && (
                          <div className="text-[11px] text-muted">
                            <span className="font-medium">{copy.reason}: </span>
                            {readableCode(shown.reason)}
                          </div>
                        )}

                        <div>
                          <h5 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
                            {copy.issues} ({shown.issues.length})
                          </h5>
                          {shown.issues.length === 0 ? (
                            <p className="text-[11px] text-faint">{copy.noIssues}</p>
                          ) : (
                            <div className="space-y-1.5">
                              {shown.issues.map((issue) => (
                                <div key={issue.issue_id} className="rounded border border-line bg-sunken px-2 py-2">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${ISSUE_STATUS_TONES[issue.status]}`}>
                                      {ISSUE_STATUS_LABELS[issue.status][lang]}
                                    </span>
                                    <span className="text-[9px] font-semibold uppercase text-muted">{issue.severity}</span>
                                    <span className="text-[10px] text-faint">
                                      {DIMENSION_LABELS[issue.dimension]?.[lang] ?? issue.dimension}
                                    </span>
                                  </div>
                                  <p className="mt-1 break-words text-[11px] text-muted">{issue.evidence}</p>
                                  {(issue.assignee_id || issue.fix_task_id) && (
                                    <dl className="mt-1.5 grid gap-x-3 gap-y-1 text-[10px] text-muted sm:grid-cols-2">
                                      {issue.assignee_id && (
                                        <div className="min-w-0">
                                          <dt className="font-medium">{copy.assignee}</dt>
                                          <dd className="break-all font-mono" title={issue.assignee_id}>{issue.assignee_id}</dd>
                                        </div>
                                      )}
                                      {issue.fix_task_id && (
                                        <div className="min-w-0">
                                          <dt className="font-medium">{copy.fixTask}</dt>
                                          <dd className="break-all font-mono" title={issue.fix_task_id}>{issue.fix_task_id}</dd>
                                        </div>
                                      )}
                                    </dl>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {shown.dimensions.length > 0 && (
                          <div>
                            <h5 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-faint">
                              {copy.dimensions}
                            </h5>
                            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                              {shown.dimensions.map((dimension) => (
                                <div
                                  key={dimension.dimension}
                                  className={`min-w-0 rounded border px-2 py-1.5 ${
                                    dimension.passed
                                      ? "border-success bg-success-subtle"
                                      : "border-danger bg-danger-subtle"
                                  }`}
                                >
                                  <div className="truncate text-[10px] text-muted" title={dimension.rationale}>
                                    {DIMENSION_LABELS[dimension.dimension]?.[lang] ?? dimension.dimension}
                                  </div>
                                  <div className={`text-xs font-semibold ${dimension.passed ? "text-success" : "text-danger"}`}>
                                    {dimension.score}/10
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <details className="text-[10px] text-muted">
                          <summary className="cursor-pointer select-none font-medium focus-visible:ring-2 focus-visible:ring-accent">
                            {copy.execution}
                          </summary>
                          <dl className="mt-1.5 grid gap-x-3 gap-y-1.5 sm:grid-cols-2">
                            {shown.implementation_session_id && (
                              <div className="min-w-0">
                                <dt>{copy.implementationAgent}</dt>
                                <dd className="break-all font-mono">{shown.implementation_session_id}</dd>
                              </div>
                            )}
                            {shown.evaluator_session_id && (
                              <div className="min-w-0">
                                <dt>{copy.evaluatorAgent}</dt>
                                <dd className="break-all font-mono">{shown.evaluator_session_id}</dd>
                              </div>
                            )}
                            {shown.fix_session_ids.length > 0 && (
                              <div className="min-w-0 sm:col-span-2">
                                <dt>{copy.fixAgents}</dt>
                                {shown.fix_session_ids.map((sessionId) => (
                                  <dd key={sessionId} className="break-all font-mono">{sessionId}</dd>
                                ))}
                              </div>
                            )}
                          </dl>
                        </details>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <RecoveryHistory goalId={goalId} />

      {status?.status === "failed" && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-danger">
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
            {copy.failedStage}
          </div>
          <ActivityLog
            events={activityEvents}
            highlightFailures
            maxEvents={8}
            steeringNotes={steeringNotes}
            resolveSteeringStep={resolveSteeringStep}
          />
        </div>
      )}

      {status?.status !== "failed" && (activityEvents.length > 0 || (steeringNotes?.length ?? 0) > 0) && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
            {copy.activity}
          </div>
          <ActivityLog
            events={activityEvents}
            compact
            maxEvents={5}
            steeringNotes={steeringNotes}
            resolveSteeringStep={resolveSteeringStep}
          />
        </div>
      )}
    </section>
  );
}
