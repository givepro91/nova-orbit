import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { detectAnomalies } from "../core/anomalies.js";
import type Database from "better-sqlite3";

/**
 * 이상 신호 감지 테스트.
 *
 * 이 패널의 실패 모드는 "못 잡는 것"이 아니라 "노이즈"다 — 평상시에도 뜨는 신호는
 * 사용자가 패널 자체를 무시하게 만든다(기존 관찰 6탭이 그렇게 죽었다). 그래서
 * 적중 케이스만큼 **안 떠야 하는 케이스**를 촘촘히 고정한다.
 */

vi.mock("../core/project/git-workflow.js", () => ({
  worktreeHasUncommittedChanges: vi.fn(() => false),
}));
const { worktreeHasUncommittedChanges } = await import("../core/project/git-workflow.js");
const mockDirty = vi.mocked(worktreeHasUncommittedChanges);

let seq = 0;

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

function seedProject(db: Database.Database): string {
  const id = `p${++seq}`;
  db.prepare("INSERT INTO projects (id, name, source) VALUES (?, 'test', 'new')").run(id);
  return id;
}

function seedGoal(
  db: Database.Database,
  projectId: string,
  opts: { squashStatus?: string; worktreePath?: string | null; goalModel?: string } = {},
): string {
  const id = `g${++seq}`;
  db.prepare(
    "INSERT INTO goals (id, project_id, title, description, goal_model, squash_status, worktree_path) VALUES (?, ?, 'goal', 'goal', ?, ?, ?)",
  ).run(
    id, projectId,
    opts.goalModel ?? "goal_as_unit",
    opts.squashStatus ?? "none",
    opts.worktreePath === undefined ? null : opts.worktreePath,
  );
  return id;
}

/** minutesAgo 를 주면 updated_at 을 그만큼 과거로 심는다. */
function seedTask(
  db: Database.Database,
  projectId: string,
  goalId: string | null,
  status: string,
  opts: { minutesAgo?: number; assigneeId?: string | null } = {},
): string {
  const id = `t${++seq}`;
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id) VALUES (?, ?, ?, 'task', ?, ?)",
  ).run(id, goalId, projectId, status, opts.assigneeId ?? null);
  if (opts.minutesAgo !== undefined) {
    db.prepare("UPDATE tasks SET updated_at = datetime('now', ?) WHERE id = ?")
      .run(`-${opts.minutesAgo} minutes`, id);
  }
  return id;
}

const kinds = (db: Database.Database, projectId: string) =>
  detectAnomalies(db, projectId).anomalies.map((a) => a.kind);

