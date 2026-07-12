import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createDatabase, migrate } from "../db/schema.js";

function createSessionManager(): SessionManager {
  return {
    spawnAgent: vi.fn(() => {
      throw new Error("execution slots are already occupied");
    }),
    getSession: vi.fn(() => undefined),
    getSessionRecord: vi.fn(() => undefined),
    killSession: vi.fn(),
    killAll: vi.fn(),
    pauseSession: vi.fn(),
    resumeSession: vi.fn(),
    setProviderOverride: vi.fn(),
    clearProviderOverride: vi.fn(),
  } as SessionManager;
}

/**
 * 반자동(goal)/완전자동(full)에서는 승인 게이트가 파이프라인을 막지 않아야 한다:
 * autopilot이 생성/보유한 draft 기획서를 자동 승인(execution_spec_version_id 고정)한 뒤
 * decompose로 넘어간다. 수동(off)에서는 승인 게이트가 그대로 실행을 막는다.
 */
describe("scheduler auto-approves the blueprint under goal/full autopilot", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  const projectId = "project-autoapprove";
  const goalId = "appr-goal";

  const decomposeActivityCount = (): number =>
    (db.prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE project_id = ? AND message LIKE '태스크 분할 중:%'",
    ).get(projectId) as { count: number }).count;

  const executionPin = (): string | null =>
    (db.prepare("SELECT execution_spec_version_id FROM goals WHERE id = ?").get(goalId) as {
      execution_spec_version_id: string | null;
    }).execution_spec_version_id;

  function seed(autopilot: "off" | "goal" | "full") {
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO projects (id, name, source, autopilot) VALUES (?, 'test', 'new', ?)",
    ).run(projectId, autopilot);
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role) VALUES ('cto-1', ?, 'cto', 'cto')",
    ).run(projectId);
    // 승인 대기 상태의 goal: draft 버전 존재 + marker on + 실행 기준 미고정.
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description, priority, sort_order, spec_approval_required, execution_spec_version_id) VALUES (?, ?, 'appr-goal', 'goal', 'critical', 0, 1, NULL)",
    ).run(goalId, projectId);
    db.prepare(
      `INSERT INTO goal_spec_versions (id, goal_id, version, scope, out_of_scope, acceptance_criteria, expected_tasks, verification_methods, status)
       VALUES ('ver-1', ?, 1, 'build login', '', '["ac1"]', '["task1"]', '["vm1"]', 'draft')`,
    ).run(goalId);

    scheduler = createScheduler(db, createSessionManager(), () => {});
    scheduler.setSpecGenerator(vi.fn(async () => {}));
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    scheduler.stopQueue(projectId);
    db.close();
    vi.useRealTimers();
  });

  it.each(["goal", "full"] as const)(
    "%s mode: auto-approves the draft and proceeds to decompose",
    async (autopilot) => {
      seed(autopilot);
      scheduler.startQueue(projectId);
      await vi.advanceTimersByTimeAsync(5_000);

      // 자동 승인: 실행 기준이 draft 버전으로 고정된다.
      expect(executionPin()).toBe("ver-1");
      // 게이트를 통과해 decompose 단계까지 진행한다.
      expect(decomposeActivityCount()).toBeGreaterThanOrEqual(1);
    },
  );

  it("off mode: the approval gate blocks — no auto-approve, no decompose", async () => {
    seed("off");
    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(executionPin()).toBeNull();
    expect(decomposeActivityCount()).toBe(0);
  });
});
