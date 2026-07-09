import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

interface Activity {
  id: number;
  type: string;
  message: string;
  agent_id: string | null;
  created_at: string;
}

interface ActivityFeedProps {
  projectId: string;
}

/** Simplify cryptic technical error messages for non-developer users */
function humanizeMessage(msg: string): string {
  return msg
    .replace(/\[CLI_EXIT_NONZERO\]:\s*/gi, "에이전트 실행 실패: ")
    .replace(/Agent CLI exited with code \d+/gi, "에이전트가 비정상 종료됨")
    .replace(/ENOENT/gi, "파일을 찾을 수 없음")
    .replace(/EACCES/gi, "권한 부족")
    .replace(/ENOMEM/gi, "메모리 부족")
    .replace(/EPERM/gi, "권한 부족")
    .replace(/SIGTERM/gi, "중단됨")
    .replace(/SIGKILL/gi, "강제 종료됨")
    .replace(/null reference/gi, "내부 오류")
    .replace(/rate limit/gi, "사용량 한도 초과");
}

const TYPE_ICONS: Record<string, string> = {
  task_started: "▶",
  task_completed: "✅",
  verification_pass: "✔",
  verification_fail: "✗",
  agent_started: "🤖",
  agent_stopped: "⏹",
  "system:error": "⚠",
  "task:git": "⬆",
};

function formatTime(iso: string): string {
  // SQLite datetime('now') returns UTC without 'Z' suffix — append it
  const normalized = iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z";
  return new Date(normalized).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatWsMessage(
  type: string,
  payload: unknown,
  t: (key: string, opts?: Record<string, string>) => string,
): string {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, string>;

  switch (type) {
    case "agent:status": {
      const statusLabel = t(`agentStatus_${p.status}`) || p.status || "";
      return t("activityAgentStatus", { name: p.name ?? t("agentUnnamed"), status: statusLabel });
    }
    case "task:updated":
      return t("activityTaskUpdated", { title: p.title ?? "", status: p.status ?? "" });
    case "task:started":
      return t("activityTaskStarted", { title: p.title ?? "" });
    case "task:completed":
      return t("activityTaskCompleted", { title: p.title ?? "" });
    case "verification:result": {
      const rawVerdict = p.verdict ?? (p.passed === "true" ? "pass" : p.passed === "false" ? "fail" : "");
      const verdictLabel = t(`verdict_${rawVerdict}`) || rawVerdict;
      return t("activityVerification", { verdict: verdictLabel });
    }
    case "project:updated":
      return t("activityProjectUpdated");
    case "system:error": {
      // payload.error는 문자열 또는 { message } 객체 양쪽으로 broadcast됨
      const err = p.error as unknown;
      const errMsg =
        (typeof err === "string" ? err : (err as { message?: string } | null)?.message) ??
        p.message ??
        type;
      const errAgent = p.agentName ? `[${p.agentName}] ` : "";
      return `${errAgent}${t("activitySystemError", { message: errMsg })}`;
    }
    case "task:git": {
      const parts: string[] = [];
      if (p.committed) parts.push(t("gitCommitted", { count: String(p.filesChanged ?? 0) }));
      if (p.pushed) parts.push(t("gitPushed"));
      if (p.prUrl) parts.push(t("gitPrCreated"));
      return parts.length > 0 ? parts.join(" → ") : t("activityGitEvent");
    }
    default:
      return t("activityUnknown", { type });
  }
}

export function ActivityFeed({ projectId }: ActivityFeedProps) {
  const { t } = useTranslation();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  const wsIdRef = useRef(0);
  const buildWsActivity = useCallback(
    (detail: { type: string; payload?: unknown }): Activity => ({
      id: -(++wsIdRef.current),
      type: detail.type,
      message: formatWsMessage(detail.type, detail.payload, t),
      agent_id: (detail.payload as Record<string, string> | null)?.agent_id ?? null,
      created_at: new Date().toISOString(),
    }),
    [t],
  );

  // Initial load from REST API
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    api.activities
      .list(projectId)
      .then((data) => {
        setActivities(data);
      })
      .catch(() => {
        setActivities([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [projectId]);

  // Prepend real-time WebSocket events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.type) return;
      setActivities((prev) => [buildWsActivity(detail), ...prev].slice(0, 50));
    };

    const errorHandler = (e: Event) => {
      const payload = (e as CustomEvent).detail;
      setActivities((prev) =>
        [buildWsActivity({ type: "system:error", payload }), ...prev].slice(0, 50),
      );
    };

    const gitHandler = (e: Event) => {
      const payload = (e as CustomEvent).detail;
      setActivities((prev) =>
        [buildWsActivity({ type: "task:git", payload }), ...prev].slice(0, 50),
      );
    };

    window.addEventListener("crewdeck:refresh", handler);
    window.addEventListener("crewdeck:system-error", errorHandler);
    window.addEventListener("crewdeck:task-git", gitHandler);
    return () => {
      window.removeEventListener("crewdeck:refresh", handler);
      window.removeEventListener("crewdeck:system-error", errorHandler);
      window.removeEventListener("crewdeck:task-git", gitHandler);
    };
  }, [buildWsActivity]);

  if (loading) {
    return <p className="text-xs text-gray-400 italic">{t("loadingActivity")}</p>;
  }

  if (activities.length === 0) {
    return (
      <p className="text-xs text-gray-400 italic">
        {t("noActivity")}
      </p>
    );
  }

  return (
    <div className="space-y-1.5 px-3 py-2">
      {activities.map((a) => (
        <div key={a.id} className="flex items-start gap-2 text-xs">
          <span className={`shrink-0 w-4 text-center ${a.type === "system:error" ? "text-red-500" : ""}`}>
            {TYPE_ICONS[a.type] ?? "•"}
          </span>
          <div className="min-w-0 flex-1">
            <span className={`break-words ${a.type === "system:error" ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>
              {humanizeMessage(a.message)}
            </span>
          </div>
          <span className="shrink-0 text-gray-300 dark:text-gray-600 tabular-nums">
            {formatTime(a.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}
