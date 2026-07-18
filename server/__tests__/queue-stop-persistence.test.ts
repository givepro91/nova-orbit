import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createOrchestrationRoutes } from "../api/routes/orchestration.js";
import { createProjectRoutes } from "../api/routes/projects.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createDatabase, migrate } from "../db/schema.js";
import { autoStartAutopilotQueues } from "../index.js";

const orchestrationRuntime = vi.hoisted(() => ({
  decomposeGoal: vi.fn(),
  applyPlanReviewGate: vi.fn(),
  executeTask: vi.fn(),
  generateGoalsFromMission: vi.fn(),
}));

vi.mock("../core/orchestration/engine.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createOrchestrationEngine: () => orchestrationRuntime,
  };
});

const databases: Database.Database[] = [];

function createTestDatabase(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  databases.push(db);
  return db;
}

function createSessionManager(): SessionManager {
  return {
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
}

function patchProject(router: any, projectId: string, body: Record<string, unknown>): unknown {
  const layer = router.stack.find(
    (candidate: any) => candidate.route?.path === "/:id" && candidate.route.methods.patch,
  );
  let status = 200;
  let responseBody: unknown;
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      responseBody = payload;
      return this;
    },
  };

  layer.route.stack[0].handle({ params: { id: projectId }, body }, response);
  expect(status).toBe(200);
  return responseBody;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fn of Object.values(orchestrationRuntime)) fn.mockReset();
});

