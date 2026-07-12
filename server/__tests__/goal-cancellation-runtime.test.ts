import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { createQualityGate } from "../core/quality-gate/evaluator.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import type { SessionManager } from "../core/agent/session.js";
import { createAgentHandoff } from "../core/agent/handoff.js";
import { saveAgentHandoff } from "../core/agent/handoff-store.js";

function createSessionManager(session: EventEmitter & { id: string; send: ReturnType<typeof vi.fn> }): SessionManager {
  return {
    spawnAgent: vi.fn(() => session),
    getSession: vi.fn(() => session),
    getSessionRecord: vi.fn(() => undefined),
    killSession: vi.fn(),
    killAll: vi.fn(),
    pauseSession: vi.fn(),
    resumeSession: vi.fn(),
    setProviderOverride: vi.fn(),
    clearProviderOverride: vi.fn(),
  } as unknown as SessionManager;
}

function seedRuntimeTask(role = "backend") {
  const db = createDatabase(":memory:");
  migrate(db);
  db.prepare(
    "INSERT INTO projects (id, name, source, workdir) VALUES ('project-cancel', 'test', 'new', ?)",
  ).run(process.cwd());
  db.prepare(
    "INSERT INTO agents (id, project_id, name, role, needs_worktree) VALUES ('agent-cancel', 'project-cancel', 'worker', ?, 0)",
  ).run(role);
  db.prepare(
    "INSERT INTO goals (id, project_id, description) VALUES ('goal-cancel', 'project-cancel', 'goal')",
  ).run();
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, description, status, assignee_id) VALUES ('task-cancel', 'goal-cancel', 'project-cancel', 'simple task', 'simple', 'todo', 'agent-cancel')",
  ).run();
  db.prepare(
    "INSERT INTO sessions (id, agent_id, task_id, status) VALUES ('decompose-cancel', 'agent-cancel', NULL, 'completed')",
  ).run();
  saveAgentHandoff(db, {
    goalId: "goal-cancel",
    taskId: null,
    sessionId: "decompose-cancel",
    handoff: createAgentHandoff({ stage: "decompose" }),
  });
  return db;
}

describe("goal cancellation runtime boundaries", () => {
  it("Evaluator 응답 대기 중 task가 삭제되면 parse retry와 verification 저장을 중단한다", async () => {
    const db = seedRuntimeTask();
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role, needs_worktree) VALUES ('reviewer-cancel', 'project-cancel', 'reviewer', 'reviewer', 0)",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, agent_id, task_id, status) VALUES ('implementation-cancel', 'agent-cancel', 'task-cancel', 'completed')",
    ).run();
    saveAgentHandoff(db, {
      goalId: "goal-cancel",
      taskId: "task-cancel",
      sessionId: "implementation-cancel",
      handoff: createAgentHandoff({ stage: "implementation" }),
    });

    const session = new EventEmitter() as EventEmitter & { id: string; send: ReturnType<typeof vi.fn> };
    session.id = "evaluator-runtime";
    const sessionManager = createSessionManager(session);
    session.send = vi.fn(async () => {
      db.prepare("DELETE FROM goals WHERE id = 'goal-cancel'").run();
      sessionManager.killSession("evaluator-task-cancel");
      return { stdout: "", stderr: "", exitCode: 143, provider: "claude" };
    });

    const qualityGate = createQualityGate(db, sessionManager);
    await expect(qualityGate.verify("task-cancel", { workdir: process.cwd() }))
      .rejects.toThrow("deleted during verification");

    expect(session.send).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM verifications").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("cancelGoal은 settle되지 않은 send와 무관하게 busy agent lane을 즉시 해제한다", async () => {
    const db = seedRuntimeTask("reviewer");
    let notifySendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { notifySendStarted = resolve; });
    const session = new EventEmitter() as EventEmitter & { id: string; send: ReturnType<typeof vi.fn> };
    session.id = "worker-runtime";
    session.send = vi.fn(() => {
      notifySendStarted();
      return new Promise(() => {});
    });
    const sessionManager = createSessionManager(session);
    const scheduler = createScheduler(db, sessionManager, () => {});

    scheduler.startQueue("project-cancel");
    await Promise.race([
      sendStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("session did not start")), 2_000)),
    ]);
    expect(scheduler.getQueueState("project-cancel").activeTasks).toBe(1);

    db.prepare("DELETE FROM goals WHERE id = 'goal-cancel'").run();
    scheduler.cancelGoal("project-cancel", "goal-cancel", ["task-cancel"]);

    expect(scheduler.getQueueState("project-cancel").activeTasks).toBe(0);
    scheduler.stopQueue("project-cancel");
    db.close();
  });
});
