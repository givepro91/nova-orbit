import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { getPreset } from "./roles.js";
import { analyzeProject } from "../project/analyzer.js";

const log = createLogger("agent-suggest");

export interface SuggestedAgent {
  name: string;
  role: string;
  systemPrompt: string;
  reason: string;
  source: "project-agents" | "tech-stack" | "preset" | "ai";
  /** 에이전트별 모델 배정 (opus|sonnet|haiku) — 없으면 ROLE_DEFAULT_MODEL로 해석 */
  model?: string;
}

/**
 * Smart team suggestion — 2-layer:
 *
 * 1. .claude/agents/*.md 가 있으면 → 그대로 사용. 파일 = 에이전트.
 *    role 추론은 best-effort. 매칭 안 되면 "custom" — 문제 없음.
 *    CLAUDE.md 내용은 각 에이전트 시스템 프롬프트 앞에 컨텍스트로 주입.
 *
 * 2. .claude/agents/ 없으면 → package.json 분석 + 프리셋 기반 기본 팀.
 *    이 경우만 하드코딩 허용 (기본값이니까).
 *
 * reviewer/qa가 하나도 없으면 마지막에 추가 (Quality Gate 필수).
 */
export function suggestFromProject(
  workdir: string,
  mission?: string,
): SuggestedAgent[] {
  // ─── Layer 1: .claude/agents/*.md → 파일이 곧 에이전트 ────────────────
  const projectAgents = loadProjectAgents(workdir);

  if (projectAgents.length > 0) {
    // CLAUDE.md를 읽어서 각 에이전트에 프로젝트 컨텍스트 주입
    const claudeMd = loadClaudeMd(workdir);
    const contextPrefix = claudeMd
      ? `[Project Context from CLAUDE.md]\n${claudeMd.slice(0, 2000)}\n\n---\n\n`
      : "";

    const agents: SuggestedAgent[] = projectAgents.map((pa) => ({
      name: pa.name,
      role: pa.role,
      systemPrompt: contextPrefix + pa.systemPrompt,
      reason: `.claude/agents/${pa.file}`,
      source: "project-agents" as const,
    }));

    // Quality Gate: reviewer 계열이 없으면 추가
    const hasReviewer = agents.some((a) =>
      a.role === "reviewer" || a.role === "qa" || a.name.toLowerCase().includes("review") || a.name.toLowerCase().includes("qa"),
    );
    if (!hasReviewer) {
      const preset = getPreset("reviewer");
      agents.push({
        name: preset?.name ?? "Code Reviewer",
        role: "reviewer",
        systemPrompt: contextPrefix + (preset?.systemPrompt ?? ""),
        reason: "Quality Gate 필수 (자동 추가)",
        source: "preset",
      });
    }

    log.info(`Loaded ${agents.length} agents from .claude/agents/`, {
      agents: agents.map((a) => `${a.name}(${a.role})`),
    });

    return agents;
  }

  // ─── Layer 2: 프로젝트에 에이전트 정의 없음 → 분석 기반 기본 팀 ──────
  return buildDefaultTeam(workdir, mission);
}

/**
 * .claude/agents/ 없을 때: package.json 분석 + 프리셋 기반 기본 팀 생성
 */
