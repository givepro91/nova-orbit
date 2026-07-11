import { describe, it, expect } from "vitest";
import { parseNarrativeJson } from "../core/orchestration/work-report.js";

describe("parseNarrativeJson", () => {
  it("parses a fenced json block (commitType defaults to feat)", () => {
    const out = parseNarrativeJson('설명...\n```json\n{"before":"a","changed":"b","after":"c","notes":""}\n```');
    expect(out).toEqual({ before: "a", changed: "b", after: "c", notes: "", commitType: "feat" });
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
