import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { createSessionRoutes } from "../api/routes/sessions.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("../core/agent/adapters/backend.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBackend: () => ({ provider: "claude", spawn }),
  };
});

import { createSessionManager } from "../core/agent/session.js";

function session() {
  return Object.assign(new EventEmitter(), {
    id: `runtime-${Math.random()}`,
    status: "idle",
    process: null,
    lastSessionId: null,
    send: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
  });
}

function seededDb() {
  const db = createDatabase(":memory:");
  migrate(db);
  db.exec(`
    INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'Project', 'new', '/tmp');
    INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Agent', 'backend');
    INSERT INTO goals (id, project_id, description, goal_model) VALUES ('g1', 'p1', 'Goal', 'goal_as_unit');
    INSERT INTO workspaces (id, project_id, goal_id, name) VALUES ('w1', 'p1', 'g1', 'Goal');
    INSERT INTO tasks (id, goal_id, project_id, title, assignee_id) VALUES ('t1', 'g1', 'p1', 'Task', 'a1');
  `);
  return db;
}

describe("session workspace ownership", () => {
  it("persists workspace/session key and kills only the requested sibling", async () => {
    spawn.mockReset();
    spawn.mockImplementation(session);
    const db = seededDb();
    const manager = createSessionManager(db);
    manager.spawnAgent("a1", "/tmp", "implementation-one", "t1");
    manager.spawnAgent("a1", "/tmp", "implementation-two", "t1");

    const rows = db.prepare(`
      SELECT id, workspace_id, session_key, origin, status
        FROM sessions ORDER BY rowid
    `).all() as Array<{
      id: string;
      workspace_id: string | null;
      session_key: string | null;
      origin: string;
      status: string;
    }>;
    expect(rows).toEqual([
      expect.objectContaining({ workspace_id: "w1", session_key: "implementation-one", origin: "orchestration", status: "active" }),
      expect.objectContaining({ workspace_id: "w1", session_key: "implementation-two", origin: "orchestration", status: "active" }),
    ]);

    const app = express();
    app.use("/api/sessions", createSessionRoutes({
      db,
      sessionManager: manager,
      broadcast: () => {},
    } as any));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${rows[0].id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);
      expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(rows[0].id)).toEqual({ status: "killed" });
      expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(rows[1].id)).toEqual({ status: "active" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects explicit ownership from another project before spawning", () => {
    spawn.mockReset();
    spawn.mockImplementation(session);
    const db = seededDb();
    db.exec(`
      INSERT INTO projects (id, name, source) VALUES ('p2', 'Other', 'new');
      INSERT INTO workspaces (id, project_id, name) VALUES ('w2', 'p2', 'Other');
    `);
    const manager = createSessionManager(db);

    expect(() => manager.spawnAgent(
      "a1", "/tmp", "foreign", null, undefined, undefined,
      { workspaceId: "w2", origin: "terminal" },
    )).toThrow("does not belong to agent project");
    expect(spawn).not.toHaveBeenCalled();
  });
});
