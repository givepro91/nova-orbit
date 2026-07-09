import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync, mkdtempSync, writeFileSync, symlinkSync,
  existsSync, rmSync, readdirSync, readFileSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createLogger } from "../../../utils/logger.js";
import { TASK_TIMEOUT_MS, RATE_LIMIT_WAIT_MS, SIGKILL_TIMEOUT_MS } from "../../../utils/constants.js";
import {
  makeRateLimitError,
  makeSessionExpiredError,
  makeSpawnFailedError,
  makeTimeoutError,
  type NovaAgentErrorData,
} from "../../../utils/errors.js";

const log = createLogger("claude-code-adapter");

export interface ClaudeCodeConfig {
  workdir: string;
  systemPrompt: string;
  skillsDir?: string;
  sessionBehavior: "resume-or-new" | "new";
  resumeSessionId?: string | null;
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
  dangerouslySkipPermissions?: boolean;
  memoryContent?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  sessionId: string | null;
}

export interface ClaudeCodeSession extends EventEmitter {
  id: string;
  process: ChildProcess | null;
  status: "idle" | "working" | "completed" | "failed";
  lastSessionId: string | null;
  send: (message: string) => Promise<RunResult>;
  kill: () => void;
  cleanup: () => void;
}

/**
 * Claude Code CLI Adapter
 *
 * Based on Paperclip's claude_local adapter (validated in production):
 *
 * Key patterns from Paperclip analysis:
 * 1. child_process.spawn with `--print -` + `--output-format stream-json`
 * 2. Prompt passed via stdin (stdin.write → stdin.end)
 * 3. `--add-dir` flag with temp dir containing `.claude/skills/` symlinks
 * 4. `--append-system-prompt-file` for long system prompts (not --system-prompt)
 * 5. `--resume <sessionId>` for session persistence
 * 6. Auto-retry with fresh session if resume fails ("unknown session" error)
 * 7. Temp directory cleanup after run
 *
 * @see /Users/keunsik/develop/swk/paperclip/packages/adapters/claude-local/src/server/execute.ts
 */
