import { Router } from "express";
import type { AppContext } from "../../index.js";
import { loadProviderConfig } from "../../core/agent/provider.js";
import { getSpecState } from "../../core/goal-spec/spec-approval.js";
import { resolveRootOriginTaskId } from "../../core/orchestration/fix-relations.js";
import { MAX_TITLE_LEN, MAX_DESC_LEN, MAX_TASK_RETRIES, MAX_REASSIGNS } from "../../utils/constants.js";
import type {
  AgentProvider,
  ProviderFailoverReasonCode,
  ProviderResolutionSource,
  ProviderTrace,
} from "../../../shared/types.js";

const PROVIDERS: AgentProvider[] = ["claude", "codex"];
const RESOLUTION_SOURCES: ProviderResolutionSource[] = ["agent", "project", "global"];
const FAILOVER_REASONS: ProviderFailoverReasonCode[] = ["rate_limit", "session_exhausted", "env_error"];
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending_approval: ["todo", "blocked"],
  todo: ["in_progress", "blocked", "pending_approval"],
  in_progress: ["in_review", "blocked", "todo"],
  in_review: ["done", "todo", "blocked"],
  done: ["todo"],
  blocked: ["todo", "in_progress", "pending_approval"],
};
const VALID_STATUSES = ["todo", "pending_approval", "in_progress", "in_review", "done", "blocked"];

type GraphTaskRow = {
  id: string;
  goal_id: string;
  project_id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  status: string;
  sort_order: number;
  depends_on: string | null;
};

type GraphTaskEdit = {
  id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  status: string;
  sort_order: number;
  depends_on: string[];
};

class TaskGraphValidationError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "TaskGraphValidationError";
  }
}

