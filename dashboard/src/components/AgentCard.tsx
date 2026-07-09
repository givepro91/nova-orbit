import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";
import { AgentAvatar } from "./AgentAvatar";

interface AgentStats {
  taskCount: number;
  totalTokens: number;
  totalCostUsd: number;
}

const STATUS_COLORS: Record<string, string> = {
  idle: "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
  working: "bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 animate-pulse",
  waiting_approval: "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-600 dark:text-yellow-400",
  paused: "bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-400",
  terminated: "bg-red-100 dark:bg-red-900/40 text-red-500 dark:text-red-400",
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  idle: "statusIdle",
  working: "statusWorking",
  waiting_approval: "statusWaitingApproval",
  paused: "statusPaused",
  terminated: "statusTerminated",
};

interface AgentCardProps {
  agent: {
    id: string;
    name: string;
    role: string;
    status: string;
    current_task_id: string | null;
  };
  tasks?: Array<{ id: string; title: string }>;
  onKill?: () => void;
  onDeleted?: () => void;
  onClick?: () => void;
}

export function AgentCard({ agent, tasks, onKill, onDeleted, onClick }: AgentCardProps) {
  const { t } = useTranslation();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [workingSeconds, setWorkingSeconds] = useState(0);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentTask = tasks?.find((task) => task.id === agent.current_task_id);

  useEffect(() => {
    if (agent.status === "working") {
      setWorkingSeconds(0);
      intervalRef.current = setInterval(() => {
        setWorkingSeconds((s) => s + 1);
      }, 1000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setWorkingSeconds(0);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [agent.status]);

  useEffect(() => {
    let cancelled = false;
    api.agents.stats(agent.id)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agent.id]);

  useEffect(() => {
    const handler = (e: Event) => {
      const payload = (e as CustomEvent<{ agentId: string; usage?: { totalCostUsd?: number; inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number } }>).detail;
      if (payload.agentId !== agent.id) return;
      const u = payload.usage;
      const costUsd = u?.totalCostUsd ?? 0;
      const tokens = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.cacheCreationTokens ?? 0);
      setStats((prev) =>
        prev
          ? {
              taskCount: prev.taskCount + 1,
              totalTokens: prev.totalTokens + tokens,
              totalCostUsd: prev.totalCostUsd + costUsd,
            }
          : { taskCount: 1, totalTokens: tokens, totalCostUsd: costUsd }
      );
    };
    window.addEventListener("crewdeck:task-usage", handler);
    return () => window.removeEventListener("crewdeck:task-usage", handler);
  }, [agent.id]);

  const handleKillClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirm(true);
  };

  const handleKillConfirm = async () => {
    setShowConfirm(false);
    await api.orchestration.killAgent(agent.id);
    onKill?.();
  };

  const handlePauseClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await api.orchestration.pauseAgent(agent.id);
    onKill?.(); // reuse refresh callback
  };

  const handleResumeClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await api.orchestration.resumeAgent(agent.id);
    onKill?.();
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = async () => {
    setShowDeleteConfirm(false);
    await api.agents.delete(agent.id);
    onDeleted?.();
  };

  const statusLabelKey = STATUS_LABEL_KEYS[agent.status] ?? "statusIdle";

  return (
    <>
      {showConfirm && (
        <ConfirmDialog
          message={t("confirmKillAgent")}
          onConfirm={handleKillConfirm}
          onCancel={() => setShowConfirm(false)}
        />
      )}
      {showDeleteConfirm && (
        <ConfirmDialog
          message={t("deleteAgentConfirm")}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
      <div
        className={`border rounded-lg p-2.5 bg-white dark:bg-[#25253d] transition-all cursor-pointer ${
          agent.status === "working"
            ? "border-green-400 dark:border-green-600 shadow-[0_0_12px_2px_rgba(74,222,128,0.15)] hover:border-green-500"
            : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
        }`}
        onClick={onClick}
      >
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <AgentAvatar name={agent.name} role={agent.role} size="sm" />
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{agent.name}</div>
              <div className="text-xs text-gray-400 dark:text-gray-500 capitalize">{agent.role}</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {agent.status === "working" && (
              <>
                <button
                  onClick={handlePauseClick}
                  className="text-[10px] px-1.5 py-0.5 text-yellow-500 hover:text-yellow-700 hover:bg-yellow-50 dark:hover:bg-yellow-900/30 rounded"
                >
                  {t("pauseAgent")}
                </button>
                <button
                  onClick={handleKillClick}
                  className="text-[10px] px-1.5 py-0.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded"
                  title={t("confirmKillAgent")}
                >
                  {t("stopAgent")}
                </button>
              </>
            )}
            {agent.status === "paused" && (
              <button
                onClick={handleResumeClick}
                className="text-[10px] px-1.5 py-0.5 text-green-500 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/30 rounded"
              >
                {t("resumeAgent")}
              </button>
            )}
            <button
              onClick={handleDeleteClick}
              title={t("deleteAgent")}
              className="w-5 h-5 flex items-center justify-center text-gray-300 dark:text-gray-600 hover:text-red-400 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              STATUS_COLORS[agent.status] ?? STATUS_COLORS.idle
            }`}
          >
            {t(statusLabelKey)}
          </span>
          {agent.status === "working" && (
            <span className="flex items-center gap-0.5">
              <span className="w-1 h-1 rounded-full bg-green-400 dark:bg-green-500 animate-bounce [animation-delay:0ms]" />
              <span className="w-1 h-1 rounded-full bg-green-400 dark:bg-green-500 animate-bounce [animation-delay:150ms]" />
              <span className="w-1 h-1 rounded-full bg-green-400 dark:bg-green-500 animate-bounce [animation-delay:300ms]" />
            </span>
          )}
          {agent.status === "working" && workingSeconds > 0 && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 tabular-nums">
              {workingSeconds}s
            </span>
          )}
          {currentTask && (
            <span className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
              {currentTask.title}
            </span>
          )}
        </div>
        {stats && stats.taskCount > 0 && (
          <div className="mt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
            {t("tasksCost", {
              count: stats.taskCount,
              cost: stats.totalCostUsd.toFixed(2),
            })}
            {stats.totalTokens > 0 && (
              <span className="ml-1">
                · {t("contextTokens", { count: (stats.totalTokens / 1000).toFixed(1) })}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
