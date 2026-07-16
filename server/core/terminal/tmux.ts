import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";

const MAX_CAPTURE = 200 * 1024;

export interface TmuxCommand {
  command: string;
  args: string[];
}

interface TmuxSessionInput {
  runtimeId: string;
  shell: string;
  shellArgs: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string | undefined>;
}

export class TmuxBackend {
  static detect(dataDir: string, override?: TmuxCommand | null): TmuxBackend | null {
    if (override === null) return null;
    const command = override ?? { command: "tmux", args: [] };
    try {
      execFileSync(command.command, [...command.args, "-V"], { stdio: "ignore" });
      return new TmuxBackend(command, dataDir);
    } catch {
      return null;
    }
  }

  private readonly socketName: string;
  private readonly socketPath: string;
  private readonly configPath: string;

  private constructor(
    private readonly command: TmuxCommand,
    dataDir: string,
  ) {
    const dataHash = createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
    this.socketName = `crewdeck-${dataHash}`;
    const socketRoot = process.env.TMUX_TMPDIR ?? "/tmp";
    const userId = typeof process.getuid === "function" ? process.getuid() : 0;
    this.socketPath = resolve(socketRoot, `tmux-${userId}`, this.socketName);
    this.configPath = resolve(dataDir, "terminal-runtime", "tmux.conf");
  }

  createSession(input: TmuxSessionInput): void {
    const environmentKeys = Object.entries(input.env)
      .filter(([key, value]) => value !== undefined && (
        value !== process.env[key]
        || key.startsWith("CREWDECK_")
        || ["PATH", "ZDOTDIR", "TERM", "COLORTERM", "CODEX_HOME"].includes(key)
      ))
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .map(([key]) => key);
    // tmux's `new-session -e` only accepts KEY=value, which would expose the
    // value in process argv. `update-environment` copies named values from the
    // client process environment instead. The dedicated socket config handles
    // the very first server; set-option handles a server that already exists.
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.configPath,
      `set-option -g update-environment ${JSON.stringify(environmentKeys.join(" "))}\n`,
      { mode: 0o600 },
    );
    chmodSync(this.configPath, 0o600);
    try {
      this.run(["set-option", "-g", "update-environment", environmentKeys.join(" ")]);
    } catch {
      // No server yet: the 0600 config is loaded before the first new-session.
    }
    try {
      this.run([
        "new-session", "-d", "-s", input.runtimeId,
        "-c", input.cwd, "-x", String(input.cols), "-y", String(input.rows),
        // tmux accepts shell-command and its arguments separately. Keeping the
        // executable fixed and values in an argument array avoids a shell sink.
        input.shell,
        ...input.shellArgs,
      ], { env: input.env });
      // tmux may create its socket using a permissive caller umask. This socket
      // carries terminal keystrokes and environment, so keep it owner-only.
      try { chmodSync(this.socketPath, 0o600); } catch { /* tmux remains authoritative if chmod is unsupported */ }
      this.run(["set-option", "-t", input.runtimeId, "status", "off"]);
      this.run(["set-option", "-t", input.runtimeId, "history-limit", "10000"]);
    } catch (error) {
      this.killSession(input.runtimeId);
      throw error;
    }
  }

  attach(input: Pick<TmuxSessionInput, "runtimeId" | "cwd" | "cols" | "rows" | "env">): IPty {
    return spawn(this.command.command, [
      ...this.command.args,
      "-L", this.socketName,
      "attach-session", "-t", input.runtimeId,
    ], {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: input.env,
    });
  }

  hasSession(runtimeId: string): boolean {
    try {
      this.run(["has-session", "-t", runtimeId]);
      return true;
    } catch {
      return false;
    }
  }

  panePid(runtimeId: string): number | null {
    try {
      const value = this.run(["display-message", "-p", "-t", runtimeId, "#{pane_pid}"], { encoding: "utf8" });
      const pid = Number.parseInt(value.trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  capture(runtimeId: string): string {
    try {
      const output = this.run(["capture-pane", "-p", "-t", runtimeId, "-S", "-"], { encoding: "utf8" });
      return output.slice(-MAX_CAPTURE);
    } catch {
      return "";
    }
  }

  write(runtimeId: string, data: string): boolean {
    if (!data || !this.hasSession(runtimeId)) return false;
    try {
      // Writing to the short-lived `tmux attach-session` client immediately after
      // spawn races with the client registration handshake. Input accepted by
      // node-pty in that window can disappear before tmux attaches it to the pane.
      // send-keys targets the durable pane directly, so the same path works during
      // initial creation and after a server reattach without depending on client
      // readiness. `-l` preserves the browser terminal's raw input bytes.
      this.run(["send-keys", "-t", runtimeId, "-l", "--", data]);
      return true;
    } catch {
      return false;
    }
  }

  environment(runtimeId: string, keys: string[]): Record<string, string> {
    try {
      const output = this.run(["show-environment", "-t", runtimeId], { encoding: "utf8" });
      const requested = new Set(keys);
      const result: Record<string, string> = {};
      for (const line of output.split("\n")) {
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        const key = line.slice(0, separator);
        if (requested.has(key)) result[key] = line.slice(separator + 1);
      }
      return result;
    } catch {
      return {};
    }
  }

  killSession(runtimeId: string): void {
    try {
      this.run(["kill-session", "-t", runtimeId]);
    } catch {
      // The shell may have already exited and removed the tmux session.
    }
    let noSessions = false;
    try {
      noSessions = this.run(["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).trim() === "";
    } catch {
      noSessions = true;
    }
    if (noSessions) {
      try { this.run(["kill-server"]); } catch { /* server already exited */ }
      try { unlinkSync(this.socketPath); } catch { /* socket already removed or still owned */ }
    }
  }

  private run(
    args: string[],
    options: { env?: Record<string, string | undefined>; encoding?: BufferEncoding } = {},
  ): string {
    return execFileSync(this.command.command, [
      ...this.command.args,
      "-L", this.socketName,
      "-f", this.configPath,
      ...args,
    ], {
      env: options.env,
      encoding: options.encoding ?? "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
