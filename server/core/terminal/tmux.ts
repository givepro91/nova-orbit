import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { spawn, type IPty } from "node-pty";

const MAX_CAPTURE = 200 * 1024;

// tmux는 LC_ALL > LC_CTYPE > LANG 중 첫 값에 "UTF-8"이 없으면 non-UTF-8 클라이언트로 붙어
// (client_utf8=0) 한글 같은 멀티바이트를 '_'로 뭉갠다. launchd 기동 시 로케일 env가 아예
// 없으므로 -u로 UTF-8을 강제한다 — attach(입력·출력)와 capture-pane(스냅샷) 양쪽에 필요하다.
const UTF8_ARGS = ["-u"];

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
      ...UTF8_ARGS,
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
      // -e: ANSI escape를 보존해 색·스타일이 스냅샷에서 사라지지 않게 한다.
      // -J는 쓰지 않는다 — 랩된 줄을 합쳐 행 수를 줄이므로 아래 커서 좌표와 어긋난다.
      const output = this.run(["capture-pane", "-p", "-e", "-t", runtimeId, "-S", "-"], { encoding: "utf8" });
      // capture-pane은 줄을 LF로만 끊는다. xterm은 convertEol=false로 동작하므로 CR이 없으면
      // 커서가 열을 유지한 채 내려가 복원 화면이 계단식으로 밀린다 — PTY 스트림과 같은 CRLF로 정규화한다.
      // capture-pane은 마지막 줄 뒤에도 개행을 붙인다. 그대로 쓰면 xterm이 한 줄 더 스크롤해
      // 화면이 팬보다 위로 밀리고, 아래 절대 좌표 이동이 그만큼 어긋난다.
      const normalized = output.slice(-MAX_CAPTURE).replace(/\r?\n/g, "\r\n").replace(/\r\n$/, "");
      // capture-pane은 커서 위치를 담지 않는다. 그대로 write하면 xterm 커서가 텍스트 끝(화면 맨 아래)에
      // 남아, TUI(claude 등)에 재진입해 입력하면 프롬프트가 아니라 상태줄 아래에 찍힌다.
      // tmux가 보고하는 실제 커서로 이동시켜 복원 화면과 입력 위치를 일치시킨다.
      const cursor = this.cursorPosition(runtimeId);
      return cursor ? `${normalized}\x1b[${cursor.y + 1};${cursor.x + 1}H` : normalized;
    } catch {
      return "";
    }
  }

  /** 팬의 현재 커서 위치(0-based 화면 좌표). */
  private cursorPosition(runtimeId: string): { x: number; y: number } | null {
    try {
      const value = this.run(["display-message", "-p", "-t", runtimeId, "#{cursor_y} #{cursor_x}"], { encoding: "utf8" });
      const [y, x] = value.trim().split(" ").map((part) => Number.parseInt(part, 10));
      return Number.isFinite(y) && Number.isFinite(x) ? { x, y } : null;
    } catch {
      return null;
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
      ...UTF8_ARGS,
      "-L", this.socketName,
      ...args,
    ], {
      env: options.env,
      encoding: options.encoding ?? "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}
