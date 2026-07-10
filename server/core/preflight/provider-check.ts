import { spawnSync } from "node:child_process";
import type { AgentProvider } from "../agent/adapters/backend.js";
import {
  loadProviderConfig,
  resolveProviderTrace,
  type ProviderConfig,
} from "../agent/provider.js";
import type { PreflightCheck, PreflightCheckResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

type ProviderFailureKind =
  | "not-installed"
  | "not-authenticated"
  | "timeout"
  | "execution-error";

interface ProviderProbeResult {
  provider: AgentProvider;
  available: boolean;
  failureKind?: ProviderFailureKind;
  detail: string;
}

interface CommandResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: Error & { code?: string | number };
}

interface CommandOptions {
  timeout: number;
  env: NodeJS.ProcessEnv;
}

export type ProviderCommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => CommandResult;

export interface EffectiveProviderDecision {
  /** 이 진단 이후 세션 spawn이 실제로 사용해야 하는 provider. */
  provider: AgentProvider;
  /** 선택된 provider가 사용 불가해 fallback으로 대체되었는지 여부. */
  usedFallback: boolean;
}

/**
 * 복구 재실행 명령이 현재 호출의 실행 컨텍스트를 잃지 않도록 함께 싣는다.
 * 이게 없으면 `npx crewdeck` 재실행이 사용자가 지정한 --data-dir·--port·--no-open을
 * 모두 버리고 기본 데이터 디렉토리·기본 포트로 별도 서버를 시작할 수 있다.
 */
export interface RestartContext {
  dataDir?: string;
  port?: number;
  noOpen?: boolean;
}

interface ProviderCliCheckOptions {
  agent?: { provider?: string | null };
  project?: { default_provider?: string | null };
  config?: ProviderConfig;
  timeoutMs?: number;
  runCommand?: ProviderCommandRunner;
  /** run() 이 이미 수행한 probe 결과로 실제 실행 provider를 알려준다 (재probe 없이). */
  onResolved?: (decision: EffectiveProviderDecision) => void;
  /** 복구 재실행 명령이 보존해야 하는 현재 호출 컨텍스트 (--data-dir·--port·--no-open). */
  restart?: RestartContext;
}

interface ProviderCommand {
  args: readonly string[];
  install: string;
  login: string;
}

const PROVIDER_COMMANDS: Record<AgentProvider, ProviderCommand> = {
  claude: {
    args: ["auth", "status", "--json"],
    install: "npm install -g @anthropic-ai/claude-code",
    login: "claude login",
  },
  codex: {
    args: ["login", "status"],
    install: "npm install -g @openai/codex",
    login: "codex login",
  },
};

const runCommand: ProviderCommandRunner = (command, args, options) => {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    timeout: options.timeout,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
};

function otherProvider(provider: AgentProvider): AgentProvider {
  return provider === "claude" ? "codex" : "claude";
}

function errorCode(error: CommandResult["error"]): string | undefined {
  return error?.code === undefined ? undefined : String(error.code);
}

function timeout(timeoutMs: number | undefined): number {
  return Number.isInteger(timeoutMs) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
}

