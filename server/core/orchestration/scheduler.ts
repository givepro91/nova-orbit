import type { Database } from "better-sqlite3";
import type { SessionManager } from "../agent/session.js";
import { createOrchestrationEngine } from "./engine.js";
import { createDelegationEngine } from "./delegation.js";
import { createQualityGate } from "../quality-gate/evaluator.js";
import { createLogger } from "../../utils/logger.js";
import { classifyAgentFailure } from "../../utils/errors.js";
import { getBackend, type AgentProvider } from "../agent/adapters/backend.js";
import { loadProviderConfig } from "../agent/provider.js";
import { decideFailover, type FailureClass } from "../agent/failover.js";
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
  stopQueue: (projectId: string) => void;
  isRunning: (projectId: string) => boolean;
  isPaused: (projectId: string) => boolean;
  resumeQueue: (projectId: string) => void;
  getQueueState: (projectId: string) => QueueState;
  /** Notify that a goal was added or its spec completed — scheduler decides processing order. */
  notifyGoalReady: (projectId: string) => void;
  /** Clear all task assignees and re-run auto-assignment. Returns count of assigned tasks. */
  reassignAll: (projectId: string) => number;
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
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.goal_id = g.id AND t.status IN ('in_progress', 'in_review')
          AND NOT EXISTS (
            SELECT 1 FROM tasks s
            WHERE s.parent_task_id = t.id
              AND s.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
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
  `).all(projectId, maxGoals) as { id: string }[];
  return rows.map((r) => r.id);
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

  function getEffectiveConcurrency(projectId: string): number {
    return effectiveConcurrency.get(projectId) ?? DEFAULT_MAX_CONCURRENCY;
  }
  /**
   * Prevent duplicate pipeline work. Two disjoint key namespaces share this
   * Set intentionally:
   * - `${projectId}`       → mission → goals generation (full autopilot)
   * - `process-${projectId}` → sequential goal processing (processNextGoal)
   * They gate different operations, so using one Set with prefixed keys keeps
   * them independent without extra state.
   */
  const fullAutopilotLock = new Set<string>();
  const decomposRetryCount = new Map<string, number>();

  // 사용자가 명시적으로 정지한 큐 (stopQueue API). 자동 완료 정지(stopQueueInternal)와
  // 구분한다 — in-flight decompose 완료(processNextGoal 꼬리)가 정지된 큐를 침묵
  // 재시작하던 버그의 가드. startQueue/resumeQueue(사용자 재개)가 해제한다.
  const userStoppedQueues = new Set<string>();

  // projectId → set of currently busy agent IDs
  const busyAgents = new Map<string, Set<string>>();
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
          WHERE s.goal_id = t.goal_id AND s.id != t.id AND s.status != 'done'
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

  /**
   * Fix dangling assignee_ids — tasks assigned to agents that no longer exist.
   * Clears assignee so autoAssignUnassigned can reassign them.
   */
  function fixDanglingAssignees(projectId: string): void {
    const fixed = db.prepare(`
      UPDATE tasks SET assignee_id = NULL
      WHERE project_id = ? AND assignee_id IS NOT NULL
        AND status != 'done'
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
          AND updated_at <= datetime('now', '-${levelCooldown} seconds')
      `).run(projectId, level);
      totalRetried += retried.changes;
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
      db.prepare(`
        UPDATE tasks SET status = 'todo', assignee_id = ?, retry_count = 0,
          reassign_count = reassign_count + 1, updated_at = datetime('now')
        WHERE id = ? AND status = 'blocked'
      `).run(altAgent.id, t.id);

      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_reassigned', ?)",
      ).run(projectId, `Escalated "${t.title}" to different agent (retry exhausted)`);
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
   *   1. Mark it as 'done' with a result_summary explaining it was auto-skipped
   *   2. Log a clear activity entry so the user can review later
   *   3. Update goal progress so the next goal can start
   *
   * This runs on every scheduler poll — idempotent (only targets blocked tasks
   * that haven't been resolved yet).
   */
  function autoResolvePermanentlyBlocked(projectId: string): void {
    const stuck = db.prepare(`
      SELECT t.id, t.title, t.goal_id FROM tasks t
      WHERE t.project_id = ? AND t.status = 'blocked'
        AND t.retry_count >= ? AND t.reassign_count >= ?
    `).all(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { id: string; title: string; goal_id: string }[];

    if (stuck.length === 0) return;

    for (const t of stuck) {
      db.prepare(
        "UPDATE tasks SET status = 'done', result_summary = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(`[자동 건너뜀] 재시도 한도 초과 — 수동 확인 권장`, t.id);

      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_auto_resolved', ?)",
      ).run(projectId, `자동 건너뜀: "${t.title}" — 재시도 ${MAX_TASK_RETRIES}회 + 재할당 ${MAX_REASSIGNS}회 소진`);

      log.info(`Auto-resolved permanently blocked task "${t.title}" (${t.id}) → done (skipped)`);
    }

    // Recalculate goal progress now that blocked → done
    const goalIds = [...new Set(stuck.map((t) => t.goal_id))];
    for (const goalId of goalIds) {
      const stats = db.prepare(`
        SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
        FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
      `).get(goalId) as { total: number; done: number };
      const progress = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 100;
      db.prepare("UPDATE goals SET progress = ? WHERE id = ?").run(progress, goalId);
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
      "SELECT DISTINCT goal_id FROM tasks WHERE project_id = ? AND status = 'blocked' AND retry_count >= ? AND reassign_count >= ?",
    ).all(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { goal_id: string }[];

    for (const { goal_id } of goals) {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
          SUM(CASE WHEN status = 'blocked' AND retry_count >= ? AND reassign_count >= ? THEN 1 ELSE 0 END) as permanently_blocked
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
   * Pick next executable tasks — sequential goal processing.
   *
   * Goal-level sequencing: only ONE goal is active at a time within a project.
   *   1) If any goal already has in_progress/in_review tasks → that goal stays active
   *   2) Otherwise → highest-priority goal with todo tasks becomes active
   *   3) Tasks within the active goal can still run in parallel (up to maxSlots)
   *
   * This prevents the previous behavior where multiple goals' tasks would
   * interleave by global priority, making it hard to finish anything.
   */
  function pickNextTasks(projectId: string, maxSlots: number): any[] {
    if (maxSlots <= 0) return [];

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
      SELECT id, assignee_id, status, retry_count, reassign_count FROM tasks t
      WHERE project_id = ?
        AND status IN ('in_progress', 'in_review')
        AND (strftime('%s', 'now') - strftime('%s', updated_at)) > ?
        AND NOT EXISTS (
          SELECT 1 FROM tasks s
          WHERE s.parent_task_id = t.id
            AND s.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
        )
    `).all(projectId, STALE_THRESHOLD_SECONDS) as { id: string; assignee_id: string | null; status: string; retry_count: number; reassign_count: number }[];
    for (const ghost of staleCandidates) {
      if (ghost.assignee_id && busy.has(ghost.assignee_id)) continue; // really running

      // Respect retry/reassign limits — don't revive permanently exhausted tasks
      if (ghost.retry_count >= MAX_TASK_RETRIES && ghost.reassign_count >= MAX_REASSIGNS) {
        db.prepare("UPDATE tasks SET status = 'blocked', updated_at = datetime('now') WHERE id = ?").run(ghost.id);
        log.warn(`Stale ${ghost.status} task ${ghost.id} → blocked (retry/reassign exhausted, not revivable)`);
        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_skipped', ?)"
        ).run(projectId, `중단된 작업 영구 차단됨 (재시도 한도 초과)`);
        broadcast("project:updated", { projectId });
        continue;
      }

      db.prepare("UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE id = ?").run(ghost.id);
      log.warn(`Stale ${ghost.status} task ${ghost.id} reset to todo (no live runtime, idle > ${STALE_THRESHOLD_SECONDS}s)`);
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)"
      ).run(projectId, `중단된 작업 자동 복구: 진행 상태 → todo`);
      broadcast("project:updated", { projectId });
    }

    // Step 1: goal 간 병렬 — 이번 라운드에 태스크를 뽑을 goal 들을 고른다.
    // in-flight 태스크가 있는 goal 은 "goal 내부 순차 1" 원칙상 이미 슬롯을
    // 점유 중이라 제외되고, 남은 goal 중 ready 태스크가 있는 것을 우선순위
    // 순으로 최대 maxSlots 개. goal 간에는 worktree 격리로 병렬이 안전하다.
    const activeGoalIds = pickParallelGoals(db, projectId, maxSlots);
    if (activeGoalIds.length === 0) return [];

    // Reviewer/QA tasks should wait until all other tasks in the same goal are done
    const reviewerAgentIds = new Set(
      (db.prepare(
        "SELECT id FROM agents WHERE project_id = ? AND role IN ('qa-reviewer', 'reviewer', 'qa')"
      ).all(projectId) as { id: string }[]).map((a) => a.id)
    );

    const picked: any[] = [];
    const usedAgents = new Set(busy);

    // Step 2: goal 마다 실행 가능한 첫 태스크 1개만 뽑는다 (goal 내부 순차 1)
    for (const activeGoalId of activeGoalIds) {
      if (picked.length >= maxSlots) break;

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
            WHERE goal_id = ? AND id != ? AND status != 'done'
              AND depends_on LIKE '%' || ? || '%'
          `).get(task.goal_id, task.id, task.id) as { cnt: number };

          if (dependents.cnt === 0) {
            const siblings = db.prepare(`
              SELECT COUNT(*) as remaining FROM tasks
              WHERE goal_id = ? AND id != ?
                AND status != 'done'
                AND NOT (status = 'blocked' AND retry_count >= ? AND reassign_count >= ?)
                AND assignee_id NOT IN (SELECT id FROM agents WHERE project_id = ? AND role IN ('qa-reviewer', 'reviewer', 'qa'))
            `).get(task.goal_id, task.id, MAX_TASK_RETRIES, MAX_REASSIGNS, projectId) as { remaining: number };

            if (siblings.remaining > 0) {
              logDeferOnce(task.id, task.title, siblings.remaining);
              continue;
            }
          }
        }

        // Gate: DAG dependency check — all depends_on task IDs must be 'done'
        // Permanently-blocked tasks (retry+reassign exhausted) are treated as done
        // to prevent goals from being blocked forever by unresolvable tasks.
        const rawDeps: string[] = (() => {
          try {
            const parsed = JSON.parse(task.depends_on ?? "[]");
            return Array.isArray(parsed) ? parsed.filter((d: unknown): d is string => typeof d === "string") : [];
          } catch {
            return [];
          }
        })();

        if (rawDeps.length > 0) {
          const pendingDeps = rawDeps.filter((depId) => {
            const dep = db.prepare(
              "SELECT status, retry_count, reassign_count FROM tasks WHERE id = ?"
            ).get(depId) as { status: string; retry_count: number; reassign_count: number } | undefined;
            if (!dep) return false; // 존재하지 않는 ID는 무시 (안전하게)
            if (dep.status === "done") return false;
            // permanently blocked → done과 동일 취급
            if (dep.retry_count >= MAX_TASK_RETRIES && dep.reassign_count >= MAX_REASSIGNS) return false;
            return true; // 아직 미완료
          });

          if (pendingDeps.length > 0) {
            log.debug(`Task "${task.title}" deferred: ${pendingDeps.length} dependencies not yet done`);
            continue;
          }
        }

        picked.push(task);
        usedAgents.add(task.assignee_id);
        break; // goal 내부 순차 1 — 이 goal 은 이번 라운드 종료
      }
    }
    return picked;
  }

  /**
   * Non-blocking: check for unprocessed goals and process them in background.
   * Does NOT stop the queue — current todo tasks keep running.
   */
  function triggerGoalProcessingIfNeeded(projectId: string): void {
    const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
    if (!project || (project.autopilot !== "goal" && project.autopilot !== "full")) return;

    // Pipeline lookahead: "실행 중인 goal 수 < 동시성 + 1" 일 때만 다음 goal 의
    // spec/decompose 를 미리 돌린다. 예전에는 모든 작업이 끝나야 다음 goal 을
    // 분할해서 goal 전환마다 spec+decompose 시간만큼 큐가 놀았고, 반대로 전부
    // 미리 분할하면 앞 goal 결과에 따라 범위가 바뀔 goal 에 토큰을 낭비한다 —
    // 실행 슬롯 + 선행(lookahead) 1개가 그 절충.
    //
    // "실행 중" 판정은 기존 2-layer check 유지:
    // 1. non-terminal 태스크(in_progress, in_review, todo, pending_approval)가 있거나
    // 2. progress < 100 이면서 재시도 여지가 있는 blocked 태스크가 있는 goal
    // (모두 blocked/done 인 순간의 progress 재계산 지연을 흡수해, 아직 일이 남은
    //  goal 을 완료로 오판해 다음 goal 이 끼어드는 것을 막는다.)
    const activeGoalCount = (db.prepare(`
      SELECT COUNT(*) AS cnt FROM goals g
      WHERE g.project_id = ?
        AND g.progress < 100
        AND (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id) > 0
        AND (
          (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status NOT IN ('done', 'blocked')) > 0
          OR (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status = 'blocked'
              AND (t.retry_count < ? OR t.reassign_count < ?)) > 0
        )
    `).get(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { cnt: number }).cnt;

    if (activeGoalCount >= getEffectiveConcurrency(projectId) + 1) return; // 실행분 + 선행 1개까지 준비 완료

    const nextGoal = db.prepare(`
      SELECT g.id FROM goals g
      WHERE g.project_id = ?
        AND (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id) = 0
      ORDER BY
        CASE g.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        g.sort_order ASC,
        g.created_at ASC
      LIMIT 1
    `).get(projectId) as { id: string } | undefined;

    if (nextGoal) {
      processNextGoal(projectId, nextGoal.id);
    }
  }

  /**
   * Check if the queue should auto-stop:
   * No todo, in_progress, in_review, pending_approval, or retryable blocked tasks remain.
   */
  function shouldAutoStop(projectId: string): boolean {
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
        AND NOT (retry_count >= ? AND reassign_count >= ?)
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
    if (fullAutopilotLock.has(`process-${projectId}`)) return;
    fullAutopilotLock.add(`process-${projectId}`);

    const ctoAgent = db.prepare(
      "SELECT id FROM agents WHERE project_id = ? AND role = 'cto' LIMIT 1"
    ).get(projectId) as { id: string } | undefined;

    const setActivity = (activity: string) => {
      if (ctoAgent) {
        db.prepare("UPDATE agents SET status = 'working', current_activity = ? WHERE id = ?").run(activity, ctoAgent.id);
        broadcast("agent:status", { id: ctoAgent.id, status: "working", activity });
      }
    };
    const clearActivity = () => {
      if (ctoAgent) {
        db.prepare("UPDATE agents SET status = 'idle', current_activity = NULL WHERE id = ?").run(ctoAgent.id);
        broadcast("agent:status", { id: ctoAgent.id, status: "idle" });
      }
    };

    const goalRow = db.prepare("SELECT id, title FROM goals WHERE id = ?").get(goalId) as { id: string; title: string } | undefined;
    if (!goalRow) { fullAutopilotLock.delete(`process-${projectId}`); return; }
    const goalTitle = goalRow.title || goalId;

    const spec = db.prepare("SELECT prd_summary FROM goal_specs WHERE goal_id = ?").get(goalId) as { prd_summary: string } | undefined;
    const prd = spec?.prd_summary;
    const isGenerating = prd && prd.includes('"_status":"generating"');
    const hasSpec = prd && !isGenerating && !prd.includes('"_status":"failed"');

    if (isGenerating) {
      fullAutopilotLock.delete(`process-${projectId}`);
      scheduleNextPoll(projectId);
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
        }

        // Step 2: Decompose (skip if tasks already exist — decomposeGoal guards this too)
        const existingTasks = (db.prepare(
          "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ?"
        ).get(goalId) as { count: number }).count;
        if (existingTasks === 0) {
          setActivity(`decompose:${goalTitle.slice(0, 60)}`);
          db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot', ?)").run(
            projectId, `태스크 분할 중: "${goalTitle.slice(0, 60)}"`
          );
          broadcast("project:updated", { projectId });
          await engine.decomposeGoal(goalId);

          // Step 3: Auto-approve (only after successful decompose — never for pre-existing tasks)
          const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
          if (project && (project.autopilot === "goal" || project.autopilot === "full")) {
            db.prepare("UPDATE tasks SET status = 'todo' WHERE goal_id = ? AND status = 'pending_approval'").run(goalId);
          }
          broadcast("project:updated", { projectId });
        } else {
          log.info(`processNextGoal: goal ${goalId} already has ${existingTasks} task(s), skipping decompose`);
        }

        // Resume queue — will pick up new tasks for THIS goal only.
        // 단, 사용자가 명시적으로 정지한 큐는 되살리지 않는다. lookahead 덕에
        // decompose가 태스크 실행과 겹치면서, 정지 버튼 이후 완료된 decompose가
        // 이 코드로 큐를 침묵 재시작하던 실측 버그 (07-08, stop-queue 무시).
        if (!timers.has(projectId) && !userStoppedQueues.has(projectId)) {
          // busyAgents는 보존 — 빈 Set으로 리셋하면 실행 중인 executeOne이 보이지
          // 않게 되어, 같은 에이전트에 이중 스폰 → 기존 세션 SIGTERM(exit 143) 살해
          // → 무고한 태스크 재시도 소모 (07-08 실측: 세이브 v12가 전투 이벤트 스폰에 살해됨).
          if (!busyAgents.has(projectId)) busyAgents.set(projectId, new Set());
          pauseState.delete(projectId);
          timers.set(projectId, setTimeout(() => poll(projectId), 0));
        }
      } catch (err: any) {
        log.error(`Failed to process goal ${goalId}`, err);
        db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_error', ?)").run(
          projectId, `목표 처리 실패 "${goalTitle.slice(0, 40)}": ${err.message?.slice(0, 150)}`
        );
        broadcast("project:updated", { projectId });

        // Auto-retry decompose failures (rate limit, truncated JSON, etc.)
        // Max 2 retries with 60s backoff. Only retry if no tasks were created
        // (partial creation is handled by the fallback auto-approve path).
        const retryKey = `decompose-retry-${goalId}`;
        const retryCount = (decomposRetryCount.get(retryKey) ?? 0) + 1;
        decomposRetryCount.set(retryKey, retryCount);
        const existingAfterError = (db.prepare(
          "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ?"
        ).get(goalId) as { count: number }).count;

        if (retryCount <= 2 && existingAfterError === 0) {
          const retryDelayMs = 60_000 * retryCount; // 60s, 120s
          log.info(`Decompose retry ${retryCount}/2 for goal "${goalTitle}" in ${retryDelayMs / 1000}s`);
          db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot', ?)").run(
            projectId, `작업 분할 재시도 ${retryCount}/2 — ${retryDelayMs / 1000}초 후 자동 재시도`
          );
          broadcast("project:updated", { projectId });
          setTimeout(() => {
            decomposRetryCount.delete(retryKey);
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
        fullAutopilotLock.delete(`process-${projectId}`);
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
        effectiveConcurrency.set(projectId, DEFAULT_MAX_CONCURRENCY);
        if (prevConcurrency !== DEFAULT_MAX_CONCURRENCY) {
          log.info(`AIMD: concurrency ${prevConcurrency} → ${DEFAULT_MAX_CONCURRENCY} for ${projectId} (cooldown reset)`);
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

  /** Execute a single task, handling completion and delegation. */
  async function executeOne(projectId: string, task: any): Promise<void> {
    const busy = getBusyAgents(projectId);
    busy.add(task.assignee_id);
    const state = getPauseState(projectId);

    log.info(`Scheduler: executing "${task.title}" via agent ${task.assignee_id}`);

    try {
      const result = await engine.executeTask(task.id);
      broadcast("task:updated", { taskId: task.id, ...result });

      // Success — reset rate limit counter
      state.consecutiveRateLimits = 0;

      // Success — failover override/이력 정리 (다음 실행은 정상 해석)
      sessionManager.clearProviderOverride(task.assignee_id);
      triedProvidersByTask.delete(task.id);

      // AIMD: Additive Increase — restore concurrency by 1 on consecutive success
      const prevConcurrency = getEffectiveConcurrency(projectId);
      if (prevConcurrency < DEFAULT_MAX_CONCURRENCY) {
        const newConcurrency = Math.min(DEFAULT_MAX_CONCURRENCY, prevConcurrency + 1);
        effectiveConcurrency.set(projectId, newConcurrency);
        log.info(`AIMD: concurrency ${prevConcurrency} → ${newConcurrency} for ${projectId} (success, additive increase)`);
      }

      if (task.parent_task_id) {
        delegationEngine.checkParentCompletion(task.parent_task_id);
      }
    } catch (err: any) {
      // Duplicate execution — another caller owns this task, nothing to do
      if (err.message?.includes("skipping duplicate execution")) {
        busy.delete(task.assignee_id);
        return;
      }

      // 책임 소재 분류는 errors.ts의 classifyAgentFailure 단일 정본 사용 —
      // engine의 태스크 상태 전이와 판단이 갈리면 전역 오류가 태스크 재시도
      // 예산을 태운다 (세션 소진 실측, 07-08).
      // 방금 실패한 세션이 실제 돈 provider (sessions.provider) — 분류·failover 공용.
      // codex 세션의 "빈 stderr non-zero"를 claude 세션소진으로 오분류하지 않도록 provider를 넘긴다.
      const lastSess = db.prepare(
        "SELECT provider FROM sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1",
      ).get(task.assignee_id) as { provider: string | null } | undefined;
      const currentProvider: AgentProvider = lastSess?.provider === "codex" ? "codex" : "claude";

      const failureClass = classifyAgentFailure(err, { provider: currentProvider });

      // ── Codex/Claude failover — 트리거 실패면 대체 백엔드로 즉시 재디스패치(쿨다운 대신) ──
      if (failureClass === "rate_limit" || failureClass === "session_exhausted" || failureClass === "env_error") {
        const provCfg = loadProviderConfig();
        const tried = triedProvidersByTask.get(task.id) ?? new Set<AgentProvider>();
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
        if (decision.action === "failover") {
          tried.add(decision.toProvider);
          sessionManager.setProviderOverride(task.assignee_id, decision.toProvider);
          // 태스크를 todo로 되돌려 즉시 재픽 (retry 예산 미소모·쿨다운 없음)
          db.prepare(
            "UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE id = ?",
          ).run(task.id);
          broadcast("task:updated", { taskId: task.id, status: "todo" });
          log.warn(`Failover ${currentProvider}→${decision.toProvider} for task "${task.title}" (${failureClass})`);
          busy.delete(task.assignee_id);
          if (timers.has(projectId)) poll(projectId); // 즉시 재폴링 → 대체 백엔드로 실행
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
        if (actual && (actual.status === "todo" || actual.status === "in_progress")) {
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
      busy.delete(task.assignee_id);
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

    const state = getPauseState(projectId);
    if (state.paused) {
      // paused 상태에서는 poll 재등록하지 않음 — resumeTimer 만료 시 자동 재개
      return;
    }

    const busy = getBusyAgents(projectId);
    const availableSlots = getEffectiveConcurrency(projectId) - busy.size;

    if (availableSlots <= 0) {
      // All slots occupied — wait for a task to finish
      scheduleNextPoll(projectId);
      return;
    }

    const tasks = pickNextTasks(projectId, availableSlots);

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
      // No tasks to pick — try to process unhandled goals in background (non-blocking)
      triggerGoalProcessingIfNeeded(projectId);

      // Check if queue should auto-stop
      if (busy.size === 0 && shouldAutoStop(projectId)) {
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
            "SELECT COUNT(*) as count FROM goals g WHERE g.project_id = ? AND (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status NOT IN ('done','blocked')) > 0",
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

    // Launch all picked tasks in parallel (fire-and-forget, each manages its own lifecycle)
    for (const task of tasks) {
      executeOne(projectId, task); // intentionally not awaited
    }

    // Schedule next poll to check for more tasks
    scheduleNextPoll(projectId);
  }

  return {
    startQueue(projectId: string): void {
      userStoppedQueues.delete(projectId); // 사용자 재개 — 정지 마킹 해제
      if (timers.has(projectId)) {
        log.warn(`Queue already running for project ${projectId}`);
        return;
      }
      log.info(`Starting queue for project ${projectId} (max concurrency: ${DEFAULT_MAX_CONCURRENCY})`);

      // Auto-approve any stuck pending_approval tasks from previous runs
      // (e.g., rescue decompose completed but server restarted before approval)
      const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
      if (project && (project.autopilot === "goal" || project.autopilot === "full")) {
        const approved = db.prepare(
          "UPDATE tasks SET status = 'todo' WHERE project_id = ? AND status = 'pending_approval'"
        ).run(projectId);
        if (approved.changes > 0) {
          log.info(`startQueue: auto-approved ${approved.changes} stuck pending_approval task(s) for project ${projectId}`);
          broadcast("project:updated", { projectId });
        }
      }

      // busyAgents 보존 — 정지 후 drain 중(in-flight 잔존) 재시작 시 빈 Set으로
      // 리셋하면 이중 스폰 → 기존 세션 SIGTERM 살해 (processNextGoal 꼬리와 동일 함정)
      if (!busyAgents.has(projectId)) busyAgents.set(projectId, new Set());
      pauseState.delete(projectId);
      timers.set(projectId, setTimeout(() => poll(projectId), 0));
    },

    stopQueue(projectId: string): void {
      // 명시적 사용자 정지 — in-flight decompose가 끝나도 재시작하지 않도록 마킹
      userStoppedQueues.add(projectId);
      stopQueueInternal(projectId);
      log.info(`Stopped queue for project ${projectId} (user stop — auto-restart suppressed)`);
    },

    isRunning(projectId: string): boolean {
      return timers.has(projectId);
    },

    isPaused(projectId: string): boolean {
      return getPauseState(projectId).paused;
    },

    resumeQueue(projectId: string): void {
      userStoppedQueues.delete(projectId); // 사용자 재개 — 정지 마킹 해제
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
