import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate } from "../db/schema.js";
import { createTerminalRoutes } from "../api/routes/terminals.js";
import { TERMINAL_TASK_KICKOFF } from "../../shared/terminal-agent.js";
import { promptLanguageRule } from "../utils/language.js";

const servers: Server[] = [];
const databases: ReturnType<typeof createDatabase>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  databases.splice(0).forEach((db) => db.close());
});

async function startApi(dismiss: (id: string) => unknown) {
  const broadcast = vi.fn();
  const app = express();
  app.use(express.json());
  app.use("/api/terminals", createTerminalRoutes({
    terminalManager: { dismiss },
    broadcast,
  } as never));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, broadcast };
}

async function startTaskApi(terminalManager: Record<string, unknown>, db: unknown = {}) {
  const broadcast = vi.fn();
  const app = express();
  app.use(express.json());
  app.use("/api/terminals", createTerminalRoutes({
    db,
    terminalManager,
    broadcast,
  } as never));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, broadcast };
}

describe("terminal tab routes", () => {
  it("dismisses a completed terminal and broadcasts the tab update", async () => {
    const dismiss = vi.fn().mockReturnValue({ id: "term-1", workspaceId: "w1", projectId: "p1" });
    const { baseUrl, broadcast } = await startApi(dismiss);

    const response = await fetch(`${baseUrl}/api/terminals/term-1/dismiss`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "dismissed", terminalId: "term-1" });
    expect(dismiss).toHaveBeenCalledWith("term-1");
    expect(broadcast).toHaveBeenCalledWith("terminal:dismissed", {
      terminalId: "term-1",
      workspaceId: "w1",
      projectId: "p1",
    });
  });

  it("requires an active terminal to be stopped first", async () => {
    const { baseUrl } = await startApi(() => {
      throw new Error("Active terminal must be stopped before dismissal");
    });

    const response = await fetch(`${baseUrl}/api/terminals/term-active/dismiss`, { method: "POST" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Active terminal must be stopped before dismissal" });
  });

  it("rejects task start before claiming when terminal context is mismatched", async () => {
    const write = vi.fn();
    const { baseUrl } = await startTaskApi({
      get: vi.fn().mockReturnValue({ id: "term-1", status: "active", contextState: "mismatch" }),
      write,
    });

    const response = await fetch(`${baseUrl}/api/terminals/term-1/start-next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: "g1" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Terminal context is not connected" });
    expect(write).not.toHaveBeenCalled();
  });

  it("records the claimed task and honest provider launch request", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    migrate(db);
    db.exec(`
      INSERT INTO projects (id, name, source, default_provider) VALUES ('p1', 'Project', 'new', 'codex');
      INSERT INTO agents (id, project_id, name, role, provider) VALUES ('a1', 'p1', 'Coder', 'coder', 'codex');
      INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Goal', 'Ship');
      INSERT INTO workspaces (id, project_id, goal_id, active_goal_id, name, state)
        VALUES ('w1', 'p1', 'g1', 'g1', 'Workspace', 'ready');
      INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status)
        VALUES ('t1', 'g1', 'p1', 'Implement', 'a1', 'todo');
      INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, goal_id, agent_id, status)
        VALUES ('term1', 'w1', 'p1', '/bin/zsh', '/tmp', 'g1', 'a1', 'active');
    `);
    const write = vi.fn().mockReturnValue(true);
    const { baseUrl, broadcast } = await startTaskApi({
      get: vi.fn().mockReturnValue({
        id: "term1", workspaceId: "w1", projectId: "p1", status: "active", contextState: "connected",
      }),
      write,
    }, db);

    const response = await fetch(`${baseUrl}/api/terminals/term1/start-next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: "g1", agentId: "a1", provider: "codex", language: "ko" }),
    });

    expect(response.status).toBe(200);
    expect(write).toHaveBeenCalledWith("term1", `codex '${TERMINAL_TASK_KICKOFF} ${promptLanguageRule("ko")}'\r`);
    expect(db.prepare("SELECT kind FROM terminal_activities ORDER BY rowid").all())
      .toEqual([{ kind: "task_claimed" }, { kind: "provider_launch_requested" }]);
    expect(broadcast).toHaveBeenCalledWith("terminal:activity", expect.objectContaining({ kind: "task_claimed" }));
  });

  it("starts the exact task requested from the list instead of the priority queue", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    migrate(db);
    db.exec(`
      INSERT INTO projects (id, name, source, default_provider) VALUES ('p1', 'Project', 'new', 'codex');
      INSERT INTO agents (id, project_id, name, role, provider) VALUES ('a1', 'p1', 'Coder', 'coder', 'codex');
      INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Goal', 'Ship');
      INSERT INTO workspaces (id, project_id, goal_id, active_goal_id, name, state)
        VALUES ('w1', 'p1', 'g1', 'g1', 'Workspace', 'ready');
      INSERT INTO tasks (id, goal_id, project_id, title, status, priority, sort_order)
        VALUES ('t1', 'g1', 'p1', 'Urgent first', 'todo', 'critical', 0);
      INSERT INTO tasks (id, goal_id, project_id, title, status, priority, sort_order)
        VALUES ('t2', 'g1', 'p1', 'Picked from the list', 'todo', 'medium', 1);
      INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, goal_id, agent_id, status)
        VALUES ('term1', 'w1', 'p1', '/bin/zsh', '/tmp', 'g1', 'a1', 'active');
    `);
    const write = vi.fn().mockReturnValue(true);
    const { baseUrl } = await startTaskApi({
      get: vi.fn().mockReturnValue({
        id: "term1", workspaceId: "w1", projectId: "p1", status: "active", contextState: "connected",
      }),
      write,
    }, db);

    const response = await fetch(`${baseUrl}/api/terminals/term1/start-next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: "g1", taskId: "t2", provider: "codex" }),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as { task: Record<string, unknown> };
    expect(payload.task).toMatchObject({ id: "t2", status: "in_progress" });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 't1'").get()).toEqual({ status: "todo" });
    expect(db.prepare("SELECT active_task_id FROM terminal_sessions WHERE id = 'term1'").get())
      .toEqual({ active_task_id: "t2" });
  });
});
