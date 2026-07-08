import { Router } from "express";
import type { AppContext } from "../../index.js";
import { MAX_TITLE_LEN, MAX_DESC_LEN, MAX_TASK_RETRIES, MAX_REASSIGNS } from "../../utils/constants.js";

export function createTaskRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

  // List tasks (filter by projectId or goalId)
  router.get("/", (req, res) => {
    const goalId = typeof req.query.goalId === "string" ? req.query.goalId : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 200;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

    // Join verification verdict + issues so the dashboard can render verification badges & block reasons.
    // retry_limit/reassign_limit은 env로 바뀔 수 있는 서버 상수라 응답에 실어
    // 대시보드가 "재시도 n/max" 분모를 하드코딩하지 않게 한다.
    const withVerification = `
      SELECT t.*,
             ${MAX_TASK_RETRIES} AS retry_limit,
             ${MAX_REASSIGNS}    AS reassign_limit,
             v.verdict        AS verification_verdict,
             v.severity       AS verification_severity,
             v.scope          AS verification_scope,
             v.issues         AS verification_issues
      FROM tasks t
      LEFT JOIN verifications v ON v.id = t.verification_id
    `;

    let tasks;
    if (goalId) {
      tasks = db.prepare(`${withVerification} WHERE t.goal_id = ? ORDER BY t.created_at DESC LIMIT ?`).all(goalId, limit);
    } else if (projectId) {
      tasks = db.prepare(`${withVerification} WHERE t.project_id = ? ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 WHEN 'todo' THEN 2 WHEN 'pending_approval' THEN 3 WHEN 'blocked' THEN 4 WHEN 'done' THEN 5 ELSE 6 END, t.created_at DESC LIMIT ?`).all(projectId, limit);
    } else {
      return res.status(400).json({ error: "projectId or goalId query param required" });
    }
    res.json(tasks);
  });

  // Get single task (includes verification badge fields)
  router.get("/:id", (req, res) => {
    const task = db.prepare(`
      SELECT t.*,
             v.verdict        AS verification_verdict,
             v.severity       AS verification_severity,
             v.scope          AS verification_scope
      FROM tasks t
      LEFT JOIN verifications v ON v.id = t.verification_id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json(task);
  });

  // Create task
  router.post("/", (req, res) => {
    const { goal_id, project_id, title, description = "", assignee_id } = req.body;
    // Type + length validation
    if (typeof goal_id !== "string" || !goal_id) {
      return res.status(400).json({ error: "goal_id (string) is required" });
    }
    if (typeof project_id !== "string" || !project_id) {
      return res.status(400).json({ error: "project_id (string) is required" });
    }
    if (typeof title !== "string" || !title) {
      return res.status(400).json({ error: "title (string) is required" });
    }
    if (typeof description !== "string") {
      return res.status(400).json({ error: "description must be a string" });
    }
    // Verify parent resources exist (provides clean 404 instead of FK error)
    const goal = db.prepare("SELECT id, project_id FROM goals WHERE id = ?").get(goal_id) as { id: string; project_id: string } | undefined;
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    if (goal.project_id !== project_id) {
      return res.status(400).json({ error: "goal_id does not belong to project_id" });
    }
    if (assignee_id != null) {
      if (typeof assignee_id !== "string") {
        return res.status(400).json({ error: "assignee_id must be a string or null" });
      }
      const agent = db.prepare("SELECT id FROM agents WHERE id = ? AND project_id = ?").get(assignee_id, project_id) as { id: string } | undefined;
      if (!agent) return res.status(404).json({ error: "Assignee agent not found in this project" });
    }

    const boundedTitle = title.slice(0, MAX_TITLE_LEN);
    const boundedDesc = description.slice(0, MAX_DESC_LEN);

    try {
      const result = db.prepare(`
        INSERT INTO tasks (goal_id, project_id, title, description, assignee_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(goal_id, project_id, boundedTitle, boundedDesc, assignee_id ?? null);

      const task = db.prepare("SELECT * FROM tasks WHERE rowid = ?").get(result.lastInsertRowid);
      broadcast("task:updated", task);
      res.status(201).json(task);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Helper: auto-resume queue for autopilot projects when todo tasks appear
  function ensureQueueRunning(projectId: string): void {
    if (ctx.scheduler?.isRunning(projectId)) return;
    const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
    if (project && (project.autopilot === "goal" || project.autopilot === "full")) {
      ctx.scheduler?.startQueue(projectId);
    }
  }

  // Valid status transitions (Sprint 5: pending_approval added)
  const VALID_TRANSITIONS: Record<string, string[]> = {
    pending_approval: ["todo", "blocked"],
    todo: ["in_progress", "blocked", "pending_approval"],
    in_progress: ["in_review", "blocked", "todo"],
    in_review: ["done", "todo", "blocked"],
    done: ["todo"],
    blocked: ["todo", "in_progress", "pending_approval"],
  };
  const VALID_STATUSES = ["todo", "pending_approval", "in_progress", "in_review", "done", "blocked"];

  // Update task
  router.patch("/:id", (req, res) => {
    const { title, description, assignee_id, status, verification_id, target_files, stack_hint } = req.body;
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "Task not found" });

    // Validate status transition
    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
      }
      const allowed = VALID_TRANSITIONS[existing.status];
      if (allowed && !allowed.includes(status)) {
        return res.status(400).json({
          error: `Cannot transition from '${existing.status}' to '${status}'. Allowed: ${allowed.join(", ")}`,
        });
      }
    }

    // Input type + length validation
    if (title != null && typeof title !== "string") {
      return res.status(400).json({ error: "title must be a string" });
    }
    if (description != null && typeof description !== "string") {
      return res.status(400).json({ error: "description must be a string" });
    }
    // P2: scope anchor validation
    if (target_files !== undefined) {
      if (!Array.isArray(target_files) || target_files.some((f) => typeof f !== "string" || f.length === 0 || f.length > 260)) {
        return res.status(400).json({ error: "target_files must be an array of non-empty path strings (max 260 chars each)" });
      }
      if (target_files.length > 20) {
        return res.status(400).json({ error: "target_files may contain at most 20 entries" });
      }
    }
    if (stack_hint !== undefined && (typeof stack_hint !== "string" || stack_hint.length > 200)) {
      return res.status(400).json({ error: "stack_hint must be a string (max 200 chars)" });
    }
    const boundedTitle = typeof title === "string" ? title.slice(0, MAX_TITLE_LEN) : null;
    const boundedDesc = typeof description === "string" ? description.slice(0, MAX_DESC_LEN) : null;
    const targetFilesJson = target_files !== undefined ? JSON.stringify(target_files) : null;
    const stackHintValue = stack_hint !== undefined ? stack_hint : null;

    try {
      // assignee_id needs special handling: explicit null means "unassign",
      // undefined means "don't change". COALESCE(NULL, x) = x, so we can't use it.
      const assigneeClause = assignee_id !== undefined
        ? "assignee_id = ?,"
        : "";
      const assigneeParams = assignee_id !== undefined
        ? [assignee_id]
        : [];

      // Atomic re-check + update — prevents race with concurrent DELETE
      const run = db.transaction(() => {
        const current = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id) as { id: string } | undefined;
        if (!current) return null;
        db.prepare(`
          UPDATE tasks SET
            title = COALESCE(?, title),
            description = COALESCE(?, description),
            ${assigneeClause}
            status = COALESCE(?, status),
            verification_id = COALESCE(?, verification_id),
            target_files = COALESCE(?, target_files),
            stack_hint = COALESCE(?, stack_hint),
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          boundedTitle,
          boundedDesc,
          ...assigneeParams,
          status ?? null,
          verification_id ?? null,
          targetFilesJson,
          stackHintValue,
          req.params.id,
        );
        return db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
      });

      const updated = run();
      if (!updated) return res.status(404).json({ error: "Task not found (deleted concurrently)" });
      broadcast("task:updated", updated);

      // Update goal progress if task status changed
      if (status) {
        updateGoalProgress(db, existing.goal_id);
      }

      // Auto-resume queue when task becomes todo in autopilot mode
      if (status === "todo") {
        ensureQueueRunning(existing.project_id);
      }

      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Approve task (governance gate: in_review → done)
  // Requires verification to exist — use /orchestration/tasks/:id/verify first
  router.post("/:id/approve", async (req, res) => {
    const { force = false } = req.body ?? {};
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as any;
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "in_review") {
      return res.status(400).json({ error: `Cannot approve task in status '${task.status}'. Must be 'in_review'.` });
    }

    // Block approve without verification (unless force override)
    if (!task.verification_id && !force) {
      return res.status(400).json({
        error: "Task has no verification. Run verification first.",
        requiresVerification: true,
      });
    }

    // Mark as done
    db.prepare("UPDATE tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    updateGoalProgress(db, task.goal_id);

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    broadcast("task:updated", updated);

    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_approved', ?)",
    ).run(task.project_id, `Approved: ${task.title}`);

    res.json(updated);
  });

  // Bulk approve all in_review tasks for a project (only verified tasks unless force=true)
  router.post("/bulk-approve", (req, res) => {
    const { projectId, force = false } = req.body;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });

    const tasks = db.prepare(
      "SELECT * FROM tasks WHERE project_id = ? AND status = 'in_review'",
    ).all(projectId) as any[];

    let approved = 0;
    let skipped = 0;
    for (const task of tasks) {
      // Skip unverified tasks unless force override
      if (!task.verification_id && !force) {
        skipped++;
        continue;
      }
      db.prepare("UPDATE tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?")
        .run(task.id);
      updateGoalProgress(db, task.goal_id);
      approved++;
    }

    broadcast("project:updated", { projectId });

    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_approved', ?)",
    ).run(projectId, `Bulk approved ${approved} tasks`);

    res.json({ approved, skipped, total: tasks.length });
  });

  // Reject task (governance gate: in_review → todo with feedback)
  router.post("/:id/reject", (req, res) => {
    const { feedback } = req.body ?? {};
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as any;
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "in_review") {
      return res.status(400).json({ error: `Cannot reject task in status '${task.status}'. Must be 'in_review'.` });
    }

    // Append feedback to task description
    const newDesc = feedback
      ? `${task.description}\n\n--- Rejection Feedback ---\n${feedback}`
      : task.description;

    db.prepare(
      "UPDATE tasks SET status = 'todo', description = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(newDesc, req.params.id);

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    broadcast("task:updated", updated);

    // Rejected task goes back to todo — auto-resume queue in autopilot mode
    ensureQueueRunning(task.project_id);

    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_rejected', ?)",
    ).run(task.project_id, `Rejected: ${task.title}${feedback ? ` — ${feedback}` : ""}`);

    res.json(updated);
  });

  // Delete task
  router.delete("/:id", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as any;
    const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: "Task not found" });
    if (task?.goal_id) updateGoalProgress(db, task.goal_id);
    if (task?.project_id) broadcast("project:updated", { projectId: task.project_id });
    res.json({ success: true });
  });

  return router;
}

function updateGoalProgress(db: any, goalId: string): void {
  // Single atomic statement — avoids SELECT-then-UPDATE race when tasks
  // update concurrently. Result is clamped to 0..100 via MIN/MAX.
  // Only root tasks (parent_task_id IS NULL) count — subtasks roll up via their parent.
  db.prepare(`
    UPDATE goals SET progress = (
      SELECT
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE MAX(0, MIN(100, CAST(ROUND(100.0 * SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) / COUNT(*)) AS INTEGER)))
        END
      FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
    )
    WHERE id = ?
  `).run(goalId, goalId);
}
