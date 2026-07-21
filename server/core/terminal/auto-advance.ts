import type { Database } from "better-sqlite3";
import type { SessionManager } from "../agent/session.js";
import { shellQuote, type TerminalManager } from "./manager.js";
import { startNextTerminalTask } from "./session-binding.js";
import { prepareTerminalReview, runTerminalReview } from "./review-loop.js";
import { createQualityGate } from "../quality-gate/evaluator.js";
import { TERMINAL_TASK_KICKOFF } from "../../../shared/terminal-agent.js";
import { promptLanguageRule } from "../../utils/language.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("terminal-auto-advance");

const POLL_INTERVAL_MS = 5_000;

/** 게이트를 다시 돌려야 하는 리뷰 상태 — 재시도 플래그로 재실행한다. */
const RETRYABLE_REVIEW = new Set(["conditional", "error", "timeout"]);
/** 이미 게이트가 돌고 있어 건드리면 안 되는 상태. */
const IN_FLIGHT_REVIEW = new Set(["running"]);

interface Candidate {
  terminal_id: string;
  project_id: string;
  goal_id: string | null;
  agent_id: string | null;
  provider: "claude" | "codex" | null;
  active_task_id: string | null;
  task_status: string | null;
}

interface ReviewRow {
  id: string;
  status: string;
}

/**
 * 터미널 파이프라인 자동 전진 (execution_mode='pty' 프로젝트 한정).
 *
 * 터미널 실행은 이미 완결된 PTY 파이프라인이다 — 에이전트가 실제 TUI에서 일하고
 * crewdeck 브리지로 lifecycle(in_progress→in_review)을 스스로 보고하며,
 * prepareTerminalReview 가 implementation handoff 를 합성해 Generator-Evaluator
 * 게이트까지 이어진다. 유일하게 사람 클릭이 필요했던 두 지점만 여기서 대신 눌러준다:
 *
 *   1. 태스크가 in_review 로 보고되면 → 리뷰 준비 + Quality Gate 실행
 *   2. 게이트를 통과해 done 이 되면 → 같은 터미널(같은 에이전트)의 다음 ready 태스크 착수
 *
 * 다른 에이전트에 배정된 태스크로의 라우팅(터미널 신규 생성)은 하지 않는다 —
 * 터미널은 에이전트 1명에 바인딩되고, 구현/검증 분리를 깨지 않기 위해서다.
 * 그런 태스크는 기존대로 Crewdeck 에서 담당 에이전트 터미널로 착수한다.
 */
export function createTerminalAutoAdvance(
  db: Database,
  manager: TerminalManager,
  sessionManager: SessionManager,
  broadcast: (event: string, data: unknown) => void,
) {
  /** 터미널당 1개 전진만 — 폴이 겹쳐 같은 태스크를 두 번 밀지 않는다. */
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function candidates(): Candidate[] {
    return db.prepare(`
      SELECT ts.id AS terminal_id, ts.project_id, ts.goal_id, ts.agent_id, ts.provider,
             ts.active_task_id, t.status AS task_status
        FROM terminal_sessions ts
        JOIN projects p ON p.id = ts.project_id
        LEFT JOIN tasks t ON t.id = ts.active_task_id
       WHERE ts.status = 'active'
         AND p.execution_mode = 'pty'
    `).all() as Candidate[];
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
  async function advanceReview(row: Candidate): Promise<void> {
    const taskId = row.active_task_id!;
    const existing = latestReview(row.terminal_id, taskId);
    if (existing && IN_FLIGHT_REVIEW.has(existing.status)) return;

    let reviewId = existing?.id;
    let retry = false;
    if (!existing) {
      // 에이전트가 브리지로 남긴 자기보고를 리뷰 근거로 그대로 쓴다 — 드라이버가 지어낸
      // 문구로 덮으면 게이트가 보는 근거가 실제 작업 내용에서 멀어진다.
      const reported = db.prepare("SELECT result_summary FROM tasks WHERE id = ?")
        .get(taskId) as { result_summary: string | null } | undefined;
      const prepared = prepareTerminalReview(db, row.terminal_id, {
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
      // passed/failed 등 종료 상태 — 태스크 상태 전이가 처리한다.
      return;
    }
    if (!reviewId) return;

    const qualityGate = createQualityGate(db, sessionManager, broadcast);
    const result = await runTerminalReview(
      db,
      row.terminal_id,
      reviewId,
      (verifyTaskId, config) => qualityGate.verify(verifyTaskId, config),
      { retry },
    );
    broadcast("terminal:review", result.review);
    broadcast("task:updated", result.task);
    broadcast("project:updated", { projectId: row.project_id });
    log.info(`Auto-advance: quality gate for task ${taskId} → ${result.review.status}`);
  }

  /** done/미바인딩 → 같은 에이전트의 다음 ready 태스크 착수. */
  function advanceNextTask(row: Candidate): void {
    if (!row.goal_id || !row.agent_id) return;
    const kickoff = `${TERMINAL_TASK_KICKOFF} ${promptLanguageRule(undefined)}`;
    const result = startNextTerminalTask(
      db,
      row.terminal_id,
      { goalId: row.goal_id, agentId: row.agent_id, provider: row.provider },
      (provider) => manager.write(row.terminal_id, `${provider} ${shellQuote(kickoff)}\r`),
    );
    broadcast("task:updated", result.task);
    const terminal = manager.get(row.terminal_id);
    if (terminal) broadcast("terminal:binding", terminal);
    broadcast("project:updated", { projectId: row.project_id });
    log.info(`Auto-advance: started next task ${result.task.id} in terminal ${row.terminal_id}`);
  }

  async function tick(): Promise<void> {
    let rows: Candidate[];
    try {
      rows = candidates();
    } catch (error) {
      log.error(`Auto-advance poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const row of rows) {
      if (inFlight.has(row.terminal_id)) continue;
      const needsReview = row.active_task_id !== null && row.task_status === "in_review";
      const needsNext = row.active_task_id === null || row.task_status === "done";
      if (!needsReview && !needsNext) continue;

      inFlight.add(row.terminal_id);
      void (async () => {
        try {
          if (needsReview) await advanceReview(row);
          else advanceNextTask(row);
        } catch (error) {
          // 착수할 ready 태스크가 없는 건 정상 — 조용히 넘어간다.
          const message = error instanceof Error ? error.message : String(error);
          if (!/no ready task|No ready task|ready task/i.test(message)) {
            log.warn(`Auto-advance failed for terminal ${row.terminal_id}: ${message}`);
          }
        } finally {
          inFlight.delete(row.terminal_id);
        }
      })();
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
      log.info(`Terminal auto-advance started (poll ${POLL_INTERVAL_MS}ms, execution_mode='pty' only)`);
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
