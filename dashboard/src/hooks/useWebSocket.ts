import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../stores/useStore";
import { useToast } from "../stores/useToast";
import { getApiKey } from "../lib/api";

/** Send a message through the active WebSocket connection. */
export function wsSend(data: Record<string, unknown>): void {
  const ws = _wsInstance;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

let _wsInstance: WebSocket | null = null;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    // dev 환경에서는 Vite proxy를 우회해 백엔드에 직접 연결
    // (Vite /ws proxy가 탐침 연결을 시도해 서버 측 EPIPE를 유발하므로 제거됨)
    const wsHost = import.meta.env.VITE_WS_URL ?? `${protocol}//${window.location.host}`;

    let destroyed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_DELAY = 30000;

    function connect() {
      // API 키가 없으면 연결 지연 — initAuth() 완료 대기
      const token = getApiKey();
      if (!token) {
        if (!destroyed) reconnectTimer = setTimeout(connect, 1000);
        return;
      }
      // 토큰을 URL 쿼리 대신 첫 메시지로 전송 (#12)
      const wsUrl = `${wsHost}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      _wsInstance = ws;

      ws.onopen = () => {
        reconnectAttempts = 0; // Reset on successful connection
        // auth 메시지를 먼저 전송 — connected 응답 후 setConnected(true) 처리
        try {
          ws.send(JSON.stringify({ type: "auth", token }));
        } catch {
          // ignore
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            case "connected":
              // auth 방식: 서버가 connected를 보내면 인증 완료
              useStore.getState().setConnected(true);
              break;
            case "task:updated":
              useStore.getState().updateTask(msg.payload);
              window.dispatchEvent(new CustomEvent("nova:task-updated-event", { detail: msg.payload }));
              break;
            case "team_design:status":
              window.dispatchEvent(new CustomEvent("nova:team-design-status", { detail: msg.payload }));
              break;
            case "task:started":
              window.dispatchEvent(new CustomEvent("nova:task-started", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "task:completed":
              window.dispatchEvent(new CustomEvent("nova:task-completed", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "verification:result":
              window.dispatchEvent(new CustomEvent("nova:verification-result", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "agent:output":
              // Still dispatch for AgentTerminal in agent detail view
              window.dispatchEvent(
                new CustomEvent("nova:agent-output", {
                  detail: { agentId: msg.payload.agentId, output: msg.payload.output },
                })
              );
              break;
            case "agent:prompt-complete":
              window.dispatchEvent(
                new CustomEvent("nova:prompt-complete", { detail: msg.payload })
              );
              // Also trigger refresh to sync agent status
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "multi-prompt:agent-done":
              window.dispatchEvent(
                new CustomEvent("nova:multi-agent-done", { detail: msg.payload })
              );
              // Refresh to sync agent status changes
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "multi-prompt:complete":
              window.dispatchEvent(
                new CustomEvent("nova:multi-complete", { detail: msg.payload })
              );
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "task:usage":
              window.dispatchEvent(
                new CustomEvent("nova:task-usage", { detail: msg.payload })
              );
              break;
            case "system:rate-limit":
              window.dispatchEvent(new CustomEvent("nova:rate-limit", { detail: msg.payload }));
              // Also trigger refresh
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "task:delegated":
              window.dispatchEvent(new CustomEvent("nova:task-delegated", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "queue:paused":
              window.dispatchEvent(new CustomEvent("nova:queue-paused", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "queue:resumed":
              window.dispatchEvent(new CustomEvent("nova:queue-resumed", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "queue:stopped":
              window.dispatchEvent(new CustomEvent("nova:queue-stopped", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "autopilot:mode-changed":
              window.dispatchEvent(new CustomEvent("nova:autopilot-changed", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "autopilot:full-completed":
              window.dispatchEvent(new CustomEvent("nova:autopilot-full-completed", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "autopilot:full-status":
              window.dispatchEvent(new CustomEvent("nova:autopilot-full-status", { detail: msg.payload }));
              break;
            case "agent:activity":
              // Live activity feed for TaskDetail — no full refresh, just append
              window.dispatchEvent(new CustomEvent("nova:agent-activity", { detail: msg.payload }));
              break;
            case "agent:status":
            case "project:updated":
              // Trigger a refetch — handled by components
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "system:error":
              window.dispatchEvent(new CustomEvent("nova:system-error", { detail: msg.payload }));
              break;
            case "task:git":
              window.dispatchEvent(new CustomEvent("nova:task-git", { detail: msg.payload }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            case "project:branch-merge-complete":
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: { type: msg.type, data: msg.payload } }));
              break;
            case "goal:squash_ready": {
              const { goalId, commitMessage, filesChanged, acceptanceOutput } = msg.payload;
              // H-1: 퇴행 방지 — merged/approved 상태에서 pending_approval로 되돌리지 않음
              const currentGoal = useStore.getState().goals.find((g) => g.id === goalId);
              if (currentGoal?.squash_status === "merged" || currentGoal?.squash_status === "approved") {
                break;
              }
              useStore.getState().updateGoal({ id: goalId, squash_status: "pending_approval" });
              useToast.getState().showToast(t("toastSquashReady"), "info");
              window.dispatchEvent(new CustomEvent("nova:goal-squash-ready", {
                detail: { goalId, commitMessage, filesChanged, acceptanceOutput },
              }));
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            }
            case "goal:squash_resolving": {
              const { goalId } = msg.payload;
              // 퇴행 방지 — merged 상태에서 resolving으로 되돌리지 않음
              const resolvingGoal = useStore.getState().goals.find((g) => g.id === goalId);
              if (resolvingGoal?.squash_status === "merged") {
                break;
              }
              useStore.getState().updateGoal({ id: goalId, squash_status: "resolving" });
              useToast.getState().showToast(t("toastSquashResolving"), "info");
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            }
            case "goal:merged": {
              const { goalId, sha } = msg.payload;
              useStore.getState().updateGoal({ id: goalId, squash_status: "merged", squash_commit_sha: sha });
              useToast.getState().showToast(t("toastSquashMerged", { sha: String(sha ?? "").slice(0, 7) }), "success");
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            }
            case "goal:squash_blocked": {
              const { goalId, output, reason } = msg.payload;
              // H-1: 퇴행 방지 — merged 상태에서 blocked로 되돌리지 않음
              const blockedGoal = useStore.getState().goals.find((g) => g.id === goalId);
              if (blockedGoal?.squash_status === "merged") {
                break;
              }
              useStore.getState().updateGoal({ id: goalId, squash_status: "blocked" });
              useToast.getState().showToast(t("toastSquashBlocked"), "error", output ?? reason);
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            }
            case "goal:squash_failed": {
              const { goalId, error } = msg.payload;
              // H-1: 퇴행 방지 — merged 상태에서 none으로 되돌리지 않음
              const failedGoal = useStore.getState().goals.find((g) => g.id === goalId);
              if (failedGoal?.squash_status === "merged") {
                break;
              }
              useStore.getState().updateGoal({ id: goalId, squash_status: "none" });
              useToast.getState().showToast(t("toastSquashFailed"), "error", error);
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            }
            case "goal:qa_regression_created": {
              const { goalId, qaTaskId } = msg.payload;
              useStore.getState().updateGoal({ id: goalId, qa_regression_task_id: qaTaskId });
              window.dispatchEvent(new CustomEvent("nova:refresh", { detail: msg }));
              break;
            }
          }
        } catch {
          // Ignore
        }
      };

      ws.onclose = () => {
        useStore.getState().setConnected(false);
        if (!destroyed) {
          // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 30s
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
          reconnectAttempts++;
          reconnectTimer = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      _wsInstance = null;
    };
  }, []);
}
