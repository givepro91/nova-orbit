import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate } from "../db/schema.js";
import { createTerminalRoutes } from "../api/routes/terminals.js";

const servers: Server[] = [];
const cleanup: Array<() => void> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  cleanup.splice(0).reverse().forEach((run) => run());
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
});

function bindingFixture() {
  const dir = mkdtempSync(join(tmpdir(), "crewdeck-terminal-routes-"));
  const db = createDatabase(join(dir, "crewdeck.db"));
  migrate(db);
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'Project', 'local_import', ?)").run(dir);
  db.prepare("INSERT INTO goals (id, project_id, title, description, sort_order) VALUES ('g1', 'p1', 'Goal', 'Ship it', 0)").run();
  db.prepare(`
    INSERT INTO workspaces (id, project_id, goal_id, active_goal_id, name, kind, state, worktree_path, worktree_branch)
    VALUES ('w1', 'p1', 'g1', 'g1', 'Workspace', 'goal', 'ready', ?, 'workspace/g1')
  `).run(dir);
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES ('t1', 'g1', 'p1', 'Implement feature', 'todo', 0, '[]')").run();
  db.prepare("INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, status, goal_id) VALUES ('term1', 'w1', 'p1', '/bin/zsh', ?, 'active', 'g1')").run(dir);
  return db;
}

function fakeManager(db: ReturnType<typeof bindingFixture>) {
  return {
    get: vi.fn((id: string) => {
      const row = db.prepare(`
        SELECT ts.*, t.title AS active_task_title FROM terminal_sessions ts
        LEFT JOIN tasks t ON t.id = ts.active_task_id WHERE ts.id = ?
      `).get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id,
        status: row.status,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        activeTaskId: row.active_task_id,
        activeTaskTitle: row.active_task_title ?? null,
        provider: row.provider,
      };
    }),
    runningAgent: vi.fn<(id: string) => "claude" | "codex" | null>(() => null),
    sendAgentMessage: vi.fn(async () => true),
    launchAgentCommand: vi.fn(() => true),
    dismiss: vi.fn(),
  };
}

async function startBindingApi(db: ReturnType<typeof bindingFixture>, manager: ReturnType<typeof fakeManager>) {
  const broadcast = vi.fn();
  const app = express();
  app.use(express.json());
  app.use("/api/terminals", createTerminalRoutes({ db, terminalManager: manager, broadcast } as never));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, broadcast };
}

describe("claim-next kickoff", () => {
  it("injects the kickoff into a running agent session", async () => {
    const db = bindingFixture();
    const manager = fakeManager(db);
    manager.runningAgent.mockReturnValue("claude");
    const { baseUrl } = await startBindingApi(db, manager);

    const response = await fetch(`${baseUrl}/api/terminals/term1/claim-next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: "g1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { kickoff: { status: string; provider: string } };
    expect(body.kickoff).toEqual({ status: "sent", provider: "claude" });
    expect(manager.sendAgentMessage).toHaveBeenCalledWith("term1", expect.stringContaining('"Implement feature"'));
    expect(manager.sendAgentMessage).toHaveBeenCalledWith("term1", expect.stringContaining("task t1"));
  });

  it("never types into a bare shell — reports agent_not_running instead", async () => {
    const db = bindingFixture();
    const manager = fakeManager(db);
    const { baseUrl } = await startBindingApi(db, manager);

    const response = await fetch(`${baseUrl}/api/terminals/term1/claim-next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: "g1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { kickoff: { status: string } };
    expect(body.kickoff).toEqual({ status: "agent_not_running", provider: null });
    expect(manager.sendAgentMessage).not.toHaveBeenCalled();
    expect(manager.launchAgentCommand).not.toHaveBeenCalled();
  });
});

describe("terminal launch", () => {
  it("launches the agent CLI with the kickoff as its initial prompt", async () => {
    const db = bindingFixture();
    const manager = fakeManager(db);
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 't1'").run();
    db.prepare("UPDATE terminal_sessions SET active_task_id = 't1' WHERE id = 'term1'").run();
    const { baseUrl } = await startBindingApi(db, manager);

    const response = await fetch(`${baseUrl}/api/terminals/term1/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude", goalId: "g1", kickoff: true }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; kickoffSent: boolean };
    expect(body.status).toBe("launched");
    expect(body.kickoffSent).toBe(true);
    expect(manager.launchAgentCommand).toHaveBeenCalledWith("term1", "claude", expect.stringContaining('"Implement feature"'));
    expect(manager.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("does not retype the launch command into an already running session", async () => {
    const db = bindingFixture();
    const manager = fakeManager(db);
    manager.runningAgent.mockReturnValue("claude");
    const { baseUrl } = await startBindingApi(db, manager);

    const response = await fetch(`${baseUrl}/api/terminals/term1/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude", goalId: "g1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; kickoffSent: boolean };
    expect(body.status).toBe("already_running");
    expect(body.kickoffSent).toBe(false);
    expect(manager.launchAgentCommand).not.toHaveBeenCalled();
    expect(manager.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("blocks launching while a different agent is running", async () => {
    const db = bindingFixture();
    const manager = fakeManager(db);
    manager.runningAgent.mockReturnValue("codex");
    const { baseUrl } = await startBindingApi(db, manager);

    const response = await fetch(`${baseUrl}/api/terminals/term1/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude", goalId: "g1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; runningProvider: string };
    expect(body.status).toBe("conflict");
    expect(body.runningProvider).toBe("codex");
    expect(manager.launchAgentCommand).not.toHaveBeenCalled();
    expect(manager.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider", async () => {
    const db = bindingFixture();
    const manager = fakeManager(db);
    const { baseUrl } = await startBindingApi(db, manager);

    const response = await fetch(`${baseUrl}/api/terminals/term1/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "gemini" }),
    });

    expect(response.status).toBe(400);
  });
});