export function createClaudeCodeAdapter() {
  return {
    spawn(config: ClaudeCodeConfig): ClaudeCodeSession {
      const session = new EventEmitter() as ClaudeCodeSession;
      session.id = randomUUID().slice(0, 16);
      session.process = null;
      session.status = "idle";
      session.lastSessionId = config.resumeSessionId ?? null;

      // Build temp directory with skills + system prompt file
      const tempDir = buildTempDir(config);

      /**
       * Send a message to Claude Code CLI.
       *
       * Paperclip pattern: prompt goes via stdin, NOT as CLI argument.
       * This avoids shell escaping issues with long/complex prompts.
       */
      session.send = async (message: string): Promise<RunResult> => {
        // Rate-limit retry budget (anti-infinite-loop).
        // Previously `return runAttempt(null)` recursed on every rate-limit,
        // so a sustained quota miss would wedge the session in a 60s-wait →
        // retry → 60s-wait cycle for hours. Cap the retries so the caller
        // eventually sees a failed result and can transition the task.
        let rateLimitRetries = 0;
        const MAX_RATE_LIMIT_RETRIES = 1;
        const runAttempt = (resumeId: string | null): Promise<RunResult> => {
          return new Promise((resolve, reject) => {
            session.status = "working";
            session.emit("status", "working");

            const args = buildArgs(config, tempDir, resumeId);

            log.info("Spawning Claude Code CLI", {
              workdir: config.workdir,
              resume: resumeId ?? "new",
              args: args.join(" "),
            });

            const TIMEOUT_MS = TASK_TIMEOUT_MS;

            const ALLOWED_ENV_KEYS = [
              "PATH", "HOME", "SHELL", "USER", "LANG", "LC_ALL", "TERM",
              "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK",
              "NODE_ENV", "TMPDIR", "XDG_CONFIG_HOME",
            ];
            const safeEnv: Record<string, string> = {
              BROWSER: "none",
              CREWDECK_AGENT_ID: session.id,
            };
            for (const key of ALLOWED_ENV_KEYS) {
              if (process.env[key]) safeEnv[key] = process.env[key]!;
            }
            // Ensure common binary paths are in PATH (npm/tsx may strip them)
            const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
            const currentPath = safeEnv.PATH ?? "";
            const missingPaths = extraPaths.filter((p) => !currentPath.includes(p));
            if (missingPaths.length > 0) {
              safeEnv.PATH = [currentPath, ...missingPaths].filter(Boolean).join(":");
            }

            const proc: ChildProcess = spawn("claude", args, {
              cwd: resolvePath(config.workdir),
              stdio: ["pipe", "pipe", "pipe"] as const,
              env: safeEnv,
            });

            session.process = proc;

            // Emit PID immediately after spawn so session.ts can record it.
            // The earlier "working" event fires before spawn(), so
            // session.process?.pid is null at that point.
            if (proc.pid) {
              session.emit("pid", proc.pid);
            }

            // Two-layer timeout:
            // 1. Hard timeout: absolute max wall-clock time (prevents truly stuck processes)
            // 2. Idle timeout: no output for TIMEOUT_MS (catches broken pipes, crashed processes)
            //    BUT: idle timer only starts AFTER first output (TTFT can be long for complex prompts)
            let sigkillTimer: ReturnType<typeof setTimeout> | null = null;
            let lastActivity = Date.now();
            let hasReceivedOutput = false;

            const HARD_TIMEOUT_MS = TIMEOUT_MS * 3; // 3x idle timeout as absolute max

            /** Clear all pending timers to prevent leaks */
            const clearAllTimers = () => {
              if (idleTimer) { clearTimeout(idleTimer); idleTimer = null as any; }
              if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
            };

            /** Reset idle timer on activity (prevents stale timer from firing) */
            const resetIdleTimer = () => {
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(checkTimeout, hasReceivedOutput ? TIMEOUT_MS : 30000);
            };

            const checkTimeout = () => {
              if (!session.process) return;

              const elapsed = Date.now() - lastActivity;

              // Before first output: only enforce hard timeout (TTFT may be slow)
              if (!hasReceivedOutput) {
                const totalElapsed = Date.now() - startTime;
                if (totalElapsed >= HARD_TIMEOUT_MS) {
                  clearAllTimers();
                  log.warn(`Session ${session.id} hard timeout: ${Math.round(totalElapsed / 1000)}s with no output at all, sending SIGTERM`);
                  session.process.kill("SIGTERM");
                  const novaError = makeTimeoutError(totalElapsed);
                  session.emit("nova:error", novaError.toJSON());
                  sigkillTimer = setTimeout(() => {
                    if (session.process) {
                      log.warn(`Session ${session.id} did not exit after SIGTERM, sending SIGKILL`);
                      session.process.kill("SIGKILL");
                    }
                  }, SIGKILL_TIMEOUT_MS);
                } else {
                  idleTimer = setTimeout(checkTimeout, 30000); // Re-check every 30s
                }
                return;
              }

              // After first output: enforce idle timeout
              if (elapsed >= TIMEOUT_MS) {
                clearAllTimers();
                log.warn(`Session ${session.id} idle for ${Math.round(elapsed / 1000)}s (no output after first response), sending SIGTERM`);
                session.process.kill("SIGTERM");
                const novaError = makeTimeoutError(elapsed);
                session.emit("nova:error", novaError.toJSON());
                sigkillTimer = setTimeout(() => {
                  if (session.process) {
                    log.warn(`Session ${session.id} did not exit after SIGTERM, sending SIGKILL`);
                    session.process.kill("SIGKILL");
                  }
                }, SIGKILL_TIMEOUT_MS);
              } else {
                idleTimer = setTimeout(checkTimeout, TIMEOUT_MS - elapsed + 100);
              }
            };
            const startTime = Date.now();
            let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(checkTimeout, TIMEOUT_MS);

            let stdout = "";
            let stderr = "";

            proc.stdout!.on("data", (chunk: Buffer) => {
              const text = chunk.toString();
              stdout += text;
              lastActivity = Date.now();
              hasReceivedOutput = true;
              resetIdleTimer(); // Fix: reset timer on each output
              session.emit("output", text);
            });

            proc.stderr!.on("data", (chunk: Buffer) => {
              const text = chunk.toString();
              stderr += text;
              lastActivity = Date.now();
              hasReceivedOutput = true;
              resetIdleTimer(); // Fix: reset timer on each output
              session.emit("stderr", text);
            });

            // Paperclip pattern: write prompt to stdin, then close
            proc.stdin!.write(message);
            proc.stdin!.end();

            proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
              clearAllTimers();
              const wasKilled = proc.killed;
              session.process = null;

              // Try to extract sessionId from stream-json output
              const extractedSessionId = extractSessionId(stdout);
              if (extractedSessionId) {
                session.lastSessionId = extractedSessionId;
              }

              if (code === 0) {
                session.status = "completed";
                session.emit("status", "completed");
                log.info(`Claude Code completed`, {
                  stdoutLen: stdout.length,
                  stderrLen: stderr.length,
                  sessionId: session.lastSessionId,
                  hasReceivedOutput,
                });
              } else {
                session.status = "failed";
                session.emit("status", "failed");
                log.error(`Claude Code exited with code ${code}`, {
                  stdoutLen: stdout.length,
                  stderrLen: stderr.length,
                  stderr: stderr.slice(0, 1000),
                  signal,
                  wasKilled,
                  hasReceivedOutput,
                });
              }

              if (stdout.trim() === "") {
                log.warn(`Claude Code produced empty stdout (exit code: ${code}, signal: ${signal ?? "none"}, killed: ${wasKilled})`, {
                  stderr: stderr.slice(0, 500),
                });
              }

              // Surface signal/kill info via stderr so upstream parsers can see it
              const enrichedStderr = code === null && signal
                ? `${stderr}${stderr.endsWith("\n") ? "" : "\n"}[nova] process terminated by signal ${signal}${wasKilled ? " (killed)" : ""}`
                : stderr;

              resolve({ stdout: stdout.trim(), stderr: enrichedStderr, exitCode: code, sessionId: session.lastSessionId });
            });

            proc.on("error", (err: Error) => {
              clearAllTimers(); // Fix: prevent timer leaks on spawn failure
              session.process = null;
              session.status = "failed";
              session.emit("status", "failed");
              const isNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
              if (isNotFound) {
                log.error(`Claude Code CLI not found in PATH: ${safeEnv.PATH}`);
              }
              log.error("Failed to spawn Claude Code", err);
              const novaError = makeSpawnFailedError(err.message);
              session.emit("nova:error", novaError.toJSON());
              reject(err);
            });
          });
        };

        // Paperclip pattern: attempt resume, fallback to fresh session
        const resumeId =
          config.sessionBehavior === "resume-or-new"
            ? session.lastSessionId
            : null;

        const result = await runAttempt(resumeId);

        // If resume failed with "unknown session" error, retry fresh
        if (
          resumeId &&
          result.exitCode !== 0 &&
          isUnknownSessionError(result.stderr)
        ) {
          log.info(
            `Session "${resumeId}" unavailable, retrying with fresh session`,
          );
          const novaError = makeSessionExpiredError(resumeId);
          session.emit("nova:error", novaError.toJSON());
          session.lastSessionId = null;
          return runAttempt(null);
        }

        // Rate limit detection — wait and retry at most MAX_RATE_LIMIT_RETRIES
        // times. After the budget is exhausted we surface the failed result
        // to the caller (engine → scheduler) which owns the queue-level
        // backoff via handleRateLimit.
        if (result.exitCode !== 0 && isRateLimitError(result.stderr)) {
          const waitMs = RATE_LIMIT_WAIT_MS;
          const novaError = makeRateLimitError(result.stderr.slice(0, 200));
          session.emit("rate-limit", { waitMs, stderr: result.stderr.slice(0, 200) });
          session.emit("nova:error", novaError.toJSON());
          if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
            log.warn(
              `Rate limit hit after ${rateLimitRetries} retries — surfacing to caller`,
              { stderr: result.stderr.slice(0, 300) },
            );
            session.emit(
              "output",
              `\n[Rate limit retry budget exhausted (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}). Returning to scheduler.]\n`,
            );
            return result;
          }
          rateLimitRetries++;
          log.warn(`Rate limit hit, waiting ${waitMs / 1000}s before retry (${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`);
          session.emit("output", `\n[Rate limit reached. Waiting ${waitMs / 1000}s before retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}...]\n`);
          await new Promise((r) => setTimeout(r, waitMs));
          session.lastSessionId = null;
          return runAttempt(null);
        }

        return result;
      };

      session.kill = () => {
        if (session.process) {
          session.process.kill("SIGTERM");
          session.process = null;
          session.status = "idle";
          session.emit("status", "idle");
        }
      };

      session.cleanup = () => {
        session.kill();
        // Cleanup temp directory (Paperclip pattern)
        if (tempDir && existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true });
          log.debug(`Cleaned up temp dir: ${tempDir}`);
        }
      };

      return session;
    },
  };
}

