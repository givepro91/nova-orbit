import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createGoalRoutes } from "../api/routes/goals.js";
import { createOrchestrationRoutes } from "../api/routes/orchestration.js";
import { createTaskRoutes } from "../api/routes/tasks.js";
import { saveSpecDraft } from "../core/goal-spec/spec-approval.js";
import { createDatabase, migrate } from "../db/schema.js";

const dbs: Database.Database[] = [];
const servers: Server[] = [];

async function fixture() {
  const db = createDatabase(":memory:");
  migrate(db);
  dbs.push(db);
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Project', 'new')").run();
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Builder', 'coder')").run();
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a2', 'p1', 'Reviewer', 'reviewer')").run();
  db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Ship graph', 'Editable execution plan')").run();
  db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g2', 'p1', 'Other', 'Other goal')").run();
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status, sort_order, depends_on) VALUES ('t1', 'g1', 'p1', 'Contract', 'a1', 'done', 0, '[]')").run();
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status, sort_order, depends_on) VALUES ('t2', 'g1', 'p1', 'UI', 'a1', 'todo', 1, '[\"t1\"]')").run();
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES ('t3', 'g1', 'p1', 'QA', 'todo', 2, '[\"t2\"]')").run();
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES ('other', 'g2', 'p1', 'Other task', 'todo', 0, '[]')").run();
  saveSpecDraft(db, "g1", {
    scope: "Expose and edit the execution graph",
    out_of_scope: "Visual canvas",
    acceptance_criteria: ["Same task rows power scheduler and editor"],
    expected_tasks: ["Contract", "UI", "QA"],
    verification_methods: ["Route tests"],
  });

  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  const app = express();
  app.use(express.json());
  app.use("/api/tasks", createTaskRoutes({
    db,
    broadcast: (type: string, payload: unknown) => broadcasts.push({ type, payload }),
    scheduler: { isRunning: () => false, startQueue: () => undefined },
  } as any));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { db, broadcasts, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function json(baseUrl: string, path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  return { response, body: await response.json() as any };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  for (const db of dbs.splice(0)) db.close();
});

