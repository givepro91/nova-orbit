import type { Database } from "better-sqlite3";
import type { Anomaly, AnomalyReport } from "../../shared/types.js";
import { worktreeHasUncommittedChanges } from "./project/git-workflow.js";
import { STALLED_TASK_MINUTES } from "../utils/constants.js";

/**
 * 이상 신호 감지 — 관찰 패널의 정본.
 *
 * 원칙: 어느 한 테이블만 보면 정상인데 둘을 나란히 놓으면 모순인 것만 신호로 올린다.
 * 단일 상태를 그대로 옮기는 건(진행 중 태스크 목록, 파일 목록) 좌측·터미널이 이미 하며,
 * 그걸 좁은 패널에 복제하면 열등한 사본이 될 뿐이다.
 *
 * 노이즈 배제: 신호 후보는 라이브 DB 실측으로 걸렀다. "검증 없이 done"·"세션 없는 in_progress"는
 * done 6/6·in_progress 1/1 을 전부 잡아 적중률 100%였는데, 이는 이상이 아니라 터미널 경로가
 * 엔진 테이블(verifications·sessions)을 쓰지 않는다는 뜻이었다. 경로 전제가 깔린 신호는
 * 해당 경로가 실제로 돌기 시작한 뒤 실측해서 넣는다.
 */
export function detectAnomalies(db: Database, projectId: string): AnomalyReport {
  const anomalies: Anomaly[] = [
    ...detectStalledTasks(db, projectId),
    ...detectBlockedApplies(db, projectId),
    ...detectUnsavedChanges(db, projectId),
  ];

  // critical 먼저, 같은 심각도면 오래된 것 먼저 — 급한 것이 위로 온다.
  anomalies.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0);
  });

  const watched = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tasks WHERE project_id = ?) AS tasks,
      (SELECT COUNT(*) FROM goals WHERE project_id = ?) AS goals
  `).get(projectId, projectId) as { tasks: number; goals: number };

  return {
    anomalies,
    watched,
    checkedAt: new Date().toISOString(),
  };
}

/** 진행 중 표시 ↔ 실제 변화 없음. 경로와 무관하게 성립한다. */
function detectStalledTasks(db: Database, projectId: string): Anomaly[] {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.goal_id, t.updated_at,
           CAST(ROUND((julianday('now') - julianday(t.updated_at)) * 1440) AS INTEGER) AS age_minutes,
           a.name AS assignee_name
      FROM tasks t
      LEFT JOIN agents a ON a.id = t.assignee_id
     WHERE t.project_id = ?
       AND t.status = 'in_progress'
       AND t.updated_at < datetime('now', ?)
  `).all(projectId, `-${STALLED_TASK_MINUTES} minutes`) as Array<{
    id: string; title: string; goal_id: string | null;
    updated_at: string; age_minutes: number; assignee_name: string | null;
  }>;

  return rows.map((r) => ({
    id: `stalled_task:${r.id}`,
    kind: "stalled_task" as const,
    severity: "warning" as const,
    targetType: "task" as const,
    targetId: r.id,
    targetTitle: r.title,
    projectId,
    goalId: r.goal_id,
    since: r.updated_at,
    ageMinutes: r.age_minutes,
    facts: { assignee: r.assignee_name ?? "", lastChangeAt: r.updated_at },
  }));
}

/**
 * 태스크는 끝났는데 반영이 막힌 goal.
 *
 * squash_status='none' 인 채 갇히는 경우는 sweepCompletedGoalSquashes 가 게이트로 올려주므로
 * 여기서 다시 신호로 띄우지 않는다 — 자동 복구되는 것을 사람에게 알리면 그게 노이즈다.
 * 자동 복구가 실패한 지점('blocked')만 사람 손이 필요하다.
 */
function detectBlockedApplies(db: Database, projectId: string): Anomaly[] {
  const rows = db.prepare(`
    SELECT g.id, g.title, g.description,
           (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.parent_task_id IS NULL) AS total,
           (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.parent_task_id IS NULL
              AND t.status IN ('done','skipped')) AS done
      FROM goals g
     WHERE g.project_id = ?
       AND g.goal_model = 'goal_as_unit'
       AND g.squash_status = 'blocked'
  `).all(projectId) as Array<{
    id: string; title: string; description: string; total: number; done: number;
  }>;

  return rows.map((r) => ({
    id: `apply_blocked:${r.id}`,
    kind: "apply_blocked" as const,
    severity: "critical" as const,
    targetType: "goal" as const,
    targetId: r.id,
    targetTitle: r.title || r.description,
    projectId,
    goalId: r.id,
    since: null,
    ageMinutes: null,
    facts: { doneCount: r.done, totalCount: r.total },
  }));
}

/**
 * 아무도 작업하지 않는데 저장 안 된 변경이 남아 있는 작업 공간.
 *
 * tasks.recovery_worktree_dirty 는 쓰지 않는다 — engine.ts 의 태스크 실행 경로에서만 채워져
 * 터미널 작업에서는 영원히 null 이고, 스냅샷 시점 값이라 현재 상태도 아니다. git 에 직접 묻는다.
 */
function detectUnsavedChanges(db: Database, projectId: string): Anomaly[] {
  const goals = db.prepare(`
    SELECT g.id, g.title, g.description, g.worktree_path
      FROM goals g
     WHERE g.project_id = ?
       AND g.worktree_path IS NOT NULL
       AND g.squash_status != 'merged'
       AND NOT EXISTS (
         SELECT 1 FROM tasks t
          WHERE t.goal_id = g.id AND t.status = 'in_progress'
       )
  `).all(projectId) as Array<{
    id: string; title: string; description: string; worktree_path: string;
  }>;

  const out: Anomaly[] = [];
  for (const g of goals) {
    if (!worktreeHasUncommittedChanges(g.worktree_path)) continue;
    out.push({
      id: `unsaved_changes:${g.id}`,
      kind: "unsaved_changes",
      severity: "warning",
      targetType: "goal",
      targetId: g.id,
      targetTitle: g.title || g.description,
      projectId,
      goalId: g.id,
      since: null,
      ageMinutes: null,
      facts: { worktreePath: g.worktree_path },
    });
  }
  return out;
}