/**
 * Build CLI arguments.
 *
 * Paperclip uses: --print - --output-format stream-json --verbose
 * Plus: --append-system-prompt-file, --add-dir, --resume, --model, etc.
 */
function buildArgs(
  config: ClaudeCodeConfig,
  tempDir: string | null,
  resumeSessionId: string | null,
): string[] {
  // Core flags (Paperclip pattern)
  const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];

  // Session resume
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  // Model selection
  if (config.model) {
    args.push("--model", config.model);
  }

  // Max turns limit
  if (config.maxTurns && config.maxTurns > 0) {
    args.push("--max-turns", String(config.maxTurns));
  }

  // System prompt via file (Paperclip uses --append-system-prompt-file for long prompts)
  if (tempDir) {
    const promptFile = join(tempDir, ".nova-system-prompt");
    if (existsSync(promptFile)) {
      args.push("--append-system-prompt-file", promptFile);
    }
  }

  // Skills directory injection
  if (tempDir) {
    args.push("--add-dir", tempDir);
  }

  // Allowed tools
  if (config.allowedTools?.length) {
    args.push("--allowedTools", config.allowedTools.join(","));
  }

  // Skip permissions — requires explicit opt-in in ~/.crewdeck/config.json
  if (config.dangerouslySkipPermissions) {
    const configPath = join(homedir(), ".crewdeck", "config.json");
    let allowed = false;
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      allowed = cfg.allowDangerousPermissions === true;
    } catch {
      // config 없음 = 불허
    }
    if (allowed) {
      args.push("--dangerously-skip-permissions");
      log.warn("dangerouslySkipPermissions ENABLED — agent has unrestricted access");
    } else {
      log.info("dangerouslySkipPermissions requested but not allowed in config — ignoring");
    }
  }

  return args;
}

