import { describe, it, expect } from "vitest";
import { detectAgentRunFailure, CLI_ERROR_LEAK_PATTERNS } from "../utils/errors.js";

/**
 * Regression tests for the silent-failure gate introduced after the Pulsar
 * incident where tasks like "로컬 개발 편의 스크립트 작성" were marked done
 * with result_summary = "API Error: Unable to connect to API (ECONNRESET)".
 *
 * These inputs are real DB rows from the Pulsar project's tasks table.
 */
describe("detectAgentRunFailure — Pulsar regression cases", () => {
  it("catches ECONNRESET leaked into assistant text (exit=0)", () => {
    const implResult = { exitCode: 0, stderr: "" };
    const implParsed = {
      text: "API Error: Unable to connect to API (ECONNRESET)",
      errors: [],
    };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("API_ERROR_LEAK");
  });

  it("catches 401 authentication_error in assistant text", () => {
    const implResult = { exitCode: 0, stderr: "" };
    const implParsed = {
      text: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
      errors: [],
    };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("API_ERROR_LEAK");
  });

  it("catches non-zero exit code even with some text", () => {
    const implResult = { exitCode: 1, stderr: "connection refused" };
    const implParsed = { text: "partial output", errors: [] };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("CLI_EXIT_NONZERO");
  });

  it("catches stream parser errors (empty stdout)", () => {
    const implResult = { exitCode: 0, stderr: "" };
    const implParsed = {
      text: "",
      errors: ["Empty stdout from Claude Code CLI — no output received"],
    };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("STREAM_ERROR");
  });

  it("passes legitimate success output through", () => {
    const implResult = { exitCode: 0, stderr: "" };
    const implParsed = {
      text: "Task complete. Modified web/src/app/page.tsx with dashboard layout.",
      errors: [],
    };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).toBeNull();
  });

  it("does not false-positive on the word 'error' in normal context", () => {
    const implResult = { exitCode: 0, stderr: "" };
    const implParsed = {
      text: "Added error handling to the login flow. All edge cases covered.",
      errors: [],
    };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).toBeNull();
  });

  it("catches ECONNREFUSED", () => {
    const implResult = { exitCode: 0, stderr: "" };
    const implParsed = {
      text: "Error: connect ECONNREFUSED 127.0.0.1:8080",
      errors: [],
    };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).not.toBeNull();
  });

  it("catches 'Credit balance is too low'", () => {
    const implResult = { exitCode: 0, stderr: "" };
    const implParsed = {
      text: "Your credit balance is too low to access the Anthropic API",
      errors: [],
    };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("API_ERROR_LEAK");
  });

  // W1-11: 구 동작(signal 종료 = pending 취급)은 외부 SIGTERM/OOM으로 죽은 세션의
  // 부분 출력이 정상 결과로 위장돼 done 처리되는 구멍이었다 — 실패로 분류한다.
  it("exitCode === null + signal marker (외부 kill) → 실패 분류", () => {
    const implResult = { exitCode: null, stderr: "[crewdeck] process terminated by signal SIGTERM" };
    const implParsed = { text: "some partial output", errors: [] };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).not.toBeNull();
    expect(failure?.code).toBe("SIGNAL_TERMINATED");
    expect(failure?.message).toContain("SIGTERM");
  });

  it("의도적 중단(interrupted — steer/abort/failover kill)은 실패가 아니다", () => {
    const implResult = {
      exitCode: null,
      stderr: "[crewdeck] process terminated by signal SIGTERM",
      interrupted: true,
    };
    const implParsed = { text: "partial", errors: [] };
    expect(detectAgentRunFailure(implResult, implParsed)).toBeNull();
  });

  it("하드 타임아웃 kill('(killed)' 마커)은 TIMEOUT 경로가 처리 — 이중 분류하지 않는다", () => {
    const implResult = {
      exitCode: null,
      stderr: "[crewdeck] process terminated by signal SIGTERM (killed)",
    };
    const implParsed = { text: "partial", errors: [] };
    expect(detectAgentRunFailure(implResult, implParsed)).toBeNull();
  });

  it("exitCode === null 이지만 signal 마커가 없으면 기존 경로대로 통과", () => {
    const implResult = { exitCode: null, stderr: "" };
    const implParsed = { text: "정상 완료 요약", errors: [] };
    expect(detectAgentRunFailure(implResult, implParsed)).toBeNull();
  });
});

