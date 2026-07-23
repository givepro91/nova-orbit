import { describe, expect, it } from "vitest";
import { classifyFailCause } from "../core/quality-gate/fail-cause.js";

describe("classifyFailCause", () => {
  it("fail이 아닌 판정은 분류하지 않는다", () => {
    expect(classifyFailCause({ verdict: "pass" })).toBeNull();
    expect(classifyFailCause({ verdict: "conditional", termination_reason: "conditional" })).toBeNull();
    // pass인데 issue가 남아 있어도 분류 대상이 아니다
    expect(classifyFailCause({
      verdict: "pass",
      issues: [{ dimension: "craft", severity: "high" }],
    })).toBeNull();
  });

  it("termination_reason이 dimension보다 우선한다", () => {
    expect(classifyFailCause({
      verdict: "fail",
      termination_reason: "evaluator_error",
      issues: [{ dimension: "functionality", severity: "critical" }],
    })).toBe("evaluator_error");

    expect(classifyFailCause({
      verdict: "fail",
      termination_reason: "fix_round_limit",
      issues: [{ dimension: "functionality", severity: "critical" }],
    })).toBe("fix_round_limit");
  });

  it("분류 카테고리가 아닌 termination_reason은 dimension 신호를 가리지 않는다", () => {
    // hard_blocked는 severity의 재진술일 뿐 원인이 아니다
    expect(classifyFailCause({
      verdict: "fail",
      severity: "hard-block",
      termination_reason: "hard_blocked",
      issues: [{ dimension: "dataFlow", severity: "high" }],
    })).toBe("dataFlow");

    expect(classifyFailCause({
      verdict: "fail",
      termination_reason: "escalated_to_goal_qa",
      issues: [{ dimension: "edgeCases", severity: "warning" }],
    })).toBe("edgeCases");
  });

  it("최고 severity issue의 dimension을 고른다", () => {
    expect(classifyFailCause({
      verdict: "fail",
      issues: [
        { dimension: "craft", severity: "info" },
        { dimension: "functionality", severity: "critical" },
        { dimension: "edgeCases", severity: "warning" },
      ],
    })).toBe("functionality");
  });

  it("레거시 severity 어휘(major/medium/hard-block)도 랭크에 반영한다", () => {
    expect(classifyFailCause({
      verdict: "fail",
      issues: [
        { dimension: "craft", severity: "medium" },
        { dimension: "designAlignment", severity: "major" },
      ],
    })).toBe("designAlignment");

    expect(classifyFailCause({
      verdict: "fail",
      issues: [
        { dimension: "craft", severity: "high" },
        { dimension: "dataFlow", severity: "hard-block" },
      ],
    })).toBe("dataFlow");
  });

  it("severity 동점은 배열 첫 등장이 이긴다 (결정론적 출력)", () => {
    const issues = [
      { dimension: "craft", severity: "high" },
      { dimension: "functionality", severity: "high" },
    ];
    expect(classifyFailCause({ verdict: "fail", issues })).toBe("craft");
    expect(classifyFailCause({ verdict: "fail", issues: [...issues].reverse() })).toBe("functionality");
  });

  it("severity를 모르는 issue도 dimension이 있으면 unclassified로 떨어지지 않는다", () => {
    expect(classifyFailCause({
      verdict: "fail",
      issues: [{ dimension: "edgeCases", severity: "누가봐도이상한값" }],
    })).toBe("edgeCases");
    expect(classifyFailCause({ verdict: "fail", issues: [{ dimension: "craft" }] })).toBe("craft");
  });

  it("dimension이 없거나 어휘 밖이면 unclassified", () => {
    expect(classifyFailCause({ verdict: "fail" })).toBe("unclassified");
    expect(classifyFailCause({ verdict: "fail", issues: [] })).toBe("unclassified");
    expect(classifyFailCause({ verdict: "fail", issues: null })).toBe("unclassified");
    // dimension 없는 레거시 JSON blob issue
    expect(classifyFailCause({
      verdict: "fail",
      issues: [{ severity: "critical" } as never],
    })).toBe("unclassified");
    // 5개 화이트리스트 밖 dimension은 무시
    expect(classifyFailCause({
      verdict: "fail",
      issues: [{ dimension: "performance", severity: "critical" }],
    })).toBe("unclassified");
  });

  it("화이트리스트 밖 dimension이 최고 severity여도 유효한 dimension을 살린다", () => {
    expect(classifyFailCause({
      verdict: "fail",
      issues: [
        { dimension: "performance", severity: "critical" },
        { dimension: "craft", severity: "info" },
      ],
    })).toBe("craft");
  });
});