function buildDefaultTeam(workdir: string, mission?: string): SuggestedAgent[] {
  const agents: SuggestedAgent[] = [];
  const seen = new Set<string>();

  const add = (role: string, reason: string, customPrompt?: string) => {
    if (seen.has(role)) return;
    seen.add(role);
    const preset = getPreset(role);
    agents.push({
      name: preset?.name ?? role,
      role,
      systemPrompt: customPrompt ?? preset?.systemPrompt ?? "",
      reason,
      source: customPrompt ? "tech-stack" : "preset",
    });
  };

  try {
    const { techStack } = analyzeProject(workdir);

    const hasFrontend = techStack.frameworks.some((f) =>
      ["React", "Vue", "Svelte", "Next.js"].includes(f),
    );
    const hasBackend = techStack.frameworks.some((f) =>
      ["Express", "Fastify", "NestJS", "Django", "FastAPI", "Flask", "Spring Boot", "Gin", "Echo"].includes(f),
    );

    if (hasFrontend && hasBackend) {
      add("cto", `Full-stack (${techStack.languages.join(", ")})`);
    }
    if (hasBackend || (!hasFrontend && !hasBackend)) {
      add("backend", techStack.frameworks.filter((f) => !["React", "Vue", "Svelte", "Next.js", "TailwindCSS"].includes(f)).join(", ") || techStack.languages.join(", "));
    }
    if (hasFrontend) {
      add("frontend", techStack.frameworks.filter((f) => ["React", "Vue", "Svelte", "Next.js"].includes(f)).join(", "));
    }
    if (techStack.testFramework) {
      add("qa", `${techStack.testFramework} 감지`);
    }
  } catch {
    // Fallback: 분석 실패 시 최소 팀
    add("backend", "기본 구현 에이전트");
    add("frontend", "기본 구현 에이전트");
  }

  add("reviewer", "Quality Gate 필수");

  log.info(`Built default team (${agents.length} agents) for: "${workdir}"`);
  return agents;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

interface ProjectAgentDef {
  name: string;
  role: string;
  systemPrompt: string;
  file: string;
}

/** Read .claude/agents/*.md — parse frontmatter + body as-is */
function loadProjectAgents(workdir: string): ProjectAgentDef[] {
  const agentsDir = join(workdir, ".claude", "agents");
  if (!existsSync(agentsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const results: ProjectAgentDef[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(agentsDir, file), "utf-8");
      if (!content.trim()) continue;

      const parsed = parseFrontmatter(content);
      const name = parsed.meta.name ?? file.replace(/\.md$/, "");

      // role: explicit frontmatter > filename match > keyword inference > "custom"
      const role = parsed.meta.role && isValidRole(parsed.meta.role)
        ? parsed.meta.role
        : inferRole(name, file, parsed.meta.description ?? "");

      results.push({ name, role, systemPrompt: parsed.body.trim(), file });
    } catch {
      continue;
    }
  }

  return results;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: match[2] };
}

const KNOWN_ROLES = new Set([
  "cto", "pm", "backend", "frontend", "ux", "qa", "reviewer", "devops", "marketer", "coder", "designer", "custom",
]);
function isValidRole(role: string): boolean {
  return KNOWN_ROLES.has(role.toLowerCase());
}

/**
 * Role inference — 3-layer:
 *   1. Filename exact match (e.g., "backend.md" → backend)
 *   2. Name-based keyword match (strict, avoids false positives)
 *   3. "custom" fallback (safe default — better than wrong role)
 *
 * NOTE: description is NOT used for inference. "디자인 패턴 적용"→ux,
 * "API 검증"→backend 등 false positive가 너무 많음. 사용자가 원하는
 * role은 frontmatter `role:` 필드로 명시하는 게 정확.
 */
function inferRole(name: string, filename: string, _description: string): string {
  // Layer 1: filename → role (most reliable)
  const FILENAME_ROLE: Record<string, string> = {
    "backend.md": "backend", "server.md": "backend", "api.md": "backend", "api-dev.md": "backend",
    "frontend.md": "frontend", "client.md": "frontend", "frontend-dev.md": "frontend",
    "ux.md": "ux", "designer.md": "ux", "ux-designer.md": "ux",
    "qa.md": "qa", "tester.md": "qa", "qa-engineer.md": "reviewer",
    "reviewer.md": "reviewer", "review.md": "reviewer", "code-reviewer.md": "reviewer",
    "cto.md": "cto", "lead.md": "cto", "architect.md": "cto", "tech-lead.md": "cto",
    "devops.md": "devops", "infra.md": "devops", "ops.md": "devops", "devops-engineer.md": "devops",
    "marketer.md": "marketer", "marketing.md": "marketer",
    "pm.md": "pm", "product-manager.md": "pm",
    "security.md": "custom", "security-engineer.md": "custom",
    "senior-dev.md": "backend", "senior-developer.md": "backend",
  };
  const fileRole = FILENAME_ROLE[filename.toLowerCase()];
  if (fileRole) return fileRole;

  // Layer 2: name-based (strict word boundary, name only — NOT description)
  const nameLower = name.toLowerCase();
  const NAME_SIGNALS: Array<{ test: RegExp; role: string }> = [
    { test: /\bcto\b|^architect$|tech[\s-]?lead/, role: "cto" },
    { test: /\bbackend\b|\bapi[\s-]dev\b|\bserver[\s-]dev\b|^senior[\s-]dev/, role: "backend" },
    { test: /\bfrontend\b|\bclient[\s-]dev\b|\bweb[\s-]dev\b/, role: "frontend" },
    { test: /^ux\b|^ui[\s/]ux\b/, role: "ux" },
    { test: /\bqa\b|\breview(?:er)?\b|검증|품질/, role: "reviewer" },
    { test: /\bdevops\b|\binfra\b|\bops\b|\bsre\b/, role: "devops" },
    { test: /\bmarket|\bgrowth\b|\bseo\b/, role: "marketer" },
    { test: /\bpm\b|product[\s-]?manager/, role: "pm" },
  ];
  for (const { test, role } of NAME_SIGNALS) {
    if (test.test(nameLower)) return role;
  }

  return "custom";
}

