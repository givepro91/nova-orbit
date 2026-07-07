/**
 * Nova Rules Engine — 런타임에 방법론 규칙 텍스트를 로드해 에이전트 프롬프트에 주입한다.
 *
 * 이 디렉토리의 .md 파일들은 Orbit 소유다 (2026-07-07 Nova 의존 절단 — 직접 편집 가능).
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { VerificationScope } from "../../../shared/types.js";

/**
 * Resolve nova-rules directory: works both in dev (source tree) and prod (dist bundle).
 * In dev:  server/core/nova-rules/index.ts → __dirname = server/core/nova-rules/
 * In dist: dist/server/index.js (bundled) → __dirname = dist/ or dist/server/
 *          so we look for dist/server/core/nova-rules/ relative to the bundle root.
 */
function resolveRulesDir(): string {
  const devDir = dirname(fileURLToPath(import.meta.url));
  // Dev mode: this file is at server/core/nova-rules/index.ts
  if (existsSync(join(devDir, "rules.md"))) return devDir;

  // Bundled mode: find rules relative to dist/
  // import.meta.url points to something inside dist/, walk up to find dist root
  let dir = devDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "server", "core", "nova-rules");
    if (existsSync(join(candidate, "rules.md"))) return candidate;
    dir = dirname(dir);
  }

  // Fallback: try CWD-based paths
  const cwdCandidate = join(process.cwd(), "server", "core", "nova-rules");
  if (existsSync(join(cwdCandidate, "rules.md"))) return cwdCandidate;
  const distCandidate = join(process.cwd(), "dist", "server", "core", "nova-rules");
  if (existsSync(join(distCandidate, "rules.md"))) return distCandidate;

  return devDir; // best effort
}

const rulesDir = resolveRulesDir();

export interface NovaRulesEngine {
  /** Get verification protocol text for the given scope */
  getVerificationProtocol(scope: VerificationScope): string;
  /** Get all 10 auto-apply rules */
  getAutoApplyRules(): string;
  /** Get complexity guidance (§1) */
  getComplexityGuidance(): string;
  /** Get full orchestrator protocol */
  getOrchestratorProtocol(): string;
}

// Lazy-loaded file cache
const cache = new Map<string, string>();

function loadFile(filename: string): string {
  const cached = cache.get(filename);
  if (cached) return cached;

  const filePath = join(rulesDir, filename);
  if (!existsSync(filePath)) return "";

  const content = readFileSync(filePath, "utf-8");
  cache.set(filename, content);
  return content;
}

/**
 * Extract a markdown section by heading (## heading).
 * Returns content from the heading to the next same-level heading.
 */
function extractSection(content: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^## ${escaped}[\\s\\S]*?(?=\\n## |$)`, "m");
  const match = content.match(regex);
  return match ? match[0].trim() : "";
}

export function createNovaRulesEngine(): NovaRulesEngine {
  return {
    getVerificationProtocol(scope: VerificationScope): string {
      const protocol = loadFile("evaluator-protocol.md");
      if (!protocol) return "";

      // Strip YAML frontmatter
      const clean = protocol.replace(/^---[\s\S]*?---\n*/, "");

      if (scope === "lite") {
        return extractSection(clean, "Layer 1: 정적 분석 (즉시)") +
          "\n\n" + extractSection(clean, "평가 자세");
      }

      if (scope === "standard") {
        return [
          extractSection(clean, "Layer 1: 정적 분석 (즉시)"),
          extractSection(clean, "Layer 2: LLM 의미론적 분석"),
          extractSection(clean, "복잡도별 검증 강도"),
          extractSection(clean, "평가 자세"),
        ].filter(Boolean).join("\n\n");
      }

      // full — return everything
      return clean;
    },

    getAutoApplyRules(): string {
      const rules = loadFile("rules.md");
      if (!rules) return "";
      // Return all rules, stripping the header note
      return rules.replace(/^>.*\n>.*\n>.*\n\n---\n/m, "").trim();
    },

    getComplexityGuidance(): string {
      const rules = loadFile("rules.md");
      if (!rules) return "";
      return extractSection(rules, "§1. 작업 전 복잡도 + 위험도 판단");
    },

    getOrchestratorProtocol(): string {
      const protocol = loadFile("orchestrator-protocol.md");
      if (!protocol) return "";
      // Strip YAML frontmatter
      return protocol.replace(/^---[\s\S]*?---\n*/, "").trim();
    },
  };
}
