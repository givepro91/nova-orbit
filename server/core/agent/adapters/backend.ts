/**
 * Provider-중립 에이전트 백엔드 추상화.
 *
 * 기존 `ClaudeCodeSession`(EventEmitter) 이벤트 계약과 `RunResult` 반환 타입을 그대로 재사용해,
 * claude / codex 두 백엔드가 동일한 세션 인터페이스를 구현하도록 한다. 소비자(session.ts 등)는
 * provider를 몰라도 `AgentSession`만 다루면 된다.
 */
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createClaudeCodeAdapter, type ClaudeCodeConfig, type RunResult } from "./claude-code.js";
import { createCodexAdapter } from "./codex.js";

export type AgentProvider = "claude" | "codex";

export interface AgentSession extends EventEmitter {
  id: string;
  process: ChildProcess | null;
  status: "idle" | "working" | "completed" | "failed";
  lastSessionId: string | null;
  send(message: string): Promise<RunResult>;
  kill(): void;
  cleanup(): void;
}

export type AgentBackendConfig = ClaudeCodeConfig & { provider?: AgentProvider };

export interface AgentBackend {
  readonly provider: AgentProvider;
  spawn(config: AgentBackendConfig): AgentSession;
  /** CLI가 설치·인증돼 실제 사용 가능한지. failover 결정에 쓰인다. */
  isAvailable(): Promise<boolean>;
}

/** provider별 백엔드 인스턴스를 반환한다. */
export function getBackend(provider: AgentProvider): AgentBackend {
  if (provider === "codex") {
    return createCodexAdapter();
  }
  const claude = createClaudeCodeAdapter();
  return {
    provider: "claude",
    spawn: (config) => claude.spawn(config),
    isAvailable: async () => true, // claude CLI는 런타임 전제(AGENTS.md)
  };
}
