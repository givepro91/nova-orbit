import { describe, it, expect } from "vitest";
import { parseNarrativeJson, buildDiffDigest, buildNarrativePrompt } from "../core/orchestration/work-report.js";

describe("parseNarrativeJson", () => {
  it("parses a fenced json block (commitType defaults to feat)", () => {
    const out = parseNarrativeJson('설명...\n```json\n{"before":"a","changed":"b","after":"c","notes":""}\n```');
    expect(out).toEqual({ before: "a", changed: "b", after: "c", notes: "", commitType: "feat", userImpact: null, outOfScope: "" });
  });
  it("picks up a valid commitType", () => {
    const out = parseNarrativeJson('```json\n{"commitType":"fix","before":"a","changed":"b","after":"c","notes":""}\n```');
    expect(out?.commitType).toBe("fix");
  });
  it("falls back to feat on invalid commitType", () => {
    const out = parseNarrativeJson('```json\n{"commitType":"bogus","before":"a","changed":"b","after":"c","notes":""}\n```');
    expect(out?.commitType).toBe("feat");
  });
  it("returns null on garbage", () => {
    expect(parseNarrativeJson("죄송합니다 JSON이 없어요")).toBeNull();
  });
  it("returns null when required keys missing", () => {
    expect(parseNarrativeJson('```json\n{"before":"a"}\n```')).toBeNull();
  });
});

// 확장 필드는 관대하게 — 모양이 틀려도 기존 서사는 살아남아야 한다.
describe("parseNarrativeJson — userImpact / outOfScope", () => {
  const base = '"before":"a","changed":"b","after":"c","notes":""';

  it("parses surfaces and trims outOfScope", () => {
    const out = parseNarrativeJson(
      `\`\`\`json\n{${base},"userImpact":{"visible":true,"surfaces":[{"name":"호스트 목록","change":"CPU 표기가 바뀐다"}]},"outOfScope":"  alias 6대 재생성이 섞였다  "}\n\`\`\``,
    );
    expect(out?.userImpact).toEqual({ visible: true, surfaces: [{ name: "호스트 목록", change: "CPU 표기가 바뀐다" }] });
    expect(out?.outOfScope).toBe("alias 6대 재생성이 섞였다");
  });

  it("keeps an explicit 'no user-visible change' declaration", () => {
    const out = parseNarrativeJson(`\`\`\`json\n{${base},"userImpact":{"visible":false,"surfaces":[]}}\n\`\`\``);
    // null(미생성)과 구별되어야 UI가 "체감 변화 없음"을 명시할 수 있다.
    expect(out?.userImpact).toEqual({ visible: false, surfaces: [] });
  });

  it("rejects a visible claim with no surfaces to back it", () => {
    const out = parseNarrativeJson(`\`\`\`json\n{${base},"userImpact":{"visible":true,"surfaces":[]}}\n\`\`\``);
    expect(out?.userImpact).toBeNull();
  });

  it("infers visible from surfaces when the flag is malformed", () => {
    const out = parseNarrativeJson(
      `\`\`\`json\n{${base},"userImpact":{"visible":"yes","surfaces":[{"name":"n","change":"c"}]}}\n\`\`\``,
    );
    expect(out?.userImpact).toEqual({ visible: true, surfaces: [{ name: "n", change: "c" }] });
  });

  it("survives garbage in the new fields without losing the narrative", () => {
    const out = parseNarrativeJson(`\`\`\`json\n{${base},"userImpact":"엉뚱한 문자열","outOfScope":42}\n\`\`\``);
    expect(out?.before).toBe("a");
    expect(out?.userImpact).toBeNull();
    expect(out?.outOfScope).toBe("");
  });
});

describe("buildDiffDigest", () => {
  const block = (path: string, body = "+++ changed\n") => `diff --git a/${path} b/${path}\n${body}`;

  it("drops generated noise but keeps real changes", () => {
    const raw = block("src/app.ts") + block("package-lock.json") + block("dist/bundle.js");
    const d = buildDiffDigest(" src/app.ts | 2 +-\n", raw);
    expect(d.body).toContain("src/app.ts");
    expect(d.body).not.toContain("package-lock.json");
    expect(d.body).not.toContain("dist/bundle.js");
    expect(d.dropped).toBe(2);
    expect(d.truncated).toBe(false);
  });

  it("flags truncation once the body exceeds budget", () => {
    const huge = block("src/big.ts", `${"+x\n".repeat(30_000)}`);
    const d = buildDiffDigest("", huge + block("src/small.ts"));
    expect(d.truncated).toBe(true);
  });

  it("returns an empty body for an empty diff", () => {
    const d = buildDiffDigest("", "");
    expect(d).toEqual({ stat: "", body: "", truncated: false, dropped: 0 });
  });
});

describe("buildNarrativePrompt", () => {
  const goal = { title: "제목", description: "설명" };

  it("omits the diff section entirely when no diff is available", () => {
    const p = buildNarrativePrompt(goal, [], ["a.ts"], null);
    expect(p).not.toContain("실제 코드 변경");
    expect(p).toContain("a.ts");
  });

  it("tells the model to trust the diff over the agent's self-report", () => {
    const p = buildNarrativePrompt(goal, [], ["a.ts"], { stat: "1 file", body: "diff --git a/a.ts b/a.ts", truncated: false, dropped: 0 });
    expect(p).toContain("실제 코드 변경");
    expect(p).toContain("이 diff를 믿으세요");
  });

  // 잘린 diff를 다 본 것처럼 "범위 밖 변경 없음"이라 단언하는 것이 최악의 실패 모드다.
  it("forbids asserting outOfScope when the diff was truncated", () => {
    const p = buildNarrativePrompt(goal, [], [], { stat: "s", body: "b", truncated: true, dropped: 0 });
    expect(p).toContain("단정하지 마세요");
  });

  it("reports how many generated blocks were dropped", () => {
    const p = buildNarrativePrompt(goal, [], [], { stat: "s", body: "b", truncated: false, dropped: 3 });
    expect(p).toContain("생성물 3개");
  });
});