describe("CLI_ERROR_LEAK_PATTERNS — export for extensibility", () => {
  it("exports at least 8 patterns", () => {
    expect(CLI_ERROR_LEAK_PATTERNS.length).toBeGreaterThanOrEqual(8);
  });

  it("all entries are RegExp", () => {
    for (const p of CLI_ERROR_LEAK_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });

  it("Claude 구독 세션 한도·조직 접근 차단 문구를 매칭한다 (stdout leak → 토스트에 실제 사유)", () => {
    const hit = (text: string) => CLI_ERROR_LEAK_PATTERNS.some((p) => p.test(text));
    expect(hit("You've hit your session limit · resets 10:50pm (Asia/Seoul)")).toBe(true);
    expect(hit("Your organization has disabled Claude subscription access for Claude Code")).toBe(true);
    // 정상 결과 텍스트엔 오탐 없음
    expect(hit("작업을 완료했습니다. 세션 요약: 로그인 기능 구현")).toBe(false);
  });
});

// classifyAgentFailure — 책임 소재 분류 단일 정본.
// engine(태스크 상태)과 scheduler(큐 상태)가 같은 분류를 쓰는지가 계약의 핵심:
// 세션 소진이 task_error로 새면 사용량 한도만으로 재시도 예산이 증발한다 (07-08 실측).
import { classifyAgentFailure, AgentError } from "../utils/errors.js";
import { AgentHandoffConsumptionError } from "../core/agent/handoff-consumer.js";

describe("classifyAgentFailure", () => {
  it("rate limit 문자열 변형들 → rate_limit", () => {
    expect(classifyAgentFailure(new Error("API rate limit reached"))).toBe("rate_limit");
    expect(classifyAgentFailure(new Error("HTTP 429 Too Many Requests"))).toBe("rate_limit");
    expect(classifyAgentFailure(new Error("too many requests"))).toBe("rate_limit");
  });

  it("CLI exit non-zero + 빈 stderr → session_exhausted (사용량 한도 신호)", () => {
    const err = new AgentError({
      code: "CLI_EXIT_NONZERO",
      message: "Agent CLI exited with code 1",
      detail: "",
    });
    expect(classifyAgentFailure(err)).toBe("session_exhausted");
  });

  it("Codex 세션의 빈 stderr non-zero → task_error (claude 세션소진 휴리스틱 미적용)", () => {
    const err = new AgentError({
      code: "CLI_EXIT_NONZERO",
      message: "Agent CLI exited with code 1",
      detail: "",
    });
    expect(classifyAgentFailure(err, { provider: "codex" })).toBe("task_error");
    // claude(기본)에서는 여전히 session_exhausted
    expect(classifyAgentFailure(err, { provider: "claude" })).toBe("session_exhausted");
  });

  it("Codex rate-limit 메시지는 provider 무관하게 rate_limit", () => {
    const err = new AgentError({ code: "CLI_EXIT_NONZERO", message: "429 too many requests", detail: "429 too many requests" });
    expect(classifyAgentFailure(err, { provider: "codex" })).toBe("rate_limit");
  });

  it("Claude 구독 세션 한도/조직 접근 차단 문구 → session_exhausted (codex는 task_error)", () => {
    // CLI가 stdout으로 흘린 구독 에러를 engine이 API_ERROR_LEAK(detail=원문)로 감싼 경로.
    // exit code로만 뜨면 사유가 사라지므로 텍스트 시그니처로 잡아 codex failover 대상으로 승격.
    const sessionLimit = new AgentError({
      code: "API_ERROR_LEAK",
      message: "Agent output contains API error signature",
      detail: "You've hit your session limit · resets 10:50pm (Asia/Seoul)",
    });
    expect(classifyAgentFailure(sessionLimit)).toBe("session_exhausted");
    expect(classifyAgentFailure(sessionLimit, { provider: "claude" })).toBe("session_exhausted");
    // codex 세션엔 구독 세션 휴리스틱 미적용
    expect(classifyAgentFailure(sessionLimit, { provider: "codex" })).toBe("task_error");

    const orgDisabled = new AgentError({
      code: "API_ERROR_LEAK",
      message: "Agent output contains API error signature",
      detail: "Your organization has disabled Claude subscription access for Claude Code",
    });
    expect(classifyAgentFailure(orgDisabled)).toBe("session_exhausted");
  });

  it("codex usage limit(stdout turn.failed)은 detail로 보존되고 rate_limit로 분류된다", () => {
    // codex는 사용 한도를 stderr가 아니라 stdout JSON(turn.failed)으로 흘리고 exit 1 한다.
    // detectAgentRunFailure가 parsed.errors를 detail로 끌어와야 사유 노출·분류가 산다.
    const failure = detectAgentRunFailure(
      { exitCode: 1, stderr: "" },
      { text: "", errors: ["Codex turn failed: You've hit your usage limit. ... try again at 1:05 AM."] },
    );
    expect(failure?.code).toBe("CLI_EXIT_NONZERO");
    expect(failure?.detail).toContain("usage limit");
    // usage limit은 provider 무관하게 rate_limit → rate-limit pause(3초 재시도 폭풍 방지)
    expect(classifyAgentFailure(failure!, { provider: "codex" })).toBe("rate_limit");
    expect(classifyAgentFailure(failure!, { provider: "claude" })).toBe("rate_limit");
  });

  it("rate limit 신호가 detail(stderr)에만 있어도 rate_limit — CLI_EXIT_NONZERO로 감싸진 429 회귀", () => {
    // adapter가 429를 non-zero 종료 + stderr로 올리고 engine이 CLI_EXIT_NONZERO
    // (message는 종료코드만, detail은 stderr)로 감싸는 실제 경로. message만 보면
    // task_error로 새어 scheduler의 rate_limit failover/관측성 분기를 못 탄다.
    const err = new AgentError({
      code: "CLI_EXIT_NONZERO",
      message: "Agent CLI exited with code 1",
      detail: "HTTP 429 Too Many Requests: rate limit exceeded",
    });
    expect(classifyAgentFailure(err)).toBe("rate_limit");
    expect(classifyAgentFailure(err, { provider: "codex" })).toBe("rate_limit");
    expect(classifyAgentFailure(err, { provider: "claude" })).toBe("rate_limit");
  });

  it("CLI exit non-zero인데 stderr에 내용이 있으면 → task_error", () => {
    const err = new AgentError({
      code: "CLI_EXIT_NONZERO",
      message: "Agent CLI exited with code 1",
      detail: "TypeError: cannot read properties of undefined",
    });
    expect(classifyAgentFailure(err)).toBe("task_error");
  });

  it("ENOENT/EACCES/not found/not installed — message든 detail이든 → env_error", () => {
    expect(classifyAgentFailure(new Error("spawn claude ENOENT"))).toBe("env_error");
    expect(classifyAgentFailure(new Error("claude: command not found"))).toBe("env_error");
    expect(classifyAgentFailure({ message: "EACCES: permission denied" })).toBe("env_error");
    expect(
      classifyAgentFailure(
        new AgentError({
          code: "CLI_EXIT_NONZERO",
          message: "Agent CLI exited with code 127",
          detail: "sh: claude: not found",
        }),
      ),
    ).toBe("env_error");
  });

  it("SPAWN_FAILED 코드는 detail 내용과 무관하게 → env_error", () => {
    const err = new AgentError({
      code: "SPAWN_FAILED",
      message: "Failed to spawn Claude Code CLI process.",
    });
    expect(classifyAgentFailure(err)).toBe("env_error");
  });

  it("타임아웃은 태스크 책임 → task_error (재시도/분할 대상)", () => {
    expect(classifyAgentFailure(new Error("Task execution timed out after 600s."))).toBe("task_error");
  });

  it("일반 오류/코드 없는 Error → task_error", () => {
    expect(classifyAgentFailure(new Error("something broke"))).toBe("task_error");
    expect(classifyAgentFailure({})).toBe("task_error");
  });

  it("handoff 계약 위반(HANDOFF_CONTRACT_VIOLATION)은 'not found' 메시지여도 → task_error (env_error 오분류·왕복 failover 방지)", () => {
    // 실측 회귀(2026-07-13 nova): "Required preceding handoff (decompose) was not found."가
    // envSignature('not found')에 걸려 env_error로 분류 → Claude↔Codex 왕복 + 무한 재시도.
    const handoffErr = new AgentHandoffConsumptionError("implementation", [{
      field: "$",
      code: "missing_field",
      message: "Required preceding handoff (decompose) was not found.",
    }]);
    expect(handoffErr.message).toContain("not found");
    expect(classifyAgentFailure(handoffErr)).toBe("task_error");
    expect(classifyAgentFailure(handoffErr, { provider: "codex" })).toBe("task_error");
  });
});
