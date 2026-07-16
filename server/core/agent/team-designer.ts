/**
 * AI Team Designer — 프로젝트를 실제로 읽고 맞춤 팀을 설계한다.
 *
 * 규칙표 기반 suggest(suggest.ts)의 상위 경로: 대상 프로젝트의 mission·docs·
 * 스택·디렉토리 구조를 컨텍스트로 Claude 세션 1개를 spawn해 도메인 특화 팀
 * (이름·이유·system prompt)을 JSON으로 받는다. 실패 시 호출부가 규칙표로
 * fallback하는 것을 전제로 하며, 여기서는 조용히 삼키지 않고 throw한다.
 *
 * role은 VALID_ROLES 안에서만 낸다 — role은 모델 라우팅/아이콘용 배관이고,
 * 도메인 특화는 name + system_prompt가 담당한다.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { promptLanguageRule } from "../../utils/language.js";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";
import { extractJsonArray } from "../../utils/llm-json.js";
import { getPreset, getAgentPresets } from "./roles.js";
import { createClaudeCodeAdapter } from "./adapters/claude-code.js";
import { parseAgentOutput } from "./adapters/stream-parser.js";
import { VALID_ROLES } from "../../utils/constants.js";
import type { SuggestedAgent } from "./suggest.js";

const log = createLogger("team-designer");

export interface TeamDesignInput {
  projectName: string;
  mission?: string | null;
  workdir: string;
  techStack?: { languages?: string[]; frameworks?: string[]; testFramework?: string } | null;
  focusGoal?: {
    title: string;
    description: string;
    plan?: string | null;
    tasks?: Array<{ title: string; description?: string; status?: string }>;
  } | null;
  maxAgents?: number;
  /** 대시보드 UI 언어("ko"|"en"). 있으면 그 언어로 설계, 없으면 프로젝트 언어 따라감. */
  language?: string | null;
}

const MAX_AGENTS_DEFAULT = 6;
const DOC_EXCERPT_LIMIT = 3000;

