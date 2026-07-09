import { describe, it, expect } from "vitest";
import { decideFailover } from "../core/agent/failover.js";

const base = {
  triedProviders: ["claude"] as ("claude" | "codex")[],
  codexAvailable: true,
  claudeAvailable: true,
  failoverEnabled: true,
};

describe("decideFailover", () => {
  it("claude rate_limit → codex failover", () => {
    expect(decideFailover({ ...base, failure: "rate_limit", currentProvider: "claude" }))
      .toEqual({ action: "failover", toProvider: "codex" });
  });
  it("session_exhausted·env_error도 failover", () => {
    for (const f of ["session_exhausted", "env_error"] as const)
      expect(decideFailover({ ...base, failure: f, currentProvider: "claude" }).action).toBe("failover");
  });
  it("task_error는 cooldown(코드 버그는 failover 안 함)", () => {
    expect(decideFailover({ ...base, failure: "task_error", currentProvider: "claude" }))
      .toEqual({ action: "cooldown" });
  });
  it("이미 codex 시도했으면 루프 가드 → cooldown", () => {
    expect(decideFailover({ ...base, triedProviders: ["claude", "codex"], failure: "rate_limit", currentProvider: "codex" }))
      .toEqual({ action: "cooldown" });
  });
  it("codex 미가용이면 cooldown", () => {
    expect(decideFailover({ ...base, codexAvailable: false, failure: "rate_limit", currentProvider: "claude" }))
      .toEqual({ action: "cooldown" });
  });
  it("failover 꺼져 있으면 cooldown", () => {
    expect(decideFailover({ ...base, failoverEnabled: false, failure: "rate_limit", currentProvider: "claude" }))
      .toEqual({ action: "cooldown" });
  });
  it("codex가 소진돼도 claude 미시도면 claude로 failover", () => {
    expect(decideFailover({ ...base, triedProviders: ["codex"], failure: "rate_limit", currentProvider: "codex" }))
      .toEqual({ action: "failover", toProvider: "claude" });
  });
});
