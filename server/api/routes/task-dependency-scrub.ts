import type Database from "better-sqlite3";

export function updateGoalProgress(db: Database.Database, goalId: string): void {
  // Single atomic statement — avoids SELECT-then-UPDATE race when tasks
  // update concurrently. Result is clamped to 0..100 via MIN/MAX.
  // Only root tasks (parent_task_id IS NULL) count — subtasks roll up via their parent.
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
  `).run(goalId, goalId);
}

/** Remove deleted task IDs from every surviving task dependency list. */
export function scrubTaskDependencies(
  db: Database.Database,
  taskIds: Iterable<string>,
): Set<string> {
  const deletedIds = new Set(taskIds);
  if (deletedIds.size === 0) return new Set();

  const dependents = new Map<string, { id: string; goal_id: string | null; depends_on: string }>();
  const findCandidates = db.prepare(
    "SELECT id, goal_id, depends_on FROM tasks WHERE depends_on LIKE '%' || ? || '%'",
  );
  for (const taskId of deletedIds) {
    const candidates = findCandidates.all(taskId) as Array<{
      id: string;
      goal_id: string | null;
      depends_on: string;
    }>;
    for (const candidate of candidates) dependents.set(candidate.id, candidate);
  }

  const affectedGoalIds = new Set<string>();
  const updateDependencies = db.prepare(
    "UPDATE tasks SET depends_on = ?, updated_at = datetime('now') WHERE id = ?",
  );
  for (const dependent of dependents.values()) {
    let dependencies: unknown;
    try {
      dependencies = JSON.parse(dependent.depends_on);
    } catch {
      continue;
    }
    if (!Array.isArray(dependencies)) continue;
    const remaining = dependencies.filter((dependency) => !deletedIds.has(dependency));
    if (remaining.length === dependencies.length) continue;
    updateDependencies.run(JSON.stringify(remaining), dependent.id);
    if (dependent.goal_id) affectedGoalIds.add(dependent.goal_id);
  }

  for (const goalId of affectedGoalIds) updateGoalProgress(db, goalId);
  return affectedGoalIds;
}
