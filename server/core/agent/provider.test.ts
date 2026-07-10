import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveProvider,
  resolveProviderTrace,
  setRuntimeDefaultProvider,
  setRuntimeProviderSubstitution,
} from "./provider.js";

const cfg = { defaultProvider: "claude" as const };

afterEach(() => {
  setRuntimeDefaultProvider(null);
  setRuntimeProviderSubstitution("claude", null);
  setRuntimeProviderSubstitution("codex", null);
});

describe("resolveProviderTrace", () => {
  it("records agent as the source when agent.provider is valid", () => {
    expect(
      resolveProviderTrace(
        { provider: "codex" },
        { default_provider: "claude" },
        cfg,
      ),
    ).toEqual({ provider: "codex", source: "agent" });
  });

  it("records project as the source when agent.provider is absent", () => {
    expect(
      resolveProviderTrace(
        { provider: null },
        { default_provider: "codex" },
        cfg,
      ),
    ).toEqual({ provider: "codex", source: "project" });
  });

  it("records global as the source when neither agent nor project has a provider", () => {
    expect(
      resolveProviderTrace(
        { provider: null },
        { default_provider: null },
        cfg,
      ),
    ).toEqual({ provider: "claude", source: "global" });
  });

  it("falls back to the global default when a configured provider is invalid", () => {
    expect(
      resolveProviderTrace(
        { provider: "openai" },
        { default_provider: "codex" },
        { defaultProvider: "codex" },
      ),
    ).toEqual({ provider: "codex", source: "global" });
  });

  it("substitutes an agent-selected provider once the preflight marks it unavailable", () => {
    // agent.provider=codex는 여전히 최우선 해석이지만, 이번 프로세스에서 codex CLI가
    // 사용 불가로 확인되면(providerCliCheck의 onResolved) 실제 spawn은 진단이 보고한
    // fallback provider를 써야 한다 — 그렇지 않으면 진단 메시지와 런타임이 어긋난다.
    setRuntimeProviderSubstitution("codex", "claude");

    expect(
      resolveProviderTrace(
        { provider: "codex" },
        { default_provider: null },
        cfg,
      ),
    ).toEqual({ provider: "claude", source: "agent" });
  });

  it("leaves other providers untouched by an unrelated substitution", () => {
    setRuntimeProviderSubstitution("codex", "claude");

    expect(
      resolveProviderTrace(
        { provider: "claude" },
        { default_provider: null },
        cfg,
      ),
    ).toEqual({ provider: "claude", source: "agent" });
  });

  it("clears a substitution when set to null", () => {
    setRuntimeProviderSubstitution("codex", "claude");
    setRuntimeProviderSubstitution("codex", null);

    expect(
      resolveProviderTrace(
        { provider: "codex" },
        { default_provider: null },
        cfg,
      ),
    ).toEqual({ provider: "codex", source: "agent" });
  });
});

describe("resolveProvider", () => {
  it("keeps the provider-only API aligned with the traced policy", () => {
    expect(
      resolveProvider(
        { provider: null },
        { default_provider: "codex" },
        cfg,
      ),
    ).toBe("codex");
  });

  it("shares the preflight runtime provider across separate module instances", async () => {
    setRuntimeDefaultProvider("codex");
    vi.resetModules();
    const serverBundleCopy = await import("./provider.js");

    expect(serverBundleCopy.loadProviderConfig().defaultProvider).toBe("codex");

    setRuntimeDefaultProvider("claude");
    expect(serverBundleCopy.loadProviderConfig().defaultProvider).toBe("claude");
  });
});
