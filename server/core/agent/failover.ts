/**
 * failover 결정 로직 (순수 함수).
 *
 * 세션이 실패했을 때 대체 백엔드로 재디스패치할지, 아니면 기존 쿨다운으로 갈지 결정한다.
 * - 트리거: rate_limit | session_exhausted | env_error (task_error=코드버그는 failover 안 함)
 * - failover 전역 토글이 켜져 있고, 대체 provider가 가용하며, 이 태스크 시도에서 아직 안 써봤을 때만 failover
 * - 루프 가드: triedProviders로 claude↔codex 무한 왕복 차단
 */
import type { AgentProvider } from "./adapters/backend.js";

export type FailureClass = "rate_limit" | "session_exhausted" | "env_error" | "task_error";

const TRIGGERS: FailureClass[] = ["rate_limit", "session_exhausted", "env_error"];

export interface FailoverInput {
  failure: FailureClass;
  currentProvider: AgentProvider;
  triedProviders: AgentProvider[];
  codexAvailable: boolean;
  claudeAvailable: boolean;
  failoverEnabled: boolean;
}

export type FailoverDecision =
  | { action: "failover"; toProvider: AgentProvider }
  | { action: "cooldown" };

export function decideFailover(input: FailoverInput): FailoverDecision {
  if (!input.failoverEnabled || !TRIGGERS.includes(input.failure)) {
    return { action: "cooldown" };
  }
  const alt: AgentProvider = input.currentProvider === "claude" ? "codex" : "claude";
  const altAvailable = alt === "codex" ? input.codexAvailable : input.claudeAvailable;
  if (!altAvailable || input.triedProviders.includes(alt)) {
    return { action: "cooldown" };
  }
  return { action: "failover", toProvider: alt };
}
