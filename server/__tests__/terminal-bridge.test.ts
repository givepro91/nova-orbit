import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { createDatabase, migrate } from "../db/schema.js";
import {
  createTerminalBridgeGoal,
  createTerminalBridgeTask,
  finishTerminalBridgeAgentRun,
  getTerminalBridgeContext,
  listTerminalBridgeActivity,
  updateTerminalBridgeTask,
} from "../core/terminal/bridge.js";
import { createTerminalBridgeRoutes } from "../api/routes/terminal-bridge.js";
import { authMiddleware, createScopedTerminalTokenValidator } from "../api/middleware/auth.js";

const servers: Server[] = [];
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const workdir = mkdtempSync(join(tmpdir(), "crewdeck-bridge-"));
  dirs.push(workdir);
  const db = createDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'Project', 'new', ?)").run(workdir);
  db.exec(`
    INSERT INTO workspaces (
      id, project_id, name, kind, state, worktree_path, worktree_branch, setup_progress
    ) VALUES ('w1', 'p1', 'Terminal', 'manual', 'ready', '${workdir.replaceAll("'", "''")}', 'workspace/terminal', 100);
    INSERT INTO agents (id, project_id, name, role) VALUES
      ('a1', 'p1', 'Backend Agent', 'backend'),
      ('a2', 'p1', 'QA Agent', 'qa');
  `);
  return { db, workdir };
}

describe("terminal bridge contract", () => {
  it("atomically creates an idempotent goal, tasks, ownership, and goal workspace", () => {
    const { db } = fixture();
    const input = {
      workspaceId: "w1",
      clientRequestId: "request-1",
      title: "Terminal-created objective",
      description: "Created by the connected AI",
      priority: "high" as const,
      tasks: [
        { title: "Implement", assignee: "backend" },
        { title: "Verify", assignee: "QA Agent" },
      ],
    };
    const first = createTerminalBridgeGoal(db, input);
    const replay = createTerminalBridgeGoal(db, input);

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, goal: { id: first.goal.id } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM goals").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT goal_model, origin_workspace_id FROM goals WHERE id = ?").get(first.goal.id))
      .toEqual({ goal_model: "goal_as_unit", origin_workspace_id: "w1" });
    expect(first.tasks.map((task) => task.assignee_id)).toEqual(["a1", "a2"]);
    expect(db.prepare("SELECT state FROM workspaces WHERE goal_id = ?").get(first.goal.id)).toEqual({ state: "pending" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM terminal_bridge_events").get()).toEqual({ count: 1 });
  });

  it("creates and transitions project-scoped tasks while exposing live context", () => {
    const { db, workdir } = fixture();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workdir, stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.email", "test@crewdeck.local");
    git("config", "user.name", "Crewdeck Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(workdir, "README.md"), "# base\n");
    git("add", ".");
    git("commit", "-m", "base");
    const goal = createTerminalBridgeGoal(db, {
      workspaceId: "w1", clientRequestId: "goal", title: "Goal",
    });
    const taskResult = createTerminalBridgeTask(db, {
      workspaceId: "w1", clientRequestId: "task", goalId: String(goal.goal.id),
      task: { title: "Live task", assignee: "backend" },
    });
    const taskId = String((taskResult.task as Record<string, unknown>).id);
    const started = updateTerminalBridgeTask(db, {
      workspaceId: "w1", clientRequestId: "start", taskId, status: "in_progress",
    });
    writeFileSync(join(workdir, "proof.md"), "# terminal evidence\n");
    const review = updateTerminalBridgeTask(db, {
      workspaceId: "w1", clientRequestId: "review", taskId, status: "in_review", summary: "ready",
    });
    const done = updateTerminalBridgeTask(db, {
      workspaceId: "w1", clientRequestId: "done", taskId, status: "done", summary: "complete",
    });
    expect((started.task as Record<string, unknown>).status).toBe("in_progress");
    expect((review.task as Record<string, unknown>).status).toBe("in_review");
    expect((done.task as Record<string, unknown>).status).toBe("done");
    expect(review.evidence).toMatchObject({ dirty: true, changedFiles: ["proof.md"] });
    expect(db.prepare("SELECT progress FROM goals WHERE id = ?").get(goal.goal.id)).toEqual({ progress: 100 });
    expect(getTerminalBridgeContext(db, "w1")).toMatchObject({
      project: { id: "p1" }, agents: [{ id: "a1" }, { id: "a2" }],
    });
    expect(listTerminalBridgeActivity(db, "w1", String(goal.goal.id)).map((event) => event.status))
      .toEqual(["done", "in_review", "in_progress", "todo", null]);
  });

  it("marks an unfinished task blocked when its AI command exits", () => {
    const { db, workdir } = fixture();
    db.prepare(
      "INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, status) "
      + "VALUES ('term-1', 'w1', 'p1', '/bin/zsh', ?, 'active')",
    ).run(workdir);
    const goal = createTerminalBridgeGoal(db, {
      workspaceId: "w1", terminalSessionId: "term-1", clientRequestId: "exit-goal", title: "Exit recovery",
    });
    const task = createTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: "term-1", clientRequestId: "exit-task",
      goalId: String(goal.goal.id), task: { title: "Do work" },
    });
    const taskId = String((task.task as Record<string, unknown>).id);
    updateTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: "term-1", clientRequestId: "exit-start",
      taskId, status: "in_progress",
    });

    const reconciled = finishTerminalBridgeAgentRun(db, {
      workspaceId: "w1", terminalSessionId: "term-1", clientRequestId: "exit-finish",
      provider: "claude", exitCode: 9,
    });

    expect(reconciled.task).toMatchObject({ id: taskId, status: "blocked" });
    expect((reconciled.task as Record<string, unknown>).result_summary).toContain("exited with code 9");
    expect(finishTerminalBridgeAgentRun(db, {
      workspaceId: "w1", terminalSessionId: "term-1", clientRequestId: "exit-noop",
      provider: "claude", exitCode: 0,
    })).toEqual({ task: null, replayed: false });
  });
});

