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

/**
 * 게이트 자동 재시도 상한. 상한이 없으면 review-loop 의 에러 경로가 태스크를 다시
 * in_review 로 되돌리므로 폴 틱마다 영원히 같은 실패를 반복한다 — 라이브에서 한 리뷰가
 * attempt 923 까지 갔다(수 시간 동안 5초마다). 사람이 명시적으로 누르는 재시도
 * (POST /reviews/:id/verify) 는 이 상한과 무관하다.
 */
const MAX_REVIEW_ATTEMPTS = 3;

/**
 * in_progress 태스크가 바인딩된 터미널이 이만큼 무출력이면 사람에게 넘긴다.
 *
 * PTY 는 headless 어댑터와 달리 타임아웃이 없어, 에이전트 CLI 가 입력 대기에 걸리면
 * 태스크가 무기한 멈춘 채 아무 신호도 남지 않는다(실측: codex 신뢰 온보딩에서 정지).
 * 프로세스는 살아 있으므로 runningAgent() 는 "정상 실행 중"으로 본다 — 무출력만이 신호다.
 * 신뢰 프롬프트는 미리 막아 두지만(codex-trust/claude-trust), 로그인 만료·사용량 한도·
 * CLI 업데이트 안내처럼 막을 수 없는 원인도 같은 방식으로 멈추므로 마지막 방어선이 필요하다.
 * headless 태스크 타임아웃(기본 10분)과 같은 기준을 쓴다.
 */
