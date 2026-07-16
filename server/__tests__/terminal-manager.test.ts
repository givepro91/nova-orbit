import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createDatabase, migrate } from "../db/schema.js";
import { TerminalManager, type TerminalEvent, type TerminalRuntimeOptions } from "../core/terminal/manager.js";
import {
  createTerminalBridgeGoal,
  createTerminalBridgeTask,
  updateTerminalBridgeTask,
} from "../core/terminal/bridge.js";
import { recoverOnStartup } from "../core/recovery.js";

const tempDirs: string[] = [];
const managers: TerminalManager[] = [];
let originalZdotdir: string | undefined;
const tmuxAvailable = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  originalZdotdir = process.env.ZDOTDIR;
  const isolatedShellConfig = mkdtempSync(join(tmpdir(), "crewdeck-shell-config-"));
  tempDirs.push(isolatedShellConfig);
  process.env.ZDOTDIR = isolatedShellConfig;
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.killAll({ preservePersistent: false });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
  if (originalZdotdir === undefined) delete process.env.ZDOTDIR;
  else process.env.ZDOTDIR = originalZdotdir;
});

function setup(
  withRuntime = false,
  persistent = false,
  tmuxCommand: TerminalRuntimeOptions["tmuxCommand"] = persistent ? undefined : null,
) {
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
  const runtime = withRuntime ? {
    dataDir: cwd,
    apiBaseUrl: "http://127.0.0.1:7200/api",
    syncCommand: { command: "/bin/echo", args: ["sync"] },
    mcpCommand: { command: "/bin/echo", args: ["mcp"] },
    tmuxCommand,
  } : undefined;
  const manager = new TerminalManager(db, (event) => events.push(event), runtime);
  managers.push(manager);
  return { cwd, db, events, manager, runtime };
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

  it("dismisses a completed tab without deleting its terminal evidence", async () => {
    const { manager } = setup();
    const completed = manager.create("w1");
    const active = manager.create("w1");

    expect(() => manager.dismiss(active.id)).toThrow("Active terminal must be stopped before dismissal");
    manager.kill(completed.id);
    await waitUntil(() => manager.get(completed.id)?.status === "killed");

    expect(manager.dismiss(completed.id)).toMatchObject({ id: completed.id, status: "killed" });
    expect(manager.list("w1").map((terminal) => terminal.id)).toEqual([active.id]);
    expect(manager.get(completed.id)).toMatchObject({ id: completed.id, status: "killed" });
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

  it("marks stale active PTYs interrupted and blocks their active bridge task on server restart", () => {
    const { db } = setup();
    db.prepare(`
      INSERT INTO terminal_sessions (
        id, workspace_id, project_id, shell, cwd, pid, status
      ) VALUES ('stale', 'w1', 'p1', '/bin/zsh', '/tmp', 99999, 'active')
    `).run();
    const goal = createTerminalBridgeGoal(db, {
      workspaceId: "w1", terminalSessionId: "stale", clientRequestId: "restart-goal", title: "Restart recovery",
    });
    const task = createTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: "stale", clientRequestId: "restart-task",
      goalId: String(goal.goal.id), task: { title: "Interrupted work" },
    });
    const taskId = String((task.task as Record<string, unknown>).id);
    updateTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: "stale", clientRequestId: "restart-start",
      taskId, status: "in_progress",
    });
    const manager = new TerminalManager(db, () => {});
    managers.push(manager);
    expect(manager.get("stale")).toMatchObject({ status: "interrupted", pid: null });
    expect(db.prepare("SELECT status, result_summary FROM tasks WHERE id = ?").get(taskId)).toMatchObject({
      status: "blocked",
      result_summary: expect.stringContaining("was interrupted"),
    });
  });

  it("preserves output and reconciles the active bridge task during graceful shutdown", async () => {
    const { db, manager } = setup();
    const terminal = manager.create("w1");
    manager.write(terminal.id, "printf 'OUTPUT_BEFORE_RESTART\\n'\n");
    await waitUntil(() => manager.get(terminal.id)?.output.includes("OUTPUT_BEFORE_RESTART") === true);
    const goal = createTerminalBridgeGoal(db, {
      workspaceId: "w1", terminalSessionId: terminal.id, clientRequestId: "shutdown-goal", title: "Shutdown recovery",
    });
    const task = createTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: terminal.id, clientRequestId: "shutdown-task",
      goalId: String(goal.goal.id), task: { title: "Gracefully interrupted work" },
    });
    const taskId = String((task.task as Record<string, unknown>).id);
    updateTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: terminal.id, clientRequestId: "shutdown-start",
      taskId, status: "in_progress",
    });

    manager.killAll();

    expect(manager.get(terminal.id)).toMatchObject({
      status: "interrupted",
      pid: null,
      output: expect.stringContaining("OUTPUT_BEFORE_RESTART"),
    });
    expect(db.prepare("SELECT status, result_summary FROM tasks WHERE id = ?").get(taskId)).toMatchObject({
      status: "blocked",
      result_summary: expect.stringContaining("was interrupted"),
    });
  });

  it.skipIf(!tmuxAvailable)("reattaches to the same persistent shell without blocking its active task", async () => {
    const { db, manager, runtime } = setup(true, true);
    const terminal = manager.create("w1");
    expect(terminal).toMatchObject({ status: "active", backend: "tmux" });
    expect(manager.write(
      terminal.id,
      "printf 'INITIAL=%s:%s\\n' \"$CREWDECK_WORKSPACE_ID\" \"$CREWDECK_TERMINAL_ID\"; export CREWDECK_PERSIST_PROBE=same-shell\n",
    )).toBe(true);
    await waitUntil(() => manager.get(terminal.id)?.output.includes(`INITIAL=w1:${terminal.id}`) === true);

    const goal = createTerminalBridgeGoal(db, {
      workspaceId: "w1", terminalSessionId: terminal.id, clientRequestId: "persist-goal", title: "Persistent work",
    });
    const task = createTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: terminal.id, clientRequestId: "persist-task",
      goalId: String(goal.goal.id), task: { title: "Keep running" },
    });
    const taskId = String((task.task as Record<string, unknown>).id);
    db.prepare("INSERT INTO agents (id, project_id, name, role, status, current_task_id) VALUES ('persistent-agent', 'p1', 'Persistent Agent', 'coder', 'working', ?)")
      .run(taskId);
    db.prepare("UPDATE tasks SET assignee_id = 'persistent-agent' WHERE id = ?").run(taskId);
    db.prepare("UPDATE terminal_sessions SET agent_id = 'persistent-agent', active_task_id = ? WHERE id = ?")
      .run(taskId, terminal.id);
    updateTerminalBridgeTask(db, {
      workspaceId: "w1", terminalSessionId: terminal.id, clientRequestId: "persist-start",
      taskId, status: "in_progress",
    });
    expect(manager.write(
      terminal.id,
      "(sleep 0.4; printf '\\117\\125\\124\\120\\125\\124\\137\\127\\110\\111\\114\\105\\137\\123\\105\\122\\126\\105\\122\\137\\104\\117\\127\\116\\n') &\n",
    )).toBe(true);

    const socketName = `crewdeck-${createHash("sha256").update(runtime!.dataDir).digest("hex").slice(0, 12)}`;
    const environmentBeforeRestart = execFileSync("tmux", [
      "-L", socketName, "show-environment", "-t", `crewdeck-${terminal.id}`,
    ], { encoding: "utf8" });
    const tokenBeforeRestart = environmentBeforeRestart.split("\n")
      .find((line) => line.startsWith("CREWDECK_API_KEY="))?.slice("CREWDECK_API_KEY=".length);
    expect(tokenBeforeRestart).toBeTruthy();
    manager.killAll();
    expect(db.prepare("SELECT bridge_token_hash FROM terminal_sessions WHERE id = ?").get(terminal.id))
      .toEqual({ bridge_token_hash: createHash("sha256").update(tokenBeforeRestart!).digest("hex") });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(recoverOnStartup(db)).toMatchObject({ recoveredTasks: 0 });
    const recoveredManager = new TerminalManager(db, () => {}, runtime);
    managers.push(recoveredManager);

    const environmentAfterAttach = execFileSync("tmux", [
      "-L", socketName, "show-environment", "-t", `crewdeck-${terminal.id}`,
    ], { encoding: "utf8" });
    const tokenAfterAttach = environmentAfterAttach.split("\n")
      .find((line) => line.startsWith("CREWDECK_API_KEY="))?.slice("CREWDECK_API_KEY=".length);
    expect(tokenAfterAttach).toBeTruthy();
    expect(createHash("sha256").update(tokenAfterAttach!).digest("hex"))
      .toBe(createHash("sha256").update(tokenBeforeRestart!).digest("hex"));

    expect(recoveredManager.get(terminal.id)).toMatchObject({
      status: "active",
      backend: "tmux",
      pid: terminal.pid,
      contextState: "connected",
    });
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "in_progress" });
    expect(db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'persistent-agent'").get())
      .toEqual({ status: "working", current_task_id: taskId });
    expect(recoveredManager.get(terminal.id)?.output).toContain("OUTPUT_WHILE_SERVER_DOWN");
    expect(recoveredManager.write(terminal.id, "printf 'PERSIST=%s\\n' \"$CREWDECK_PERSIST_PROBE\"\n")).toBe(true);
    await waitUntil(() => recoveredManager.get(terminal.id)?.output.includes("PERSIST=same-shell") === true);
    // 스냅샷은 -e로 색을 보존하므로 ESC가 존재한다(과거에는 ESC가 전혀 없어야 한다고 못박았다).
    // 대신 커서 위치 복원으로 끝나는지를 고정한다 — 이게 빠지면 재진입 후 입력이 프롬프트가
    // 아니라 화면 맨 아래에 찍힌다.
    expect(recoveredManager.get(terminal.id)?.output).toMatch(/\u001b\[\d+;\d+H$/);

    recoveredManager.kill(terminal.id);
    await waitUntil(() => recoveredManager.get(terminal.id)?.status === "killed");
    expect(db.prepare("SELECT bridge_token_hash FROM terminal_sessions WHERE id = ?").get(terminal.id))
      .toEqual({ bridge_token_hash: null });
  });

  it.skipIf(!tmuxAvailable)("isolates Crewdeck context across persistent Workspace terminals", async () => {
    const { cwd, db, manager } = setup(true, true);
    const otherCwd = mkdtempSync(join(tmpdir(), "crewdeck-pty-other-"));
    tempDirs.push(otherCwd);
    db.exec(`
      INSERT INTO projects (id, name, source, workdir)
      VALUES ('p2', 'Other Project', 'new', '${otherCwd.replaceAll("'", "''")}');
    `);
    db.prepare(`
      INSERT INTO workspaces (
        id, project_id, name, kind, state, worktree_path, worktree_branch, setup_progress
      ) VALUES ('w2', 'p2', 'Other Workspace', 'manual', 'ready', ?, 'workspace/other', 100)
    `).run(otherCwd);

    const first = manager.create("w1");
    const second = manager.create("w2");
    expect(first).toMatchObject({ contextState: "connected", projectId: "p1", workspaceId: "w1" });
    expect(second).toMatchObject({ contextState: "connected", projectId: "p2", workspaceId: "w2" });

    const socketName = `crewdeck-${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`;
    const firstTokenLine = execFileSync("tmux", ["-L", socketName, "show-environment", "-t", `crewdeck-${first.id}`, "CREWDECK_API_KEY"], { encoding: "utf8" }).trim();
    const secondTokenLine = execFileSync("tmux", ["-L", socketName, "show-environment", "-t", `crewdeck-${second.id}`, "CREWDECK_API_KEY"], { encoding: "utf8" }).trim();
    const firstToken = firstTokenLine.slice(firstTokenLine.indexOf("=") + 1);
    const secondToken = secondTokenLine.slice(secondTokenLine.indexOf("=") + 1);
    const storedHashes = db.prepare("SELECT id, bridge_token_hash FROM terminal_sessions WHERE id IN (?, ?)")
      .all(first.id, second.id) as Array<{ id: string; bridge_token_hash: string }>;
    expect(new Map(storedHashes.map((row) => [row.id, row.bridge_token_hash]))).toEqual(new Map([
      [first.id, createHash("sha256").update(firstToken).digest("hex")],
      [second.id, createHash("sha256").update(secondToken).digest("hex")],
    ]));
    expect(createHash("sha256").update(firstToken).digest("hex"))
      .not.toBe(createHash("sha256").update(secondToken).digest("hex"));
    const processCommands = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
    expect(processCommands.includes(firstToken)).toBe(false);
    expect(processCommands.includes(secondToken)).toBe(false);
    const configPath = join(cwd, "terminal-runtime", "tmux.conf");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const tmuxConfig = readFileSync(configPath, "utf8");
    expect(tmuxConfig.includes(firstToken)).toBe(false);
    expect(tmuxConfig.includes(secondToken)).toBe(false);
    const userId = typeof process.getuid === "function" ? process.getuid() : 0;
    const socketPath = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userId}`, socketName);
    expect(statSync(socketPath).mode & 0o077).toBe(0);

    manager.write(first.id, "printf 'FIRST=%s:%s:%s\\n' \"$CREWDECK_PROJECT_ID\" \"$CREWDECK_WORKSPACE_ID\" \"$CREWDECK_TERMINAL_ID\"\n");
    manager.write(second.id, "printf 'SECOND=%s:%s:%s\\n' \"$CREWDECK_PROJECT_ID\" \"$CREWDECK_WORKSPACE_ID\" \"$CREWDECK_TERMINAL_ID\"\n");
    await waitUntil(() => manager.get(first.id)?.output.includes(`FIRST=p1:w1:${first.id}`) === true);
    await waitUntil(() => manager.get(second.id)?.output.includes(`SECOND=p2:w2:${second.id}`) === true);

    manager.killAll({ preservePersistent: false });
    const revoked = db.prepare("SELECT id, bridge_token_hash FROM terminal_sessions WHERE id IN (?, ?)")
      .all(first.id, second.id) as Array<{ id: string; bridge_token_hash: string | null }>;
    expect(new Map(revoked.map((row) => [row.id, row.bridge_token_hash]))).toEqual(new Map([
      [first.id, null],
      [second.id, null],
    ]));
    expect(existsSync(socketPath)).toBe(false);
  });

  it("injects the Crewdeck bridge and AI wrappers into the local shell", async () => {
    const { cwd, events, manager } = setup(true);
    const terminal = manager.create("w1");
    expect(terminal.backend).toBe("pty");
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

  it("falls back to PTY without argv secrets and revokes tokens on kill and natural exit", async () => {
    const { db, manager } = setup(true, false, { command: "/crewdeck-test/missing-tmux", args: [] });
    const killed = manager.create("w1");
    expect(killed).toMatchObject({ backend: "pty", contextState: "connected", status: "active" });
    expect(db.prepare("SELECT bridge_token_hash FROM terminal_sessions WHERE id = ?").get(killed.id))
      .toMatchObject({ bridge_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    manager.kill(killed.id);
    await waitUntil(() => manager.get(killed.id)?.status === "killed");
    expect(db.prepare("SELECT bridge_token_hash FROM terminal_sessions WHERE id = ?").get(killed.id))
      .toEqual({ bridge_token_hash: null });

    const exited = manager.create("w1");
    expect(manager.write(exited.id, "exit\n")).toBe(true);
    await waitUntil(() => manager.get(exited.id)?.status === "exited");
    expect(db.prepare("SELECT bridge_token_hash FROM terminal_sessions WHERE id = ?").get(exited.id))
      .toEqual({ bridge_token_hash: null });
  });
});
