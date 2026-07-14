import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { reconcileMergedGoalTasks } from "../core/orchestration/engine.js";
import { pickParallelGoals } from "../core/orchestration/scheduler.js";
import type Database from "better-sqlite3";

/**
 * merged goal 정합화 회귀 테스트.
 *
 * 버그(실측): 반영(squash merge)된 goal 에 실패한 auto-fix 라운드가 남긴 [수정]
 * 태스크 등 미완료 태스크가 orphan 으로 남아 (1) 대시보드가 "반영됨 + N개 남음"
 * 으로 모순 표시되고 (2) scheduler 가 반영된 goal 을 재디스패치했다.
 *
 * 계약:
 * - reconcileMergedGoalTasks = goal 의 미완료 태스크를 done 종결 + 활동 기록(멱등)
 * - pickParallelGoals = squash_status='merged' goal 은 후보에서 제외
 */

let seq = 0;

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

function seedProject(db: Database.Database): { projectId: string; agentId: string } {
  const projectId = `p${++seq}`;
  db.prepare("INSERT INTO projects (id, name, source) VALUES (?, 'test', 'new')").run(projectId);
  const agentId = `a${seq}`;
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'dev', 'backend')").run(agentId, projectId);
  return { projectId, agentId };
}

function seedGoal(db: Database.Database, projectId: string, squashStatus = "none"): string {
  const goalId = `g${++seq}`;
  db.prepare(
    "INSERT INTO goals (id, project_id, description, squash_status) VALUES (?, ?, 'goal', ?)",
  ).run(goalId, projectId, squashStatus);
  return goalId;
}

function seedTask(
  db: Database.Database,
  goalId: string,
  projectId: string,
  status: string,
  opts: { assigneeId?: string | null; resultSummary?: string | null } = {},
): string {
  const taskId = `t${++seq}`;
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id, result_summary) VALUES (?, ?, ?, 'task', ?, ?, ?)",
  ).run(taskId, goalId, projectId, status, opts.assigneeId ?? null, opts.resultSummary ?? null);
  return taskId;
}

function statusOf(db: Database.Database, taskId: string): string {
  return (db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status;
}

describe("reconcileMergedGoalTasks", () => {
  let db: Database.Database;
  let projectId: string;
  let agentId: string;

  beforeEach(() => {
    db = createTestDb();
    ({ projectId, agentId } = seedProject(db));
  });

  it("미완료 태스크(todo/in_progress/pending_approval)를 done 으로 종결하고 개수를 반환한다", () => {
    const goalId = seedGoal(db, projectId, "merged");
    const done = seedTask(db, goalId, projectId, "done");
    const todo = seedTask(db, goalId, projectId, "todo", { assigneeId: agentId });
    const running = seedTask(db, goalId, projectId, "in_progress", { assigneeId: agentId });
    const pending = seedTask(db, goalId, projectId, "pending_approval");

    const broadcast = vi.fn();
    const closed = reconcileMergedGoalTasks(db, broadcast, goalId);

    expect(closed).toBe(3);
    expect(statusOf(db, todo)).toBe("done");
    expect(statusOf(db, running)).toBe("done");
    expect(statusOf(db, pending)).toBe("done");
    expect(statusOf(db, done)).toBe("done");
  });

  it("종결한 태스크에 result_summary 노트를 남기되 기존 요약은 보존한다(COALESCE)", () => {
    const goalId = seedGoal(db, projectId, "merged");
    const blank = seedTask(db, goalId, projectId, "todo");
    const hadSummary = seedTask(db, goalId, projectId, "in_progress", { resultSummary: "부분 작업 결과" });

    reconcileMergedGoalTasks(db, vi.fn(), goalId);

    const blankSummary = (db.prepare("SELECT result_summary FROM tasks WHERE id = ?").get(blank) as { result_summary: string }).result_summary;
    const keptSummary = (db.prepare("SELECT result_summary FROM tasks WHERE id = ?").get(hadSummary) as { result_summary: string }).result_summary;
    expect(blankSummary).toContain("자동 종결");
    expect(keptSummary).toBe("부분 작업 결과");
  });

  it("멱등 — 두 번째 호출은 종결할 게 없어 0 을 반환하고 활동을 추가하지 않는다", () => {
    const goalId = seedGoal(db, projectId, "merged");
    seedTask(db, goalId, projectId, "todo");
    seedTask(db, goalId, projectId, "done");

    expect(reconcileMergedGoalTasks(db, vi.fn(), goalId)).toBe(1);
    const actAfterFirst = (db.prepare("SELECT COUNT(*) c FROM activities WHERE project_id = ?").get(projectId) as { c: number }).c;
    expect(reconcileMergedGoalTasks(db, vi.fn(), goalId)).toBe(0);
    const actAfterSecond = (db.prepare("SELECT COUNT(*) c FROM activities WHERE project_id = ?").get(projectId) as { c: number }).c;
    expect(actAfterSecond).toBe(actAfterFirst);
  });

  it("미완료 태스크가 없으면 0 을 반환하고 broadcast/활동을 만들지 않는다", () => {
    const goalId = seedGoal(db, projectId, "merged");
    seedTask(db, goalId, projectId, "done");
    const broadcast = vi.fn();
    expect(reconcileMergedGoalTasks(db, broadcast, goalId)).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("종결 시 활동 로그 1건 + 태스크별 task:updated + project:updated 를 브로드캐스트한다", () => {
    const goalId = seedGoal(db, projectId, "merged");
    seedTask(db, goalId, projectId, "todo");
    seedTask(db, goalId, projectId, "pending_approval");
    const broadcast = vi.fn();

    reconcileMergedGoalTasks(db, broadcast, goalId);

    const events = broadcast.mock.calls.map((c) => c[0]);
    expect(events.filter((e) => e === "task:updated")).toHaveLength(2);
    expect(events).toContain("project:updated");
    const acts = db.prepare("SELECT message FROM activities WHERE project_id = ?").all(projectId) as { message: string }[];
    expect(acts.some((a) => a.message.includes("자동 종결"))).toBe(true);
  });
});

describe("pickParallelGoals — merged goal 제외", () => {
  let db: Database.Database;
  let projectId: string;
  let agentId: string;

  beforeEach(() => {
    db = createTestDb();
    ({ projectId, agentId } = seedProject(db));
  });

  it("반영된(merged) goal 에 ready todo 태스크가 있어도 후보로 뽑지 않는다", () => {
    const merged = seedGoal(db, projectId, "merged");
    seedTask(db, merged, projectId, "todo", { assigneeId: agentId }); // 정합화 전 잔존 시나리오

    const live = seedGoal(db, projectId, "none");
    seedTask(db, live, projectId, "todo", { assigneeId: agentId });

    expect(pickParallelGoals(db, projectId, 10)).toEqual([live]);
  });
});
