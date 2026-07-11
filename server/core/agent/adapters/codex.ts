/**
 * Codex CLI Adapter — `codex exec --json` 비대화 실행을 AgentBackend로 감싼다.
 *
 * claude 어댑터(claude-code.ts)와 동일한 세션 계약을 지킨다:
 * - spawn(config) → AgentSession (EventEmitter)
 * - session.send(message) → Promise<RunResult> : 실제 프로세스 실행 주체
 * - 이벤트: status / pid / output / stderr / rate-limit / crewdeck:error
 *
 * claude와 다른 점:
 * - 커맨드 `codex exec --json ...`, 프롬프트 stdin(`-`)
 * - 시스템프롬프트 파일 플래그 없음 → 시스템프롬프트+컨텍스트는 session.ts가 stdin 본문에 prepend
 * - rate-limit은 내부 대기 없이 즉시 실패 surface(failover가 scheduler에서 처리)
 * - 세션 resume(`thread_id`)은 후속 — 현재는 항상 fresh
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../../utils/logger.js";
import { TASK_TIMEOUT_MS, SIGKILL_TIMEOUT_MS } from "../../../utils/constants.js";
import { makeSpawnFailedError, makeTimeoutError } from "../../../utils/errors.js";
import type { RunResult } from "./claude-code.js";
import type { AgentBackend, AgentBackendConfig, AgentSession } from "./backend.js";
import { parseCodexJson } from "./codex-stream-parser.js";

const log = createLogger("codex-adapter");

/** Codex rate-limit/quota 신호 감지 (best-effort — Task 9에서 정교화). */
export function isCodexRateLimit(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests") ||
    lower.includes("429") ||
    lower.includes("usage limit") ||
    lower.includes("quota")
  );
}

function buildCodexArgs(config: AgentBackendConfig): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "-C", resolvePath(config.workdir)];
  if (config.model) args.push("-m", config.model);
  // crewdeck는 격리된 goal worktree에서 codex를 비대화로 실행한다(= 외부 샌드박스).
  // 에이전트는 build·test·playwright·패키지 설치 등 전체 접근이 필요하고, 승인 프롬프트를 답할 TTY가 없다.
  // `-s workspace-write`는 네트워크·워크스페이스 밖 쓰기를 막아 playwright(브라우저 다운로드)·CodeRabbit·
  // `npm install`이 실패한다(실측 확인). 따라서 승인·샌드박스를 우회한다 — worktree가 안전 경계.
  // Claude 어댑터의 `--dangerously-skip-permissions`와 대칭(자율 실행 도구의 전제).
  args.push("--dangerously-bypass-approvals-and-sandbox");
  args.push("-"); // 프롬프트는 stdin
  return args;
}

