import type { Database } from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getBackend, type AgentSession, type AgentProvider } from "./adapters/backend.js";
import { resolveProviderTrace, loadProviderConfig } from "./provider.js";
import { createLogger } from "../../utils/logger.js";
import { resolvePrompt } from "./prompt-resolver.js";
import { loadMemory } from "./memory.js";
import { agentActivityLog, parseActivityEvents, type ActivityInput } from "./activity-log.js";
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
    promptOptions?: SessionPromptOptions,
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

export interface SessionPromptOptions {
  /** Structured phase handoff is authoritative; do not leak prior session prose. */
  omitUnstructuredTaskOutput?: boolean;
  /** Start a provider conversation with no resume chain. */
  forceNewSession?: boolean;
  /** Generator(구현·fix) 스텝 경계 전용: 이 goal 의 pending 조향(steering) 노트를 시스템
   *  프롬프트 말미에 주입하고 큐를 소진(injected=1)한다. Evaluator 세션은 이 옵션을
   *  설정하지 않으므로 주입 대상에서 제외된다(Generator-Evaluator 분리 유지). */
  injectSteeringForGoalId?: string;
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
      promptOptions?: SessionPromptOptions,
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
      const summonPreamble = buildSummonContext(db, taskId, {
        includeLastOutput: !promptOptions?.omitUnstructuredTaskOutput,
      }).preamble;

      // 조향(steering) 주입 — Generator(구현·fix) 스텝 경계 전용. 이 goal 의 pending 노트를
      // FIFO 로 조회해 프롬프트 말미(최고 salience)에 붙인다. 실제 큐 소진·activity log 기록은
      // 세션 row 가 만들어진 뒤(injected_step = sessions.id) 수행한다. spawn 이 실패하면
      // sessionRow 에 도달하지 못하므로 노트는 pending 으로 남아 다음 스텝에서 재시도된다.
      const steeringGoalId = promptOptions?.injectSteeringForGoalId;
      const pendingSteering = steeringGoalId
        ? db.prepare(`
            SELECT id, content, created_at FROM goal_steering_notes
            WHERE goal_id = ? AND injected = 0
            ORDER BY created_at ASC, rowid ASC
          `).all(steeringGoalId) as { id: string; content: string; created_at: string }[]
        : [];
      let steeringBlock = "";
      if (pendingSteering.length > 0) {
        steeringBlock = "\n\n## 사용자 조향 지침 (실행 중 제출 — 우선 반영)\n"
          + "사용자가 이 goal 실행을 관찰하며 남긴 조향 메시지다. 현재 스텝 작업에 우선 반영하라.\n"
          + pendingSteering.map((n, i) => `${i + 1}. ${n.content}`).join("\n");
      }

      const enrichedPrompt = claudeMdContext + resolution.prompt + contextChain + projectContext + summonPreamble + steeringBlock;

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
        sessionBehavior: promptOptions?.forceNewSession
          ? "new"
          : agent.session_behavior || "resume-or-new",
        resumeSessionId: promptOptions?.forceNewSession ? null : lastSession?.runtime_session_id ?? null,
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

      // 조향 큐 소진 + activity log — 프롬프트에 실제로 반영된 이 스텝(sessionRow.id)을
      // injected_step 으로 마킹해 재주입을 막고, '조향 주입됨'(제출 시각·반영 스텝·내용)을
      // 남겨 언제 무엇이 반영됐는지 추적 가능하게 한다. steeringGoalId 는 Generator 경로에서만 세팅됨.
      if (steeringGoalId && pendingSteering.length > 0) {
        const injectedStep = sessionRow.id;
        const injectedAt = (db.prepare("SELECT datetime('now') AS value").get() as { value: string }).value;
        const markNote = db.prepare(
          "UPDATE goal_steering_notes SET injected = 1, injected_at = ?, injected_step = ? WHERE id = ? AND injected = 0",
        );
        db.transaction(() => {
          for (const n of pendingSteering) markNote.run(injectedAt, injectedStep, n.id);
        })();
        const preview = pendingSteering.map((n) => n.content).join(" / ").slice(0, 200);
        const activityRow = db.prepare(`
          INSERT INTO activities (project_id, agent_id, type, message, metadata)
          VALUES (?, ?, 'steering_injected', ?, ?)
          RETURNING id, project_id, agent_id, type, message, metadata, created_at
        `).get(
          agent.project_id,
          agentId,
          `조향 주입됨: ${pendingSteering.length}건 → ${preview}`,
          JSON.stringify({
            goalId: steeringGoalId,
            taskId: taskId ?? null,
            sessionId: injectedStep,
            injectedStep,
            notes: pendingSteering.map((n) => ({ id: n.id, content: n.content, createdAt: n.created_at })),
          }),
        ) as {
          id: number; project_id: string; agent_id: string | null;
          type: string; message: string; metadata: string | null; created_at: string;
        };
        log.info(`Injected ${pendingSteering.length} steering note(s) into ${agent.role} step (session ${injectedStep})`);
        if (broadcast) {
          broadcast("activity:created", {
            ...activityRow,
            projectId: activityRow.project_id,
            agentId: activityRow.agent_id,
            metadata: activityRow.metadata ? JSON.parse(activityRow.metadata) : null,
            createdAt: activityRow.created_at,
          });
          // 조향 큐 pending→injected 전이를 대시보드 조향 뷰가 폴링 없이 즉시 반영하도록
          // 전용 타입으로도 broadcast. activity feed와 별개(반영 스텝·건수·노트 스코프).
          broadcast("steering:injected", {
            goalId: steeringGoalId,
            projectId: agent.project_id,
            agentId,
            injectedStep,
            injectedAt,
            count: pendingSteering.length,
            notes: pendingSteering.map((n) => ({ id: n.id, content: n.content, createdAt: n.created_at })),
          });
        }
      }

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
        const streamed: ActivityInput[] = [];
        for (const line of complete.split("\n")) {
          if (!line.trim()) continue;
          for (const ev of parseActivityEvents(line)) {
            agentActivityLog.record(agentId, ev);
            streamed.push(ev);
          }
        }
        // 활성 session 실시간 관찰 뷰용 스트림. output 이벤트는 spawn 후에만 발화하므로
        // "spawn 전 emit 금지" 규칙에 안전. agentActivityLog(1/sec 스로틀·agentId 집계)와 달리
        // session_id 스코프로 라인 단위 즉시 append — 이번 chunk에서 완성된 라인만 배치 전송.
        if (broadcast && streamed.length > 0) {
          broadcast("session:stream", {
            agentId,
            sessionId: sessionRow.id,
            taskId: taskId ?? null,
            projectId: agent.project_id,
            role: agent.role,
            events: streamed,
          });
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
          taskId: owner.task_id,
          sessionId: rowId,
        }, broadcast);
        return "advance";
      }
      return recoverInterruptedTask(
        db,
        owner.task_id,
        "session_exit",
        undefined,
        phase,
        broadcast,
        { taskId: owner.task_id, sessionId: rowId },
      );
    },
  };
}
