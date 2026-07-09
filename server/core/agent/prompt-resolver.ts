import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { getPreset } from "./roles.js";

const log = createLogger("prompt-resolver");

export interface PromptResolution {
  prompt: string;
  source: "custom" | "project" | "preset" | "fallback";
  filePath?: string;
}

// role → 후보 파일명 (우선순위순)
const ROLE_FILE_CANDIDATES: Record<string, string[]> = {
  backend:  ["backend.md", "server.md"],
  frontend: ["frontend.md", "client.md"],
  ux:       ["ux.md", "designer.md", "design.md"],
  qa:       ["qa.md", "tester.md"],
  reviewer: ["reviewer.md", "review.md"],
  cto:      ["cto.md", "lead.md", "architect.md"],
  devops:   ["devops.md", "infra.md", "ops.md"],
  marketer: ["marketer.md", "marketing.md"],
  // coder, designer 등 기타 role은 아래 fallback 로직에서 처리
};

// 최종 하드코딩 fallback
const FALLBACK_PROMPTS: Record<string, string> = {
  coder:    `You are a senior software engineer. Implement the assigned task by writing clean, production-ready code. Before writing, analyze the existing codebase. Run lint/type-check before committing. You implement only — verification is handled separately.`,
  reviewer: `You are a code reviewer with an adversarial mindset. "Don't pass it — find the problem." Apply 5-dimension verification: Functionality, Data Flow, Design Alignment, Craft, Edge Cases. Classify issues as auto-resolve / soft-block / hard-block.`,
  marketer: `You are a growth marketer. Write SEO-optimized content. Always consider target audience and core messaging.`,
  designer: `You are a UI/UX designer. Create clean, accessible, and intuitive designs. Follow existing design system conventions.`,
  qa:       `You are a QA engineer. Analyze failure paths before success paths. Always test boundary values (0, -1, empty, null, max). Risk-based priority, not 100% coverage.`,
  backend:  `You are a senior backend engineer. Design and implement robust, scalable server-side logic. Follow existing code conventions and architecture patterns.`,
  frontend: `You are a senior frontend engineer. Build clean, accessible, and performant UI components. Follow the existing design system and framework conventions.`,
  ux:       `You are a UX designer. Create intuitive user flows and interfaces. Prioritize usability and accessibility.`,
  cto:      `You are a CTO and technical lead. Provide architectural guidance, review designs, and ensure technical excellence across the team.`,
  devops:   `You are a DevOps engineer. Manage infrastructure, CI/CD pipelines, and deployment processes. Prioritize reliability and automation.`,
  custom:   `You are an AI assistant. Complete the assigned task thoroughly and accurately.`,
};

/**
 * 프로젝트의 .claude/agents/ 디렉토리에서 role에 맞는 파일을 탐색한다.
 * 빈 파일(whitespace only)은 무시. 파일 읽기 에러는 warn 후 null 반환.
 */
function findProjectAgentFile(
  projectWorkdir: string,
  role: string,
  agentName: string,
): { content: string; filePath: string } | null {
  const agentsDir = join(projectWorkdir, ".claude", "agents");

  if (!existsSync(agentsDir)) {
    return null;
  }

  // role에 해당하는 후보 파일명 목록
  const candidates = ROLE_FILE_CANDIDATES[role] ?? [];

  // custom role인 경우 agent.name 소문자를 추가 후보로
  if ((role === "custom" || candidates.length === 0) && agentName.trim().length > 0) {
    const nameBased = `${agentName.toLowerCase().replace(/[^a-z0-9가-힣-]/g, "-").replace(/-+/g, "-")}.md`;
    if (!candidates.includes(nameBased)) {
      candidates.push(nameBased);
    }
  }

  const resolvedAgentsDir = resolvePath(agentsDir);

  for (const filename of candidates) {
    const filePath = join(agentsDir, filename);
    // 경로 Traversal 방어: agentsDir 외부 접근 차단
    if (!resolvePath(filePath).startsWith(resolvedAgentsDir)) {
      log.warn(`Path traversal blocked: ${filename} resolves outside agents dir`);
      continue;
    }
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, "utf-8");
      if (content.trim().length === 0) {
        log.warn(`Skipping empty project agent file: ${filePath}`);
        continue;
      }
      if (content.length > 100 * 1024) {
        log.warn(`Large project agent file (${content.length} bytes): ${filePath} — using anyway`);
      }
      return { content, filePath };
    } catch (err) {
      log.warn(`Failed to read project agent file ${filePath}: ${err}`);
    }
  }

  return null;
}

/**
 * 4단계 프롬프트 해결 체인.
 *
 * 1. agent.prompt_source === 'custom' && system_prompt.trim() 있음 → DB 값
 * 2. 프로젝트 .claude/agents/{role}.md 탐색 → 파일 내용
 * 3. Crewdeck 프리셋 getPreset(role).systemPrompt → 프리셋 값
 * 4. FALLBACK_PROMPTS 하드코딩 → 최종 fallback
 */
export function resolvePrompt(
  agent: { role: string; name: string; system_prompt: string; prompt_source: string },
  projectWorkdir: string,
): PromptResolution {
  // 1단계: 사용자가 대시보드에서 직접 편집한 커스텀 프롬프트
  if (agent.prompt_source === "custom" && agent.system_prompt.trim().length > 0) {
    return {
      prompt: agent.system_prompt,
      source: "custom",
    };
  }

  // 2단계: 프로젝트 .claude/agents/ 파일 (절대경로일 때만)
  const projectFile = projectWorkdir && projectWorkdir.startsWith("/")
    ? findProjectAgentFile(projectWorkdir, agent.role, agent.name)
    : null;
  if (projectFile) {
    return {
      prompt: projectFile.content,
      source: "project",
      filePath: projectFile.filePath,
    };
  }

  // 3단계: Crewdeck 프리셋
  const preset = getPreset(agent.role);
  if (preset?.systemPrompt) {
    return {
      prompt: preset.systemPrompt,
      source: "preset",
    };
  }

  // 4단계: 하드코딩 fallback
  const fallback = FALLBACK_PROMPTS[agent.role] ?? FALLBACK_PROMPTS.custom;
  return {
    prompt: fallback,
    source: "fallback",
  };
}
