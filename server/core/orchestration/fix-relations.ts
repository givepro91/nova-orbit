import type { Database } from "better-sqlite3";

/**
 * fix task 판별 SQL — 단일 정본.
 *
 * "fix task"의 정의 = verification issue에서 파생돼 verification_issue_tasks에
 * relation='fix'로 링크된 태스크. 이 판별이 engine/scheduler/recovery에 인라인으로
 * 중복되면 한 곳만 고쳐질 때 Quality Gate 우회(예: startQueue가 fix task를 legacy
 * plan task로 오인해 자동 승인)가 생긴다. 반드시 아래 프래그먼트를 재사용한다.
 */

/** 단건 probe용 (prepared statement, ? = task id). */
export const FIX_TASK_PROBE_SQL =
  "SELECT 1 AS x FROM verification_issue_tasks WHERE task_id = ? AND relation = 'fix' LIMIT 1";

/** bulk WHERE절용 EXISTS 프래그먼트 — taskIdRef는 **정적 컬럼 참조만** 허용(예: 'tasks.id', 't.id').
 *  SQL에 그대로 보간되므로 동적/사용자 입력 값은 절대 넘기지 않는다 — 형식 위반 시 throw. */
export function fixTaskExistsSql(taskIdRef: string): string {
  if (!/^[a-z_]+(\.[a-z_]+)?$/.test(taskIdRef)) throw new Error(`fixTaskExistsSql: invalid static column ref '${taskIdRef}'`);
  return `EXISTS (SELECT 1 FROM verification_issue_tasks vit WHERE vit.task_id = ${taskIdRef} AND vit.relation = 'fix')`;
}

/** bulk WHERE절용 NOT EXISTS 프래그먼트 (recovery.ts interrupted 선별과 동형). */
export function notFixTaskSql(taskIdRef: string): string {
  return `NOT ${fixTaskExistsSql(taskIdRef)}`;
}

/**
 * fix task의 "근본 원본 태스크" id를 찾는다. taskId가 fix task가 아니면 null.
 * issue→verification→task 체인을 non-fix 원본에 도달할 때까지 거슬러 올라간다(중첩 fix 대응).
 * engine.ts resolveRootTaskTitle과 같은 관계 그래프를 걷지만, 이쪽은 API 직렬화용으로
 * 제목이 아니라 root id를 돌려준다(대시보드가 fix를 원본 밑에 그룹핑하는 데 씀). 루프 가드 10.
 */
export function resolveRootOriginTaskId(db: Database, taskId: string): string | null {
  const isFixTask = db.prepare(FIX_TASK_PROBE_SQL);
  if (!isFixTask.get(taskId)) return null;

  const parentOf = db.prepare(`
    SELECT v.task_id AS id
    FROM verification_issue_tasks vit
    JOIN verification_issues vi ON vi.id = vit.issue_id
    JOIN verifications v ON v.id = vi.verification_id
    WHERE vit.task_id = ? AND vit.relation = 'fix'
    ORDER BY (SELECT rowid FROM tasks WHERE id = v.task_id) ASC
    LIMIT 1
  `);

  let cur = taskId;
  let root: string | null = null;
  for (let i = 0; i < 10 && isFixTask.get(cur); i++) {
    const parent = parentOf.get(cur) as { id: string } | undefined;
    if (!parent || parent.id === cur) break;
    root = parent.id;
    cur = parent.id;
  }
  return root;
}
