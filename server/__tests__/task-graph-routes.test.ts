import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
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
});
