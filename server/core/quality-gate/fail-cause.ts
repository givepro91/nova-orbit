import type { FailCauseCategory, QualityGateDimension } from "../../../shared/types.js";

/**
 * fail 판정의 사유를 룰 기반으로 분류하는 순수 함수. 새 AI 호출 없이 이미 기록된
 * verification 필드만 읽는다 — 라벨은 사람 → 분석 단방향이고, evaluator는 이 모듈을
 * 참조하지 않는다 (Generator-Evaluator 분리 유지).
 */

const DIMENSIONS: readonly QualityGateDimension[] = [
  "functionality", "dataFlow", "designAlignment", "craft", "edgeCases",
];

/**
 * issue severity 랭크. `verification_issues.severity` CHECK는 critical/high/warning/info
 * 4개지만, 레거시 `verifications.issues` JSON blob에는 정규화 이전 어휘(major/medium/
 * hard-block)가 섞여 있다 — 실측 모수에서 그 행들이 랭크 0으로 밀리지 않도록 함께 매핑한다.
 */
const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  "hard-block": 4,
  hard_block: 4,
  high: 3,
  major: 3,
  warning: 2,
  medium: 2,
  "soft-block": 2,
  soft_block: 2,
  info: 1,
  low: 1,
};

export interface FailCauseIssue {
  dimension?: string | null;
  severity?: string | null;
}

export interface FailCauseInput {
  verdict: string;
  /** verification 레벨 severity. 분류에는 쓰지 않는다 — 행을 그대로 넘길 수 있게 받아만 둔다. */
  severity?: string | null;
  termination_reason?: string | null;
  issues?: FailCauseIssue[] | null;
}

function severityRank(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  return SEVERITY_RANK[raw.trim().toLowerCase()] ?? 0;
}

function isDimension(raw: unknown): raw is QualityGateDimension {
  return typeof raw === "string" && (DIMENSIONS as readonly string[]).includes(raw);
}

/**
 * 우선순위: termination_reason(evaluator_error → fix_round_limit) → 최고 severity issue의
 * dimension → 'unclassified'. severity 동점은 배열 첫 등장이 이긴다(결정론적 출력).
 *
 * fail이 아닌 판정은 분류 대상이 아니므로 null을 돌려준다 — 호출부가 fail만 집계한다.
 *
 * `hard_blocked`는 카테고리로 쓰지 않는다: fail의 hard_blocked는 severity의 재진술일 뿐
 * "원인"이 아니고, 우선순위 상단에 두면 dimension 신호를 가진 행을 통째로 가려버린다.
 */
export function classifyFailCause(input: FailCauseInput): FailCauseCategory | null {
  if (input.verdict !== "fail") return null;

  const reason = input.termination_reason;
  if (reason === "evaluator_error") return "evaluator_error";
  if (reason === "fix_round_limit") return "fix_round_limit";

  let best: QualityGateDimension | null = null;
  let bestRank = -1;
  for (const issue of Array.isArray(input.issues) ? input.issues : []) {
    if (!isDimension(issue?.dimension)) continue;
    const rank = severityRank(issue.severity);
    if (rank > bestRank) {
      best = issue.dimension;
      bestRank = rank;
    }
  }

  return best ?? "unclassified";
}
