import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { getProviderActivityDetails, useActivityStore } from "../stores/activityStore";
import { REASON_LABEL_KEYS, providerEngineName } from "../lib/providerActivity";
import type { ActivityLogEntry } from "../types";

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
  // 활동 피드는 공유 activityStore를 단일 출처로 사용한다. provider 관측 이벤트
  // (activity:created·provider:*)는 useWebSocket이 직접 store에 ingest하므로
  // 여기서는 초기 로드와 그 외 실시간 이벤트만 store에 반영한다.
  const activities = useActivityStore((s) => s.activities);
  const loading = useActivityStore((s) => s.loading);

  // Initial load from REST API via the shared store
  useEffect(() => {
    if (!projectId) return;
    useActivityStore.getState().loadActivities(projectId);
  }, [projectId]);

  // Prepend real-time WebSocket events into the shared store.
  // id는 store가 부여(중복 없는 음수) — 이벤트 payload에 id를 싣지 않는다.
  useEffect(() => {
    const prepend = (type: string, payload: unknown) => {
      useActivityStore.getState().prependActivity({
        type,
        message: formatWsMessage(type, payload, t),
        agent_id: (payload as Record<string, string> | null)?.agent_id ?? null,
        created_at: new Date().toISOString(),
        projectId,
      });
    };

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.type) return;
      prepend(detail.type, detail.payload);
    };
    const errorHandler = (e: Event) => prepend("system:error", (e as CustomEvent).detail);
    const gitHandler = (e: Event) => prepend("task:git", (e as CustomEvent).detail);

    window.addEventListener("crewdeck:refresh", handler);
    window.addEventListener("crewdeck:system-error", errorHandler);
    window.addEventListener("crewdeck:task-git", gitHandler);
    return () => {
      window.removeEventListener("crewdeck:refresh", handler);
      window.removeEventListener("crewdeck:system-error", errorHandler);
      window.removeEventListener("crewdeck:task-git", gitHandler);
    };
  }, [t, projectId]);

  // 연속된 동일 이벤트(같은 type·메시지)를 한 줄로 접는다 — autopilot의 "정체" 류
  // 하트비트 메시지가 5분마다 반복돼 실제 이벤트(실패·fix·건너뜀)를 밀어내는 도배를
  // 막는다. provider 전환 행은 metadata가 제각각이라 병합에서 제외한다.
  const groups = useMemo(() => {
    const isTransition = (a: ActivityLogEntry) => {
      const d = getProviderActivityDetails(a);
      return d?.event === "provider:failover" || d?.event === "provider:redispatched";
    };
    const keyOf = (a: ActivityLogEntry) => `${a.type}::${humanizeMessage(a.message)}`;
    const out: { head: ActivityLogEntry; count: number; oldest: string }[] = [];
    for (const a of activities) {
      const prev = out[out.length - 1];
      if (prev && !isTransition(a) && !isTransition(prev.head) && keyOf(prev.head) === keyOf(a)) {
        prev.count += 1;
        prev.oldest = a.created_at; // 배열은 최신순 — 뒤로 갈수록 과거
      } else {
        out.push({ head: a, count: 1, oldest: a.created_at });
      }
    }
    return out;
  }, [activities]);

  if (loading) {
    return <p className="text-xs text-faint italic px-4 py-3">{t("loadingActivity")}</p>;
  }

  if (activities.length === 0) {
    return (
      <p className="text-xs text-faint italic px-4 py-3">
        {t("noActivity")}
      </p>
    );
  }

  return (
    <div className="space-y-1.5 px-3 py-2">
      {groups.map(({ head: a, count, oldest }) => {
        const providerDetails = getProviderActivityDetails(a);
        const isProviderTransition =
          providerDetails?.event === "provider:failover" || providerDetails?.event === "provider:redispatched";
        return (
          <div key={a.id} className="flex items-start gap-2 text-xs">
            <span className={`shrink-0 w-4 text-center ${a.type === "system:error" ? "text-danger" : ""}`}>
              {TYPE_ICONS[a.type] ?? "•"}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              {providerDetails && isProviderTransition && (
                <div className="flex flex-wrap items-center gap-1">
                  {(providerDetails.fromProvider || providerDetails.toProvider) && (
                    <span className="rounded-full bg-warning-subtle px-1.5 py-0.5 text-[10px] font-medium text-warning">
                      {providerEngineName(providerDetails.fromProvider)} → {providerEngineName(providerDetails.toProvider)}
                    </span>
                  )}
                  {providerDetails.reasonCode && (
                    <span className="rounded-full bg-warning-subtle px-1.5 py-0.5 text-[10px] font-medium text-warning">
                      {t(REASON_LABEL_KEYS[providerDetails.reasonCode])} · reasonCode={providerDetails.reasonCode}
                    </span>
                  )}
                  {providerDetails.loopGuardBlocked && (
                    <span className="rounded-full bg-sunken px-1.5 py-0.5 text-[10px] font-medium text-muted">
                      {t("failoverLoopGuardBlocked")}
                    </span>
                  )}
                </div>
              )}
              <span className={`break-words ${a.type === "system:error" ? "text-danger" : "text-muted"}`}>
                {humanizeMessage(a.message)}
                {count > 1 && (
                  <span
                    className="ml-1.5 inline-flex items-center rounded-full bg-sunken px-1.5 py-0.5 text-[10px] font-medium text-muted align-middle tabular-nums"
                    title={`${t("activityRepeatedTimes", { count: String(count) })} · ${formatTime(oldest)}–${formatTime(a.created_at)}`}
                  >
                    ×{count}
                  </span>
                )}
              </span>
            </div>
            <span className="shrink-0 text-muted tabular-nums">
              {formatTime(a.created_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
