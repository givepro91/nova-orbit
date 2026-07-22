import { describe, it, expect } from "vitest";
import {
  findUngroundedTargetFiles,
  stripNewFileMarkers,
  sanitizeAffectedUrls,
} from "../core/orchestration/engine.js";

/**
 * Decompose 접지 검증 헬퍼 테스트.
 *
 * decompose 가 인용한 target_files 는 레포에 실존해야 한다 — 추측 경로가
 * 구현/검증을 오도해 fix 라운드를 유발하는 것이 실측된 최다 실패 원인.
 * "+" 프리픽스는 신규 생성 선언이라 실존 검사에서 제외한다.
 */
describe("findUngroundedTargetFiles", () => {
  const exists = (paths: string[]) => (rel: string) => paths.includes(rel);

  it("returns empty when every cited path exists", () => {
    const tasks = [
      { title: "A", target_files: ["src/a.ts", "src/b.ts"] },
      { title: "B", target_files: [] },
    ];
    expect(findUngroundedTargetFiles(tasks, exists(["src/a.ts", "src/b.ts"]))).toEqual([]);
  });

  it("flags tasks citing nonexistent paths with the missing list", () => {
    const tasks = [
      { title: "A", target_files: ["src/a.ts"] },
      { title: "B", target_files: ["src/ghost.ts", "src/a.ts"] },
    ];
    expect(findUngroundedTargetFiles(tasks, exists(["src/a.ts"]))).toEqual([
      { index: 1, title: "B", missing: ["src/ghost.ts"] },
    ]);
  });

  it('skips "+"-prefixed new-file declarations', () => {
    const tasks = [{ title: "A", target_files: ["+src/new-file.ts", "src/a.ts"] }];
    expect(findUngroundedTargetFiles(tasks, exists(["src/a.ts"]))).toEqual([]);
  });

  it("ignores tasks without a target_files array and non-string entries", () => {
    const tasks = [
      { title: "A" },
      { title: "B", target_files: "not-an-array" },
      { title: "C", target_files: [42, null, ""] },
    ];
    expect(findUngroundedTargetFiles(tasks, exists([]))).toEqual([]);
  });

  it("falls back to a positional title when title is missing", () => {
    const tasks = [{ target_files: ["src/ghost.ts"] }];
    expect(findUngroundedTargetFiles(tasks, exists([]))).toEqual([
      { index: 0, title: "task 1", missing: ["src/ghost.ts"] },
    ]);
  });
});

describe("stripNewFileMarkers", () => {
  it('removes the "+" prefix and keeps plain paths as-is', () => {
    expect(stripNewFileMarkers(["+src/new.ts", "src/old.ts"])).toEqual([
      "src/new.ts",
      "src/old.ts",
    ]);
  });

  it('drops entries that are empty after stripping ("+" alone)', () => {
    expect(stripNewFileMarkers(["+", "+  ", "src/a.ts"])).toEqual(["src/a.ts"]);
  });
});

describe("sanitizeAffectedUrls", () => {
  it("returns empty for non-array input", () => {
    expect(sanitizeAffectedUrls(undefined)).toEqual([]);
    expect(sanitizeAffectedUrls("/cart")).toEqual([]);
  });

  it('keeps "/"-prefixed paths (including root) and trims whitespace', () => {
    expect(sanitizeAffectedUrls([" /cart ", "/", "/admin/coupons"])).toEqual([
      "/cart",
      "/",
      "/admin/coupons",
    ]);
  });

  it("drops non-strings, non-path values, and over-long entries", () => {
    const long = "/" + "x".repeat(200);
    expect(sanitizeAffectedUrls(["cart", "https://a.com/x", 3, null, long])).toEqual([]);
  });

  it("caps the list at 5 entries", () => {
    const urls = ["/a", "/b", "/c", "/d", "/e", "/f"];
    expect(sanitizeAffectedUrls(urls)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  });
});
