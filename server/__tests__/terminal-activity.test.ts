import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createDatabase, migrate } from "../db/schema.js";
import { authMiddleware, createScopedTerminalTokenValidator } from "../api/middleware/auth.js";
import { createTerminalActivityRoutes } from "../api/routes/terminal-activity.js";
import {
  createTerminalActivity,
  listTerminalActivities,
  sanitizeTerminalActivityMetadata,
} from "../core/terminal/activity.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function fixture() {
  const db = createDatabase(":memory:");
  migrate(db);
  db.exec(`
    INSERT INTO projects (id, name, source) VALUES
      ('p1', 'Project one', 'new'),
      ('p2', 'Project two', 'new');
    INSERT INTO goals (id, project_id, title, description) VALUES
      ('g1', 'p1', 'Goal one', 'Goal one'),
      ('g2', 'p2', 'Goal two', 'Goal two');
    INSERT INTO agents (id, project_id, name, role) VALUES
      ('a1', 'p1', 'Coder', 'coder'),
      ('a2', 'p2', 'Other coder', 'coder');
    INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status) VALUES
      ('t1', 'g1', 'p1', 'Task one', 'a1', 'in_progress'),
      ('t2', 'g2', 'p2', 'Task two', 'a2', 'in_progress');
    INSERT INTO workspaces (id, project_id, goal_id, active_goal_id, name, state) VALUES
      ('w1', 'p1', 'g1', 'g1', 'Workspace one', 'ready'),
      ('w2', 'p2', 'g2', 'g2', 'Workspace two', 'ready');
    INSERT INTO terminal_sessions (
      id, workspace_id, project_id, shell, cwd, goal_id, agent_id, active_task_id, provider
    ) VALUES
      ('term1', 'w1', 'p1', '/bin/zsh', '/tmp/one', 'g1', 'a1', 't1', 'codex'),
      ('term1b', 'w1', 'p1', '/bin/zsh', '/tmp/one', 'g1', 'a1', 't1', 'claude'),
      ('term2', 'w2', 'p2', '/bin/zsh', '/tmp/two', 'g2', 'a2', 't2', 'claude');
  `);
  return db;
}

