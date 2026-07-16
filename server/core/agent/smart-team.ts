import type { SuggestedAgent } from "./suggest.js";

export interface SmartTeamExistingAgent {
  id: string;
  name: string;
  role: string;
  system_prompt?: string | null;
  model?: string | null;
  provider?: "claude" | "codex" | null;
}

export interface SmartTeamCandidate {
  key: string;
  matchedAgentId: string | null;
  name: string;
  role: string;
  reason: string;
  systemPrompt: string;
  source: SuggestedAgent["source"];
  model: string | null;
  provider: "claude" | "codex" | null;
  action: "add" | "keep" | "update" | "conflict";
  warnings: string[];
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function sameIdentity(candidate: SmartTeamCandidate, existing: SmartTeamExistingAgent): boolean {
  return normalized(candidate.name) === normalized(existing.name)
    && candidate.role === existing.role
    && candidate.provider === (existing.provider ?? null);
}

function sameConfiguration(candidate: SmartTeamCandidate, existing: SmartTeamExistingAgent): boolean {
  return sameIdentity(candidate, existing)
    && candidate.model === (existing.model ?? null)
    && candidate.systemPrompt.trim() === (existing.system_prompt ?? "").trim();
}

/**
 * 추천 결과를 기존 팀과 비교하는 순수 preview 계약이다.
 * 같은 role의 복수 에이전트는 병렬 팀에서 유효하므로 경고만 하고, 이름 충돌과
 * 완전 중복은 명시적으로 구분해 apply가 조용히 팀을 중복 생성하지 않게 한다.
 */
export function buildSmartTeamPreview(
  suggestions: SuggestedAgent[],
  existingAgents: SmartTeamExistingAgent[],
): { candidates: SmartTeamCandidate[]; preservedExisting: number; additions: number; updates: number; conflicts: number } {
  const candidates = suggestions.map((suggestion, index): SmartTeamCandidate => {
    const candidate: SmartTeamCandidate = {
      key: `recommendation:${index}:${normalized(suggestion.name).replace(/[^a-z0-9가-힣]+/g, "-")}`,
      matchedAgentId: null,
      name: suggestion.name.trim(),
      role: suggestion.role,
      reason: suggestion.reason,
      systemPrompt: suggestion.systemPrompt,
      source: suggestion.source,
      model: suggestion.model ?? null,
      provider: null,
      action: "add",
      warnings: [],
    };

    const sameName = existingAgents.find((agent) => normalized(agent.name) === normalized(candidate.name));
    if (sameName && sameIdentity(candidate, sameName)) {
      candidate.matchedAgentId = sameName.id;
      if (sameConfiguration(candidate, sameName)) {
        candidate.action = "keep";
        candidate.warnings.push("already_exists");
      } else {
        candidate.action = "update";
        candidate.warnings.push("configuration_diff");
      }
      return candidate;
    }

    if (sameName) {
      candidate.action = "conflict";
      candidate.matchedAgentId = sameName.id;
      candidate.warnings.push("name_conflict");
    }
    if (existingAgents.some((agent) => agent.role === candidate.role)) {
      candidate.warnings.push("role_already_staffed");
    }
    return candidate;
  });

  return {
    candidates,
    preservedExisting: existingAgents.length,
    additions: candidates.filter((candidate) => candidate.action === "add").length,
    updates: candidates.filter((candidate) => candidate.action === "update").length,
    conflicts: candidates.filter((candidate) => candidate.action === "conflict").length,
  };
}

export function normalizedAgentName(value: string): string {
  return normalized(value);
}
