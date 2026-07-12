import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createDatabase, migrate } from "../db/schema.js";

const runtime = vi.hoisted(() => ({
  executeTask: vi.fn(),
}));

vi.mock("../core/orchestration/engine.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createOrchestrationEngine: () => ({ executeTask: runtime.executeTask }),
  };
});

vi.mock("../core/agent/adapters/backend.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBackend: () => ({ isAvailable: async () => true }),
  };
});

vi.mock("../core/agent/provider.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadProviderConfig: () => ({
      defaultProvider: "claude",
      codexFailover: true,
      codexModelMap: {},
    }),
  };
});

import { createScheduler } from "../core/orchestration/scheduler.js";

describe("scheduler failure redispatch ordering", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  let sessionManager: SessionManager;
  const projectId = "project-retry-order";

  function seedAgent(id: string, role = "backend"): void {
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)",
    ).run(id, projectId, id, role);
  }

  function seedGoal(id: string, sortOrder: number): void {
    db.prepare(
      `INSERT INTO goals (id, project_id, title, description, priority, sort_order)
       VALUES (?, ?, ?, 'goal', 'high', ?)`,
    ).run(id, projectId, id, sortOrder);
  }

  function seedTask(input: {
    id: string;
    goalId: string;
    agentId: string;
    status?: string;
    sortOrder?: number;
    retryCount?: number;
  }): void {
    db.prepare(
      `INSERT INTO tasks (
         id, goal_id, project_id, title, status, assignee_id, sort_order, retry_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.goalId,
      projectId,
      input.id,
      input.status ?? "todo",
      input.agentId,
      input.sortOrder ?? 0,
      input.retryCount ?? 0,
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    runtime.executeTask.mockReset();
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO projects (id, name, source) VALUES (?, 'test', 'new')",
    ).run(projectId);
    sessionManager = {
      spawnAgent: vi.fn(),
      getSession: vi.fn(() => undefined),
      getSessionRecord: vi.fn(() => undefined),
      killSession: vi.fn(),
      killAll: vi.fn(),
      pauseSession: vi.fn(),
      resumeSession: vi.fn(),
      setProviderOverride: vi.fn(),
      clearProviderOverride: vi.fn(),
    } as SessionManager;
    scheduler = createScheduler(db, sessionManager, () => {});
  });

  afterEach(() => {
    scheduler.stopQueue(projectId);
    db.close();
    vi.useRealTimers();
  });

  it("cooldown 중인 blocked task가 goal slot을 유지해 새 goal이 빈 슬롯을 쓰지 못한다", async () => {
    seedAgent("retry-agent");
    seedAgent("next-agent");
    seedAgent("other-agent");
    seedGoal("failed-goal", 0);
    seedGoal("other-goal", 1);
    seedGoal("must-wait-goal", 2);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "retry-agent", status: "blocked" });
    seedTask({ id: "same-goal-next", goalId: "failed-goal", agentId: "next-agent", sortOrder: 1 });
    seedTask({ id: "other-running", goalId: "other-goal", agentId: "other-agent" });
    seedTask({ id: "new-goal-task", goalId: "must-wait-goal", agentId: "next-agent" });
    runtime.executeTask.mockImplementation(() => new Promise(() => {}));

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(1);

    expect(runtime.executeTask.mock.calls.map(([taskId]) => taskId)).toEqual(["other-running"]);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'failed'").get())
      .toMatchObject({ status: "blocked" });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'new-goal-task'").get())
      .toMatchObject({ status: "todo" });
  });

  it("cooldown이 끝난 retry는 같은 task_id와 예산으로 후속 task/reviewer보다 먼저 claim된다", async () => {
    seedAgent("retry-agent");
    seedAgent("next-agent");
    seedAgent("reviewer-agent", "reviewer");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "retry-agent", status: "blocked" });
    seedTask({ id: "same-goal-next", goalId: "failed-goal", agentId: "next-agent", sortOrder: 1 });
    seedTask({ id: "review", goalId: "failed-goal", agentId: "reviewer-agent", sortOrder: 2 });
    db.prepare("UPDATE tasks SET updated_at = datetime('now', '-1 day') WHERE id = 'failed'").run();
    runtime.executeTask.mockImplementation(() => new Promise(() => {}));

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(1);

    expect(runtime.executeTask).toHaveBeenCalledTimes(1);
    expect(runtime.executeTask.mock.calls[0]?.[0]).toBe("failed");
    expect(db.prepare("SELECT status, retry_count FROM tasks WHERE id = 'failed'").get())
      .toEqual({ status: "in_progress", retry_count: 1 });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'same-goal-next'").get())
      .toEqual({ status: "todo" });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'review'").get())
      .toEqual({ status: "todo" });
  });

  it("dirty recovery blocked 판단을 rate-limit failover가 todo로 덮지 않는다", async () => {
    seedAgent("worker");
    seedGoal("blocked-goal", 0);
    seedTask({ id: "blocked-recovery", goalId: "blocked-goal", agentId: "worker" });
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      db.prepare(`
        UPDATE tasks SET status = 'blocked', recovery_manual_action_required = 1
        WHERE id = ?
      `).run(taskId);
      const error = new Error("rate limit reached") as Error & { recoveryDecision: string };
      error.recoveryDecision = "blocked";
      throw error;
    });

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(1);
    scheduler.stopQueue(projectId);

    expect(db.prepare(`
      SELECT status, recovery_manual_action_required FROM tasks WHERE id = 'blocked-recovery'
    `).get()).toEqual({ status: "blocked", recovery_manual_action_required: 1 });
    expect(sessionManager.setProviderOverride).not.toHaveBeenCalled();
  });

  it("clean recovery resume 판단을 generic task error가 blocked로 덮지 않는다", async () => {
    seedAgent("worker");
    seedGoal("resume-goal", 0);
    seedTask({ id: "resume-recovery", goalId: "resume-goal", agentId: "worker" });
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
      const error = new Error("invalid agent output") as Error & { recoveryDecision: string };
      error.recoveryDecision = "resume";
      throw error;
    });

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(1);
    scheduler.stopQueue(projectId);

    expect(db.prepare("SELECT status, retry_count FROM tasks WHERE id = 'resume-recovery'").get())
      .toEqual({ status: "todo", retry_count: 0 });
  });

  it("failover callback과 poll이 겹쳐도 같은 task만 한 번 재claim하고 새 session을 연결한다", async () => {
    seedAgent("worker");
    seedAgent("next-agent");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });
    seedTask({ id: "same-goal-next", goalId: "failed-goal", agentId: "next-agent", sortOrder: 1 });

    let attempt = 0;
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      attempt++;
      if (attempt === 1) {
        db.prepare(
          "INSERT INTO sessions (id, agent_id, status, provider, task_id) VALUES ('session-claude', 'worker', 'failed', 'claude', ?)",
        ).run(taskId);
        db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
        throw new Error("rate limit reached");
      }
      db.prepare(
        "INSERT INTO sessions (id, agent_id, status, provider, task_id) VALUES ('session-codex', 'worker', 'completed', 'codex', ?)",
      ).run(taskId);
      return new Promise(() => {});
    });

    scheduler.startQueue(projectId);
    scheduler.notifyGoalReady(projectId);
    scheduler.notifyGoalReady(projectId);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(runtime.executeTask.mock.calls.map(([taskId]) => taskId)).toEqual(["failed", "failed"]);
    expect(sessionManager.setProviderOverride).toHaveBeenCalledWith("worker", "codex");
    expect(db.prepare(`
      SELECT provider_failover_original_session_id, provider_failover_redispatched_session_id
      FROM tasks WHERE id = 'failed'
    `).get()).toEqual({
      provider_failover_original_session_id: "session-claude",
      provider_failover_redispatched_session_id: "session-codex",
    });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'same-goal-next'").get())
      .toEqual({ status: "todo" });
  });

  it.each([
    { from: "claude", to: "codex" },
    { from: "codex", to: "claude" },
  ] as const)(
    "$from→$to failover가 동일 task를 대체 provider로 재디스패치한다",
    async ({ from, to }) => {
      seedAgent("worker");
      db.prepare("UPDATE agents SET provider = ? WHERE id = 'worker'").run(from);
      seedGoal("failed-goal", 0);
      seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });

      let attempt = 0;
      runtime.executeTask.mockImplementation(async (taskId: string) => {
        attempt++;
        const provider = attempt === 1 ? from : to;
        db.prepare(`
          INSERT INTO sessions (id, agent_id, status, provider, task_id)
          VALUES (?, 'worker', ?, ?, ?)
        `).run(`session-${attempt}`, attempt === 1 ? "failed" : "active", provider, taskId);
        if (attempt === 1) {
          db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
          throw new Error("rate limit reached");
        }
        return new Promise(() => {});
      });

      scheduler.startQueue(projectId);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(runtime.executeTask).toHaveBeenCalledTimes(2);
      expect(sessionManager.setProviderOverride).toHaveBeenCalledWith("worker", to);
      expect(db.prepare(`
        SELECT provider_failover_from_provider, provider_failover_to_provider,
               provider_failover_original_session_id, provider_failover_redispatched_session_id
        FROM tasks WHERE id = 'failed'
      `).get()).toEqual({
        provider_failover_from_provider: from,
        provider_failover_to_provider: to,
        provider_failover_original_session_id: "session-1",
        provider_failover_redispatched_session_id: "session-2",
      });
    },
  );

  it("evaluator provider 실패는 evaluator sessionKey로 대체 backend를 재디스패치한다", async () => {
    seedAgent("worker");
    seedAgent("reviewer", "reviewer");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });

    let attempt = 0;
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      attempt++;
      if (attempt === 1) {
        db.prepare(`
          INSERT INTO sessions (id, agent_id, status, provider, task_id)
          VALUES ('evaluator-claude', 'reviewer', 'failed', 'claude', ?)
        `).run(taskId);
        db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
        throw new Error("rate limit reached");
      }
      db.prepare(`
        INSERT INTO sessions (id, agent_id, status, provider, task_id)
        VALUES ('evaluator-codex', 'reviewer', 'active', 'codex', ?)
      `).run(taskId);
      return new Promise(() => {});
    });

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sessionManager.setProviderOverride).toHaveBeenCalledWith("evaluator-failed", "codex");
    expect(sessionManager.setProviderOverride).not.toHaveBeenCalledWith("worker", "codex");
    expect(db.prepare(`
      SELECT provider_failover_original_session_id, provider_failover_redispatched_session_id
      FROM tasks WHERE id = 'failed'
    `).get()).toEqual({
      provider_failover_original_session_id: "evaluator-claude",
      provider_failover_redispatched_session_id: "evaluator-codex",
    });
  });

  it("재시작 후에도 evaluator 원본 session에서 evaluator failover key를 복원한다", async () => {
    seedAgent("worker");
    seedAgent("reviewer", "reviewer");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });
    db.prepare(`
      INSERT INTO sessions (id, agent_id, status, provider, task_id)
      VALUES ('evaluator-claude', 'reviewer', 'failed', 'claude', 'failed')
    `).run();
    db.prepare(`
      UPDATE tasks SET
        provider_failover_original_session_id = 'evaluator-claude',
        provider_failover_to_provider = 'codex',
        provider_failover_redispatched = 1
      WHERE id = 'failed'
    `).run();
    runtime.executeTask.mockImplementation(() => new Promise(() => {}));

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(1);

    expect(sessionManager.setProviderOverride).toHaveBeenCalledWith("evaluator-failed", "codex");
    expect(runtime.executeTask).toHaveBeenCalledWith("failed", {}, expect.objectContaining({ claimed: true }));
  });

  it("failover 예약과 재디스패치 재실행 사이에 낀 무관한 codex 세션을 재디스패치 세션으로 오귀속하지 않는다", async () => {
    seedAgent("worker");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });

    let attempt = 0;
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      attempt++;
      if (attempt === 1) {
        db.prepare(
          "INSERT INTO sessions (id, agent_id, status, provider, task_id) VALUES ('session-claude', 'worker', 'failed', 'claude', ?)",
        ).run(taskId);
        db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
        throw new Error("rate limit reached");
      }
      // 실제 재디스패치 재실행만이 이 태스크의 새 codex 세션을 만든다(task_id가 찍힌다).
      db.prepare(
        "INSERT INTO sessions (id, agent_id, status, provider, task_id) VALUES ('redispatch-codex', 'worker', 'active', 'codex', ?)",
      ).run(taskId);
      return new Promise(() => {});
    });

    scheduler.startQueue(projectId);
    // attempt 1 (claude) 실패 → codex failover 예약. 아직 재디스패치 재실행 전.
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toBe(1);
    // failover 예약과 재디스패치 재실행 사이에 같은 agent의 무관한 codex 세션이 끼어든다
    // (다른 실행 경로가 만든 세션). failed 세션 이후 rowid라 boundary heuristic에 걸린다.
    db.prepare(
      "INSERT INTO sessions (id, agent_id, status, provider) VALUES ('unrelated-codex', 'worker', 'completed', 'codex')",
    ).run();
    await vi.advanceTimersByTimeAsync(3_000);

    // 무관한 'unrelated-codex'가 아니라 재실행이 만든 'redispatch-codex'만 연결돼야 한다.
    expect(db.prepare(`
      SELECT provider_failover_redispatched_session_id FROM tasks WHERE id = 'failed'
    `).get()).toEqual({ provider_failover_redispatched_session_id: "redispatch-codex" });
  });

  it("재실행 boundary 이후 무관한 codex 세션이 실제 재디스패치 세션보다 먼저 생겨도 task_id로 실제 세션만 연결한다", async () => {
    seedAgent("worker");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });

    let attempt = 0;
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      attempt++;
      if (attempt === 1) {
        db.prepare(
          "INSERT INTO sessions (id, agent_id, status, provider, task_id) VALUES ('session-claude', 'worker', 'failed', 'claude', 'failed')",
        ).run();
        db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
        throw new Error("rate limit reached");
      }
      // 재실행 boundary는 이미 executeOne 시작 시 고정됐다. 그 이후, 실제 task 세션
      // spawn 전에 같은 agent+provider의 무관한 세션이 먼저 끼어든다(rowid ASC로 첫 후보).
      db.prepare(
        "INSERT INTO sessions (id, agent_id, status, provider, task_id) VALUES ('unrelated-codex', 'worker', 'completed', 'codex', NULL)",
      ).run();
      // 실제 재디스패치 세션 — 이 task를 위해 spawn되어 task_id가 찍힌다.
      db.prepare(
        "INSERT INTO sessions (id, agent_id, status, provider, task_id) VALUES ('redispatch-codex', 'worker', 'active', 'codex', ?)",
      ).run(taskId);
      return new Promise(() => {});
    });

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(3_000);

    // rowid ASC 첫 후보인 'unrelated-codex'가 아니라, task_id가 일치하는 'redispatch-codex'만 연결돼야 한다.
    expect(db.prepare(`
      SELECT provider_failover_redispatched_session_id FROM tasks WHERE id = 'failed'
    `).get()).toEqual({ provider_failover_redispatched_session_id: "redispatch-codex" });
  });

  it("spawn 전 failover는 과거 session을 원본으로 오인하지 않고 새 session만 연결한다", async () => {
    seedAgent("worker");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });
    db.prepare(
      "INSERT INTO sessions (id, agent_id, status, provider) VALUES ('old-session', 'worker', 'completed', 'codex')",
    ).run();

    let attempt = 0;
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      attempt++;
      if (attempt === 1) {
        db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
        throw new Error("spawn ENOENT: claude not installed");
      }
      db.prepare(
        "INSERT INTO sessions (id, agent_id, status, provider, task_id) VALUES ('new-session', 'worker', 'active', 'codex', ?)",
      ).run(taskId);
      return new Promise(() => {});
    });

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(runtime.executeTask.mock.calls.map(([taskId]) => taskId)).toEqual(["failed", "failed"]);
    expect(db.prepare(`
      SELECT provider_failover_original_session_id, provider_failover_redispatched_session_id
      FROM tasks WHERE id = 'failed'
    `).get()).toEqual({
      provider_failover_original_session_id: null,
      provider_failover_redispatched_session_id: "new-session",
    });
    expect(db.prepare(`
      SELECT provider_failover_original_session_id, provider_failover_redispatched_session_id
      FROM sessions WHERE id = 'old-session'
    `).get()).toEqual({
      provider_failover_original_session_id: null,
      provider_failover_redispatched_session_id: null,
    });
  });

  it("spawn 전 실패 뒤 끼어든 같은 agent의 무관한 session을 원본으로 선택하지 않는다", async () => {
    seedAgent("worker");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });

    let attempt = 0;
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      attempt++;
      if (attempt === 1) {
        db.prepare(
          "INSERT INTO sessions (id, agent_id, status, provider) VALUES ('unrelated', 'worker', 'completed', 'codex')",
        ).run();
        db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
        throw new Error("spawn ENOENT: claude not installed");
      }
      db.prepare(
        "INSERT INTO sessions (id, agent_id, status, provider, task_id) VALUES ('new-session', 'worker', 'active', 'codex', ?)",
      ).run(taskId);
      return new Promise(() => {});
    });

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sessionManager.setProviderOverride).toHaveBeenCalledWith("worker", "codex");
    expect(db.prepare(`
      SELECT provider_failover_from_provider, provider_failover_to_provider,
             provider_failover_original_session_id, provider_failover_redispatched_session_id
      FROM tasks WHERE id = 'failed'
    `).get()).toEqual({
      provider_failover_from_provider: "claude",
      provider_failover_to_provider: "codex",
      provider_failover_original_session_id: null,
      provider_failover_redispatched_session_id: "new-session",
    });
    expect(db.prepare(`
      SELECT provider_failover_original_session_id, provider_failover_redispatched_session_id
      FROM sessions WHERE id = 'unrelated'
    `).get()).toEqual({
      provider_failover_original_session_id: null,
      provider_failover_redispatched_session_id: null,
    });
  });

  it("task failure callback과 다음 poll 경쟁에서 retry budget을 한 번만 소비한다", async () => {
    seedAgent("worker");
    seedAgent("next-agent");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });
    seedTask({ id: "same-goal-next", goalId: "failed-goal", agentId: "next-agent", sortOrder: 1 });

    let attempt = 0;
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      attempt++;
      if (attempt === 1) {
        db.prepare(
          `UPDATE tasks SET status = 'blocked',
             started_at = datetime('now', '-1 day'),
             updated_at = datetime('now', '-1 day')
           WHERE id = ?`,
        ).run(taskId);
        throw new Error("implementation failed");
      }
      return new Promise(() => {});
    });

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runtime.executeTask.mock.calls.map(([taskId]) => taskId)).toEqual(["failed", "failed"]);
    expect(db.prepare("SELECT status, retry_count FROM tasks WHERE id = 'failed'").get())
      .toEqual({ status: "in_progress", retry_count: 1 });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'same-goal-next'").get())
      .toEqual({ status: "todo" });
  });

  it("양쪽 provider가 연속 실패해도 왕복 재디스패치와 중복 실행을 막고 사유를 남긴다", async () => {
    seedAgent("worker");
    seedGoal("failed-goal", 0);
    seedTask({ id: "failed", goalId: "failed-goal", agentId: "worker" });

    let attempt = 0;
    runtime.executeTask.mockImplementation(async (taskId: string) => {
      attempt++;
      const provider = attempt === 1 ? "claude" : "codex";
      db.prepare(`
        INSERT INTO sessions (id, agent_id, status, provider, task_id)
        VALUES (?, 'worker', 'failed', ?, ?)
      `).run(`session-${provider}`, provider, taskId);
      db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(taskId);
      throw new Error("rate limit reached");
    });

    scheduler.startQueue(projectId);
    scheduler.notifyGoalReady(projectId);
    scheduler.notifyGoalReady(projectId);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(runtime.executeTask.mock.calls.map(([taskId]) => taskId))
      .toEqual(["failed", "failed"]);
    expect(sessionManager.setProviderOverride).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sessionManager.setProviderOverride).mock.calls)
      .toEqual([["worker", "codex"], ["worker", "codex"]]);
    expect(db.prepare(`
      SELECT provider_failover_redispatched, provider_failover_loop_guard_blocked,
             provider_failover_original_session_id, provider_failover_redispatched_session_id
      FROM tasks WHERE id = 'failed'
    `).get()).toEqual({
      provider_failover_redispatched: 1,
      provider_failover_loop_guard_blocked: 1,
      provider_failover_original_session_id: "session-claude",
      provider_failover_redispatched_session_id: "session-codex",
    });
    const decisions = db.prepare(`
      SELECT message, metadata FROM activities
      WHERE project_id = ? AND type = 'provider_failover_decision'
      ORDER BY id
    `).all(projectId) as Array<{ message: string; metadata: string }>;
    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.message).toContain("왕복 방지를 위해 추가 전환을 차단했습니다");
    expect(JSON.parse(decisions[1]!.metadata)).toMatchObject({
      fromProvider: "codex",
      toProvider: "claude",
      redispatched: false,
      loopGuardBlocked: true,
    });
  });
});