function parseDependencies(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function assertStatusTransition(current: string, next: unknown): asserts next is string {
  if (typeof next !== "string" || !VALID_STATUSES.includes(next)) {
    throw new TaskGraphValidationError(`Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`);
  }
  if (next === current) return;
  const allowed = VALID_TRANSITIONS[current] ?? [];
  if (!allowed.includes(next)) {
    throw new TaskGraphValidationError(
      `Cannot transition from '${current}' to '${next}'. Allowed: ${allowed.join(", ")}`,
    );
  }
}

function detectDependencyCycle(tasks: GraphTaskEdit[]): string[] | null {
  const taskIds = new Set(tasks.map((task) => task.id));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const visit = (taskId: string): string[] | null => {
    if (visited.has(taskId)) return null;
    if (visiting.has(taskId)) {
      const start = path.indexOf(taskId);
      return [...path.slice(start), taskId];
    }
    visiting.add(taskId);
    path.push(taskId);
    for (const dependencyId of byId.get(taskId)?.depends_on ?? []) {
      if (!taskIds.has(dependencyId)) continue;
      const cycle = visit(dependencyId);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

function normalizeGraphEdits(
  db: any,
  goalId: string,
  submitted: unknown,
): { projectId: string; currentById: Map<string, GraphTaskRow>; edits: GraphTaskEdit[] } {
  if (!Array.isArray(submitted) || submitted.length === 0) {
    throw new TaskGraphValidationError("tasks must be a non-empty array");
  }
  const goal = db.prepare("SELECT id, project_id FROM goals WHERE id = ?").get(goalId) as { id: string; project_id: string } | undefined;
  if (!goal) throw new TaskGraphValidationError("Goal not found", 404);
  const current = db.prepare(`
    SELECT id, goal_id, project_id, title, description, assignee_id, status, sort_order, depends_on
    FROM tasks WHERE goal_id = ?
  `).all(goalId) as GraphTaskRow[];
  const currentById = new Map(current.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const submittedById = new Map<string, Record<string, unknown>>();

  for (const value of submitted) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TaskGraphValidationError("Each task edit must be an object");
    }
    const edit = value as Record<string, unknown>;
    if (typeof edit.id !== "string" || !edit.id) throw new TaskGraphValidationError("Each task edit requires id");
    if (seen.has(edit.id)) throw new TaskGraphValidationError(`Duplicate task edit: ${edit.id}`);
    if (!currentById.has(edit.id)) throw new TaskGraphValidationError(`Task does not belong to goal: ${edit.id}`);
    seen.add(edit.id);
    submittedById.set(edit.id, edit);
  }

  const edits = current.map((task): GraphTaskEdit => {
    const patch = submittedById.get(task.id);
    const title = patch?.title ?? task.title;
    const description = patch?.description ?? task.description;
    const assigneeId = patch && Object.hasOwn(patch, "assignee_id") ? patch.assignee_id : task.assignee_id;
    const status = patch?.status ?? task.status;
    const sortOrder = patch?.sort_order ?? task.sort_order;
    const dependencies = patch?.depends_on ?? parseDependencies(task.depends_on);

    if (typeof title !== "string" || !title.trim()) throw new TaskGraphValidationError(`Task ${task.id} title is required`);
    if (typeof description !== "string") throw new TaskGraphValidationError(`Task ${task.id} description must be a string`);
    if (assigneeId !== null && typeof assigneeId !== "string") {
      throw new TaskGraphValidationError(`Task ${task.id} assignee_id must be a string or null`);
    }
    if (!Number.isInteger(sortOrder) || Number(sortOrder) < 0) {
      throw new TaskGraphValidationError(`Task ${task.id} sort_order must be a non-negative integer`);
    }
    if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string" || !dependency)) {
      throw new TaskGraphValidationError(`Task ${task.id} depends_on must be an array of task IDs`);
    }
    const uniqueDependencies = [...new Set(dependencies as string[])];
    if (uniqueDependencies.length !== dependencies.length) {
      throw new TaskGraphValidationError(`Task ${task.id} depends_on contains duplicates`);
    }
    if (uniqueDependencies.includes(task.id)) throw new TaskGraphValidationError(`Task ${task.id} cannot depend on itself`);
    if (patch?.status !== undefined) assertStatusTransition(task.status, status);
    if (!VALID_STATUSES.includes(String(status))) {
      throw new TaskGraphValidationError(`Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`);
    }
    if (assigneeId) {
      const assignee = db.prepare("SELECT id FROM agents WHERE id = ? AND project_id = ?").get(assigneeId, goal.project_id);
      if (!assignee) throw new TaskGraphValidationError(`Assignee agent not found in this project: ${assigneeId}`, 404);
    }
    for (const dependencyId of uniqueDependencies) {
      if (currentById.has(dependencyId)) continue;
      const foreign = db.prepare("SELECT goal_id FROM tasks WHERE id = ?").get(dependencyId) as { goal_id: string } | undefined;
      if (foreign) throw new TaskGraphValidationError(`Dependency ${dependencyId} belongs to another goal`);
      throw new TaskGraphValidationError(`Dependency task not found: ${dependencyId}`, 404);
    }
    return {
      id: task.id,
      title: title.slice(0, MAX_TITLE_LEN),
      description: description.slice(0, MAX_DESC_LEN),
      assignee_id: assigneeId as string | null,
      status: String(status),
      sort_order: Number(sortOrder),
      depends_on: uniqueDependencies,
    };
  });

  const cycle = detectDependencyCycle(edits);
  if (cycle) throw new TaskGraphValidationError(`Dependency cycle detected: ${cycle.join(" -> ")}`);
  return { projectId: goal.project_id, currentById, edits };
}

function isProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && PROVIDERS.includes(value as AgentProvider);
}

function asProvider(value: unknown, fallback: AgentProvider): AgentProvider {
  return isProvider(value) ? value : fallback;
}

function asResolutionSource(value: unknown): ProviderResolutionSource | null {
  return typeof value === "string" && RESOLUTION_SOURCES.includes(value as ProviderResolutionSource)
    ? value as ProviderResolutionSource
    : null;
}

function asFailoverReason(value: unknown): ProviderFailoverReasonCode | null {
  return typeof value === "string" && FAILOVER_REASONS.includes(value as ProviderFailoverReasonCode)
    ? value as ProviderFailoverReasonCode
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBooleanFlag(value: unknown): boolean {
  return value === true || value === 1;
}

function buildProviderTrace(row: Record<string, unknown>, globalDefault: AgentProvider): ProviderTrace {
  const resolutionSource = asResolutionSource(row.provider_trace_resolution_source)
    ?? (isProvider(row.agent_provider) ? "agent" : isProvider(row.project_default_provider) ? "project" : "global");
  const inheritedProvider = resolutionSource === "agent"
    ? row.agent_provider
    : resolutionSource === "project"
      ? row.project_default_provider
      : globalDefault;
  const resolvedProvider = asProvider(
    row.provider_trace_resolved_provider,
    asProvider(inheritedProvider, globalDefault),
  );

  return {
    resolvedProvider,
    resolutionSource,
    failover: {
      reasonCode: asFailoverReason(row.provider_failover_reason_code),
      userMessage: asNullableString(row.provider_failover_user_message),
      fromProvider: isProvider(row.provider_failover_from_provider) ? row.provider_failover_from_provider : null,
      toProvider: isProvider(row.provider_failover_to_provider) ? row.provider_failover_to_provider : null,
      redispatched: asBooleanFlag(row.provider_failover_redispatched),
      loopGuardBlocked: asBooleanFlag(row.provider_failover_loop_guard_blocked),
      originalSessionId: asNullableString(row.provider_failover_original_session_id),
      redispatchedSessionId: asNullableString(row.provider_failover_redispatched_session_id),
    },
  };
}

export function serializeTask(row: Record<string, unknown>, globalDefault: AgentProvider): Record<string, unknown> {
  const {
    agent_provider: _agentProvider,
    project_default_provider: _projectDefaultProvider,
    provider_trace_resolved_provider: _providerTraceResolvedProvider,
    provider_trace_resolution_source: _providerTraceResolutionSource,
    provider_failover_reason_code: _providerFailoverReasonCode,
    provider_failover_user_message: _providerFailoverUserMessage,
    provider_failover_from_provider: _providerFailoverFromProvider,
    provider_failover_to_provider: _providerFailoverToProvider,
    provider_failover_redispatched: _providerFailoverRedispatched,
    provider_failover_loop_guard_blocked: _providerFailoverLoopGuardBlocked,
    provider_failover_original_session_id: _providerFailoverOriginalSessionId,
    provider_failover_redispatched_session_id: _providerFailoverRedispatchedSessionId,
    ...task
  } = row;

  return {
    ...task,
    providerTrace: buildProviderTrace(row, globalDefault),
  };
}

export function selectTaskForResponse(db: any, taskId: string): Record<string, unknown> | undefined {
  return db.prepare(`
    SELECT t.*,
           v.verdict        AS verification_verdict,
           v.severity       AS verification_severity,
           v.scope          AS verification_scope,
           v.issues         AS verification_issues,
           a.provider       AS agent_provider,
           p.default_provider AS project_default_provider
    FROM tasks t
    LEFT JOIN verifications v ON v.id = t.verification_id
    LEFT JOIN agents a ON a.id = t.assignee_id
    JOIN projects p ON p.id = t.project_id
    WHERE t.id = ?
  `).get(taskId) as Record<string, unknown> | undefined;
}

function graphResponse(ctx: AppContext, goalId: string): Record<string, unknown> | null {
  const { db } = ctx;
  const goal = db.prepare(`
    SELECT id, project_id, title, description, priority, progress
    FROM goals WHERE id = ?
  `).get(goalId) as Record<string, unknown> | undefined;
  if (!goal) return null;

  const spec = getSpecState(db, goalId);
  const planVersion = spec.versions.find((version) => version.id === spec.execution_spec_version_id)
    ?? spec.versions.at(-1)
    ?? null;
  const rows = db.prepare(`
    SELECT id, goal_id, project_id, title, description, assignee_id, status, sort_order, depends_on,
           priority, verification_id, created_at, updated_at
    FROM tasks
    WHERE goal_id = ?
    ORDER BY sort_order ASC, created_at ASC
  `).all(goalId) as Array<GraphTaskRow & Record<string, unknown>>;
  const byId = new Map(rows.map((task) => [task.id, task]));
  const tasks = rows.map((task) => {
    const dependencies = parseDependencies(task.depends_on);
    const blockedBy = dependencies.filter((dependencyId) => byId.get(dependencyId)?.status !== "done");
    const executionState = task.status === "done"
      ? "complete"
      : task.status === "blocked" || blockedBy.length > 0
        ? "blocked"
        : task.status === "in_progress" || task.status === "in_review"
          ? "active"
          : "ready";
    return {
      ...task,
      depends_on: dependencies,
      blocked_by: blockedBy,
      execution_state: executionState,
    };
  });

  return {
    goal,
    plan: planVersion ? {
      status: spec.status,
      version_id: planVersion.id,
      version: planVersion.version,
      scope: planVersion.scope,
      acceptance_criteria: planVersion.acceptance_criteria,
      expected_tasks: planVersion.expected_tasks,
      verification_methods: planVersion.verification_methods,
    } : spec.legacy_spec ? {
      status: spec.status,
      version_id: null,
      version: null,
      scope: spec.legacy_spec.prd_summary.scope ?? spec.legacy_spec.prd_summary.objective ?? "",
      acceptance_criteria: spec.legacy_spec.acceptance_criteria,
      expected_tasks: spec.legacy_spec.feature_specs.map((feature) => feature.name ?? "").filter(Boolean),
      verification_methods: [],
    } : null,
    tasks,
  };
}

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
             v.issues         AS verification_issues,
             a.provider       AS agent_provider,
             p.default_provider AS project_default_provider
      FROM tasks t
      LEFT JOIN verifications v ON v.id = t.verification_id
      LEFT JOIN agents a ON a.id = t.assignee_id
      JOIN projects p ON p.id = t.project_id
    `;

    let tasks: Record<string, unknown>[];
    if (goalId) {
      tasks = db.prepare(`${withVerification} WHERE t.goal_id = ? ORDER BY t.created_at DESC LIMIT ?`).all(goalId, limit) as Record<string, unknown>[];
    } else if (projectId) {
      tasks = db.prepare(`${withVerification} WHERE t.project_id = ? ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 WHEN 'todo' THEN 2 WHEN 'pending_approval' THEN 3 WHEN 'blocked' THEN 4 WHEN 'done' THEN 5 ELSE 6 END, t.created_at DESC LIMIT ?`).all(projectId, limit) as Record<string, unknown>[];
    } else {
      return res.status(400).json({ error: "projectId or goalId query param required" });
    }
    const globalDefault = loadProviderConfig().defaultProvider;
    // origin_task_id: fix task면 근본 원본 태스크 id(파생·read-only, 스키마 무변경).
    // 대시보드가 fix task를 원본 밑에 그룹핑하는 데 쓴다(관계는 verification_issue_tasks에 이미 존재).
    res.json(tasks.map((task) => ({
      ...serializeTask(task, globalDefault),
      origin_task_id: resolveRootOriginTaskId(db, String(task.id)),
    })));
  });

  // Goal planning + task DAG projection. This reads the same task rows consumed by
  // the scheduler; it is not a second planning store.
  router.get("/graph/:goalId", (req, res) => {
    const graph = graphResponse(ctx, req.params.goalId);
    if (!graph) return res.status(404).json({ error: "Goal not found" });
    res.json(graph);
  });

  // Atomic task graph editor. All submitted changes are validated against the
  // merged goal DAG before any task is updated.
  router.patch("/graph/:goalId", (req, res) => {
    try {
      const normalized = normalizeGraphEdits(db, req.params.goalId, req.body?.tasks);
      const submittedIds = new Set((req.body.tasks as Array<{ id: string }>).map((task) => task.id));
      const changed = normalized.edits.filter((task) => submittedIds.has(task.id));
      const update = db.transaction(() => {
        for (const task of changed) {
          db.prepare(`
            UPDATE tasks SET
              title = ?, description = ?, assignee_id = ?, status = ?, sort_order = ?, depends_on = ?,
              updated_at = datetime('now')
            WHERE id = ? AND goal_id = ?
          `).run(
            task.title,
            task.description,
            task.assignee_id,
            task.status,
            task.sort_order,
            JSON.stringify(task.depends_on),
            task.id,
            req.params.goalId,
          );
        }
        updateGoalProgress(db, req.params.goalId);
      });
      update();

      for (const task of changed) {
        const updated = selectTaskForResponse(db, task.id);
        if (updated) broadcast("task:updated", serializeTask(updated, loadProviderConfig().defaultProvider));
        const previous = normalized.currentById.get(task.id);
        if (task.status === "todo" && previous?.status !== "todo") ensureQueueRunning(normalized.projectId);
      }
      const graph = graphResponse(ctx, req.params.goalId);
      res.json(graph);
    } catch (error) {
      if (error instanceof TaskGraphValidationError) return res.status(error.status).json({ error: error.message });
      return res.status(400).json({ error: error instanceof Error ? error.message : "Task graph update failed" });
    }
  });

  // Get single task (includes verification badge fields)
  router.get("/:id", (req, res) => {
    const task = selectTaskForResponse(db, req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json(serializeTask(task, loadProviderConfig().defaultProvider));
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

      const inserted = db.prepare("SELECT id FROM tasks WHERE rowid = ?").get(result.lastInsertRowid) as { id: string };
      const task = serializeTask(selectTaskForResponse(db, inserted.id)!, loadProviderConfig().defaultProvider);
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

  // Update task
  router.patch("/:id", (req, res) => {
    const { title, description, assignee_id, status, verification_id, target_files, stack_hint, depends_on, sort_order } = req.body;
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "Task not found" });

    // Validate status transition
    if (status !== undefined) {
      try {
        assertStatusTransition(existing.status, status);
      } catch (error) {
        if (error instanceof TaskGraphValidationError) return res.status(error.status).json({ error: error.message });
        throw error;
      }
    }

    // Input type + length validation
    if (title != null && typeof title !== "string") {
      return res.status(400).json({ error: "title must be a string" });
    }
    if (description != null && typeof description !== "string") {
      return res.status(400).json({ error: "description must be a string" });
    }
    if (assignee_id !== undefined && assignee_id !== null && typeof assignee_id !== "string") {
      return res.status(400).json({ error: "assignee_id must be a string or null" });
    }
    if (sort_order !== undefined && (!Number.isInteger(sort_order) || sort_order < 0)) {
      return res.status(400).json({ error: "sort_order must be a non-negative integer" });
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
      normalizeGraphEdits(db, existing.goal_id, [{
        id: existing.id,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(assignee_id !== undefined ? { assignee_id } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(sort_order !== undefined ? { sort_order } : {}),
        ...(depends_on !== undefined ? { depends_on } : {}),
      }]);
    } catch (error) {
      if (error instanceof TaskGraphValidationError) return res.status(error.status).json({ error: error.message });
      return res.status(400).json({ error: error instanceof Error ? error.message : "Task update failed" });
    }

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
            depends_on = COALESCE(?, depends_on),
            sort_order = COALESCE(?, sort_order),
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
          depends_on !== undefined ? JSON.stringify(depends_on) : null,
          sort_order ?? null,
          req.params.id,
        );
        return selectTaskForResponse(db, req.params.id);
      });

      const updated = run();
      if (!updated) return res.status(404).json({ error: "Task not found (deleted concurrently)" });
      const responseTask = serializeTask(updated as Record<string, unknown>, loadProviderConfig().defaultProvider);
      broadcast("task:updated", responseTask);

      // Update goal progress if task status changed
      if (status) {
        updateGoalProgress(db, existing.goal_id);
      }

      // Auto-resume queue when task becomes todo in autopilot mode
      if (status === "todo") {
        ensureQueueRunning(existing.project_id);
      }

      res.json(responseTask);
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

    const updated = serializeTask(selectTaskForResponse(db, req.params.id)!, loadProviderConfig().defaultProvider);
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

    const updated = serializeTask(selectTaskForResponse(db, req.params.id)!, loadProviderConfig().defaultProvider);
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
