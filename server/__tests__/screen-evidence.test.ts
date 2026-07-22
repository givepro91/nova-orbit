import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { applyScreenEvidencePolicy } from "../core/quality-gate/evaluator.js";
import {
  hasScreenshotEvidence,
  sweepExpiredGoalArtifacts,
} from "../core/orchestration/work-report.js";

/**
 * ③ 화면 증거 정책 + ④ artifacts 수명 테스트.
 *
 * 화면 증거: affected_urls 를 선언한 code 태스크가 스크린샷 없이 pass 로 끝나면
 * conditional 로 강등된다 — 증거 부재가 자동 반영으로 이어지는 것을 막는 게이트.
 */
describe("applyScreenEvidencePolicy", () => {
  it("downgrades pass to conditional when evidence is required but missing", () => {
    expect(applyScreenEvidencePolicy("pass", true, false)).toEqual({
      verdict: "conditional",
      downgraded: true,
    });
  });

  it("keeps pass when evidence exists", () => {
    expect(applyScreenEvidencePolicy("pass", true, true)).toEqual({
      verdict: "pass",
      downgraded: false,
    });
  });

  it("never touches fail or conditional verdicts", () => {
    expect(applyScreenEvidencePolicy("fail", true, false).verdict).toBe("fail");
    expect(applyScreenEvidencePolicy("conditional", true, false).verdict).toBe("conditional");
  });

  it("is a no-op when evidence is not required", () => {
    expect(applyScreenEvidencePolicy("pass", false, false)).toEqual({
      verdict: "pass",
      downgraded: false,
    });
  });
});

describe("hasScreenshotEvidence", () => {
  it("finds images in .cc-shots (nested included)", () => {
    const w = mkdtempSync(join(tmpdir(), "shots-"));
    mkdirSync(join(w, ".cc-shots", "nested"), { recursive: true });
    writeFileSync(join(w, ".cc-shots", "nested", "cart-after.png"), "x");
    expect(hasScreenshotEvidence(w)).toBe(true);
  });

  it("finds images in .playwright-mcp", () => {
    const w = mkdtempSync(join(tmpdir(), "shots-"));
    mkdirSync(join(w, ".playwright-mcp"), { recursive: true });
    writeFileSync(join(w, ".playwright-mcp", "page.jpeg"), "x");
    expect(hasScreenshotEvidence(w)).toBe(true);
  });

  it("returns false for missing dirs, empty dirs, and non-image files", () => {
    const w = mkdtempSync(join(tmpdir(), "shots-"));
    expect(hasScreenshotEvidence(w)).toBe(false);
    mkdirSync(join(w, ".cc-shots"), { recursive: true });
    writeFileSync(join(w, ".cc-shots", "notes.txt"), "x");
    expect(hasScreenshotEvidence(w)).toBe(false);
  });
});

describe("sweepExpiredGoalArtifacts", () => {
  function makeDataDir() {
    const dataDir = mkdtempSync(join(tmpdir(), "crewdeck-sweep-"));
    const db = new Database(join(dataDir, "crewdeck.db"));
    db.exec("CREATE TABLE goals (id TEXT PRIMARY KEY)");
    return { dataDir, db };
  }

  function makeArtifactDir(dataDir: string, goalId: string, ageDays = 0) {
    const dir = join(dataDir, "artifacts", "goals", goalId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shot.png"), "x");
    if (ageDays > 0) {
      const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
      utimesSync(dir, t, t);
    }
    return dir;
  }

  it("removes orphan dirs (goal row gone) and keeps live recent goals", () => {
    const { dataDir, db } = makeDataDir();
    db.prepare("INSERT INTO goals (id) VALUES ('alive')").run();
    const orphanDir = makeArtifactDir(dataDir, "ghost");
    const aliveDir = makeArtifactDir(dataDir, "alive");

    expect(sweepExpiredGoalArtifacts(db)).toBe(1);
    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(aliveDir)).toBe(true);
  });

  it("removes dirs older than maxAgeDays even when the goal still exists", () => {
    const { dataDir, db } = makeDataDir();
    db.prepare("INSERT INTO goals (id) VALUES ('old')").run();
    const oldDir = makeArtifactDir(dataDir, "old", 40);

    expect(sweepExpiredGoalArtifacts(db, 30)).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
  });

  it("returns 0 when the artifacts root does not exist", () => {
    const { db } = makeDataDir();
    expect(sweepExpiredGoalArtifacts(db)).toBe(0);
  });
});
