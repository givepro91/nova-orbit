import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../agent/session.js";
import { createDatabase, migrate } from "../../db/schema.js";
import { createScheduler, markProviderFailoverLoopGuardBlocked } from "./scheduler.js";

describe("markProviderFailoverLoopGuardBlocked", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, mission, source) VALUES (?, ?, ?, ?)").run(
      "project-1",
      "Project",
      "",
      "new",
    );
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)").run(
      "agent-1",
      "project-1",
      "Backend",
      "backend",
    );
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES (?, ?, ?)").run(
      "goal-1",
      "project-1",
      "Goal",
    );
    db.prepare(
      `INSERT INTO tasks (
         id, goal_id, project_id, title, assignee_id,
         provider_failover_reason_code, provider_failover_user_message,
         provider_failover_from_provider, provider_failover_to_provider,
         provider_failover_redispatched,
         provider_failover_original_session_id, provider_failover_redispatched_session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-1",
      "goal-1",
      "project-1",
      "Task",
      "agent-1",
      "rate_limit",
      "claude 사용량 한도로 codex에 재디스패치했습니다.",
      "claude",
      "codex",
      1,
      "session-claude",
      "session-codex",
    );
    db.prepare(
      `INSERT INTO sessions (
         id, agent_id, status, provider,
         provider_failover_reason_code, provider_failover_user_message,
         provider_failover_from_provider, provider_failover_to_provider,
         provider_failover_redispatched,
         provider_failover_original_session_id, provider_failover_redispatched_session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "session-claude",
      "agent-1",
      "failed",
      "claude",
      "rate_limit",
      "claude 사용량 한도로 codex에 재디스패치했습니다.",
      "claude",
      "codex",
      1,
      "session-claude",
      "session-codex",
    );
    db.prepare("INSERT INTO sessions (id, agent_id, status, provider) VALUES (?, ?, ?, ?)").run(
      "session-codex",
      "agent-1",
      "failed",
      "codex",
    );
  });

  afterEach(() => {
    db.close();
  });

  it("marks the second failed session as loop-guard blocked without clearing the original redispatch trace", () => {
    markProviderFailoverLoopGuardBlocked(db, "task-1", "session-codex", {
      reasonCode: "rate_limit",
      userMessage: "codex 사용량 한도가 발생했지만 claude는 이미 이 태스크에서 시도되어 재디스패치하지 않았습니다.",
      fromProvider: "codex",
      toProvider: "claude",
      redispatched: false,
      loopGuardBlocked: true,
    });

    const task = db.prepare(
      `SELECT provider_failover_reason_code,
              provider_failover_user_message,
              provider_failover_from_provider,
              provider_failover_to_provider,
              provider_failover_redispatched,
              provider_failover_loop_guard_blocked,
              provider_failover_original_session_id,
              provider_failover_redispatched_session_id
       FROM tasks WHERE id = ?`,
    ).get("task-1") as Record<string, unknown>;
    expect(task).toMatchObject({
      provider_failover_reason_code: "rate_limit",
      provider_failover_user_message: "claude 사용량 한도로 codex에 재디스패치했습니다.",
      provider_failover_from_provider: "claude",
      provider_failover_to_provider: "codex",
      provider_failover_redispatched: 1,
      provider_failover_loop_guard_blocked: 1,
      provider_failover_original_session_id: "session-claude",
      provider_failover_redispatched_session_id: "session-codex",
    });

    const sessions = db.prepare(
      `SELECT id,
              provider_failover_reason_code,
              provider_failover_from_provider,
              provider_failover_to_provider,
              provider_failover_redispatched,
              provider_failover_loop_guard_blocked
       FROM sessions ORDER BY id`,
    ).all() as Record<string, unknown>[];
    expect(sessions).toEqual([
      {
        id: "session-claude",
        provider_failover_reason_code: "rate_limit",
        provider_failover_from_provider: "claude",
        provider_failover_to_provider: "codex",
        provider_failover_redispatched: 1,
        provider_failover_loop_guard_blocked: 0,
      },
      {
        id: "session-codex",
        provider_failover_reason_code: "rate_limit",
        provider_failover_from_provider: "codex",
        provider_failover_to_provider: "claude",
        provider_failover_redispatched: 0,
        provider_failover_loop_guard_blocked: 1,
      },
    ]);
  });
});

describe("scheduler DAG dependency gate", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  let spawnAgent: ReturnType<typeof vi.fn>;
  const projectId = "dependency-gate-project";

  beforeEach(() => {
    vi.useFakeTimers();
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source) VALUES (?, 'Project', 'new')").run(projectId);
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role) VALUES ('dependency-agent', ?, 'Builder', 'backend')",
    ).run(projectId);
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description) VALUES ('dependency-goal', ?, 'Goal', 'Dependency gate')",
    ).run(projectId);

    spawnAgent = vi.fn();
    const sessionManager = {
      spawnAgent,
      getSession: vi.fn(() => undefined),
      getSessionRecord: vi.fn(() => undefined),
      killSession: vi.fn(),
      killAll: vi.fn(),
      pauseSession: vi.fn(),
      resumeSession: vi.fn(),
      setProviderOverride: vi.fn(),
      clearProviderOverride: vi.fn(),
    } as unknown as SessionManager;
    scheduler = createScheduler(db, sessionManager, () => {});
  });

  afterEach(() => {
    scheduler.stopQueue(projectId);
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function pollTaskWithDependencies(dependsOn: string): Promise<string> {
    const taskId = "dependent-task";
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id, depends_on)
       VALUES (?, 'dependency-goal', ?, 'Dependent task', 'todo', 'dependency-agent', ?)`,
    ).run(taskId, projectId, dependsOn);

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(1);
    return taskId;
  }

  it("does not dispatch a task whose dependency id is dangling", async () => {
    const taskId = await pollTaskWithDependencies('["missing-task"]');

    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId))
      .toEqual({ status: "todo" });
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("does not dispatch a task whose depends_on JSON is corrupt", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const taskId = await pollTaskWithDependencies("not-json");

    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId))
      .toEqual({ status: "todo" });
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some(([message]) => String(message).includes("depends_on contains invalid JSON")))
      .toBe(true);
  });

  it.each([
    ["object", "{}"],
    ["string", '"x"'],
    ["array with a non-string element", "[123]"],
  ])("does not dispatch a task whose depends_on is a valid JSON %s", async (_label, dependsOn) => {
    const taskId = await pollTaskWithDependencies(dependsOn);

    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId))
      .toEqual({ status: "todo" });
    expect(spawnAgent).not.toHaveBeenCalled();
  });
});
