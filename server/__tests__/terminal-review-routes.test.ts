import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { createTerminalRoutes } from "../api/routes/terminals.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "crewdeck-terminal-review-routes-"));
  const db = createDatabase(join(dir, "crewdeck.db"));
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'Project', 'local_import', ?)").run(dir);
  db.prepare("INSERT INTO agents (id, project_id, name, role, status, current_task_id) VALUES ('a1', 'p1', 'Coder', 'coder', 'working', 't1')").run();
  db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Goal', 'Ship')").run();
  db.prepare(`
    INSERT INTO workspaces (id, project_id, goal_id, active_goal_id, name, state, worktree_path, worktree_branch)
    VALUES ('w1', 'p1', 'g1', 'g1', 'Workspace', 'ready', ?, 'workspace/g1')
  `).run(dir);
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status) VALUES ('t1', 'g1', 'p1', 'Task', 'a1', 'in_progress')").run();
  db.prepare(`
    INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, status, goal_id, agent_id, active_task_id)
    VALUES ('term1', 'w1', 'p1', '/bin/zsh', ?, 'active', 'g1', 'a1', 't1')
  `).run(dir);

  const terminal = {
    id: "term1", workspaceId: "w1", projectId: "p1", status: "active",
    activeTaskId: "t1", goalId: "g1", agentId: "a1",
  };
  const broadcast = vi.fn();
  const app = express();
  app.use(express.json());
  app.use("/api/terminals", createTerminalRoutes({
    db,
    broadcast,
    terminalManager: { get: () => terminal },
  } as never));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    broadcast,
    db,
  };
}

describe("terminal review routes", () => {
  it("returns 201 for a new review and 200 for an idempotent replay", async () => {
    const { baseUrl, broadcast, db } = await fixture();
    const body = {
      summary: "Bearer private-token",
      verificationCommands: ["ACCESS_TOKEN=secret npm test"],
      idempotencyKey: "request-1",
    };
    const first = await fetch(`${baseUrl}/api/terminals/term1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const firstJson = await first.json() as any;
    expect(first.status).toBe(201);
    expect(firstJson).toMatchObject({
      replayed: false,
      review: {
        status: "pending",
        evidence: {
          summary: "Bearer [REDACTED]",
          verificationCommands: ["ACCESS_TOKEN=[REDACTED] npm test"],
        },
      },
      task: { status: "in_review" },
    });

    const replay = await fetch(`${baseUrl}/api/terminals/term1/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, review: { id: firstJson.review.id } });

    const listed = await fetch(`${baseUrl}/api/terminals/term1/reviews`);
    expect(await listed.json()).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledWith("terminal:review", expect.objectContaining({ id: firstJson.review.id }));
    expect(db.prepare("SELECT kind, summary FROM terminal_activities").get()).toEqual({
      kind: "completion_requested",
      summary: "Bearer [REDACTED]",
    });
  });
});
