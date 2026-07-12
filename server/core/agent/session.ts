import type { Database } from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getBackend, type AgentSession, type AgentProvider } from "./adapters/backend.js";
import { resolveProviderTrace, loadProviderConfig } from "./provider.js";
import { createLogger } from "../../utils/logger.js";
import { resolvePrompt } from "./prompt-resolver.js";
import { loadMemory } from "./memory.js";
import { agentActivityLog, parseActivityEvents } from "./activity-log.js";
import { ROLE_DEFAULT_MODEL } from "../../utils/constants.js";
import { buildSummonContext } from "./summon-context.js";
import { recordRecoveryIncident, recoverInterruptedTask } from "../recovery.js";
import type { RecoveryDecision, RecoveryPhase } from "../../../shared/types.js";
import { readProcessIdentity } from "./process-identity.js";

const log = createLogger("session-manager");

export interface SessionManager {
  /** Spawn a session. sessionKey defaults to agentId; use a unique key for concurrent sessions on the same agent.
   *  taskId stamps sessions.task_id so failover redispatch backfill can correlate the session to its task. */
  spawnAgent: (
    agentId: string,
    projectWorkdir: string,
    sessionKey?: string,
    taskId?: string | null,
    executionContext?: ExecutionSessionContext,
  ) => AgentSession;
  getSession: (agentId: string) => AgentSession | undefined;
  getSessionRecord: (sessionKey: string) => SessionRecord | undefined;
  killSession: (agentId: string) => void;
  killAll: () => void;
  pauseSession: (agentId: string) => void;
  resumeSession: (agentId: string) => void;
  /** failover: 다음 spawn(sessionKey)이 강제로 이 provider를 쓰도록 override 설정 */
  setProviderOverride: (sessionKey: string, provider: AgentProvider) => void;
  clearProviderOverride: (sessionKey: string) => void;
  /** Called by the owning pipeline only after adapter-internal retries finish. */
  recoverAbnormalExit?: (
    sessionKey: string,
    phase: RecoveryPhase,
    mode: "reconcile" | "advance",
    reason: string,
  ) => RecoveryDecision | null;
}

export interface ExecutionSessionContext {
  executionRunId: string;
  executionSpecVersionId: string;
}

export interface SessionRecord {
  sessionKey: string;
  agentId: string;
  rowId: string;
  provider: AgentProvider;
  runtimeSessionId: string | null;
}

