import { afterEach, describe, expect, it, vi } from "vitest";
import {
  providerCliCheck,
  type ProviderCommandRunner,
} from "./provider-check.js";
import {
  resolveProviderTrace,
  setRuntimeProviderSubstitution,
} from "../agent/provider.js";

afterEach(() => {
  setRuntimeProviderSubstitution("claude", null);
  setRuntimeProviderSubstitution("codex", null);
});

const baseConfig = {
  defaultProvider: "claude" as const,
  codexFailover: true,
  codexModelMap: {},
};

function commandRunner(
  results: Partial<Record<"claude" | "codex", ReturnType<ProviderCommandRunner>>>,
): ProviderCommandRunner {
  return vi.fn((command) => results[command as "claude" | "codex"] ?? {
    status: 0,
    stdout: command === "claude" ? '{"loggedIn":true}' : "Logged in",
  });
}

describe("providerCliCheck", () => {
  it("uses agent → project → global resolution and probes with non-interactive auth commands", async () => {
    const runner = commandRunner({});
    const check = providerCliCheck({
      agent: { provider: "codex" },
      project: { default_provider: "claude" },
      config: baseConfig,
      timeoutMs: 1_234,
      runCommand: runner,
    });

    expect(await check.run()).toMatchObject({
      status: "pass",
      summary: expect.stringContaining("codex"),
      detail: expect.stringContaining("agent 설정"),
    });
    expect(runner).toHaveBeenNthCalledWith(
      1,
      "codex",
      ["login", "status"],
      expect.objectContaining({
        timeout: 1_234,
        env: expect.objectContaining({ BROWSER: "none", CI: "1" }),
      }),
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "claude",
      ["auth", "status", "--json"],
      expect.any(Object),
    );
  });

  it("warns and shows the actual fallback path when the selected provider is missing", async () => {
    const runner = commandRunner({
      claude: {
        status: null,
        error: Object.assign(new Error("spawnSync claude ENOENT"), {
          code: "ENOENT",
        }),
      },
    });

    const result = await providerCliCheck({
      config: baseConfig,
      runCommand: runner,
    }).run();

    expect(result).toMatchObject({
      status: "warning",
      summary: expect.stringContaining("codex fallback"),
      detail: expect.stringContaining("claude(진단 실패) → codex"),
      recoveryCommands: [
        "npm install -g @anthropic-ai/claude-code",
        "claude login",
        "npx crewdeck",
      ],
    });
  });

  it("fails with install, login, and rerun commands when no allowed provider is executable", async () => {
    const runner = commandRunner({
      claude: {
        status: null,
        error: Object.assign(new Error("not found"), { code: "ENOENT" }),
      },
      codex: { status: 1, stderr: "Not logged in" },
    });

    const result = await providerCliCheck({
      config: baseConfig,
      runCommand: runner,
    }).run();

    expect(result).toEqual(expect.objectContaining({
      status: "fail",
      summary: "실행 가능한 provider가 없습니다.",
      recoveryCommands: [
        "npm install -g @anthropic-ai/claude-code",
        "claude login",
        "npx crewdeck",
      ],
    }));
    expect(result.detail).toContain("codex fallback도 사용할 수 없습니다");
  });

  it("does not use a healthy fallback when codexFailover is disabled", async () => {
    const runner = commandRunner({
      codex: { status: 1, stderr: "Not logged in" },
    });

    const result = await providerCliCheck({
      agent: { provider: "codex" },
      config: { ...baseConfig, codexFailover: false },
      runCommand: runner,
    }).run();

    expect(result).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("codexFailover=false"),
      recoveryCommands: ["codex login", "npx crewdeck"],
    });
  });

  it("preserves the invocation's --data-dir, --port, and --no-open in the restart command", async () => {
    // 복구 재실행 명령이 현재 호출 컨텍스트를 잃으면 사용자가 지정한 DB·포트를 버리고
    // 기본 위치로 별도 서버를 시작할 수 있다 — data-dir(공백 포함)은 안전하게 quote한다.
    const result = await providerCliCheck({
      config: { ...baseConfig, codexFailover: false },
      runCommand: commandRunner({ claude: { status: 1, stderr: "Not logged in" } }),
      restart: { dataDir: "/tmp/crewdeck test/data", port: 29113, noOpen: true },
    }).run();

    expect(result.recoveryCommands).toEqual([
      "claude login",
      "npx crewdeck --data-dir='/tmp/crewdeck test/data' --port=29113 --no-open",
    ]);
  });

  it("omits --no-open from the restart command when the invocation did not request it", async () => {
    const result = await providerCliCheck({
      config: { ...baseConfig, codexFailover: false },
      runCommand: commandRunner({ claude: { status: 1, stderr: "Not logged in" } }),
      restart: { dataDir: "/home/me/.crewdeck", port: 7200 },
    }).run();

    expect(result.recoveryCommands).toEqual([
      "claude login",
      "npx crewdeck --data-dir='/home/me/.crewdeck' --port=7200",
    ]);
  });

  it("classifies an authentication timeout and always keeps a finite timeout", async () => {
    const runner = commandRunner({
      claude: {
        status: null,
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      },
      codex: { status: 1, stderr: "Not logged in" },
    });

    const result = await providerCliCheck({
      config: baseConfig,
      timeoutMs: 0,
      runCommand: runner,
    }).run();

    expect(result).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("10000ms"),
    });
    expect(runner).toHaveBeenCalledWith(
      "claude",
      ["auth", "status", "--json"],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("rejects a successful claude command when loggedIn is false or malformed", async () => {
    for (const stdout of ['{"loggedIn":false}', "not-json"]) {
      const result = await providerCliCheck({
        config: { ...baseConfig, codexFailover: false },
        runCommand: commandRunner({ claude: { status: 0, stdout } }),
      }).run();

      expect(result).toMatchObject({
        status: "fail",
        recoveryCommands: ["claude login", "npx crewdeck"],
      });
    }
  });

  it("warns without blocking when only the enabled fallback is unavailable", async () => {
    const result = await providerCliCheck({
      config: baseConfig,
      runCommand: commandRunner({
        codex: {
          status: null,
          error: Object.assign(new Error("not found"), { code: "ENOENT" }),
        },
      }),
    }).run();

    expect(result).toMatchObject({
      status: "warning",
      summary: expect.stringContaining("fallback은 사용할 수 없습니다"),
      detail: expect.stringContaining("실제 시작 provider: claude"),
    });
  });

  it("reports the actual fallback decision via onResolved so callers can keep session spawn in sync", async () => {
    // agent.provider=codex, codex ENOENT, claude 인증 성공 — 진단 메시지가 "claude
    // fallback 경로로 시작합니다"라고 보고하는 정확히 그 케이스. onResolved가 없으면
    // 이 결정은 diagnostics에만 남고 실제 세션 spawn(resolveProviderTrace)에는 전달되지
    // 않는다.
    const onResolved = vi.fn();
    const runner = commandRunner({
      codex: {
        status: null,
        error: Object.assign(new Error("spawnSync codex ENOENT"), { code: "ENOENT" }),
      },
    });

    await providerCliCheck({
      agent: { provider: "codex" },
      config: baseConfig,
      runCommand: runner,
      onResolved,
    }).run();

    expect(onResolved).toHaveBeenCalledWith({ provider: "claude", usedFallback: true });
  });

  it("reports usedFallback: false via onResolved when the selected provider is healthy", async () => {
    const onResolved = vi.fn();

    await providerCliCheck({
      agent: { provider: "codex" },
      config: baseConfig,
      runCommand: commandRunner({}),
      onResolved,
    }).run();

    expect(onResolved).toHaveBeenCalledWith({ provider: "codex", usedFallback: false });
  });

  it("keeps a project/agent override's real session spawn in sync with the reported fallback path (server/index.ts wiring)", async () => {
    // server/index.ts의 project/agent override 진단 루프를 재현: agent.provider=codex,
    // Codex=ENOENT, Claude=인증 성공. 진단은 "claude fallback 경로로 시작합니다"라고
    // 보고하는데, session.ts:146의 실제 spawn 경로가 쓰는 resolveProviderTrace()도
    // 같은 provider를 반환해야 한다.
    const runner = commandRunner({
      codex: {
        status: null,
        error: Object.assign(new Error("spawnSync codex ENOENT"), { code: "ENOENT" }),
      },
    });

    const result = await providerCliCheck({
      agent: { provider: "codex" },
      config: baseConfig,
      runCommand: runner,
      onResolved: (decision) => {
        if (decision.usedFallback) setRuntimeProviderSubstitution("codex", decision.provider);
      },
    }).run();

    expect(result.status).toBe("warning");
    expect(result.summary).toContain("claude fallback");

    // session.ts가 실제 spawn에 쓰는 것과 동일한 호출
    expect(
      resolveProviderTrace({ provider: "codex" }, {}, baseConfig),
    ).toEqual({ provider: "claude", source: "agent" });
  });

  it("does not expose raw auth output or thrown error details", async () => {
    const secrets = "account=user@example.com access_token=secret-test-token";
    const unauthenticated = await providerCliCheck({
      config: { ...baseConfig, codexFailover: false },
      runCommand: commandRunner({
        claude: { status: 1, stdout: secrets, stderr: secrets },
      }),
    }).run();
    const thrown = await providerCliCheck({
      config: { ...baseConfig, codexFailover: false },
      runCommand: () => {
        throw new Error(secrets);
      },
    }).run();

    expect(unauthenticated.detail).not.toContain(secrets);
    expect(thrown.detail).not.toContain(secrets);
  });
});
