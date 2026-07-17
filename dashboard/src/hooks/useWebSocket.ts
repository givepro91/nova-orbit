import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../stores/useStore";
import { useToast } from "../stores/useToast";
import { useActivityStore } from "../stores/activityStore";
import { useLiveSessionStore } from "../stores/liveSession";
import { getApiKey } from "../lib/api";

/** Send a message through the active WebSocket connection. */
export function wsSend(data: Record<string, unknown>): void {
  trackSubscription(data);
  const ws = _wsInstance;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

let _wsInstance: WebSocket | null = null;

// --- 재연결 복구: 구독 레지스트리 -----------------------------------------
// subscribe:terminal/agent는 전부 wsSend를 경유하므로 여기서 추적(dedupe)하고,
// 재연결 후 서버 connected 수신 시 전부 재전송한다. 연결이 닫혀 있는 동안의
// 구독 요청도 레지스트리에는 남으므로 재연결 시 함께 복구된다.
// (서버 측 Set add는 중복에 멱등 — websocket.ts subscribe 처리 확인됨)
const _subscriptions = new Map<string, Record<string, unknown>>();

function trackSubscription(data: Record<string, unknown>): void {
  const { type } = data;
  if (type === "subscribe:terminal" && typeof data.terminalId === "string") {
    _subscriptions.set(`terminal:${data.terminalId}`, data);
  } else if (type === "unsubscribe:terminal" && typeof data.terminalId === "string") {
    _subscriptions.delete(`terminal:${data.terminalId}`);
  } else if (type === "subscribe:agent" && typeof data.agentId === "string") {
    _subscriptions.set(`agent:${data.agentId}`, data);
  } else if (type === "unsubscribe:agent" && typeof data.agentId === "string") {
    _subscriptions.delete(`agent:${data.agentId}`);
  }
}

// --- 중앙 코얼레싱: crewdeck:refresh trailing 디바운스 ----------------------
// WS 이벤트 burst가 리스너들의 REST 재조회 폭풍이 되지 않도록 모든 refresh
// 발화를 한 곳에서 모아 trailing 디바운스한다. 디바운스 창 안에서 projectId가
// 하나로 일관되면 detail.projectId로 스코프를 전달하고, 서로 다른 프로젝트가
// 섞이거나 스코프를 알 수 없으면 전역(빈 detail)으로 발화한다.
const REFRESH_DEBOUNCE_MS = 400;
// trailing 디바운스 상한 — WS 이벤트가 400ms 간격 미만으로 계속 이어지면(장시간 burst)
// trailing 창이 무한 연장돼 refresh가 영영 안 나간다. 첫 pending 시각 기준 2s를 넘기면
// 강제 발화해 "실행 중 내내 화면이 안 갱신되는" 기아를 막는다.
const REFRESH_MAX_WAIT_MS = 2000;
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
// undefined = 대기 중인 발화 없음 / null = 전역 / string = 단일 프로젝트 스코프
let _pendingRefreshProjectId: string | null | undefined = undefined;
// 현재 pending 묶음의 최초 도착 시각 — max-wait 계산 기준.
let _refreshFirstPendingAt: number | null = null;

function requestRefresh(projectId?: string): void {
  if (_pendingRefreshProjectId === undefined) {
    _pendingRefreshProjectId = projectId ?? null;
    _refreshFirstPendingAt = Date.now();
  } else if (!projectId || _pendingRefreshProjectId !== projectId) {
    _pendingRefreshProjectId = null;
  }
  if (_refreshTimer) clearTimeout(_refreshTimer);
  const waited = Date.now() - (_refreshFirstPendingAt ?? Date.now());
  const delay = Math.min(REFRESH_DEBOUNCE_MS, Math.max(0, REFRESH_MAX_WAIT_MS - waited));
  _refreshTimer = setTimeout(() => {
    const scoped = _pendingRefreshProjectId;
    _refreshTimer = null;
    _pendingRefreshProjectId = undefined;
    _refreshFirstPendingAt = null;
    // detail은 항상 객체로 — 일부 리스너가 detail 프로퍼티를 옵셔널 체이닝 없이
    // 읽으므로(예: AgentChatLog의 ev.detail.taskId) null detail은 금지.
    window.dispatchEvent(
      new CustomEvent("crewdeck:refresh", { detail: scoped ? { projectId: scoped } : {} }),
    );
  }, delay);
}

function clearPendingRefresh(): void {
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
  _pendingRefreshProjectId = undefined;
  _refreshFirstPendingAt = null;
}

/** WS 메시지에서 refresh 스코프용 projectId를 최선노력으로 추출. */
function extractProjectId(detail: { payload?: unknown; data?: unknown }): string | undefined {
  for (const source of [detail.payload, detail.data]) {
    if (!source || typeof source !== "object") continue;
    const record = source as Record<string, unknown>;
    const pid = record.projectId ?? record.project_id;
    if (typeof pid === "string") return pid;
  }
  return undefined;
}

/**
 * refresh 계열 WS 메시지의 단일 발화 헬퍼.
 * - crewdeck:ws-event: 메시지 데이터를 직접 읽는 소비자(ActivityFeed·ProjectSettings)용
 *   즉시 패스스루 — 코얼레싱하면 개별 payload가 유실되므로 디바운스하지 않는다.
 * - crewdeck:refresh: REST 재조회 리스너용 — 위 디바운스로 코얼레싱.
 */
function emitRefresh(detail: { type: string; payload?: unknown; data?: unknown }): void {
  // detail.projectId: 메시지에서 추출한 스코프(불명이면 undefined) — 소비자
  // (ActivityFeed 등)가 다른 프로젝트의 이벤트를 자기 화면에 섞지 않도록 함께 싣는다.
  const projectId = extractProjectId(detail);
  window.dispatchEvent(new CustomEvent("crewdeck:ws-event", { detail: { ...detail, projectId } }));
  requestRefresh(projectId);
}

/** 테스트 전용 — 모듈 레벨 실시간 상태 초기화 (레지스트리·디바운스 타이머). */
export function _resetRealtimeStateForTests(): void {
  _subscriptions.clear();
  clearPendingRefresh();
}

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
    // 재연결 복구 가드: 최초 연결의 connected는 마운트 직후 컴포넌트 초기 로드와
    // 겹치므로 refresh만 스킵한다. 구독 replay는 최초 연결에도 무조건 수행 —
    // 연결이 닫혀 있는 동안 레지스트리에 쌓인 구독(예: 서버 재시작 대기 중 연
    // 터미널)은 최초 connected가 유일한 복구 기회이고, 서버 측 Set add는 멱등이다.
    let hasConnectedOnce = false;
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
              // 구독 replay는 무조건 — 서버가 onTerminalSubscribe에서 스냅샷을
              // 재전송하므로 터미널 화면이 즉시 복원된다. 서버 측 Set add가 멱등이라
              // 최초 연결에 replay해도 부작용이 없고, 연결 전에 쌓인 구독도 복구된다.
              for (const sub of _subscriptions.values()) {
                try {
                  ws.send(JSON.stringify(sub));
                } catch {
                  // ignore
                }
              }
              if (hasConnectedOnce) {
                // 전역 재동기화 refresh 1회(코얼레싱 경유)는 재연결에만 — 최초
                // 연결은 마운트 직후 컴포넌트 초기 로드와 겹쳐 이중 조회가 된다.
                requestRefresh();
              }
              hasConnectedOnce = true;
              break;
            case "task:updated":
              useStore.getState().updateTask(msg.payload);
              window.dispatchEvent(new CustomEvent("crewdeck:task-updated-event", { detail: msg.payload }));
              break;
            case "activity:created":
            case "provider:resolved":
            case "provider:failover":
            case "provider:redispatched":
              // 실행 엔진 해석·자동 전환·재디스패치 관측 이벤트를 활동 피드에 즉시 반영.
              // activity:created(범용 recordActivity 싱크)와 provider:*(typed)를 모두 넘기되,
              // 중복은 activityStore에서 걸러진다(provider:*가 provider 항목을 소유).
              useActivityStore.getState().ingestWsEvent(msg.type, msg.payload);
              // recovery incident/blocked 사용자 조치는 열린 Goal 상세(RecoveryHistory)가
              // crewdeck:refresh로만 재조회하므로, 새로고침 없이 즉시 보이도록 함께 발생시킨다.
              if (
                msg.type === "activity:created" &&
                ["recovery_incident", "recovery_manual_action", "recovery_promoted"].includes(msg.payload?.type)
              ) {
                emitRefresh(msg);
              }
              break;
            case "team_design:status":
              window.dispatchEvent(new CustomEvent("crewdeck:team-design-status", { detail: msg.payload }));
              break;
            case "task:started":
              window.dispatchEvent(new CustomEvent("crewdeck:task-started", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "task:completed":
              window.dispatchEvent(new CustomEvent("crewdeck:task-completed", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "verification:result":
              window.dispatchEvent(new CustomEvent("crewdeck:verification-result", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "agent:output":
              // Still dispatch for AgentTerminal in agent detail view
              window.dispatchEvent(
                new CustomEvent("crewdeck:agent-output", {
                  detail: { agentId: msg.payload.agentId, output: msg.payload.output },
                })
              );
              break;
            case "agent:prompt-complete":
              window.dispatchEvent(
                new CustomEvent("crewdeck:prompt-complete", { detail: msg.payload })
              );
              // Also trigger refresh to sync agent status
              emitRefresh(msg);
              break;
            case "multi-prompt:agent-done":
              window.dispatchEvent(
                new CustomEvent("crewdeck:multi-agent-done", { detail: msg.payload })
              );
              // Refresh to sync agent status changes
              emitRefresh(msg);
              break;
            case "multi-prompt:complete":
              window.dispatchEvent(
                new CustomEvent("crewdeck:multi-complete", { detail: msg.payload })
              );
              emitRefresh(msg);
              break;
            case "task:usage":
              window.dispatchEvent(
                new CustomEvent("crewdeck:task-usage", { detail: msg.payload })
              );
              break;
            case "system:rate-limit":
              window.dispatchEvent(new CustomEvent("crewdeck:rate-limit", { detail: msg.payload }));
              // Also trigger refresh
              emitRefresh(msg);
              break;
            case "task:delegated":
              window.dispatchEvent(new CustomEvent("crewdeck:task-delegated", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "queue:paused":
              window.dispatchEvent(new CustomEvent("crewdeck:queue-paused", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "queue:resumed":
              window.dispatchEvent(new CustomEvent("crewdeck:queue-resumed", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "queue:stopped":
              window.dispatchEvent(new CustomEvent("crewdeck:queue-stopped", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "autopilot:mode-changed":
              window.dispatchEvent(new CustomEvent("crewdeck:autopilot-changed", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "autopilot:full-completed":
              window.dispatchEvent(new CustomEvent("crewdeck:autopilot-full-completed", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "autopilot:full-status":
              window.dispatchEvent(new CustomEvent("crewdeck:autopilot-full-status", { detail: msg.payload }));
              break;
            case "agent:activity":
              // Live activity feed for TaskDetail — no full refresh, just append
              window.dispatchEvent(new CustomEvent("crewdeck:agent-activity", { detail: msg.payload }));
              break;
            case "agent:status":
            case "project:updated":
              // Trigger a refetch — handled by components
              emitRefresh(msg);
              break;
            case "system:error":
              window.dispatchEvent(new CustomEvent("crewdeck:system-error", { detail: msg.payload }));
              break;
            case "task:git":
              window.dispatchEvent(new CustomEvent("crewdeck:task-git", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "project:branch-merge-complete":
              emitRefresh({ type: msg.type, data: msg.payload });
              break;
            case "goal:squash_ready": {
              const { goalId, commitMessage, filesChanged, acceptanceOutput, workReport, skippedTasks } = msg.payload;
              // H-1: 퇴행 방지 — merged/approved 상태에서 pending_approval로 되돌리지 않음
              const currentGoal = useStore.getState().goals.find((g) => g.id === goalId);
              if (currentGoal?.squash_status === "merged" || currentGoal?.squash_status === "approved") {
                break;
              }
              useStore.getState().updateGoal({ id: goalId, squash_status: "pending_approval" });
              useToast.getState().showToast(t("toastSquashReady"), "info");
              window.dispatchEvent(new CustomEvent("crewdeck:goal-squash-ready", {
                detail: { goalId, commitMessage, filesChanged, acceptanceOutput, workReport, skippedTasks },
              }));
              emitRefresh(msg);
              break;
            }
            case "goal:work_report":
              // 비동기 서사 요약 완료 — 승인창이 병합해 갱신
              window.dispatchEvent(new CustomEvent("crewdeck:goal-work-report", { detail: msg.payload }));
              break;
            case "goal:squash_resolving": {
              const { goalId } = msg.payload;
              // 퇴행 방지 — merged 상태에서 resolving으로 되돌리지 않음
              const resolvingGoal = useStore.getState().goals.find((g) => g.id === goalId);
              if (resolvingGoal?.squash_status === "merged") {
                break;
              }
              useStore.getState().updateGoal({ id: goalId, squash_status: "resolving" });
              useToast.getState().showToast(t("toastSquashResolving"), "info");
              emitRefresh(msg);
              break;
            }
            case "goal:merged": {
              const { goalId, sha, prUrl, prNumber, mergeOutcome, prState } = msg.payload;
              useStore.getState().updateGoal({
                id: goalId, squash_status: "merged", squash_commit_sha: sha,
                merge_outcome: mergeOutcome ?? null,
                pr_url: prUrl ?? null,
                pr_number: prNumber ?? null,
                pr_state: prState ?? null,
              });
              // pr_open은 실제 머지가 아니라 PR 생성 — 다른 토스트로 정직하게 알린다
              if (mergeOutcome === "pr_open") {
                useToast.getState().showToast(t("toastPrCreated"), "info", prUrl ?? undefined);
              } else {
                useToast.getState().showToast(t("toastSquashMerged", { sha: String(sha ?? "").slice(0, 7) }), "success");
              }
              emitRefresh(msg);
              break;
            }
            case "goal:pr_state": {
              const { goalId, prState, prStateCheckedAt } = msg.payload;
              useStore.getState().updateGoal({ id: goalId, pr_state: prState, pr_state_checked_at: prStateCheckedAt ?? null });
              emitRefresh(msg);
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
              emitRefresh(msg);
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
              emitRefresh(msg);
              break;
            }
            case "goal:qa_regression_created": {
              const { goalId, qaTaskId } = msg.payload;
              useStore.getState().updateGoal({ id: goalId, qa_regression_task_id: qaTaskId });
              emitRefresh(msg);
              break;
            }
            case "chat:event":
              window.dispatchEvent(new CustomEvent("crewdeck:chat-event", { detail: msg.payload }));
              break;
            case "terminal:data":
              window.dispatchEvent(new CustomEvent("crewdeck:terminal-data", { detail: msg.payload }));
              break;
            case "terminal:snapshot":
              window.dispatchEvent(new CustomEvent("crewdeck:terminal-snapshot", { detail: msg.payload }));
              break;
            case "terminal:exit":
              window.dispatchEvent(new CustomEvent("crewdeck:terminal-exit", { detail: msg.payload }));
              break;
            case "terminal:dismissed":
              window.dispatchEvent(new CustomEvent("crewdeck:terminal-dismissed", { detail: msg.payload }));
              break;
            case "terminal:bridge":
              window.dispatchEvent(new CustomEvent("crewdeck:terminal-bridge", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "terminal:binding":
              window.dispatchEvent(new CustomEvent("crewdeck:terminal-binding", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "terminal:decision":
              window.dispatchEvent(new CustomEvent("crewdeck:terminal-decision", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "terminal:activity":
              window.dispatchEvent(new CustomEvent("crewdeck:terminal-activity", { detail: msg.payload }));
              break;
            case "terminal:review":
              window.dispatchEvent(new CustomEvent("crewdeck:terminal-review", { detail: msg.payload }));
              emitRefresh(msg);
              break;
            case "session:stream":
              useLiveSessionStore.getState().appendStream(msg.payload.agentId, msg.payload.events);
              break;
            case "steering:submitted":
              useLiveSessionStore.getState().applySubmitted(msg.payload.goalId, msg.payload.note);
              break;
            case "steering:injected":
              useLiveSessionStore.getState().applyInjected(
                msg.payload.goalId,
                (msg.payload.notes ?? []).map((n: { id: string }) => n.id),
                msg.payload.injectedStep,
                msg.payload.injectedAt,
              );
              break;
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
      clearPendingRefresh(); // 디바운스 타이머 누수 방지 (테스트 포함)
      wsRef.current?.close();
      _wsInstance = null;
    };
  }, [t]);
}