/**
 * Build temp directory with skills and system prompt.
 *
 * Mirrors Paperclip's structure:
 * - Creates temp dir
 * - Writes system prompt to file (for --append-system-prompt-file)
 * - Creates `.claude/skills/` subdirectory
 * - Symlinks each skill into it
 */
function buildTempDir(config: ClaudeCodeConfig): string | null {
  const tempDir = mkdtempSync(join(tmpdir(), "crewdeck-"));

  // Write system prompt to file
  if (config.systemPrompt) {
    writeFileSync(join(tempDir, ".nova-system-prompt"), config.systemPrompt);
  }

  // Write agent memory file for --add-dir injection (Sprint 6)
  if (config.memoryContent) {
    writeFileSync(join(tempDir, ".nova-agent-memory.md"), config.memoryContent);
  }

  // Create .claude/skills/ structure and symlink skills
  if (config.skillsDir && existsSync(config.skillsDir)) {
    const skillsTarget = join(tempDir, ".claude", "skills");
    mkdirSync(skillsTarget, { recursive: true });

    try {
      const entries = readdirSync(config.skillsDir);
      for (const entry of entries) {
        const source = join(config.skillsDir, entry);
        const link = join(skillsTarget, entry);
        symlinkSync(source, link);
      }
      log.debug(`Linked ${entries.length} skills to ${skillsTarget}`);
    } catch (err) {
      log.warn("Failed to symlink skills", err);
    }
  }

  return tempDir;
}

/**
 * Extract Claude session ID from stream-json output.
 * Paperclip parses the JSON stream to get the session ID for resume.
 */
function extractSessionId(output: string): string | null {
  try {
    // stream-json output has one JSON object per line
    const lines = output.split("\n").filter(Boolean);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.session_id) return parsed.session_id;
      if (parsed.sessionId) return parsed.sessionId;
    }
  } catch {
    // Not JSON or no session info
  }
  return null;
}

/**
 * Check if error indicates an unknown/expired session.
 * Paperclip auto-retries with fresh session in this case.
 */
function isUnknownSessionError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("unknown session") ||
    lower.includes("session not found") ||
    lower.includes("invalid session")
  );
}

/**
 * Check if error indicates a rate limit (Claude Pro usage exhausted).
 * Strict patterns only — previously `capacity` and bare `quota` matched
 * generic cloud errors (e.g. "insufficient disk capacity") and locked the
 * queue in a 15min cooldown over non-rate-limit noise.
 */
function isRateLimitError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    (lower.includes("out of") && lower.includes("usage")) ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("rate-limit") ||
    lower.includes("too many requests") ||
    lower.includes("status 429") ||
    lower.includes("http 429") ||
    lower.includes("error 429") ||
    lower.includes("usage limit") ||
    lower.includes("quota exceeded") ||
    lower.includes("api_usage_exceeded")
  );
}
