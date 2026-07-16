import type { Database } from "better-sqlite3";
import type {
  TerminalBridgeActivity,
  TerminalBridgeEvidence,
  TerminalBridgeGoalInput,
  TerminalBridgeGoalResult,
  TerminalBridgeTaskInput,
  TaskStatus,
} from "../../../shared/types.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { MAX_DESC_LEN, MAX_TITLE_LEN } from "../../utils/constants.js";
import { upsertGoalWorkspace } from "../project/workspace.js";
import { redactTerminalText, redactTerminalValue } from "./redaction.js";

const PRIORITIES = new Set(["critical", "high", "medium", "low"]);
const STATUSES = new Set<TaskStatus>(["todo", "pending_approval", "in_progress", "in_review", "done", "blocked"]);
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending_approval: ["todo", "blocked"],
  todo: ["in_progress", "blocked", "pending_approval"],
  in_progress: ["in_review", "blocked", "todo"],
  in_review: ["done", "todo", "blocked"],
  done: ["todo"],
  blocked: ["todo", "in_progress", "pending_approval"],
};

interface BridgeWorkspace {
  id: string;
  project_id: string;
  name: string;
  state: string;
  worktree_path: string | null;
  active_goal_id: string | null;
}

interface BridgeTerminal {
  id: string;
  workspace_id: string;
  project_id: string;
  status: string;
  goal_id: string | null;
  active_task_id: string | null;
}

export interface TerminalBridgeContext {
  workspace: Record<string, unknown>;
  project: Record<string, unknown>;
  agents: Array<Record<string, unknown>>;
  goals: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  activeGoal: Record<string, unknown> | null;
  activeTasks: Array<Record<string, unknown>>;
  sessionBinding: Record<string, unknown> | null;
}

function workspaceForBridge(db: Database, workspaceId: string): BridgeWorkspace {
  const workspace = db.prepare(`
    SELECT id, project_id, name, state, worktree_path,
           COALESCE(active_goal_id, goal_id) AS active_goal_id
      FROM workspaces WHERE id = ?
  `).get(workspaceId) as BridgeWorkspace | undefined;
  if (!workspace) throw new Error("Workspace not found");
  if (workspace.state !== "ready") throw new Error("Workspace is not ready");
  return workspace;
}

function terminalForBridge(
  db: Database,
  workspace: BridgeWorkspace,
  terminalSessionId: string | undefined,
  options: { allowInactive?: boolean } = {},
): BridgeTerminal {
  if (!terminalSessionId?.trim()) throw new Error("terminalSessionId is required");
  const terminal = db.prepare(`
    SELECT id, workspace_id, project_id, status, goal_id, active_task_id
      FROM terminal_sessions
     WHERE id = ? AND workspace_id = ?
  `).get(terminalSessionId, workspace.id) as BridgeTerminal | undefined;
  if (!terminal) throw new Error("Terminal session not found in this workspace");
  if (!options.allowInactive && terminal.status !== "active") throw new Error("Terminal session is not active");
  if (terminal.project_id !== workspace.project_id) {
    throw new Error("Terminal project does not match its workspace");
  }
  return terminal;
}

function collectWorkspaceEvidence(worktreePath: string | null): TerminalBridgeEvidence {
  if (!worktreePath || !existsSync(worktreePath)) return { dirty: null, changedFiles: [], diffStat: "" };
  const runGit = (args: string[]) => spawnSync("git", args, {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
  });
  try {
    const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.status !== 0) return { dirty: null, changedFiles: [], diffStat: "" };
    const changedFiles = status.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^.* -> /, ""))
      .slice(0, 100);
    const trackedStat = runGit(["diff", "--stat", "HEAD"]);
    const untracked = status.stdout
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => ` ${line.slice(3)} | new file`);
    const diffStat = [trackedStat.status === 0 ? trackedStat.stdout.trim() : "", ...untracked]
      .filter(Boolean)
      .join("\n")
      .slice(0, 8_000);
    return {
      dirty: changedFiles.length > 0,
      changedFiles: changedFiles.map((file) => redactTerminalText(file, 500)),
      diffStat: redactTerminalText(diffStat, 8_000),
    };
  } catch {
    return { dirty: null, changedFiles: [], diffStat: "" };
  }
}

