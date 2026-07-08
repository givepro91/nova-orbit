import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { pickParallelGoals } from "../core/orchestration/scheduler.js";
import type Database from "better-sqlite3";

/**
 * Goal 간 병렬 선택 테스트.
 *
 * 계약: in-flight 태스크가 있는 goal 은 제외(goal 내부 순차 1),
 * ready(todo+assigned) 태스크가 있는 goal 을 우선순위 순으로 최대 maxGoals 개.
 */

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

let seq = 0;

function seedProject(db: Database.Database): { projectId: string; agentId: string } {
  const projectId = `p${++seq}`;
  db.prepare("INSERT INTO projects (id, name, source) VALUES (?, 'test', 'new')").run(projectId);
  const agentId = `a${seq}`;
  db.prepare(
    "INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'dev', 'backend')",
  ).run(agentId, projectId);
  return { projectId, agentId };
}

function seedGoal(
  db: Database.Database,
  projectId: string,
  opts: { priority?: string; sortOrder?: number } = {},
): string {
  const goalId = `g${++seq}`;
  db.prepare(
    "INSERT INTO goals (id, project_id, description, priority, sort_order) VALUES (?, ?, 'goal', ?, ?)",
  ).run(goalId, projectId, opts.priority ?? "medium", opts.sortOrder ?? 0);
  return goalId;
}

function seedTask(
  db: Database.Database,
  goalId: string,
  projectId: string,
  status: string,
  assigneeId: string | null,
  parentTaskId: string | null = null,
): string {
  const taskId = `t${++seq}`;
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id, parent_task_id) VALUES (?, ?, ?, 'task', ?, ?, ?)",
  ).run(taskId, goalId, projectId, status, assigneeId, parentTaskId);
  return taskId;
}

describe("pickParallelGoals", () => {
  let db: Database.Database;
  let projectId: string;
  let agentId: string;

  beforeEach(() => {
    db = createTestDb();
    ({ projectId, agentId } = seedProject(db));
  });

  it("ready 태스크가 있는 goal 을 우선순위 순으로 maxGoals 개 고른다", () => {
    const low = seedGoal(db, projectId, { priority: "low" });
    const critical = seedGoal(db, projectId, { priority: "critical" });
    const medium = seedGoal(db, projectId, { priority: "medium" });
    for (const g of [low, critical, medium]) seedTask(db, g, projectId, "todo", agentId);

    expect(pickParallelGoals(db, projectId, 2)).toEqual([critical, medium]);
    expect(pickParallelGoals(db, projectId, 10)).toEqual([critical, medium, low]);
  });

  it("in-flight 태스크가 있는 goal 은 제외한다 — goal 내부 순차 1", () => {
    const running = seedGoal(db, projectId, { priority: "critical" });
    seedTask(db, running, projectId, "in_progress", agentId);
    seedTask(db, running, projectId, "todo", agentId); // ready 가 있어도 in-flight 면 제외

    const idle = seedGoal(db, projectId, { priority: "low" });
    seedTask(db, idle, projectId, "todo", agentId);

    expect(pickParallelGoals(db, projectId, 5)).toEqual([idle]);
  });

  it("in_review 도 in-flight 로 취급한다", () => {
    const reviewing = seedGoal(db, projectId);
    seedTask(db, reviewing, projectId, "in_review", agentId);
    seedTask(db, reviewing, projectId, "todo", agentId);

    expect(pickParallelGoals(db, projectId, 5)).toEqual([]);
  });

  it("미배정 todo 만 있는 goal 은 ready 가 아니다", () => {
    const unassigned = seedGoal(db, projectId);
    seedTask(db, unassigned, projectId, "todo", null);

    expect(pickParallelGoals(db, projectId, 5)).toEqual([]);
  });

  it("pending_approval/blocked/done 만 있는 goal 은 제외된다", () => {
    const g = seedGoal(db, projectId);
    seedTask(db, g, projectId, "pending_approval", agentId);
    seedTask(db, g, projectId, "blocked", agentId);
    seedTask(db, g, projectId, "done", agentId);

    expect(pickParallelGoals(db, projectId, 5)).toEqual([]);
  });

  it("같은 우선순위는 sort_order 로 정렬한다", () => {
    const second = seedGoal(db, projectId, { sortOrder: 2 });
    const first = seedGoal(db, projectId, { sortOrder: 1 });
    for (const g of [second, first]) seedTask(db, g, projectId, "todo", agentId);

    expect(pickParallelGoals(db, projectId, 5)).toEqual([first, second]);
  });

  it("위임 대기 부모(in_progress + 미종결 하위 작업)는 in-flight 로 치지 않는다 — 하위 작업 기아 방지", () => {
    const g = seedGoal(db, projectId);
    const parent = seedTask(db, g, projectId, "in_progress", agentId);
    seedTask(db, g, projectId, "todo", agentId, parent); // 실행 대기 중인 하위 작업

    expect(pickParallelGoals(db, projectId, 5)).toEqual([g]);
  });

  it("하위 작업 자체가 in_progress 면 goal 은 제외된다 (내부 순차 1)", () => {
    const g = seedGoal(db, projectId);
    const parent = seedTask(db, g, projectId, "in_progress", agentId);
    seedTask(db, g, projectId, "in_progress", agentId, parent);
    seedTask(db, g, projectId, "todo", agentId, parent);

    expect(pickParallelGoals(db, projectId, 5)).toEqual([]);
  });

  it("하위 작업이 모두 종결된 in_progress 부모는 in-flight 다 (완료 처리 대기)", () => {
    const g = seedGoal(db, projectId);
    const parent = seedTask(db, g, projectId, "in_progress", agentId);
    seedTask(db, g, projectId, "done", agentId, parent);
    seedTask(db, g, projectId, "todo", agentId); // 부모와 무관한 다른 ready 태스크

    expect(pickParallelGoals(db, projectId, 5)).toEqual([]);
  });

  it("maxGoals 가 0 이하면 빈 배열", () => {
    const g = seedGoal(db, projectId);
    seedTask(db, g, projectId, "todo", agentId);

    expect(pickParallelGoals(db, projectId, 0)).toEqual([]);
    expect(pickParallelGoals(db, projectId, -1)).toEqual([]);
  });

  it("다른 프로젝트의 goal 은 섞이지 않는다", () => {
    const mine = seedGoal(db, projectId);
    seedTask(db, mine, projectId, "todo", agentId);

    const other = seedProject(db);
    const otherGoal = seedGoal(db, other.projectId);
    seedTask(db, otherGoal, other.projectId, "todo", other.agentId);

    expect(pickParallelGoals(db, projectId, 5)).toEqual([mine]);
  });
});
