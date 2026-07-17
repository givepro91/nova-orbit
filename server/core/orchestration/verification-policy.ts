import type { Database } from "better-sqlite3";
import { createLogger } from "../../utils/logger.js";
import { MAX_VERIFY_FAIL_ROUNDS } from "../../utils/constants.js";

const log = createLogger("verification-policy");

/**
 * 검증 라운드 상한 정책 — "무한 검토" 방지의 기계적 백스톱.
 *
 * 배경 (07-08 실측): 완벽주의 Evaluator 가 매 라운드 "같은 클래스의 새 이슈"를
 * 인접 컴포넌트에서 발견하며 fail 을 반복 → 한 태스크가 검증 7라운드를 돌고도
 * 끝나지 않아 사람이 수동 개입으로 종결했다. 이슈는 전부 실재했지만 태스크
 * 범위가 매 라운드 확장되는 구조라 수렴이 불가능했다.
 *
 * 정책: fail 이 MAX_VERIFY_FAIL_ROUNDS 회 누적된 태스크는 blocked/재시도로
 * 돌리지 않고 완료 처리하되, 미해결 이슈를 같은 goal 의 최종 QA 태스크
 * 설명에 이월한다. 품질 최종 담보는 goal 의 QA 태스크 + squash 승인 게이트
 * (사람) — 이 정책은 검증을 건너뛰는 게 아니라 심급을 옮기는 것이다.
 */

export interface EscalationIssue {
  severity?: string;
  file?: string | null;
  line?: number | null;
  message?: string;
}

/** 해당 태스크의 누적 fail 검증 라운드 수 (현재 라운드 포함 — verify()가 먼저 기록함) */
export function countFailRounds(db: Database, taskId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM verifications WHERE task_id = ? AND verdict = 'fail'",
  ).get(taskId) as { cnt: number };
  return row.cnt;
}

export function shouldEscalateVerifyCap(db: Database, taskId: string): boolean {
  return countFailRounds(db, taskId) >= MAX_VERIFY_FAIL_ROUNDS;
}

/**
 * 이슈 셋의 구조적 지문 — severity|file|line 만으로 (메시지 워딩 무시, 순서 무관).
 *
 * auto-fix 스톨 감지용. 라운드 간 지문이 같으면 = fix 가 같은 위치의 같은 등급 이슈를
 * 못 없앴다(수렴 실패·외부 blocker). 이슈가 다른 파일/라인으로 옮겨가면(진짜 진전) 지문이
 * 바뀌어 스톨로 안 잡힌다. 메시지를 뺀 이유: Evaluator(LLM)가 같은 이슈를 매 라운드 다르게
 * 서술해도 같은 이슈로 취급하기 위함.
 */
export function issueSetSignature(issues: EscalationIssue[]): string {
  return (issues ?? [])
    .map((i) => `${i.severity ?? "?"}|${i.file ?? ""}|${i.line ?? ""}`)
    .sort()
    .join("\n");
}

/**
 * 상한 도달 태스크를 완료 처리하고 미해결 이슈를 goal 의 QA 태스크로 이월한다.
 * 산출물은 폐기하지 않는다 (부분 유효 작업 보존은 호출자 책임 — dropCheckpoint).
 */
export function escalateVerificationCap(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  task: { id: string; goal_id: string | null; project_id: string; assignee_id: string | null; title: string },
  issues: EscalationIssue[],
): void {
  const rounds = countFailRounds(db, task.id);
  const marker = `[이월 ${task.id.slice(0, 8)}]`;

  // 1) 미해결 이슈를 goal 의 최종 QA/리뷰 태스크 설명에 이월 (멱등 — 마커로 중복 방지)
  let carried = false;
  if (task.goal_id && issues.length > 0) {
    const qaTask = db.prepare(`
      SELECT t.id, t.description FROM tasks t
      JOIN agents a ON a.id = t.assignee_id
      WHERE t.goal_id = ? AND t.id != ? AND t.status NOT IN ('done', 'skipped') AND t.parent_task_id IS NULL
        AND a.role IN ('qa', 'reviewer', 'qa-reviewer')
      ORDER BY t.sort_order DESC LIMIT 1
    `).get(task.goal_id, task.id) as { id: string; description: string } | undefined;

    if (qaTask && !(qaTask.description ?? "").includes(marker)) {
      const issueLines = issues.slice(0, 8).map((i) =>
        `- [${i.severity ?? "?"}] ${i.file ?? ""}${i.line != null ? `:${i.line}` : ""} — ${String(i.message ?? "").slice(0, 200)}`,
      ).join("\n");
      const appended = `${qaTask.description ?? ""}\n\n--- ${marker} 검증 상한 이월 이슈 ("${task.title.slice(0, 60)}") ---\n${issueLines}`;
      db.prepare("UPDATE tasks SET description = ?, updated_at = datetime('now') WHERE id = ?").run(appended, qaTask.id);
      const updatedQa = db.prepare("SELECT * FROM tasks WHERE id = ?").get(qaTask.id);
      if (updatedQa) broadcast("task:updated", updatedQa);
      carried = true;
    }
  }

  // 2) 태스크 완료 처리 (blocked/재시도 대신)
  db.prepare("UPDATE tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(task.id);
  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
  if (updated) broadcast("task:updated", updated);

  // 3) goal 진행률 갱신 (root 태스크 기준 — engine/delegation 과 동일 로직)
  if (task.goal_id) {
    db.prepare(`
      UPDATE goals SET progress = (
        SELECT
          CASE
            WHEN COUNT(*) = 0 THEN 0
            ELSE MAX(0, MIN(100, CAST(ROUND(100.0 * SUM(CASE WHEN status IN ('done', 'skipped') THEN 1 ELSE 0 END) / COUNT(*)) AS INTEGER)))
          END
        FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
      )
      WHERE id = ?
    `).run(task.goal_id, task.goal_id);
  }

  // 4) 사용자에게 표면화
  db.prepare(
    "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'autopilot_warning', ?)",
  ).run(
    task.project_id,
    task.assignee_id,
    `검증 라운드 상한(${rounds}회) 도달 — 완료 처리, 미해결 이슈 ${issues.length}건은 ${carried ? "최종 QA 태스크로 이월" : "활동 로그에만 기록(QA 태스크 없음)"}: ${task.title.slice(0, 60)}`,
  );
  broadcast("project:updated", { projectId: task.project_id });
  log.warn(`Verification cap reached for "${task.title}" (${rounds} fail rounds) — marked done, ${issues.length} issue(s) ${carried ? "carried to goal QA" : "logged only"}`);
}