function loadClaudeMd(workdir: string): string | null {
  for (const path of [join(workdir, "CLAUDE.md"), join(workdir, ".claude", "CLAUDE.md")]) {
    try {
      if (existsSync(path)) return readFileSync(path, "utf-8");
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Legacy: keyword-only suggestion (used when workdir unavailable).
 */
export function suggestAgentsFromMission(
  mission: string,
  _techStack?: { languages?: string[]; frameworks?: string[] },
): SuggestedAgent[] {
  const agents: SuggestedAgent[] = [];
  const seen = new Set<string>();

  const add = (role: string, reason: string) => {
    if (seen.has(role)) return;
    seen.add(role);
    const preset = getPreset(role);
    agents.push({
      name: preset?.name ?? role,
      role,
      systemPrompt: preset?.systemPrompt ?? "",
      reason,
      source: "preset",
    });
  };

  add("backend", "기본 구현 에이전트");
  add("frontend", "기본 구현 에이전트");
  add("reviewer", "Quality Gate 필수");

  log.info(`Keyword-only suggestion (${agents.length} agents)`);
  return agents;
}

// ─── Team Presets (unchanged) ─────────────────────────────────────────────

export interface TeamPreset {
  id: string;
  name: string;
  description: string;
  agents: Array<{ name: string; role: string; parentRole?: string }>;
}

export function getTeamPresets(): TeamPreset[] {
  return [
    {
      id: "minimal",
      name: "Minimal",
      description: "Backend + Frontend + Reviewer",
      agents: [
        { name: "Backend Developer", role: "backend" },
        { name: "Frontend Developer", role: "frontend" },
        { name: "Code Reviewer", role: "reviewer" },
      ],
    },
    {
      id: "fullstack",
      name: "Full Stack Team",
      description: "CTO → Backend + Frontend + QA",
      agents: [
        { name: "CTO", role: "cto" },
        { name: "Backend Developer", role: "backend", parentRole: "cto" },
        { name: "Frontend Developer", role: "frontend", parentRole: "cto" },
        { name: "QA Engineer", role: "qa", parentRole: "cto" },
      ],
    },
    {
      id: "product",
      name: "Product Team",
      description: "CTO → Frontend + UX + QA",
      agents: [
        { name: "CTO", role: "cto" },
        { name: "Frontend Developer", role: "frontend", parentRole: "cto" },
        { name: "UX Designer", role: "ux", parentRole: "cto" },
        { name: "QA Engineer", role: "qa", parentRole: "cto" },
      ],
    },
    {
      id: "startup",
      name: "Startup Team",
      description: "CTO → Backend + Frontend + UX + QA + Reviewer",
      agents: [
        { name: "CTO", role: "cto" },
        { name: "Backend Developer", role: "backend", parentRole: "cto" },
        { name: "Frontend Developer", role: "frontend", parentRole: "cto" },
        { name: "UX Designer", role: "ux", parentRole: "cto" },
        { name: "QA Engineer", role: "qa", parentRole: "cto" },
        { name: "Code Reviewer", role: "reviewer", parentRole: "cto" },
      ],
    },
  ];
}
