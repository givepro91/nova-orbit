import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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

  private constructor(
    private readonly command: TmuxCommand,
    dataDir: string,
  ) {
    const dataHash = createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
    this.socketName = `crewdeck-${dataHash}`;
    const socketRoot = process.env.TMUX_TMPDIR ?? "/tmp";
    const userId = typeof process.getuid === "function" ? process.getuid() : 0;
    this.socketPath = resolve(socketRoot, `tmux-${userId}`, this.socketName);
  }

  createSession(input: TmuxSessionInput): void {
    const environmentEntries = Object.entries(input.env)
      .filter(([key, value]) => value !== undefined && value !== process.env[key])
      .map(([key, value]) => `${key}=${value}`);
    const shellCommand = `exec ${[input.shell, ...input.shellArgs].map(shellQuote).join(" ")}`;
    try {
      this.run([
        "new-session", "-d", "-s", input.runtimeId,
        "-c", input.cwd, "-x", String(input.cols), "-y", String(input.rows),
        ...environmentEntries.flatMap((entry) => ["-e", entry]),
        shellCommand,
      ], { env: input.env });
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
    try {
      this.run(["list-sessions"]);
    } catch {
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
      ...args,
    ], {
      env: options.env,
      encoding: options.encoding ?? "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
