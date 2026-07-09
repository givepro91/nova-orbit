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

function coerce(v: unknown, fallback: AgentProvider): AgentProvider {
  return VALID.includes(v as AgentProvider) ? (v as AgentProvider) : fallback;
}

export function resolveProvider(
  agent: { provider?: string | null },
  project: { default_provider?: string | null },
  config: { defaultProvider?: string },
): AgentProvider {
  const globalDefault = coerce(config.defaultProvider, "claude");
  if (agent?.provider) return coerce(agent.provider, globalDefault);
  if (project?.default_provider) return coerce(project.default_provider, globalDefault);
  return globalDefault;
}

export interface ProviderConfig {
  defaultProvider: AgentProvider;
  codexFailover: boolean;
  codexModelMap: Record<string, string>;
}

/** ~/.crewdeck/config.json에서 provider 관련 설정을 로드 (미설정 시 하위호환 기본값). */
export function loadProviderConfig(): ProviderConfig {
  let raw: any = {};
  try {
    const p = join(homedir(), ".crewdeck", "config.json");
    if (existsSync(p)) raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    // 기본값 사용
  }
  return {
    defaultProvider: coerce(raw.defaultProvider, "claude"),
    codexFailover: raw.codexFailover !== false, // 기본 true
    codexModelMap: (raw.codexModelMap ?? {}) as Record<string, string>,
  };
}
