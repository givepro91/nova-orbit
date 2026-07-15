import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate } from "../db/schema.js";
import { TerminalManager, type TerminalEvent } from "../core/terminal/manager.js";
import {
  createTerminalBridgeGoal,
  createTerminalBridgeTask,
  updateTerminalBridgeTask,
} from "../core/terminal/bridge.js";

const tempDirs: string[] = [];
const managers: TerminalManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.killAll();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(withRuntime = false) {
  const cwd = mkdtempSync(join(tmpdir(), "crewdeck-pty-"));
  tempDirs.push(cwd);
  const db = createDatabase(":memory:");
  migrate(db);
  db.exec(`INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'Project', 'new', '${cwd.replaceAll("'", "''")}')`);
  db.prepare(`
    INSERT INTO workspaces (
      id, project_id, name, kind, state, worktree_path, worktree_branch, setup_progress
    ) VALUES ('w1', 'p1', 'Workspace', 'manual', 'ready', ?, 'workspace/test', 100)
  `).run(cwd);
  const events: TerminalEvent[] = [];
  const manager = new TerminalManager(db, (event) => events.push(event), withRuntime ? {
    dataDir: cwd,
    apiBaseUrl: "http://127.0.0.1:7200/api",
    syncCommand: { command: "/bin/echo", args: ["sync"] },
    mcpCommand: { command: "/bin/echo", args: ["mcp"] },
  } : undefined);
  managers.push(manager);
  return { cwd, db, events, manager };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for PTY output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("local terminal manager", () => {
  it("opens a real PTY in the workspace and streams shell output", async () => {
    const { cwd, db, events, manager } = setup();
    const terminal = manager.create("w1", { cols: 90, rows: 24 });
    expect(terminal).toMatchObject({ workspaceId: "w1", cwd, status: "active", cols: 90, rows: 24 });

    expect(manager.write(terminal.id, "printf 'CREWDECK_PTY_OK\\n'; pwd\n")).toBe(true);
    await waitUntil(() => events.some((event) =>
      event.type === "terminal:data" && event.payload.terminalId === terminal.id && event.payload.data.includes("CREWDECK_PTY_OK"),
    ));
    await waitUntil(() => manager.get(terminal.id)?.output.includes(cwd) === true);
    expect(manager.get(terminal.id)?.output).toContain("CREWDECK_PTY_OK");
    expect(manager.get(terminal.id)?.output).toContain(cwd);
    await waitUntil(() => (db.prepare("SELECT last_output FROM terminal_sessions WHERE id = ?").get(terminal.id) as { last_output: string }).last_output.includes("CREWDECK_PTY_OK"));
  });

  it("resizes and kills only the requested sibling terminal", async () => {
    const { db, manager } = setup();
    const first = manager.create("w1");
    const second = manager.create("w1");

    expect(manager.resize(first.id, 155, 48)).toBe(true);
    expect(db.prepare("SELECT cols, rows FROM terminal_sessions WHERE id = ?").get(first.id))
      .toEqual({ cols: 155, rows: 48 });

    manager.kill(first.id);
    await waitUntil(() => manager.get(first.id)?.status === "killed");
    expect(manager.get(second.id)?.status).toBe("active");
  });

  it("blocks the terminal-owned active task when the user stops its PTY", async () => {
    const { db, manager } = setup();
    const terminal = manager.create("w1");
    const goal = createTerminalBridgeGoal(db, {
      workspaceId: "w1", terminalSessionId: terminal.id, clientRequestId: "kill-goal", title: "Kill recovery",
    });
    const task = createTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: terminal.id, clientRequestId: "kill-task",
      goalId: String(goal.goal.id), task: { title: "Terminal-owned work" },
    });
    const taskId = String((task.task as Record<string, unknown>).id);
    updateTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: terminal.id, clientRequestId: "kill-start",
      taskId, status: "in_progress",
    });

    manager.kill(terminal.id);

    await waitUntil(() => manager.get(terminal.id)?.status === "killed");
    expect(db.prepare("SELECT status, result_summary FROM tasks WHERE id = ?").get(taskId))
      .toMatchObject({ status: "blocked", result_summary: expect.stringContaining("terminal session exited") });
  });

  it("marks stale active PTYs interrupted on server restart", () => {
    const { db } = setup();
    db.prepare(`
      INSERT INTO terminal_sessions (
        id, workspace_id, project_id, shell, cwd, pid, status
      ) VALUES ('stale', 'w1', 'p1', '/bin/zsh', '/tmp', 99999, 'active')
    `).run();
    const manager = new TerminalManager(db, () => {});
    managers.push(manager);
    expect(manager.get("stale")).toMatchObject({ status: "interrupted", pid: null });
  });

  it("injects the Crewdeck bridge and AI wrappers into the local shell", async () => {
    const { cwd, events, manager } = setup(true);
    const terminal = manager.create("w1");
    manager.write(terminal.id, "command -v crewdeck-sync; whence -w claude; whence -w codex; printf 'BRIDGE_ENV=%s:%s\\n' \"$CREWDECK_WORKSPACE_ID\" \"$CREWDECK_TERMINAL_ID\"; printf 'LIFECYCLE=%s\\n' \"$CREWDECK_AGENT_PROMPT\"\n");
    await waitUntil(() => manager.get(terminal.id)?.output.includes("BRIDGE_ENV=w1:") === true);
    const output = manager.get(terminal.id)?.output ?? "";
    expect(output).toContain("terminal-runtime/bin/crewdeck-sync");
    expect(output).toContain("claude: function");
    expect(output).toContain("codex: function");
    expect(output).toContain(`BRIDGE_ENV=w1:${terminal.id}`);
    expect(output).toContain("todo -> in_progress -> in_review -> done");
    const zshrc = readFileSync(join(cwd, "terminal-runtime", ".zshrc"), "utf8");
    expect(zshrc).toContain("--strict-mcp-config");
    expect(zshrc).toContain("crewdeck-sync agent-exit --provider claude");
    expect(zshrc).toContain("crewdeck-sync agent-exit --provider codex");
    expect(zshrc).toContain('CODEX_HOME="$CREWDECK_CODEX_HOME"');
    const codexConfig = readFileSync(
      join(cwd, "terminal-runtime", "codex-home", terminal.id, "config.toml"),
      "utf8",
    );
    expect(codexConfig).toContain("[mcp_servers.crewdeck.env]");
    expect(codexConfig).toContain("CREWDECK_API_KEY");
    expect(events.some((event) => event.type === "terminal:data")).toBe(true);
  });
});
