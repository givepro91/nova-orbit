import type { Database } from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { AgentProvider, TerminalSession, TerminalSessionStatus } from "../../../shared/types.js";
import { TERMINAL_AGENT_PROMPT } from "../../../shared/terminal-agent.js";
import { detectRunningAgent } from "./agent-detect.js";
import { codexTrustEntry } from "../agent/codex-trust.js";
import { grantClaudeTrust } from "../agent/claude-trust.js";
import { finishTerminalBridgeAgentRun } from "./bridge.js";
import { recoverInterruptedTask } from "../recovery.js";
import { sanitizeReplayOutput, splitTerminalReplies } from "./escape-filter.js";
import { TmuxBackend, type TmuxCommand } from "./tmux.js";

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
  tab_number: number;
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
  backend: "pty" | "tmux";
  runtime_id: string | null;
  bridge_token_hash: string | null;
  goal_id: string | null;
  goal_title: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_role: string | null;
  active_task_id: string | null;
  active_task_title: string | null;
  active_task_status: TerminalSession["activeTaskStatus"];
  provider: TerminalSession["provider"];
}

interface ActiveTerminal {
  pty: IPty;
  output: string;
  backend: "pty" | "tmux";
  runtimeId: string | null;
  stopStatus: "killed" | "interrupted" | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  inputReady: boolean;
  pendingInput: string;
  inputReadyTimer: ReturnType<typeof setTimeout> | null;
  /** 마지막으로 PTY 출력이 있었던 시각 — 무인 실행이 입력 대기로 멈춘 것을 감지하는 신호. */
  lastDataAt: number;
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
  tmuxCommand?: TmuxCommand | null;
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

const UTF8_LOCALE = "en_US.UTF-8";

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * PTY 환경에 UTF-8 로케일을 보장한다. launchd로 기동하면 LANG/LC_* 가 아예 없는데,
 * tmux는 LC_ALL > LC_CTYPE > LANG 중 첫 값에 "UTF-8"이 없으면 non-UTF-8 클라이언트로
 * 붙어(client_utf8=0) 멀티바이트 입력·출력을 '_'로 뭉갠다. 셸과 claude/codex CLI의
 * 한글 출력도 같은 이유로 깨진다. 이미 UTF-8이면 사용자 설정을 그대로 둔다.
 */
function withUtf8Locale<T extends Record<string, string | undefined>>(env: T): T {
  const configured = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
  if (configured && /utf-?8/i.test(configured)) return env;
  return { ...env, LANG: env.LANG ?? UTF8_LOCALE, LC_CTYPE: UTF8_LOCALE };
}

function toModel(
  row: TerminalRow,
  output?: string,
  contextState: TerminalSession["contextState"] = "unknown",
  replaySuffix = "",
): TerminalSession {
  return {
    id: row.id,
    tabNumber: row.tab_number,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    shell: row.shell,
    cwd: row.cwd,
    pid: row.pid,
    cols: row.cols,
    rows: row.rows,
    status: row.status,
    exitCode: row.exit_code,
    // 리플레이 버퍼의 디바이스 질의·마우스 모드는 새 xterm에서 junk 입력을 유발한다.
    // 단 살아 있는 팬이 실제로 켜 둔 마우스 모드는 sanitize 뒤에 되살린다 — 이게 없으면
    // 새로고침한 xterm이 휠을 앱에 전달하지 못해 alt-screen TUI의 자체 스크롤이 죽는다.
    output: `${sanitizeReplayOutput(output ?? row.last_output ?? "")}${replaySuffix}`,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    backend: row.backend,
    contextState,
    goalId: row.goal_id,
    goalTitle: row.goal_title,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentRole: row.agent_role,
    activeTaskId: row.active_task_id,
    activeTaskTitle: row.active_task_title,
    activeTaskStatus: row.active_task_status,
    provider: row.provider,
  };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export class TerminalManager {
  private readonly active = new Map<string, ActiveTerminal>();
  private readonly tmux: TmuxBackend | null;
  private shuttingDown = false;

  constructor(
    private readonly db: Database,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly runtime?: TerminalRuntimeOptions,
  ) {
    ensureSpawnHelperExecutable();
    this.ensureShellIntegration();
    this.tmux = this.runtime
      ? TmuxBackend.detect(this.runtime.dataDir, this.runtime.tmuxCommand)
      : null;
    const staleTerminals = this.db.prepare(`
      SELECT * FROM terminal_sessions WHERE status = 'active'
    `).all() as TerminalRow[];
    for (const terminal of staleTerminals) {
      if (terminal.backend === "tmux" && terminal.runtime_id && this.recoverPersistentTerminal(terminal)) {
        continue;
      }
      this.db.prepare(`
        UPDATE terminal_sessions
           SET status = 'interrupted', pid = NULL, bridge_token_hash = NULL,
               ended_at = datetime('now')
         WHERE id = ? AND status = 'active'
      `).run(terminal.id);
      this.reconcileInterruptedTerminal(terminal.id, terminal.workspace_id);
    }
  }

  /**
   * tmux 런타임이 사라진 'active' 터미널 행을 정리한다.
   *
   * 위 생성자는 부팅 때 한 번만 이 정합성을 맞춘다. 서버가 계속 살아 있는 동안 tmux
   * 서버가 죽으면(마지막 pane 종료 등) DB 는 status='active' 인데 런타임은 없는 유령이
   * 남고, 아무도 이를 되돌리지 않는다 — contextState 가 'unknown' 이 되어 auto-advance 의
   * 착수 지점이 조용히 return 하므로 goal 이 영구 정지한다(2026-07-22 실측: tmux 소실 후
   * 56분간 무음, 남은 태스크는 의존성 충족·담당자 idle 이었는데도 착수 불가).
   * 정리해 두면 resolveAgentTerminal 이 다음 틱에 새 터미널을 띄워 스스로 복구한다.
   */
  reapOrphanedPersistentTerminals(): string[] {
    if (!this.tmux) return [];
    const rows = this.db.prepare(`
      SELECT * FROM terminal_sessions WHERE status = 'active' AND backend = 'tmux'
    `).all() as TerminalRow[];
    const reaped: string[] = [];
    for (const row of rows) {
      if (row.runtime_id && this.tmux.hasSession(row.runtime_id)) continue;
      // attach 용 PTY 는 tmux 세션이 사라져도 남아 있을 수 있다 — 같이 정리한다.
      const active = this.active.get(row.id);
      if (active) {
        active.stopStatus = "interrupted";
        try { active.pty.kill(); } catch { /* 이미 종료됨 */ }
        this.active.delete(row.id);
      }
      this.db.prepare(`
        UPDATE terminal_sessions
           SET status = 'interrupted', pid = NULL, bridge_token_hash = NULL,
               ended_at = datetime('now')
         WHERE id = ? AND status = 'active'
      `).run(row.id);
      this.reconcileInterruptedTerminal(row.id, row.workspace_id);
      this.emit({
        type: "terminal:exit",
        payload: {
          terminalId: row.id,
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          status: "interrupted",
          exitCode: null,
        },
      });
      reaped.push(row.id);
    }
    return reaped;
  }

  /**
   * 신뢰 상속 이전에 만들어진 codex-home 은 trust 항목이 없어 다음 codex 실행도 온보딩에서 멈춘다.
   * MCP 설정(재발급 불가한 bridge token 포함)은 건드리지 않고 신뢰 섹션만 덧붙인다.
   */
  private backfillCodexTrust(codexHome: string, workspaceId: string): void {
    const configFile = resolve(codexHome, "config.toml");
    if (!existsSync(configFile)) return;
    const existing = readFileSync(configFile, "utf-8");
    if (existing.includes("[projects.")) return;
    const workspace = this.db.prepare(`
      SELECT worktree_path FROM workspaces WHERE id = ?
    `).get(workspaceId) as { worktree_path: string | null } | undefined;
    if (!workspace?.worktree_path) return;
    const trust = codexTrustEntry(workspace.worktree_path);
    writeFileSync(configFile, `${existing.trimEnd()}\n\n${trust.join("\n")}`, { mode: 0o600 });
  }

  private recoverPersistentTerminal(row: TerminalRow): boolean {
    if (!this.tmux || !row.runtime_id || !this.tmux.hasSession(row.runtime_id)) return false;
    if (this.persistentContextState(row) !== "connected") {
      this.tmux.killSession(row.runtime_id);
      return false;
    }
    // 구버전 create()가 만든 codex-home에는 AGENTS.md가 없다. 다음 codex 실행이
    // lifecycle 계약과 defer된 MCP 도구를 받도록 복구 시점에 보증한다.
    if (this.runtime) {
      try {
        const codexHome = resolve(this.runtime.dataDir, "terminal-runtime", "codex-home", row.id);
        if (existsSync(codexHome)) {
          writeFileSync(resolve(codexHome, "AGENTS.md"), `${TERMINAL_AGENT_PROMPT}\n`, { mode: 0o600 });
          this.backfillCodexTrust(codexHome, row.workspace_id);
        }
      } catch {
        // AGENTS.md 갱신 실패가 세션 복구 자체를 막아서는 안 된다.
      }
    }
    const worktree = (this.db.prepare("SELECT worktree_path FROM workspaces WHERE id = ?")
      .get(row.workspace_id) as { worktree_path: string | null } | undefined)?.worktree_path;
    if (worktree) grantClaudeTrust(worktree);
    try {
      const output = this.tmux.capture(row.runtime_id) || row.last_output;
      const terminal = this.tmux.attach({
        runtimeId: row.runtime_id,
        cwd: row.cwd,
        cols: row.cols,
        rows: row.rows,
        env: withUtf8Locale({ ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }),
      });
      const pid = this.tmux.panePid(row.runtime_id) ?? row.pid;
      this.db.prepare(`
        UPDATE terminal_sessions
           SET pid = ?, last_output = ?, ended_at = NULL
         WHERE id = ? AND status = 'active'
      `).run(pid, output, row.id);
      this.registerTerminal({
        id: row.id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        pty: terminal,
        backend: "tmux",
        runtimeId: row.runtime_id,
        output,
      });
      return true;
    } catch {
      return false;
    }
  }

  private persistentContextState(row: TerminalRow): TerminalSession["contextState"] {
    if (!this.tmux || !row.runtime_id || !this.tmux.hasSession(row.runtime_id)) return "unknown";
    const environment = this.tmux.environment(row.runtime_id, [
      "CREWDECK_WORKSPACE_ID",
      "CREWDECK_PROJECT_ID",
      "CREWDECK_TERMINAL_ID",
      "CREWDECK_API_KEY",
    ]);
    const tokenHash = environment.CREWDECK_API_KEY
      ? createHash("sha256").update(environment.CREWDECK_API_KEY).digest("hex")
      : null;
    return environment.CREWDECK_WORKSPACE_ID === row.workspace_id
      && environment.CREWDECK_PROJECT_ID === row.project_id
      && environment.CREWDECK_TERMINAL_ID === row.id
      && tokenHash !== null
      && tokenHash === row.bridge_token_hash
      ? "connected"
      : "mismatch";
  }

  private registerTerminal(input: {
    id: string;
    workspaceId: string;
    projectId: string;
    pty: IPty;
    backend: "pty" | "tmux";
    runtimeId: string | null;
    output: string;
    deferInputUntilData?: boolean;
    inputReadyFile?: string | null;
  }): void {
    const active: ActiveTerminal = {
      pty: input.pty,
      output: input.output,
      backend: input.backend,
      runtimeId: input.runtimeId,
      stopStatus: null,
      flushTimer: null,
      inputReady: input.deferInputUntilData !== true,
      pendingInput: "",
      inputReadyTimer: null,
      lastDataAt: Date.now(),
    };
    this.active.set(input.id, active);

    const markInputReady = () => {
      if (active.inputReady) return;
      active.inputReady = true;
      if (active.inputReadyTimer) clearTimeout(active.inputReadyTimer);
      active.inputReadyTimer = null;
      const pending = active.pendingInput;
      active.pendingInput = "";
      if (!pending) return;
      if (active.backend === "tmux" && active.runtimeId && this.tmux) {
        this.tmux.write(active.runtimeId, pending);
      } else {
        active.pty.write(pending);
      }
    };
    const pollInputReady = () => {
      if (active.inputReady) return;
      if (!input.inputReadyFile || existsSync(input.inputReadyFile)) {
        markInputReady();
        return;
      }
      active.inputReadyTimer = setTimeout(pollInputReady, 20);
    };
    if (!active.inputReady) {
      active.inputReadyTimer = setTimeout(pollInputReady, 20);
    }

    input.pty.onData((data) => {
      if (!input.inputReadyFile || existsSync(input.inputReadyFile)) markInputReady();
      active.lastDataAt = Date.now();
      active.output = `${active.output}${data}`.slice(-MAX_OUTPUT);
      if (!active.flushTimer) {
        active.flushTimer = setTimeout(() => {
          active.flushTimer = null;
          this.db.prepare("UPDATE terminal_sessions SET last_output = ? WHERE id = ? AND status = 'active'")
            .run(active.output, input.id);
        }, 250);
      }
      this.emit({ type: "terminal:data", payload: { terminalId: input.id, data } });
    });
    input.pty.onExit(({ exitCode }) => {
      if (active.flushTimer) clearTimeout(active.flushTimer);
      if (active.inputReadyTimer) clearTimeout(active.inputReadyTimer);
      if (this.shuttingDown) {
        this.active.delete(input.id);
        return;
      }
      const persistentSessionSurvives = active.backend === "tmux"
        && active.runtimeId !== null
        && active.stopStatus === null
        && this.tmux?.hasSession(active.runtimeId) === true;
      if (persistentSessionSurvives) {
        this.active.delete(input.id);
        const row = this.db.prepare("SELECT * FROM terminal_sessions WHERE id = ? AND status = 'active'")
          .get(input.id) as TerminalRow | undefined;
        if (row && this.recoverPersistentTerminal(row)) return;
      }

      const status: TerminalSessionStatus = persistentSessionSurvives
        ? "interrupted"
        : active.stopStatus ?? "exited";
      this.db.prepare(`
        UPDATE terminal_sessions
           SET status = ?, exit_code = ?, pid = NULL, bridge_token_hash = NULL,
               last_output = ?, ended_at = datetime('now')
         WHERE id = ?
      `).run(status, exitCode, active.output, input.id);
      if (status === "interrupted") {
        this.reconcileInterruptedTerminal(input.id, input.workspaceId);
      } else {
        try {
          finishTerminalBridgeAgentRun(this.db, {
            workspaceId: input.workspaceId,
            terminalSessionId: input.id,
            clientRequestId: "terminal-exit-" + input.id + "-" + randomUUID(),
            provider: status === "killed" ? "terminal session" : "shell",
            exitCode: exitCode ?? -1,
          });
        } catch {
          // Terminal status is authoritative even when there is no bridge task to reconcile.
        }
      }
      this.active.delete(input.id);
      this.emit({
        type: "terminal:exit",
        payload: {
          terminalId: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          status,
          exitCode,
        },
      });
    });
  }

  private reconcileInterruptedTerminal(terminalId: string, workspaceId: string): void {
    try {
      const result = finishTerminalBridgeAgentRun(this.db, {
        workspaceId,
        terminalSessionId: terminalId,
        clientRequestId: `terminal-interrupted-${terminalId}`,
        provider: "terminal session",
        exitCode: -1,
        interrupted: true,
      });
      if (result.task) return;
    } catch {
      // Terminal history remains authoritative even when no bridge task exists.
    }
    const binding = this.db.prepare(`
      SELECT active_task_id, agent_id FROM terminal_sessions WHERE id = ?
    `).get(terminalId) as { active_task_id: string | null; agent_id: string | null } | undefined;
    if (!binding?.active_task_id) return;
    recoverInterruptedTask(this.db, binding.active_task_id, "startup");
    if (binding.agent_id) {
      this.db.prepare(`
        UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL
         WHERE id = ? AND current_task_id = ? AND status != 'terminated'
      `).run(binding.agent_id, binding.active_task_id);
    }
  }

  create(workspaceId: string, size: { cols?: number; rows?: number } = {}): TerminalSession {
    const workspace = this.db.prepare(`
      SELECT id, project_id, worktree_path, state, COALESCE(active_goal_id, goal_id) AS active_goal_id
        FROM workspaces
       WHERE id = ?
    `).get(workspaceId) as {
      id: string;
      project_id: string;
      worktree_path: string | null;
      state: string;
      active_goal_id: string | null;
    } | undefined;

    if (!workspace) throw new Error("Workspace not found");
    if (workspace.state !== "ready" || !workspace.worktree_path || !existsSync(workspace.worktree_path)) {
      throw new Error("Workspace is not ready");
    }

    // 한 터미널에서 claude/codex 를 번갈아 쓸 수 있고, 신뢰 등록이 없으면 어느 쪽이든
    // 온보딩 다이얼로그에서 멈춘다. worktree 생성 시점(worktree.ts)에 등록을 놓친
    // 기존 worktree 도 여기서 보장한다 — 이미 신뢰돼 있으면 아무것도 하지 않는다.
    grantClaudeTrust(workspace.worktree_path);

    const shell = process.env.SHELL && existsSync(process.env.SHELL)
      ? process.env.SHELL
      : existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
    const cols = clamp(size.cols ?? 120, 20, 400, 120);
    const rows = clamp(size.rows ?? 32, 5, 200, 32);
    const id = randomUUID().replaceAll("-", "").slice(0, 16);
    const bridgeToken = this.runtime ? randomBytes(32).toString("hex") : null;
    const bridgeTokenHash = bridgeToken ? createHash("sha256").update(bridgeToken).digest("hex") : null;
    const runtimeDir = this.runtime ? resolve(this.runtime.dataDir, "terminal-runtime") : null;
    const inputReadyFile = runtimeDir ? resolve(runtimeDir, "ready", id) : null;
    const terminalEnv: Record<string, string | undefined> = withUtf8Locale({
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CREWDECK_WORKSPACE_ID: workspace.id,
      CREWDECK_PROJECT_ID: workspace.project_id,
      CREWDECK_TERMINAL_ID: id,
    });
    if (this.runtime && runtimeDir) {
      terminalEnv.CREWDECK_API_URL = this.runtime.apiBaseUrl;
      terminalEnv.CREWDECK_API_KEY = bridgeToken!;
      terminalEnv.CREWDECK_AGENT_PROMPT = TERMINAL_AGENT_PROMPT;
      terminalEnv.CREWDECK_AGENT_PROMPT_FILE = resolve(runtimeDir, "agent-prompt.txt");
      terminalEnv.CREWDECK_MCP_CONFIG = resolve(runtimeDir, "claude-mcp.json");
      terminalEnv.CREWDECK_MCP_COMMAND = this.runtime.mcpCommand.command;
      terminalEnv.CREWDECK_MCP_ARGS_TOML = JSON.stringify(this.runtime.mcpCommand.args);
      terminalEnv.CREWDECK_TERMINAL_READY_FILE = inputReadyFile!;
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
      // codex 0.144+는 config MCP 도구를 모델 기본 도구 목록에 싣지 않고 defer한다 —
      // 지시문/프롬프트에 도구 이름이 언급된 턴에만 attach된다. config의
      // developer_instructions 키는 더 이상 시스템 프롬프트에 주입되지 않으므로,
      // codex가 전역 지시문으로 읽는 CODEX_HOME/AGENTS.md에 lifecycle 계약을 쓴다.
      writeFileSync(resolve(codexHome, "AGENTS.md"), `${TERMINAL_AGENT_PROMPT}\n`, { mode: 0o600 });
      const tomlString = (value: string) => JSON.stringify(value);
      // 격리 CODEX_HOME 에는 신뢰 목록이 없어, 이게 없으면 codex 가 온보딩 다이얼로그를
      // 띄우고 무인 진행이 첫 줄도 못 나간다(신규 사용자는 100% 재현).
      writeFileSync(resolve(codexHome, "config.toml"), [
        ...codexTrustEntry(workspace.worktree_path),
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
    let backend: "pty" | "tmux" = "pty";
    let runtimeId: string | null = null;
    let terminal: IPty;
    if (this.tmux) {
      runtimeId = `crewdeck-${id}`;
      try {
        this.tmux.createSession({
          runtimeId,
          shell,
          shellArgs,
          cwd: workspace.worktree_path,
          cols,
          rows,
          env: terminalEnv,
        });
        const sessionEnvironment = this.tmux.environment(runtimeId, [
          "CREWDECK_WORKSPACE_ID",
          "CREWDECK_PROJECT_ID",
          "CREWDECK_TERMINAL_ID",
          "CREWDECK_API_KEY",
        ]);
        const sessionTokenHash = sessionEnvironment.CREWDECK_API_KEY
          ? createHash("sha256").update(sessionEnvironment.CREWDECK_API_KEY).digest("hex")
          : null;
        if (sessionEnvironment.CREWDECK_WORKSPACE_ID !== workspace.id
          || sessionEnvironment.CREWDECK_PROJECT_ID !== workspace.project_id
          || sessionEnvironment.CREWDECK_TERMINAL_ID !== id
          || sessionTokenHash !== bridgeTokenHash) {
          this.tmux.killSession(runtimeId);
          throw new Error("Persistent terminal context mismatch");
        }
        terminal = this.tmux.attach({
          runtimeId,
          cwd: workspace.worktree_path,
          cols,
          rows,
          env: terminalEnv,
        });
        backend = "tmux";
      } catch {
        runtimeId = null;
        terminal = spawn(shell, shellArgs, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: workspace.worktree_path,
          env: terminalEnv,
        });
      }
    } else {
      terminal = spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: workspace.worktree_path,
        env: terminalEnv,
      });
    }
    const pid = backend === "tmux" && runtimeId
      ? this.tmux?.panePid(runtimeId) ?? terminal.pid
      : terminal.pid;

    this.db.prepare(`
      INSERT INTO terminal_sessions (
        id, workspace_id, project_id, shell, cwd, pid, bridge_token_hash,
        goal_id, backend, runtime_id, cols, rows, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, workspace.id, workspace.project_id, shell, workspace.worktree_path, pid, bridgeTokenHash,
      workspace.active_goal_id, backend, runtimeId, cols, rows,
    );

    this.registerTerminal({
      id,
      workspaceId: workspace.id,
      projectId: workspace.project_id,
      pty: terminal,
      backend,
      runtimeId,
      output: "",
      deferInputUntilData: backend === "tmux" && (shell.endsWith("/zsh") || shell.endsWith("/bash")),
      inputReadyFile,
    });

    return this.get(id)!;
  }

  private ensureShellIntegration(): void {
    if (!this.runtime) return;
    const runtimeDir = resolve(this.runtime.dataDir, "terminal-runtime");
    const binDir = resolve(runtimeDir, "bin");
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    mkdirSync(resolve(runtimeDir, "ready"), { recursive: true, mode: 0o700 });
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
: > "$CREWDECK_TERMINAL_READY_FILE"
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
: > "$CREWDECK_TERMINAL_READY_FILE"
`, { mode: 0o600 });
  }

  list(workspaceId: string): TerminalSession[] {
    const rows = this.db.prepare(`
      SELECT ts.*,
             g.title AS goal_title,
             a.name AS agent_name,
             a.role AS agent_role,
             t.title AS active_task_title,
             t.status AS active_task_status,
             (SELECT COUNT(*)
                FROM terminal_sessions previous
               WHERE previous.workspace_id = ts.workspace_id
                 AND previous.rowid <= ts.rowid) AS tab_number
        FROM terminal_sessions ts
        LEFT JOIN goals g ON g.id = ts.goal_id
        LEFT JOIN agents a ON a.id = ts.agent_id
        LEFT JOIN tasks t ON t.id = ts.active_task_id
       WHERE ts.workspace_id = ? AND ts.dismissed_at IS NULL
       ORDER BY ts.started_at DESC, ts.rowid DESC
    `).all(workspaceId) as TerminalRow[];
    return rows.map((row) => toModel(row, this.currentOutput(row), this.contextState(row), this.mouseRestore(row)));
  }

  get(id: string): TerminalSession | null {
    const row = this.db.prepare(`
      SELECT ts.*,
             g.title AS goal_title,
             a.name AS agent_name,
             a.role AS agent_role,
             t.title AS active_task_title,
             t.status AS active_task_status,
             (SELECT COUNT(*)
                FROM terminal_sessions previous
               WHERE previous.workspace_id = ts.workspace_id
                 AND previous.rowid <= ts.rowid) AS tab_number
        FROM terminal_sessions ts
        LEFT JOIN goals g ON g.id = ts.goal_id
        LEFT JOIN agents a ON a.id = ts.agent_id
        LEFT JOIN tasks t ON t.id = ts.active_task_id
       WHERE ts.id = ?
    `).get(id) as TerminalRow | undefined;
    return row ? toModel(row, this.currentOutput(row), this.contextState(row), this.mouseRestore(row)) : null;
  }

  private contextState(row: TerminalRow): TerminalSession["contextState"] {
    if (row.status !== "active") return "unknown";
    if (row.backend === "tmux") return this.persistentContextState(row);
    return this.active.has(row.id) ? "connected" : "unknown";
  }

  private currentOutput(row: TerminalRow): string | undefined {
    const terminal = this.active.get(row.id);
    if (!terminal) return undefined;
    if (terminal.backend === "tmux" && terminal.runtimeId && this.tmux?.hasSession(terminal.runtimeId)) {
      return this.tmux.capture(terminal.runtimeId) || row.last_output;
    }
    return terminal.output;
  }

  /**
   * 재진입 스냅샷 뒤에 붙일 마우스 모드 복원 시퀀스.
   * capture-pane은 DEC private 모드를 담지 않고 sanitizeReplayOutput은 이를 제거하므로,
   * 새로고침한 xterm은 마우스 트래킹이 꺼진 채로 시작해 휠을 팬으로 넘기지 못한다.
   * alt-screen TUI(claude 등)는 스크롤백을 자기가 들고 있어 휠이 끊기면 위로 못 올라간다.
   * 죽은 리플레이 바이트가 아니라 살아 있는 팬의 현재 상태만 근거로 삼아 junk 입력을 피한다.
   */
  private mouseRestore(row: TerminalRow): string {
    const terminal = this.active.get(row.id);
    if (!terminal || terminal.backend !== "tmux" || !terminal.runtimeId) return "";
    if (!this.tmux?.hasSession(terminal.runtimeId)) return "";
    return this.tmux.paneMouseModes(terminal.runtimeId);
  }

  write(id: string, data: string): boolean {
    const terminal = this.active.get(id);
    if (!terminal || typeof data !== "string" || data.length > 64 * 1024) return false;
    // 브라우저 xterm이 자동 생성한 제어 응답(색상/DA/CPR 보고)은 pane 키 입력이 아니다.
    // send-keys로 pane에 넣으면 셸 프롬프트에 literal로 echo되므로(재진입 junk),
    // 질의를 보낸 tmux attach 클라이언트 stdin으로 돌려준다.
    if (terminal.backend === "tmux") {
      const { replies, input } = splitTerminalReplies(data);
      if (replies) terminal.pty.write(replies);
      if (!input) return true;
      data = input;
    }
    if (!terminal.inputReady) {
      if (terminal.pendingInput.length + data.length > 64 * 1024) return false;
      terminal.pendingInput += data;
      return true;
    }
    if (terminal.backend === "tmux" && terminal.runtimeId && this.tmux) {
      return this.tmux.write(terminal.runtimeId, data);
    }
    terminal.pty.write(data);
    return true;
  }

  /**
   * 터미널 foreground에서 실행 중인 에이전트 CLI(claude/codex)를 감지한다.
   * tmux는 attach 클라이언트가 아니라 pane 셸의 자손을 봐야 한다.
   */
  runningAgent(id: string): AgentProvider | null {
    const row = this.db.prepare(
      "SELECT status, backend, runtime_id, pid FROM terminal_sessions WHERE id = ?",
    ).get(id) as Pick<TerminalRow, "status" | "backend" | "runtime_id" | "pid"> | undefined;
    if (!row || row.status !== "active") return null;
    const rootPid = row.backend === "tmux" && row.runtime_id
      ? this.tmux?.panePid(row.runtime_id) ?? null
      : this.active.get(id)?.pty.pid ?? row.pid;
    return detectRunningAgent(rootPid);
  }

  /**
   * 마지막 PTY 출력 이후 경과 시간(ms). 활성 터미널이 아니면 null.
   *
   * 에이전트 CLI 가 입력 대기(신뢰 온보딩·로그인·사용량 한도 등)에 걸리면 화면이 정지해
   * 출력이 끊긴다. 반대로 정상 작업 중에는 TUI 가 스피너·경과시간을 계속 갱신하므로
   * 출력이 이어진다 — 그래서 무출력 시간이 "사람을 기다리는 중"의 신호가 된다.
   */
  outputIdleMs(id: string): number | null {
    const terminal = this.active.get(id);
    return terminal ? Date.now() - terminal.lastDataAt : null;
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
    if (terminal.backend === "tmux" && terminal.runtimeId) {
      this.tmux?.killSession(terminal.runtimeId);
    }
    try { terminal.pty.kill(); } catch { /* process already exited */ }
    return this.get(id);
  }

  dismiss(id: string): TerminalSession | null {
    const terminal = this.get(id);
    if (!terminal) return null;
    if (terminal.status === "active") {
      throw new Error("Active terminal must be stopped before dismissal");
    }
    this.db.prepare(`
      UPDATE terminal_sessions
         SET dismissed_at = COALESCE(dismissed_at, datetime('now'))
       WHERE id = ?
    `).run(id);
    return this.get(id);
  }

  killAll(options: { preservePersistent?: boolean } = {}): void {
    this.shuttingDown = true;
    for (const [id, terminal] of this.active) {
      terminal.stopStatus = "interrupted";
      if (terminal.flushTimer) clearTimeout(terminal.flushTimer);
      if (terminal.inputReadyTimer) clearTimeout(terminal.inputReadyTimer);
      if (terminal.backend === "tmux" && terminal.runtimeId && this.tmux?.hasSession(terminal.runtimeId)) {
        if (options.preservePersistent === false) {
          this.tmux.killSession(terminal.runtimeId);
        } else {
          const output = this.tmux.capture(terminal.runtimeId) || terminal.output;
          const pid = this.tmux.panePid(terminal.runtimeId);
          this.db.prepare(`
            UPDATE terminal_sessions
               SET pid = COALESCE(?, pid), last_output = ?
             WHERE id = ? AND status = 'active'
          `).run(pid, output, id);
          try { terminal.pty.kill(); } catch { /* best effort during shutdown */ }
          continue;
        }
      }
      try { terminal.pty.kill(); } catch { /* best effort during shutdown */ }
      this.db.prepare(`
        UPDATE terminal_sessions
           SET status = 'interrupted', pid = NULL, bridge_token_hash = NULL,
               last_output = ?, ended_at = datetime('now')
         WHERE id = ? AND status = 'active'
      `).run(terminal.output, id);
      const session = this.get(id);
      if (session) this.reconcileInterruptedTerminal(id, session.workspaceId);
    }
    if (options.preservePersistent === false && this.tmux) {
      const persistent = this.db.prepare(`
        SELECT runtime_id FROM terminal_sessions
         WHERE backend = 'tmux' AND status = 'active' AND runtime_id IS NOT NULL
      `).all() as Array<{ runtime_id: string }>;
      for (const terminal of persistent) this.tmux.killSession(terminal.runtime_id);
      this.db.prepare(`
        UPDATE terminal_sessions
           SET status = 'interrupted', pid = NULL, bridge_token_hash = NULL,
               ended_at = datetime('now')
         WHERE backend = 'tmux' AND status = 'active'
      `).run();
    }
  }
}