describe("task graph routes", () => {
  it("projects the goal blueprint and scheduler readiness from the task SoT", async () => {
    const { baseUrl } = await fixture();

    const { response, body } = await json(baseUrl, "/api/tasks/graph/g1");

    expect(response.status).toBe(200);
    expect(body.goal).toMatchObject({ id: "g1", title: "Ship graph", description: "Editable execution plan" });
    expect(body.plan).toMatchObject({ scope: "Expose and edit the execution graph", expected_tasks: ["Contract", "UI", "QA"] });
    expect(body.tasks).toEqual([
      expect.objectContaining({ id: "t1", depends_on: [], blocked_by: [], execution_state: "complete" }),
      expect.objectContaining({ id: "t2", depends_on: ["t1"], blocked_by: [], execution_state: "ready" }),
      expect.objectContaining({ id: "t3", depends_on: ["t2"], blocked_by: ["t2"], execution_state: "blocked" }),
    ]);
  });

  it("atomically persists graph edits and broadcasts the same task rows", async () => {
    const { baseUrl, db, broadcasts } = await fixture();

    const { response, body } = await json(baseUrl, "/api/tasks/graph/g1", {
      method: "PATCH",
      body: JSON.stringify({ tasks: [
        { id: "t2", title: "Build UI", description: "Editor", assignee_id: "a2", sort_order: 2, depends_on: ["t1"] },
        { id: "t3", title: "Run QA", description: "Regression", assignee_id: "a2", sort_order: 1, depends_on: ["t1"] },
      ] }),
    });

    expect(response.status).toBe(200);
    expect(body.tasks.map((task: any) => task.id)).toEqual(["t1", "t3", "t2"]);
    expect(body.tasks.find((task: any) => task.id === "t3")).toMatchObject({
      title: "Run QA", assignee_id: "a2", depends_on: ["t1"], execution_state: "ready",
    });
    expect(db.prepare("SELECT title, assignee_id, sort_order, depends_on FROM tasks WHERE id = 't3'").get())
      .toEqual({ title: "Run QA", assignee_id: "a2", sort_order: 1, depends_on: '["t1"]' });
    expect(broadcasts.filter((event) => event.type === "task:updated")).toHaveLength(2);
  });

  it.each([
    [{ id: "t2", depends_on: ["t2"] }, 400, "cannot depend on itself"],
    [{ id: "t1", depends_on: ["t3"] }, 400, "Dependency cycle detected"],
    [{ id: "t2", depends_on: ["other"] }, 400, "belongs to another goal"],
    [{ id: "t2", depends_on: ["missing"] }, 404, "Dependency task not found"],
    [{ id: "t2", assignee_id: "missing" }, 404, "Assignee agent not found"],
    [{ id: "t2", status: "done" }, 400, "Cannot transition"],
    // skipped는 시스템 전용 terminal — 수동 API로 '전이 선언'은 계속 거부
    [{ id: "t2", status: "skipped" }, 400, "Invalid status"],
  ])("rejects invalid graph edit %#", async (edit, status, message) => {
    const { baseUrl, db } = await fixture();
    const before = db.prepare("SELECT depends_on, assignee_id, status FROM tasks WHERE id = 't2'").get();

    const result = await json(baseUrl, "/api/tasks/graph/g1", {
      method: "PATCH",
      body: JSON.stringify({ tasks: [edit] }),
    });

    expect(result.response.status).toBe(status);
    expect(result.body.error).toContain(message);
    expect(db.prepare("SELECT depends_on, assignee_id, status FROM tasks WHERE id = 't2'").get()).toEqual(before);
  });

  it("goal에 기존 skipped 태스크가 있어도 다른 태스크의 편집은 400 없이 통과한다", async () => {
    const { baseUrl, db } = await fixture();
    // 시스템(autoResolve)이 남긴 skipped 태스크 — 요청이 새로 선언한 값이 아니다
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES ('t-skip', 'g1', 'p1', 'Skipped one', 'skipped', 3, '[]')",
    ).run();

    const { response, body } = await json(baseUrl, "/api/tasks/graph/g1", {
      method: "PATCH",
      body: JSON.stringify({ tasks: [
        { id: "t2", title: "Renamed UI" },
      ] }),
    });

    expect(response.status).toBe(200);
    expect(body.tasks.find((task: any) => task.id === "t2")).toMatchObject({ title: "Renamed UI" });
    // 기존 skipped row는 상태 그대로 보존된다
    expect(db.prepare("SELECT status FROM tasks WHERE id = 't-skip'").get()).toEqual({ status: "skipped" });
  });

  it("applies the same dependency and assignee validation to the existing task PATCH API", async () => {
    const { baseUrl } = await fixture();

    const self = await json(baseUrl, "/api/tasks/t2", {
      method: "PATCH",
      body: JSON.stringify({ depends_on: ["t2"] }),
    });
    const assignee = await json(baseUrl, "/api/tasks/t2", {
      method: "PATCH",
      body: JSON.stringify({ assignee_id: "missing" }),
    });

    expect(self.response.status).toBe(400);
    expect(self.body.error).toContain("cannot depend on itself");
    expect(assignee.response.status).toBe(404);
    expect(assignee.body.error).toContain("Assignee agent not found");
  });

  it("scrubs a deleted task id from dependents without matching partial ids", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    dbs.push(db);
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Project', 'new')").run();
    db.prepare("INSERT INTO goals (id, project_id, title, description, progress) VALUES ('g1', 'p1', 'Goal', 'Delete target', 100)").run();
    db.prepare("INSERT INTO goals (id, project_id, title, description, progress) VALUES ('g2', 'p1', 'Dependent goal', 'Cross-goal scrub', 100)").run();
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES
       ('t1', 'g1', 'p1', 'Delete target', 'done', 0, '[]'),
       ('t2', 'g1', 'p1', 'Exact dependent', 'todo', 1, '["t1"]')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, parent_task_id, title, status, sort_order, depends_on)
       VALUES ('t1-child', 'g1', 'p1', 't1', 'Cascade child', 'done', 0, '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on)
       VALUES ('child-dependent', 'g1', 'p1', 'Cascade child dependent', 'todo', 2, '["t1-child"]')`,
    ).run();
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES ('t10', 'g1', 'p1', 'Partial id target', 'todo', 3, '[]')",
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on)
       VALUES ('partial-dependent', 'g1', 'p1', 'Partial dependent', 'todo', 4, '["t10"]')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on)
       VALUES ('cross-dependent', 'g2', 'p1', 'Cross-goal dependent', 'todo', 0, '["t1"]')`,
    ).run();

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    const router = createTaskRoutes({
      db,
      broadcast: (type: string, payload: unknown) => broadcasts.push({ type, payload }),
    } as any) as any;
    const deleteRoute = router.stack.find(
      (layer: any) => layer.route?.path === "/:id" && layer.route.methods.delete,
    );
    expect(deleteRoute).toBeTruthy();
    let status = 200;
    let body: unknown;
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    };

    deleteRoute.route.stack[0].handle({ params: { id: "t1" } }, response);

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.prepare("SELECT id FROM tasks WHERE id = 't1'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM tasks WHERE id = 't1-child'").get()).toBeUndefined();
    expect(db.prepare("SELECT depends_on FROM tasks WHERE id = 't2'").get())
      .toEqual({ depends_on: "[]" });
    expect(db.prepare("SELECT depends_on FROM tasks WHERE id = 'child-dependent'").get())
      .toEqual({ depends_on: "[]" });
    expect(db.prepare("SELECT depends_on FROM tasks WHERE id = 'cross-dependent'").get())
      .toEqual({ depends_on: "[]" });
    expect(db.prepare("SELECT depends_on FROM tasks WHERE id = 'partial-dependent'").get())
      .toEqual({ depends_on: '["t10"]' });
    expect(db.prepare("SELECT id, progress FROM goals ORDER BY id").all())
      .toEqual([{ id: "g1", progress: 0 }, { id: "g2", progress: 0 }]);
    expect(broadcasts.filter((event) => event.type === "project:updated"))
      .toEqual([{ type: "project:updated", payload: { projectId: "p1" } }]);
  });

  it("scrubs every bulk-deleted task id when a goal is re-decomposed", async () => {
    const db = createDatabase(":memory:");
    migrate(db);
    dbs.push(db);
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Project', 'new')").run();
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description, progress) VALUES ('g1', 'p1', 'Redo', 'Re-decompose', 100)",
    ).run();
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description, progress) VALUES ('g2', 'p1', 'Dependent', 'Legacy cross-goal dependency', 100)",
    ).run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, depends_on) VALUES
        ('old-1', 'g1', 'p1', 'Old one', 'done', '[]'),
        ('old-2', 'g1', 'p1', 'Old two', 'done', '["old-1"]'),
        ('survivor', 'g2', 'p1', 'Survivor', 'todo', '["old-1","old-2"]')
    `).run();

    const router = createOrchestrationRoutes({ db, broadcast: () => {} } as any) as any;
    const decomposeRoute = router.stack.find(
      (layer: any) => layer.route?.path === "/goals/:goalId/decompose" && layer.route.methods.post,
    );
    expect(decomposeRoute).toBeTruthy();
    let status = 200;
    let body: unknown;
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    };

    decomposeRoute.route.stack[0].handle({ params: { goalId: "g1" } }, response);

    expect(status).toBe(202);
    expect(body).toEqual({ status: "decomposing", goalId: "g1" });
    expect(db.prepare("SELECT id FROM tasks WHERE goal_id = 'g1'").all()).toEqual([]);
    expect(db.prepare("SELECT depends_on FROM tasks WHERE id = 'survivor'").get())
      .toEqual({ depends_on: "[]" });
    expect(db.prepare("SELECT id, progress FROM goals ORDER BY id").all())
      .toEqual([{ id: "g1", progress: 0 }, { id: "g2", progress: 0 }]);

    // The route starts decompose in the background. This fixture has no workdir,
    // so let its handled rejection finish before afterEach closes the DB.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("scrubs every CASCADE-deleted task id when a goal is deleted", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    dbs.push(db);
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Project', 'new')").run();
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Delete', 'Delete goal')",
    ).run();
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description, progress) VALUES ('g2', 'p1', 'Dependent', 'Cross-goal dependency', 100)",
    ).run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, depends_on) VALUES
        ('deleted-1', 'g1', 'p1', 'Deleted one', 'done', '[]'),
        ('deleted-2', 'g1', 'p1', 'Deleted two', 'done', '["deleted-1"]'),
        ('survivor', 'g2', 'p1', 'Survivor', 'todo', '["deleted-1","deleted-2"]')
    `).run();

    const router = createGoalRoutes({ db, broadcast: () => {} } as any) as any;
    const deleteRoute = router.stack.find(
      (layer: any) => layer.route?.path === "/:id" && layer.route.methods.delete,
    );
    expect(deleteRoute).toBeTruthy();
    let status = 200;
    let body: unknown;
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    };

    deleteRoute.route.stack[0].handle({ params: { id: "g1" } }, response);

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.prepare("SELECT id FROM goals WHERE id = 'g1'").get()).toBeUndefined();
    expect(db.prepare("SELECT depends_on FROM tasks WHERE id = 'survivor'").get())
      .toEqual({ depends_on: "[]" });
    expect(db.prepare("SELECT progress FROM goals WHERE id = 'g2'").get())
      .toEqual({ progress: 0 });
  });
});