function claudeAuthenticated(stdout: string | undefined): boolean {
  try {
    const status = JSON.parse(stdout || "") as { loggedIn?: unknown };
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

function probeProvider(
  provider: AgentProvider,
  timeoutMs: number,
  runner: ProviderCommandRunner,
): ProviderProbeResult {
  const command = PROVIDER_COMMANDS[provider];
  let result: CommandResult;

  try {
    result = runner(provider, command.args, {
      timeout: timeoutMs,
      env: {
        ...process.env,
        BROWSER: "none",
        CI: "1",
        NO_COLOR: "1",
      },
    });
  } catch (error) {
    return {
      provider,
      available: false,
      failureKind: "execution-error",
      detail: `${provider} 인증 상태 확인 명령을 실행할 수 없습니다.`,
    };
  }

  const code = errorCode(result.error);
  if (code === "ENOENT") {
    return {
      provider,
      available: false,
      failureKind: "not-installed",
      detail: `${provider} CLI를 PATH에서 찾을 수 없습니다.`,
    };
  }
  if (code === "ETIMEDOUT") {
    return {
      provider,
      available: false,
      failureKind: "timeout",
      detail: `${provider} 인증 상태 확인이 ${timeoutMs}ms 내에 완료되지 않았습니다.`,
    };
  }
  if (result.error) {
    return {
      provider,
      available: false,
      failureKind: "execution-error",
      detail: `${provider} 인증 상태 확인 명령을 실행할 수 없습니다.`,
    };
  }
  if (result.status !== 0) {
    return {
      provider,
      available: false,
      failureKind: "not-authenticated",
      // auth status 출력은 계정·조직 정보를 포함할 수 있어 사용자에게 그대로 노출하지 않는다.
      detail: `${provider} 인증 상태 확인이 종료 코드 ${String(result.status)}로 실패했습니다.`,
    };
  }
  if (provider === "claude" && !claudeAuthenticated(result.stdout)) {
    return {
      provider,
      available: false,
      failureKind: "not-authenticated",
      detail: "claude auth status가 로그인 상태를 확인하지 못했습니다.",
    };
  }

  return {
    provider,
    available: true,
    detail: `${provider} CLI 설치·인증 확인 완료`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * 인증을 고친 뒤 실행할 재실행 명령을 만든다 — 현재 호출의 --data-dir·--port·--no-open을
 * 그대로 보존해, 복사·실행 시 사용자가 지정한 DB·포트를 그대로 복구하도록 한다.
 */
function restartCommand(restart: RestartContext | undefined): string {
  const parts = ["npx crewdeck"];
  if (restart?.dataDir) parts.push(`--data-dir=${shellQuote(restart.dataDir)}`);
  if (restart?.port !== undefined) parts.push(`--port=${restart.port}`);
  if (restart?.noOpen) parts.push("--no-open");
  return parts.join(" ");
}

function recoveryCommands(
  probe: ProviderProbeResult,
  restart: RestartContext | undefined,
): string[] {
  const command = PROVIDER_COMMANDS[probe.provider];
  const commands = probe.failureKind === "not-installed" ? [command.install] : [];
  commands.push(command.login, restartCommand(restart));
  return commands;
}

function providerResult(
  selected: ProviderProbeResult,
  fallback: ProviderProbeResult,
  resolutionSource: string,
  failoverEnabled: boolean,
  restart: RestartContext | undefined,
): PreflightCheckResult {
  const resolution = `${resolutionSource} 설정에서 ${selected.provider}를 선택했습니다.`;

  if (selected.available) {
    if (failoverEnabled && !fallback.available) {
      return {
        status: "warning",
        summary: `${selected.provider}로 시작하지만 ${fallback.provider} fallback은 사용할 수 없습니다.`,
        detail: `${resolution} 실제 시작 provider: ${selected.provider}. ${fallback.detail}`,
        recoveryCommands: recoveryCommands(fallback, restart),
      };
    }
    return {
      status: "pass",
      summary: `${selected.provider} provider 사용 가능`,
      detail: `${resolution} 실제 시작 provider: ${selected.provider}.`,
      recoveryCommands: [],
    };
  }

  if (failoverEnabled && fallback.available) {
    return {
      status: "warning",
      summary: `${selected.provider}를 사용할 수 없어 ${fallback.provider} fallback 경로로 시작합니다.`,
      detail:
        `${resolution} ${selected.detail} ` +
        `실제 실행 경로: ${selected.provider}(진단 실패) → ${fallback.provider}(fallback 인증 확인).`,
      recoveryCommands: recoveryCommands(selected, restart),
    };
  }

  const fallbackDetail = failoverEnabled
    ? ` ${fallback.provider} fallback도 사용할 수 없습니다: ${fallback.detail}`
    : ` ${fallback.provider} fallback은 codexFailover=false로 꺼져 있습니다.`;
  return {
    status: "fail",
    summary: "실행 가능한 provider가 없습니다.",
    detail: `${resolution} ${selected.detail}${fallbackDetail}`,
    recoveryCommands: recoveryCommands(selected, restart),
  };
}

/** 현재 provider 해석과 failover 정책에 따라 두 CLI의 설치·인증 상태를 진단한다. */
export function providerCliCheck(
  options: ProviderCliCheckOptions = {},
): PreflightCheck {
  return {
    id: "provider-cli",
    required: true,
    run: (): PreflightCheckResult => {
      const config = options.config ?? loadProviderConfig();
      const resolution = resolveProviderTrace(
        options.agent ?? {},
        options.project ?? {},
        config,
      );
      const selectedProvider = resolution.provider;
      const fallbackProvider = otherProvider(selectedProvider);
      const probeTimeout = timeout(options.timeoutMs);
      const runner = options.runCommand ?? runCommand;
      const selected = probeProvider(selectedProvider, probeTimeout, runner);
      const fallback = probeProvider(fallbackProvider, probeTimeout, runner);

      const usedFallback = !selected.available && config.codexFailover && fallback.available;
      options.onResolved?.({
        provider: usedFallback ? fallback.provider : selected.provider,
        usedFallback,
      });

      return providerResult(
        selected,
        fallback,
        resolution.source,
        config.codexFailover,
        options.restart,
      );
    },
  };
}
