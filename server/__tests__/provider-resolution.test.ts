import { describe, it, expect } from "vitest";
import { resolveProvider } from "../core/agent/provider.js";

describe("resolveProvider", () => {
  const cfg = { defaultProvider: "claude" as const, codexFailover: true, codexModelMap: {} };

  it("agent.provider가 최우선", () => {
    expect(resolveProvider({ provider: "codex" }, { default_provider: "claude" }, cfg)).toBe("codex");
  });
  it("agent null이면 project 기본", () => {
    expect(resolveProvider({ provider: null }, { default_provider: "codex" }, cfg)).toBe("codex");
  });
  it("둘 다 null이면 전역 기본", () => {
    expect(resolveProvider({ provider: null }, { default_provider: null }, cfg)).toBe("claude");
  });
  it("잘못된 값은 전역 기본으로 폴백", () => {
    expect(resolveProvider({ provider: "gpt" as any }, { default_provider: null }, cfg)).toBe("claude");
  });
  it("전역 기본이 codex면 상속 시 codex", () => {
    expect(resolveProvider({ provider: null }, { default_provider: null }, { ...cfg, defaultProvider: "codex" })).toBe("codex");
  });
});