/** 설계 프롬프트 생성 — 순수 함수 (파일 읽기는 workdir 기준 best-effort) */
export function buildTeamDesignPrompt(input: TeamDesignInput): string {
  const maxAgents = input.maxAgents ?? MAX_AGENTS_DEFAULT;

  // 프로젝트 문서 발췌 (CLAUDE.md 우선, 없으면 README.md)
  let docsExcerpt = "";
  for (const file of ["CLAUDE.md", "README.md", "readme.md"]) {
    try {
      const p = join(input.workdir, file);
      if (existsSync(p)) {
        docsExcerpt = `\n\n[${file}]\n${readFileSync(p, "utf-8").slice(0, DOC_EXCERPT_LIMIT)}`;
        break;
      }
    } catch { /* skip */ }
  }

  // 최상위 구조 (파일+디렉토리, 40개 제한) — 도메인 힌트
  let structure = "";
  try {
    const entries = readdirSync(input.workdir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (entries.length > 0) structure = `\nTop-level structure: ${entries.join(", ")}`;
  } catch { /* skip */ }

  const stack = input.techStack;
  const stackInfo = stack
    ? `\nTech stack: ${(stack.languages ?? []).join(", ") || "unknown"} / ${(stack.frameworks ?? []).join(", ") || "-"}${stack.testFramework ? ` / tests: ${stack.testFramework}` : ""}`
    : "";

  const focusGoal = input.focusGoal;
  const goalInfo = focusGoal
    ? `\n\nSelected goal (design the team for this work):\nTitle: ${focusGoal.title}\nDescription: ${focusGoal.description || "(not set)"}${focusGoal.plan ? `\nApproved/draft plan: ${focusGoal.plan}` : ""}${focusGoal.tasks?.length ? `\nCurrent tasks:\n${focusGoal.tasks.map((task) => `- [${task.status ?? "todo"}] ${task.title}${task.description ? ` — ${task.description}` : ""}`).join("\n")}` : "\nCurrent tasks: (not split yet)"}`
    : "";

  // 아키타입 참조 — 설계의 출발점이지 정답이 아님을 명시
  const archetypes = getAgentPresets()
    .map((p) => `- ${p.role}: ${p.description?.slice(0, 80) ?? p.name}`)
    .join("\n");

  return `Design an AI agent team for THIS specific project. Each agent runs as an autonomous Claude Code session that implements/reviews tasks in this repo.

Project: ${input.projectName}
Mission: ${input.mission || "(not set)"}${goalInfo}${stackInfo}${structure}${docsExcerpt}

Reference archetypes (starting points, NOT answers — specialize beyond them):
${archetypes}

Respond in this EXACT JSON format (no markdown, just raw JSON):
[
  {
    "name": "domain-specific agent name (e.g. '커리어 증거 카피 검증자', 'Gameplay Systems Engineer')",
    "role": "one of: ${VALID_ROLES.join(", ")}",
    "reason": "why THIS project needs this agent (1 sentence)",
    "system_prompt": "300-800 chars. This agent's identity, responsibilities, what to focus on and what NOT to do — all specific to THIS project's domain, stack, and conventions. Written as instructions to the agent.",
    "model": "opus | sonnet | haiku — match the agent's actual work"
  }
]

Rules:
- 3 to ${maxAgents} agents. Quality over headcount — only roles this project actually needs.
- Optimize the team for the selected goal, its plan, and current task mix. Do not recommend unrelated roles just because the repository contains that technology.
- Domain specificity lives in "name" and "system_prompt". "role" is routing plumbing — pick the closest one; use "custom" if nothing fits.
- Include exactly one coordinator with role "cto" — Crewdeck's pipeline uses the cto agent for goal decomposition, spec generation, and architecture passes (it runs on the strongest model). Give it a project-specific identity too (e.g. product owner-architect for this domain).
- Include at least one reviewer or qa agent (Generator-Evaluator separation is mandatory).
- "model" per agent: "opus" for deep reasoning work (architecture, decomposition, balance-critical logic, adversarial review of complex systems — the cto coordinator should be opus), "sonnet" for standard implementation (the default), "haiku" only for genuinely simple mechanical work.
- system_prompt must reference this project's actual domain/stack/conventions — a prompt that could apply to any project is a failure.
- ${promptLanguageRule(input.language, "Respond in the same language as the project mission/docs (Korean if Korean).")}`;
}

/** LLM 응답 파싱 + 검증 — 순수 함수. 깨진 응답은 throw (호출부가 fallback). */
export function parseTeamDesign(raw: string, maxAgents = MAX_AGENTS_DEFAULT): SuggestedAgent[] {
  const parsed = extractJsonArray(raw);
  if (!parsed || parsed.length === 0) {
    throw new Error("Team design must be a non-empty array");
  }

  const agents: SuggestedAgent[] = [];
  for (const item of parsed.slice(0, maxAgents) as any[]) {
    const name = String(item?.name ?? "").trim().slice(0, 50);
    const systemPrompt = String(item?.system_prompt ?? "").trim().slice(0, 4000);
    if (!name || !systemPrompt) continue; // 필수 필드 없는 항목은 버림
    const rawRole = String(item?.role ?? "").trim().toLowerCase();
    const role = (VALID_ROLES as readonly string[]).includes(rawRole) ? rawRole : "custom";
    const rawModel = String(item?.model ?? "").trim().toLowerCase();
    const model = ["opus", "sonnet", "haiku"].includes(rawModel) ? rawModel : undefined;
    agents.push({
      name,
      role,
      systemPrompt,
      reason: String(item?.reason ?? "").trim().slice(0, 200),
      source: "ai",
      ...(model ? { model } : {}),
    });
  }
  if (agents.length === 0) {
    throw new Error("Team design produced no valid agents");
  }

  // Quality Gate 보장 — reviewer/qa 계열이 없으면 프리셋 reviewer 추가
  const hasReviewer = agents.some((a) => a.role === "reviewer" || a.role === "qa");
  if (!hasReviewer) {
    const preset = getPreset("reviewer");
    agents.push({
      name: preset?.name ?? "Code Reviewer",
      role: "reviewer",
      systemPrompt: preset?.systemPrompt ?? "",
      reason: "Quality Gate 필수 (자동 추가)",
      source: "preset",
    });
  }

  // 조정자 보장 — 분할·기획서·architect 단계가 cto role을 우선 사용(opus)하므로
  // cto/pm이 없으면 전략 단계가 임의 에이전트+sonnet으로 강등되고 architect는 스킵된다.
  const hasCoordinator = agents.some((a) => a.role === "cto" || a.role === "pm");
  if (!hasCoordinator) {
    const preset = getPreset("cto");
    agents.push({
      name: preset?.name ?? "CTO",
      role: "cto",
      systemPrompt: preset?.systemPrompt ?? "",
      reason: "분할·아키텍처 조정자 필수 (자동 추가)",
      source: "preset",
    });
  }

  return agents;
}

/**
 * 프로젝트별 설계 캐시 + in-flight 공유.
 *
 * 설계는 1~3분짜리 opus 세션이라, 클라이언트가 모달을 닫거나 새로고침해도
 * 결과를 버리지 않고 캐시에 남긴다. 진행 중에 같은 프로젝트로 다시 요청하면
 * 새 세션을 띄우지 않고 동일 Promise에 합류한다 (동일 키 inflight 락 패턴).
 * refresh=true는 캐시를 무시하고 새로 설계한다 ("다시 설계" 버튼).
 */
const DESIGN_CACHE_TTL_MS = 10 * 60_000;
const designInflight = new Map<string, Promise<SuggestedAgent[]>>();
const designCache = new Map<string, { agents: SuggestedAgent[]; at: number; consumed: boolean }>();

/**
 * 설계 상태 조회 — UI 표면화용.
 * ready = 캐시가 살아있고 아직 어떤 클라이언트도 결과를 받아가지 않음
 * (새로고침으로 응답을 놓친 경우 "결과 보기" 칩의 근거가 된다).
 */
export function getDesignStatus(projectId: string): { running: boolean; ready: boolean } {
  const cached = designCache.get(projectId);
  const fresh = !!cached && Date.now() - cached.at < DESIGN_CACHE_TTL_MS;
  return { running: designInflight.has(projectId), ready: fresh && !cached!.consumed };
}

/** 결과가 클라이언트에 전달됐음을 기록 — 이후 "결과 보기" 칩을 숨긴다 */
export function markDesignConsumed(projectId: string): void {
  const c = designCache.get(projectId);
  if (c) c.consumed = true;
}

export async function designTeamCached(
  projectId: string,
  input: TeamDesignInput,
  opts?: { refresh?: boolean; designFn?: (input: TeamDesignInput) => Promise<SuggestedAgent[]> },
): Promise<SuggestedAgent[]> {
  const designFn = opts?.designFn ?? designTeam;

  if (!opts?.refresh) {
    const cached = designCache.get(projectId);
    if (cached && Date.now() - cached.at < DESIGN_CACHE_TTL_MS) {
      log.info(`Design cache hit for project ${projectId}`);
      return cached.agents;
    }
    const inflight = designInflight.get(projectId);
    if (inflight) {
      log.info(`Joining in-flight design for project ${projectId}`);
      return inflight;
    }
  }

  const p = designFn(input)
    .then((agents) => {
      designCache.set(projectId, { agents, at: Date.now(), consumed: false });
      return agents;
    })
    .finally(() => {
      // 실패 시에도 inflight만 비운다 — 실패는 캐시하지 않아 재시도가 가능하다
      if (designInflight.get(projectId) === p) designInflight.delete(projectId);
    });
  designInflight.set(projectId, p);
  return p;
}

/** 테스트용 — 캐시/인플라이트 상태 초기화 */
export function clearDesignCache(): void {
  designInflight.clear();
  designCache.clear();
}

/**
 * 팀 설계 실행 — Claude 세션 1개 spawn (에이전트 row 불필요, 어댑터 직접 사용).
 * 프로젝트 workdir에서 실행되므로 설계자가 필요 시 파일을 직접 읽을 수 있다.
 */
export async function designTeam(input: TeamDesignInput): Promise<SuggestedAgent[]> {
  const adapter = createClaudeCodeAdapter();
  const session = adapter.spawn({
    workdir: input.workdir,
    systemPrompt:
      "You are a senior engineering team designer. You read the project you are placed in and design the smallest effective AI agent team for it. You respond with raw JSON only.",
    sessionBehavior: "new",
    model: "opus",
  });

  try {
    const result = await session.send(buildTeamDesignPrompt(input));
    if (result.exitCode !== 0 && result.stdout.trim() === "") {
      throw new Error(`Claude Code CLI failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
    }
    const parsed = parseAgentOutput(result.stdout, result.provider);
    const text = parsed.text || "";
    if (!text.trim()) {
      const cause = parsed.errors.length ? ` — ${parsed.errors.join("; ")}` : "";
      throw new Error(`Team design produced no text output${cause}`);
    }

    const agents = parseTeamDesign(text, input.maxAgents);
    log.info(`Designed team of ${agents.length} for "${input.projectName}"`, {
      agents: agents.map((a) => `${a.name}(${a.role})`),
    });
    return agents;
  } finally {
    session.kill();
  }
}
