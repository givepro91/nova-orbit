import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { createDelegationEngine } from "../core/orchestration/delegation.js";
import type Database from "better-sqlite3";

/**
 * 위임 부모 완료 흐름 테스트 (07-08 실측 30분 ghost 루프 회귀 방지).
 *
 * 계약:
 * - 미종결 하위 작업이 있으면 재위임 스킵 + 대기 (delegated: true, 부모 in_progress)
 * - 하위 작업이 전부 종결됐으면 대기하지 않고 즉시 완료 흐름 실행 — 완료 신호는
 *   다시 오지 않으므로 대기는 무한 루프가 된다
 * - checkParentCompletion 의 CAS 는 in_progress 뿐 아니라 todo(ghost 복구로 리셋된
 *   상태)에서도 진입해야 한다
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
  const agentId = `a${seq}`;
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'lead', 'cto')").run(agentId, pid);
  return { pid, gid, agentId };
}

function seedTask(
  db: Database.Database,
  pid: string,
  gid: string,
  status: string,
  assigneeId: string,
  parentTaskId: string | null = null,
): string {
  const id = `t${++seq}`;
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id, parent_task_id) VALUES (?, ?, ?, 'task', ?, ?, ?)",
  ).run(id, gid, pid, status, assigneeId, parentTaskId);
  return id;
}

function makeEngine(db: Database.Database) {
  // 이 경로들은 sessionManager 를 사용하지 않고, parentVerifier 미지정 시
  // 즉시 done 폴백(legacy)을 타므로 스텁으로 충분하다
  return createDelegationEngine(db, {} as any, () => {});
}

const status = (db: Database.Database, id: string): string =>
  (db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;

describe("attemptDelegation — 기존 하위 작업 가드", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("미종결 하위 작업이 있으면 대기: 부모 in_progress, 완료 아님", async () => {
    const { pid, gid, agentId } = seed(db);
    const parent = seedTask(db, pid, gid, "todo", agentId);
    seedTask(db, pid, gid, "done", agentId, parent);
    seedTask(db, pid, gid, "todo", agentId, parent);

    const result = await makeEngine(db).attemptDelegation(parent);
    expect(result.delegated).toBe(true);
    expect(status(db, parent)).toBe("in_progress");
  });

  it("하위 작업 전부 done 이면 대기하지 않고 완료 흐름 실행 → 부모 done", async () => {
    const { pid, gid, agentId } = seed(db);
    const parent = seedTask(db, pid, gid, "todo", agentId);
    seedTask(db, pid, gid, "done", agentId, parent);
    seedTask(db, pid, gid, "done", agentId, parent);

    const result = await makeEngine(db).attemptDelegation(parent);
    expect(result.delegated).toBe(true);
    expect(status(db, parent)).toBe("done"); // 30분 ghost 루프 회귀 방지의 핵심
  });

  it("전부 done 이어도 직전 검증이 fail 이면 재검증 대신 수정 패스로 위임 해제", async () => {
    const { pid, gid, agentId } = seed(db);
    const parent = seedTask(db, pid, gid, "todo", agentId);
    seedTask(db, pid, gid, "done", agentId, parent);
    db.prepare(
      "INSERT INTO verifications (task_id, verdict, issues) VALUES (?, 'fail', '[{\"severity\":\"high\",\"message\":\"broken\"}]')",
    ).run(parent);

    const result = await makeEngine(db).attemptDelegation(parent);
    expect(result.delegated).toBe(false); // 부모가 직접 수정 패스 실행 (재검증-only 루프 차단)
    expect(status(db, parent)).toBe("todo"); // 상태 전이는 engine 의 실행 흐름이 담당
  });

  it("하위 작업 전부 종결 + 일부 blocked 면 부모 blocked", async () => {
    const { pid, gid, agentId } = seed(db);
    const parent = seedTask(db, pid, gid, "todo", agentId);
    seedTask(db, pid, gid, "done", agentId, parent);
    seedTask(db, pid, gid, "blocked", agentId, parent);

    await makeEngine(db).attemptDelegation(parent);
    expect(status(db, parent)).toBe("blocked");
  });
});

describe("checkParentCompletion — CAS 진입 상태", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("부모가 todo(ghost 복구로 리셋)여도 전부 done 이면 완료된다", async () => {
    const { pid, gid, agentId } = seed(db);
    const parent = seedTask(db, pid, gid, "todo", agentId);
    seedTask(db, pid, gid, "done", agentId, parent);

    await makeEngine(db).checkParentCompletion(parent);
    expect(status(db, parent)).toBe("done");
  });

  it("부모가 이미 done 이면 CAS 불발 — 중복 완료 없음", async () => {
    const { pid, gid, agentId } = seed(db);
    const parent = seedTask(db, pid, gid, "done", agentId);
    seedTask(db, pid, gid, "done", agentId, parent);

    await makeEngine(db).checkParentCompletion(parent);
    expect(status(db, parent)).toBe("done");
  });
});