describe("queue stop intent persistence", () => {
  it("adds queue_stopped to an existing projects table non-destructively and idempotently", () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mission TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL CHECK (source IN ('new', 'local_import', 'github')),
        workdir TEXT NOT NULL DEFAULT '',
        github_config TEXT,
        tech_stack TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'paused')),
        autopilot TEXT NOT NULL DEFAULT 'off' CHECK (autopilot IN ('off', 'goal', 'full')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO projects (id, name, source, autopilot)
      VALUES ('legacy-project', 'Legacy', 'new', 'goal');
    `);

    migrate(db);
    migrate(db);

    expect(db.prepare(
      "SELECT id, autopilot, queue_stopped FROM projects WHERE id = 'legacy-project'",
    ).get()).toEqual({ id: "legacy-project", autopilot: "goal", queue_stopped: 0 });
    expect((db.prepare("PRAGMA table_info(projects)").all() as { name: string }[])
      .filter((column) => column.name === "queue_stopped")).toHaveLength(1);
  });

  it("keeps a stopped goal queue stopped across scheduler recreation and startup auto-start", () => {
    vi.useFakeTimers();
    const db = createTestDatabase();
    const projectId = "stopped-autopilot-project";
    db.prepare(
      "INSERT INTO projects (id, name, source, autopilot) VALUES (?, 'Stopped', 'new', 'goal')",
    ).run(projectId);

    const schedulerBeforeRestart = createScheduler(db, createSessionManager(), () => {});
    schedulerBeforeRestart.stopQueue(projectId);
    expect(db.prepare(
      "SELECT autopilot, queue_stopped FROM projects WHERE id = ?",
    ).get(projectId)).toEqual({ autopilot: "goal", queue_stopped: 1 });

    const schedulerAfterRestart = createScheduler(db, createSessionManager(), () => {});
    autoStartAutopilotQueues(db, schedulerAfterRestart);

    expect(schedulerAfterRestart.isRunning(projectId)).toBe(false);
    expect(db.prepare(
      "SELECT autopilot, queue_stopped FROM projects WHERE id = ?",
    ).get(projectId)).toEqual({ autopilot: "goal", queue_stopped: 1 });

    schedulerAfterRestart.startQueue(projectId);
    expect(db.prepare("SELECT queue_stopped FROM projects WHERE id = ?").get(projectId))
      .toEqual({ queue_stopped: 0 });

    schedulerAfterRestart.stopQueue(projectId);
    expect(db.prepare("SELECT queue_stopped FROM projects WHERE id = ?").get(projectId))
      .toEqual({ queue_stopped: 1 });

    schedulerAfterRestart.resumeQueue(projectId);
    expect(db.prepare("SELECT queue_stopped FROM projects WHERE id = ?").get(projectId))
      .toEqual({ queue_stopped: 0 });
  });

  it("does not persist an automatic no-work queue stop as user intent", async () => {
    vi.useFakeTimers();
    const db = createTestDatabase();
    const projectId = "auto-stopped-project";
    db.prepare(
      "INSERT INTO projects (id, name, source, autopilot) VALUES (?, 'Auto stopped', 'new', 'goal')",
    ).run(projectId);
    const scheduler = createScheduler(db, createSessionManager(), () => {});

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(1);

    expect(scheduler.isRunning(projectId)).toBe(false);
    expect(db.prepare("SELECT queue_stopped FROM projects WHERE id = ?").get(projectId))
      .toEqual({ queue_stopped: 0 });
  });

  it("preserves a stopped goal queue across same-mode and unrelated project patches", () => {
    vi.useFakeTimers();
    const db = createTestDatabase();
    const projectId = "same-mode-stopped-project";
    db.prepare(`
      INSERT INTO projects (id, name, mission, source, autopilot, queue_stopped)
      VALUES (?, 'Autopilot', 'Ship the project', 'new', 'goal', 1)
    `).run(projectId);
    const scheduler = createScheduler(db, createSessionManager(), () => {});
    const router = createProjectRoutes({
      db,
      broadcast: vi.fn(),
      scheduler,
      sessionManager: createSessionManager(),
    } as any) as any;

    patchProject(router, projectId, { autopilot: "goal" });
    patchProject(router, projectId, { name: "Renamed" });

    expect(db.prepare("SELECT autopilot, queue_stopped FROM projects WHERE id = ?").get(projectId))
      .toEqual({ autopilot: "goal", queue_stopped: 1 });
    expect(scheduler.isRunning(projectId)).toBe(false);

    const schedulerAfterRestart = createScheduler(db, createSessionManager(), () => {});
    autoStartAutopilotQueues(db, schedulerAfterRestart);
    expect(schedulerAfterRestart.isRunning(projectId)).toBe(false);
    expect(db.prepare("SELECT queue_stopped FROM projects WHERE id = ?").get(projectId))
      .toEqual({ queue_stopped: 1 });
  });

  it("does not restart a queue stopped while route decompose is in flight", async () => {
    const db = createTestDatabase();
    const projectId = "decompose-stop-project";
    const goalId = "decompose-stop-goal";
    db.prepare(
      "INSERT INTO projects (id, name, source, autopilot) VALUES (?, 'Stopped', 'new', 'goal')",
    ).run(projectId);
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description) VALUES (?, ?, 'Goal', 'Goal')",
    ).run(goalId, projectId);

    let finishDecompose!: (value: { taskCount: number; projectId: string }) => void;
    orchestrationRuntime.decomposeGoal.mockReturnValueOnce(new Promise((resolve) => {
      finishDecompose = resolve;
    }));
    orchestrationRuntime.applyPlanReviewGate.mockResolvedValueOnce(undefined);

    const ctx = { db, broadcast: vi.fn() } as any;
    const router = createOrchestrationRoutes(ctx) as any;
    const layer = router.stack.find(
      (candidate: any) => candidate.route?.path === "/goals/:goalId/decompose",
    );
    const response = {
      status: vi.fn(function status(this: unknown) { return this; }),
      json: vi.fn(function json(this: unknown) { return this; }),
    };

    layer.route.stack[0].handle({ params: { goalId }, body: {} }, response);
    expect(response.status).toHaveBeenCalledWith(202);

    ctx.scheduler.stopQueue(projectId);
    finishDecompose({ taskCount: 1, projectId });
    await vi.waitFor(() => expect(orchestrationRuntime.applyPlanReviewGate).toHaveBeenCalled());

    expect(ctx.scheduler.isRunning(projectId)).toBe(false);
    expect(db.prepare("SELECT queue_stopped FROM projects WHERE id = ?").get(projectId))
      .toEqual({ queue_stopped: 1 });
  });
});
