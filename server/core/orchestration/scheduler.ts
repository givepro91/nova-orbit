import type { Database } from "better-sqlite3";
import type { SessionManager } from "../agent/session.js";
import {
  checkAndTriggerGoalSquash,
  claimTaskForExecution,
  createOrchestrationEngine,
  type TaskExecutionClaim,
} from "./engine.js";
import { notFixTaskSql } from "./fix-relations.js";
import { createDelegationEngine } from "./delegation.js";
import { createQualityGate } from "../quality-gate/evaluator.js";
import { createLogger } from "../../utils/logger.js";
import { classifyAgentFailure } from "../../utils/errors.js";
import { getBackend, type AgentProvider } from "../agent/adapters/backend.js";
import { loadProviderConfig } from "../agent/provider.js";
import { decideFailover, triedProvidersFromFailoverTrace, type FailureClass, type FailoverReasonCode } from "../agent/failover.js";
import { selectTaskForResponse, serializeTask } from "../../api/routes/tasks.js";
import { assertExecutionAllowed, approveSpecVersion, getSpecState, SpecApprovalError } from "../goal-spec/spec-approval.js";
import type {
  ActivityLogEntry,
  ProviderFailoverEventPayload,
  ProviderRedispatchEventPayload,
  ProviderResolutionSource,
  ProviderResolvedEventPayload,
} from "../../../shared/types.js";
import {
  POLL_INTERVAL_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
  MAX_CONSECUTIVE_RATE_LIMITS, DEFAULT_MAX_CONCURRENCY,
  RATE_LIMIT_COOLDOWN_MS,
  MAX_TASK_RETRIES, MAX_REASSIGNS, BLOCKED_RETRY_DELAY_MS,
  TASK_TIMEOUT_MS,
} from "../../utils/constants.js";

const log = createLogger("scheduler");

export interface Scheduler {
  startQueue: (projectId: string) => void;
  stopQueue: (projectId: string, persistUserIntent?: boolean) => void;
  isRunning: (projectId: string) => boolean;
  isPaused: (projectId: string) => boolean;
  enforceDailyBudget: (projectId: string) => boolean;
  resumeQueue: (projectId: string) => void;
  getQueueState: (projectId: string) => QueueState;
  /** Notify that a goal was added or its spec completed — scheduler decides processing order. */
  notifyGoalReady: (projectId: string) => void;
  /** Clear all task assignees and re-run auto-assignment. Returns count of assigned tasks. */
  reassignAll: (projectId: string) => number;
  /**
   * Release all in-flight scheduler ownership for a goal that was just deleted.
   * Clears the spec/decompose lookahead flight, decompose retry backoff, and the
   * per-task failover/backfill state so a cancelled goal cannot keep the project
   * "busy" or re-dispatch its (now CASCADE-deleted) tasks. Call AFTER the goal row
   * is gone, passing the ids of the tasks it owned.
   */
  cancelGoal: (projectId: string, goalId: string, taskIds: string[]) => void;
}

export interface QueueState {
  running: boolean;
  paused: boolean;
  activeTasks: number;
  maxConcurrency: number;
  rateLimitRetries: number;
  nextRetryAt: string | null;
}

/** Goal 우선순위 정렬식 — pickNextTasks / pickParallelGoals 공용 (alias `g` 전제) */
const GOAL_PRIORITY_ORDER = `
  CASE g.priority
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
    ELSE 4
  END ASC, g.sort_order ASC, g.created_at ASC
`;

/**
 * Goal 간 병렬 선택: 이번 라운드에 태스크를 뽑을 goal 들을 고른다.
 *
 * - in-flight(in_progress/in_review) 태스크가 있는 goal 은 제외 — "goal 내부
 *   순차 1" 원칙상 이미 슬롯을 점유 중이다.
 * - ready(todo + assigned) 태스크가 있는 goal 을 우선순위 순으로 최대
 *   maxGoals 개. goal 간에는 worktree 가 격리되어 있어 병렬이 안전하다.
 *
 * "goal 내부 순차 1" 이 왜 필수인가 (Goal-as-Unit 계약): 한 goal 의 모든 태스크는
 * worktree 1개를 공유하고(엔진이 goal 시작 시 1회 생성, 실패하면 fallback 없이
 * hard-fail), 태스크 시작 시 stash 체크포인트를 찍는다. 같은 goal 태스크 2개가
 * 동시에 실행되면 같은 worktree 에서 파일 쓰기·stash 가 뒤섞여 맥락이 엇갈린다 —
 * 그래서 goal 간은 병렬 허용(worktree 격리), goal 내부는 항상 1개만 in-flight.
 *
 * 위임(delegation) 과의 상호작용: "위임 대기 부모"(미종결 하위 작업을 가진
 * in_progress 태스크)는 세션을 점유하지 않으므로 in-flight 판정에서 제외한다.
 * 하지만 그 goal 에 실제로 "돌고 있는" 하위 작업(대기 부모가 아닌 in_progress
 * 태스크)이 하나라도 있으면 그 태스크가 goal 전체를 in-flight 로 만들어 제외되므로,
 * 위임 중인 goal 도 결국 동시에 1개 work-stream 만 진행한다.
 */
export function pickParallelGoals(db: Database, projectId: string, maxGoals: number): string[] {
  if (maxGoals <= 0) return [];
  // in-flight 판정에서 "위임 대기 부모"(미종결 하위 작업을 가진 in_progress 태스크)는
  // 제외한다 — 대기 부모는 세션을 점유하지 않으며, 이를 in-flight로 치면 goal이
  // 병렬 선택에서 빠져 자기 하위 작업이 영영 안 뽑히는 기아가 생긴다 (07-08 실측:
  // ghost 복구가 부모를 todo로 되돌린 우연 덕에만 하위 작업이 진행됐다).
  const rows = db.prepare(`
    SELECT g.id FROM goals g
    WHERE g.project_id = ?
      AND g.squash_status != 'merged'
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.goal_id = g.id AND t.status IN ('in_progress', 'in_review')
          AND NOT EXISTS (
            SELECT 1 FROM tasks s
            WHERE s.parent_task_id = t.id
              AND s.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.goal_id = g.id
          AND t.status = 'todo'
          AND julianday(t.started_at) > julianday('now', '-5 seconds')
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks retrying
        WHERE retrying.goal_id = g.id
          AND retrying.status = 'blocked'
          AND (
            retrying.recovery_manual_action_required = 1
            OR NOT (retrying.retry_count >= ? AND retrying.reassign_count >= ?)
          )
      )
      AND EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.goal_id = g.id
          AND t.status = 'todo'
          AND t.assignee_id IS NOT NULL
      )
    ORDER BY ${GOAL_PRIORITY_ORDER}
    LIMIT ?
  `).all(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS, maxGoals) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * DB 상 "live execution lane" 을 점유한 agent id 집합.
 *
 * 실행 경로(스케줄러 executeOne vs 수동 POST /tasks/:id/execute)와 무관하게,
 * in_progress/in_review 태스크의 assignee 는 세션을 하나 점유 중이다. 스케줄러의
 * in-memory busyAgents 는 스케줄러 자신이 스폰한 세션만 알기 때문에, 수동 실행이
 * DB claim(in_progress)만 얻고 busyAgents 에는 등록되지 않는 경우 poll 이 같은
 * agent 의 다른 goal 태스크를 뽑아 spawnAgent 가 정상 세션을 cleanup(SIGTERM)한다.
 * DB 를 진실원으로 삼아 그 갭을 메운다.
 *
 * 위임 대기 부모(미종결 하위 작업을 가진 in_progress 태스크)는 라이브 세션 없이
 * 하위 작업 완료를 기다리는 상태라 세션을 점유하지 않으므로 제외한다 — pickParallelGoals
 * 의 in-flight 판정과 동일한 계약.
 */
export function getActiveAgentIds(
  db: Database,
  projectId: string,
  sessionManager?: SessionManager,
): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT t.assignee_id FROM tasks t
    WHERE t.project_id = ?
      AND t.assignee_id IS NOT NULL
      AND t.status IN ('in_progress', 'in_review')
      AND NOT EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.parent_task_id = t.id
          AND s.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
      )
  `).all(projectId) as { assignee_id: string }[];
  const active = new Set(rows.map((r) => r.assignee_id));
  for (const agentId of getActiveSessionAgentIds(db, projectId, sessionManager)) active.add(agentId);
  return active;
}

function getActiveSessionAgentIds(
  db: Database,
  projectId: string,
  sessionManager?: SessionManager,
): Set<string> {
  // A DB row can linger as status='active' after its process dies (crash/orphan).
  // When a sessionManager is supplied, cross-check in-memory liveness so a dead
  // 'active' row no longer protects a stale task from the ghost reconciler — an
  // in_review task assigned to the reviewer whose evaluator session died would
  // otherwise be trapped until the next restart. Scheduler-dispatched agents are
  // already tracked synchronously in busyAgents, so this does not open a
  // spawn-race in the hot dispatch path.
  const rows = db.prepare(`
    SELECT s.id, s.agent_id, s.session_key
    FROM sessions s
    JOIN agents a ON a.id = s.agent_id
    WHERE a.project_id = ?
      AND s.status = 'active'
  `).all(projectId) as Array<{ id: string; agent_id: string; session_key: string | null }>;
  if (!sessionManager) return new Set(rows.map((row) => row.agent_id));

  const activeAgentIds = new Set<string>();
  for (const row of rows) {
    const sessionKey = row.session_key ?? row.agent_id;
    const session = sessionManager.getSession(sessionKey);
    const record = sessionManager.getSessionRecord(sessionKey);
    if (!session || session.status === "completed" || session.status === "failed") continue;
    if (record && record.rowId !== row.id) continue;
    activeAgentIds.add(row.agent_id);
  }
  return activeAgentIds;
}

function getActiveSessionTaskIds(
  db: Database,
  projectId: string,
  sessionManager: SessionManager,
): Set<string> {
  const rows = db.prepare(`
    SELECT s.id, s.agent_id, s.session_key, s.task_id
    FROM sessions s
    JOIN tasks t ON t.id = s.task_id
    WHERE t.project_id = ?
      AND s.status = 'active'
      AND s.task_id IS NOT NULL
  `).all(projectId) as Array<{
    id: string;
    agent_id: string;
    session_key: string | null;
    task_id: string;
  }>;
  const activeTaskIds = new Set<string>();
  for (const row of rows) {
    const sessionKey = row.session_key ?? row.agent_id;
    const session = sessionManager.getSession(sessionKey);
    const record = sessionManager.getSessionRecord(sessionKey);
    if (!session || session.status === "completed" || session.status === "failed") continue;
    if (record && record.rowId !== row.id) continue;
    activeTaskIds.add(row.task_id);
  }
  return activeTaskIds;
}

interface ProviderFailoverDecisionRecord {
  reasonCode: FailoverReasonCode | null;
  userMessage: string | null;
  fromProvider: AgentProvider | null;
  toProvider: AgentProvider | null;
  redispatched: boolean;
  loopGuardBlocked: boolean;
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "claude" || value === "codex";
}

function asAgentProvider(value: unknown, fallback: AgentProvider): AgentProvider {
  return isAgentProvider(value) ? value : fallback;
}

function asResolutionSource(value: unknown): ProviderResolutionSource | null {
  return value === "agent" || value === "project" || value === "global" ? value : null;
}

function labelProvider(provider: AgentProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

function labelResolutionSource(source: ProviderResolutionSource): string {
  switch (source) {
    case "agent":
      return "에이전트 설정";
    case "project":
      return "프로젝트 설정";
    case "global":
      return "전역 기본값";
  }
}

function labelFailoverReason(reasonCode: FailoverReasonCode): string {
  switch (reasonCode) {
    case "rate_limit":
      return "사용량 한도";
    case "session_exhausted":
      return "세션 소진";
    case "env_error":
      return "실행 환경 오류";
  }
}

function asFailoverReasonCode(value: unknown): FailoverReasonCode | null {
  return value === "rate_limit" || value === "session_exhausted" || value === "env_error"
    ? value
    : null;
}

interface ActivityRow {
  id: number;
  project_id: string;
  agent_id: string | null;
  type: string;
  message: string;
  metadata: string | null;
  created_at: string;
}

function parseActivityMetadata(raw: string | null): Record<string, unknown> | null {
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

function serializeActivityRow(row: ActivityRow): ActivityLogEntry {
  return {
    id: row.id,
    project_id: row.project_id,
    projectId: row.project_id,
    agent_id: row.agent_id,
    agentId: row.agent_id,
    type: row.type,
    message: row.message,
    metadata: parseActivityMetadata(row.metadata),
    created_at: row.created_at,
    createdAt: row.created_at,
  };
}

function recordProviderFailoverDecision(
  db: Database,
  taskId: string,
  sessionId: string | null | undefined,
  decision: ProviderFailoverDecisionRecord,
): void {
  db.prepare(
    `UPDATE tasks SET
       provider_failover_reason_code =
         CASE WHEN provider_failover_redispatched = 1 THEN provider_failover_reason_code ELSE ? END,
       provider_failover_user_message =
         CASE WHEN provider_failover_redispatched = 1 THEN provider_failover_user_message ELSE ? END,
       provider_failover_from_provider =
         CASE WHEN provider_failover_redispatched = 1 THEN provider_failover_from_provider ELSE ? END,
       provider_failover_to_provider =
         CASE WHEN provider_failover_redispatched = 1 THEN provider_failover_to_provider ELSE ? END,
       provider_failover_redispatched =
         CASE WHEN provider_failover_redispatched = 1 THEN 1 ELSE ? END,
       provider_failover_loop_guard_blocked = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    decision.reasonCode,
    decision.userMessage,
    decision.fromProvider,
    decision.toProvider,
    decision.redispatched ? 1 : 0,
    decision.loopGuardBlocked ? 1 : 0,
    taskId,
  );

  if (!sessionId) return;
  db.prepare(
    `UPDATE sessions SET
       provider_failover_reason_code = ?,
       provider_failover_user_message = ?,
       provider_failover_from_provider = ?,
       provider_failover_to_provider = ?,
       provider_failover_redispatched = ?,
       provider_failover_loop_guard_blocked = ?
     WHERE id = ?`,
  ).run(
    decision.reasonCode,
    decision.userMessage,
    decision.fromProvider,
    decision.toProvider,
    decision.redispatched ? 1 : 0,
    decision.loopGuardBlocked ? 1 : 0,
    sessionId,
  );
}

