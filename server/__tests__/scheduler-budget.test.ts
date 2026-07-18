import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createProjectRoutes } from "../api/routes/projects.js";
import { createDatabase, migrate } from "../db/schema.js";

const runtime = vi.hoisted(() => ({
  executeTask: vi.fn(),
  decomposeGoal: vi.fn(),
  applyPlanReviewGate: vi.fn(),
  generateGoalsFromMission: vi.fn(),
  budget: undefined as {
    tokenLimit: number | null;
    timeLimitMs: number | null;
    warnPct: number;
  } | undefined,
}));

vi.mock("../core/orchestration/engine.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createOrchestrationEngine: () => ({
      executeTask: runtime.executeTask,
      decomposeGoal: runtime.decomposeGoal,
      applyPlanReviewGate: runtime.applyPlanReviewGate,
      generateGoalsFromMission: runtime.generateGoalsFromMission,
    }),
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
      budget: runtime.budget,
    }),
  };
});

import { createScheduler } from "../core/orchestration/scheduler.js";

describe("scheduler global daily budget gate", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  const broadcast = vi.fn();
  const projectId = "budget-project";

  beforeEach(() => {
    vi.useFakeTimers();
    runtime.executeTask.mockReset();
    runtime.executeTask.mockImplementation(() => new Promise(() => {}));
    runtime.decomposeGoal.mockReset();
    runtime.decomposeGoal.mockResolvedValue({ taskCount: 1, projectId });
    runtime.applyPlanReviewGate.mockReset();
    runtime.applyPlanReviewGate.mockResolvedValue(undefined);
    runtime.generateGoalsFromMission.mockReset();
    runtime.budget = undefined;
    broadcast.mockReset();

    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source) VALUES (?, 'Budget project', 'new')").run(projectId);
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('usage-project', 'Usage project', 'new')").run();
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role) VALUES ('budget-agent', ?, 'Builder', 'backend')",
    ).run(projectId);
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role) VALUES ('usage-agent', 'usage-project', 'Usage', 'backend')",
    ).run();
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description) VALUES ('budget-goal', ?, 'Goal', 'Budget gate')",
    ).run(projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id)
      VALUES ('budget-task', 'budget-goal', ?, 'Task', 'todo', 'budget-agent')
    `).run(projectId);

    const sessionManager = {
      spawnAgent: vi.fn(),
      getSession: vi.fn(() => undefined),
      getSessionRecord: vi.fn(() => undefined),
      killSession: vi.fn(),
      killAll: vi.fn(),
      pauseSession: vi.fn(),
      resumeSession: vi.fn(),
      setProviderOverride: vi.fn(),
      clearProviderOverride: vi.fn(),
    } as unknown as SessionManager;
    scheduler = createScheduler(db, sessionManager, broadcast);
  });

  afterEach(() => {
    scheduler.stopQueue(projectId);
    db.close();
    vi.useRealTimers();
  });

  function seedUsage(input: { tokens?: number; activeMs?: number }): void {
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, status, token_usage, started_at, ended_at
      ) VALUES (
        'usage-session', 'usage-agent', 'completed', ?,
        datetime('now', ?), datetime('now')
      )
    `).run(input.tokens ?? 0, `-${(input.activeMs ?? 1) / 1000} seconds`);
  }

  async function startAndPoll(): Promise<void> {
    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(1);
  }

  function patchProject(body: Record<string, unknown>): void {
    const router = createProjectRoutes({
      db,
      broadcast,
      scheduler,
      orchestrationEngine: {
        decomposeGoal: runtime.decomposeGoal,
        applyPlanReviewGate: runtime.applyPlanReviewGate,
        generateGoalsFromMission: runtime.generateGoalsFromMission,
        executeTask: runtime.executeTask,
      },
    } as any) as any;
    const layer = router.stack.find(
      (candidate: any) => candidate.route?.path === "/:id" && candidate.route.methods.patch,
    );
    const response = {
      status: vi.fn(function status(this: unknown) { return this; }),
      json: vi.fn(function json(this: unknown) { return this; }),
    };
    layer.route.stack[0].handle({ params: { id: projectId }, body }, response);
    expect(response.status).not.toHaveBeenCalled();
  }

  it("pauses without dispatch when global today token usage exceeds tokenLimit", async () => {
    runtime.budget = { tokenLimit: 100, timeLimitMs: null, warnPct: 0.8 };
    seedUsage({ tokens: 101 });

    await startAndPoll();

    expect(runtime.executeTask).not.toHaveBeenCalled();
    expect(scheduler.isPaused(projectId)).toBe(true);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'budget-task'").get())
      .toEqual({ status: "todo" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE project_id = ? AND metadata LIKE '%"event":"budget:paused"%'
    `).get(projectId)).toEqual({ count: 1 });
    expect(broadcast).toHaveBeenCalledWith(
      "queue:paused",
      expect.objectContaining({ projectId, reason: "budget_limit" }),
    );
  });

  it("keeps dispatching when both limits are null", async () => {
    runtime.budget = { tokenLimit: null, timeLimitMs: null, warnPct: 0.8 };
    seedUsage({ tokens: 1_000_000, activeMs: 60_000 });

    await startAndPoll();

    expect(runtime.executeTask).toHaveBeenCalledWith("budget-task", {}, expect.any(Object));
    expect(scheduler.isPaused(projectId)).toBe(false);
  });

  it("records the warnPct activity only once per project and UTC day", async () => {
    runtime.budget = { tokenLimit: 100, timeLimitMs: null, warnPct: 0.8 };
    seedUsage({ tokens: 80 });

    await startAndPoll();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(scheduler.isPaused(projectId)).toBe(false);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE project_id = ? AND metadata LIKE '%"event":"budget:warning"%'
    `).get(projectId)).toEqual({ count: 1 });
  });

  it("pauses when global today session activity reaches timeLimitMs", async () => {
    runtime.budget = { tokenLimit: null, timeLimitMs: 1_000, warnPct: 0.8 };
    seedUsage({ activeMs: 2_000 });

    await startAndPoll();

    expect(runtime.executeTask).not.toHaveBeenCalled();
    expect(scheduler.isPaused(projectId)).toBe(true);
  });

  it("blocks decompose when budget is exceeded while goal spec generation is in flight", async () => {
    runtime.budget = { tokenLimit: 100, timeLimitMs: null, warnPct: 0.8 };
    db.prepare("UPDATE projects SET autopilot = 'goal' WHERE id = ?").run(projectId);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'budget-task'").run();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description)
      VALUES ('prep-goal', ?, 'Prep goal', 'Prep goal')
    `).run(projectId);
    let finishSpec!: () => void;
    const generateGoalSpec = vi.fn(() => new Promise<void>((resolve) => {
      finishSpec = resolve;
    }));
    scheduler.setSpecGenerator(generateGoalSpec);

    await startAndPoll();
    expect(generateGoalSpec).toHaveBeenCalledWith("prep-goal");

    seedUsage({ tokens: 101 });
    finishSpec();
    await vi.advanceTimersByTimeAsync(1);

    expect(runtime.decomposeGoal).not.toHaveBeenCalled();
    expect(scheduler.isPaused(projectId)).toBe(true);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE project_id = ? AND metadata LIKE '%"event":"budget:paused"%'
    `).get(projectId)).toEqual({ count: 1 });
  });

  it("blocks plan review when budget is exceeded while decompose is in flight", async () => {
    runtime.budget = { tokenLimit: 100, timeLimitMs: null, warnPct: 0.8 };
    db.prepare("UPDATE projects SET autopilot = 'goal' WHERE id = ?").run(projectId);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'budget-task'").run();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description)
      VALUES ('review-goal', ?, 'Review goal', 'Review goal')
    `).run(projectId);
    db.prepare(`
      INSERT INTO goal_specs (
        goal_id, prd_summary, feature_specs, user_flow,
        acceptance_criteria, tech_considerations, generated_by
      ) VALUES ('review-goal', 'ready', '[]', '[]', '[]', '[]', 'ai')
    `).run();
    let finishDecompose!: (value: { taskCount: number; projectId: string }) => void;
    runtime.decomposeGoal.mockReturnValueOnce(new Promise((resolve) => {
      finishDecompose = resolve;
    }));

    await startAndPoll();
    expect(runtime.decomposeGoal).toHaveBeenCalledWith("review-goal");

    seedUsage({ tokens: 101 });
    finishDecompose({ taskCount: 1, projectId });
    await vi.advanceTimersByTimeAsync(1);

    expect(runtime.applyPlanReviewGate).not.toHaveBeenCalled();
    expect(scheduler.isPaused(projectId)).toBe(true);
  });

  it("blocks full autopilot mission generation when the daily budget is exceeded", () => {
    runtime.budget = { tokenLimit: 100, timeLimitMs: null, warnPct: 0.8 };
    seedUsage({ tokens: 101 });
    db.prepare("UPDATE projects SET mission = 'Ship it' WHERE id = ?").run(projectId);
    db.prepare("UPDATE goals SET progress = 100 WHERE project_id = ?").run(projectId);
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role) VALUES ('budget-cto', ?, 'CTO', 'cto')",
    ).run(projectId);

    patchProject({ autopilot: "full" });

    expect(runtime.generateGoalsFromMission).not.toHaveBeenCalled();
    expect(scheduler.isPaused(projectId)).toBe(true);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE project_id = ? AND metadata LIKE '%"event":"budget:paused"%'
    `).get(projectId)).toEqual({ count: 1 });
  });

  it("keeps full autopilot mission generation enabled when both limits are null", () => {
    runtime.budget = { tokenLimit: null, timeLimitMs: null, warnPct: 0.8 };
    db.prepare("UPDATE projects SET mission = 'Ship it' WHERE id = ?").run(projectId);
    db.prepare("UPDATE goals SET progress = 100 WHERE project_id = ?").run(projectId);
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role) VALUES ('budget-cto', ?, 'CTO', 'cto')",
    ).run(projectId);
    runtime.generateGoalsFromMission.mockReturnValue(new Promise(() => {}));

    patchProject({ autopilot: "full" });

    expect(runtime.generateGoalsFromMission).toHaveBeenCalledWith(projectId);
    expect(scheduler.isPaused(projectId)).toBe(false);
  });
});