const PTY_STALL_MS = parseInt(process.env.CREWDECK_PTY_STALL_MS ?? "600000", 10);

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
  attempt: number;
  error_message: string | null;
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
  /** 착수를 막고 있는 사유 — 5초 폴마다 같은 줄을 쌓지 않도록 변할 때만 남긴다. */
  const blockedReason = new Map<string, string>();

  function noteBlocked(taskId: string, reason: string): void {
    if (blockedReason.get(taskId) === reason) return;
    blockedReason.set(taskId, reason);
    log.warn(`Auto-advance: task ${taskId} not started — ${reason}`);
  }

  function clearBlocked(taskId: string): void {
    blockedReason.delete(taskId);
  }

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
      SELECT id, status, attempt, error_message FROM terminal_review_requests
       WHERE terminal_session_id = ? AND task_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1
    `).get(terminalId, taskId) as ReviewRow | undefined;
  }

  /**
   * 자동 재시도를 소진한 리뷰를 사람에게 넘긴다.
   *
   * 게이트가 데이터 상태 때문에 시작조차 못 하는 경우가 있다(실측: handoff 단계가 이미
   * verification 이라 "cannot precede" 로 즉시 실패). 이런 실패는 재시도로 절대 안 풀리는데
   * review-loop 의 에러 경로가 태스크를 in_review 로 되돌려 놓기 때문에 태스크 상태를
   * 밖에서 바꿔도 다음 틱에 원복된다 — 루프를 끊는 유일한 지점이 여기다.
   * blocked 로 세우면 in_review 질의에서 빠져 루프가 멎고, 이 함수도 다시 불리지 않는다.
   */
  function blockExhaustedReview(taskId: string, projectId: string, review: ReviewRow): void {
    const reason = review.error_message?.trim() || `Quality Gate ${review.status}`;
    const task = db.prepare(`
      UPDATE tasks
         SET status = 'blocked', result_summary = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'in_review'
       RETURNING *
    `).get(`Quality Gate 자동 재시도 ${review.attempt}회 실패 — 사람 확인 필요: ${reason}`, taskId) as
      Record<string, unknown> | undefined;
    if (!task) return; // 이미 다른 경로가 상태를 옮겼다 — 중복 처리하지 않는다.
    broadcast("task:updated", task);
    broadcast("project:updated", { projectId });
    log.warn(
      `Auto-advance: giving up on review for task ${taskId} after ${review.attempt} attempts — task blocked: ${reason}`,
    );
  }

  /**
   * 응답이 끊긴 터미널의 태스크를 사람에게 넘긴다.
   *
   * blocked 로 세우면 goal 점유가 풀려 다음 태스크가 나갈 수 있고, 대시보드의 "내 결정 필요"
   * 에 올라와 사용자가 원인을 볼 수 있다. 멈춘 터미널에는 CLI 가 그대로 떠 있으므로
   * advanceNextTask 의 runningAgent() 가드가 같은 터미널로의 재라우팅을 막는다.
   */
  function blockStalledTask(taskId: string, projectId: string, idleMs: number): void {
    const minutes = Math.round(idleMs / 60_000);
    const task = db.prepare(`
      UPDATE tasks
         SET status = 'blocked', result_summary = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'in_progress'
       RETURNING *
    `).get(
      `터미널이 ${minutes}분간 응답 없음 — 사람 확인 필요: 에이전트 CLI 가 입력을 기다리는 중일 수 있습니다`
      + ` (디렉토리 신뢰 확인, 로그인 만료, 사용량 한도, 업데이트 안내 등). 해당 터미널 화면을 확인하세요.`,
      taskId,
    ) as Record<string, unknown> | undefined;
    if (!task) return; // 이미 다른 경로가 상태를 옮겼다 — 중복 처리하지 않는다.
    broadcast("task:updated", task);
    broadcast("project:updated", { projectId });
    log.warn(`Auto-advance: task ${taskId} blocked — terminal produced no output for ${minutes}m`);
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
      if (existing.attempt >= MAX_REVIEW_ATTEMPTS) {
        blockExhaustedReview(taskId, projectId, existing);
        return;
      }
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
  function resolveAgentTerminal(ws: WorkspaceRow, agentId: string, taskId: string): string | null {
    // 고른 태스크를 이미 쥐고 있는 활성 터미널이 있으면 그 터미널에서 착수한다.
    // 유휴 판정은 태스크 기준(done/skipped)인데 nextReadyTask 는 todo 를 고르므로,
    // todo 태스크를 쥔 터미널은 '유휴 아님'이면서 그 태스크는 '다음 착수 대상'이 된다.
    // 그대로 두면 다른 유휴 터미널로 라우팅해 startNextTerminalTask 가
    // "Task is already bound to another terminal" 로 거부하고, 5초마다 같은 실패가
    // 영원히 반복된다(실측: 워크스페이스 하나가 2684회 경고 후에도 전진 못 함).
    const holder = db.prepare(`
      SELECT id, agent_id FROM terminal_sessions
       WHERE workspace_id = ? AND status = 'active' AND active_task_id = ?
       LIMIT 1
    `).get(ws.workspace_id, taskId) as { id: string; agent_id: string | null } | undefined;
    if (holder) {
      // 담당자가 다른 터미널이 쥐고 있으면 어디로 라우팅해도 거부된다 — 조용히 넘긴다.
      // (에러를 던져봐야 폴 틱마다 같은 로그만 쌓인다.)
      return !holder.agent_id || holder.agent_id === agentId ? holder.id : null;
    }

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

    const terminalId = resolveAgentTerminal(ws, next.assignee_id, next.id);
    if (!terminalId) return; // 방금 띄운 터미널 — 다음 틱에 착수

    const terminal = manager.get(terminalId);
    if (!terminal || terminal.contextState !== "connected") {
      // 컨텍스트 정렬 전엔 착수하지 않는다. 정상적으로는 다음 틱에 풀리지만, 런타임이
      // 사라진 터미널이면 영원히 안 풀린다 — 조용히 return 하면 화면에도 로그에도
      // 아무 신호가 없어 "왜 멈췄는지" 를 알 수 없다. 상태가 바뀔 때만 한 줄 남긴다.
      noteBlocked(next.id, `terminal ${terminalId} not connected (contextState=${terminal?.contextState ?? "missing"})`);
      return;
    }

    // foreground 에 이미 에이전트 CLI 가 떠 있으면 셸 명령을 써 넣으면 안 된다. 셸이 아니라
    // 그 TUI 의 입력창에 텍스트가 들어가고, 태스크는 in_progress 로 표시됐는데 실제로는
    // 아무것도 실행되지 않는 상태가 된다(라이브 실측). 이전 턴을 끝낸 CLI 가 대화형으로
    // 남아 있으면 여기 걸린다 — 셸로 돌아올 때까지(=에이전트 종료) 착수를 미룬다.
    if (manager.runningAgent(terminalId)) {
      noteBlocked(next.id, `agent CLI still in foreground on terminal ${terminalId}`);
      return;
    }
    clearBlocked(next.id);

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
    // 2) 응답이 끊긴 채 진행 중인 태스크를 사람에게 넘긴다 — PTY 의 유일한 타임아웃.
    const running = db.prepare(`
      SELECT ts.id AS terminal_id, ts.active_task_id AS task_id
        FROM terminal_sessions ts
        JOIN tasks t ON t.id = ts.active_task_id
       WHERE ts.workspace_id = ? AND ts.status = 'active' AND t.status = 'in_progress'
    `).all(ws.workspace_id) as Array<{ terminal_id: string; task_id: string }>;
    for (const row of running) {
      const idleMs = manager.outputIdleMs(row.terminal_id);
      if (idleMs === null || idleMs < PTY_STALL_MS) continue;
      blockStalledTask(row.task_id, ws.project_id, idleMs);
    }
    // 3) goal 이 비었으면 다음 태스크를 담당 에이전트에게 라우팅
    advanceNextTask(ws);
  }

  function tick(): void {
    // 런타임이 사라진 터미널을 먼저 걷어낸다. 남겨 두면 resolveAgentTerminal 이 그 유령을
    // 계속 재사용 대상으로 골라 착수가 영원히 막힌다(tmux 서버 소실 실측).
    try {
      const reaped = manager.reapOrphanedPersistentTerminals();
      if (reaped.length > 0) {
        log.warn(`Auto-advance: reaped ${reaped.length} orphaned terminal(s) with no live tmux runtime: ${reaped.join(", ")}`);
      }
    } catch (error) {
      log.error(`Auto-advance reap failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
