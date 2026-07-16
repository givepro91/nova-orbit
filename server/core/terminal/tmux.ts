import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

  private constructor(
    private readonly command: TmuxCommand,
    dataDir: string,
  ) {
    const dataHash = createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
    this.socketName = `crewdeck-${dataHash}`;
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
      // -J: 팬 폭 기준 하드랩·trailing 공백을 제거해 재진입 시 xterm cols와 어긋나지 않게 한다.
      // -e: ANSI escape를 보존해 색·스타일이 스냅샷에서 사라지지 않게 한다.
      const output = this.run(["capture-pane", "-p", "-J", "-e", "-t", runtimeId, "-S", "-"], { encoding: "utf8" });
      // capture-pane은 줄을 LF로만 끊는다. xterm은 convertEol=false로 동작하므로 CR이 없으면
      // 커서가 열을 유지한 채 내려가 복원 화면이 계단식으로 밀린다 — PTY 스트림과 같은 CRLF로 정규화한다.
      return output.slice(-MAX_CAPTURE).replace(/\r?\n/g, "\r\n");
    } catch {
      return "";
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
