import type Database from "better-sqlite3";
import type {
  AgentProvider,
  ProjectGoalReportsResponse,
  ReportDetail,
  ReportFinalStatus,
  ReportHistoryEntry,
  ReportProviderUsage,
  ReportSummary,
  ReportTelemetry,
  Verdict,
} from "../../../shared/types.js";

type GoalRow = {
  id: string;
  project_id: string;
  title: string;
  qa_regression_task_id: string | null;
};

type RunRow = {
  id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  telemetry_contract_version: number | null;
};

type TaskRow = {
  id: string;
  execution_run_id: string | null;
  updated_at: string;
  provider_failover_reason_code: string | null;
  provider_failover_user_message: string | null;
  provider_failover_from_provider: string | null;
  provider_failover_to_provider: string | null;
  provider_failover_redispatched: number;
  provider_failover_original_session_id: string | null;
  provider_failover_redispatched_session_id: string | null;
};

type SessionRow = {
  id: string;
  agent_id: string;
  task_id: string | null;
  execution_run_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  provider: string | null;
  token_usage: number | null;
  cost_usd: number | null;
  token_usage_reported: number | null;
  cost_usd_reported: number | null;
  provider_failover_reason_code: string | null;
  provider_failover_user_message: string | null;
  provider_failover_from_provider: string | null;
  provider_failover_to_provider: string | null;
  provider_failover_redispatched: number;
  provider_failover_original_session_id: string | null;
  provider_failover_redispatched_session_id: string | null;
};

type VerificationRow = {
  id: string;
  task_id: string;
  verdict: Verdict;
  created_at: string;
};

type FixRoundRow = {
  id: string;
  task_id: string;
  assignee_id: string | null;
  session_id: string | null;
  status: string;
  started_at: string | null;
  session_started_at: string | null;
  completed_at: string | null;
  created_at: string;
};

type ActivityRow = {
  id: number;
  type: string;
  message: string;
  metadata: string | null;
  created_at: string;
};

type RecoveryIncidentRow = {
  id: string;
  decision: string;
  reason: string;
  created_at: string;
};

type FailoverTrace = {
  sourceId: string;
  taskId: string | null;
  occurredAt: string;
  reason: string | null;
  message: string | null;
  fromProvider: string | null;
  toProvider: string | null;
  originalSessionId: string | null;
  redispatchedSessionId: string | null;
};

function isProvider(value: unknown): value is AgentProvider {
  return value === "claude" || value === "codex";
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function elapsedMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function buildProviderUsage(sessions: SessionRow[]): ReportProviderUsage[] {
  const grouped = new Map<AgentProvider, SessionRow[]>();

  for (const session of sessions) {
    if (!isProvider(session.provider)) continue;
    const rows = grouped.get(session.provider) ?? [];
    rows.push(session);
    grouped.set(session.provider, rows);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, rows]): ReportProviderUsage => {
      const distinctRows = [...new Map(rows.map((row) => [row.id, row])).values()];
      const tokensReported = distinctRows.every((row) =>
        row.token_usage !== null
        && (row.token_usage_reported === 1 || (row.token_usage_reported === null && row.token_usage !== 0)));
      const costReported = distinctRows.every((row) =>
        row.cost_usd !== null
        && (row.cost_usd_reported === 1 || (row.cost_usd_reported === null && row.cost_usd !== 0)));
      return {
        provider,
        sessionCount: distinctRows.length,
        tokens: tokensReported
          ? distinctRows.reduce((sum, row) => sum + (row.token_usage ?? 0), 0)
          : null,
        costUsd: costReported
          ? distinctRows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0)
          : null,
      };
    });
}

