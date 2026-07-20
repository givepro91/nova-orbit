import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { findGoalsAwaitingSquash } from "../core/orchestration/engine.js";
import type Database from "better-sqlite3";

/**
 * Goal-as-Unit squash sweep 회귀 테스트.
 *
 * 버그(실측): 터미널에서 마지막 태스크를 done 처리한 goal 이 progress=100 인 채
 * squash_status='none' 에 갇혔다. 대시보드는 "완료 6/6 100%" 로 표시했지만 worktree 는
 * 살아 있고 main 에는 아무것도 반영되지 않았다. 승인 API 는 'none' 을 거부하므로
 * UI 로는 되살릴 수 없는 데드엔드였다.
 *
 * 원인: 태스크를 done 으로 만드는 경로 중 엔진 밖 경로(REST·터미널 브리지·review-loop·
 * delegation)는 checkAndTriggerGoalSquash 를 호출하지 않는다. 기존 sweeper 는
 * recovery_commit_ready=1 인 goal 만 봐서 이 경우를 못 건졌다.
 *
 * 계약: findGoalsAwaitingSquash = 루트 태스크가 모두 terminal 인데 squash 파이프라인이
 * 시작되지 않은 goal_as_unit goal 을, 어떤 경로로 done 됐는지와 무관하게 후보로 잡는다.
 */

let seq = 0;

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

function seedProject(db: Database.Database): string {
  const projectId = `p${++seq}`;
  db.prepare("INSERT INTO projects (id, name, source) VALUES (?, 'test', 'new')").run(projectId);
  return projectId;
}

function seedGoal(
  db: Database.Database,
  projectId: string,
  opts: { goalModel?: string; squashStatus?: string; worktreePath?: string | null } = {},
): string {
  const goalId = `g${++seq}`;
  db.prepare(
    "INSERT INTO goals (id, project_id, description, goal_model, squash_status, worktree_path) VALUES (?, ?, 'goal', ?, ?, ?)",
  ).run(
    goalId,
    projectId,
    opts.goalModel ?? "goal_as_unit",
    opts.squashStatus ?? "none",
    opts.worktreePath === undefined ? "/tmp/wt" : opts.worktreePath,
  );
  return goalId;
}

function seedTask(
  db: Database.Database,
  goalId: string,
  projectId: string,
  status: string,
  opts: { parentTaskId?: string | null; recoveryReady?: 0 | 1 } = {},
): string {
  const taskId = `t${++seq}`;
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, parent_task_id, recovery_commit_ready) VALUES (?, ?, ?, 'task', ?, ?, ?)",
  ).run(taskId, goalId, projectId, status, opts.parentTaskId ?? null, opts.recoveryReady ?? 0);
  return taskId;
}

function sweptIds(db: Database.Database): string[] {
  return findGoalsAwaitingSquash(db).map((g) => g.id);
}

describe("findGoalsAwaitingSquash", () => {
  let db: Database.Database;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    projectId = seedProject(db);
  });

  it("엔진 밖 경로로 done 된 goal 을 잡는다 (recovery 증거 없음 — 원 버그 재현)", () => {
    const goalId = seedGoal(db, projectId);
    seedTask(db, goalId, projectId, "done", { recoveryReady: 0 });
    seedTask(db, goalId, projectId, "done", { recoveryReady: 0 });

    expect(sweptIds(db)).toEqual([goalId]);
  });

  it("미완 루트 태스크가 남아 있으면 잡지 않는다", () => {
    const goalId = seedGoal(db, projectId);
    seedTask(db, goalId, projectId, "done");
    seedTask(db, goalId, projectId, "in_progress");

    expect(sweptIds(db)).toEqual([]);
  });

  it("미완 서브태스크는 완료 판정을 막지 않는다 (루트만 계산)", () => {
    const goalId = seedGoal(db, projectId);
    const rootId = seedTask(db, goalId, projectId, "done");
    seedTask(db, goalId, projectId, "in_progress", { parentTaskId: rootId });

    expect(sweptIds(db)).toEqual([goalId]);
  });

  it("done + skipped 혼합은 terminal 로 본다", () => {
    const goalId = seedGoal(db, projectId);
    seedTask(db, goalId, projectId, "done");
    seedTask(db, goalId, projectId, "skipped");

    expect(sweptIds(db)).toEqual([goalId]);
  });

  it("전부 skipped 면 잡지 않는다 (반영할 변경이 없어 blocked 노이즈만 생긴다)", () => {
    const goalId = seedGoal(db, projectId);
    seedTask(db, goalId, projectId, "skipped");

    expect(sweptIds(db)).toEqual([]);
  });

  it("이미 파이프라인에 진입한 goal 은 재진입시키지 않는다", () => {
    for (const status of ["triggering", "pending_approval", "approved", "resolving", "merged", "blocked"]) {
      const goalId = seedGoal(db, projectId, { squashStatus: status });
      seedTask(db, goalId, projectId, "done");
    }

    expect(sweptIds(db)).toEqual([]);
  });

  it("legacy goal 은 대상이 아니다", () => {
    const goalId = seedGoal(db, projectId, { goalModel: "legacy" });
    seedTask(db, goalId, projectId, "done");

    expect(sweptIds(db)).toEqual([]);
  });

  it("worktree 가 없는 goal 은 대상이 아니다", () => {
    const goalId = seedGoal(db, projectId, { worktreePath: null });
    seedTask(db, goalId, projectId, "done");

    expect(sweptIds(db)).toEqual([]);
  });

  it("태스크가 없는 goal 은 대상이 아니다 (분할 전 goal 이 즉시 반영되면 안 된다)", () => {
    seedGoal(db, projectId);

    expect(sweptIds(db)).toEqual([]);
  });

  it("goal 이 여러 개여도 각각 한 번씩만 반환한다", () => {
    const a = seedGoal(db, projectId);
    seedTask(db, a, projectId, "done");
    seedTask(db, a, projectId, "done");
    const b = seedGoal(db, projectId);
    seedTask(db, b, projectId, "done");

    expect(sweptIds(db).sort()).toEqual([a, b].sort());
  });
});