function parseJson(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

export function listTerminalBridgeActivity(
  db: Database,
  workspaceId: string,
  goalId?: string,
  terminalSessionId?: string,
): TerminalBridgeActivity[] {
  const workspace = workspaceForBridge(db, workspaceId);
  if (terminalSessionId) terminalForBridge(db, workspace, terminalSessionId);
  const rows = db.prepare(`
    SELECT id, workspace_id, terminal_session_id, kind, payload, result, created_at
      FROM terminal_bridge_events
     WHERE workspace_id = ?
       AND (? IS NULL OR terminal_session_id = ?)
     ORDER BY created_at DESC, rowid DESC
     LIMIT 200
  `).all(workspaceId, terminalSessionId ?? null, terminalSessionId ?? null) as Array<{
    id: string;
    workspace_id: string;
    terminal_session_id: string | null;
    kind: TerminalBridgeActivity["kind"];
    payload: string;
    result: string;
    created_at: string;
  }>;
  return rows.flatMap((row) => {
    const payload = parseJson(row.payload);
    const result = parseJson(row.result);
    const goal = (result.goal ?? null) as Record<string, unknown> | null;
    const task = (result.task ?? null) as Record<string, unknown> | null;
    const eventGoalId = goal ? String(goal.id ?? "") : task ? String(task.goal_id ?? "") : "";
    if (goalId && eventGoalId !== goalId) return [];
    const evidence = result.evidence as TerminalBridgeEvidence | undefined;
    return [{
      id: row.id,
      workspaceId: row.workspace_id,
      terminalSessionId: row.terminal_session_id,
      kind: row.kind,
      goalId: eventGoalId || null,
      goalTitle: goal ? String(goal.title ?? "") || null : null,
      taskId: task ? String(task.id ?? "") || null : null,
      taskTitle: task ? String(task.title ?? "") || null : null,
      status: task ? task.status as TaskStatus : null,
      summary: typeof payload.summary === "string" ? redactTerminalText(payload.summary, MAX_DESC_LEN) : null,
      evidence: evidence && Array.isArray(evidence.changedFiles) ? evidence : null,
      createdAt: row.created_at,
    }];
  });
}

function resolveAssignee(db: Database, projectId: string, input: TerminalBridgeTaskInput): string | null {
  if (input.assigneeId) {
    const exact = db.prepare("SELECT id FROM agents WHERE id = ? AND project_id = ? AND status != 'terminated'")
      .get(input.assigneeId, projectId) as { id: string } | undefined;
    if (!exact) throw new Error(`Assignee ${input.assigneeId} is not available in this project`);
    return exact.id;
  }
  if (!input.assignee?.trim()) return null;
  const assignee = db.prepare(`
    SELECT id FROM agents
     WHERE project_id = ? AND status != 'terminated'
       AND (lower(name) = lower(?) OR lower(role) = lower(?))
     ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, created_at
     LIMIT 1
  `).get(projectId, input.assignee.trim(), input.assignee.trim(), input.assignee.trim()) as { id: string } | undefined;
  return assignee?.id ?? null;
}

function updateGoalProgress(db: Database, goalId: string): void {
  db.prepare(`
    UPDATE goals SET progress = (
      SELECT CASE WHEN COUNT(*) = 0 THEN 0
        ELSE MAX(0, MIN(100, CAST(ROUND(100.0 * SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) / COUNT(*)) AS INTEGER)))
      END
      FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
    ) WHERE id = ?
  `).run(goalId, goalId);
}

export function getTerminalBridgeContext(
  db: Database,
  workspaceId: string,
  terminalSessionId?: string,
): TerminalBridgeContext {
  const workspace = workspaceForBridge(db, workspaceId);
  const project = db.prepare(`
    SELECT id, name, mission, workdir, autopilot, default_provider, base_branch
      FROM projects WHERE id = ?
  `).get(workspace.project_id) as Record<string, unknown>;
  const agents = db.prepare(`
    SELECT id, name, role, status, current_task_id
      FROM agents WHERE project_id = ? AND status != 'terminated' ORDER BY created_at
  `).all(workspace.project_id) as Array<Record<string, unknown>>;
  const goals = db.prepare(`
    SELECT id, title, description, priority, progress, origin_workspace_id, created_at
      FROM goals WHERE project_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(workspace.project_id) as Array<Record<string, unknown>>;
  const tasks = db.prepare(`
    SELECT id, goal_id, title, description, assignee_id, status, updated_at
      FROM tasks WHERE project_id = ?
     ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
              updated_at DESC LIMIT 200
  `).all(workspace.project_id) as Array<Record<string, unknown>>;
  const activeGoal = workspace.active_goal_id
    ? goals.find((goal) => goal.id === workspace.active_goal_id) ?? null
    : null;
  const activeTasks = activeGoal
    ? tasks.filter((task) => task.goal_id === activeGoal.id)
    : [];
  let sessionBinding: Record<string, unknown> | null = null;
  if (terminalSessionId) {
    terminalForBridge(db, workspace, terminalSessionId);
    const terminal = db.prepare(`
      SELECT ts.id, ts.workspace_id, ts.goal_id, ts.agent_id, ts.active_task_id, ts.provider,
             g.title AS goal_title, a.name AS agent_name, a.role AS agent_role,
             t.title AS task_title, t.status AS task_status
        FROM terminal_sessions ts
        LEFT JOIN goals g ON g.id = ts.goal_id
        LEFT JOIN agents a ON a.id = ts.agent_id
        LEFT JOIN tasks t ON t.id = ts.active_task_id
       WHERE ts.id = ? AND ts.workspace_id = ?
    `).get(terminalSessionId, workspaceId) as Record<string, unknown> | undefined;
    if (!terminal) throw new Error("Terminal does not belong to this workspace");
    sessionBinding = terminal;
  }
  return { workspace: { ...workspace }, project, agents, goals, tasks, activeGoal, activeTasks, sessionBinding };
}

export function createTerminalBridgeGoal(db: Database, input: TerminalBridgeGoalInput): TerminalBridgeGoalResult {
  const workspace = workspaceForBridge(db, input.workspaceId);
  const terminal = terminalForBridge(db, workspace, input.terminalSessionId);
  const title = redactTerminalText(input.title?.trim() ?? "", MAX_TITLE_LEN);
  const description = redactTerminalText(input.description?.trim() ?? "", MAX_DESC_LEN);
  if (!title) throw new Error("Goal title is required");
  if (!input.clientRequestId?.trim() || input.clientRequestId.length > 120) {
    throw new Error("clientRequestId is required (max 120 characters)");
  }
  const priority = PRIORITIES.has(input.priority ?? "medium") ? input.priority ?? "medium" : "medium";
  const taskInputs = (input.tasks ?? []).slice(0, 50);
  for (const task of taskInputs) {
    if (!task.title?.trim()) throw new Error("Every task requires a title");
  }

  const existing = db.prepare(`
    SELECT result FROM terminal_bridge_events
     WHERE workspace_id = ? AND terminal_session_id = ? AND client_request_id = ?
  `).get(workspace.id, terminal.id, input.clientRequestId.trim()) as { result: string } | undefined;
  if (existing) return { ...(JSON.parse(existing.result) as TerminalBridgeGoalResult), replayed: true };
  if (terminal.active_task_id) {
    const bound = db.prepare("SELECT status FROM tasks WHERE id = ? AND project_id = ?")
      .get(terminal.active_task_id, workspace.project_id) as { status: TaskStatus } | undefined;
    if (bound && ["in_progress", "in_review", "blocked"].includes(bound.status)) {
      throw new Error("Complete or release the terminal's active task before creating another goal");
    }
  }

  const transaction = db.transaction(() => {
    const sortOrder = (db.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM goals WHERE project_id = ?",
    ).get(workspace.project_id) as { next: number }).next;
    const insertedGoal = db.prepare(`
      INSERT INTO goals (
        project_id, title, description, priority, sort_order, goal_model,
        spec_approval_required, origin_workspace_id
      ) VALUES (?, ?, ?, ?, ?, 'goal_as_unit', 0, ?)
      RETURNING *
    `).get(workspace.project_id, title, description, priority, sortOrder, workspace.id) as Record<string, unknown>;
    const goalId = String(insertedGoal.id);
    db.prepare("UPDATE workspaces SET active_goal_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(goalId, workspace.id);
    db.prepare(`
      UPDATE terminal_sessions SET goal_id = ?, active_task_id = NULL
       WHERE id = ? AND workspace_id = ? AND status = 'active'
    `).run(goalId, terminal.id, workspace.id);
    const createdTasks: Array<Record<string, unknown>> = [];
    taskInputs.forEach((task, index) => {
      const assigneeId = resolveAssignee(db, workspace.project_id, task);
      const created = db.prepare(`
        INSERT INTO tasks (
          goal_id, project_id, title, description, assignee_id, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?)
        RETURNING *
      `).get(
        goalId,
        workspace.project_id,
        redactTerminalText(task.title.trim(), MAX_TITLE_LEN),
        redactTerminalText(task.description?.trim() ?? "", MAX_DESC_LEN),
        assigneeId,
        index,
      ) as Record<string, unknown>;
      createdTasks.push(created);
    });
    const goalWorkspaceId = upsertGoalWorkspace(db, goalId);
    db.prepare(`
      INSERT INTO activities (project_id, type, message)
      VALUES (?, 'goal_created', ?)
    `).run(workspace.project_id, redactTerminalText(`[terminal] 목표 생성: ${title}`, 400));
    const result: TerminalBridgeGoalResult = {
      goal: insertedGoal,
      tasks: createdTasks,
      workspaceId: goalWorkspaceId,
      replayed: false,
    };
    db.prepare(`
      INSERT INTO terminal_bridge_events (
        workspace_id, terminal_session_id, client_request_id, kind, payload, result
      ) VALUES (?, ?, ?, 'goal_created', ?, ?)
    `).run(
      workspace.id,
      terminal.id,
      input.clientRequestId.trim(),
      JSON.stringify(redactTerminalValue(input)),
      JSON.stringify(redactTerminalValue(result)),
    );
    return result;
  });
  return transaction();
}

export function createTerminalBridgeTask(
  db: Database,
  input: { workspaceId: string; terminalSessionId: string; clientRequestId: string; goalId: string; task: TerminalBridgeTaskInput },
): Record<string, unknown> & { replayed: boolean } {
  const workspace = workspaceForBridge(db, input.workspaceId);
  const terminal = terminalForBridge(db, workspace, input.terminalSessionId);
  if (!input.clientRequestId?.trim() || input.clientRequestId.length > 120) throw new Error("clientRequestId is required");
  const existing = db.prepare(`
    SELECT result FROM terminal_bridge_events
     WHERE workspace_id = ? AND terminal_session_id = ? AND client_request_id = ?
  `).get(workspace.id, terminal.id, input.clientRequestId.trim()) as { result: string } | undefined;
  if (existing) return { ...(JSON.parse(existing.result) as Record<string, unknown>), replayed: true };
  if (workspace.active_goal_id !== input.goalId || terminal.goal_id !== input.goalId) {
    throw new Error("Goal is not active in this terminal workspace");
  }
  const goal = db.prepare("SELECT id FROM goals WHERE id = ? AND project_id = ?").get(input.goalId, workspace.project_id);
  if (!goal) throw new Error("Goal not found in this project");
  const taskTitle = redactTerminalText(input.task.title?.trim() ?? "", MAX_TITLE_LEN);
  const taskDescription = redactTerminalText(input.task.description?.trim() ?? "", MAX_DESC_LEN);
  if (!taskTitle) throw new Error("Task title is required");
  const result = db.transaction(() => {
    const next = (db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tasks WHERE goal_id = ?")
      .get(input.goalId) as { next: number }).next;
    const task = db.prepare(`
      INSERT INTO tasks (goal_id, project_id, title, description, assignee_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      input.goalId,
      workspace.project_id,
      taskTitle,
      taskDescription,
      resolveAssignee(db, workspace.project_id, input.task),
      next,
    ) as Record<string, unknown>;
    const response = { task, replayed: false };
    updateGoalProgress(db, input.goalId);
    db.prepare(`
      INSERT INTO terminal_bridge_events (
        workspace_id, terminal_session_id, client_request_id, kind, payload, result
      ) VALUES (?, ?, ?, 'task_created', ?, ?)
    `).run(
      workspace.id,
      terminal.id,
      input.clientRequestId.trim(),
      JSON.stringify(redactTerminalValue(input)),
      JSON.stringify(redactTerminalValue(response)),
    );
    return response;
  })();
  return result;
}