function collectRetryHistory(
  activities: ActivityRow[],
  taskIds: Set<string>,
  legacyTaskIds: Set<string>,
  runIds: Set<string>,
  firstRunStartedAt: string | null,
): ReportHistoryEntry[] {
  const seen = new Set<string>();
  const history: ReportHistoryEntry[] = [];

  for (const activity of activities) {
    if (activity.type !== "task_retry" && activity.type !== "task_reassigned") continue;
    const metadata = parseMetadata(activity.metadata);
    const taskId = asString(metadata?.taskId);
    if (!taskId || !taskIds.has(taskId)) continue;
    if (firstRunStartedAt && legacyTaskIds.has(taskId) && activity.created_at >= firstRunStartedAt) continue;
    const executionRunId = asString(metadata?.executionRunId);
    if (executionRunId && !runIds.has(executionRunId)) continue;
    const explicitId = asString(metadata?.eventId) ?? asString(metadata?.attemptId);
    const retryCount = asNonNegativeInteger(metadata?.retryCount);
    const reassignCount = asNonNegativeInteger(metadata?.reassignCount);
    const attempt = explicitId
      ?? (activity.type === "task_retry" && retryCount !== null
        ? `retry:${reassignCount ?? 0}:${retryCount}`
        : activity.type === "task_reassigned" && reassignCount !== null
          ? `reassign:${reassignCount}`
          : String(activity.id));
    const key = `${taskId}:${attempt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    history.push({
      kind: "retry",
      occurredAt: toIso(activity.created_at) ?? new Date(0).toISOString(),
      taskId,
      summary: activity.message.trim() || "Task retry recorded",
    });
  }

  return history;
}

function collectFailovers(tasks: TaskRow[], sessions: SessionRow[]): FailoverTrace[] {
  const traces: FailoverTrace[] = [];
  for (const task of tasks) {
    if (task.provider_failover_redispatched !== 1) continue;
    traces.push({
      sourceId: `task:${task.id}`,
      taskId: task.id,
      occurredAt: task.updated_at,
      reason: task.provider_failover_reason_code,
      message: task.provider_failover_user_message,
      fromProvider: task.provider_failover_from_provider,
      toProvider: task.provider_failover_to_provider,
      originalSessionId: task.provider_failover_original_session_id,
      redispatchedSessionId: task.provider_failover_redispatched_session_id,
    });
  }
  for (const session of sessions) {
    if (session.provider_failover_redispatched !== 1) continue;
    traces.push({
      sourceId: `session:${session.id}`,
      taskId: session.task_id,
      occurredAt: session.ended_at ?? session.started_at,
      reason: session.provider_failover_reason_code,
      message: session.provider_failover_user_message,
      fromProvider: session.provider_failover_from_provider,
      toProvider: session.provider_failover_to_provider,
      originalSessionId: session.provider_failover_original_session_id,
      redispatchedSessionId: session.provider_failover_redispatched_session_id,
    });
  }

  const completePairs = new Map<string, FailoverTrace>();
  for (const trace of traces) {
    if (!trace.originalSessionId || !trace.redispatchedSessionId) continue;
    const key = `${trace.originalSessionId}:${trace.redispatchedSessionId}`;
    const existing = completePairs.get(key);
    if (!existing || trace.sourceId.startsWith("task:")) completePairs.set(key, trace);
  }

  const incomplete = new Map<string, FailoverTrace>();
  for (const trace of traces) {
    if (trace.originalSessionId && trace.redispatchedSessionId) continue;
    if (trace.originalSessionId && [...completePairs.values()].some((pair) =>
      pair.originalSessionId === trace.originalSessionId
      && (!trace.taskId || !pair.taskId || pair.taskId === trace.taskId)
      && (!trace.fromProvider || pair.fromProvider === trace.fromProvider)
      && (!trace.toProvider || pair.toProvider === trace.toProvider))) {
      continue;
    }
    const key = [trace.taskId ?? "", trace.originalSessionId ?? "", trace.fromProvider ?? "", trace.toProvider ?? ""].join(":");
    if (!incomplete.has(key)) incomplete.set(key, trace);
  }

  return [...completePairs.values(), ...incomplete.values()];
}

function failoverHistory(traces: FailoverTrace[]): ReportHistoryEntry[] {
  return traces.map((trace) => ({
    kind: "failover",
    occurredAt: toIso(trace.occurredAt) ?? new Date(0).toISOString(),
    taskId: trace.taskId,
    summary: trace.message?.trim()
      || `${trace.fromProvider ?? "unknown"} → ${trace.toProvider ?? "unknown"} provider failover`,
  }));
}

function historyOrder(left: ReportHistoryEntry & { _id?: string }, right: ReportHistoryEntry & { _id?: string }): number {
  return left.occurredAt.localeCompare(right.occurredAt)
    || left.kind.localeCompare(right.kind)
    || (left._id ?? "").localeCompare(right._id ?? "");
}

function summaryFromDetail(detail: ReportDetail): ReportSummary {
  const { agentRoles: _agentRoles, history: _history, ...summary } = detail;
  return summary;
}

export function getGoalExecutionReport(db: Database.Database, goalId: string): ReportDetail | null {
  const goal = db.prepare(`
    SELECT id, project_id, title, qa_regression_task_id
    FROM goals WHERE id = ?
  `).get(goalId) as GoalRow | undefined;
  if (!goal) return null;

  const runs = db.prepare(`
    SELECT id, status, started_at, ended_at, telemetry_contract_version
    FROM goal_execution_runs
    WHERE goal_id = ?
    ORDER BY started_at ASC, id ASC
  `).all(goal.id) as RunRow[];
  const runIds = new Set(runs.map((run) => run.id));
  const firstRunStartedAt = runs[0]?.started_at ?? null;

  const tasks = db.prepare(`
    SELECT id, execution_run_id, updated_at,
           provider_failover_reason_code, provider_failover_user_message,
           provider_failover_from_provider, provider_failover_to_provider,
           provider_failover_redispatched,
           provider_failover_original_session_id, provider_failover_redispatched_session_id
    FROM tasks
    WHERE goal_id = ?
      AND (${runs.length
        ? `(execution_run_id IN (${placeholders(runs)})) OR (execution_run_id IS NULL AND created_at < ?)`
        : "execution_run_id IS NULL"})
    ORDER BY id ASC
  `).all(goal.id, ...runs.map((run) => run.id), ...(firstRunStartedAt ? [firstRunStartedAt] : [])) as TaskRow[];
  const taskIds = new Set(tasks.map((task) => task.id));
  const legacyTaskIds = new Set(tasks.filter((task) => task.execution_run_id === null).map((task) => task.id));

  const sessions = taskIds.size === 0 && runIds.size === 0
    ? []
    : db.prepare(`
        SELECT s.id, s.agent_id, s.task_id, s.execution_run_id, s.started_at, s.ended_at,
               s.status, s.provider, s.token_usage, s.cost_usd,
               s.token_usage_reported, s.cost_usd_reported,
               s.provider_failover_reason_code, s.provider_failover_user_message,
               s.provider_failover_from_provider, s.provider_failover_to_provider,
               s.provider_failover_redispatched,
               s.provider_failover_original_session_id, s.provider_failover_redispatched_session_id
        FROM sessions s
        WHERE ${runIds.size ? `s.execution_run_id IN (${placeholders(runs)}) OR` : ""}
          (s.execution_run_id IS NULL ${taskIds.size ? `AND s.task_id IN (${placeholders(tasks)})` : "AND 0"}
            ${firstRunStartedAt ? "AND s.started_at < ?" : ""})
        ORDER BY s.id ASC
      `).all(
        ...runs.map((run) => run.id),
        ...tasks.map((task) => task.id),
        ...(firstRunStartedAt ? [firstRunStartedAt] : []),
      ) as SessionRow[];

  const verificationRows = taskIds.size
    ? db.prepare(`
        SELECT id, task_id, verdict, created_at
        FROM verifications
        WHERE task_id IN (${placeholders(tasks)})
        ORDER BY created_at ASC, id ASC
      `).all(...tasks.map((task) => task.id)) as VerificationRow[]
    : [];
  const verifications = verificationRows.filter((verification) =>
    !firstRunStartedAt || !legacyTaskIds.has(verification.task_id) || verification.created_at < firstRunStartedAt);
  const fixRoundRows = taskIds.size
    ? db.prepare(`
        SELECT round.id, round.task_id, round.assignee_id, round.session_id, round.status,
               round.started_at, session.started_at AS session_started_at,
               round.completed_at, round.created_at
        FROM verification_fix_rounds round
        LEFT JOIN sessions session ON session.id = round.session_id
        WHERE round.task_id IN (${placeholders(tasks)})
        ORDER BY round.created_at ASC, round.id ASC
      `).all(...tasks.map((task) => task.id)) as FixRoundRow[]
    : [];
  const fixRounds = fixRoundRows.filter((round) => {
    const occurredAt = round.started_at ?? round.session_started_at ?? round.created_at;
    return !firstRunStartedAt || !legacyTaskIds.has(round.task_id) || occurredAt < firstRunStartedAt;
  });
  const startedFixRounds = fixRounds.filter((round) =>
    round.status !== "pending" || round.started_at !== null || round.session_id !== null);

  const activities = taskIds.size
    ? db.prepare(`
        SELECT id, type, message, metadata, created_at
        FROM activities
        WHERE project_id = ?
          AND type IN ('task_retry', 'task_reassigned')
        ORDER BY id ASC
      `).all(goal.project_id) as ActivityRow[]
    : [];
  const recoveryIncidents = db.prepare(`
    SELECT id, decision, reason, created_at
    FROM recovery_incidents
    WHERE goal_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(goal.id) as RecoveryIncidentRow[];
  const recoveryActivities = recoveryIncidents.length
    ? db.prepare(`
        SELECT id, type, message, metadata, created_at
        FROM activities
        WHERE project_id = ?
          AND type IN ('recovery_incident', 'recovery_promoted', 'recovery_manual_action')
        ORDER BY id ASC
      `).all(goal.project_id) as ActivityRow[]
    : [];
  const retryHistory = collectRetryHistory(activities, taskIds, legacyTaskIds, runIds, firstRunStartedAt);
  const failoverTasks = tasks.filter((task) =>
    !firstRunStartedAt || task.execution_run_id !== null || task.updated_at < firstRunStartedAt);
  const failovers = collectFailovers(failoverTasks, sessions);

  const startedAt = runs.length
    ? runs.map((run) => toIso(run.started_at)).filter((value): value is string => value !== null).sort()[0] ?? null
    : null;
  const hasActiveRun = runs.some((run) => run.status === "active");
  const endedAt = !runs.length || hasActiveRun || runs.some((run) => !run.ended_at)
    ? null
    : runs.map((run) => toIso(run.ended_at)).filter((value): value is string => value !== null).sort().at(-1) ?? null;
  const latestRun = [...runs].sort((left, right) =>
    right.started_at.localeCompare(left.started_at) || right.id.localeCompare(left.id))[0];

  let finalStatus: ReportFinalStatus = "interrupted";
  if (hasActiveRun) finalStatus = "running";
  else if (latestRun?.status === "completed") finalStatus = "completed";
  else if (latestRun?.status === "failed") finalStatus = "failed";

  const finalVerification = (() => {
    const qaRows = goal.qa_regression_task_id
      ? verifications.filter((verification) => verification.task_id === goal.qa_regression_task_id)
      : [];
    const candidates = qaRows.length ? qaRows : verifications;
    return [...candidates].sort((left, right) =>
      right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))[0];
  })();

  const providers = buildProviderUsage(sessions);
  const hasRecords = runs.length > 0 || tasks.length > 0 || sessions.length > 0
    || verifications.length > 0 || startedFixRounds.length > 0 || recoveryIncidents.length > 0;
  const hasCompleteRunBoundaries = runs.length > 0 && runs.every((run) =>
    toIso(run.started_at) !== null
    && (run.status === "active" || toIso(run.ended_at) !== null));
  const hasCurrentTelemetryContract = runs.length > 0
    && runs.every((run) => run.telemetry_contract_version === 1);
  const hasCompleteSessionTelemetry = sessions.every((session) =>
    isProvider(session.provider)
    && session.token_usage !== null
    && session.token_usage_reported === 1
    && session.cost_usd !== null
    && session.cost_usd_reported === 1);
  const telemetry: ReportTelemetry = !hasRecords
    ? "none"
    : hasCompleteRunBoundaries && hasCurrentTelemetryContract && hasCompleteSessionTelemetry
      ? "complete"
      : "partial";

  const agentIds = new Set(sessions.map((session) => session.agent_id));
  for (const round of startedFixRounds) if (round.assignee_id) agentIds.add(round.assignee_id);
  const agentRoles = agentIds.size
    ? (db.prepare(`
        SELECT DISTINCT role FROM agents
        WHERE project_id = ? AND id IN (${placeholders([...agentIds])})
        ORDER BY role ASC
      `).all(goal.project_id, ...agentIds) as { role: string }[]).map((row) => row.role)
    : [];

  const historyWithIds: Array<ReportHistoryEntry & { _id: string }> = [];
  const recoveryMetadata = new Map<string, Record<string, unknown>>();
  for (const activity of recoveryActivities) {
    const metadata = parseMetadata(activity.metadata);
    const incidentId = asString(metadata?.incident_id);
    if (incidentId && !recoveryMetadata.has(incidentId)) recoveryMetadata.set(incidentId, metadata!);
  }
  const incidentSessionIds = new Set<string>();
  for (const incident of recoveryIncidents) {
    const metadata = recoveryMetadata.get(incident.id);
    const source = asString(metadata?.source);
    if (source !== "session_exit" && incident.decision !== "blocked") continue;
    const sessionId = asString(metadata?.sessionId);
    if (sessionId) incidentSessionIds.add(sessionId);
    historyWithIds.push({
      _id: `recovery:${incident.id}`,
      kind: "failure",
      occurredAt: toIso(incident.created_at) ?? new Date(0).toISOString(),
      taskId: asString(metadata?.taskId),
      summary: incident.reason,
    });
  }
  for (const session of sessions) {
    if (session.status !== "failed" || incidentSessionIds.has(session.id)) continue;
    historyWithIds.push({
      _id: session.id,
      kind: "failure",
      occurredAt: toIso(session.ended_at ?? session.started_at) ?? new Date(0).toISOString(),
      taskId: session.task_id,
      summary: "Agent session failed",
    });
  }
  const failedSessionRunIds = new Set(
    sessions
      .filter((session) => session.status === "failed" && session.execution_run_id)
      .map((session) => session.execution_run_id as string),
  );
  for (const run of runs) {
    if (run.status !== "failed" || failedSessionRunIds.has(run.id)) continue;
    historyWithIds.push({
      _id: run.id,
      kind: "failure",
      occurredAt: toIso(run.ended_at ?? run.started_at) ?? new Date(0).toISOString(),
      taskId: null,
      summary: "Goal execution failed",
    });
  }
  historyWithIds.push(...retryHistory.map((entry, index) => ({ ...entry, _id: `retry:${index}` })));
  historyWithIds.push(...failoverHistory(failovers).map((entry, index) => ({ ...entry, _id: `failover:${index}` })));
  for (const verification of verifications) {
    historyWithIds.push({
      _id: verification.id,
      kind: "evaluation",
      occurredAt: toIso(verification.created_at) ?? new Date(0).toISOString(),
      taskId: verification.task_id,
      summary: `Quality Gate verdict: ${verification.verdict}`,
    });
  }
  for (const round of startedFixRounds) {
    historyWithIds.push({
      _id: round.id,
      kind: "fix",
      occurredAt: toIso(round.started_at ?? round.session_started_at ?? round.created_at) ?? new Date(0).toISOString(),
      taskId: round.task_id,
      summary: `Quality Gate fix round: ${round.status}`,
    });
  }
  historyWithIds.sort(historyOrder);

  return {
    goalId: goal.id,
    title: goal.title,
    finalStatus,
    startedAt,
    endedAt,
    durationMs: elapsedMs(startedAt, endedAt),
    providers,
    retryCount: retryHistory.length,
    failoverCount: failovers.length,
    evaluationCount: new Set(verifications.map((verification) => verification.id)).size,
    fixRoundCount: new Set(startedFixRounds.map((round) => round.id)).size,
    finalVerdict: finalVerification?.verdict ?? null,
    telemetry,
    agentRoles,
    history: historyWithIds.map(({ _id: _ignored, ...entry }) => entry),
  };
}

export function getProjectGoalReports(db: Database.Database, projectId: string): ProjectGoalReportsResponse | null {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!project) return null;
  const goals = db.prepare("SELECT id FROM goals WHERE project_id = ?").all(projectId) as { id: string }[];
  const reports = goals
    .map((goal) => getGoalExecutionReport(db, goal.id))
    .filter((report): report is ReportDetail => report !== null)
    .map(summaryFromDetail)
    .sort((left, right) => {
      if (left.startedAt === null && right.startedAt !== null) return 1;
      if (left.startedAt !== null && right.startedAt === null) return -1;
      return (right.startedAt ?? "").localeCompare(left.startedAt ?? "")
        || left.goalId.localeCompare(right.goalId);
    });
  return { reports };
}
