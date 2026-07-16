import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";

const ROOT = resolve(import.meta.dirname, "../..");
const NODE_BIN = dirname(process.execPath);
const cleanupDirs: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const sockets = new Set<WebSocket>();

const tmuxAvailable = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function tmuxSocketName(dataDir: string): string {
  return `crewdeck-${createHash("sha256").update(dataDir).digest("hex").slice(0, 12)}`;
}

function killTmuxServer(dataDir: string): void {
  const socketName = tmuxSocketName(dataDir);
  try {
    execFileSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
  } catch {
    // The test may have already removed its last tmux session and socket.
  }
  try {
    execFileSync("tmux", ["-L", socketName, "list-sessions"], { stdio: "ignore" });
    return;
  } catch {
    // No live server remains; only this test's exact hashed socket may be stale.
  }
  const userId = typeof process.getuid === "function" ? process.getuid() : 0;
  const socketPath = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userId}`, socketName);
  try { unlinkSync(socketPath); } catch { /* stale socket already removed */ }
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Crewdeck server did not stop")), 10_000)),
  ]);
  children.delete(child);
}

afterEach(async () => {
  for (const socket of sockets) {
    try { socket.close(); } catch { /* already closed */ }
  }
  sockets.clear();
  for (const child of [...children]) {
    try { await stopServer(child); } catch { child.kill("SIGKILL"); }
  }
  for (const dir of cleanupDirs) killTmuxServer(dir);
  for (const dir of cleanupDirs.splice(0).reverse()) rmSync(dir, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve an E2E port");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function createGitRepo(parent: string): string {
  const repo = join(parent, "project");
  execFileSync("mkdir", ["-p", repo]);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@crewdeck.local");
  git("config", "user.name", "Crewdeck Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), ".crewdeck-worktrees/\n.claude/worktrees/\n");
  writeFileSync(join(repo, "README.md"), "# terminal orchestration dogfood\n");
  git("add", ".");
  git("commit", "-m", "base");
  return repo;
}

function createFakeCodex(parent: string): string {
  const bin = join(parent, "fake-bin");
  execFileSync("mkdir", ["-p", bin]);
  const executable = join(bin, "codex");
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-dogfood 0.0.0\\n'
  exit 0
fi
export CREWDECK_DOGFOOD_PERSIST=same-shell
printf 'FAKE_CODEX_READY=%s:%s\\n' "$CREWDECK_WORKSPACE_ID" "$CREWDECK_TERMINAL_ID"
while IFS= read -r command; do
  case "$command" in
    probe-after-restart)
      printf 'persistent terminal evidence\\n' > terminal-dogfood-proof.txt
      if crewdeck-sync context >/dev/null 2>&1; then
        printf 'AFTER_RESTART=%s:%s:%s\\n' "$CREWDECK_DOGFOOD_PERSIST" "$CREWDECK_WORKSPACE_ID" "$CREWDECK_TERMINAL_ID"
        printf 'BRIDGE_CONTEXT_OK\\n'
      else
        printf 'BRIDGE_CONTEXT_FAILED\\n'
      fi
      ;;
    stop-fake)
      exit 0
      ;;
    *)
      printf 'FAKE_CODEX_INPUT=%s\\n' "$command"
      ;;
  esac
done
`, { mode: 0o755 });
  return bin;
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  let latest: T;
  while (true) {
    latest = await read();
    if (accept(latest)) return latest;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for dogfood runtime state");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function startCrewdeck(input: {
  port: number;
  dataDir: string;
  fakeBin: string;
  shellConfig: string;
}): Promise<{ child: ChildProcessWithoutNullStreams; baseUrl: string; apiKey: string; output: () => string }> {
  let logs = "";
  const child = spawn(resolve(ROOT, "node_modules/.bin/tsx"), [resolve(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${input.fakeBin}:${NODE_BIN}:${process.env.PATH ?? ""}`,
      PORT: String(input.port),
      CREWDECK_DATA_DIR: input.dataDir,
      CREWDECK_NO_AUTO_QUEUE: "true",
      SHELL: "/bin/zsh",
      ZDOTDIR: input.shellConfig,
    },
    stdio: "pipe",
  });
  children.add(child);
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${input.port}`;
  await waitFor(
    async () => {
      try { return (await fetch(`${baseUrl}/api/health`)).ok; } catch { return false; }
    },
    Boolean,
    15_000,
  ).catch((error) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.slice(-4_000)}`);
  });
  const keyPath = join(input.dataDir, "api-key");
  await waitFor(async () => existsSync(keyPath), Boolean);
  return { child, baseUrl, apiKey: readFileSync(keyPath, "utf8").trim(), output: () => logs };
}

async function api<T>(
  runtime: { baseUrl: string; apiKey: string },
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${runtime.baseUrl}/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${runtime.apiKey}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function terminalSocket(
  runtime: { baseUrl: string; apiKey: string },
  terminalId: string,
): Promise<{ socket: WebSocket; messages: Array<Record<string, any>> }> {
  const url = runtime.baseUrl.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(runtime.apiKey)}`;
  const socket = new WebSocket(url);
  sockets.add(socket);
  const messages: Array<Record<string, any>> = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, any>));
  await once(socket, "open");
  await waitFor(async () => messages, (items) => items.some((message) => message.type === "connected"));
  socket.send(JSON.stringify({ type: "subscribe:terminal", terminalId }));
  await waitFor(async () => messages, (items) => items.some((message) => message.type === "terminal:snapshot"));
  return { socket, messages };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("terminal orchestration dogfood", () => {
  it.skipIf(!tmuxAvailable)("관통: DAG claim, bridge evidence, 재기동 PTY 복구, 누수 없는 teardown", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join("/tmp", "crewdeck-terminal-dogfood-"));
    const dataDir = join(root, "data");
    const shellConfig = join(root, "shell-config");
    execFileSync("mkdir", ["-p", dataDir, shellConfig]);
    cleanupDirs.push(dataDir, root);
    const repo = createGitRepo(root);
    const fakeBin = createFakeCodex(root);
    const port = await availablePort();
    let runtime = await startCrewdeck({ port, dataDir, fakeBin, shellConfig });

    const project = await api<Record<string, any>>(runtime, "/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Terminal Dogfood",
        source: "local_import",
        workdir: repo,
      }),
    });
    const agent = await api<Record<string, any>>(runtime, "/agents", {
      method: "POST",
      body: JSON.stringify({ project_id: project.id, name: "Dogfood Coder", role: "coder", provider: "codex" }),
    });
    const workspace = await api<Record<string, any>>(runtime, "/workspaces", {
      method: "POST",
      body: JSON.stringify({ projectId: project.id, name: "Terminal Dogfood Workspace" }),
    });
    expect(workspace).toMatchObject({ kind: "manual", state: "ready", pathExists: true });
    expect(existsSync(workspace.worktreePath)).toBe(true);

    const terminal = await api<Record<string, any>>(runtime, "/terminals", {
      method: "POST",
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    expect(terminal).toMatchObject({ workspaceId: workspace.id, backend: "tmux", contextState: "connected" });
    const initialPanePid = Number(terminal.pid);
    expect(processExists(initialPanePid)).toBe(true);

    const created = await api<Record<string, any>>(runtime, "/terminal-bridge/goals", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: workspace.id,
        terminalSessionId: terminal.id,
        clientRequestId: "dogfood-goal",
        title: "Terminal orchestration dogfood",
        tasks: [
          { title: "Completed prerequisite", assigneeId: agent.id },
          { title: "Persistent terminal target", assigneeId: agent.id },
        ],
      }),
    });
    const [prerequisite, target] = created.tasks as Array<Record<string, any>>;
    for (const status of ["in_progress", "in_review", "done"]) {
      await api(runtime, `/tasks/${prerequisite.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
    }
    await api(runtime, `/tasks/graph/${created.goal.id}`, {
      method: "PATCH",
      body: JSON.stringify({ tasks: [{ id: target.id, depends_on: [prerequisite.id] }] }),
    });
    const graph = await api<Record<string, any>>(runtime, `/tasks/graph/${created.goal.id}`);
    expect(graph.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: prerequisite.id, status: "done", execution_state: "complete" }),
      expect.objectContaining({ id: target.id, status: "todo", depends_on: [prerequisite.id], blocked_by: [], execution_state: "ready" }),
    ]));

    await api(runtime, `/terminals/${terminal.id}/binding`, {
      method: "PATCH",
      body: JSON.stringify({ goalId: created.goal.id, agentId: agent.id, provider: "codex" }),
    });
    const started = await api<Record<string, any>>(runtime, `/terminals/${terminal.id}/start-next`, {
      method: "POST",
      body: JSON.stringify({ goalId: created.goal.id, agentId: agent.id, provider: "codex" }),
    });
    expect(started).toMatchObject({
      task: { id: target.id, title: "Persistent terminal target", status: "in_progress" },
      provider: "codex",
      launchState: "requested",
    });
    const beforeRestart = await waitFor(
      () => api<Record<string, any>>(runtime, `/terminals/${terminal.id}`),
      (value) => String(value.output).includes(`FAKE_CODEX_READY=${workspace.id}:${terminal.id}`),
    );
    expect(beforeRestart).toMatchObject({ pid: initialPanePid, backend: "tmux", contextState: "connected" });

    const startActivities = await api<Record<string, any>>(
      runtime,
      `/terminal-activities?workspaceId=${workspace.id}&terminalSessionId=${terminal.id}&limit=100`,
    );
    expect(startActivities.items.map((item: Record<string, any>) => item.kind)).toEqual(expect.arrayContaining([
      "task_claimed",
      "provider_launch_requested",
    ]));
    const bridgeEvents = await api<Array<Record<string, any>>>(
      runtime,
      `/terminal-bridge/events?workspaceId=${workspace.id}&goalId=${created.goal.id}`,
    );
    expect(bridgeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "goal_created", goalId: created.goal.id }),
    ]));

    await stopServer(runtime.child);
    expect(processExists(runtime.child.pid!)).toBe(false);
    expect(processExists(initialPanePid)).toBe(true);

    runtime = await startCrewdeck({ port, dataDir, fakeBin, shellConfig });
    const recovered = await api<Record<string, any>>(runtime, `/terminals/${terminal.id}`);
    expect(recovered).toMatchObject({
      id: terminal.id,
      pid: initialPanePid,
      backend: "tmux",
      status: "active",
      contextState: "connected",
      activeTaskId: target.id,
      activeTaskStatus: "in_progress",
    });
    expect(String(recovered.output)).toContain(`FAKE_CODEX_READY=${workspace.id}:${terminal.id}`);

    const ws = await terminalSocket(runtime, terminal.id);
    const snapshot = ws.messages.find((message) => message.type === "terminal:snapshot");
    expect(String(snapshot?.payload?.data)).toContain(`FAKE_CODEX_READY=${workspace.id}:${terminal.id}`);
    ws.socket.send(JSON.stringify({ type: "terminal:input", terminalId: terminal.id, data: "probe-after-restart\n" }));
    const afterRestart = await waitFor(
      () => api<Record<string, any>>(runtime, `/terminals/${terminal.id}`),
      (value) => String(value.output).includes(`AFTER_RESTART=same-shell:${workspace.id}:${terminal.id}`)
        && String(value.output).includes("BRIDGE_CONTEXT_OK"),
    );
    expect(afterRestart.pid).toBe(initialPanePid);
    expect(afterRestart.output).not.toContain("BRIDGE_CONTEXT_FAILED");

    const diff = await api<Record<string, any>>(runtime, `/workspaces/${workspace.id}/diff`);
    expect(diff.diff).toContain("terminal-dogfood-proof.txt");
    expect(diff.diff).toContain("persistent terminal evidence");
    const blocked = await api<Record<string, any>>(runtime, `/terminal-bridge/tasks/${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        workspaceId: workspace.id,
        terminalSessionId: terminal.id,
        clientRequestId: "dogfood-blocked",
        status: "blocked",
        summary: "Deterministic runtime failure for decision recovery",
      }),
    });
    expect(blocked).toMatchObject({
      task: { id: target.id, status: "blocked" },
      evidence: { dirty: true, changedFiles: expect.arrayContaining(["terminal-dogfood-proof.txt"]) },
    });
    const decided = await api<Record<string, any>>(runtime, `/terminals/${terminal.id}/decisions`, {
      method: "POST",
      body: JSON.stringify({ message: "Keep the persisted PTY evidence and retry the same task" }),
    });
    expect(decided).toMatchObject({
      decision: { terminalSessionId: terminal.id, taskId: target.id },
      task: { id: target.id, status: "in_progress" },
    });

    const review = await api<Record<string, any>>(runtime, `/terminals/${terminal.id}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: "dogfood-review",
        summary: "Persistent terminal implementation is ready for deterministic Quality Gate handoff",
        changedFiles: ["terminal-dogfood-proof.txt"],
        verificationCommands: ["git diff --check"],
      }),
    });
    expect(review).toMatchObject({
      replayed: false,
      review: {
        status: "pending",
        taskId: target.id,
        evidence: {
          changedFiles: ["terminal-dogfood-proof.txt"],
          verificationCommands: ["git diff --check"],
        },
      },
      task: { id: target.id, status: "in_review" },
    });
    const finalActivities = await api<Record<string, any>>(
      runtime,
      `/terminal-activities?workspaceId=${workspace.id}&terminalSessionId=${terminal.id}&limit=100`,
    );
    expect(finalActivities.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "completion_requested", taskId: target.id }),
    ]));

    await api(runtime, `/terminals/${terminal.id}`, { method: "DELETE" });
    await waitFor(
      () => api<Record<string, any>>(runtime, `/terminals/${terminal.id}`),
      (value) => value.status === "killed",
    );
    expect(processExists(initialPanePid)).toBe(false);
    expect(() => execFileSync("tmux", [
      "-L", tmuxSocketName(dataDir), "has-session", "-t", `crewdeck-${terminal.id}`,
    ], { stdio: "ignore" })).toThrow();

    await api(runtime, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmDirty: true }),
    });
    expect(existsSync(workspace.worktreePath)).toBe(false);
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }))
      .not.toContain(workspace.worktreePath);
    expect(execFileSync("git", ["branch", "--list", workspace.worktreeBranch], { cwd: repo, encoding: "utf8" }).trim())
      .toBe("");

    ws.socket.close();
    sockets.delete(ws.socket);
    await stopServer(runtime.child);
    expect(processExists(runtime.child.pid!)).toBe(false);
    expect(existsSync(join(dataDir, "server.pid"))).toBe(false);
    expect(runtime.output()).not.toContain("Failed to start server");
  });
});
