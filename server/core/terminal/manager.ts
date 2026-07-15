import type { Database } from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { TerminalSession, TerminalSessionStatus } from "../../../shared/types.js";
import { TERMINAL_AGENT_PROMPT } from "../../../shared/terminal-agent.js";
import { finishTerminalBridgeAgentRun } from "./bridge.js";

const MAX_OUTPUT = 200 * 1024;

function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const packageRoot = resolve(dirname(require.resolve("node-pty")), "..");
    for (const helper of [
      resolve(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      resolve(packageRoot, "build", "Release", "spawn-helper"),
    ]) {
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  } catch {
    // node-pty will surface a concrete spawn error if its helper is unavailable.
  }
}

interface TerminalRow {
  id: string;
  workspace_id: string;
  project_id: string;
  shell: string;
  cwd: string;
  pid: number | null;
  cols: number;
  rows: number;
  status: TerminalSessionStatus;
  exit_code: number | null;
  last_output: string;
  started_at: string;
  ended_at: string | null;
}

interface ActiveTerminal {
  pty: IPty;
  output: string;
  stopStatus: "killed" | "interrupted" | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalCommand {
  command: string;
  args: string[];
}

export interface TerminalRuntimeOptions {
  dataDir: string;
  apiBaseUrl: string;
  syncCommand: TerminalCommand;
  mcpCommand: TerminalCommand;
}

export type TerminalEvent =
  | { type: "terminal:data"; payload: { terminalId: string; data: string } }
  | { type: "terminal:exit"; payload: {
    terminalId: string;
    workspaceId: string;
    projectId: string;
    status: TerminalSessionStatus;
    exitCode: number | null;
  } };

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function toModel(row: TerminalRow, output?: string): TerminalSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    shell: row.shell,
    cwd: row.cwd,
    pid: row.pid,
    cols: row.cols,
    rows: row.rows,
    status: row.status,
    exitCode: row.exit_code,
    output: output ?? row.last_output ?? "",
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class TerminalManager {
  private readonly active = new Map<string, ActiveTerminal>();
  private shuttingDown = false;

  constructor(
    private readonly db: Database,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly runtime?: TerminalRuntimeOptions,
  ) {
    ensureSpawnHelperExecutable();
    this.ensureShellIntegration();
    // A PTY cannot survive the server process. Preserve the history while making
    // the stale status explicit instead of pretending the old PID is attached.
    this.db.prepare(`
      UPDATE terminal_sessions
         SET status = 'interrupted', pid = NULL, ended_at = datetime('now')
       WHERE status = 'active'
    `).run();
  }

  create(workspaceId: string, size: { cols?: number; rows?: number } = {}): TerminalSession {
    const workspace = this.db.prepare(`
      SELECT id, project_id, worktree_path, state
        FROM workspaces
       WHERE id = ?
    `).get(workspaceId) as {
      id: string;
      project_id: string;
      worktree_path: string | null;
      state: string;
    } | undefined;

    if (!workspace) throw new Error("Workspace not found");
    if (workspace.state !== "ready" || !workspace.worktree_path || !existsSync(workspace.worktree_path)) {
      throw new Error("Workspace is not ready");
    }

    const shell = process.env.SHELL && existsSync(process.env.SHELL)
      ? process.env.SHELL
      : existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
    const cols = clamp(size.cols ?? 120, 20, 400, 120);
    const rows = clamp(size.rows ?? 32, 5, 200, 32);
    const id = randomUUID().replaceAll("-", "").slice(0, 16);
    const bridgeToken = this.runtime ? randomBytes(32).toString("hex") : null;
    const bridgeTokenHash = bridgeToken ? createHash("sha256").update(bridgeToken).digest("hex") : null;
    const runtimeDir = this.runtime ? resolve(this.runtime.dataDir, "terminal-runtime") : null;
    const terminalEnv: Record<string, string | undefined> = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CREWDECK_WORKSPACE_ID: workspace.id,
      CREWDECK_PROJECT_ID: workspace.project_id,
      CREWDECK_TERMINAL_ID: id,
    };
    if (this.runtime && runtimeDir) {
      terminalEnv.CREWDECK_API_URL = this.runtime.apiBaseUrl;
      terminalEnv.CREWDECK_API_KEY = bridgeToken!;
      terminalEnv.CREWDECK_AGENT_PROMPT = TERMINAL_AGENT_PROMPT;
      terminalEnv.CREWDECK_AGENT_PROMPT_FILE = resolve(runtimeDir, "agent-prompt.txt");
      terminalEnv.CREWDECK_MCP_CONFIG = resolve(runtimeDir, "claude-mcp.json");
      terminalEnv.CREWDECK_MCP_COMMAND = this.runtime.mcpCommand.command;
      terminalEnv.CREWDECK_MCP_ARGS_TOML = JSON.stringify(this.runtime.mcpCommand.args);
      terminalEnv.CREWDECK_ORIGINAL_ZDOTDIR = process.env.ZDOTDIR ?? process.env.HOME ?? "";
      terminalEnv.PATH = `${resolve(runtimeDir, "bin")}:${process.env.PATH ?? ""}`;
      const codexHome = resolve(runtimeDir, "codex-home", id);
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      const userCodexHome = process.env.CODEX_HOME
        ?? (process.env.HOME ? resolve(process.env.HOME, ".codex") : null);
      const userCodexAuth = userCodexHome ? resolve(userCodexHome, "auth.json") : null;
      const isolatedCodexAuth = resolve(codexHome, "auth.json");
      if (userCodexAuth && existsSync(userCodexAuth) && !existsSync(isolatedCodexAuth)) {
        symlinkSync(userCodexAuth, isolatedCodexAuth);
      }
      const tomlString = (value: string) => JSON.stringify(value);
      writeFileSync(resolve(codexHome, "config.toml"), [
        "developer_instructions = " + tomlString(TERMINAL_AGENT_PROMPT),
        "",
        "[mcp_servers.crewdeck]",
        "command = " + tomlString(this.runtime.mcpCommand.command),
        "args = [" + this.runtime.mcpCommand.args.map(tomlString).join(", ") + "]",
        "",
        "[mcp_servers.crewdeck.env]",
        "CREWDECK_API_URL = " + tomlString(this.runtime.apiBaseUrl),
        "CREWDECK_API_KEY = " + tomlString(bridgeToken!),
        "CREWDECK_WORKSPACE_ID = " + tomlString(workspace.id),
        "CREWDECK_PROJECT_ID = " + tomlString(workspace.project_id),
        "CREWDECK_TERMINAL_ID = " + tomlString(id),
        "",
      ].join("\n"), { mode: 0o600 });
      terminalEnv.CREWDECK_CODEX_HOME = codexHome;
      if (shell.endsWith("/zsh")) terminalEnv.ZDOTDIR = runtimeDir;
    }
    const shellArgs = shell.endsWith("/bash") && runtimeDir
      ? ["--rcfile", resolve(runtimeDir, "bashrc"), "-i"]
      : ["-l"];
    const terminal = spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: workspace.worktree_path,
      env: terminalEnv,
    });

    this.db.prepare(`
      INSERT INTO terminal_sessions (
        id, workspace_id, project_id, shell, cwd, pid, bridge_token_hash, cols, rows, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(id, workspace.id, workspace.project_id, shell, workspace.worktree_path, terminal.pid, bridgeTokenHash, cols, rows);

    const active: ActiveTerminal = { pty: terminal, output: "", stopStatus: null, flushTimer: null };
    this.active.set(id, active);

    terminal.onData((data) => {
      active.output = `${active.output}${data}`.slice(-MAX_OUTPUT);
      if (!active.flushTimer) {
        active.flushTimer = setTimeout(() => {
          active.flushTimer = null;
          this.db.prepare("UPDATE terminal_sessions SET last_output = ? WHERE id = ? AND status = 'active'")
            .run(active.output, id);
        }, 250);
      }
      this.emit({ type: "terminal:data", payload: { terminalId: id, data } });
    });
    terminal.onExit(({ exitCode }) => {
      if (active.flushTimer) clearTimeout(active.flushTimer);
      if (this.shuttingDown) {
        this.active.delete(id);
        return;
      }
      const status: TerminalSessionStatus = active.stopStatus ?? "exited";
      this.db.prepare(`
        UPDATE terminal_sessions
           SET status = ?, exit_code = ?, pid = NULL, last_output = ?, ended_at = datetime('now')
         WHERE id = ?
      `).run(status, exitCode, active.output, id);
      try {
        finishTerminalBridgeAgentRun(this.db, {
          workspaceId: workspace.id,
          terminalSessionId: id,
          clientRequestId: "terminal-exit-" + id + "-" + randomUUID(),
          provider: status === "killed" ? "terminal session" : "shell",
          exitCode: exitCode ?? -1,
        });
      } catch {
        // Terminal status is authoritative even when there is no bridge task to reconcile.
      }
      this.active.delete(id);
      this.emit({
        type: "terminal:exit",
        payload: { terminalId: id, workspaceId: workspace.id, projectId: workspace.project_id, status, exitCode },
      });
    });

    return this.get(id)!;
  }

  private ensureShellIntegration(): void {
    if (!this.runtime) return;
    const runtimeDir = resolve(this.runtime.dataDir, "terminal-runtime");
    const binDir = resolve(runtimeDir, "bin");
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const syncWrapper = resolve(binDir, "crewdeck-sync");
    writeFileSync(
      syncWrapper,
      `#!/bin/sh\nexec ${[this.runtime.syncCommand.command, ...this.runtime.syncCommand.args].map(shellQuote).join(" ")} "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(syncWrapper, 0o700);
    writeFileSync(resolve(runtimeDir, "agent-prompt.txt"), `${TERMINAL_AGENT_PROMPT}\n`, { mode: 0o600 });
    writeFileSync(resolve(runtimeDir, "claude-mcp.json"), JSON.stringify({
      mcpServers: {
        crewdeck: {
          command: this.runtime.mcpCommand.command,
          args: this.runtime.mcpCommand.args,
        },
      },
    }, null, 2), { mode: 0o600 });

    const zshSource = (file: string) => `
if [[ -n "$CREWDECK_ORIGINAL_ZDOTDIR" && -f "$CREWDECK_ORIGINAL_ZDOTDIR/${file}" ]]; then
  _crewdeck_zdotdir="$ZDOTDIR"
  ZDOTDIR="$CREWDECK_ORIGINAL_ZDOTDIR"
  source "$CREWDECK_ORIGINAL_ZDOTDIR/${file}"
  ZDOTDIR="$_crewdeck_zdotdir"
  unset _crewdeck_zdotdir
fi
`;
    writeFileSync(resolve(runtimeDir, ".zshenv"), zshSource(".zshenv"), { mode: 0o600 });
    writeFileSync(resolve(runtimeDir, ".zprofile"), zshSource(".zprofile"), { mode: 0o600 });
    writeFileSync(resolve(runtimeDir, ".zlogin"), zshSource(".zlogin"), { mode: 0o600 });
    writeFileSync(resolve(runtimeDir, ".zlogout"), zshSource(".zlogout"), { mode: 0o600 });
    writeFileSync(resolve(runtimeDir, ".zshrc"), `${zshSource(".zshrc")}
export PATH=${shellQuote(binDir)}:"$PATH"
export CREWDECK_CLAUDE_BIN="$(whence -p claude 2>/dev/null)"
export CREWDECK_CODEX_BIN="$(whence -p codex 2>/dev/null)"
if [[ -n "$CREWDECK_CLAUDE_BIN" ]]; then
  claude() {
    "$CREWDECK_CLAUDE_BIN" --strict-mcp-config --mcp-config "$CREWDECK_MCP_CONFIG" --append-system-prompt "$CREWDECK_AGENT_PROMPT" "$@"
    local _crewdeck_exit=$?
    crewdeck-sync agent-exit --provider claude --exit-code "$_crewdeck_exit" >/dev/null 2>&1 || true
    return "$_crewdeck_exit"
  }
fi
if [[ -n "$CREWDECK_CODEX_BIN" ]]; then
  codex() {
    CODEX_HOME="$CREWDECK_CODEX_HOME" "$CREWDECK_CODEX_BIN" "$@"
    local _crewdeck_exit=$?
    crewdeck-sync agent-exit --provider codex --exit-code "$_crewdeck_exit" >/dev/null 2>&1 || true
    return "$_crewdeck_exit"
  }
fi
`, { mode: 0o600 });
    writeFileSync(resolve(runtimeDir, "bashrc"), `
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
export PATH=${shellQuote(binDir)}:"$PATH"
export CREWDECK_CLAUDE_BIN="$(type -P claude 2>/dev/null)"
export CREWDECK_CODEX_BIN="$(type -P codex 2>/dev/null)"
claude() {
  "$CREWDECK_CLAUDE_BIN" --strict-mcp-config --mcp-config "$CREWDECK_MCP_CONFIG" --append-system-prompt "$CREWDECK_AGENT_PROMPT" "$@"
  local _crewdeck_exit=$?
  crewdeck-sync agent-exit --provider claude --exit-code "$_crewdeck_exit" >/dev/null 2>&1 || true
  return "$_crewdeck_exit"
}
codex() {
  CODEX_HOME="$CREWDECK_CODEX_HOME" "$CREWDECK_CODEX_BIN" "$@"
  local _crewdeck_exit=$?
  crewdeck-sync agent-exit --provider codex --exit-code "$_crewdeck_exit" >/dev/null 2>&1 || true
  return "$_crewdeck_exit"
}
`, { mode: 0o600 });
  }

  list(workspaceId: string): TerminalSession[] {
    const rows = this.db.prepare(`
      SELECT * FROM terminal_sessions WHERE workspace_id = ? ORDER BY started_at DESC
    `).all(workspaceId) as TerminalRow[];
    return rows.map((row) => toModel(row, this.active.get(row.id)?.output));
  }

  get(id: string): TerminalSession | null {
    const row = this.db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as TerminalRow | undefined;
    return row ? toModel(row, this.active.get(id)?.output) : null;
  }

  write(id: string, data: string): boolean {
    const terminal = this.active.get(id);
    if (!terminal || typeof data !== "string" || data.length > 64 * 1024) return false;
    terminal.pty.write(data);
    return true;
  }

  resize(id: string, colsInput: number, rowsInput: number): boolean {
    const terminal = this.active.get(id);
    if (!terminal) return false;
    const cols = clamp(colsInput, 20, 400, 120);
    const rows = clamp(rowsInput, 5, 200, 32);
    terminal.pty.resize(cols, rows);
    this.db.prepare("UPDATE terminal_sessions SET cols = ?, rows = ? WHERE id = ?").run(cols, rows, id);
    return true;
  }

  kill(id: string): TerminalSession | null {
    const terminal = this.active.get(id);
    if (!terminal) return this.get(id);
    terminal.stopStatus = "killed";
    terminal.pty.kill();
    return this.get(id);
  }

  killAll(): void {
    this.shuttingDown = true;
    for (const [id, terminal] of this.active) {
      terminal.stopStatus = "interrupted";
      if (terminal.flushTimer) clearTimeout(terminal.flushTimer);
      try { terminal.pty.kill(); } catch { /* best effort during shutdown */ }
      this.db.prepare(`
        UPDATE terminal_sessions
           SET status = 'interrupted', pid = NULL, last_output = ?, ended_at = datetime('now')
         WHERE id = ? AND status = 'active'
      `).run(terminal.output, id);
    }
  }
}
