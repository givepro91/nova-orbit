import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectScreenshots, extractWrapUp, initialWorkReport } from "../core/orchestration/work-report.js";

let work: string, dest: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "wt-"));
  dest = mkdtempSync(join(tmpdir(), "art-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

describe("collectScreenshots", () => {
  it("collects images from .playwright-mcp and .cc-shots, ignores non-images", () => {
    mkdirSync(join(work, ".playwright-mcp"), { recursive: true });
    mkdirSync(join(work, ".cc-shots"), { recursive: true });
    writeFileSync(join(work, ".playwright-mcp", "page-1.png"), "x");
    writeFileSync(join(work, ".playwright-mcp", "page.yml"), "x"); // 비이미지 무시
    writeFileSync(join(work, ".cc-shots", "after.jpg"), "x");
    const refs = collectScreenshots(work, dest);
    expect(refs.length).toBe(2);
    expect(readdirSync(dest).length).toBe(2);
    expect(refs.every((r) => /\.(png|jpe?g)$/i.test(r.file))).toBe(true);
  });
  it("returns empty when no capture dirs exist", () => {
    expect(collectScreenshots(work, dest)).toEqual([]);
  });
  it("caps the number collected", () => {
    mkdirSync(join(work, ".cc-shots"), { recursive: true });
    for (let i = 0; i < 30; i++) writeFileSync(join(work, ".cc-shots", `s${i}.png`), "x");
    expect(collectScreenshots(work, dest).length).toBeLessThanOrEqual(12);
  });
});

describe("extractWrapUp", () => {
  it("returns tail trimmed to a boundary within maxLen", () => {
    const t = "첫 문단.\n\n중간 작업 로그 여러 줄...\n\n마무리: 로그인 폼을 추가하고 검증을 붙였습니다.";
    const s = extractWrapUp(t, 60);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s).toContain("마무리");
  });
  it("handles empty", () => {
    expect(extractWrapUp("", 100)).toBe("");
  });
});

describe("initialWorkReport", () => {
  it("starts pending with given screenshots", () => {
    const wr = initialWorkReport([{ file: "a.png", label: "a" }]);
    expect(wr.summaryStatus).toBe("pending");
    expect(wr.before).toBeNull();
    expect(wr.screenshots.length).toBe(1);
  });
});
