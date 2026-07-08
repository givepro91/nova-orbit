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

  it("exitCode === null (process killed by signal) is treated as pending, not hard failure", () => {
    // Note: signal-killed processes already surface via other paths (timeout,
    // rate-limit). The gate should not double-fail on exitCode === null.
    const implResult = { exitCode: null, stderr: "[nova] process terminated by signal SIGTERM" };
    const implParsed = { text: "some partial output", errors: [] };
    const failure = detectAgentRunFailure(implResult, implParsed);
    expect(failure).toBeNull();
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
});

// classifyAgentFailure — 책임 소재 분류 단일 정본.
// engine(태스크 상태)과 scheduler(큐 상태)가 같은 분류를 쓰는지가 계약의 핵심:
// 세션 소진이 task_error로 새면 사용량 한도만으로 재시도 예산이 증발한다 (07-08 실측).
import { classifyAgentFailure, NovaAgentError } from "../utils/errors.js";

describe("classifyAgentFailure", () => {
  it("rate limit 문자열 변형들 → rate_limit", () => {
    expect(classifyAgentFailure(new Error("API rate limit reached"))).toBe("rate_limit");
    expect(classifyAgentFailure(new Error("HTTP 429 Too Many Requests"))).toBe("rate_limit");
    expect(classifyAgentFailure(new Error("too many requests"))).toBe("rate_limit");
  });

  it("CLI exit non-zero + 빈 stderr → session_exhausted (사용량 한도 신호)", () => {
    const err = new NovaAgentError({
      code: "CLI_EXIT_NONZERO",
      message: "Agent CLI exited with code 1",
      detail: "",
    });
    expect(classifyAgentFailure(err)).toBe("session_exhausted");
  });

  it("CLI exit non-zero인데 stderr에 내용이 있으면 → task_error", () => {
    const err = new NovaAgentError({
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
        new NovaAgentError({
          code: "CLI_EXIT_NONZERO",
          message: "Agent CLI exited with code 127",
          detail: "sh: claude: not found",
        }),
      ),
    ).toBe("env_error");
  });

  it("SPAWN_FAILED 코드는 detail 내용과 무관하게 → env_error", () => {
    const err = new NovaAgentError({
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
});
