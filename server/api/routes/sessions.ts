import { Router } from "express";
import type { AppContext } from "../../index.js";
import { loadProviderConfig } from "../../core/agent/provider.js";
import { createLogger } from "../../utils/logger.js";
import type {
  AgentProvider,
  ProviderFailoverReasonCode,
  ProviderResolutionSource,
  ProviderTrace,
} from "../../../shared/types.js";

const log = createLogger("sessions-api");
const PROVIDERS: AgentProvider[] = ["claude", "codex"];
const RESOLUTION_SOURCES: ProviderResolutionSource[] = ["agent", "project", "global"];
const FAILOVER_REASONS: ProviderFailoverReasonCode[] = ["rate_limit", "session_exhausted", "env_error"];

function isProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && PROVIDERS.includes(value as AgentProvider);
}

function asProvider(value: unknown, fallback: AgentProvider): AgentProvider {
  return isProvider(value) ? value : fallback;
}

function asResolutionSource(value: unknown): ProviderResolutionSource | null {
  return typeof value === "string" && RESOLUTION_SOURCES.includes(value as ProviderResolutionSource)
    ? value as ProviderResolutionSource
    : null;
}

function asFailoverReason(value: unknown): ProviderFailoverReasonCode | null {
  return typeof value === "string" && FAILOVER_REASONS.includes(value as ProviderFailoverReasonCode)
    ? value as ProviderFailoverReasonCode
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBooleanFlag(value: unknown): boolean {
  return value === true || value === 1;
}

function buildProviderTrace(row: Record<string, unknown>, globalDefault: AgentProvider): ProviderTrace {
  const resolutionSource = asResolutionSource(row.provider_trace_resolution_source)
    ?? (isProvider(row.agent_provider) ? "agent" : isProvider(row.project_default_provider) ? "project" : "global");
  const inheritedProvider = resolutionSource === "agent"
    ? row.agent_provider
    : resolutionSource === "project"
      ? row.project_default_provider
      : globalDefault;
  const resolvedProvider = asProvider(
    row.provider_trace_resolved_provider ?? row.provider,
    asProvider(inheritedProvider, globalDefault),
  );

  return {
    resolvedProvider,
    resolutionSource,
    failover: {
      reasonCode: asFailoverReason(row.provider_failover_reason_code),
      userMessage: asNullableString(row.provider_failover_user_message),
      fromProvider: isProvider(row.provider_failover_from_provider) ? row.provider_failover_from_provider : null,
      toProvider: isProvider(row.provider_failover_to_provider) ? row.provider_failover_to_provider : null,
      redispatched: asBooleanFlag(row.provider_failover_redispatched),
      loopGuardBlocked: asBooleanFlag(row.provider_failover_loop_guard_blocked),
      originalSessionId: asNullableString(row.provider_failover_original_session_id),
      redispatchedSessionId: asNullableString(row.provider_failover_redispatched_session_id),
    },
  };
}

function serializeSession(row: Record<string, unknown>, globalDefault: AgentProvider): Record<string, unknown> {
  const {
    agent_provider: _agentProvider,
    project_default_provider: _projectDefaultProvider,
    provider_trace_resolved_provider: _providerTraceResolvedProvider,
    provider_trace_resolution_source: _providerTraceResolutionSource,
    provider_failover_reason_code: _providerFailoverReasonCode,
    provider_failover_user_message: _providerFailoverUserMessage,
    provider_failover_from_provider: _providerFailoverFromProvider,
    provider_failover_to_provider: _providerFailoverToProvider,
    provider_failover_redispatched: _providerFailoverRedispatched,
    provider_failover_loop_guard_blocked: _providerFailoverLoopGuardBlocked,
    provider_failover_original_session_id: _providerFailoverOriginalSessionId,
    provider_failover_redispatched_session_id: _providerFailoverRedispatchedSessionId,
    ...session
  } = row;

  return {
    ...session,
    providerTrace: buildProviderTrace(row, globalDefault),
  };
}

export function createSessionRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

  // List all sessions with agent/project info
  router.get("/", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    let where = "1=1";
    const params: string[] = [];

    if (status) {
      where += " AND s.status = ?";
      params.push(status);
    }
    if (projectId) {
      where += " AND a.project_id = ?";
      params.push(projectId);
    }

    const globalDefault = loadProviderConfig().defaultProvider;
    const rows = db.prepare(`
      SELECT s.id, s.agent_id, s.task_id, s.execution_run_id, s.execution_spec_version_id,
             s.workspace_id, s.session_key, s.origin,
             s.pid, s.started_at, s.ended_at, s.status,
             s.token_usage, s.cost_usd, s.provider,
             s.provider_trace_resolved_provider, s.provider_trace_resolution_source,
             s.provider_failover_reason_code, s.provider_failover_user_message,
             s.provider_failover_from_provider, s.provider_failover_to_provider,
             s.provider_failover_redispatched, s.provider_failover_loop_guard_blocked,
             s.provider_failover_original_session_id, s.provider_failover_redispatched_session_id,
             a.name AS agent_name, a.role AS agent_role, a.status AS agent_status,
             a.current_activity, a.current_task_id, a.provider AS agent_provider,
             p.id AS project_id, p.name AS project_name, p.default_provider AS project_default_provider,
             w.name AS workspace_name, w.worktree_path, w.worktree_branch
      FROM sessions s
      JOIN agents a ON s.agent_id = a.id
      JOIN projects p ON a.project_id = p.id
      LEFT JOIN workspaces w ON w.id = s.workspace_id
      WHERE ${where}
      ORDER BY s.started_at DESC
      LIMIT 200
    `).all(...params);

    res.json(rows.map((row) => serializeSession(row as Record<string, unknown>, globalDefault)));
  });

  // Get session stats summary (optionally scoped to a project)
  router.get("/stats", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    const whereClause = projectId
      ? "WHERE s.agent_id IN (SELECT id FROM agents WHERE project_id = ?)"
      : "";
    const params = projectId ? [projectId] : [];

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN s.status = 'killed' THEN 1 ELSE 0 END) as killed,
        SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) as failed,
        COALESCE(SUM(s.token_usage), 0) as total_tokens,
        COALESCE(SUM(s.cost_usd), 0) as total_cost
      FROM sessions s
      ${whereClause}
    `).get(...params);

    // Detect orphan sessions: active in DB but process not running.
    const activeSessions = db.prepare(
      `SELECT s.id, s.pid, s.started_at FROM sessions s
       ${projectId ? "WHERE s.status = 'active' AND s.agent_id IN (SELECT id FROM agents WHERE project_id = ?)" : "WHERE s.status = 'active'"}`,
    ).all(...params) as { id: string; pid: number | null; started_at: string }[];

    let orphanCount = 0;
    const now = Date.now();
    const GRACE_MS = 30_000;
    for (const s of activeSessions) {
      const age = now - new Date(s.started_at + "Z").getTime();
      if (age < GRACE_MS) continue; // still starting up
      if (!s.pid) { orphanCount++; continue; }
      try {
        process.kill(s.pid, 0);
      } catch {
        orphanCount++;
      }
    }

    res.json({ ...(stats as Record<string, unknown>), orphan: orphanCount });
  });

  // Kill a specific session
  router.delete("/:id", (req, res) => {
    const session = db.prepare(
      `SELECT s.id, s.agent_id, s.session_key, a.name, a.project_id
         FROM sessions s
         JOIN agents a ON s.agent_id = a.id
        WHERE s.id = ?`,
    ).get(req.params.id) as {
      id: string;
      agent_id: string;
      session_key: string | null;
      name: string;
      project_id: string;
    } | undefined;

    if (!session) return res.status(404).json({ error: "Session not found" });

    if (session.session_key) {
      ctx.sessionManager?.killSession(session.session_key);
    }

    // Force DB update in case killSession didn't reach this row
    db.prepare(
      "UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ? AND status = 'active'",
    ).run(req.params.id);

    const activeSibling = db.prepare(
      "SELECT 1 FROM sessions WHERE agent_id = ? AND status = 'active' LIMIT 1",
    ).get(session.agent_id);
    if (!activeSibling) {
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE id = ?",
      ).run(session.agent_id);
    }

    log.info(`Session ${req.params.id} killed via API (agent: ${session.name})`);
    broadcast("project:updated", { projectId: session.project_id });
    res.json({ success: true, killed: session.id });
  });

  // Cleanup orphan sessions (active in DB but process dead)
  router.post("/cleanup", (_req, res) => {
    const active = db.prepare(
      "SELECT id, pid, agent_id, started_at FROM sessions WHERE status = 'active'",
    ).all() as { id: string; pid: number | null; agent_id: string; started_at: string }[];

    const now = Date.now();
    const GRACE_MS = 30_000;
    let cleaned = 0;
    for (const s of active) {
      const age = now - new Date(s.started_at + "Z").getTime();
      if (age < GRACE_MS) continue; // still starting up — don't kill
      let alive = false;
      if (s.pid) {
        try { process.kill(s.pid, 0); alive = true; } catch { alive = false; }
      }
      if (!alive) {
        db.prepare(
          "UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?",
        ).run(s.id);
        // Reset agent status too
        db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE id = ?",
        ).run(s.agent_id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.info(`Cleaned ${cleaned} orphan session(s)`);
      broadcast("project:updated", {});
    }

    res.json({ success: true, cleaned, checked: active.length });
  });

  return router;
}
