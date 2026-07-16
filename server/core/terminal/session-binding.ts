import type { Database } from "better-sqlite3";
import type { AgentProvider, TaskStatus, TerminalDecision, TerminalSession } from "../../../shared/types.js";
import { updateTerminalBridgeTask } from "./bridge.js";

interface SessionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  status: string;
  goal_id: string | null;
  agent_id: string | null;
  active_task_id: string | null;
  provider: AgentProvider | null;
}

interface TaskRow {
  id: string;
  goal_id: string;
  project_id: string;
  assignee_id: string | null;
  status: TaskStatus;
  depends_on: string | null;
}

function sessionRow(db: Database, terminalId: string): SessionRow {
  const row = db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(terminalId) as SessionRow | undefined;
  if (!row) throw new Error("Terminal not found");
  return row;
}

function activeSessionRow(db: Database, terminalId: string): SessionRow {
  const row = sessionRow(db, terminalId);
  if (row.status !== "active") throw new Error("Terminal is not active");
  return row;
}

function recordByProject(
  db: Database,
  table: "goals" | "agents" | "tasks",
  id: string,
  projectId: string,
): Record<string, unknown> {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`).get(id, projectId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`${table.slice(0, -1)} does not belong to this terminal project`);
  return row;
}

function normalizeProvider(value: unknown): AgentProvider | null {
  if (value == null || value === "") return null;
  if (value !== "claude" && value !== "codex") throw new Error("provider must be claude or codex");
  return value;
}

export interface TerminalBindingInput {
  goalId?: string | null;
  agentId?: string | null;
  taskId?: string | null;
  provider?: AgentProvider | null;
}

export function bindTerminalSession(
  db: Database,
  terminalId: string,
  input: TerminalBindingInput,
): void {
  const session = activeSessionRow(db, terminalId);
  let goalId = input.goalId === undefined ? session.goal_id : input.goalId;
  let agentId = input.agentId === undefined ? session.agent_id : input.agentId;
  const taskId = input.taskId === undefined ? session.active_task_id : input.taskId;
  const provider = input.provider === undefined ? session.provider : normalizeProvider(input.provider);

  if (goalId) recordByProject(db, "goals", goalId, session.project_id);
  if (agentId) {
    const agent = recordByProject(db, "agents", agentId, session.project_id);
    if (agent.status === "terminated") throw new Error("Agent is terminated");
  }
  if (taskId) {
    const task = recordByProject(db, "tasks", taskId, session.project_id) as unknown as TaskRow;
    if (goalId && task.goal_id !== goalId) throw new Error("Task does not belong to the selected goal");
    goalId = task.goal_id;
    if (agentId && task.assignee_id && task.assignee_id !== agentId) {
      throw new Error("Task is assigned to another agent");
    }
    if (!agentId && task.assignee_id) agentId = task.assignee_id;
  }

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE terminal_sessions
         SET goal_id = ?, agent_id = ?, active_task_id = ?, provider = ?
       WHERE id = ?
    `).run(goalId, agentId, taskId, provider, terminalId);
    if (goalId) {
      db.prepare("UPDATE workspaces SET active_goal_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(goalId, session.workspace_id);
    }
    if (taskId && agentId) {
      db.prepare("UPDATE tasks SET assignee_id = COALESCE(assignee_id, ?), updated_at = datetime('now') WHERE id = ?")
        .run(agentId, taskId);
    }
  });
  update();
}

