import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCodexJson } from "../core/agent/adapters/codex-stream-parser.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dir, "fixtures/codex-exec-basic.jsonl"), "utf-8");

describe("parseCodexJson", () => {
  it("agent_message item.text를 최종 텍스트로 추출", () => {
    const r = parseCodexJson(fixture);
    expect(r.text).toBe("작업을 완료했습니다.");
  });
  it("thread.started.thread_id를 sessionId로 추출", () => {
    expect(parseCodexJson(fixture).sessionId).toBe("019f45ac-d922-7b23-a938-a7df3b4f54d6");
  });
  it("turn.completed.usage에서 토큰 집계 (Codex는 cost 미보고 → 0)", () => {
    const u = parseCodexJson(fixture).usage!;
    expect(u.inputTokens).toBe(18041);
    expect(u.outputTokens).toBe(22);
    expect(u.cacheReadTokens).toBe(4992);
    expect(u.totalCostUsd).toBe(0);
    expect(u.tokenUsageReported).toBe(true);
    expect(u.costUsdReported).toBe(false);
  });
  it.each([
    { name: "빈 usage", usage: {} },
    { name: "일부 token 필드만 있는 usage", usage: { input_tokens: 12 } },
    { name: "음수 input token", usage: { input_tokens: -1, output_tokens: 12 } },
    { name: "음수 output token", usage: { input_tokens: 12, output_tokens: -1 } },
  ])("$name는 token 미보고로 분류", ({ usage }) => {
    const u = parseCodexJson(JSON.stringify({ type: "turn.completed", usage })).usage;
    expect(u?.tokenUsageReported).toBe(false);
  });
  it("item.type=='error'는 치명 실패로 보지 않는다(비치명 경고)", () => {
    expect(parseCodexJson(fixture).errors).toHaveLength(0);
  });
  it("빈/비JSONL 입력에 방어적", () => {
    expect(parseCodexJson("").text).toBe("");
    expect(parseCodexJson("not json\n{bad").text).toBe("");
  });
  it("top-level error 이벤트를 errors에 담아 원인을 노출 (모델/버전 불일치 등)", () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"message\\":\\"The \'gpt-5.6-sol\' model requires a newer version of Codex.\\"}}"}',
    ].join("\n");
    const r = parseCodexJson(jsonl);
    expect(r.text).toBe("");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("requires a newer version of Codex");
  });
  it("turn.failed 이벤트를 errors에 담는다", () => {
    const jsonl = [
      '{"type":"turn.started"}',
      '{"type":"turn.failed","error":{"message":"rate limited"}}',
    ].join("\n");
    const r = parseCodexJson(jsonl);
    expect(r.text).toBe("");
    expect(r.errors.some((e) => e.includes("rate limited"))).toBe(true);
  });
});