export function markProviderFailoverLoopGuardBlocked(
  db: Database,
  taskId: string,
  sessionId: string | null | undefined,
  trace?: ProviderFailoverDecisionRecord,
): void {
  if (trace) {
    db.prepare(
      `UPDATE tasks SET
         provider_failover_reason_code = COALESCE(provider_failover_reason_code, ?),
         provider_failover_user_message = COALESCE(provider_failover_user_message, ?),
         provider_failover_from_provider = COALESCE(provider_failover_from_provider, ?),
         provider_failover_to_provider = COALESCE(provider_failover_to_provider, ?),
         provider_failover_redispatched =
           CASE WHEN provider_failover_redispatched = 1 THEN 1 ELSE ? END,
         provider_failover_loop_guard_blocked = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      trace.reasonCode,
      trace.userMessage,
      trace.fromProvider,
      trace.toProvider,
      trace.redispatched ? 1 : 0,
      trace.loopGuardBlocked ? 1 : 0,
      taskId,
    );
  } else {
    db.prepare(
      "UPDATE tasks SET provider_failover_loop_guard_blocked = 1, updated_at = datetime('now') WHERE id = ?",
    ).run(taskId);
  }
  if (!sessionId) return;
  if (trace) {
    db.prepare(
      `UPDATE sessions SET
         provider_failover_reason_code = ?,
         provider_failover_user_message = ?,
         provider_failover_from_provider = ?,
         provider_failover_to_provider = ?,
         provider_failover_redispatched = ?,
         provider_failover_loop_guard_blocked = ?
       WHERE id = ?`,
    ).run(
      trace.reasonCode,
      trace.userMessage,
      trace.fromProvider,
      trace.toProvider,
      trace.redispatched ? 1 : 0,
      trace.loopGuardBlocked ? 1 : 0,
      sessionId,
    );
    return;
  }
  db.prepare(
    "UPDATE sessions SET provider_failover_loop_guard_blocked = 1 WHERE id = ?",
  ).run(sessionId);
}

/**
 * Parallel task scheduler with per-agent concurrency control.
 *
 * - Each agent runs at most 1 task at a time (prevents session conflicts).
 * - Goals run in parallel (up to maxConcurrency, worktree-isolated);
 *   WITHIN a goal tasks stay sequential — 1 in flight per goal.
 * - Rate limit: pauses queue with exponential backoff.
 * - 3 consecutive rate limits → full stop.
 */
export function createScheduler(
  db: Database,
  sessionManager: SessionManager,
  broadcast: (event: string, data: unknown) => void,
): Scheduler & { setSpecGenerator: (fn: (goalId: string) => Promise<any>) => void } {
  const engine = createOrchestrationEngine(db, sessionManager, broadcast);
  // Share the same quality gate so parent-task verification works from both
  // engine (direct execution) and scheduler (delegation completion paths).
  const qualityGate = createQualityGate(db, sessionManager, broadcast);
  const delegationEngine = createDelegationEngine(db, sessionManager, broadcast, qualityGate);
  let generateGoalSpec: ((goalId: string) => Promise<any>) | null = null;

  // projectId → timer handle
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // AIMD: projectId → current effective concurrency limit
  // Starts at DEFAULT_MAX_CONCURRENCY, decreases on rate limit, increases on success.
  const effectiveConcurrency = new Map<string, number>();

  // failover: taskId → 이 태스크 시도에서 이미 써본 provider 집합 (claude↔codex 무한왕복 차단)
  const triedProvidersByTask = new Map<string, Set<AgentProvider>>();

  // failover 관측성 브리지: 재디스패치된 taskId → 원본(실패) 세션 id + 기대 provider.
  // 재실행이 새 세션을 만든 뒤(다음 poll의 executeOne) redispatched_session_id를 backfill한다.
  const pendingFailoverByTask = new Map<string, {
    originalSessionId: string | null;
    toProvider: AgentProvider;
    sessionKey: string;
    afterSessionRowId: number;
    // 재디스패치 재실행이 실제로 시작된 시점의 세션 rowid boundary. failover 예약 시엔
    // null이며, executeOne이 이 task를 재실행할 때 세팅된다. backfill은 이 값이 세팅된
    // 뒤에만(=재실행이 시작된 뒤) 그 이후 rowid의 세션을 재디스패치 세션으로 귀속한다.
    // afterSessionRowId(원본 실패 세션 기준)만 쓰면 failover 예약~재실행 사이에 낀 무관한
    // 세션이 오귀속되므로 task 식별 대용으로 재실행 boundary를 별도로 고정한다.
    redispatchAfterRowId: number | null;
  }>();

  const pendingBackfillTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // per-project 동시성 상한 (projects.max_concurrency ?? 전역 DEFAULT_MAX_CONCURRENCY).
  // 매 호출마다 DB 조회 → UI/API 로 바꾸면 재시작 없이 다음 사이클부터 반영.
  function getProjectBaseConcurrency(projectId: string): number {
    try {
      const row = db.prepare("SELECT max_concurrency FROM projects WHERE id = ?").get(projectId) as { max_concurrency: number | null } | undefined;
      const v = row?.max_concurrency;
      if (typeof v === "number" && v >= 1) return v;
    } catch { /* 컬럼 부재 등 — 전역 기본으로 폴백 */ }
    return DEFAULT_MAX_CONCURRENCY;
  }

  function getEffectiveConcurrency(projectId: string): number {
    return effectiveConcurrency.get(projectId) ?? getProjectBaseConcurrency(projectId);
  }

  /**
   * Project concurrency is a goal-slot contract, not an agent count.
   *
   * A live task occupies its goal's single execution lane. A recently released
   * claim also occupies it for the same short settle window enforced by
   * claimTaskForExecution, so a nested poll cannot fill that lane while a
   * concurrent dispatch is still settling.
   */
  function getOccupiedGoalIds(projectId: string): Set<string> {
    const staleThresholdSeconds = Math.ceil((TASK_TIMEOUT_MS * 3) / 1000);
    const rows = db.prepare(`
      SELECT t.goal_id, t.status, t.assignee_id,
        CASE
          WHEN t.status IN ('in_progress', 'in_review')
            AND (strftime('%s', 'now') - strftime('%s', t.updated_at)) > ?
          THEN 1 ELSE 0
        END AS is_stale
      FROM tasks t
      WHERE t.project_id = ?
        AND t.goal_id IS NOT NULL
        AND (
          (
            t.status IN ('in_progress', 'in_review')
            AND NOT EXISTS (
              SELECT 1 FROM tasks child
              WHERE child.parent_task_id = t.id
                AND child.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
            )
          )
          OR (
            t.status = 'todo'
            AND julianday(t.started_at) > julianday('now', '-5 seconds')
          )
        )
    `).all(staleThresholdSeconds, projectId) as {
      goal_id: string;
      status: string;
      assignee_id: string | null;
      is_stale: number;
    }[];

    const busy = getBusyAgents(projectId);
    const activeSessionAgents = getActiveSessionAgentIds(db, projectId, sessionManager);
    return new Set(
      rows
        // Let pickNextTasks reach its ghost recovery when a stale DB state has
        // no live scheduler owner. A genuinely running long task still owns
        // its lane through busyAgents or an active manual session even if its
        // task row is old.
        .filter((row) => row.is_stale === 0 || (row.assignee_id !== null
          && (busy.has(row.assignee_id) || activeSessionAgents.has(row.assignee_id))))
        .map((row) => row.goal_id),
    );
  }

  /**
   * A recoverable failure keeps ownership of its existing project goal slot.
   *
   * `blocked` rows reserve the lane while their cooldown runs. Once promoted
   * to `todo`, retry/reassign counters (or an unlinked failover trace) keep the
   * reservation until the exact same task is atomically reclaimed. This is
   * deliberately separate from getOccupiedGoalIds: a continuation owns a
   * slot, but must still be allowed to start inside that owned slot.
   */
  function getRetryReservedGoalIds(projectId: string): Set<string> {
    const rows = db.prepare(`
      SELECT DISTINCT goal_id FROM tasks
      WHERE project_id = ?
        AND goal_id IS NOT NULL
        AND (
          (
            status = 'blocked'
            AND recovery_manual_action_required = 0
            AND NOT (retry_count >= ? AND reassign_count >= ?)
          )
          OR (
            status = 'todo'
            AND (
              retry_count > 0
              OR reassign_count > 0
              OR (
                provider_failover_redispatched = 1
                AND provider_failover_redispatched_session_id IS NULL
              )
            )
          )
        )
    `).all(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { goal_id: string }[];
    return new Set(rows.map((row) => row.goal_id));
  }

  function recordActivity(input: {
    projectId: string;
    agentId?: string | null;
    type: string;
    message: string;
    metadata?: Record<string, unknown> | null;
  }): ActivityLogEntry | null {
    try {
      const row = db.prepare(
        `INSERT INTO activities (project_id, agent_id, type, message, metadata)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id, project_id, agent_id, type, message, metadata, created_at`,
      ).get(
        input.projectId,
        input.agentId ?? null,
        input.type,
        input.message,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ) as ActivityRow;
      const activity = serializeActivityRow(row);
      broadcast("activity:created", activity);
      return activity;
    } catch (err: any) {
      log.warn(`Failed to record activity ${input.type}: ${err?.message ?? err}`);
      return null;
    }
  }

  function readProviderResolution(task: any): {
    resolvedProvider: AgentProvider;
    resolutionSource: ProviderResolutionSource;
    failoverOverride: boolean;
  } {
    const cfg = loadProviderConfig();
    const pendingFailover = getPendingFailover(task.id);
    const row = db.prepare(
      `SELECT t.provider_trace_resolved_provider, t.provider_trace_resolution_source,
              a.provider AS agent_provider, p.default_provider AS project_default_provider
       FROM tasks t
       LEFT JOIN agents a ON a.id = t.assignee_id
       JOIN projects p ON p.id = t.project_id
       WHERE t.id = ?`,
    ).get(task.id) as {
      provider_trace_resolved_provider: string | null;
      provider_trace_resolution_source: string | null;
      agent_provider: string | null;
      project_default_provider: string | null;
    } | undefined;

    const resolutionSource = asResolutionSource(row?.provider_trace_resolution_source)
      ?? (isAgentProvider(row?.agent_provider) ? "agent" : isAgentProvider(row?.project_default_provider) ? "project" : "global");
    const inheritedProvider = resolutionSource === "agent"
      ? row?.agent_provider
      : resolutionSource === "project"
        ? row?.project_default_provider
        : cfg.defaultProvider;
    const baseProvider = asAgentProvider(
      row?.provider_trace_resolved_provider,
      asAgentProvider(inheritedProvider, cfg.defaultProvider),
    );

    return {
      resolvedProvider: pendingFailover?.toProvider ?? baseProvider,
      resolutionSource,
      failoverOverride: pendingFailover !== undefined,
    };
  }

  function recordProviderResolved(task: any): void {
    try {
      const trace = readProviderResolution(task);
      db.prepare(
        `UPDATE tasks SET
           provider_trace_resolved_provider = ?,
           provider_trace_resolution_source = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(trace.resolvedProvider, trace.resolutionSource, task.id);

      const sourceText = trace.failoverOverride
        ? "자동 전환"
        : labelResolutionSource(trace.resolutionSource);
      const taskTitle = String(task.title ?? "");
      const userMessage = `실행 엔진 선택: ${labelProvider(trace.resolvedProvider)} (${sourceText}) — "${taskTitle.slice(0, 80)}"`;
      const payload: ProviderResolvedEventPayload = {
        projectId: task.project_id ?? task.projectId ?? "",
        taskId: task.id,
        agentId: task.assignee_id ?? null,
        taskTitle,
        resolvedProvider: trace.resolvedProvider,
        resolutionSource: trace.resolutionSource,
        failoverOverride: trace.failoverOverride,
        userMessage,
      };

      recordActivity({
        projectId: payload.projectId,
        agentId: payload.agentId,
        type: "provider_resolved",
        message: userMessage,
        metadata: { event: "provider:resolved", ...payload },
      });
      broadcast("provider:resolved", payload);
    } catch (err: any) {
      log.warn(`Failed to record provider resolution for task ${task.id}: ${err?.message ?? err}`);
    }
  }

  function recordFailoverDecisionActivity(
    projectId: string,
    task: any,
    sessionId: string | null,
    decision: ProviderFailoverDecisionRecord,
  ): void {
    if (!decision.reasonCode || !decision.fromProvider || !decision.toProvider) return;

    const reasonLabel = labelFailoverReason(decision.reasonCode);
    const userMessage = decision.userMessage
      ?? `${labelProvider(decision.fromProvider)} ${reasonLabel}로 자동 전환 판단을 완료했습니다.`;
    const statusText = decision.redispatched
      ? "대체 엔진으로 재실행합니다"
      : decision.loopGuardBlocked
        ? "왕복 방지를 위해 추가 전환을 차단했습니다"
        : "쿨다운 후 재시도합니다";
    const message = `${reasonLabel}(reasonCode=${decision.reasonCode}): ${userMessage} ${statusText}.`;
    const payload: ProviderFailoverEventPayload = {
      projectId,
      taskId: task.id,
      agentId: task.assignee_id ?? null,
      taskTitle: String(task.title ?? ""),
      sessionId,
      reasonCode: decision.reasonCode,
      userMessage,
      fromProvider: decision.fromProvider,
      toProvider: decision.toProvider,
      redispatched: decision.redispatched,
      loopGuardBlocked: decision.loopGuardBlocked,
    };

    recordActivity({
      projectId,
      agentId: payload.agentId,
      type: "provider_failover_decision",
      message,
      metadata: { event: "provider:failover", ...payload },
    });
    broadcast("provider:failover", payload);
    if (decision.reasonCode === "rate_limit") {
      broadcast("system:error", {
        projectId,
        agentId: payload.agentId,
        taskId: payload.taskId,
        error: {
          code: "provider_rate_limit",
          reasonCode: decision.reasonCode,
          message,
          recovery: decision.redispatched
            ? `${labelProvider(decision.toProvider)}로 자동 재실행합니다.`
            : "쿨다운 후 자동 재시도합니다.",
        },
      });
    }
  }

  function recordRedispatchActivity(payload: ProviderRedispatchEventPayload): void {
    recordActivity({
      projectId: payload.projectId,
      agentId: payload.agentId,
      type: "provider_redispatch_result",
      message: payload.userMessage,
      metadata: { event: "provider:redispatched", ...payload },
    });
    broadcast("provider:redispatched", payload);
  }

  /** Prevent duplicate mission → goals generation in full autopilot. */
  const fullAutopilotLock = new Set<string>();

  // projectId → the single goal currently occupying the spec/decompose
  // lookahead slot. Reserving this synchronously before the async pipeline
  // starts makes nested polls, notify callbacks, and completion callbacks
  // contend on one project-level flight.
  const goalPreparationFlights = new Map<string, string>();
  const decomposRetryCount = new Map<string, number>();

  // Blueprint version ids whose autopilot auto-approval failed validation
  // (invalid_spec). The selector skips a goal whose LATEST version is here so an
  // un-approvable blueprint (e.g. AI produced an incomplete one) stops being
  // re-picked every poll (busy-loop) and no longer blocks other goals. Keyed by
  // version id, not goal id, so an edited/regenerated blueprint (new version id)
  // is retried automatically. Bounded by the number of failed versions.
  const autoApproveFailedVersions = new Set<string>();

  // 사용자가 명시적으로 정지한 큐 (stopQueue API). 자동 완료 정지(stopQueueInternal)와
  // 구분한다 — in-flight decompose 완료(processNextGoal 꼬리)가 정지된 큐를 침묵
  // 재시작하던 버그의 가드. startQueue/resumeQueue(사용자 재개)가 해제한다.
  const userStoppedQueues = new Set(
    (db.prepare("SELECT id FROM projects WHERE queue_stopped = 1").all() as { id: string }[])
      .map((project) => project.id),
  );

  // projectId → set of currently busy agent IDs
  const busyAgents = new Map<string, Set<string>>();
  // taskId → scheduler-owned execution lane. Keeping task ownership separate
  // lets goal cancellation release a lane without waiting for a stuck send()
  // Promise, while preventing that old Promise's finally from releasing a
  // newer task that reused the same agent.
  const activeExecutionOwners = new Map<string, { projectId: string; agentId: string }>();
  // Dedup repeated log warnings (e.g., "permanently blocked" on every poll)
  const loggedProgressWarnings = new Set<string>();

  // projectId → rate limit state
  const pauseState = new Map<string, {
    paused: boolean;
    consecutiveRateLimits: number;
    resumeTimer: ReturnType<typeof setTimeout> | null;
    nextRetryAt: Date | null;
  }>();

  // Deduplicate noisy "Deferring reviewer task" logs — log once per task, then only when remaining count changes
  const lastDeferLog = new Map<string, number>();
  function logDeferOnce(taskId: string, title: string, remaining: number): void {
    if (lastDeferLog.get(taskId) === remaining) return;
    lastDeferLog.set(taskId, remaining);
    log.info(`Deferring reviewer task "${title}" — ${remaining} sibling tasks still incomplete`);
  }

  /**
   * Per-project stuck-state detection. When pickNextTasks returns nothing
   * repeatedly but there IS outstanding work, the scheduler is silently
   * idle — the user sees "Auto 실행 중" with no activity and no idea why.
   * Track consecutive empty polls and surface a diagnosis when it crosses
   * a threshold, with dedup so we don't spam activities.
   */
  const stuckState = new Map<string, {
    emptyPollCount: number;
    lastWarnedAt: number;
    lastDiagnosisKey: string;
  }>();
  const STUCK_POLL_THRESHOLD = 30; // ~30s of empty polls before warning
  const STUCK_REWARN_MS = 5 * 60 * 1000; // re-warn every 5 min

  /**
   * Explain WHY pickNextTasks is returning nothing even though work exists.
   * Returns a short Korean summary suitable for the activity feed.
   */
  function diagnoseStuck(projectId: string): { summary: string; code: string } | null {
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) AS in_review,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN status = 'blocked' AND retry_count >= ? AND reassign_count >= ? THEN 1 ELSE 0 END) AS permanent_blocked,
        SUM(CASE WHEN status = 'todo' AND assignee_id IS NULL THEN 1 ELSE 0 END) AS unassigned_todo
      FROM tasks WHERE project_id = ?
    `).get(MAX_TASK_RETRIES, MAX_REASSIGNS, projectId) as any;

    if (!counts || (counts.todo === 0 && counts.blocked === 0)) {
      return null; // genuinely nothing to do
    }

    if (counts.unassigned_todo > 0) {
      const agentCount = (db.prepare("SELECT COUNT(*) as n FROM agents WHERE project_id = ?").get(projectId) as { n: number }).n;
      if (agentCount === 0) {
        return {
          code: "no_agents",
          summary: `할당 가능한 에이전트가 없습니다 — 에이전트를 추가해주세요 (미할당 태스크 ${counts.unassigned_todo}개)`,
        };
      }
    }

    // Check if all remaining todo tasks are reviewer-gated
    const reviewerGated = db.prepare(`
      SELECT COUNT(*) AS cnt FROM tasks t
      WHERE t.project_id = ? AND t.status = 'todo'
        AND t.assignee_id IN (SELECT id FROM agents WHERE project_id = ? AND role IN ('qa-reviewer','reviewer','qa'))
        AND EXISTS (
          SELECT 1 FROM tasks s
          WHERE s.goal_id = t.goal_id AND s.id != t.id AND s.status NOT IN ('done', 'skipped')
            AND NOT (s.status = 'blocked' AND s.retry_count >= ? AND s.reassign_count >= ?)
            AND s.assignee_id NOT IN (SELECT id FROM agents WHERE project_id = ? AND role IN ('qa-reviewer','reviewer','qa'))
        )
    `).get(projectId, projectId, MAX_TASK_RETRIES, MAX_REASSIGNS, projectId) as { cnt: number };

    const allTodo = (counts.todo ?? 0) as number;
    if (reviewerGated.cnt > 0 && reviewerGated.cnt === allTodo) {
      return {
        code: "reviewer_gate_lock",
        summary: `모든 남은 태스크가 리뷰어 대기 중 — 형제 태스크를 먼저 완료해야 합니다 (${reviewerGated.cnt}개 gated)`,
      };
    }

    if (counts.permanent_blocked > 0) {
      return {
        code: "permanent_blocked",
        summary: `재시도 불가능한 차단된 태스크 ${counts.permanent_blocked}개 — 수동 개입 필요`,
      };
    }

    if (counts.blocked > 0 && counts.todo === 0 && counts.in_progress === 0) {
      return {
        code: "all_blocked",
        summary: `모든 활성 태스크가 차단됨 (blocked ${counts.blocked}개) — 원인 확인 필요`,
      };
    }

    // PTY 프로젝트에서 태스크를 잇는 주체는 이 큐가 아니라 terminal auto-advance 다.
    // 그걸 모른 채 "큐 상태 확인 필요"라고 하면 멀쩡한 큐를 의심하게 만든다 — 실제 원인은
    // 터미널 쪽인데 사용자를 반대 방향으로 보낸다(2026-07-22 실측: tmux 소실로 1시간
    // 정지했는데 경고는 내내 큐를 가리켰다).
    const executionMode = (db.prepare(
      "SELECT execution_mode FROM projects WHERE id = ?",
    ).get(projectId) as { execution_mode: string } | undefined)?.execution_mode;
    if (executionMode === "pty") {
      const liveTerminals = (db.prepare(
        "SELECT COUNT(*) AS n FROM terminal_sessions WHERE project_id = ? AND status = 'active'",
      ).get(projectId) as { n: number }).n;
      return {
        code: "pty_idle",
        summary: liveTerminals === 0
          ? `태스크 ${allTodo}개 대기 — 실행 중인 터미널이 없습니다. 터미널 화면을 확인해주세요`
          : `태스크 ${allTodo}개 대기 — 터미널 실행 모드입니다. 큐가 아니라 터미널 상태를 확인해주세요 (활성 터미널 ${liveTerminals}개)`,
      };
    }

    return {
      code: "unknown_idle",
      summary: `태스크 ${allTodo}개가 대기 중이지만 실행되지 않음 — 큐 상태 확인 필요`,
    };
  }

  function checkStuckState(projectId: string, pickedCount: number): void {
    if (pickedCount > 0) {
      stuckState.delete(projectId);
      return;
    }
    const state = stuckState.get(projectId) ?? { emptyPollCount: 0, lastWarnedAt: 0, lastDiagnosisKey: "" };
    state.emptyPollCount++;

    if (state.emptyPollCount < STUCK_POLL_THRESHOLD) {
      stuckState.set(projectId, state);
      return;
    }

    const diagnosis = diagnoseStuck(projectId);
    if (!diagnosis) {
      stuckState.set(projectId, state);
      return;
    }

    const now = Date.now();
    const diagnosisChanged = state.lastDiagnosisKey !== diagnosis.code;
    if (diagnosisChanged || now - state.lastWarnedAt > STUCK_REWARN_MS) {
      log.warn(`[stuck] project ${projectId}: ${diagnosis.summary} (${state.emptyPollCount} empty polls)`);
      try {
        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)",
        ).run(projectId, `🟡 자동 실행 정체: ${diagnosis.summary}`);
      } catch { /* best-effort */ }
      broadcast("autopilot:stuck", {
        projectId,
        code: diagnosis.code,
        summary: diagnosis.summary,
        emptyPollCount: state.emptyPollCount,
      });
      broadcast("project:updated", { projectId });
      state.lastWarnedAt = now;
      state.lastDiagnosisKey = diagnosis.code;
    }
    stuckState.set(projectId, state);
  }

  function getBusyAgents(projectId: string): Set<string> {
    if (!busyAgents.has(projectId)) busyAgents.set(projectId, new Set());
    return busyAgents.get(projectId)!;
  }

  function acquireExecutionOwnership(projectId: string, taskId: string, agentId: string): void {
    activeExecutionOwners.set(taskId, { projectId, agentId });
    getBusyAgents(projectId).add(agentId);
  }

  function releaseExecutionOwnership(taskId: string): void {
    const owner = activeExecutionOwners.get(taskId);
    if (!owner) return;
    activeExecutionOwners.delete(taskId);
    const agentStillOwned = [...activeExecutionOwners.values()].some(
      (candidate) => candidate.projectId === owner.projectId && candidate.agentId === owner.agentId,
    );
    if (!agentStillOwned) getBusyAgents(owner.projectId).delete(owner.agentId);
  }

  function getPauseState(projectId: string) {
    if (!pauseState.has(projectId)) {
      pauseState.set(projectId, {
        paused: false,
        consecutiveRateLimits: 0,
        resumeTimer: null,
        nextRetryAt: null,
      });
    }
    return pauseState.get(projectId)!;
  }

  function enforceDailyBudget(projectId: string): boolean {
    const budget = loadProviderConfig().budget;
    if (!budget || (budget.tokenLimit === null && budget.timeLimitMs === null)) return false;

    // crewdeck-status의 todayTokens와 같은 UTC 일일 창을 사용한다.
    const today = new Date().toISOString().slice(0, 10);
    const usage = db.prepare(`
      SELECT
        COALESCE(SUM(token_usage), 0) AS tokenUsage,
        COALESCE(SUM(
          CASE
            WHEN julianday(COALESCE(ended_at, datetime('now'))) > julianday(started_at)
              THEN (julianday(COALESCE(ended_at, datetime('now'))) - julianday(started_at)) * 86400000
            ELSE 0
          END
        ), 0) AS timeUsageMs
      FROM sessions
      WHERE started_at >= ?
    `).get(today) as { tokenUsage: number; timeUsageMs: number };
    const tokenUsage = Math.max(0, usage.tokenUsage);
    const timeUsageMs = Math.max(0, Math.round(usage.timeUsageMs));
    const tokenExceeded = budget.tokenLimit !== null && tokenUsage >= budget.tokenLimit;
    const timeExceeded = budget.timeLimitMs !== null && timeUsageMs >= budget.timeLimitMs;

    if (!tokenExceeded && !timeExceeded) {
      const tokenWarned = budget.tokenLimit !== null
        && tokenUsage >= budget.tokenLimit * budget.warnPct;
      const timeWarned = budget.timeLimitMs !== null
        && timeUsageMs >= budget.timeLimitMs * budget.warnPct;
      if (!tokenWarned && !timeWarned) return false;

      const alreadyWarned = db.prepare(`
        SELECT 1 FROM activities
        WHERE project_id = ?
          AND type = 'autopilot_warning'
          AND created_at >= ?
          AND metadata LIKE '%"event":"budget:warning"%'
        LIMIT 1
      `).get(projectId, today);
      if (!alreadyWarned) {
        const reached = [tokenWarned ? "토큰" : null, timeWarned ? "활동 시간" : null]
          .filter(Boolean)
          .join("·");
        recordActivity({
          projectId,
          type: "autopilot_warning",
          message: `일일 예산 경고: ${reached} 사용량이 설정 한도의 ${Math.round(budget.warnPct * 100)}%에 도달했습니다.`,
          metadata: {
            event: "budget:warning",
            scope: "global_daily",
            date: today,
            tokenUsage,
            timeUsageMs,
            tokenLimit: budget.tokenLimit,
            timeLimitMs: budget.timeLimitMs,
            warnPct: budget.warnPct,
          },
        });
      }
      return false;
    }

    const state = getPauseState(projectId);
    state.paused = true;
    const nextResetAt = new Date(`${today}T00:00:00.000Z`);
    nextResetAt.setUTCDate(nextResetAt.getUTCDate() + 1);
    state.nextRetryAt = nextResetAt;
    const exceeded = [tokenExceeded ? "토큰" : null, timeExceeded ? "활동 시간" : null]
      .filter(Boolean)
      .join("·");
    const message = `전역 일일 ${exceeded} 예산 한도에 도달해 자동 실행을 일시정지했습니다.`;

    recordActivity({
      projectId,
      type: "autopilot_warning",
      message,
      metadata: {
        event: "budget:paused",
        scope: "global_daily",
        date: today,
        tokenUsage,
        timeUsageMs,
        tokenLimit: budget.tokenLimit,
        timeLimitMs: budget.timeLimitMs,
      },
    });
    broadcast("queue:paused", {
      projectId,
      reason: "budget_limit",
      nextRetryAt: nextResetAt.toISOString(),
      message,
    });

    if (state.resumeTimer) clearTimeout(state.resumeTimer);
    state.resumeTimer = setTimeout(() => {
      state.paused = false;
      state.nextRetryAt = null;
      state.resumeTimer = null;
      log.info(`Queue resumed after daily budget reset for project ${projectId}`);
      broadcast("queue:resumed", { projectId });
      if (timers.has(projectId)) poll(projectId);
    }, Math.max(1, nextResetAt.getTime() - Date.now()));

    log.warn(`${message} project=${projectId}, tokens=${tokenUsage}, timeMs=${timeUsageMs}`);
    return true;
  }

  /**
   * Fix dangling assignee_ids — tasks assigned to agents that no longer exist.
   * Clears assignee so autoAssignUnassigned can reassign them.
   */
  function fixDanglingAssignees(projectId: string): void {
    const fixed = db.prepare(`
      UPDATE tasks SET assignee_id = NULL
      WHERE project_id = ? AND assignee_id IS NOT NULL
        AND status NOT IN ('done', 'skipped')
        AND assignee_id NOT IN (SELECT id FROM agents WHERE project_id = ?)
    `).run(projectId, projectId);

    if (fixed.changes > 0) {
      log.warn(`Fixed ${fixed.changes} tasks with dangling assignee in project ${projectId}`);
    }
  }

  /**
   * Auto-retry blocked tasks with escalation strategy:
   * 1. retry_count < MAX → same agent retry (after cooldown)
   * 2. retry_count >= MAX → reassign to a DIFFERENT agent, reset retry_count
   * 3. Already reassigned + retry exhausted again → give up (permanent blocked)
   *
   * Permanent blocked tasks are excluded from goal progress calculation
   * so the goal can still complete with the remaining tasks.
   */
  function retryBlockedTasks(projectId: string): void {
    const baseCooldownSeconds = Math.round(BLOCKED_RETRY_DELAY_MS / 1000);

    // Step 0: Circuit breaker — detect repeated identical verification failures.
    // If a task has 2+ consecutive 'fail' verdicts with the same top issue,
    // exhaust its retry/reassign budget immediately. Retrying the same prompt
    // against the same code will produce the same failure — burning tokens.
    const blockedWithRetries = db.prepare(`
      SELECT id, title FROM tasks
      WHERE project_id = ? AND status = 'blocked'
        AND recovery_manual_action_required = 0
        AND NOT (retry_count >= ? AND reassign_count >= ?)
    `).all(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { id: string; title: string }[];

    for (const task of blockedWithRetries) {
      const recentFails = db.prepare(`
        SELECT issues FROM verifications
        WHERE task_id = ? AND verdict = 'fail'
        ORDER BY created_at DESC LIMIT 2
      `).all(task.id) as { issues: string }[];

      if (recentFails.length < 2) continue;

      // Compare top issue signatures across the two most recent failures
      try {
        const sig = (issuesJson: string): string => {
          const issues = JSON.parse(issuesJson);
          if (!Array.isArray(issues) || issues.length === 0) return "";
          // Signature: severity + first 120 chars of message (normalize line numbers only)
          // Targeted normalization: file.ts:42 → file.ts:N, line 42 → line N
          // Preserves identifiers like variable1, foo2 to avoid false positives
          return issues.slice(0, 3).map((i: any) =>
            `${i.severity ?? ""}:${(i.message ?? "").replace(/:\d+/g, ":N").replace(/line \d+/gi, "line N").slice(0, 120)}`
          ).join("|");
        };
        const sig0 = sig(recentFails[0].issues);
        const sig1 = sig(recentFails[1].issues);
        if (sig0 && sig0 === sig1) {
          db.prepare(
            "UPDATE tasks SET retry_count = ?, reassign_count = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(MAX_TASK_RETRIES, MAX_REASSIGNS, task.id);
          log.warn(`Circuit breaker: task "${task.title}" has identical failures — permanently blocked`);
          db.prepare(
            "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_skipped', ?)"
          ).run(projectId, `반복 동일 실패 감지 — 자동 중단: ${task.title}`);
          broadcast("project:updated", { projectId });
        }
      } catch { /* ignore JSON parse errors — proceed with normal retry */ }
    }

    // Step 1: Retry tasks that still have attempts left (same agent)
    // Exponential backoff: cooldown doubles with each retry (10s → 20s → 40s → ...)
    // Query each retry level separately to apply per-level cooldown.
    let totalRetried = 0;
    for (let level = 0; level < MAX_TASK_RETRIES; level++) {
      const levelCooldown = baseCooldownSeconds * Math.pow(2, level);
      const retried = db.prepare(`
        UPDATE tasks SET status = 'todo', retry_count = retry_count + 1, updated_at = datetime('now')
        WHERE project_id = ? AND status = 'blocked' AND retry_count = ?
          AND recovery_manual_action_required = 0
          AND updated_at <= datetime('now', '-${levelCooldown} seconds')
        RETURNING id, title, assignee_id, execution_run_id, retry_count, reassign_count
      `).all(projectId, level) as Array<{
        id: string;
        title: string;
        assignee_id: string | null;
        execution_run_id: string | null;
        retry_count: number;
        reassign_count: number;
      }>;
      for (const task of retried) {
        recordActivity({
          projectId,
          agentId: task.assignee_id,
          type: "task_retry",
          message: `Retrying "${task.title}" with the same agent (attempt ${task.retry_count})`,
          metadata: {
            taskId: task.id,
            executionRunId: task.execution_run_id,
            retryCount: task.retry_count,
            reassignCount: task.reassign_count,
          },
        });
      }
      totalRetried += retried.length;
    }

    if (totalRetried > 0) {
      log.info(`Auto-retried ${totalRetried} blocked tasks (same agent, exponential backoff)`);
      broadcast("project:updated", { projectId });
    }

    // Step 2: Escalate — reassign retry-exhausted tasks to a different agent
    // Only if reassign_count < MAX_REASSIGNS (prevents infinite agent-switching loop)
    // Use escalated cooldown for reassignment (base × 2^MAX_TASK_RETRIES)
    const reassignCooldown = baseCooldownSeconds * Math.pow(2, MAX_TASK_RETRIES);
    const exhausted = db.prepare(`
      SELECT t.id, t.assignee_id, t.title, t.reassign_count FROM tasks t
      WHERE t.project_id = ? AND t.status = 'blocked' AND t.retry_count >= ? AND t.reassign_count < ?
        AND t.recovery_manual_action_required = 0
        AND t.updated_at <= datetime('now', '-${reassignCooldown} seconds')
    `).all(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { id: string; assignee_id: string | null; title: string; reassign_count: number }[];

    if (exhausted.length === 0) return;

    // Get all available agents for reassignment
    const agents = db.prepare(
      "SELECT id, role FROM agents WHERE project_id = ?",
    ).all(projectId) as { id: string; role: string }[];

    if (agents.length <= 1) {
      // Only one agent — can't reassign, exhaust reassign budget to prevent repeat queries
      for (const t of exhausted) {
        db.prepare(
          "UPDATE tasks SET reassign_count = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(MAX_REASSIGNS, t.id);
        log.warn(`Task "${t.title}" permanently blocked — no alternative agent available`);
        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_skipped', ?)",
        ).run(projectId, `Permanently blocked (no alt agent): ${t.title}`);
      }
      // Update goal progress to exclude permanently blocked tasks
      updateGoalProgressExcludingBlocked(projectId);
      return;
    }

    let reassigned = 0;
    for (const t of exhausted) {
      // Find a different agent than the current assignee
      const altAgent = agents.find((a) => a.id !== t.assignee_id)
        ?? agents.find((a) => a.role !== "cto" && a.role !== "reviewer")
        ?? agents[0];

      if (!altAgent || altAgent.id === t.assignee_id) {
        // No alternative — mark as permanently blocked so this task exits the
        // exhausted query and doesn't loop every poll cycle.
        log.warn(`Task "${t.title}" permanently blocked — no different agent`);
        db.prepare(
          "UPDATE tasks SET reassign_count = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(MAX_REASSIGNS, t.id);
        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_skipped', ?)",
        ).run(projectId, `Permanently blocked: ${t.title}`);
        continue;
      }

      // Reassign + reset retry_count for fresh attempts with new agent
      const updated = db.prepare(`
        UPDATE tasks SET status = 'todo', assignee_id = ?, retry_count = 0,
          reassign_count = reassign_count + 1, updated_at = datetime('now')
        WHERE id = ? AND status = 'blocked'
        RETURNING execution_run_id, reassign_count
      `).get(altAgent.id, t.id) as { execution_run_id: string | null; reassign_count: number } | undefined;
      if (!updated) continue;

      recordActivity({
        projectId,
        agentId: altAgent.id,
        type: "task_reassigned",
        message: `Escalated "${t.title}" to different agent (retry exhausted)`,
        metadata: {
          taskId: t.id,
          executionRunId: updated.execution_run_id,
          previousAgentId: t.assignee_id,
          assigneeId: altAgent.id,
          reassignCount: updated.reassign_count,
        },
      });
      reassigned++;
    }

    if (reassigned > 0) {
      log.info(`Escalated ${reassigned} blocked tasks to different agents`);
      broadcast("project:updated", { projectId });
    }

    // Update goal progress for any permanently stuck tasks
    updateGoalProgressExcludingBlocked(projectId);
  }

  /**
   * Auto-resolve permanently blocked tasks — no user intervention required.
   *
   * When both retry and reassign budgets are exhausted, the task is unsolvable
   * by the current agent pool. Leaving it as 'blocked' forever stalls the UI
   * and confuses non-technical users. Instead:
   *   1. Mark it as 'skipped' (terminal, NOT 'done' — 완료로 위장하지 않는다)
   *      with skip_reason='retry_exhausted'. result_summary는 건드리지 않는다.
   *   2. Log a clear activity entry so the user can review later
   *   3. Update goal progress so the next goal can start
   *   4. Goal-as-Unit goal이면 squash 트리거를 재확인 (skipped가 마지막 미완이면
   *      사람 승인 게이트로 진행 — degraded는 다이얼로그의 스킵 섹션으로 노출)
   *
   * This runs on every scheduler poll — idempotent (only targets blocked tasks
   * that haven't been resolved yet).
   */
  function autoResolvePermanentlyBlocked(projectId: string): void {
    const stuck = db.prepare(`
      SELECT t.id, t.title, t.goal_id FROM tasks t
      WHERE t.project_id = ? AND t.status = 'blocked'
        AND t.recovery_manual_action_required = 0
        AND t.retry_count >= ? AND t.reassign_count >= ?
    `).all(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { id: string; title: string; goal_id: string }[];

    if (stuck.length === 0) return;

    for (const t of stuck) {
      db.prepare(
        "UPDATE tasks SET status = 'skipped', skip_reason = 'retry_exhausted', updated_at = datetime('now') WHERE id = ?",
      ).run(t.id);

      // 메시지는 사람용 요약, 구조 필드(metadata)가 기계 판독 정본 — 프론트 번역용 key:data.
      db.prepare(
        "INSERT INTO activities (project_id, type, message, metadata) VALUES (?, 'task_auto_resolved', ?, ?)",
      ).run(
        projectId,
        `자동 건너뜀: "${t.title}" — 재시도 ${MAX_TASK_RETRIES}회 + 재할당 ${MAX_REASSIGNS}회 소진`,
        JSON.stringify({
          taskId: t.id,
          goalId: t.goal_id,
          skipReason: "retry_exhausted",
          retryCount: MAX_TASK_RETRIES,
          reassignCount: MAX_REASSIGNS,
        }),
      );

      log.info(`Auto-resolved permanently blocked task "${t.title}" (${t.id}) → skipped (retry_exhausted)`);
    }

    // Recalculate goal progress now that blocked → skipped.
    // progress는 terminal-inclusive(done|skipped 포함) — skipped가 남아도 100%에
    // 도달할 수 있어야 full autopilot의 progress<100 활성 카운트가 슬롯을 영구
    // 점유하지 않는다. degraded 여부는 skipped COUNT>0 파생값으로 별도 표기.
    const goalIds = [...new Set(stuck.map((t) => t.goal_id))];
    for (const goalId of goalIds) {
      const stats = db.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN status IN ('done', 'skipped') THEN 1 ELSE 0 END) as done
        FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
      `).get(goalId) as { total: number; done: number };
      const progress = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 100;
      db.prepare("UPDATE goals SET progress = ? WHERE id = ?").run(progress, goalId);

      // Goal-as-Unit: skipped 전이가 goal의 마지막 미완 태스크였다면 squash 게이트로
      // 진행시킨다 (CAS 멱등 — 미완이 남았거나 non-goal-as-unit이면 내부에서 no-op).
      const goalRow = db.prepare(
        "SELECT worktree_path FROM goals WHERE id = ? AND goal_model = 'goal_as_unit' AND worktree_path IS NOT NULL",
      ).get(goalId) as { worktree_path: string } | undefined;
      if (goalRow) {
        void checkAndTriggerGoalSquash(db, broadcast, sessionManager, goalId, goalRow.worktree_path)
          .catch((err) => log.error(`Squash check after auto-skip failed for goal ${goalId}`, err));
      }
    }

    broadcast("project:updated", { projectId });
    log.info(`Auto-resolved ${stuck.length} permanently blocked task(s) in project ${projectId}`);
  }

  /**
   * Update goal progress for goals that have permanently blocked tasks.
   * Permanently blocked = blocked + retry exhausted + reassign exhausted.
   * These tasks are excluded from the denominator so the goal can still complete.
   */
  function updateGoalProgressExcludingBlocked(projectId: string): void {
    const goals = db.prepare(
      "SELECT DISTINCT goal_id FROM tasks WHERE project_id = ? AND status = 'blocked' AND recovery_manual_action_required = 0 AND retry_count >= ? AND reassign_count >= ?",
    ).all(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { goal_id: string }[];

    for (const { goal_id } of goals) {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status IN ('done', 'skipped') THEN 1 ELSE 0 END) as done,
          SUM(CASE WHEN status = 'blocked' AND recovery_manual_action_required = 0 AND retry_count >= ? AND reassign_count >= ? THEN 1 ELSE 0 END) as permanently_blocked
        FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
      `).get(MAX_TASK_RETRIES, MAX_REASSIGNS, goal_id) as { total: number; done: number; permanently_blocked: number };

      const effective = stats.total - stats.permanently_blocked;
      const progress = effective > 0 ? Math.round((stats.done / effective) * 100) : (stats.total === stats.permanently_blocked ? 100 : 0);
      db.prepare("UPDATE goals SET progress = ? WHERE id = ?").run(progress, goal_id);
      broadcast("project:updated", { projectId });

      if (stats.permanently_blocked > 0) {
        // Log once per goal — suppress repeated warnings for unchanged state
        const warnKey = `blocked:${goal_id}:${stats.permanently_blocked}`;
        if (!loggedProgressWarnings.has(warnKey)) {
          loggedProgressWarnings.add(warnKey);
          log.warn(`Goal ${goal_id}: ${stats.permanently_blocked} tasks permanently blocked, progress based on ${effective} remaining tasks`);
        }
      }
    }
  }

  /**
   * Auto-assign unassigned todo tasks to available agents.
   * Prefers worker agents, falls back to CTO/reviewer if no workers exist.
   */
  function autoAssignUnassigned(projectId: string): void {
    // First fix any dangling assignees from deleted agents
    fixDanglingAssignees(projectId);

    // Only auto-assign todo tasks (blocked tasks need human review)
    const unassigned = db.prepare(
      "SELECT id, title FROM tasks WHERE project_id = ? AND status = 'todo' AND assignee_id IS NULL",
    ).all(projectId) as { id: string; title: string }[];

    if (unassigned.length === 0) return;

    // Prefer worker agents, fall back to any agent if no workers
    let agents = db.prepare(
      "SELECT id, role FROM agents WHERE project_id = ? AND role NOT IN ('cto', 'reviewer')",
    ).all(projectId) as { id: string; role: string }[];

    if (agents.length === 0) {
      // Fallback: use any agent including CTO/reviewer — better than no execution
      agents = db.prepare(
        "SELECT id, role FROM agents WHERE project_id = ?",
      ).all(projectId) as { id: string; role: string }[];
    }

    if (agents.length === 0) {
      // Rate-limit warning to avoid spam: only log once per polling cycle
      log.warn(`Cannot auto-assign ${unassigned.length} task(s) in project ${projectId} — no agents available`);
      // Record activity so the user sees it in the UI (deduped by recent message)
      const lastWarn = db.prepare(
        "SELECT id FROM activities WHERE project_id = ? AND type = 'autopilot_warning' AND created_at > datetime('now', '-5 minutes') LIMIT 1"
      ).get(projectId) as { id: number } | undefined;
      if (!lastWarn) {
        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)"
        ).run(projectId, `작업 ${unassigned.length}개를 자동 할당할 수 없습니다 — 에이전트가 없습니다. 에이전트를 추가해주세요.`);
        broadcast("project:updated", { projectId });
      }
      return;
    }

    // Role-aware round-robin: try to match task's original role hint first,
    // then fall back to round-robin across all available agents.
    const roleCount = new Map<string, number>();
    for (const task of unassigned) {
      // Try to recover a role hint from the task's previous assignee or description
      const taskDetail = db.prepare("SELECT description, title FROM tasks WHERE id = ?").get(task.id) as { description: string; title: string } | undefined;
      const titleLower = (taskDetail?.title ?? "").toLowerCase();

      // Heuristic: match role keywords in task title
      const roleHint = agents.find((a) => titleLower.includes(a.role))?.role;
      const roleAgents = roleHint
        ? agents.filter((a) => a.role === roleHint)
        : [];

      let agent;
      if (roleAgents.length > 0) {
        const count = roleCount.get(roleHint!) ?? 0;
        roleCount.set(roleHint!, count + 1);
        agent = roleAgents[count % roleAgents.length];
      } else {
        // Fallback: global round-robin
        const count = roleCount.get("__global__") ?? 0;
        roleCount.set("__global__", count + 1);
        agent = agents[count % agents.length];
      }

      db.prepare("UPDATE tasks SET assignee_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(agent.id, task.id);
    }

    log.info(`Auto-assigned ${unassigned.length} unassigned tasks in project ${projectId}`);
    broadcast("project:updated", { projectId });
  }

  /**
   * Pick next executable tasks: goals run in parallel, each goal has one lane.
   * Active/settling goals are excluded and every selected goal contributes at
   * most one task, ordered by goal priority.
   */
  function pickNextTasks(
    projectId: string,
    maxContinuationSlots: number,
    maxNewGoalSlots: number,
  ): any[] {
    // Auto-retry blocked tasks that haven't exceeded retry limit
    retryBlockedTasks(projectId);

    // Auto-resolve permanently blocked tasks (retry+reassign exhausted) → done(skipped)
    // Must run AFTER retryBlockedTasks so we don't skip tasks that could still be retried
    autoResolvePermanentlyBlocked(projectId);

    // Recompute goal progress accounting for permanently-blocked tasks.
    // Previously this only fired from inside retryBlockedTasks when there were
    // retry-exhausted-but-reassignable tasks — so a goal that reached fully
    // permanent-blocked state never got its progress corrected and appeared
    // stuck at 67% forever. Idempotent + cheap; safe to run every poll.
    updateGoalProgressExcludingBlocked(projectId);

    // Then auto-assign any unassigned tasks
    autoAssignUnassigned(projectId);

    const busy = getBusyAgents(projectId);

    // Safety net: clean up "ghost" in_progress tasks whose runtime context was
    // lost (e.g., server killed without graceful shutdown, executeOne crashed
    // before transitioning the task). In sequential goal mode such a ghost
    // would pin a goal as active forever and block all other goals.
    //
    // Heuristic: an in_progress / in_review task is a ghost if its assignee is
    // NOT in the in-memory busyAgents set AND it has not been updated within
    // a generous window (3x task timeout). The window guard prevents racing
    // with a task that was just transitioned but hasn't been added to busy yet.
    const STALE_THRESHOLD_SECONDS = Math.ceil((TASK_TIMEOUT_MS * 3) / 1000);
    // 위임 대기 부모(미종결 하위 작업 보유)는 ghost가 아니다 — 설계상 라이브 세션
    // 없이 하위 작업 완료를 기다리는 상태라 updated_at이 오래돼도 정상. 이를 todo로
    // 리셋하면 부모가 재픽·중복 위임될 수 있고, "할 일"로 보여 사용자를 혼란시킨다.
    const staleCandidates = db.prepare(`
      SELECT id, title, assignee_id, status, retry_count, reassign_count FROM tasks t
      WHERE project_id = ?
        AND status IN ('in_progress', 'in_review')
        AND (strftime('%s', 'now') - strftime('%s', updated_at)) > ?
        AND NOT EXISTS (
          SELECT 1 FROM tasks s
          WHERE s.parent_task_id = t.id
            AND s.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
        )
    `).all(projectId, STALE_THRESHOLD_SECONDS) as { id: string; title: string; assignee_id: string | null; status: string; retry_count: number; reassign_count: number }[];
    const activeSessionAgents = getActiveSessionAgentIds(db, projectId, sessionManager);
    const activeSessionTasks = getActiveSessionTaskIds(db, projectId, sessionManager);
    for (const ghost of staleCandidates) {
      if (activeSessionTasks.has(ghost.id)
        || (ghost.assignee_id
          && (busy.has(ghost.assignee_id) || activeSessionAgents.has(ghost.assignee_id)))) {
        continue; // really running (scheduler or manual execution)
      }

      // Respect retry/reassign limits — don't revive permanently exhausted tasks
      if (ghost.retry_count >= MAX_TASK_RETRIES && ghost.reassign_count >= MAX_REASSIGNS) {
        db.prepare("UPDATE tasks SET status = 'blocked', updated_at = datetime('now') WHERE id = ?").run(ghost.id);
        log.warn(`Stale ${ghost.status} task ${ghost.id} → blocked (retry/reassign exhausted, not revivable)`);
        recordActivity({
          projectId,
          agentId: ghost.assignee_id,
          type: "task_skipped",
          message: ghost.status === "in_review"
            ? `검증 지연 감지: "${ghost.title.slice(0, 80)}" 자동 복구 불가 — 재시도 한도 초과`
            : `중단된 작업 영구 차단됨 (재시도 한도 초과)`,
          metadata: {
            taskId: ghost.id,
            previousStatus: ghost.status,
            nextStatus: "blocked",
            reason: "stale_no_live_session",
            staleThresholdSeconds: STALE_THRESHOLD_SECONDS,
          },
        });
        broadcast("project:updated", { projectId });
        continue;
      }

      db.prepare("UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE id = ?").run(ghost.id);
      log.warn(`Stale ${ghost.status} task ${ghost.id} reset to todo (no live runtime, idle > ${STALE_THRESHOLD_SECONDS}s)`);
      recordActivity({
        projectId,
        agentId: ghost.assignee_id,
        type: "autopilot_warning",
        message: ghost.status === "in_review"
          ? `검증 지연 자동 복구: "${ghost.title.slice(0, 80)}" → todo (실행 세션 없음)`
          : `중단된 작업 자동 복구: 진행 상태 → todo`,
        metadata: {
          taskId: ghost.id,
          previousStatus: ghost.status,
          nextStatus: "todo",
          reason: "stale_no_live_session",
          staleThresholdSeconds: STALE_THRESHOLD_SECONDS,
        },
      });
      broadcast("project:updated", { projectId });
    }

    // Reviewer/QA tasks should wait until all other tasks in the same goal are done
    const reviewerAgentIds = new Set(
      (db.prepare(
        "SELECT id FROM agents WHERE project_id = ? AND role IN ('qa-reviewer', 'reviewer', 'qa')"
      ).all(projectId) as { id: string }[]).map((a) => a.id)
    );

    const picked: any[] = [];
    // busy(in-memory, 스케줄러가 스폰한 세션)만으로 seed 하면 수동 실행
    // (POST /tasks/:id/execute, DB claim 만 얻고 busyAgents 미등록)이 점유한
    // agent 를 놓쳐, 같은 agent 에 배정된 다른 goal 태스크를 뽑아 spawnAgent 가
    // 정상 세션을 cleanup(SIGTERM)한다. DB 상 live lane 을 가진 agent 를 합쳐
    // 실행 경로와 무관하게 agent 당 1 세션 불변식을 지킨다.
    const usedAgents = new Set([...busy, ...getActiveAgentIds(db, projectId, sessionManager)]);
    const occupiedGoalIds = getOccupiedGoalIds(projectId);
    const pickedGoalIds = new Set<string>();

    // Failover redispatch는 같은 태스크가 같은 agent에서 즉시 재실행되어야
    // original_session_id ↔ redispatched_session_id 연결이 정확하다. 일반 goal
    // 우선순위보다 먼저 집어, 같은 agent의 다른 태스크 세션이 사이에 끼는 것을 막는다.
    const pendingRedispatches = db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.project_id = ?
        AND t.status = 'todo'
        AND t.assignee_id IS NOT NULL
        AND t.provider_failover_redispatched = 1
        AND t.provider_failover_redispatched_session_id IS NULL
        AND t.provider_failover_to_provider IN ('claude', 'codex')
      ORDER BY t.updated_at DESC, t.created_at ASC
    `).all(projectId) as any[];
    const pendingRedispatchAgentIds = new Set(
      pendingRedispatches
        .map((task) => task.assignee_id)
        .filter((agentId: unknown): agentId is string => typeof agentId === "string"),
    );
    for (const task of pendingRedispatches) {
      if (picked.length >= maxContinuationSlots) break;
      if (usedAgents.has(task.assignee_id)) continue;
      if (occupiedGoalIds.has(task.goal_id) || pickedGoalIds.has(task.goal_id)) continue;
      picked.push(task);
      usedAgents.add(task.assignee_id);
      pickedGoalIds.add(task.goal_id);
    }

    // Ordinary retries/reassigns are continuations of the failed goal lane,
    // not fresh work. Pick the exact failed task before any later sibling or
    // reviewer. retryBlockedTasks above promotes only cooldown-eligible rows,
    // so a still-blocked task continues to reserve its slot without spawning.
    const pendingRetries = db.prepare(`
      SELECT t.* FROM tasks t
      JOIN goals g ON g.id = t.goal_id
      WHERE t.project_id = ?
        AND t.status = 'todo'
        AND t.assignee_id IS NOT NULL
        AND (t.retry_count > 0 OR t.reassign_count > 0)
        AND NOT (
          t.provider_failover_redispatched = 1
          AND t.provider_failover_redispatched_session_id IS NULL
        )
      ORDER BY ${GOAL_PRIORITY_ORDER}, t.updated_at ASC, t.created_at ASC
    `).all(projectId) as any[];
    for (const task of pendingRetries) {
      if (picked.length >= maxContinuationSlots) break;
      if (usedAgents.has(task.assignee_id)) continue;
      if (occupiedGoalIds.has(task.goal_id) || pickedGoalIds.has(task.goal_id)) continue;
      picked.push(task);
      usedAgents.add(task.assignee_id);
      pickedGoalIds.add(task.goal_id);
    }

    // Step 1: goal 간 병렬 — 이번 라운드에 태스크를 뽑을 goal 들을 고른다.
    // in-flight 태스크가 있는 goal 은 "goal 내부 순차 1" 원칙상 이미 슬롯을
    // 점유 중이라 제외되고, 남은 goal 중 ready 태스크가 있는 것을 우선순위
    // 순으로 순회한다. 상위 goal이 dependency/reviewer gate로 실행 불가능해도
    // 하위 goal로 슬롯을 채우기 위해 후보는 모두 읽고, 실제 선택만 maxSlots에서
    // 끊는다. goal 간에는 worktree 격리로 병렬이 안전하다.
    const activeGoalIds = pickParallelGoals(db, projectId, Number.MAX_SAFE_INTEGER)
      .filter((goalId) => !occupiedGoalIds.has(goalId))
      .filter((goalId) => !pickedGoalIds.has(goalId));
    if (activeGoalIds.length === 0 || maxNewGoalSlots <= 0) return picked;

    // Step 2: goal 마다 실행 가능한 첫 태스크 1개만 뽑는다 (goal 내부 순차 1)
    let pickedNewGoals = 0;
    for (const activeGoalId of activeGoalIds) {
      if (pickedNewGoals >= maxNewGoalSlots) break;

      // Sprint 5: status = 'todo' naturally excludes 'pending_approval' tasks.
      // pending_approval tasks must be explicitly approved (→ todo) via the
      // Approval Gate API before the scheduler picks them up.
      // 위임 부모 재픽 차단: 미종결 하위 작업이 있는 태스크는 (ghost 복구 등으로
      // todo로 되돌아갔더라도) 다시 뽑지 않는다 — 재실행하면 중복 위임/기존
      // 하위 작업과 충돌한다. 하위 작업이 모두 끝나면 checkParentCompletion이 처리.
      const candidates = db.prepare(`
        SELECT t.* FROM tasks t
        WHERE t.goal_id = ?
          AND t.status = 'todo'
          AND t.assignee_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM tasks s
            WHERE s.parent_task_id = t.id
              AND s.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
          )
        ORDER BY
          CASE WHEN t.parent_task_id IS NOT NULL THEN 0 ELSE 1 END,
          t.sort_order ASC,
          CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
          t.created_at ASC
        LIMIT 20
      `).all(activeGoalId) as any[];

      for (const task of candidates) {
        if (usedAgents.has(task.assignee_id)) continue; // agent already occupied
        if (pendingRedispatchAgentIds.has(task.assignee_id)) continue; // failover 재연결 전까지 같은 agent의 다른 세션 차단

        // Gate: reviewer tasks wait until all sibling tasks in the same goal are
        // done. Permanently-blocked siblings (retry + reassign both exhausted)
        // are treated as "done-for-gating-purposes" — otherwise the entire goal
        // halts forever on a single task the scheduler can no longer make
        // progress on, and the whole project sits idle waiting for a human.
        if (task.goal_id && reviewerAgentIds.has(task.assignee_id)) {
          // 데드락 방지: 이 reviewer 태스크에 의존하는 미완료 태스크가 있으면 gate를 건너뛴다.
          // 감사/분석 태스크가 DAG 루트인데 reviewer 역할에 배정되면, gate는 루트를 연기하고
          // siblings는 루트의 완료를 기다리는 순환 대기가 되어 큐가 영구 정지한다 (proof goal 2호 실측).
          const dependents = db.prepare(`
            SELECT COUNT(*) as cnt FROM tasks
            WHERE goal_id = ? AND id != ? AND status NOT IN ('done', 'skipped')
              AND depends_on LIKE '%' || ? || '%'
          `).get(task.goal_id, task.id, task.id) as { cnt: number };

          if (dependents.cnt === 0) {
            const siblings = db.prepare(`
              SELECT COUNT(*) as remaining FROM tasks
              WHERE goal_id = ? AND id != ?
                AND status NOT IN ('done', 'skipped')
                -- reviewer gate 는 같은 '레벨'만 센다: subtask 는 실제 형제 subtask(같은
                -- parent_task_id)만, root reviewer 는 root 태스크(parent 없음)만. goal-wide 로
                -- 세면 reviewer subtask 가 자기 부모(하위 작업이 도는 동안 항상 in_progress)를
                -- 미완료 형제로 오인해 부모↔subtask 순환 대기 deadlock 이 생긴다(2026-07-14 실측).
                -- 부모는 자식보다 먼저 done 될 수 없으므로, root 레벨만 세도 subtask 완료를
                -- transitively 포함해 root reviewer 동작은 등가다.
                AND (
                  (? IS NULL AND parent_task_id IS NULL)
                  OR parent_task_id = ?
                )
                AND NOT (
                  status = 'blocked'
                  AND recovery_manual_action_required = 0
                  AND retry_count >= ?
                  AND reassign_count >= ?
                )
                AND assignee_id NOT IN (SELECT id FROM agents WHERE project_id = ? AND role IN ('qa-reviewer', 'reviewer', 'qa'))
            `).get(task.goal_id, task.id, task.parent_task_id, task.parent_task_id, MAX_TASK_RETRIES, MAX_REASSIGNS, projectId) as { remaining: number };

            if (siblings.remaining > 0) {
              logDeferOnce(task.id, task.title, siblings.remaining);
              continue;
            }
          }
        }

        // Gate: DAG dependency check — all depends_on task IDs must be 'done'
        // Permanently-blocked tasks (retry+reassign exhausted) are treated as done
        // to prevent goals from being blocked forever by unresolvable tasks.
        let rawDeps: string[];
        try {
          const parsed = JSON.parse(task.depends_on ?? "[]");
          if (!Array.isArray(parsed) || parsed.some((dependency) => typeof dependency !== "string")) {
            log.warn(`Task "${task.title}" deferred: depends_on must be a JSON array of task IDs`);
            continue;
          }
          rawDeps = parsed;
        } catch {
          log.warn(`Task "${task.title}" deferred: depends_on contains invalid JSON`);
          continue;
        }

        if (rawDeps.length > 0) {
          const pendingDeps = rawDeps.filter((depId) => {
            const dep = db.prepare(
              "SELECT status, retry_count, reassign_count, recovery_manual_action_required FROM tasks WHERE id = ?"
            ).get(depId) as { status: string; retry_count: number; reassign_count: number; recovery_manual_action_required: number } | undefined;
            if (!dep) return true; // 존재하지 않는 ID는 미충족으로 처리 (fail-closed)
            if (dep.status === "done" || dep.status === "skipped") return false; // terminal = 충족
            // permanently blocked → done과 동일 취급
            if (!dep.recovery_manual_action_required
              && dep.retry_count >= MAX_TASK_RETRIES
              && dep.reassign_count >= MAX_REASSIGNS) return false;
            return true; // 아직 미완료
          });

          if (pendingDeps.length > 0) {
            log.debug(`Task "${task.title}" deferred: ${pendingDeps.length} dependencies not yet done`);
            continue;
          }
        }

        picked.push(task);
        usedAgents.add(task.assignee_id);
        pickedGoalIds.add(task.goal_id);
        pickedNewGoals++;
        break; // goal 내부 순차 1 — 이 goal 은 이번 라운드 종료
      }
    }

    // 불변식 자기검증(goal 내부 순차 1): pickParallelGoals(비대기 in-flight 를 가진
    // goal 제외) + goal 당 후보 1개만 뽑고 break 하는 조합이, 한 라운드에 goal 마다
    // 최대 1개만 선택되도록 보장한다. Goal-as-Unit 은 goal 전체가 worktree 1개를
    // 공유하므로 같은 goal 태스크 2개가 동시에 뽑히면 그 worktree 에서 병행 실행돼
    // stash 체크포인트·파일 쓰기가 충돌한다. 여기서 중복이 보이면 위 불변식 중
    // 하나가 깨진 것 — 조용히 충돌시키지 말고 로그로 드러낸다(선택 결과는 불변).
    const seenGoals = new Set<string>();
    for (const t of picked) {
      if (t.goal_id && seenGoals.has(t.goal_id)) {
        log.error(
          `goal 내부 순차 1 위반: goal ${t.goal_id} 에서 태스크 2개가 동시 선택됨 — Goal-as-Unit worktree 충돌 위험 (pickParallelGoals/candidates 불변식 확인 필요)`,
        );
      }
      if (t.goal_id) seenGoals.add(t.goal_id);
    }

    return picked;
  }

  /**
   * Non-blocking: check for unprocessed goals and process them in background.
   * Does NOT stop the queue — current todo tasks keep running.
   */
  function triggerGoalProcessingIfNeeded(projectId: string): void {
    // Goal preparation belongs to a running queue. Notifications and delayed
    // callbacks may arrive after stopQueue(), but they must not start a new
    // spec/decompose session or revive the queue.
    if (!timers.has(projectId) || userStoppedQueues.has(projectId)) return;

    const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
    if (!project || (project.autopilot !== "goal" && project.autopilot !== "full")) return;
    if (goalPreparationFlights.has(projectId)) return;

    // Pipeline lookahead: "실행 중인 goal 수 < 동시성 + 1" 일 때만 다음 goal 의
    // spec/decompose 를 미리 돌린다. 예전에는 모든 작업이 끝나야 다음 goal 을
    // 분할해서 goal 전환마다 spec+decompose 시간만큼 큐가 놀았고, 반대로 전부
    // 미리 분할하면 앞 goal 결과에 따라 범위가 바뀔 goal 에 토큰을 낭비한다 —
    // 실행 슬롯 + 선행(lookahead) 1개가 그 절충.
    //
    // "실행 중" 판정은 기존 2-layer check 유지:
    // 1. non-terminal 태스크(in_progress, in_review, todo, pending_approval)가 있거나
    // 2. 재시도 여지가 있는 blocked 태스크가 있는 goal
    // progress는 파생 캐시이므로 실제 task 상태와 잠시 드리프트할 수 있다.
    // 준비 슬롯은 task 상태를 진실원으로 계산해 live goal을 누락하지 않는다.
    const activeGoalCount = (db.prepare(`
      SELECT COUNT(*) AS cnt FROM goals g
      WHERE g.project_id = ?
        AND (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id) > 0
        AND (
          (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status NOT IN ('done', 'blocked', 'skipped')) > 0
          OR (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status = 'blocked'
              AND (t.recovery_manual_action_required = 1
                OR t.retry_count < ? OR t.reassign_count < ?)) > 0
        )
    `).get(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { cnt: number }).cnt;

    if (activeGoalCount >= getEffectiveConcurrency(projectId) + 1) return; // 실행분 + 선행 1개까지 준비 완료

    // Fetch candidates in priority order with each goal's latest blueprint
    // version, then pick the first that is NOT stalled by a failed auto-approval.
    // Skipping an un-approvable blueprint lets a lower-priority goal be prepared
    // instead of the whole pipeline wedging on it (autopilot auto-approve edge).
    const candidates = db.prepare(`
      SELECT g.id AS id,
        (SELECT v.id FROM goal_spec_versions v WHERE v.goal_id = g.id ORDER BY v.version DESC LIMIT 1) AS latest_version_id
      FROM goals g
      WHERE g.project_id = ?
        AND (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id) = 0
      ORDER BY
        CASE g.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        g.sort_order ASC,
        g.created_at ASC
    `).all(projectId) as { id: string; latest_version_id: string | null }[];

    const nextGoal = candidates.find(
      (c) => !(c.latest_version_id && autoApproveFailedVersions.has(c.latest_version_id)),
    );

    if (nextGoal) {
      processNextGoal(projectId, nextGoal.id);
    }
  }

  /**
   * Check if the queue should auto-stop:
   * No todo, in_progress, in_review, pending_approval, or retryable blocked tasks remain.
   */
  function shouldAutoStop(projectId: string): boolean {
    // A zero-task goal whose spec is still '{"_status":"generating"}' is
    // pending work, not completion. The marker is owned by an in-flight spec
    // generation (POST /goals/:id/generate-spec, rescue path) that will call
    // notifyGoalReady when done — but that callback is gated on the queue
    // still running (timers.has). processNextGoal's isGenerating branch
    // releases the preparation flight and defers, so without this guard the
    // same poll would see no remaining tasks and auto-stop with reason
    // "completed", after which the completion callback is dropped and
    // decompose never starts. Treat any generating spec as outstanding work.
    // Match the generating marker as an exact literal instead of json_extract:
    // prd_summary can hold a plain-text summary (non-JSON), on which
    // json_extract throws SqliteError: malformed JSON and strands the poll.
    // The marker is always written as this exact string (recovery.ts uses the
    // same literal equality); processNextGoal likewise substring-matches it.
    const generating = db.prepare(`
      SELECT COUNT(*) as cnt FROM goal_specs gs
      JOIN goals g ON g.id = gs.goal_id
      WHERE g.project_id = ?
        AND gs.prd_summary = '{"_status":"generating"}'
    `).get(projectId) as { cnt: number };

    if (generating.cnt > 0) return false;

    // A zero-task goal waiting for its latest spec approval is pending user
    // work, not a completed project. Without this guard Full Auto immediately
    // generates another mission goal after processNextGoal returns at the gate.
    const approvalCandidates = db.prepare(`
      SELECT g.id FROM goals g
      WHERE g.project_id = ?
        AND g.spec_approval_required = 1
        AND (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id) = 0
    `).all(projectId) as { id: string }[];
    if (approvalCandidates.some((goal) => !assertExecutionAllowed(db, goal.id).allowed)) {
      return false;
    }

    const remaining = db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks
      WHERE project_id = ?
        AND status IN ('todo', 'in_progress', 'in_review', 'pending_approval')
    `).get(projectId) as { cnt: number };

    if (remaining.cnt > 0) return false;

    // Check for blocked tasks that could still be retried
    // A task is retryable only if BOTH conditions aren't exhausted.
    // Previously used OR which incorrectly kept retrying when one limit was hit but not the other.
    const retryable = db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks
      WHERE project_id = ?
        AND status = 'blocked'
        AND (recovery_manual_action_required = 1
          OR NOT (retry_count >= ? AND reassign_count >= ?))
    `).get(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { cnt: number };

    if (retryable.cnt > 0) return false;

    return true;
  }

  /**
   * Process a SINGLE goal — spec → decompose → auto-approve.
   * Sequential pipeline: one goal at a time by priority.
   * After this goal's tasks complete, shouldAutoStop picks the next goal.
   */
  function processNextGoal(projectId: string, goalId: string): void {
    if (!timers.has(projectId) || userStoppedQueues.has(projectId)) return;
    if (goalPreparationFlights.has(projectId)) return;
    goalPreparationFlights.set(projectId, goalId);

    const ctoAgent = db.prepare(
      "SELECT id FROM agents WHERE project_id = ? AND role = 'cto' LIMIT 1"
    ).get(projectId) as { id: string } | undefined;

    // 상태 전이일 때만 UPDATE+broadcast. poll() 이 매 tick(1s) processNextGoal 을
    // 재호출하고 finally 에서 clearActivity() 가 돌기 때문에, 전이 감지 없이 무조건
    // 브로드캐스트하면 스펙 승인 대기 중 CTO 가 이미 idle 인데도 초당 "대기 상태" 활동이
    // 대시보드에 폭주한다(활동 로그 스팸). prev===next 면 스킵한다.
    const setActivity = (activity: string) => {
      if (!ctoAgent) return;
      const cur = db.prepare("SELECT status, current_activity FROM agents WHERE id = ?")
        .get(ctoAgent.id) as { status: string; current_activity: string | null } | undefined;
      if (cur && cur.status === "working" && cur.current_activity === activity) return;
      db.prepare("UPDATE agents SET status = 'working', current_activity = ? WHERE id = ?").run(activity, ctoAgent.id);
      broadcast("agent:status", { id: ctoAgent.id, status: "working", activity });
    };
    const clearActivity = () => {
      if (!ctoAgent) return;
      const cur = db.prepare("SELECT status, current_activity FROM agents WHERE id = ?")
        .get(ctoAgent.id) as { status: string; current_activity: string | null } | undefined;
      if (cur && cur.status === "idle" && cur.current_activity === null) return;
      db.prepare("UPDATE agents SET status = 'idle', current_activity = NULL WHERE id = ?").run(ctoAgent.id);
      broadcast("agent:status", { id: ctoAgent.id, status: "idle" });
    };

    const goalRow = db.prepare("SELECT id, title FROM goals WHERE id = ?").get(goalId) as { id: string; title: string } | undefined;
    if (!goalRow) { goalPreparationFlights.delete(projectId); return; }
    const goalTitle = goalRow.title || goalId;

    const spec = db.prepare("SELECT prd_summary FROM goal_specs WHERE goal_id = ?").get(goalId) as { prd_summary: string } | undefined;
    const prd = spec?.prd_summary;
    const isGenerating = prd && prd.includes('"_status":"generating"');
    const hasVersionedSpec = db.prepare(
      "SELECT 1 FROM goal_spec_versions WHERE goal_id = ? LIMIT 1",
    ).get(goalId) !== undefined;
    const hasSpec = hasVersionedSpec || (prd && !isGenerating && !prd.includes('"_status":"failed"'));

    if (isGenerating) {
      goalPreparationFlights.delete(projectId);
      if (timers.has(projectId) && !userStoppedQueues.has(projectId)) {
        scheduleNextPoll(projectId);
      }
      return;
    }

    log.info(`Sequential pipeline: processing goal "${goalTitle}" (${goalId})`);

    (async () => {
      try {
        // Step 1: Generate spec if needed
        if (!hasSpec && generateGoalSpec) {
          setActivity(`spec_gen:${goalTitle.slice(0, 60)}`);
          db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot', ?)").run(
            projectId, `기획서 생성 중: "${goalTitle.slice(0, 60)}"`
          );
          broadcast("project:updated", { projectId });
          db.prepare(
            "INSERT OR REPLACE INTO goal_specs (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by) VALUES (?, '{\"_status\":\"generating\"}', '[]', '[]', '[]', '[]', 'ai')"
          ).run(goalId);
          await generateGoalSpec(goalId);
          broadcast("project:updated", { projectId });

          // stopQueue may have been called while spec generation was in
          // flight. Finishing that already-started session is allowed, but it
          // must not launch the next decompose session after the stop boundary.
          if (!timers.has(projectId) || userStoppedQueues.has(projectId)
            || getPauseState(projectId).paused || enforceDailyBudget(projectId)) return;
        }

        // 반자동(goal)/완전자동(full)에서는 자동 생성/기존 draft 기획서를 자동 승인해
        // 파이프라인이 승인 게이트에서 멈추지 않게 한다. 아래 Step 3의 task 자동 승인과 동일
        // 철학 — 수동(off)에서만 사용자 승인 게이트로 실행을 막는다. 승인 검증 실패 시엔
        // 승인하지 않고(아래 게이트가 그대로 차단) 수동 개입을 유도한다.
        const autopilotForApproval = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
        if (autopilotForApproval && (autopilotForApproval.autopilot === "goal" || autopilotForApproval.autopilot === "full")) {
          const specState = getSpecState(db, goalId);
          const latest = specState.versions.at(-1);
          if (latest && latest.state === "draft" && specState.status !== "approved") {
            try {
              approveSpecVersion(db, goalId, latest.id);
              db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot', ?)").run(
                projectId, `기획서 자동 승인: "${goalTitle.slice(0, 60)}"`
              );
              broadcast("project:updated", { projectId });
            } catch (approveErr: any) {
              // Validation failure (incomplete blueprint) is permanent until the
              // blueprint is edited — record the version so the selector stops
              // re-picking this goal every poll (busy-loop) and blocking others,
              // and surface it once for manual review. Other (transient) errors
              // are left to retry on the next poll.
              const invalidSpec = approveErr instanceof SpecApprovalError && approveErr.code === "invalid_spec";
              if (invalidSpec && !autoApproveFailedVersions.has(latest.id)) {
                autoApproveFailedVersions.add(latest.id);
                log.warn(`Auto-approve spec failed (invalid) for goal ${goalId}: ${approveErr.message}`);
                db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)").run(
                  projectId,
                  `기획서 자동 승인 실패 — 수동 검토 필요: "${goalTitle.slice(0, 60)}" (${String(approveErr.message).slice(0, 100)})`,
                );
                broadcast("project:updated", { projectId });
              } else if (!invalidSpec) {
                log.warn(`Auto-approve spec failed for goal ${goalId}: ${approveErr.message}`);
              }
            }
          }
        }

        const executionGate = assertExecutionAllowed(db, goalId);
        if (!executionGate.allowed) {
          log.info(
            `Sequential pipeline: waiting for Goal Spec approval (${goalId}, status=${executionGate.specStatus})`,
          );
          return;
        }

        // Step 2: Decompose (skip if tasks already exist — decomposeGoal guards this too)
        const existingTasks = (db.prepare(
          "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ?"
        ).get(goalId) as { count: number }).count;
        if (existingTasks === 0) {
          if (!timers.has(projectId) || userStoppedQueues.has(projectId)
            || getPauseState(projectId).paused || enforceDailyBudget(projectId)) return;
          setActivity(`decompose:${goalTitle.slice(0, 60)}`);
          db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot', ?)").run(
            projectId, `태스크 분할 중: "${goalTitle.slice(0, 60)}"`
          );
          broadcast("project:updated", { projectId });
          await engine.decomposeGoal(goalId);

          // Step 3: Plan review gate — a reviewer agent approves/rejects/
          // escalates each decomposed task (replaces the old blanket
          // auto-approve). Escalated tasks stay pending_approval for the human.
          if (!timers.has(projectId) || userStoppedQueues.has(projectId)
            || getPauseState(projectId).paused || enforceDailyBudget(projectId)) return;
          const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
          if (project) {
            await engine.applyPlanReviewGate(goalId, { autopilot: project.autopilot });
          }
          broadcast("project:updated", { projectId });
        } else {
          log.info(`processNextGoal: goal ${goalId} already has ${existingTasks} task(s), skipping decompose`);
        }

        // Wake an already-running queue so it can consume the prepared goal.
        // Never recreate a missing timer here: a missing timer means the queue
        // was stopped while this async preparation was in flight.
        if (timers.has(projectId) && !userStoppedQueues.has(projectId)) {
          const existing = timers.get(projectId);
          if (existing) clearTimeout(existing);
          timers.set(projectId, setTimeout(() => poll(projectId), 0));
        }
      } catch (err: any) {
        log.error(`Failed to process goal ${goalId}`, err);
        db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_error', ?)").run(
          projectId, `목표 처리 실패 "${goalTitle.slice(0, 40)}": ${err.message?.slice(0, 150)}`
        );
        broadcast("project:updated", { projectId });

        // 실행 파일 없음(ENOENT)/미설치는 영구 오류 — 재시도해도 60초 뒤 나타나지 않는다.
        // 즉시 중단하고 명확히 알린다 (실측: codex 미설치 + provider=codex 시 재시도·failover가
        // 겹쳐 하루 1000+ 세션 폭주). transient(rate limit·JSON 잘림)만 재시도한다.
        const errText = `${err?.code ?? ""} ${err?.message ?? ""}`.toLowerCase();
        const permanentEnvError =
          errText.includes("enoent") || errText.includes("not found") || errText.includes("not installed");
        if (permanentEnvError) {
          decomposRetryCount.delete(`decompose-retry-${goalId}`);
          log.warn(`Decompose aborted — execution engine unavailable (no retry): ${err.message}`);
          db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_error', ?)").run(
            projectId,
            `실행 엔진 미가용으로 작업 분할 중단 (재시도 안 함) — 프로젝트 '실행 엔진' 설정을 확인하거나 CLI를 설치하세요: ${err.message?.slice(0, 120)}`,
          );
          broadcast("project:updated", { projectId });
          return;
        }

        // Auto-retry decompose failures (rate limit, truncated JSON, etc.)
        // Max 2 retries with 60s backoff. Only retry if no tasks were created
        // (partial creation is handled by the fallback auto-approve path).
        const retryKey = `decompose-retry-${goalId}`;
        const retryCount = (decomposRetryCount.get(retryKey) ?? 0) + 1;
        decomposRetryCount.set(retryKey, retryCount);
        const existingAfterError = (db.prepare(
          "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ?"
        ).get(goalId) as { count: number }).count;

        if (retryCount <= 2 && existingAfterError === 0
          && timers.has(projectId) && !userStoppedQueues.has(projectId)) {
          const retryDelayMs = 60_000 * retryCount; // 60s, 120s
          log.info(`Decompose retry ${retryCount}/2 for goal "${goalTitle}" in ${retryDelayMs / 1000}s`);
          db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot', ?)").run(
            projectId, `작업 분할 재시도 ${retryCount}/2 — ${retryDelayMs / 1000}초 후 자동 재시도`
          );
          broadcast("project:updated", { projectId });
          setTimeout(() => {
            decomposRetryCount.delete(retryKey);
            if (!timers.has(projectId) || userStoppedQueues.has(projectId)) return;
            // Guard: goal may have been deleted during the retry delay
            const stillExists = db.prepare("SELECT id FROM goals WHERE id = ?").get(goalId);
            if (stillExists) {
              processNextGoal(projectId, goalId);
            } else {
              log.info(`Decompose retry skipped: goal ${goalId} was deleted`);
              triggerGoalProcessingIfNeeded(projectId);
            }
          }, retryDelayMs);
        } else if (retryCount > 2) {
          decomposRetryCount.delete(retryKey);
          log.warn(`Decompose retry exhausted for goal "${goalTitle}" — manual retry required`);
          db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)").run(
            projectId, `작업 분할 ${retryCount}회 실패 — 수동 재시도 필요: "${goalTitle.slice(0, 60)}"`
          );
          broadcast("project:updated", { projectId });
        }
      } finally {
        clearActivity();
        if (goalPreparationFlights.get(projectId) === goalId) {
          goalPreparationFlights.delete(projectId);
        }
      }
    })();
  }

  function scheduleNextPoll(projectId: string): void {
    // Clear any existing timer before scheduling a new one. Without this,
    // code paths that call scheduleNextPoll twice in the same poll() cycle
    // (e.g. processNextGoal's isGenerating early-return path followed by
    // poll()'s own tail call at the end) leak orphan timers. Map.set only
    // replaces the map entry — the previous setTimeout handle stays live
    // and fires independently, doubling the timer count each poll cycle.
    // Left unchecked this grows exponentially and saturates the event loop.
    const existing = timers.get(projectId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => poll(projectId), POLL_INTERVAL_MS);
    timers.set(projectId, handle);
  }

  // 환경 오류(claude CLI ENOENT 등) 쿨다운 — rate-limit 쿨다운과 동일 패턴의 짧은 버전.
  // 환경 오류는 태스크가 아니라 전역 상태의 문제라, 태스크를 blocked로 소모하는 대신
  // 큐를 잠시 멈추고 자동 재시도한다 (claude 자동 업데이트 같은 transient는 스스로 회복).
  const ENV_ERROR_COOLDOWN_MS = 60_000;

  function handleEnvError(projectId: string, message: string): void {
    const state = getPauseState(projectId);
    if (state.paused) return; // 이미 쿨다운 중 — 중복 진입 방지
    state.paused = true;
    const retryAt = new Date(Date.now() + ENV_ERROR_COOLDOWN_MS);
    state.nextRetryAt = retryAt;
    log.error(`Queue cooling down: environment error — ${message.slice(0, 150)} (retry in ${ENV_ERROR_COOLDOWN_MS / 1000}s)`);
    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)",
    ).run(projectId, `환경 오류로 자동 실행 일시정지 (${ENV_ERROR_COOLDOWN_MS / 1000}초 후 자동 재시도) — ${message.slice(0, 150)}`);
    broadcast("queue:paused", {
      projectId,
      reason: "env_error_cooldown",
      nextRetryAt: retryAt.toISOString(),
      backoffMs: ENV_ERROR_COOLDOWN_MS,
      message: `환경 오류 (claude CLI 상태 확인 필요) — ${ENV_ERROR_COOLDOWN_MS / 1000}초 후 자동 재시도`,
    });
    if (state.resumeTimer) clearTimeout(state.resumeTimer);
    state.resumeTimer = setTimeout(() => {
      state.paused = false;
      state.nextRetryAt = null;
      log.info(`Queue resumed after env-error cooldown for project ${projectId}`);
      broadcast("queue:resumed", { projectId });
      poll(projectId);
    }, ENV_ERROR_COOLDOWN_MS);
  }

  function handleRateLimit(projectId: string): void {
    const state = getPauseState(projectId);
    state.consecutiveRateLimits++;
    state.paused = true;

    if (state.consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
      // Previously: stopQueueInternal() — completely stopped the queue and
      // required a human to click "run queue" again. That meant long-running
      // autopilot sessions silently died overnight the first time the Claude
      // Pro budget hit its window limit.
      //
      // New behaviour: enter a long cooldown (default 15 min), reset the
      // rate-limit counter when it expires, and auto-resume the queue.
      // The queue itself stays "alive" from the user's perspective — the
      // UI can surface "cooling down, resumes at HH:MM" without requiring
      // intervention.
      const retryAt = new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS);
      state.nextRetryAt = retryAt;
      log.error(
        `Queue cooling down: ${state.consecutiveRateLimits} consecutive rate limits — long backoff ${RATE_LIMIT_COOLDOWN_MS / 60000}min for project ${projectId}`,
      );
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)",
      ).run(
        projectId,
        `Rate limit ${state.consecutiveRateLimits}회 연속 — ${Math.round(RATE_LIMIT_COOLDOWN_MS / 60000)}분 쿨다운 후 자동 재시도`,
      );
      broadcast("queue:paused", {
        projectId,
        reason: "rate_limit_cooldown",
        retryNumber: state.consecutiveRateLimits,
        maxRetries: MAX_CONSECUTIVE_RATE_LIMITS,
        nextRetryAt: retryAt.toISOString(),
        backoffMs: RATE_LIMIT_COOLDOWN_MS,
        message: `Rate limit ${state.consecutiveRateLimits}회 — ${Math.round(RATE_LIMIT_COOLDOWN_MS / 60000)}분 후 자동 재시도`,
      });

      // Cancel any short-backoff resume timer that may still be pending
      if (state.resumeTimer) clearTimeout(state.resumeTimer);
      state.resumeTimer = setTimeout(() => {
        state.paused = false;
        state.nextRetryAt = null;
        state.consecutiveRateLimits = 0; // full reset after cooldown
        // AIMD: reset concurrency to max after full cooldown recovery
        const prevConcurrency = getEffectiveConcurrency(projectId);
        const baseConcurrency = getProjectBaseConcurrency(projectId);
        effectiveConcurrency.set(projectId, baseConcurrency);
        if (prevConcurrency !== baseConcurrency) {
          log.info(`AIMD: concurrency ${prevConcurrency} → ${baseConcurrency} for ${projectId} (cooldown reset)`);
        }
        log.info(`Queue resumed after rate-limit cooldown for project ${projectId}`);
        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot', ?)",
        ).run(projectId, `쿨다운 종료 — 큐 자동 재개`);
        broadcast("queue:resumed", { projectId });
        if (timers.has(projectId)) {
          poll(projectId);
        } else if (!userStoppedQueues.has(projectId)) {
          // Queue was fully stopped somewhere else (e.g. shutdown). Start
          // it again inline — same logic as the exported startQueue.
          // 사용자 명시 정지는 존중, busyAgents는 보존(이중 스폰 SIGTERM 방지).
          log.info(`Rate-limit cooldown over but timers cleared, restarting queue for ${projectId}`);
          if (!busyAgents.has(projectId)) busyAgents.set(projectId, new Set());
          pauseState.delete(projectId);
          timers.set(projectId, setTimeout(() => poll(projectId), 0));
        }
      }, RATE_LIMIT_COOLDOWN_MS);
      return;
    }

    // AIMD: Multiplicative Decrease — reduce concurrency instead of full pause
    // consecutive 1~2회: 동시성을 절반으로 줄이고 계속 실행
    const prevConcurrency = getEffectiveConcurrency(projectId);
    const newConcurrency = Math.max(1, Math.floor(prevConcurrency * 0.5));
    effectiveConcurrency.set(projectId, newConcurrency);
    if (prevConcurrency !== newConcurrency) {
      log.info(`AIMD: concurrency ${prevConcurrency} → ${newConcurrency} for ${projectId} (rate limit, multiplicative decrease)`);
    }

    // Cancel any previous backoff timer to prevent timer overlap
    // (e.g., 60s timer fires while 120s timer is still pending → double poll)
    if (state.resumeTimer) clearTimeout(state.resumeTimer);

    // Pause during backoff — resumed by the timer below
    state.paused = true;

    const backoffMs = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, state.consecutiveRateLimits - 1),
      BACKOFF_MAX_MS,
    );

    log.warn(`Queue AIMD: rate limit (${state.consecutiveRateLimits}/${MAX_CONSECUTIVE_RATE_LIMITS}), concurrency reduced to ${newConcurrency}, backoff ${backoffMs / 1000}s before next pick`);

    broadcast("queue:paused", {
      projectId,
      reason: "rate_limit",
      retryNumber: state.consecutiveRateLimits,
      maxRetries: MAX_CONSECUTIVE_RATE_LIMITS,
      nextRetryAt: new Date(Date.now() + backoffMs).toISOString(),
      backoffMs,
    });

    // Short backoff before allowing next pick — prevents immediate retry spam
    state.resumeTimer = setTimeout(() => {
      state.paused = false;
      state.nextRetryAt = null;
      log.info(`Queue AIMD backoff elapsed for project ${projectId}`);
      broadcast("queue:resumed", { projectId });
      if (timers.has(projectId)) poll(projectId);
    }, backoffMs);
  }

  function stopQueueInternal(projectId: string): void {
    const handle = timers.get(projectId);
    if (handle !== undefined) clearTimeout(handle);
    timers.delete(projectId);

    const state = getPauseState(projectId);
    if (state.resumeTimer) clearTimeout(state.resumeTimer);
    pauseState.delete(projectId);
  }

  /**
   * failover로 재디스패치된 태스크의 redispatched_session_id를 backfill한다.
   * 재실행(executeTask)이 새 세션을 생성한 뒤에만 유효하므로 executeOne finally에서 호출된다.
   * 원본(실패) 세션과 아직 같은 세션이면(= 새 세션 미생성) no-op으로 다음 실행을 기다린다.
   */
  function getPendingFailover(taskId: string): {
    originalSessionId: string | null;
    toProvider: AgentProvider;
    sessionKey: string;
    afterSessionRowId: number;
    redispatchAfterRowId: number | null;
  } | undefined {
    const inMemory = pendingFailoverByTask.get(taskId);
    if (inMemory) return inMemory;

    const row = db.prepare(
      `SELECT t.provider_failover_original_session_id, t.provider_failover_to_provider,
              t.assignee_id, original.agent_id AS original_agent_id
       FROM tasks t
       LEFT JOIN sessions original ON original.id = t.provider_failover_original_session_id
       WHERE t.id = ?
         AND t.provider_failover_redispatched = 1
         AND t.provider_failover_redispatched_session_id IS NULL`,
    ).get(taskId) as {
      provider_failover_original_session_id: string | null;
      provider_failover_to_provider: string | null;
      assignee_id: string | null;
      original_agent_id: string | null;
    } | undefined;
    if (!row || !isAgentProvider(row.provider_failover_to_provider)) {
      return undefined;
    }

    const boundary = row.provider_failover_original_session_id
      ? db.prepare("SELECT rowid FROM sessions WHERE id = ?")
        .get(row.provider_failover_original_session_id) as { rowid: number } | undefined
      : db.prepare("SELECT COALESCE(MAX(rowid), 0) AS rowid FROM sessions WHERE task_id = ?")
        .get(taskId) as { rowid: number };

    const recovered = {
      originalSessionId: row.provider_failover_original_session_id,
      toProvider: row.provider_failover_to_provider,
      sessionKey: row.original_agent_id && row.original_agent_id !== row.assignee_id
        ? `evaluator-${taskId}`
        : row.assignee_id ?? `evaluator-${taskId}`,
      afterSessionRowId: boundary?.rowid ?? 0,
      // 재시작으로 인메모리가 비어 복원된 경우엔 재실행 boundary를 모른다 → null로 두고,
      // executeOne이 이 task를 재실행할 때 세팅되길 기다린다(그때까지 backfill 보류).
      redispatchAfterRowId: null,
    };
    pendingFailoverByTask.set(taskId, recovered);
    return recovered;
  }

  /**
   * DB에 영속된 failover 트레이스에서 이 태스크가 이미 시도한 provider를 복원한다.
   * triedProvidersByTask(인메모리)는 서버 재시작으로 비므로, 실제 재디스패치가
   * 일어난(redispatched=1) 트레이스의 from/to provider를 loop guard 입력에 되살려
   * claude↔codex 무한 왕복을 재시작 이후에도 차단한다. redispatched=0(쿨다운만)이면
   * to provider가 실제로 실행된 적이 없으므로 복원하지 않는다(불필요한 loop guard 방지).
   */
  function readTriedProvidersFromDb(taskId: string): AgentProvider[] {
    const row = db.prepare(
      `SELECT provider_failover_from_provider, provider_failover_to_provider, provider_failover_redispatched
       FROM tasks WHERE id = ?`,
    ).get(taskId) as {
      provider_failover_from_provider: string | null;
      provider_failover_to_provider: string | null;
      provider_failover_redispatched: number | null;
    } | undefined;
    if (!row) return [];
    return triedProvidersFromFailoverTrace({
      fromProvider: isAgentProvider(row.provider_failover_from_provider) ? row.provider_failover_from_provider : null,
      toProvider: isAgentProvider(row.provider_failover_to_provider) ? row.provider_failover_to_provider : null,
      redispatched: row.provider_failover_redispatched === 1,
    });
  }

  function broadcastTaskSnapshot(taskId: string): void {
    const serialized = selectTaskForResponse(db, taskId);
    if (serialized) {
      broadcast("task:updated", serializeTask(serialized, loadProviderConfig().defaultProvider));
    }
  }

  function scheduleRedispatchBackfill(taskId: string, attempt = 0): void {
    if (pendingBackfillTimers.has(taskId) || !getPendingFailover(taskId)) return;
    const handle = setTimeout(() => {
      pendingBackfillTimers.delete(taskId);
      if (backfillRedispatchSession(taskId)) {
        broadcastTaskSnapshot(taskId);
        return;
      }
      if (attempt < 40 && getPendingFailover(taskId)) {
        scheduleRedispatchBackfill(taskId, attempt + 1);
      }
    }, 250);
    pendingBackfillTimers.set(taskId, handle);
  }

  function backfillRedispatchSession(taskId: string): boolean {
    const pending = getPendingFailover(taskId);
    if (pending === undefined) return false;
    const row = db.prepare(`
      SELECT project_id, assignee_id, title,
             provider_failover_reason_code, provider_failover_user_message,
             provider_failover_from_provider, provider_failover_to_provider,
             provider_failover_redispatched
      FROM tasks WHERE id = ?
    `).get(taskId) as
      | {
          project_id: string;
          assignee_id: string | null;
          title: string | null;
          provider_failover_reason_code: string | null;
          provider_failover_user_message: string | null;
          provider_failover_from_provider: string | null;
          provider_failover_to_provider: string | null;
          provider_failover_redispatched: number;
        }
      | undefined;
    if (!row?.assignee_id) {
      pendingFailoverByTask.delete(taskId);
      return false;
    }
    // 재디스패치 재실행이 아직 시작되지 않았으면(=boundary 미확정) 귀속하지 않는다.
    // 재디스패치 세션은 task_id로 이 task에 정확히 귀속된다(spawn 시 sessions.task_id 기록).
    // rowid boundary는 같은 task의 이전 failover 라운드가 만든 toProvider 세션과 이번
    // 재실행의 세션을 구분하는 보조 조건이다 — 재실행 시작 이후 rowid만 이번 재디스패치로 본다.
    if (pending.redispatchAfterRowId === null) return false; // 재실행 미시작 — 조기 backfill 금지
    // status로 재디스패치 세션 생성 여부를 판정하지 않는다. 재디스패치 세션이 생겼다가
    // 즉시 실패하면(env_error 등) engine이 태스크를 다시 todo로 되돌리는데, 이때 status
    // 가드로 막으면 이미 생성된 세션의 링크를 영영 backfill하지 못한다. 세션 존재 여부는
    // 아래 newest 쿼리(이 task의, 재실행 boundary 이후 생성된 toProvider 세션)가 단독으로
    // 판정한다 — 없으면 false를 반환하므로 생성 전 조기 backfill도 자연히 방지된다.
    // task_id 필터가 있으므로 boundary 이후 끼어든 무관한(다른 task의) 세션은 오귀속되지 않는다.
    const newest = db.prepare(
      `SELECT id FROM sessions
       WHERE task_id = ?
         AND provider = ?
         AND rowid > ?
       ORDER BY rowid ASC
       LIMIT 1`,
    ).get(taskId, pending.toProvider, pending.redispatchAfterRowId) as { id: string } | undefined;
    if (!newest || newest.id === pending.originalSessionId) return false; // 재디스패치 세션 아직 미생성

    const originalTrace = db.prepare(
      `SELECT provider_failover_reason_code, provider_failover_user_message,
              provider_failover_from_provider, provider_failover_to_provider,
              provider_failover_redispatched
       FROM sessions WHERE id = ?`,
    ).get(pending.originalSessionId) as {
      provider_failover_reason_code: string | null;
      provider_failover_user_message: string | null;
      provider_failover_from_provider: string | null;
      provider_failover_to_provider: string | null;
      provider_failover_redispatched: number;
    } | undefined;
    const trace = originalTrace ?? row;

    db.prepare(
      `UPDATE tasks SET
         provider_failover_redispatched_session_id = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    )
      .run(newest.id, taskId);
    db.prepare(
      `UPDATE sessions SET
         provider_failover_original_session_id = COALESCE(provider_failover_original_session_id, ?),
         provider_failover_redispatched_session_id = ?
       WHERE id = ?`,
    ).run(pending.originalSessionId, newest.id, pending.originalSessionId);
    db.prepare(
      `UPDATE sessions SET
         provider_failover_reason_code = COALESCE(provider_failover_reason_code, ?),
         provider_failover_user_message = COALESCE(provider_failover_user_message, ?),
         provider_failover_from_provider = COALESCE(provider_failover_from_provider, ?),
         provider_failover_to_provider = COALESCE(provider_failover_to_provider, ?),
         provider_failover_redispatched =
           CASE WHEN provider_failover_redispatched = 1 THEN 1 ELSE ? END,
         provider_failover_original_session_id = ?,
         provider_failover_redispatched_session_id = ?
       WHERE id = ?`,
    ).run(
      trace.provider_failover_reason_code ?? null,
      trace.provider_failover_user_message ?? null,
      trace.provider_failover_from_provider ?? null,
      trace.provider_failover_to_provider ?? null,
      1,
      pending.originalSessionId,
      newest.id,
      newest.id,
    );
    pendingFailoverByTask.delete(taskId);
    const timer = pendingBackfillTimers.get(taskId);
    if (timer) clearTimeout(timer);
    pendingBackfillTimers.delete(taskId);
    recordRedispatchActivity({
      projectId: row.project_id,
      taskId,
      agentId: row.assignee_id,
      taskTitle: row.title ?? "",
      reasonCode: asFailoverReasonCode(trace.provider_failover_reason_code),
      fromProvider: isAgentProvider(trace.provider_failover_from_provider)
        ? trace.provider_failover_from_provider
        : null,
      toProvider: pending.toProvider,
      redispatched: true,
      originalSessionId: pending.originalSessionId,
      redispatchedSessionId: newest.id,
      userMessage: `재디스패치 시작: ${labelProvider(pending.toProvider)} 실행 세션이 연결되었습니다 — "${(row.title ?? "").slice(0, 80)}"`,
    });
    return true;
  }

  function sweepPendingRedispatchBackfills(projectId: string): void {
    const rows = db.prepare(
      `SELECT id FROM tasks
       WHERE project_id = ?
         AND provider_failover_redispatched = 1
         AND provider_failover_redispatched_session_id IS NULL`,
    ).all(projectId) as { id: string }[];
    for (const row of rows) {
      if (backfillRedispatchSession(row.id)) {
        broadcastTaskSnapshot(row.id);
      }
    }
  }

  /** Execute a single task, handling completion and delegation. */
  async function executeOne(
    projectId: string,
    task: any,
    claim: Extract<TaskExecutionClaim, { claimed: true }>,
  ): Promise<void> {
    acquireExecutionOwnership(projectId, task.id, task.assignee_id);
    const state = getPauseState(projectId);
    const sessionRowIdBeforeExecution = (db.prepare(
      "SELECT COALESCE(MAX(rowid), 0) AS rowid FROM sessions WHERE task_id = ?",
    ).get(task.id) as { rowid: number }).rowid;

    // 이 실행이 failover 재디스패치의 재실행이면, 재실행 시작 시점의 세션 boundary를
    // pending에 고정한다. 이 boundary 이후에 생성된 toProvider 세션만 이 task의 재디스패치
    // 세션으로 귀속돼(backfillRedispatchSession), failover 예약~재실행 사이에 낀 무관한
    // 세션의 오귀속을 막는다. (sessions엔 task_id가 없어 rowid boundary를 task 식별에 쓴다.)
    const pendingForRedispatch = getPendingFailover(task.id);
    if (pendingForRedispatch && pendingForRedispatch.redispatchAfterRowId === null) {
      pendingForRedispatch.redispatchAfterRowId = sessionRowIdBeforeExecution;
    }

    log.info(`Scheduler: executing "${task.title}" via agent ${task.assignee_id}`);

    try {
      recordProviderResolved(task);
      const result = await engine.executeTask(task.id, {}, claim);
      broadcast("task:updated", { taskId: task.id, ...result });

      // Success — reset rate limit counter
      state.consecutiveRateLimits = 0;

      // Success — failover override/이력 정리 (다음 실행은 정상 해석)
      sessionManager.clearProviderOverride(task.assignee_id);
      sessionManager.clearProviderOverride(`evaluator-${task.id}`);
      triedProvidersByTask.delete(task.id);

      // AIMD: Additive Increase — restore concurrency by 1 on consecutive success
      const prevConcurrency = getEffectiveConcurrency(projectId);
      const baseConcurrency = getProjectBaseConcurrency(projectId);
      if (prevConcurrency < baseConcurrency) {
        const newConcurrency = Math.min(baseConcurrency, prevConcurrency + 1);
        effectiveConcurrency.set(projectId, newConcurrency);
        log.info(`AIMD: concurrency ${prevConcurrency} → ${newConcurrency} for ${projectId} (success, additive increase)`);
      }

      if (task.parent_task_id) {
        delegationEngine.checkParentCompletion(task.parent_task_id);
      }
    } catch (err: any) {
      // Duplicate execution — another caller owns this task, nothing to do
      if (err.message?.includes("skipping duplicate execution")) {
        return;
      }

      const recoveryDecision = err?.recoveryDecision as
        | "resume" | "advance" | "wait_approval" | "blocked" | undefined;
      // Recovery already made the authoritative Git/worktree-safe state
      // transition. blocked/advance/wait_approval must never be overwritten by
      // provider failover or generic retry handling.
      if (recoveryDecision && recoveryDecision !== "resume") {
        broadcastTaskSnapshot(task.id);
        log.warn(`Scheduler preserved recovery decision ${recoveryDecision} for task "${task.title}"`);
        return;
      }

      // 책임 소재 분류는 errors.ts의 classifyAgentFailure 단일 정본 사용 —
      // engine의 태스크 상태 전이와 판단이 갈리면 전역 오류가 태스크 재시도
      // 예산을 태운다 (세션 소진 실측, 07-08).
      // 방금 실패한 세션이 실제 돈 provider (sessions.provider) — 분류·failover 공용.
      // codex 세션의 "빈 stderr non-zero"를 claude 세션소진으로 오분류하지 않도록 provider를 넘긴다.
      const lastSess = db.prepare(
        `SELECT id, agent_id, provider, rowid FROM sessions
         WHERE task_id = ? AND rowid > ?
         ORDER BY rowid DESC LIMIT 1`,
      ).get(task.id, sessionRowIdBeforeExecution) as
        | { id: string; agent_id: string; provider: string | null; rowid: number }
        | undefined;
      const taskTrace = db.prepare(
        "SELECT provider_trace_resolved_provider FROM tasks WHERE id = ?",
      ).get(task.id) as { provider_trace_resolved_provider: string | null } | undefined;
      const currentProvider: AgentProvider = lastSess?.provider === "codex"
        || (!lastSess && taskTrace?.provider_trace_resolved_provider === "codex")
        ? "codex"
        : "claude";

      const failureClass = classifyAgentFailure(err, { provider: currentProvider });

      // A clean checkpoint was safely returned to todo. Provider-level errors
      // may still select a backend below, but a generic task_error must not
      // rewrite the audited resume decision to blocked.
      if (recoveryDecision === "resume" && failureClass === "task_error") {
        broadcastTaskSnapshot(task.id);
        log.warn(`Scheduler preserved recovery resume for task "${task.title}"`);
        return;
      }

      // ── Codex/Claude failover — 트리거 실패면 대체 백엔드로 즉시 재디스패치(쿨다운 대신) ──
      if (failureClass === "rate_limit" || failureClass === "session_exhausted" || failureClass === "env_error") {
        const provCfg = loadProviderConfig();
        const tried = triedProvidersByTask.get(task.id) ?? new Set<AgentProvider>();
        // 재시작으로 인메모리 Map이 비어도 왕복 재디스패치를 막으려면 DB에 남은
        // failover 트레이스에서 이미 시도한 provider를 복원한다 (loop guard 내구성).
        for (const p of readTriedProvidersFromDb(task.id)) tried.add(p);
        tried.add(currentProvider);
        triedProvidersByTask.set(task.id, tried);
        const codexAvailable = await getBackend("codex").isAvailable();
        const decision = decideFailover({
          failure: failureClass as FailureClass,
          currentProvider,
          triedProviders: [...tried],
          codexAvailable,
          claudeAvailable: true,
          failoverEnabled: provCfg.codexFailover,
        });
        recordProviderFailoverDecision(db, task.id, lastSess?.id, decision);
        recordFailoverDecisionActivity(projectId, task, lastSess?.id ?? null, decision);
        if (decision.action === "failover") {
          tried.add(decision.toProvider);
          const failoverSessionKey = lastSess?.agent_id && lastSess.agent_id !== task.assignee_id
            ? `evaluator-${task.id}`
            : task.assignee_id;
          sessionManager.setProviderOverride(failoverSessionKey, decision.toProvider);
          // failover 관측성 기록 — 사유/전환 provider/원본(실패) 세션 id를 태스크와 원본 세션 양쪽에 남긴다.
          // redispatched_session_id는 재실행이 새 세션을 만든 뒤 finally의 backfillRedispatchSession에서 채운다.
          const originalSessionId = lastSess?.id ?? null;
          // 태스크를 todo로 되돌려 즉시 재픽 (retry 예산 미소모·쿨다운 없음)
          db.prepare(
            `UPDATE tasks SET
               status = 'todo',
               started_at = NULL,
               provider_failover_original_session_id = ?,
               updated_at = datetime('now')
             WHERE id = ?`,
          ).run(originalSessionId, task.id);
          if (originalSessionId) {
            db.prepare(
              `UPDATE sessions SET
                 provider_failover_original_session_id = ?
               WHERE id = ?`,
            ).run(originalSessionId, originalSessionId);
          }
          pendingFailoverByTask.set(task.id, {
            originalSessionId,
            toProvider: decision.toProvider,
            sessionKey: failoverSessionKey,
            afterSessionRowId: lastSess?.rowid ?? sessionRowIdBeforeExecution,
            // 재실행 boundary는 아직 모른다 — 다음 poll의 executeOne이 이 task를
            // 재실행할 때 세팅한다. 그 전까진 backfill이 보류돼 무관한 세션을 막는다.
            redispatchAfterRowId: null,
          });
          // 방금 기록한 failover trace가 담긴 완전한 task를 broadcast한다. 부분 페이로드
          // ({taskId, status})만 보내면 dashboard store가 providerTrace.failover를 merge하지
          // 못해 refetch 전까지 화면이 갱신되지 않는다.
          const serialized = selectTaskForResponse(db, task.id);
          broadcast(
            "task:updated",
            serialized ? serializeTask(serialized, provCfg.defaultProvider) : { taskId: task.id, status: "todo" },
          );
          recordRedispatchActivity({
            projectId,
            taskId: task.id,
            agentId: task.assignee_id ?? null,
            taskTitle: String(task.title ?? ""),
            reasonCode: decision.reasonCode,
            fromProvider: decision.fromProvider,
            toProvider: decision.toProvider,
            redispatched: true,
            originalSessionId,
            redispatchedSessionId: null,
            userMessage: `재디스패치 예약: ${labelProvider(decision.toProvider)}로 다시 실행합니다 — "${String(task.title ?? "").slice(0, 80)}"`,
          });
          log.warn(`Failover ${currentProvider}→${decision.toProvider} for task "${task.title}" (${failureClass})`);
          return;
        }
      }

      if (failureClass === "rate_limit" || failureClass === "session_exhausted") {
        if (failureClass === "session_exhausted") {
          // CLI exits with code 1 and empty stderr — all Claude sessions in use.
          // Treat as rate-limit so the pause overlay shows instead of red toasts.
          log.warn(`Session exhaustion detected for "${task.title}" — treating as rate limit`);
        }
        handleRateLimit(projectId);
      } else if (failureClass === "env_error") {
        // 환경 오류: engine이 태스크를 todo로 되돌려 뒀다 — blocked/retry로 소모하지
        // 않고 큐만 쿨다운한다. (과거: retry=999 → auto-resolve가 가짜 done 처리)
        handleEnvError(projectId, err.message ?? "environment error");
      } else {
        // CRITICAL: if engine.executeTask threw BEFORE calling
        // transitionTask(in_progress) — e.g. an architect-phase failure — the
        // task is still `todo` in the DB. Without explicitly marking it
        // failed here, the very next poll picks the same task, runs architect
        // again, fails the same way, and we spin forever (the infinite
        // architect_started loop we observed 10:18~10:21). Retry budget is
        // owned by the blocked→retry promotion path in pickNextTasks, not by
        // the caller, so we set blocked + bump retry_count so the loop can
        // actually exit on its own.
        const actual = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as
          | { status: string }
          | undefined;
        if (actual && (actual.status === "todo" || actual.status === "in_progress" || actual.status === "in_review")) {
          db.prepare(
            "UPDATE tasks SET status = 'blocked', retry_count = retry_count + 1, updated_at = datetime('now') WHERE id = ?",
          ).run(task.id);
          db.prepare(
            "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'task_blocked', ?)",
          ).run(
            projectId,
            task.assignee_id,
            `작업 실패 → blocked: "${(task.title ?? "").slice(0, 80)}" — ${(err.message ?? "").slice(0, 200)}`,
          );
        }
        const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
        broadcast("task:updated", updated ?? { taskId: task.id, status: "blocked", error: err.message });
        log.error(`Scheduler: task "${task.title}" failed`, err);

        if (task.parent_task_id) {
          delegationEngine.checkParentCompletion(task.parent_task_id);
        }
      }
    } finally {
      // failover 재디스패치가 새 세션을 만들었으면 redispatched_session_id를 backfill (no-op if none pending)
      if (backfillRedispatchSession(task.id)) {
        broadcastTaskSnapshot(task.id);
      }
      releaseExecutionOwnership(task.id);
      // Trigger next poll to fill the freed slot — cancel existing timer to avoid double-poll
      if (timers.has(projectId) && !getPauseState(projectId).paused) {
        const existing = timers.get(projectId);
        if (existing) clearTimeout(existing);
        timers.set(projectId, setTimeout(() => poll(projectId), 100)); // near-immediate
      }
    }
  }

  async function poll(projectId: string): Promise<void> {
    if (!timers.has(projectId)) return;

    sweepPendingRedispatchBackfills(projectId);

    const state = getPauseState(projectId);
    if (state.paused) {
      // paused 상태에서는 poll 재등록하지 않음 — resumeTimer 만료 시 자동 재개
      return;
    }

    if (enforceDailyBudget(projectId)) return;

    // Preparation has its own lookahead slot and must continue even when all
    // execution slots are occupied. The project-level preparation flight
    // makes this safe when this poll overlaps notifications or callbacks.
    triggerGoalProcessingIfNeeded(projectId);

    const busy = getBusyAgents(projectId);
    const occupiedGoalIds = getOccupiedGoalIds(projectId);
    const retryReservedGoalIds = getRetryReservedGoalIds(projectId);
    const occupiedOrReservedGoalIds = new Set([...occupiedGoalIds, ...retryReservedGoalIds]);
    const concurrency = getEffectiveConcurrency(projectId);
    const maxContinuationSlots = Math.max(0, concurrency - occupiedGoalIds.size);
    const maxNewGoalSlots = Math.max(0, concurrency - occupiedOrReservedGoalIds.size);
    const tasks = pickNextTasks(projectId, maxContinuationSlots, maxNewGoalSlots);

    // Surface stuck state: if we keep polling with nothing executable but
    // there IS outstanding work, the user needs to know why. Only count
    // as "stuck" when NOTHING is running — when busy.size > 0, empty picks
    // are normal (remaining tasks may need the same agent or be gated on
    // the currently running one).
    if (busy.size === 0) {
      checkStuckState(projectId, tasks.length);
    } else {
      stuckState.delete(projectId);
    }

    if (tasks.length === 0) {
      // Check if queue should auto-stop
      if (busy.size === 0 && !goalPreparationFlights.has(projectId) && shouldAutoStop(projectId)) {
        log.info(`Queue auto-stopped for project ${projectId} — no remaining work`);
        stopQueueInternal(projectId);
        broadcast("queue:stopped", { projectId, reason: "completed" });

        // Full autopilot: generate new goals when all work is done
        const project = db.prepare("SELECT autopilot, mission FROM projects WHERE id = ?").get(projectId) as { autopilot: string; mission: string } | undefined;
        if (project?.autopilot === "full" && project.mission?.trim()) {
          // Prevent duplicate triggers
          if (fullAutopilotLock.has(projectId)) {
            log.info(`Full autopilot: already running for ${projectId}, skipping`);
            return;
          }

          const activeGoals = db.prepare(
            "SELECT COUNT(*) as count FROM goals g WHERE g.project_id = ? AND (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status NOT IN ('done','blocked','skipped')) > 0",
          ).get(projectId) as { count: number };

          if (activeGoals.count === 0) {
            fullAutopilotLock.add(projectId);
            log.info(`Full autopilot: all goals complete for project ${projectId}, generating new goals`);

            // Generate goals only — spec/decompose handled by processNextGoal (sequential pipeline)
            (async () => {
              try {
                const { goalIds } = await engine.generateGoalsFromMission(projectId);
                fullAutopilotLock.delete(projectId);

                if (goalIds.length === 0) {
                  log.info("Full autopilot: no more goals to generate, notifying user");
                  db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot', ?)").run(
                    projectId, "모든 목표가 완료되었습니다. 새로운 목표를 생성하지 못했습니다 — 미션을 업데이트하거나 직접 목표를 추가해주세요."
                  );
                  broadcast("project:updated", { projectId });
                  broadcast("autopilot:idle", { projectId, reason: "no_new_goals" });
                  return;
                }

                broadcast("project:updated", { projectId });

                // Restart queue — shouldAutoStop will find unprocessed goals
                // and processNextGoal will handle them one by one in priority order.
                // (busyAgents 보존 + 사용자 명시 정지 존중 — 다른 재시작 지점과 동일 계약)
                if (!timers.has(projectId) && !userStoppedQueues.has(projectId)) {
                  if (!busyAgents.has(projectId)) busyAgents.set(projectId, new Set());
                  pauseState.delete(projectId);
                  timers.set(projectId, setTimeout(() => poll(projectId), 0));
                  log.info(`Full autopilot: restarted queue with ${goalIds.length} new goals`);
                }
              } catch (err: any) {
                fullAutopilotLock.delete(projectId);
                log.error(`Full autopilot: goal generation failed for ${projectId}`, err);
                db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_error', ?)").run(
                  projectId, `자동 목표 생성에 실패했습니다: ${err.message?.slice(0, 200)}`
                );
                broadcast("project:updated", { projectId });
                broadcast("autopilot:idle", { projectId, reason: "generation_failed" });
              }
            })();
          }
        }

        return;
      }
      scheduleNextPoll(projectId);
      return;
    }

    // execution_mode='pty' 프로젝트의 태스크 실행은 터미널 자동 전진 드라이버가 소유한다.
    // 헤드리스 dispatch 와 겹치면 같은 태스크가 두 경로에서 두 번 실행된다.
    // (goal spec/decompose 는 위에서 이미 처리됐으므로 그대로 유지되고, 실행만 넘긴다.)
    //
    // 단, 드라이버가 굴러갈 PTY 레인(활성 터미널 + goal 이 걸린 workspace)이 없으면 넘기지
    // 않고 헤드리스로 실행한다. 넘기기만 하면 아무도 태스크를 밀지 않아 프로젝트가 통째로
    // 멈춘다 — pty 를 켜두고 워크스페이스를 닫아둔 상태가 정확히 그 경우다.
    const executionMode = db.prepare("SELECT execution_mode FROM projects WHERE id = ?")
      .get(projectId) as { execution_mode?: string } | undefined;
    if (executionMode?.execution_mode === "pty") {
      const lane = db.prepare(`
        SELECT COUNT(*) AS n
          FROM terminal_sessions ts
          JOIN workspaces w ON w.id = ts.workspace_id
         WHERE ts.project_id = ? AND ts.status = 'active' AND w.active_goal_id IS NOT NULL
      `).get(projectId) as { n: number };
      if (lane.n > 0) {
        scheduleNextPoll(projectId);
        return;
      }
      log.debug(`pty mode without an active terminal lane — falling back to headless dispatch (${projectId})`);
    }

    // Launch all picked tasks in parallel (fire-and-forget, each manages its own lifecycle)
    for (const task of tasks) {
      // Reserve the goal lane before any asynchronous setup/spawn work. This
      // makes overlapping polls and manual execution contend on the same DB
      // claim instead of relying on the in-memory busy-agent snapshot.
      const claim = claimTaskForExecution(db, task.id);
      if (!claim.claimed) {
        log.debug(`Scheduler: claim rejected for task ${task.id}: ${claim.error}`);
        continue;
      }
      const pendingFailover = getPendingFailover(task.id);
      if (pendingFailover) {
        sessionManager.setProviderOverride(pendingFailover.sessionKey, pendingFailover.toProvider);
      }
      executeOne(projectId, task, claim); // intentionally not awaited
      scheduleRedispatchBackfill(task.id);
    }

    // Schedule next poll to check for more tasks
    scheduleNextPoll(projectId);
  }

  return {
    startQueue(projectId: string): void {
      userStoppedQueues.delete(projectId); // 사용자 재개 — 정지 마킹 해제
      db.prepare("UPDATE projects SET queue_stopped = 0 WHERE id = ?").run(projectId);
      if (timers.has(projectId)) {
        log.warn(`Queue already running for project ${projectId}`);
        return;
      }
      log.info(`Starting queue for project ${projectId} (max concurrency: ${getProjectBaseConcurrency(projectId)})`);

      // Auto-approve genuinely-stuck LEGACY plan tasks from previous runs
      // (e.g., rescue decompose completed but server restarted before approval).
      // EXCLUDE escalated (requires_human_approval) tasks and verification/
      // fix-derived pending_approval tasks — they must not bypass the human
      // gate or the Quality Gate. Fresh decomposes are gated by the reviewer
      // at decompose time (plan_review_status='pending' 이후 기록), so this only
      // revives pre-gate legacy tasks (plan_review_status IS NULL).
      const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
      if (project && (project.autopilot === "goal" || project.autopilot === "full")) {
        const approved = db.prepare(`
          UPDATE tasks SET status = 'todo'
          WHERE project_id = ? AND status = 'pending_approval'
            AND requires_human_approval = 0
            AND verification_id IS NULL
            AND recovery_resume_phase IS NULL
            AND plan_review_status IS NULL
            AND NOT EXISTS (SELECT 1 FROM verifications v WHERE v.task_id = tasks.id)
            AND ${notFixTaskSql("tasks.id")}
        `).run(projectId);
        if (approved.changes > 0) {
          log.info(`startQueue: auto-approved ${approved.changes} stuck legacy pending_approval task(s) for project ${projectId}`);
          broadcast("project:updated", { projectId });
        }
      }

      // busyAgents 보존 — 정지 후 drain 중(in-flight 잔존) 재시작 시 빈 Set으로
      // 리셋하면 이중 스폰 → 기존 세션 SIGTERM 살해 (processNextGoal 꼬리와 동일 함정)
      if (!busyAgents.has(projectId)) busyAgents.set(projectId, new Set());
      pauseState.delete(projectId);
      sweepPendingRedispatchBackfills(projectId);
      timers.set(projectId, setTimeout(() => poll(projectId), 0));
    },

    stopQueue(projectId: string, persistUserIntent = true): void {
      // 명시적 사용자 정지 — in-flight decompose가 끝나도 재시작하지 않도록 마킹
      userStoppedQueues.add(projectId);
      if (persistUserIntent) {
        db.prepare("UPDATE projects SET queue_stopped = 1 WHERE id = ?").run(projectId);
      }
      stopQueueInternal(projectId);
      log.info(`Stopped queue for project ${projectId} (user stop — auto-restart suppressed)`);
    },

    isRunning(projectId: string): boolean {
      return timers.has(projectId);
    },

    isPaused(projectId: string): boolean {
      return getPauseState(projectId).paused;
    },

    enforceDailyBudget,

    resumeQueue(projectId: string): void {
      userStoppedQueues.delete(projectId); // 사용자 재개 — 정지 마킹 해제
      db.prepare("UPDATE projects SET queue_stopped = 0 WHERE id = ?").run(projectId);
      const state = getPauseState(projectId);
      if (!state.paused) return;

      if (state.resumeTimer) clearTimeout(state.resumeTimer);
      state.paused = false;
      state.consecutiveRateLimits = 0;
      state.nextRetryAt = null;

      log.info(`Queue manually resumed for project ${projectId}`);
      broadcast("queue:resumed", { projectId });

      // If timers were cleared while paused (e.g. after a stopQueue), schedule a
      // fresh poll so the queue actually resumes work.
      if (!timers.has(projectId)) {
        timers.set(projectId, setTimeout(() => poll(projectId), 0));
      } else {
        poll(projectId);
      }
    },

    getQueueState(projectId: string): QueueState {
      const state = getPauseState(projectId);
      return {
        running: timers.has(projectId),
        paused: state.paused,
        activeTasks: getBusyAgents(projectId).size,
        maxConcurrency: getEffectiveConcurrency(projectId),
        rateLimitRetries: state.consecutiveRateLimits,
        nextRetryAt: state.nextRetryAt?.toISOString() ?? null,
      };
    },

    setSpecGenerator(fn: (goalId: string) => Promise<any>): void {
      generateGoalSpec = fn;
    },

    /**
     * Notify the scheduler that a new goal was added (or a spec completed).
     * The scheduler decides whether to process it now or queue it behind
     * the currently active goal — guaranteeing sequential, priority-ordered
     * spec→decompose→execute pipeline.
     */
    notifyGoalReady(projectId: string): void {
      triggerGoalProcessingIfNeeded(projectId);
    },

    /**
     * Release all in-flight scheduler ownership for a just-deleted goal so it
     * cannot keep the project "busy" or re-dispatch its tasks after the DELETE.
     */
    cancelGoal(projectId: string, goalId: string, taskIds: string[]): void {
      // Spec/decompose lookahead slot — only clear if THIS goal holds it, so we
      // never yank a flight another goal already claimed.
      if (goalPreparationFlights.get(projectId) === goalId) {
        goalPreparationFlights.delete(projectId);
      }
      // Decompose retry backoff for this goal. The retry setTimeout itself already
      // guards on goal existence, so we only drop the accumulated count here.
      decomposRetryCount.delete(`decompose-retry-${goalId}`);
      // Per-task failover/backfill state (tasks are CASCADE-deleted with the goal).
      // A live backfill timer would otherwise re-dispatch a vanished task.
      for (const taskId of taskIds) {
        releaseExecutionOwnership(taskId);
        const timer = pendingBackfillTimers.get(taskId);
        if (timer) {
          clearTimeout(timer);
          pendingBackfillTimers.delete(taskId);
        }
        pendingFailoverByTask.delete(taskId);
        triedProvidersByTask.delete(taskId);
      }
      log.info(`cancelGoal: released in-flight ownership for goal ${goalId} (${taskIds.length} task(s))`);
    },

    /**
     * Clear all assignees on non-terminal tasks, then re-run role-aware
     * auto-assignment. Returns the number of tasks reassigned.
     */
    reassignAll(projectId: string): number {
      // Clear assignees on active tasks (not done/blocked-exhausted)
      const cleared = db.prepare(
        "UPDATE tasks SET assignee_id = NULL, updated_at = datetime('now') WHERE project_id = ? AND status IN ('todo', 'pending_approval')"
      ).run(projectId);
      log.info(`reassignAll: cleared ${cleared.changes} task assignees for project ${projectId}`);

      // Re-run auto-assignment with current agent roster
      autoAssignUnassigned(projectId);

      const assigned = db.prepare(
        "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND status IN ('todo', 'pending_approval') AND assignee_id IS NOT NULL"
      ).get(projectId) as { cnt: number };

      broadcast("project:updated", { projectId });
      return assigned.cnt;
    },
  };
}
