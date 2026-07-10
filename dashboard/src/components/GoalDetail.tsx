import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityLog } from "./ActivityLog";
import {
  type GoalStatus,
  type GoalStatusResponse,
  useGoalStatusStore,
} from "../stores/goals";

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
      completed: "Completed",
    },
    activity: "Activity",
    failedStage: "Failed stage",
    isolatedWorkspace: "Isolated workspace",
    savePoint: "Save point",
    evaluator: "Evaluator",
    loadFailed: "Could not load goal status",
  },
  ko: {
    status: {
      running: "진행 중",
      failed: "실패",
      pending_approval: "목표 반영 대기 중",
      completed: "완료",
    },
    activity: "활동",
    failedStage: "실패 단계",
    isolatedWorkspace: "독립된 작업 공간",
    savePoint: "저장 지점",
    evaluator: "검증 에이전트",
    loadFailed: "목표 상태를 불러오지 못했습니다",
  },
};

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
        chip: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400",
        dot: "bg-amber-500",
        panel: "border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10",
      };
    case "failed":
      return {
        chip: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400",
        dot: "bg-red-500",
        panel: "border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-900/10",
      };
    case "completed":
      return {
        chip: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400",
        dot: "bg-green-500",
        panel: "border-green-200 dark:border-green-800 bg-green-50/60 dark:bg-green-900/10",
      };
    case "running":
      return {
        chip: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400",
        dot: "bg-blue-500",
        panel: "border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10",
      };
  }
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.slice(-2).join("/");
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
  const storeStatus = useGoalStatusStore((state) => state.byGoalId[goalId]);
  const loading = useGoalStatusStore((state) => Boolean(state.loadingByGoalId[goalId]));
  const storeError = useGoalStatusStore((state) => state.errorByGoalId[goalId]);
  const setGoalStatus = useGoalStatusStore((state) => state.setGoalStatus);
  const fetchGoalStatus = useGoalStatusStore((state) => state.fetchGoalStatus);
  const status = storeStatus ?? initialStatus;

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
    };
    load();
    window.addEventListener("crewdeck:refresh", load);
    return () => window.removeEventListener("crewdeck:refresh", load);
  }, [autoLoad, copy.loadFailed, fetchGoalStatus, goalId, onStatusChange]);

  const statusTone = useMemo(
    () => (status ? getStatusTone(status.status) : getStatusTone("running")),
    [status],
  );

  const activityEvents = status?.activity_events ?? [];
  const errorMessage = localError ?? storeError;

  return (
    <section
      className={`rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-[#25253d] ${className}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          {title && (
            <h3 className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
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
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400 dark:bg-gray-700 dark:text-gray-500">
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
          <div className="grid gap-2 text-[11px] text-gray-600 dark:text-gray-400 sm:grid-cols-3">
            {status.worktree_path && (
              <div className="min-w-0">
                <span className="block font-medium text-gray-400 dark:text-gray-500">
                  {copy.isolatedWorkspace}
                </span>
                <span className="block truncate font-mono" title={status.worktree_path}>
                  {shortPath(status.worktree_path)}
                </span>
              </div>
            )}
            {status.worktree_branch && (
              <div className="min-w-0">
                <span className="block font-medium text-gray-400 dark:text-gray-500">
                  {copy.savePoint}
                </span>
                <span className="block truncate font-mono" title={status.worktree_branch}>
                  {status.worktree_branch}
                </span>
              </div>
            )}
            {status.evaluator_session_id && (
              <div className="min-w-0">
                <span className="block font-medium text-gray-400 dark:text-gray-500">
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
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {errorMessage}
        </div>
      )}

      {status?.status === "failed" && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {copy.failedStage}
          </div>
          <ActivityLog events={activityEvents} highlightFailures maxEvents={8} />
        </div>
      )}

      {status?.status !== "failed" && activityEvents.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {copy.activity}
          </div>
          <ActivityLog events={activityEvents} compact maxEvents={5} />
        </div>
      )}
    </section>
  );
}