describe("terminal activity evidence", () => {
  it("migrates the append-only schema idempotently", () => {
    const db = fixture();
    migrate(db);
    const columns = db.prepare("PRAGMA table_info(terminal_activities)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "idempotency_key", "workspace_id", "terminal_session_id", "project_id",
      "goal_id", "task_id", "agent_id", "provider", "kind", "summary", "metadata", "created_at",
    ]));
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'terminal_activities'").get() as { sql: string };
    expect(table.sql).toContain("UNIQUE(terminal_session_id, idempotency_key)");
    db.close();
  });

  it("derives authoritative scope from the terminal binding and replays an idempotency key", () => {
    const db = fixture();
    const first = createTerminalActivity(db, {
      workspaceId: "w1",
      terminalSessionId: "term1",
      idempotencyKey: "command:build:1",
      kind: "command_finished",
      summary: "npm run build passed",
      metadata: { exitCode: 0 },
    });
    const replay = createTerminalActivity(db, {
      workspaceId: "w1",
      terminalSessionId: "term1",
      idempotencyKey: "command:build:1",
      kind: "blocked",
      summary: "this different retry must not overwrite the original",
    });
    expect(first).toMatchObject({
      replayed: false,
      activity: {
        workspaceId: "w1", terminalSessionId: "term1", projectId: "p1",
        goalId: "g1", taskId: "t1", agentId: "a1", provider: "codex",
        kind: "command_finished", metadata: { exitCode: 0 },
      },
    });
    expect(replay).toEqual({ activity: first.activity, replayed: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM terminal_activities").get()).toEqual({ count: 1 });
    expect(() => createTerminalActivity(db, {
      workspaceId: "w2", terminalSessionId: "term1", idempotencyKey: "wrong-scope",
      kind: "blocked", summary: "wrong workspace",
    })).toThrow("Terminal does not belong to workspace");
    db.close();
  });

  it("redacts secrets and rejects oversized or excessively deep metadata", () => {
    const db = fixture();
    const result = createTerminalActivity(db, {
      workspaceId: "w1",
      terminalSessionId: "term1",
      idempotencyKey: "redaction-1",
      kind: "verification_run",
      summary: "curl -H 'Authorization: Bearer very.secret.token' passed",
      metadata: {
        apiKey: "sk-live-secret",
        nested: {
          output: "DATABASE_PASSWORD=hunter2 https://jay:pw@example.com Authorization: Bearer abc.def.ghi",
        },
      },
    });
    expect(result.activity.summary).not.toContain("very.secret.token");
    expect(result.activity.metadata).toEqual({
      apiKey: "[REDACTED]",
      nested: {
        output: "DATABASE_PASSWORD=[REDACTED] https://[REDACTED]@example.com Authorization: Bearer [REDACTED]",
      },
    });
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 8; index++) deep = { nested: deep };
    expect(() => sanitizeTerminalActivityMetadata(deep)).toThrow("maximum depth");
    expect(() => sanitizeTerminalActivityMetadata(Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`output${index}`, "x".repeat(2_000)]),
    ))).toThrow("16384 bytes");
    db.close();
  });

  it("filters and paginates a bounded newest-first list", () => {
    const db = fixture();
    for (let index = 0; index < 4; index++) {
      createTerminalActivity(db, {
        workspaceId: "w1", terminalSessionId: index === 3 ? "term1b" : "term1",
        idempotencyKey: `event-${index}`, kind: index === 0 ? "task_claimed" : "file_changed",
        summary: `event ${index}`,
      });
    }
    const first = listTerminalActivities(db, { workspaceId: "w1", terminalSessionId: "term1", limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1].id);
    const second = listTerminalActivities(db, {
      workspaceId: "w1", terminalSessionId: "term1", limit: 2, cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    expect(listTerminalActivities(db, { workspaceId: "w1", goalId: "g1", limit: 100 }).items).toHaveLength(4);
    expect(() => listTerminalActivities(db, { workspaceId: "w1", cursor: "missing" })).toThrow("Invalid activity cursor");
    db.close();
  });

  it("enforces scoped terminal auth, ignores spoofed IDs, and broadcasts only a new event", async () => {
    const db = fixture();
    const scopedToken = "scoped-terminal-token";
    const tokenHash = createHash("sha256").update(scopedToken).digest("hex");
    db.prepare("UPDATE terminal_sessions SET bridge_token_hash = ? WHERE id = 'term1'").run(tokenHash);
    const broadcast = vi.fn();
    const app = express();
    app.use(express.json());
    app.use(authMiddleware("dashboard-key", "/tmp", createScopedTerminalTokenValidator(db)));
    app.use("/api/terminal-bridge/activity", createTerminalActivityRoutes(
      { db, broadcast } as any,
      { requireTerminalSessionIdForList: true },
    ));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: Record<string, unknown>) => fetch(`${base}/api/terminal-bridge/activity`, {
      method: "POST",
      headers: { authorization: `Bearer ${scopedToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const body = {
      workspaceId: "w1", terminalSessionId: "term1", idempotencyKey: "route-1",
      kind: "file_changed", summary: "changed one file", metadata: { path: "src/index.ts" },
      projectId: "p2", goalId: "g2", taskId: "t2", agentId: "a2", provider: "claude",
    };
    const created = await post(body);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      replayed: false,
      activity: { projectId: "p1", goalId: "g1", taskId: "t1", agentId: "a1", provider: "codex" },
    });
    expect((await post(body)).status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith("terminal:activity", expect.objectContaining({ kind: "file_changed" }));

    expect((await post({ ...body, workspaceId: "w2", idempotencyKey: "cross-workspace" })).status).toBe(401);
    expect((await post({ ...body, terminalSessionId: "term1b", idempotencyKey: "cross-terminal" })).status).toBe(401);
    expect((await fetch(`${base}/api/terminal-bridge/activity?workspaceId=w1`, {
      headers: { authorization: `Bearer ${scopedToken}` },
    })).status).toBe(401);
    const listed = await fetch(`${base}/api/terminal-bridge/activity?workspaceId=w1&terminalSessionId=term1&limit=1`, {
      headers: { authorization: `Bearer ${scopedToken}` },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [{ idempotencyKey: "route-1" }] });
    db.close();
  });
});
