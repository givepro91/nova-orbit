import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { buildFailureHistoryContext } from "../core/orchestration/engine.js";
import type Database from "better-sqlite3";

/**
 * Smart Resume 실패 이력 컨텍스트 테스트.
 *
 * 재시도 실행(blocked→todo 재픽)이 이전 사이클의 실패 원인을 프롬프트로
 * 전달받는지 검증한다 — 이 블록이 비면 재시도가 같은 이슈를 백지에서
 * 재발견하는 토큰 낭비가 생긴다.
 */

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

function seedTask(db: Database.Database): string {
  db.prepare(
    "INSERT INTO projects (id, name, source) VALUES ('p1', 'test', 'new')",
  ).run();
  db.prepare(
    "INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'goal')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title) VALUES ('t1', 'g1', 'p1', 'task')",
  ).run();
  return "t1";
}

function insertVerification(
  db: Database.Database,
  taskId: string,
  verdict: string,
  issues: unknown,
  createdAt: string,
): void {
  db.prepare(
    "INSERT INTO verifications (task_id, verdict, issues, created_at) VALUES (?, ?, ?, ?)",
  ).run(taskId, verdict, typeof issues === "string" ? issues : JSON.stringify(issues), createdAt);
}

describe("buildFailureHistoryContext", () => {
  let db: Database.Database;
  let taskId: string;

  beforeEach(() => {
    db = createTestDb();
    taskId = seedTask(db);
  });

  it("실패 이력이 없으면 빈 문자열", () => {
    expect(buildFailureHistoryContext(db, taskId)).toBe("");
  });

  it("pass/conditional만 있으면 빈 문자열 — fail만 이력으로 취급", () => {
    insertVerification(db, taskId, "pass", [], "2026-07-08 01:00:00");
    insertVerification(db, taskId, "conditional", [{ severity: "auto-resolve", message: "minor" }], "2026-07-08 02:00:00");
    expect(buildFailureHistoryContext(db, taskId)).toBe("");
  });

  it("fail 이슈를 severity·file:line·message 포맷으로 나열한다", () => {
    insertVerification(db, taskId, "fail", [
      { severity: "soft-block", file: "src/store.ts", line: 1017, message: "finishBattle skips spectate transition" },
    ], "2026-07-08 01:00:00");

    const ctx = buildFailureHistoryContext(db, taskId);
    expect(ctx).toContain("## Previous Failure History");
    expect(ctx).toContain("[soft-block] src/store.ts:1017 — finishBattle skips spectate transition");
  });

  it("file/line이 없는 이슈도 안전하게 포맷한다", () => {
    insertVerification(db, taskId, "fail", [
      { severity: "hard-block", message: "no file info" },
    ], "2026-07-08 01:00:00");

    const ctx = buildFailureHistoryContext(db, taskId);
    expect(ctx).toContain("[hard-block]  — no file info");
    expect(ctx).not.toContain("null");
    expect(ctx).not.toContain("undefined");
  });

  it("최신 실패가 Attempt 1로 먼저 온다", () => {
    insertVerification(db, taskId, "fail", [{ severity: "soft-block", message: "older issue" }], "2026-07-08 01:00:00");
    insertVerification(db, taskId, "fail", [{ severity: "soft-block", message: "newer issue" }], "2026-07-08 02:00:00");

    const ctx = buildFailureHistoryContext(db, taskId);
    expect(ctx.indexOf("newer issue")).toBeLessThan(ctx.indexOf("older issue"));
  });

  it("limit을 넘는 오래된 실패는 제외된다", () => {
    insertVerification(db, taskId, "fail", [{ severity: "soft-block", message: "oldest" }], "2026-07-08 01:00:00");
    insertVerification(db, taskId, "fail", [{ severity: "soft-block", message: "middle" }], "2026-07-08 02:00:00");
    insertVerification(db, taskId, "fail", [{ severity: "soft-block", message: "newest" }], "2026-07-08 03:00:00");

    const ctx = buildFailureHistoryContext(db, taskId, 2);
    expect(ctx).toContain("newest");
    expect(ctx).toContain("middle");
    expect(ctx).not.toContain("oldest");
  });

  it("issues가 깨진 JSON이면 원문 그대로 폴백한다", () => {
    insertVerification(db, taskId, "fail", "not-json{", "2026-07-08 01:00:00");

    const ctx = buildFailureHistoryContext(db, taskId);
    expect(ctx).toContain("not-json{");
  });

  it("다른 태스크의 실패는 섞이지 않는다", () => {
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title) VALUES ('t2', 'g1', 'p1', 'other')",
    ).run();
    insertVerification(db, "t2", "fail", [{ severity: "soft-block", message: "other task issue" }], "2026-07-08 01:00:00");

    expect(buildFailureHistoryContext(db, taskId)).toBe("");
  });
});