export function createSessionManager(
  db: Database,
  broadcast?: (event: string, data: unknown) => void,
): SessionManager {
  const sessions = new Map<string, AgentSession>();
  /** Maps session key → real agent ID (for DB operations) */
  const keyToAgentId = new Map<string, string>();
  /** Maps session key → sessions.id row — precise DB updates when multiple
   *  sessionKeys share the same agentId (e.g., concurrent verifications). */
  const keyToSessionRowId = new Map<string, string>();
  /** Last known session metadata per key. Kept after killSession so Quality
   *  Gate can compare the just-finished implementation session with its
   *  evaluator session. */
  const keyToSessionRecord = new Map<string, SessionRecord>();
  /** failover override: sessionKey → 강제 provider (Task 8 scheduler가 설정/해제) */
  const providerOverrides = new Map<string, AgentProvider>();

  return {
    spawnAgent(
      agentId: string,
      projectWorkdir: string,
      sessionKey?: string,
      taskId?: string | null,
      executionContext?: ExecutionSessionContext,
    ): AgentSession {
      const key = sessionKey ?? agentId;

      // Cleanup existing session for this key (memory map + DB)
      const existing = sessions.get(key);
      if (existing) {
        existing.cleanup();
        // Mark previous DB row as killed so it doesn't linger as "active"
        const prevRowId = keyToSessionRowId.get(key);
        if (prevRowId) {
          db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ? AND status = 'active'").run(prevRowId);
        }
        sessions.delete(key);
        keyToAgentId.delete(key);
        keyToSessionRowId.delete(key);
      }

      // Get agent config from DB
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
      if (!agent) throw new Error(`Agent ${agentId} not found`);

      const resolution = resolvePrompt(agent, projectWorkdir);
      log.info(`Spawned agent ${agent.role} (source: ${resolution.source}${resolution.filePath ? `, file: ${resolution.filePath}` : ""})`);

      // Session Context Chain — 최근 3개 완료 태스크의 제목만 (요약은 --add-dir로 접근 가능)
      const recentTasks = db.prepare(`
        SELECT title FROM tasks
        WHERE assignee_id = ? AND status = 'done'
        ORDER BY updated_at DESC LIMIT 3
      `).all(agentId) as { title: string }[];

      let contextChain = "";
      if (recentTasks.length > 0) {
        contextChain = "\n\n## Recently Completed Tasks\n" +
          recentTasks.map((t) => `- ${t.title}`).join("\n");
      }

      // 프로젝트 컨텍스트: tech stack만 (git log, project docs는 --add-dir로 접근 가능)
      const project = db.prepare("SELECT tech_stack, workdir, default_provider FROM projects WHERE id = ?")
        .get(agent.project_id) as { tech_stack: string | null; workdir: string; default_provider: string | null } | undefined;

      let projectContext = "";
      if (project?.tech_stack) {
        try {
          const stack = JSON.parse(project.tech_stack);
          projectContext += `\n\n## Tech Stack\n${stack.languages?.join(", ") || "unknown"} / ${stack.frameworks?.join(", ") || "none"}`;
        } catch { /* invalid JSON */ }
      }

      // NOTE: Project docs (plans, references) are NOT inlined — accessible via --add-dir
      // NOTE: Git log is NOT inlined — agent can run git commands if needed

      // 프로젝트 CLAUDE.md 동적 주입 — 에이전트에게 프로젝트 규칙/컨벤션 전달
      // 기존 수동 복붙("[Project Context from CLAUDE.md]")이 있으면 건너뛰어 중복 방지
      const alreadyHasClaudeMd = resolution.prompt.includes("[Project Context from CLAUDE.md]");
      let claudeMdContext = "";
      if (projectWorkdir && !alreadyHasClaudeMd) {
        const claudeMdPath = join(projectWorkdir, "CLAUDE.md");
        if (existsSync(claudeMdPath)) {
          try {
            const content = readFileSync(claudeMdPath, "utf-8").trim();
            if (content.length > 0) {
              // 50KB 제한 — 비정상적으로 큰 CLAUDE.md 방어
              const truncated = content.length > 50 * 1024
                ? content.slice(0, 50 * 1024) + "\n\n...(truncated)"
                : content;
              claudeMdContext = `## Project Rules (CLAUDE.md)\n\n${truncated}\n\n---\n\n`;
              log.info(`Loaded CLAUDE.md (${content.length} bytes) from ${projectWorkdir}`);
            }
          } catch (err) {
            log.warn(`Failed to read CLAUDE.md from ${projectWorkdir}: ${err}`);
          }
        }
      } else if (alreadyHasClaudeMd) {
        log.info(`Skipping CLAUDE.md injection — already embedded in agent prompt (legacy static copy)`);
      }

      // 에이전트 메모리 로드 (3KB 제한 — 시스템 프롬프트 비대화 방지)
      const dataDir = process.env.CREWDECK_DATA_DIR || join(process.cwd(), ".crewdeck");
      const memory = loadMemory(dataDir, agentId);

      // 소환(⚡): taskId가 있으면 그 goal의 기획서·worktree·판정·최근출력을 프리앰블로 주입.
      const summonPreamble = buildSummonContext(db, taskId).preamble;
      const enrichedPrompt = claudeMdContext + resolution.prompt + contextChain + projectContext + summonPreamble;

      // Model resolution: agent-level override > role default > CLI default
      const resolvedModel = agent.model || ROLE_DEFAULT_MODEL[agent.role] || undefined;

      // 실행 백엔드 해석: agent.provider → project.default_provider → 전역 기본(claude).
      // failover override(Task 8)가 이 sessionKey에 있으면 최우선.
      const providerCfg = loadProviderConfig();
      const overrideProvider = providerOverrides.get(key);
      const providerResolution = resolveProviderTrace(agent, project ?? {}, providerCfg);
      const provider = overrideProvider ?? providerResolution.provider;
      const adapter = getBackend(provider);

      // Retrieve last session's runtime conversation id for resume (Paperclip pattern).
      // MUST be runtime_session_id (the provider's conversation UUID), NOT sessions.id
      // (crewdeck's internal 16-hex row id) — passing the internal id to `--resume` makes
      // the Claude CLI fail immediately with a `result/error_during_execution` (num_turns:0,
      // no text), which surfaces as "Goal suggestion produced no text output".
      // Filter by provider so a Claude spawn never resumes a Codex thread id (and vice
      // versa) — a provider mismatch would re-trigger the same hard failure.
      const lastSession = db.prepare(
        `SELECT runtime_session_id FROM sessions
          WHERE agent_id = ? AND status = 'completed' AND provider = ?
            AND runtime_session_id IS NOT NULL
          ORDER BY ended_at DESC LIMIT 1`,
      ).get(agentId, provider) as { runtime_session_id: string } | undefined;

      // 모델 매핑: agent.model은 Claude 별칭(opus/sonnet). Codex엔 codexModelMap으로 변환(없으면 -m 생략).
      const modelForBackend = provider === "codex"
        ? (resolvedModel ? providerCfg.codexModelMap[resolvedModel] : undefined)
        : resolvedModel;

      const session = adapter.spawn({
        workdir: projectWorkdir,
        systemPrompt: enrichedPrompt,
        sessionBehavior: agent.session_behavior || "resume-or-new",
        resumeSessionId: lastSession?.runtime_session_id ?? null,
        skillsDir: agent.skills_dir || undefined,
        memoryContent: memory || undefined,
        model: modelForBackend,
        provider,
      });

      const taskExecutionContext = taskId
        ? db.prepare(`
            SELECT
              task.execution_run_id,
              run.execution_spec_version_id
            FROM tasks AS task
            LEFT JOIN goal_execution_runs AS run
              ON run.id = task.execution_run_id
             AND run.goal_id = task.goal_id
            WHERE task.id = ?
          `).get(taskId) as {
            execution_run_id: string | null;
            execution_spec_version_id: string | null;
          } | undefined
        : undefined;
      // task session은 호출자가 넘긴 복사본보다 task→run JOIN 결과가
      // authoritative하다. executionContext는 task가 없는 decompose session에만 쓴다.
      const executionRunId = taskId
        ? taskExecutionContext?.execution_run_id ?? null
        : executionContext?.executionRunId ?? null;
      const executionSpecVersionId = taskId
        ? taskExecutionContext?.execution_spec_version_id ?? null
        : executionContext?.executionSpecVersionId ?? null;

      // Track session in DB — use RETURNING to get session row id for PID update
      const sessionRow = db
        .prepare(`
          INSERT INTO sessions (
            agent_id, status, provider,
            provider_trace_resolved_provider, provider_trace_resolution_source, task_id,
            process_owner_token, execution_run_id, execution_spec_version_id
          ) VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?) RETURNING id
        `)
        // resolved_provider = 실제로 실행된 provider(failover override 반영). 기본 해석과
        // override가 갈릴 때 sessions.provider와 provider_trace_resolved_provider가 어긋나지
        // 않도록 override를 포함한 `provider`를 기록한다.
        // task_id: 이 세션이 실행하는 task — failover 재디스패치 backfill의 세션↔task 귀속에 쓴다.
        .get(
          agentId,
          provider,
          provider,
          providerResolution.source,
          taskId ?? null,
          session.id,
          executionRunId,
          executionSpecVersionId,
        ) as { id: string };
      keyToSessionRecord.set(key, {
        sessionKey: key,
        agentId,
        rowId: sessionRow.id,
        provider,
        runtimeSessionId: session.lastSessionId ?? null,
      });

      const rawSend = session.send.bind(session);
      session.send = async (message: string) => {
        const result = await rawSend(message);
        const runtimeSessionId = result.sessionId ?? session.lastSessionId ?? null;
        if (runtimeSessionId) {
          const record = keyToSessionRecord.get(key);
          if (record) record.runtimeSessionId = runtimeSessionId;
          db.prepare("UPDATE sessions SET runtime_session_id = ? WHERE id = ?")
            .run(runtimeSessionId, sessionRow.id);
        }
        return result;
      };

      // Capture PID immediately after spawn (before "working" event)
      session.on("pid", (pid: number) => {
        const identity = readProcessIdentity(pid);
        db.prepare(`
          UPDATE sessions
             SET pid = ?, process_started_at = ?, process_executable = ?, process_parent_id = ?
           WHERE id = ?
        `).run(
          pid,
          identity?.startToken ?? null,
          identity?.executable ?? null,
          identity?.parentProcessId ?? null,
          sessionRow.id,
        );
      });
      session.on("process-group-id", (processGroupId: number) => {
        db.prepare("UPDATE sessions SET process_group_id = ? WHERE id = ?").run(processGroupId, sessionRow.id);
      });

      // Listen for status changes
      session.on("status", (status: string) => {
        if (status === "working" && session.process?.pid) {
          // Fallback PID capture (in case "pid" event was missed)
          db.prepare("UPDATE sessions SET pid = COALESCE(pid, ?) WHERE id = ?").run(session.process.pid, sessionRow.id);
        }
        if (status === "working") {
          // Adapters may start a fresh internal attempt after a failed resume
          // or rate-limit wait. Keep the durable row active until send() has a
          // terminal outcome; callers reconcile only that final outcome.
          db.prepare("UPDATE sessions SET status = 'active', ended_at = NULL WHERE id = ?")
            .run(sessionRow.id);
          db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(agentId);
        } else {
          db.prepare("UPDATE agents SET status = 'idle', current_activity = NULL WHERE id = ?").run(agentId);
        }
        if (status === "completed" || status === "failed") {
          db.prepare("UPDATE sessions SET status = ?, ended_at = datetime('now') WHERE id = ? AND status = 'active'")
            .run(status, sessionRow.id);
        }
      });

      // Per-session buffer for stream-json line reassembly (chunks split lines).
      let activityLineBuf = "";
      session.on("output", (text: string) => {
        // Store last output snippet — scope to this specific session row to avoid
        // clobbering sibling sessions that share the same agent_id.
        db.prepare("UPDATE sessions SET last_output = ? WHERE id = ?")
          .run(text.slice(-500), sessionRow.id);

        // Activity ring buffer — parse complete stream-json lines into a
        // human-readable feed for the dashboard "라이브 활동" view. Recorded
        // against agentId (survives resume/fix cycles; see ActivityLogStore).
        activityLineBuf += text;
        const nl = activityLineBuf.lastIndexOf("\n");
        if (nl < 0) {
          // No complete line yet — guard against unbounded growth on a giant
          // single line (e.g. a huge tool result) by keeping only the tail.
          if (activityLineBuf.length > 1_000_000) activityLineBuf = activityLineBuf.slice(-1_000_000);
          return;
        }
        const complete = activityLineBuf.slice(0, nl);
        activityLineBuf = activityLineBuf.slice(nl + 1);
        for (const line of complete.split("\n")) {
          if (!line.trim()) continue;
          for (const ev of parseActivityEvents(line)) {
            agentActivityLog.record(agentId, ev);
          }
        }
      });

      sessions.set(key, session);
      keyToAgentId.set(key, agentId);
      keyToSessionRowId.set(key, sessionRow.id);
      log.info(`Spawned session for agent ${agentId} (key=${key}, role=${agent.role})`);
      return session;
    },

    getSession(agentId: string): AgentSession | undefined {
      return sessions.get(agentId);
    },

    getSessionRecord(sessionKey: string): SessionRecord | undefined {
      return keyToSessionRecord.get(sessionKey);
    },

    killSession(keyOrAgentId: string): void {
      const session = sessions.get(keyOrAgentId);
      if (session) {
        const realAgentId = keyToAgentId.get(keyOrAgentId) ?? keyOrAgentId;
        const sessionRowId = keyToSessionRowId.get(keyOrAgentId);
        session.removeAllListeners();
        session.cleanup();
        sessions.delete(keyOrAgentId);
        keyToAgentId.delete(keyOrAgentId);
        keyToSessionRowId.delete(keyOrAgentId);
        // Target the specific sessions row when we know it; otherwise fall back
        // to the legacy behavior. This prevents killing sibling active sessions
        // that share the same agent_id.
        if (sessionRowId) {
          db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ? AND status = 'active'")
            .run(sessionRowId);
        } else {
          db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE agent_id = ? AND status = 'active'")
            .run(realAgentId);
        }
        // Only reset the agent row to idle if no sibling session for the same
        // agent_id remains alive (otherwise it should stay 'working').
        const remaining = [...keyToAgentId.values()].filter((a) => a === realAgentId).length;
        if (remaining === 0) {
          db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE id = ?")
            .run(realAgentId);
        }
        log.info(`Killed session for agent ${realAgentId} (key=${keyOrAgentId})`);
      }
    },

    killAll(): void {
      for (const [key, session] of sessions) {
        const realAgentId = keyToAgentId.get(key) ?? key;
        const sessionRowId = keyToSessionRowId.get(key);
        session.removeAllListeners();
        session.cleanup();
        if (sessionRowId) {
          db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ? AND status = 'active'")
            .run(sessionRowId);
        } else {
          db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE agent_id = ? AND status = 'active'")
            .run(realAgentId);
        }
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE id = ?")
          .run(realAgentId);
      }
      sessions.clear();
      keyToAgentId.clear();
      keyToSessionRowId.clear();
      keyToSessionRecord.clear();
      log.info("Killed all sessions");
    },

    pauseSession(agentId: string): void {
      if (process.platform === "win32") {
        throw new Error("SIGSTOP is not supported on Windows");
      }
      const session = sessions.get(agentId);
      if (!session?.process?.pid) {
        throw new Error(`No active session for agent ${agentId}`);
      }
      process.kill(session.process.pid, "SIGSTOP");
      db.prepare("UPDATE agents SET status = 'paused' WHERE id = ?").run(agentId);
      log.info(`Paused session for agent ${agentId} (pid ${session.process.pid})`);
    },

    resumeSession(agentId: string): void {
      if (process.platform === "win32") {
        throw new Error("SIGCONT is not supported on Windows");
      }
      const session = sessions.get(agentId);
      if (!session?.process?.pid) {
        throw new Error(`No active session for agent ${agentId}`);
      }
      process.kill(session.process.pid, "SIGCONT");
      db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(agentId);
      log.info(`Resumed session for agent ${agentId} (pid ${session.process.pid})`);
    },

    setProviderOverride(sessionKey: string, provider: AgentProvider): void {
      providerOverrides.set(sessionKey, provider);
    },

    clearProviderOverride(sessionKey: string): void {
      providerOverrides.delete(sessionKey);
    },

    recoverAbnormalExit(
      sessionKey: string,
      phase: RecoveryPhase,
      mode: "reconcile" | "advance",
      reason: string,
    ): RecoveryDecision | null {
      const rowId = keyToSessionRowId.get(sessionKey);
      if (!rowId) return null;
      const owner = db.prepare(`
        SELECT s.task_id, t.goal_id, t.project_id
          FROM sessions s
          JOIN tasks t ON t.id = s.task_id
         WHERE s.id = ?
      `).get(rowId) as { task_id: string; goal_id: string; project_id: string } | undefined;
      if (!owner) return null;

      if (mode === "advance") {
        recordRecoveryIncident(db, {
          projectId: owner.project_id,
          goalId: owner.goal_id,
          phase,
          decision: "advance",
          reason,
          userAction: null,
          source: "session_exit",
        }, broadcast);
        return "advance";
      }
      return recoverInterruptedTask(db, owner.task_id, "session_exit", undefined, phase, broadcast);
    },
  };
}
