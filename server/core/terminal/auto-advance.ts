import type { Database } from "better-sqlite3";
import type { SessionManager } from "../agent/session.js";
import { shellQuote, type TerminalManager } from "./manager.js";
import { bindTerminalSession, startNextTerminalTask } from "./session-binding.js";
import { prepareTerminalReview, runTerminalReview } from "./review-loop.js";
import { createQualityGate } from "../quality-gate/evaluator.js";
import { TERMINAL_TASK_KICKOFF, providerLaunchFlags } from "../../../shared/terminal-agent.js";
import { promptLanguageRule } from "../../utils/language.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("terminal-auto-advance");

const POLL_INTERVAL_MS = 5_000;

/** 게이트를 다시 돌려야 하는 리뷰 상태 — 재시도 플래그로 재실행한다. */
const RETRYABLE_REVIEW = new Set(["conditional", "error", "timeout"]);
/** 이미 게이트가 돌고 있어 건드리면 안 되는 상태. */
const IN_FLIGHT_REVIEW = new Set(["running"]);
/** goal 을 점유 중인 태스크 상태 — 하나라도 있으면 새 태스크를 착수하지 않는다. */
const GOAL_BUSY = ["in_progress", "in_review"];

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

interface WorkspaceRow {
  workspace_id: string;
  project_id: string;
  goal_id: string;
}

interface TaskRow {
  id: string;
  status: string;
  assignee_id: string | null;
  depends_on: string | null;
  priority: string | null;
  sort_order: number | null;
}

interface ReviewRow {
  id: string;
  status: string;
}

/**
 * 터미널 파이프라인 자동 전진 (execution_mode='pty' 프로젝트 한정).
 *
 * 터미널 실행은 이미 완결된 PTY 파이프라인이다 — 에이전트가 실제 TUI 에서 일하고
 * crewdeck 브리지로 lifecycle 을 스스로 보고하며, prepareTerminalReview 가
 * implementation handoff 를 합성해 Generator-Evaluator 게이트까지 이어진다.
 * 사람이 눌러야 했던 두 지점만 여기서 대신 눌러준다:
 *
 *   1. 태스크가 in_review 로 보고되면 → 리뷰 준비 + Quality Gate 실행
 *   2. goal 이 비면 → 다음 ready 태스크를 "그 담당 에이전트의 터미널"에서 착수
 *
 * 담당자가 바뀌면 그 에이전트 전용 터미널을 새로 띄워 라우팅한다(구현/검증 분리 유지 —
 * 한 터미널은 한 에이전트에만 바인딩된다). goal 내부 동시성은 항상 1이므로, 진행 중
 * 태스크가 있으면 새로 착수하지 않는다.
 */
