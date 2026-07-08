import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { countFailRounds, shouldEscalateVerifyCap, escalateVerificationCap } from "../core/orchestration/verification-policy.js";
import { buildReverifyContext } from "../core/quality-gate/evaluator.js";
import type Database from "better-sqlite3";

/**
 * 무한 검토 방지 정책 테스트 (07-08 실측 7라운드 인시던트 회귀 방지).
 *
 * 계약:
 * - fail 라운드가 MAX_VERIFY_FAIL_ROUNDS(기본 3) 이상이면 escalate
 * - escalate = 완료 처리 + 미해결 이슈를 goal QA 태스크로 이월(멱등) + 활동 기록
 * - 재검증 프롬프트에는 이전 fail 이력 + 범위 제한 verdict 정책이 붙는다
 */

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

let seq = 0;

function seed(db: Database.Database) {
  const pid = `p${++seq}`;
  db.prepare("INSERT INTO projects (id, name, source) VALUES (?, 'test', 'new')").run(pid);
  const gid = `g${seq}`;
  db.prepare("INSERT INTO goals (id, project_id, description) VALUES (?, ?, 'goal')").run(gid, pid);
  const dev = `dev${seq}`;
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'dev', 'coder')").run(dev, pid);
  const qa = `qa${seq}`;
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'qa', 'qa')").run(qa, pid);
  return { pid, gid, dev, qa };
}

function seedTask(db: Database.Database, pid: string, gid: string, assignee: string, status = "in_review"): string {
  const id = `t${++seq}`;
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id) VALUES (?, ?, ?, '검증 태스크', ?, ?)",
  ).run(id, gid, pid, status, assignee);
  return id;
}

function addFail(db: Database.Database, taskId: string, n = 1): void {
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO verifications (task_id, verdict, issues) VALUES (?, 'fail', '[]')").run(taskId);
  }
}

describe("검증 라운드 상한 판정", () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });

  it("fail 만 센다 — pass/conditional 은 라운드에 포함되지 않음", () => {
    const { pid, gid, dev } = seed(db);
    const t = seedTask(db, pid, gid, dev);
    db.prepare("INSERT INTO verifications (task_id, verdict) VALUES (?, 'pass')").run(t);
    db.prepare("INSERT INTO verifications (task_id, verdict) VALUES (?, 'conditional')").run(t);
    addFail(db, t, 2);
    expect(countFailRounds(db, t)).toBe(2);
    expect(shouldEscalateVerifyCap(db, t)).toBe(false);
  });

  it("기본 상한 3회 도달 시 escalate 판정", () => {
    const { pid, gid, dev } = seed(db);
    const t = seedTask(db, pid, gid, dev);
    addFail(db, t, 3);
    expect(shouldEscalateVerifyCap(db, t)).toBe(true);
  });
});

describe("escalateVerificationCap", () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });

  function run(taskId: string, issues: any[] = [{ severity: "high", file: "a.ts", line: 1, message: "잔여 이슈" }]) {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    escalateVerificationCap(db, () => {}, task, issues);
  }

  it("태스크를 done 처리하고 QA 태스크 설명에 이슈를 이월한다", () => {
    const { pid, gid, dev, qa } = seed(db);
    const t = seedTask(db, pid, gid, dev);
    const qaTask = seedTask(db, pid, gid, qa, "todo");
    addFail(db, t, 3);

    run(t);

    expect((db.prepare("SELECT status FROM tasks WHERE id = ?").get(t) as any).status).toBe("done");
    const qaDesc = (db.prepare("SELECT description FROM tasks WHERE id = ?").get(qaTask) as any).description;
    expect(qaDesc).toContain("검증 상한 이월 이슈");
    expect(qaDesc).toContain("a.ts:1");
  });

  it("이월은 멱등 — 같은 태스크가 두 번 escalate 돼도 QA 설명에 한 번만", () => {
    const { pid, gid, dev, qa } = seed(db);
    const t = seedTask(db, pid, gid, dev);
    const qaTask = seedTask(db, pid, gid, qa, "todo");
    addFail(db, t, 3);

    run(t);
    run(t);

    const qaDesc = (db.prepare("SELECT description FROM tasks WHERE id = ?").get(qaTask) as any).description;
    expect(qaDesc.split("검증 상한 이월 이슈").length - 1).toBe(1);
  });

  it("QA 태스크가 없어도 done 처리 + 활동 기록은 남는다", () => {
    const { pid, gid, dev } = seed(db);
    const t = seedTask(db, pid, gid, dev);
    addFail(db, t, 3);

    run(t);

    expect((db.prepare("SELECT status FROM tasks WHERE id = ?").get(t) as any).status).toBe("done");
    const act = db.prepare(
      "SELECT COUNT(*) AS cnt FROM activities WHERE project_id = ? AND message LIKE '%검증 라운드 상한%'",
    ).get(pid) as { cnt: number };
    expect(act.cnt).toBe(1);
  });

  it("goal 진행률이 done 반영으로 갱신된다", () => {
    const { pid, gid, dev } = seed(db);
    const t = seedTask(db, pid, gid, dev);
    addFail(db, t, 3);

    run(t);

    expect((db.prepare("SELECT progress FROM goals WHERE id = ?").get(gid) as any).progress).toBe(100);
  });
});

describe("buildReverifyContext — 재검증 프롬프트 정책", () => {
  it("fail 이력이 없으면 빈 문자열 (1차 검증은 무영향)", () => {
    expect(buildReverifyContext([])).toBe("");
  });

  it("이전 이슈 목록과 범위 제한 정책이 포함된다", () => {
    const ctx = buildReverifyContext([
      { issues: JSON.stringify([{ severity: "high", file: "src/App.tsx", line: 543, message: "ESC 누수" }]), created_at: "2026-07-08 10:20:29" },
    ]);
    expect(ctx).toContain("src/App.tsx:543");
    expect(ctx).toContain("ADJACENT");
    expect(ctx).toContain("knownGaps");
  });

  it("깨진 JSON 이슈도 안전하게 폴백한다", () => {
    const ctx = buildReverifyContext([{ issues: "not-json{", created_at: "2026-07-08" }]);
    expect(ctx).toContain("not-json{");
  });
});