async function startBridgeApi() {
  const { db } = fixture();
  const app = express();
  app.use(express.json());
  app.use("/api/terminal-bridge", createTerminalBridgeRoutes({ db, broadcast: () => {} } as any));
  const server = createServer(app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return { db, apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
}

describe("terminal bridge clients", () => {
  it("creates a visible goal through crewdeck-sync", async () => {
    const { db, apiBase } = await startBridgeApi();
    const cli = resolve(process.cwd(), "node_modules/.bin/tsx");
    const output = await new Promise<string>((done, reject) => execFile(cli, [
        resolve(process.cwd(), "bin/crewdeck-sync.ts"), "goal",
        "--title", "CLI goal",
        "--tasks-json", JSON.stringify([{ title: "CLI task", assignee: "backend" }]),
        "--request-id", "cli-request",
      ], {
        encoding: "utf8",
        env: { ...process.env, CREWDECK_API_URL: apiBase, CREWDECK_API_KEY: "test", CREWDECK_WORKSPACE_ID: "w1" },
      }, (error, stdout) => error ? reject(error) : done(stdout)));
    expect(JSON.parse(output)).toMatchObject({ goal: { title: "CLI goal" }, tasks: [{ title: "CLI task" }] });
    expect(db.prepare("SELECT COUNT(*) AS count FROM goals WHERE title = 'CLI goal'").get()).toEqual({ count: 1 });
  });

  it("lists and calls Crewdeck tools over MCP stdio", async () => {
    const { db, apiBase } = await startBridgeApi();
    const child = spawn(resolve(process.cwd(), "node_modules/.bin/tsx"), [resolve(process.cwd(), "bin/crewdeck-mcp.ts")], {
      env: { ...process.env, CREWDECK_API_URL: apiBase, CREWDECK_API_KEY: "test", CREWDECK_WORKSPACE_ID: "w1" },
      stdio: "pipe",
    });
    children.push(child);
    const pending = new Map<number, (value: any) => void>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    const send = (id: number, method: string, params: Record<string, unknown> = {}) => new Promise<any>((done) => {
      pending.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    const initialized = await send(1, "initialize", { protocolVersion: "2025-06-18" });
    expect(initialized.result.serverInfo.name).toBe("crewdeck-terminal");
    expect(initialized.result.instructions).toContain("todo -> in_progress -> in_review -> done");
    const listed = await send(2, "tools/list");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name))
      .toContain("crewdeck_create_goal");
    expect(listed.result.tools.find((tool: { name: string }) => tool.name === "crewdeck_update_task").description)
      .toContain("exact sequence");
    const called = await send(3, "tools/call", {
      name: "crewdeck_create_goal",
      arguments: {
        title: "MCP goal",
        tasks: [
          { title: "Implement through MCP", assignee: "backend" },
          { title: "Verify through MCP", assignee: "qa" },
        ],
      },
    });
    expect(called.result.isError).not.toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM goals WHERE title = 'MCP goal'").get()).toEqual({ count: 1 });
    const structured = called.result.structuredContent as {
      goal: { id: string };
      tasks: Array<{ id: string }>;
    };
    let requestId = 4;
    for (const task of structured.tasks) {
      for (const status of ["in_progress", "in_review", "done"]) {
        const updated = await send(requestId++, "tools/call", {
          name: "crewdeck_update_task",
          arguments: { taskId: task.id, status, summary: status === "done" ? `${task.id} verified` : undefined },
        });
        expect(updated.result.isError).not.toBe(true);
      }
    }
    expect(db.prepare("SELECT progress FROM goals WHERE id = ?").get(structured.goal.id)).toEqual({ progress: 100 });
    expect(db.prepare("SELECT status FROM tasks WHERE goal_id = ? ORDER BY sort_order").all(structured.goal.id))
      .toEqual([{ status: "done" }, { status: "done" }]);
  });
});

describe("terminal bridge authorization", () => {
  it("accepts a live Workspace-scoped token only on bridge routes", async () => {
    const { db } = fixture();
    const token = "scoped-terminal-token";
    const hash = createHash("sha256").update(token).digest("hex");
    db.prepare(`
      INSERT INTO terminal_sessions (
        id, workspace_id, project_id, shell, cwd, status, bridge_token_hash
      ) VALUES ('term1', 'w1', 'p1', '/bin/zsh', '/tmp', 'active', ?)
    `).run(hash);
    const app = express();
    app.use(express.json());
    app.use(authMiddleware("global-key", "", createScopedTerminalTokenValidator(db)));
    app.get("/api/terminal-bridge/probe", (_req, res) => res.json({ ok: true }));
    app.get("/api/projects", (_req, res) => res.json({ ok: true }));
    const server = createServer(app);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const scopedHeaders = { authorization: `Bearer ${token}` };

    expect((await fetch(`${base}/api/terminal-bridge/probe?workspaceId=w1`, { headers: scopedHeaders })).status).toBe(200);
    expect((await fetch(`${base}/api/terminal-bridge/probe?workspaceId=other`, { headers: scopedHeaders })).status).toBe(401);
    expect((await fetch(`${base}/api/projects`, { headers: scopedHeaders })).status).toBe(401);
    expect((await fetch(`${base}/api/projects`, { headers: { authorization: "Bearer global-key" } })).status).toBe(200);
    db.prepare("UPDATE terminal_sessions SET status = 'killed' WHERE id = 'term1'").run();
    expect((await fetch(`${base}/api/terminal-bridge/probe?workspaceId=w1`, { headers: scopedHeaders })).status).toBe(401);
  });
});