export function createTerminalAutoAdvance(
  db: Database,
  manager: TerminalManager,
  sessionManager: SessionManager,
  broadcast: (event: string, data: unknown) => void,
) {
  /** workspace(=goal 실행 단위)당 1개 전진만 — 폴이 겹쳐 같은 태스크를 두 번 밀지 않는다. */
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function activeWorkspaces(): WorkspaceRow[] {
    return db.prepare(`
      SELECT DISTINCT ts.workspace_id, ts.project_id, w.active_goal_id AS goal_id
        FROM terminal_sessions ts
        JOIN projects p ON p.id = ts.project_id
        JOIN workspaces w ON w.id = ts.workspace_id
       WHERE ts.status = 'active'
         AND p.execution_mode = 'pty'
         AND w.active_goal_id IS NOT NULL
    `).all() as WorkspaceRow[];
  }

  function latestReview(terminalId: string, taskId: string): ReviewRow | undefined {
    return db.prepare(`
      SELECT id, status FROM terminal_review_requests
       WHERE terminal_session_id = ? AND task_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1
    `).get(terminalId, taskId) as ReviewRow | undefined;
  }

  /** in_review → 리뷰 준비(handoff 합성) + Quality Gate 실행. */
  async function advanceReview(terminalId: string, projectId: string, taskId: string): Promise<void> {
    const existing = latestReview(terminalId, taskId);
    if (existing && IN_FLIGHT_REVIEW.has(existing.status)) return;

    let reviewId = existing?.id;
    let retry = false;
    if (!existing) {
      // 에이전트가 브리지로 남긴 자기보고를 리뷰 근거로 그대로 쓴다 — 드라이버가 지어낸
      // 문구로 덮으면 게이트가 보는 근거가 실제 작업 내용에서 멀어진다.
      const reported = db.prepare("SELECT result_summary FROM tasks WHERE id = ?")
        .get(taskId) as { result_summary: string | null } | undefined;
      const prepared = prepareTerminalReview(db, terminalId, {
        summary: reported?.result_summary?.trim() || "Agent reported implementation complete",
        idempotencyKey: `auto-advance:${taskId}`,
      });
      reviewId = prepared.review.id;
      broadcast("terminal:review", prepared.review);
      broadcast("task:updated", prepared.task);
      log.info(`Auto-advance: prepared review for task ${taskId}`);
    } else if (RETRYABLE_REVIEW.has(existing.status)) {
      retry = true;
    } else if (existing.status !== "pending") {
      return; // passed/failed 등 종료 상태 — 태스크 상태 전이가 처리한다.
    }
    if (!reviewId) return;

    const qualityGate = createQualityGate(db, sessionManager, broadcast);
    const result = await runTerminalReview(
      db,
      terminalId,
      reviewId,
      (verifyTaskId, config) => qualityGate.verify(verifyTaskId, config),
      { retry },
    );
    broadcast("terminal:review", result.review);
    broadcast("task:updated", result.task);
    broadcast("project:updated", { projectId });
    log.info(`Auto-advance: quality gate for task ${taskId} → ${result.review.status}`);
  }

  /** goal 의 다음 ready 태스크 — 서버 우선순위 큐와 같은 순서(priority→sort_order), 의존성 충족. */
  function nextReadyTask(goalId: string): TaskRow | null {
    const tasks = db.prepare(`
      SELECT id, status, assignee_id, depends_on, priority, sort_order
        FROM tasks WHERE goal_id = ?
    `).all(goalId) as TaskRow[];
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const depsDone = (task: TaskRow): boolean => {
      let deps: string[] = [];
      try {
        const parsed = JSON.parse(task.depends_on ?? "[]");
        if (Array.isArray(parsed)) deps = parsed.filter((v): v is string => typeof v === "string");
      } catch { return false; }
      return deps.every((id) => {
        const dep = byId.get(id);
        return !dep || dep.status === "done" || dep.status === "skipped";
      });
    };
    return tasks
      .filter((task) => task.status === "todo" && depsDone(task))
      .sort((a, b) =>
        (PRIORITY_RANK[a.priority ?? "medium"] ?? 2) - (PRIORITY_RANK[b.priority ?? "medium"] ?? 2)
        || (a.sort_order ?? 0) - (b.sort_order ?? 0))[0] ?? null;
  }

  /**
   * 담당 에이전트의 터미널을 확보한다. 그 에이전트에 바인딩된 유휴 터미널이 있으면 재사용하고,
   * 없으면 새로 띄워 바인딩만 해둔 뒤 null 을 돌려준다 — 셸이 준비될 시간을 벌기 위해
   * 착수는 다음 폴 틱으로 미룬다(생성 직후 write 하면 프롬프트가 아직 없을 수 있다).
   */
  function resolveAgentTerminal(ws: WorkspaceRow, agentId: string): string | null {
    // 이 에이전트에 이미 바인딩된 유휴 터미널을 최우선으로, 없으면 아직 에이전트가 안 붙은
    // 유휴 터미널을 입양한다. 입양 경로가 없으면 사용자가 방금 연 빈 터미널을 못 알아보고
    // 매번 새 터미널을 띄우게 된다(실측된 중복 생성 원인).
    const free = db.prepare(`
      SELECT ts.id, ts.agent_id FROM terminal_sessions ts
        LEFT JOIN tasks t ON t.id = ts.active_task_id
       WHERE ts.workspace_id = ? AND ts.status = 'active'
         AND (ts.agent_id = ? OR ts.agent_id IS NULL)
         AND (ts.active_task_id IS NULL OR t.status IN ('done', 'skipped'))
       ORDER BY CASE WHEN ts.agent_id = ? THEN 0 ELSE 1 END, ts.rowid ASC
       LIMIT 1
    `).get(ws.workspace_id, agentId, agentId) as { id: string; agent_id: string | null } | undefined;
    if (free) {
      if (!free.agent_id) {
        bindTerminalSession(db, free.id, { goalId: ws.goal_id, agentId });
        const adopted = manager.get(free.id);
        if (adopted) broadcast("terminal:binding", adopted);
        log.info(`Auto-advance: adopted idle terminal ${free.id} for agent ${agentId}`);
      }
      return free.id;
    }

    const created = manager.create(ws.workspace_id, { cols: 160, rows: 48 });
    bindTerminalSession(db, created.id, { goalId: ws.goal_id, agentId });
    broadcast("workspace:updated", { workspaceId: ws.workspace_id, projectId: ws.project_id });
    broadcast("project:updated", { projectId: ws.project_id });
    log.info(`Auto-advance: spawned terminal ${created.id} for agent ${agentId} (starts next tick)`);
    return null;
  }

  /** goal 이 비었으면 다음 ready 태스크를 담당 에이전트 터미널에서 착수한다. */
  function advanceNextTask(ws: WorkspaceRow): void {
    const busy = db.prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE goal_id = ? AND status IN (${GOAL_BUSY.map(() => "?").join(",")})`,
    ).get(ws.goal_id, ...GOAL_BUSY) as { n: number };
    if (busy.n > 0) return; // goal 내부 동시성 1

    const next = nextReadyTask(ws.goal_id);
    if (!next) return;
    if (!next.assignee_id) {
      log.warn(`Auto-advance: task ${next.id} has no assignee — cannot route to a terminal`);
      return;
    }

    const terminalId = resolveAgentTerminal(ws, next.assignee_id);
    if (!terminalId) return; // 방금 띄운 터미널 — 다음 틱에 착수

    const terminal = manager.get(terminalId);
    if (!terminal || terminal.contextState !== "connected") return; // 컨텍스트 정렬 전엔 착수하지 않는다

    const kickoff = `${TERMINAL_TASK_KICKOFF} ${promptLanguageRule(undefined)}`;
    const result = startNextTerminalTask(
      db,
      terminalId,
      { goalId: ws.goal_id, agentId: next.assignee_id, taskId: next.id },
      (provider) => manager.write(terminalId, `${provider} ${providerLaunchFlags(provider)} ${shellQuote(kickoff)}\r`),
    );
    broadcast("task:updated", result.task);
    const bound = manager.get(terminalId);
    if (bound) broadcast("terminal:binding", bound);
    broadcast("project:updated", { projectId: ws.project_id });
    log.info(`Auto-advance: started task ${next.id} (agent ${next.assignee_id}) in terminal ${terminalId}`);
  }

  async function advanceWorkspace(ws: WorkspaceRow): Promise<void> {
    // 1) 리뷰 대기 중인 태스크부터 처리 — 게이트가 goal 점유를 풀어줘야 다음이 나간다.
    const reviewable = db.prepare(`
      SELECT ts.id AS terminal_id, ts.active_task_id AS task_id
        FROM terminal_sessions ts
        JOIN tasks t ON t.id = ts.active_task_id
       WHERE ts.workspace_id = ? AND ts.status = 'active' AND t.status = 'in_review'
    `).all(ws.workspace_id) as Array<{ terminal_id: string; task_id: string }>;
    for (const row of reviewable) {
      await advanceReview(row.terminal_id, ws.project_id, row.task_id);
    }
    // 2) goal 이 비었으면 다음 태스크를 담당 에이전트에게 라우팅
    advanceNextTask(ws);
  }

  function tick(): void {
    let rows: WorkspaceRow[];
    try {
      rows = activeWorkspaces();
    } catch (error) {
      log.error(`Auto-advance poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const ws of rows) {
      if (inFlight.has(ws.workspace_id)) continue;
      inFlight.add(ws.workspace_id);
      void advanceWorkspace(ws)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          log.warn(`Auto-advance failed for workspace ${ws.workspace_id}: ${message}`);
        })
        .finally(() => inFlight.delete(ws.workspace_id));
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(tick, POLL_INTERVAL_MS);
      log.info(`Terminal auto-advance started (poll ${POLL_INTERVAL_MS}ms, execution_mode='pty' only)`);
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