export function updateTerminalBridgeTask(
  db: Database,
  input: {
    workspaceId: string;
    terminalSessionId: string;
    clientRequestId: string;
    taskId: string;
    status: TaskStatus;
    summary?: string;
    allowInactiveTerminal?: boolean;
  },
): Record<string, unknown> & { replayed: boolean } {
  const workspace = workspaceForBridge(db, input.workspaceId);
  const terminal = terminalForBridge(db, workspace, input.terminalSessionId, {
    allowInactive: input.allowInactiveTerminal,
  });
  if (!input.clientRequestId?.trim() || input.clientRequestId.length > 120) throw new Error("clientRequestId is required");
  if (!STATUSES.has(input.status)) throw new Error("Invalid task status");
  const existingEvent = db.prepare(`
    SELECT result FROM terminal_bridge_events
     WHERE workspace_id = ? AND terminal_session_id = ? AND client_request_id = ?
  `).get(workspace.id, terminal.id, input.clientRequestId.trim()) as { result: string } | undefined;
  if (existingEvent) return { ...(JSON.parse(existingEvent.result) as Record<string, unknown>), replayed: true };
  const existing = db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
    .get(input.taskId, workspace.project_id) as Record<string, unknown> | undefined;
  if (!existing) throw new Error("Task not found in this project");
  const taskGoalId = String(existing.goal_id ?? "");
  if (!taskGoalId || workspace.active_goal_id !== taskGoalId || terminal.goal_id !== taskGoalId) {
    throw new Error("Task goal is not active in this terminal workspace");
  }
  const current = existing.status as TaskStatus;
  if (current !== input.status && !TRANSITIONS[current]?.includes(input.status)) {
    throw new Error(`Cannot transition task from ${current} to ${input.status}`);
  }
  if (terminal.active_task_id && terminal.active_task_id !== input.taskId) {
    const bound = db.prepare("SELECT status FROM tasks WHERE id = ? AND project_id = ?")
      .get(terminal.active_task_id, workspace.project_id) as { status: TaskStatus } | undefined;
    if (input.status !== "in_progress" || (bound && ["in_progress", "in_review", "blocked"].includes(bound.status))) {
      throw new Error("Task does not belong to this terminal's active execution");
    }
  } else if (!terminal.active_task_id && input.status !== "in_progress" && current !== input.status) {
    throw new Error("Claim the task in this terminal before updating its lifecycle");
  }
  const summary = input.summary == null ? null : redactTerminalText(input.summary, MAX_DESC_LEN);
  return db.transaction(() => {
    const task = db.prepare(`
      UPDATE tasks
         SET status = ?, result_summary = COALESCE(?, result_summary), updated_at = datetime('now')
       WHERE id = ?
       RETURNING *
    `).get(input.status, summary, input.taskId) as Record<string, unknown>;
    if (input.status === "in_progress") {
      db.prepare(`
        UPDATE terminal_sessions SET active_task_id = ?
         WHERE id = ? AND workspace_id = ? AND status = 'active'
      `).run(input.taskId, terminal.id, workspace.id);
    }
    updateGoalProgress(db, String(task.goal_id));
    const evidence = input.status === "in_review" || input.status === "done" || input.status === "blocked"
      ? collectWorkspaceEvidence(workspace.worktree_path)
      : null;
    const response = { task, evidence, replayed: false };
    db.prepare(`
      INSERT INTO terminal_bridge_events (
        workspace_id, terminal_session_id, client_request_id, kind, payload, result
      ) VALUES (?, ?, ?, 'task_updated', ?, ?)
    `).run(
      workspace.id,
      terminal.id,
      input.clientRequestId.trim(),
      JSON.stringify(redactTerminalValue({
        workspaceId: input.workspaceId,
        terminalSessionId: input.terminalSessionId,
        clientRequestId: input.clientRequestId,
        taskId: input.taskId,
        status: input.status,
        summary,
      })),
      JSON.stringify(redactTerminalValue(response)),
    );
    return response;
  })();
}