function dependenciesDone(db: Database, task: TaskRow): boolean {
  let dependencies: string[] = [];
  try {
    const parsed = JSON.parse(task.depends_on ?? "[]");
    if (Array.isArray(parsed)) dependencies = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return false;
  }
  if (dependencies.length === 0) return true;
  const placeholders = dependencies.map(() => "?").join(",");
  const row = db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE id IN (${placeholders}) AND status != 'done'`)
    .get(...dependencies) as { count: number };
  return row.count === 0;
}

export function claimNextTerminalTask(
  db: Database,
  terminalId: string,
  input: Omit<TerminalBindingInput, "taskId"> = {},
): Record<string, unknown> {
  const session = activeSessionRow(db, terminalId);
  const goalId = input.goalId ?? session.goal_id;
  const agentId = input.agentId === undefined ? session.agent_id : input.agentId;
  const provider = input.provider === undefined ? session.provider : normalizeProvider(input.provider);
  if (!goalId) throw new Error("Select a goal before claiming a task");
  recordByProject(db, "goals", goalId, session.project_id);
  if (agentId) recordByProject(db, "agents", agentId, session.project_id);

  if (session.active_task_id) {
    const current = recordByProject(db, "tasks", session.active_task_id, session.project_id);
    if (["in_progress", "in_review", "blocked"].includes(String(current.status))) return current;
  }

  const candidates = db.prepare(`
    SELECT * FROM tasks
     WHERE project_id = ? AND goal_id = ? AND status = 'todo'
       AND parent_task_id IS NULL
       AND (? IS NULL OR assignee_id IS NULL OR assignee_id = ?)
       AND id NOT IN (
         SELECT active_task_id FROM terminal_sessions
          WHERE status = 'active' AND active_task_id IS NOT NULL AND id != ?
       )
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
              sort_order, created_at
  `).all(session.project_id, goalId, agentId, agentId, terminalId) as TaskRow[];
  const task = candidates.find((candidate) => dependenciesDone(db, candidate));
  if (!task) throw new Error("No ready task is available for this goal and agent");
  const claimedAgentId = agentId ?? task.assignee_id;

  const claim = db.transaction(() => {
    const result = db.prepare(`
      UPDATE tasks
         SET status = 'in_progress', assignee_id = COALESCE(assignee_id, ?),
             started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
       WHERE id = ? AND status = 'todo'
    `).run(claimedAgentId, task.id);
    if (result.changes !== 1) throw new Error("Task was claimed by another session");
    db.prepare(`
      UPDATE terminal_sessions
         SET goal_id = ?, agent_id = ?, active_task_id = ?, provider = ?
       WHERE id = ?
    `).run(goalId, claimedAgentId, task.id, provider, terminalId);
    db.prepare("UPDATE workspaces SET active_goal_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(goalId, session.workspace_id);
    if (claimedAgentId) {
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?")
        .run(task.id, claimedAgentId);
    }
    return recordByProject(db, "tasks", task.id, session.project_id);
  });
  return claim();
}

/**
 * claim 직후 터미널의 에이전트 REPL에 주입하는 착수 지시 한 줄.
 * TERMINAL_AGENT_PROMPT 계약(crewdeck_get_context 우선)과 같은 언어(영어)로 작성한다.
 */
export function composeTaskKickoffMessage(task: { id?: unknown; title?: unknown }): string {
  const title = String(task.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const id = String(task.id ?? "").trim();
  return `[Crewdeck] Task assigned to this terminal: "${title}" (task ${id}, already in_progress). Call crewdeck_get_context to confirm the binding, then start working on this task now.`;
}

export function listTerminalDecisions(db: Database, workspaceId: string, goalId?: string): TerminalDecision[] {
  const rows = db.prepare(`
    SELECT id, workspace_id, terminal_session_id, goal_id, task_id, agent_id, message, created_at
      FROM terminal_decisions
     WHERE workspace_id = ? AND (? IS NULL OR goal_id = ?)
     ORDER BY created_at DESC, rowid DESC LIMIT 100
  `).all(workspaceId, goalId ?? null, goalId ?? null) as Array<{
    id: string; workspace_id: string; terminal_session_id: string; goal_id: string | null;
    task_id: string | null; agent_id: string | null; message: string; created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    terminalSessionId: row.terminal_session_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    message: row.message,
    createdAt: row.created_at,
  }));
}

export function recordTerminalDecision(
  db: Database,
  terminalId: string,
  messageInput: string,
): { decision: TerminalDecision; task: Record<string, unknown> | null } {
  const session = activeSessionRow(db, terminalId);
  const message = messageInput.trim().slice(0, 4_000);
  if (!message) throw new Error("Decision message is required");
  const result = db.transaction(() => {
    const row = db.prepare(`
      INSERT INTO terminal_decisions (
        workspace_id, terminal_session_id, goal_id, task_id, agent_id, message
      ) VALUES (?, ?, ?, ?, ?, ?) RETURNING *
    `).get(
      session.workspace_id,
      terminalId,
      session.goal_id,
      session.active_task_id,
      session.agent_id,
      message,
    ) as { id: string; workspace_id: string; terminal_session_id: string; goal_id: string | null; task_id: string | null; agent_id: string | null; message: string; created_at: string };
    let task: Record<string, unknown> | null = null;
    if (session.active_task_id) {
      db.prepare(`
        UPDATE tasks SET status = CASE WHEN status = 'blocked' THEN 'in_progress' ELSE status END,
                         updated_at = datetime('now')
         WHERE id = ?
      `).run(session.active_task_id);
      task = recordByProject(db, "tasks", session.active_task_id, session.project_id);
    }
    if (session.agent_id) {
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?")
        .run(session.active_task_id, session.agent_id);
    }
    return {
      decision: {
        id: row.id,
        workspaceId: row.workspace_id,
        terminalSessionId: row.terminal_session_id,
        goalId: row.goal_id,
        taskId: row.task_id,
        agentId: row.agent_id,
        message: row.message,
        createdAt: row.created_at,
      },
      task,
    };
  });
  return result();
}

export function requestTerminalTaskCompletion(
  db: Database,
  terminalId: string,
  summary: string,
): ReturnType<typeof updateTerminalBridgeTask> {
  const session = activeSessionRow(db, terminalId);
  if (!session.active_task_id) throw new Error("This terminal has no active task");
  const result = updateTerminalBridgeTask(db, {
    workspaceId: session.workspace_id,
    terminalSessionId: terminalId,
    clientRequestId: `terminal-completion-${terminalId}-${Date.now()}`,
    taskId: session.active_task_id,
    status: "in_review",
    summary: summary.trim().slice(0, 4_000) || "Terminal agent requested Quality Gate review",
  });
  if (session.agent_id) {
    db.prepare("UPDATE agents SET status = 'waiting_approval' WHERE id = ?").run(session.agent_id);
  }
  return result;
}

export function terminalBindingContext(db: Database, terminalId: string): TerminalSession | null {
  const session = sessionRow(db, terminalId);
  const goal = session.goal_id
    ? db.prepare("SELECT title FROM goals WHERE id = ?").get(session.goal_id) as { title: string } | undefined
    : undefined;
  const agent = session.agent_id
    ? db.prepare("SELECT name, role FROM agents WHERE id = ?").get(session.agent_id) as { name: string; role: string } | undefined
    : undefined;
  const task = session.active_task_id
    ? db.prepare("SELECT title, status FROM tasks WHERE id = ?").get(session.active_task_id) as { title: string; status: TaskStatus } | undefined
    : undefined;
  return {
    id: session.id,
    tabNumber: 0,
    workspaceId: session.workspace_id,
    projectId: session.project_id,
    shell: "",
    cwd: "",
    pid: null,
    cols: 0,
    rows: 0,
    status: session.status as TerminalSession["status"],
    exitCode: null,
    output: "",
    startedAt: "",
    endedAt: null,
    backend: "pty",
    contextState: "connected",
    goalId: session.goal_id,
    goalTitle: goal?.title ?? null,
    agentId: session.agent_id,
    agentName: agent?.name ?? null,
    agentRole: agent?.role ?? null,
    activeTaskId: session.active_task_id,
    activeTaskTitle: task?.title ?? null,
    activeTaskStatus: task?.status ?? null,
    provider: session.provider,
  };
}
