import { describe, it, expect } from "vitest";
import { parseVerificationResult } from "../core/quality-gate/evaluator.js";

// de-ceremony: code 프롬프트가 더 이상 dimensions를 내보내지 않아도 verdict/issues 파싱이 온전해야 한다.
describe("parseVerificationResult (dimensions-optional)", () => {
  it("trusts verdict when code response has NO dimensions", () => {
    const r = parseVerificationResult(
      "t1",
      '```json\n{"verdict":"pass","severity":"auto-resolve","issues":[],"knownGaps":[]}\n```',
      "lite",
      "e1",
      "code",
    );
    expect(r.verdict).toBe("pass");
    expect(r.issues).toEqual([]);
  });

  it("parses fail + picks issue message (no dimensions)", () => {
    const r = parseVerificationResult(
      "t1",
      '```json\n{"verdict":"fail","issues":[{"severity":"critical","file":"a.ts","line":5,"message":"boom"}]}\n```',
      "full",
      "e1",
      "code",
    );
    expect(r.verdict).toBe("fail");
    expect(r.issues[0].message).toBe("boom");
    expect(r.severity).toBe("hard-block"); // critical → hard-block 유도 유지
  });

  it("content threshold still forces pass→fail below 6.0 avg", () => {
    const r = parseVerificationResult(
      "t1",
      '```json\n{"verdict":"pass","dimensions":{"completeness":{"value":3},"consistency":{"value":3},"clarity":{"value":3}}}\n```',
      "standard",
      "e1",
      "content",
    );
    expect(r.verdict).toBe("fail");
  });

  it("garbage → fail with parse-error signal (drives explicit retry)", () => {
    const r = parseVerificationResult("t1", "no json here", "lite", "e1", "code");
    expect(r.verdict).toBe("fail");
    expect(r.issues.some((i) => i.id === "issue-parse-error")).toBe(true);
  });
});