describe("detectAnomalies", () => {
  let db: Database.Database;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    projectId = seedProject(db);
    mockDirty.mockReset();
    mockDirty.mockReturnValue(false);
  });

  describe("정체 태스크", () => {
    it("60분 넘게 변화 없는 in_progress 를 잡는다", () => {
      const goalId = seedGoal(db, projectId);
      seedTask(db, projectId, goalId, "in_progress", { minutesAgo: 90 });

      const { anomalies } = detectAnomalies(db, projectId);
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].kind).toBe("stalled_task");
      expect(anomalies[0].severity).toBe("warning");
      expect(anomalies[0].ageMinutes).toBeGreaterThanOrEqual(89);
    });

    it("방금 갱신된 in_progress 는 잡지 않는다", () => {
      const goalId = seedGoal(db, projectId);
      seedTask(db, projectId, goalId, "in_progress", { minutesAgo: 5 });

      expect(kinds(db, projectId)).toEqual([]);
    });

    it("오래된 태스크라도 진행 중이 아니면 잡지 않는다", () => {
      const goalId = seedGoal(db, projectId);
      for (const status of ["done", "todo", "blocked", "skipped", "in_review"]) {
        seedTask(db, projectId, goalId, status, { minutesAgo: 600 });
      }

      expect(kinds(db, projectId)).toEqual([]);
    });

    it("다른 프로젝트의 정체는 넘어오지 않는다", () => {
      const other = seedProject(db);
      const otherGoal = seedGoal(db, other);
      seedTask(db, other, otherGoal, "in_progress", { minutesAgo: 300 });

      expect(kinds(db, projectId)).toEqual([]);
    });
  });

  describe("반영 차단", () => {
    it("squash_status='blocked' 인 goal 을 critical 로 잡는다", () => {
      const goalId = seedGoal(db, projectId, { squashStatus: "blocked" });
      seedTask(db, projectId, goalId, "done");
      seedTask(db, projectId, goalId, "done");

      const { anomalies } = detectAnomalies(db, projectId);
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].kind).toBe("apply_blocked");
      expect(anomalies[0].severity).toBe("critical");
      expect(anomalies[0].facts).toMatchObject({ doneCount: 2, totalCount: 2 });
    });

    it("'none' 은 잡지 않는다 — sweeper 가 자동 복구하므로 알리면 노이즈다", () => {
      const goalId = seedGoal(db, projectId, { squashStatus: "none" });
      seedTask(db, projectId, goalId, "done");

      expect(kinds(db, projectId)).toEqual([]);
    });

    it("정상 진행 상태들은 잡지 않는다", () => {
      for (const status of ["triggering", "pending_approval", "approved", "resolving", "merged"]) {
        const goalId = seedGoal(db, projectId, { squashStatus: status });
        seedTask(db, projectId, goalId, "done");
      }

      expect(kinds(db, projectId)).toEqual([]);
    });

    it("legacy goal 은 대상이 아니다", () => {
      const goalId = seedGoal(db, projectId, { squashStatus: "blocked", goalModel: "legacy" });
      seedTask(db, projectId, goalId, "done");

      expect(kinds(db, projectId)).toEqual([]);
    });
  });

  describe("저장 안 된 변경", () => {
    it("아무도 작업하지 않는데 dirty 면 잡는다", () => {
      mockDirty.mockReturnValue(true);
      const goalId = seedGoal(db, projectId, { worktreePath: "/tmp/wt" });
      seedTask(db, projectId, goalId, "done");

      const { anomalies } = detectAnomalies(db, projectId);
      expect(anomalies.map((a) => a.kind)).toEqual(["unsaved_changes"]);
    });

    it("작업 중(in_progress)이면 dirty 는 정상이므로 잡지 않는다", () => {
      mockDirty.mockReturnValue(true);
      const goalId = seedGoal(db, projectId, { worktreePath: "/tmp/wt" });
      seedTask(db, projectId, goalId, "in_progress");

      expect(kinds(db, projectId)).not.toContain("unsaved_changes");
    });

    it("clean 이면 잡지 않는다", () => {
      mockDirty.mockReturnValue(false);
      const goalId = seedGoal(db, projectId, { worktreePath: "/tmp/wt" });
      seedTask(db, projectId, goalId, "done");

      expect(kinds(db, projectId)).toEqual([]);
    });

    it("이미 반영된(merged) goal 은 검사하지 않는다 — git 호출 자체를 아낀다", () => {
      mockDirty.mockReturnValue(true);
      const goalId = seedGoal(db, projectId, { worktreePath: "/tmp/wt", squashStatus: "merged" });
      seedTask(db, projectId, goalId, "done");

      expect(kinds(db, projectId)).toEqual([]);
      expect(mockDirty).not.toHaveBeenCalled();
    });

    it("worktree 가 없으면 git 을 부르지 않는다", () => {
      const goalId = seedGoal(db, projectId, { worktreePath: null });
      seedTask(db, projectId, goalId, "done");

      detectAnomalies(db, projectId);
      expect(mockDirty).not.toHaveBeenCalled();
    });
  });

  describe("정렬과 리포트", () => {
    it("critical 이 warning 보다 먼저 온다", () => {
      const stalled = seedGoal(db, projectId);
      seedTask(db, projectId, stalled, "in_progress", { minutesAgo: 120 });
      const blocked = seedGoal(db, projectId, { squashStatus: "blocked" });
      seedTask(db, projectId, blocked, "done");

      expect(kinds(db, projectId)).toEqual(["apply_blocked", "stalled_task"]);
    });

    it("같은 심각도면 오래된 것이 먼저 온다", () => {
      const goalId = seedGoal(db, projectId);
      const recent = seedTask(db, projectId, goalId, "in_progress", { minutesAgo: 70 });
      const old = seedTask(db, projectId, goalId, "in_progress", { minutesAgo: 400 });

      const ids = detectAnomalies(db, projectId).anomalies.map((a) => a.targetId);
      expect(ids).toEqual([old, recent]);
    });

    it("이상이 없어도 감시 규모를 보고한다 — 빈 화면이 고장인지 정상인지 구분되어야 한다", () => {
      const goalId = seedGoal(db, projectId);
      seedTask(db, projectId, goalId, "done");
      seedTask(db, projectId, goalId, "todo");

      const report = detectAnomalies(db, projectId);
      expect(report.anomalies).toEqual([]);
      expect(report.watched).toEqual({ tasks: 2, goals: 1 });
      expect(report.checkedAt).toBeTruthy();
    });

    it("id 는 재조회에도 안정적이다", () => {
      const goalId = seedGoal(db, projectId);
      const taskId = seedTask(db, projectId, goalId, "in_progress", { minutesAgo: 90 });

      expect(detectAnomalies(db, projectId).anomalies[0].id).toBe(`stalled_task:${taskId}`);
      expect(detectAnomalies(db, projectId).anomalies[0].id).toBe(`stalled_task:${taskId}`);
    });
  });
});