export function createCodexAdapter(): AgentBackend {
  return {
    provider: "codex",

    isAvailable() {
      return new Promise<boolean>((resolve) => {
        try {
          const p = spawn("codex", ["--version"], { stdio: "ignore" });
          p.on("error", () => resolve(false));
          p.on("exit", (code) => resolve(code === 0));
        } catch {
          resolve(false);
        }
      });
    },

    spawn(config: AgentBackendConfig): AgentSession {
      const session = new EventEmitter() as AgentSession;
      session.id = `codex-${randomUUID().slice(0, 12)}`;
      session.process = null;
      session.status = "idle";
      session.lastSessionId = config.resumeSessionId ?? null;

      // steer/abort로 현재 턴을 kill()했는지 표식(claude 어댑터와 동일 계약). close가 실패 대신 중단으로 resolve.
      let interrupting = false;

      session.send = (message: string): Promise<RunResult> => {
        return new Promise<RunResult>((resolve, reject) => {
          session.status = "working";
          session.emit("status", "working");
          interrupting = false; // 새 턴 시작 — 이전 kill 표식 초기화

          const args = buildCodexArgs(config);
          log.info("Spawning Codex CLI", { workdir: config.workdir, args: args.join(" ") });

          const ALLOWED_ENV_KEYS = [
            "PATH", "HOME", "SHELL", "USER", "LANG", "LC_ALL", "TERM",
            "NODE_ENV", "TMPDIR", "XDG_CONFIG_HOME", "CODEX_HOME",
          ];
          const safeEnv: Record<string, string> = { BROWSER: "none", CREWDECK_AGENT_ID: session.id };
          for (const key of ALLOWED_ENV_KEYS) {
            if (process.env[key]) safeEnv[key] = process.env[key]!;
          }
          const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
          const currentPath = safeEnv.PATH ?? "";
          const missing = extraPaths.filter((p) => !currentPath.includes(p));
          if (missing.length > 0) safeEnv.PATH = [currentPath, ...missing].filter(Boolean).join(":");

          const proc: ChildProcess = spawn("codex", args, {
            cwd: resolvePath(config.workdir),
            stdio: ["pipe", "pipe", "pipe"] as const,
            env: safeEnv,
          });
          session.process = proc;
          if (proc.pid) session.emit("pid", proc.pid);

          // Hard wall-clock timeout (stuck-process guard)
          const HARD_TIMEOUT_MS = TASK_TIMEOUT_MS * 3;
          const startTime = Date.now();
          let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
          const hardTimer = setTimeout(() => {
            if (!session.process) return;
            log.warn(`Codex session ${session.id} hard timeout, sending SIGTERM`);
            session.process.kill("SIGTERM");
            session.emit("crewdeck:error", makeTimeoutError(Date.now() - startTime).toJSON());
            sigkillTimer = setTimeout(() => {
              if (session.process) session.process.kill("SIGKILL");
            }, SIGKILL_TIMEOUT_MS);
          }, HARD_TIMEOUT_MS);

          let stdout = "";
          let stderr = "";
          proc.stdout!.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            session.emit("output", text);
          });
          proc.stderr!.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            session.emit("stderr", text);
          });

          // 프롬프트를 stdin으로. Codex엔 --append-system-prompt-file이 없으므로
          // 시스템프롬프트(+메모리)를 태스크 메시지 앞에 prepend한다.
          const parts: string[] = [];
          if (config.systemPrompt) parts.push(config.systemPrompt);
          if (config.memoryContent) parts.push(`## Agent Memory\n\n${config.memoryContent}`);
          parts.push(message);
          proc.stdin!.write(parts.join("\n\n---\n\n"));
          proc.stdin!.end();

          proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
            clearTimeout(hardTimer);
            if (sigkillTimer) clearTimeout(sigkillTimer);
            const wasKilled = proc.killed;
            session.process = null;

            const parsed = parseCodexJson(stdout);
            if (parsed.sessionId) session.lastSessionId = parsed.sessionId;

            // 의도적 중단(steer/abort) — 실패로 취급하지 않는다. Codex는 resume 부재라 다음 턴이
            // fresh로 재주입되지만, "failed" status 방출은 건너뛰어 UI 헛 실패를 막는다.
            if (interrupting) {
              session.status = "idle";
              session.emit("status", "idle");
              log.info(`Codex session ${session.id} interrupted (steer/abort)`);
              resolve({ stdout: stdout.trim(), stderr, exitCode: code, sessionId: session.lastSessionId, provider: "codex", interrupted: true });
              return;
            }

            session.status = code === 0 ? "completed" : "failed";
            session.emit("status", session.status);

            // rate-limit은 즉시 surface (내부 대기 없음 — failover가 scheduler에서 처리).
            // failover 관측성: 트리거가 어느 백엔드(codex)에서 났는지 페이로드에 태깅한다.
            if (code !== 0 && isCodexRateLimit(stderr)) {
              session.emit("rate-limit", { stderr: stderr.slice(0, 200), provider: "codex" });
            }

            if (code === 0) {
              log.info("Codex completed", { stdoutLen: stdout.length, sessionId: session.lastSessionId });
            } else {
              log.error(`Codex exited with code ${code}`, { stderr: stderr.slice(0, 1000), signal, wasKilled });
            }

            const enrichedStderr = code === null && signal
              ? `${stderr}${stderr.endsWith("\n") ? "" : "\n"}[crewdeck] process terminated by signal ${signal}${wasKilled ? " (killed)" : ""}`
              : stderr;

            resolve({ stdout: stdout.trim(), stderr: enrichedStderr, exitCode: code, sessionId: session.lastSessionId, provider: "codex" });
          });

          proc.on("error", (err: Error) => {
            clearTimeout(hardTimer);
            if (sigkillTimer) clearTimeout(sigkillTimer);
            session.process = null;
            session.status = "failed";
            session.emit("status", "failed");
            const isNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
            if (isNotFound) log.error(`Codex CLI not found in PATH: ${safeEnv.PATH}`);
            log.error("Failed to spawn Codex", err);
            session.emit("crewdeck:error", makeSpawnFailedError(err.message, "codex").toJSON());
            reject(err);
          });
        });
      };

      session.kill = () => {
        const proc = session.process;
        if (!proc) return;
        // 의도적 중단 — close 핸들러(interrupting 분기)가 상태 정리를 담당. SIGKILL 에스컬레이션은
        // 이 proc이 아직 현재 프로세스일 때만(교체된 다음 턴 오폭 방지).
        interrupting = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (session.process === proc) {
            log.warn(`Codex session ${session.id} did not exit after SIGTERM (kill), sending SIGKILL`);
            proc.kill("SIGKILL");
          }
        }, SIGKILL_TIMEOUT_MS).unref?.();
      };

      session.cleanup = () => {
        session.kill();
      };

      return session;
    },
  };
}
