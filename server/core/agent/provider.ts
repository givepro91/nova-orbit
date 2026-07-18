/**
 * 에이전트 실행 백엔드(provider) 해석 + 전역 설정 로드.
 *
 * 해석 순서(시작 백엔드): agent.provider → project.default_provider → 전역 기본(config.defaultProvider ?? "claude").
 * failover는 이 해석과 독립(직교) — config.codexFailover 전역 토글이 관장한다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentProvider } from "./adapters/backend.js";

const VALID: AgentProvider[] = ["claude", "codex"];

export type ProviderResolutionSource = "agent" | "project" | "global";

export interface ProviderResolution {
  provider: AgentProvider;
  source: ProviderResolutionSource;
}

function coerce(v: unknown, fallback: AgentProvider): AgentProvider {
  return VALID.includes(v as AgentProvider) ? (v as AgentProvider) : fallback;
}

function isValidProvider(v: unknown): v is AgentProvider {
  return VALID.includes(v as AgentProvider);
}

export function resolveProviderTrace(
  agent: { provider?: string | null },
  project: { default_provider?: string | null },
  config: { defaultProvider?: string },
): ProviderResolution {
  const globalDefault = coerce(config.defaultProvider, "claude");
  let resolution: ProviderResolution;
  if (agent?.provider) {
    resolution = isValidProvider(agent.provider)
      ? { provider: agent.provider, source: "agent" }
      : { provider: globalDefault, source: "global" };
  } else if (project?.default_provider) {
    resolution = isValidProvider(project.default_provider)
      ? { provider: project.default_provider, source: "project" }
      : { provider: globalDefault, source: "global" };
  } else {
    resolution = { provider: globalDefault, source: "global" };
  }

  // agent/project가 명시한 provider가 이번 프로세스에서 이미 사용 불가로 확인된
  // 경우, 시작 프리플라이트가 진단한 실제 fallback provider로 치환한다.
  // (자세한 내용: setRuntimeProviderSubstitution 참고)
  const substitute = runtimeProviderSubstitution(resolution.provider);
  return substitute ? { provider: substitute, source: resolution.source } : resolution;
}

export function resolveProvider(
  agent: { provider?: string | null },
  project: { default_provider?: string | null },
  config: { defaultProvider?: string },
): AgentProvider {
  return resolveProviderTrace(agent, project, config).provider;
}

export interface ProviderConfig {
  defaultProvider: AgentProvider;
  codexFailover: boolean;
  codexModelMap: Record<string, string>;
  budget?: {
    tokenLimit: number | null;
    timeLimitMs: number | null;
    warnPct: number;
  };
}

function parseBudget(value: unknown): ProviderConfig["budget"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  const budget = value as Record<string, unknown>;
  const validLimit = (limit: unknown): limit is number | null =>
    limit === null
    || (typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0);

  if (!validLimit(budget.tokenLimit)
    || !validLimit(budget.timeLimitMs)
    || typeof budget.warnPct !== "number"
    || !Number.isFinite(budget.warnPct)
    || budget.warnPct < 0
    || budget.warnPct > 1) {
    return undefined;
  }

  return {
    tokenLimit: budget.tokenLimit,
    timeLimitMs: budget.timeLimitMs,
    warnPct: budget.warnPct,
  };
}

// CLI와 server는 tsup에서 서로 다른 번들로 생성된다. 모듈 지역 변수는
// 번들마다 복제되므로, 두 번들이 같은 Node.js realm에서 공유하는 globalThis에
// preflight이 확인한 실제 실행 provider를 보관한다. 디스크 설정은 건드리지 않는다.
const RUNTIME_PROVIDER_KEY = "__crewdeckRuntimeDefaultProvider";

function runtimeDefaultProvider(): AgentProvider | null {
  const value = (globalThis as unknown as Record<string, unknown>)[RUNTIME_PROVIDER_KEY];
  return isValidProvider(value) ? value : null;
}

/** 시작 프리플라이트가 확인한 실제 fallback provider를 이 프로세스의 전역 기본값으로 적용한다. */
export function setRuntimeDefaultProvider(provider: AgentProvider | null): void {
  const runtime = globalThis as unknown as Record<string, unknown>;
  if (provider === null) delete runtime[RUNTIME_PROVIDER_KEY];
  else runtime[RUNTIME_PROVIDER_KEY] = provider;
}

// agent.provider/project.default_provider로 명시 선택된 provider는 위 전역 기본값
// 치환의 영향을 받지 않는다(해석 순서상 우선하므로). 그 provider의 CLI가 이번
// 프로세스에서 사용 불가로 확인되면, 진단이 보고한 실제 시작 경로와 세션 spawn이
// 어긋나지 않도록 "선택 provider → fallback provider" 치환을 별도로 기록한다.
const RUNTIME_SUBSTITUTIONS_KEY = "__crewdeckRuntimeProviderSubstitutions";

function runtimeProviderSubstitution(unavailable: AgentProvider): AgentProvider | null {
  const table = (globalThis as unknown as Record<string, unknown>)[RUNTIME_SUBSTITUTIONS_KEY] as
    | Partial<Record<AgentProvider, AgentProvider>>
    | undefined;
  const substitute = table?.[unavailable];
  return isValidProvider(substitute) ? substitute : null;
}

/**
 * 시작 프리플라이트가 agent/project에 명시 선택된 provider(`unavailable`)가 이 프로세스에서
 * 사용 불가하고 `substitute`로 fallback했음을 확인했을 때 호출한다. 이후 그 provider를
 * 참조하는 모든 resolveProviderTrace() 호출이 substitute를 반환한다.
 */
export function setRuntimeProviderSubstitution(
  unavailable: AgentProvider,
  substitute: AgentProvider | null,
): void {
  const runtime = globalThis as unknown as Record<string, unknown>;
  const table = {
    ...((runtime[RUNTIME_SUBSTITUTIONS_KEY] as Partial<Record<AgentProvider, AgentProvider>>) ?? {}),
  };
  if (substitute === null) delete table[unavailable];
  else table[unavailable] = substitute;
  runtime[RUNTIME_SUBSTITUTIONS_KEY] = table;
}

/** ~/.crewdeck/config.json에서 provider 관련 설정을 로드 (미설정 시 하위호환 기본값). */
export function loadProviderConfig(): ProviderConfig {
  let raw: Record<string, unknown> = {};
  try {
    const p = join(homedir(), ".crewdeck", "config.json");
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 기본값 사용
  }
  return {
    defaultProvider: runtimeDefaultProvider() ?? coerce(raw.defaultProvider, "claude"),
    codexFailover: raw.codexFailover !== false, // 기본 true
    codexModelMap: (raw.codexModelMap ?? {}) as Record<string, string>,
    budget: parseBudget(raw.budget),
  };
}