export function finishTerminalBridgeAgentRun(
  db: Database,
  input: {
    workspaceId: string;
    terminalSessionId: string;
    clientRequestId: string;
    provider: string;
    exitCode: number;
    interrupted?: boolean;
  },
): (Record<string, unknown> & { replayed: boolean }) | { task: null; replayed: false } {
  const workspace = workspaceForBridge(db, input.workspaceId);
  if (!input.terminalSessionId?.trim()) throw new Error("terminalSessionId is required");
  if (!Number.isInteger(input.exitCode)) throw new Error("exitCode must be an integer");
  // Process exit reconciliation runs after TerminalManager has atomically
  // marked the row exited/killed and revoked its token. Ownership must still
  // match, but this internal cleanup path intentionally accepts inactive rows.
  terminalForBridge(db, workspace, input.terminalSessionId, { allowInactive: true });

  const rows = db.prepare(
    "SELECT result FROM terminal_bridge_events "
    + "WHERE workspace_id = ? AND terminal_session_id = ? AND kind = 'task_updated' "
    + "ORDER BY created_at DESC, rowid DESC LIMIT 100",
  ).all(workspace.id, input.terminalSessionId) as Array<{ result: string }>;
  for (const row of rows) {
    const result = parseJson(row.result);
    const eventTask = result.task as Record<string, unknown> | undefined;
    if (!eventTask?.id) continue;
    const task = db.prepare("SELECT id, status FROM tasks WHERE id = ? AND project_id = ?")
      .get(String(eventTask.id), workspace.project_id) as { id: string; status: TaskStatus } | undefined;
    if (!task || (task.status !== "in_progress" && task.status !== "in_review")) continue;
    const provider = redactTerminalText(input.provider?.trim() ?? "", 40) || "AI agent";
    const summary = input.interrupted
      ? provider + " was interrupted before completing the required Crewdeck lifecycle"
      : input.exitCode === 0
      ? provider + " exited before completing the required Crewdeck lifecycle"
      : provider + " exited with code " + input.exitCode + " before completing the required Crewdeck lifecycle";
    return updateTerminalBridgeTask(db, {
      workspaceId: workspace.id,
      terminalSessionId: input.terminalSessionId,
      clientRequestId: input.clientRequestId,
      taskId: task.id,
      status: "blocked",
      summary,
      allowInactiveTerminal: true,
    });
  }
  return { task: null, replayed: false };
}
