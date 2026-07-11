/**
 * 채팅 세션 keep-alive 해석. 오케스트레이션 경로와 달리 턴마다 killSession 하지
 * 않고 chat-{agentId} 키로 세션을 유지해, session.send()가 --resume으로 이어지게 한다.
 */
export interface ChatSessionLike { status: string }
export interface ChatSessionDeps {
  getSession(key: string): ChatSessionLike | undefined;
  spawnAgent(agentId: string, workdir: string, sessionKey: string): ChatSessionLike;
}

/** 채팅 세션 키(단일 소스). */
export function chatSessionKey(agentId: string): string {
  return `chat-${agentId}`;
}

/**
 * 채팅 세션을 확보한다.
 * - 없으면 spawn (reused=false)
 * - idle이면 재사용 (reused=true → 호출부가 send()로 resume)
 * - working이면 { busy: true } (Phase 1은 큐 없음)
 */
export function resolveChatSession(
  deps: ChatSessionDeps,
  agentId: string,
  workdir: string,
): { session: ChatSessionLike; reused: boolean } | { busy: true } {
  const key = chatSessionKey(agentId);
  const existing = deps.getSession(key);
  if (existing) {
    if (existing.status === "working") return { busy: true };
    return { session: existing, reused: true };
  }
  return { session: deps.spawnAgent(agentId, workdir, key), reused: false };
}
