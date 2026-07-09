import type { Database } from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeCodeAdapter, type ClaudeCodeSession } from "./adapters/claude-code.js";
import { createLogger } from "../../utils/logger.js";
import { resolvePrompt } from "./prompt-resolver.js";
import { loadMemory } from "./memory.js";
import { agentActivityLog, parseActivityEvents } from "./activity-log.js";
import { ROLE_DEFAULT_MODEL } from "../../utils/constants.js";

const log = createLogger("session-manager");

export interface SessionManager {
  /** Spawn a session. sessionKey defaults to agentId; use a unique key for concurrent sessions on the same agent. */
  spawnAgent: (agentId: string, projectWorkdir: string, sessionKey?: string) => ClaudeCodeSession;
  getSession: (agentId: string) => ClaudeCodeSession | undefined;
  killSession: (agentId: string) => void;
  killAll: () => void;
  pauseSession: (agentId: string) => void;
  resumeSession: (agentId: string) => void;
}

export function createSessionManager(db: Database): SessionManager {
  const sessions = new Map<string, ClaudeCodeSession>();
  /** Maps session key → real agent ID (for DB operations) */
  const keyToAgentId = new Map<string, string>();
  /** Maps session key → sessions.id row — precise DB updates when multiple
   *  sessionKeys share the same agentId (e.g., concurrent verifications). */
  const keyToSessionRowId = new Map<string, string>();
  const adapter = createClaudeCodeAdapter();

  return {
    spawnAgent(agentId: string, projectWorkdir: string, sessionKey?: string): ClaudeCodeSession {
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

      // Retrieve last session ID for resume (Paperclip pattern)
      const lastSession = db.prepare(
        "SELECT id FROM sessions WHERE agent_id = ? AND status = 'completed' ORDER BY ended_at DESC LIMIT 1",
      ).get(agentId) as any;

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
      const project = db.prepare("SELECT tech_stack, workdir FROM projects WHERE id = ?")
        .get(agent.project_id) as { tech_stack: string | null; workdir: string } | undefined;

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

      const enrichedPrompt = claudeMdContext + resolution.prompt + contextChain + projectContext;

      // Model resolution: agent-level override > role default > CLI default
      const resolvedModel = agent.model || ROLE_DEFAULT_MODEL[agent.role] || undefined;

      const session = adapter.spawn({
        workdir: projectWorkdir,
        systemPrompt: enrichedPrompt,
        sessionBehavior: agent.session_behavior || "resume-or-new",
        resumeSessionId: lastSession?.id ?? null,
        skillsDir: agent.skills_dir || undefined,
        memoryContent: memory || undefined,
        model: resolvedModel,
      });

      // Track session in DB — use RETURNING to get session row id for PID update
      const sessionRow = db
        .prepare("INSERT INTO sessions (agent_id, status) VALUES (?, 'active') RETURNING id")
        .get(agentId) as { id: string };

      // Capture PID immediately after spawn (before "working" event)
      session.on("pid", (pid: number) => {
        db.prepare("UPDATE sessions SET pid = ? WHERE id = ?").run(pid, sessionRow.id);
      });

      // Listen for status changes
      session.on("status", (status: string) => {
        if (status === "working" && session.process?.pid) {
          // Fallback PID capture (in case "pid" event was missed)
          db.prepare("UPDATE sessions SET pid = COALESCE(pid, ?) WHERE id = ?").run(session.process.pid, sessionRow.id);
        }
        if (status === "working") {
          db.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(agentId);
        } else {
          db.prepare("UPDATE agents SET status = 'idle', current_activity = NULL WHERE id = ?").run(agentId);
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

    getSession(agentId: string): ClaudeCodeSession | undefined {
      return sessions.get(agentId);
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
          db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?")
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
          db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?")
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
  };
}

