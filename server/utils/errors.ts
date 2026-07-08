// Nova Orbit — Structured Error Types (Sprint 5)

export type NovaAgentErrorCode =
  | "RATE_LIMIT"
  | "SESSION_EXPIRED"
  | "SPAWN_FAILED"
  | "TIMEOUT"
  | "CLI_EXIT_NONZERO"
  | "STREAM_ERROR"
  | "API_ERROR_LEAK";

export interface NovaAgentErrorData {
  code: NovaAgentErrorCode;
  message: string;
  detail?: string;
  recovery?: string;
}

export class NovaAgentError extends Error {
  readonly code: NovaAgentErrorCode;
  readonly detail?: string;
  readonly recovery?: string;

  constructor(data: NovaAgentErrorData) {
    super(data.message);
    this.name = "NovaAgentError";
    this.code = data.code;
    this.detail = data.detail;
    this.recovery = data.recovery;
  }

  toJSON(): NovaAgentErrorData {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      recovery: this.recovery,
    };
  }
}

// Factory helpers — map raw error signals to structured errors

export function makeRateLimitError(detail?: string): NovaAgentError {
  return new NovaAgentError({
    code: "RATE_LIMIT",
    message: "API rate limit reached. Execution paused.",
    detail,
    recovery: "Wait for the backoff period to expire or switch to a different API key.",
  });
}

export function makeSessionExpiredError(sessionId: string): NovaAgentError {
  return new NovaAgentError({
    code: "SESSION_EXPIRED",
    message: `Claude session '${sessionId}' is no longer available.`,
    detail: `Session ID: ${sessionId}`,
    recovery: "A fresh session will be started automatically on the next attempt.",
  });
}

export function makeSpawnFailedError(detail?: string): NovaAgentError {
  return new NovaAgentError({
    code: "SPAWN_FAILED",
    message: "Failed to spawn Claude Code CLI process.",
    detail,
    recovery: "Ensure the 'claude' CLI is installed and ANTHROPIC_API_KEY is set.",
  });
}

export function makeTimeoutError(timeoutMs: number): NovaAgentError {
  return new NovaAgentError({
    code: "TIMEOUT",
    message: `Task execution timed out after ${timeoutMs / 1000}s.`,
    detail: `Timeout: ${timeoutMs}ms`,
    recovery: "Break the task into smaller sub-tasks or increase the timeout limit.",
  });
}

/**
 * 에이전트 실행 실패의 책임 소재 분류 — 단일 정본.
 *
 * 태스크 상태 전이(engine)와 큐 상태 전이(scheduler)가 같은 오류를 서로
 * 다르게 분류하면, "태스크 잘못이 아닌" 전역 오류(사용량 한도·CLI 소진)가
 * 태스크의 재시도 예산을 태운다 — 실측: 세션 소진 2회로 retry 2/2가 증발한
 * 태스크가 3번째 실행에서 그대로 통과 (탑과 용병단 07-08). 반드시 양쪽 모두
 * 이 함수를 사용한다.
 *
 * - rate_limit / session_exhausted → 태스크는 todo 복귀, 큐는 backoff 쿨다운
 * - env_error → 태스크는 todo 복귀, 큐는 짧은 env 쿨다운
 * - task_error → 태스크 blocked + 재시도 예산 소모 (유일하게 태스크 책임)
 */
export type AgentFailureClass = "rate_limit" | "session_exhausted" | "env_error" | "task_error";

export function classifyAgentFailure(err: {
  message?: string;
  code?: string;
  detail?: string;
}): AgentFailureClass {
  const msg = (err.message ?? "").toLowerCase();
  const detail = (err.detail ?? "").toLowerCase();

  if (msg.includes("rate limit") || msg.includes("429") || msg.includes("too many requests")) {
    return "rate_limit";
  }

  const envSignature = (s: string) =>
    s.includes("enoent") || s.includes("eacces") || s.includes("not found") || s.includes("not installed");

  if (err.code === "SPAWN_FAILED" || envSignature(msg) || envSignature(detail)) {
    return "env_error";
  }

  // CLI가 stderr 없이 non-zero 종료 = 구독 세션 소진 신호 (관측 기반 휴리스틱).
  // stderr가 있으면 실제 오류 내용이 있는 것이므로 태스크 실패로 취급한다.
  if (err.code === "CLI_EXIT_NONZERO" && detail.trim() === "") {
    return "session_exhausted";
  }

  return "task_error";
}

/**
 * Patterns that indicate Claude Code CLI or the Anthropic API leaked an error
 * message into stdout. If any of these match the assistant text, treat the
 * task as failed regardless of exit code — the "output" is actually a crash
 * trace masquerading as task result.
 *
 * Pulsar regression: result_summary columns like
 *   "API Error: Unable to connect to API (ECONNRESET)"
 *   "Failed to authenticate. API Error: 401 authentication_error"
 * were being stored as legitimate task summaries and the task was marked
 * done + verified.
 */
export const CLI_ERROR_LEAK_PATTERNS: ReadonlyArray<RegExp> = [
  /API Error: Unable to connect/i,
  /API Error:\s*\d{3}/i,         // "API Error: 401", "API Error: 500"
  /ECONNRESET/,
  /ECONNREFUSED/,
  /authentication_error/i,
  /Failed to authenticate/i,
  /Invalid authentication credentials/i,
  /Credit balance is too low/i,
];

/**
 * Inspect a completed agent run and return a NovaAgentError if the run
 * actually failed but the adapter only logged it. Returns null if the run
 * looks legitimately successful.
 *
 * Catches the three classes of silent failures surfaced in Pulsar:
 * 1. CLI non-zero exit (stdout may contain partial output — not success)
 * 2. parseStreamJson emitted structured errors (empty stdout, all-failed JSON)
 * 3. Error signature leaked into assistant text (ECONNRESET, 401, etc.)
 */
export function detectAgentRunFailure(
  implResult: { exitCode: number | null; stderr: string },
  implParsed: { text: string; errors: string[] },
): NovaAgentError | null {
  if (implResult.exitCode !== 0 && implResult.exitCode !== null) {
    return new NovaAgentError({
      code: "CLI_EXIT_NONZERO",
      message: `Agent CLI exited with code ${implResult.exitCode}`,
      detail: (implResult.stderr || "").slice(0, 300),
      recovery: "Check network, API key, and rate limit status. Task will retry.",
    });
  }

  if (implParsed.errors.length > 0) {
    return new NovaAgentError({
      code: "STREAM_ERROR",
      message: `Agent stream produced errors: ${implParsed.errors.slice(0, 3).join("; ")}`,
      detail: implParsed.errors.join(" | ").slice(0, 400),
      recovery: "Task will retry. If this persists, the API may be unavailable.",
    });
  }

  for (const pattern of CLI_ERROR_LEAK_PATTERNS) {
    if (pattern.test(implParsed.text)) {
      return new NovaAgentError({
        code: "API_ERROR_LEAK",
        message: `Agent output contains API error signature (pattern: ${pattern.source})`,
        detail: implParsed.text.slice(0, 300),
        recovery: "This indicates the agent call itself failed. Task will retry.",
      });
    }
  }

  return null;
}
