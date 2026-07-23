import type { Database } from "better-sqlite3";
import type { AgentProvider, TaskStatus, TerminalDecision, TerminalSession } from "../../../shared/types.js";
import { updateTerminalBridgeTask } from "./bridge.js";
import { redactTerminalText } from "./redaction.js";

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

/** 터미널이 놓아주면 안 되는 진행 상태 — 이 상태의 바인딩을 바꾸면 completion이 엉뚱한 태스크로 간다. */
const IN_FLIGHT_TASK_STATUSES: readonly string[] = ["in_progress", "in_review", "blocked"];

function taskBoundToOtherTerminal(db: Database, taskId: string, terminalId: string): boolean {
  return db.prepare(`
    SELECT 1 FROM terminal_sessions
     WHERE status = 'active' AND active_task_id = ? AND id != ?
  `).get(taskId, terminalId) !== undefined;
}

/**
 * 헤드리스(오케스트레이션) 세션이 이 태스크를 실행 중인가.
 *
 * PTY 레인이 없으면 스케줄러가 헤드리스로 폴백한다(scheduler). 그 상태에서 진행 중인
 * 태스크를 터미널에 물리면 CLI 없는 빈 셸이 태스크를 쥔 것처럼 보이는데 실제 실행은
 * 백그라운드에서 따로 돌고, 어느 쪽도 상대를 모른다 — 사람 눈엔 "PTY 모드인데 빈 터미널"
 * 이고 드라이버 눈엔 "무출력 터미널"이라 멀쩡한 태스크가 스톨로 오판된다(2026-07-22 실측).
 * 소유자가 하나여야 그 혼선이 생기지 않으므로, 실행 중인 쪽이 놓을 때까지 붙이지 않는다.
 */
function taskRunningHeadless(db: Database, taskId: string): boolean {
  return db.prepare(`
    SELECT 1 FROM sessions
     WHERE task_id = ? AND status = 'active' AND origin = 'orchestration'
  `).get(taskId) !== undefined;
}

function assertTerminalNotBusy(db: Database, session: SessionRow, nextTaskId: string | null): void {
  if (!session.active_task_id || nextTaskId === session.active_task_id) return;
  const current = db.prepare("SELECT status FROM tasks WHERE id = ?")
    .get(session.active_task_id) as { status: string } | undefined;
  if (current && IN_FLIGHT_TASK_STATUSES.includes(current.status)) {
    throw new Error("Terminal is busy with its active task");
  }
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
    if (taskId !== session.active_task_id && taskBoundToOtherTerminal(db, taskId, terminalId)) {
      throw new Error("Task is already bound to another terminal");
    }
    if (taskId !== session.active_task_id && taskRunningHeadless(db, taskId)) {
      // 에러가 아니라 정보성 상태(태스크가 백그라운드에서 정상 실행 중)다. code 를 실어 보내
      // 프론트가 빨간 에러 배너 대신 중립 안내로 렌더하게 한다.
      const err = new Error("Task is running in the background — attach it to a terminal after that run finishes") as Error & { code?: string };
      err.code = "task_running_headless";
      throw err;
    }
  }
  assertTerminalNotBusy(db, session, taskId);

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
  const row = db.prepare(`SELECT COUNT(*) AS count FROM tasks WHERE id IN (${placeholders}) AND status NOT IN ('done', 'skipped')`)
    .get(...dependencies) as { count: number };
  return row.count === 0;
}

export function claimNextTerminalTask(
  db: Database,
  terminalId: string,
  input: TerminalBindingInput = {},
): Record<string, unknown> {
  const session = activeSessionRow(db, terminalId);
  const requestedTaskId = input.taskId ?? null;
  let goalId = input.goalId ?? session.goal_id;
  const agentId = input.agentId === undefined ? session.agent_id : input.agentId;
  const provider = input.provider === undefined ? session.provider : normalizeProvider(input.provider);
  if (agentId) recordByProject(db, "agents", agentId, session.project_id);

  if (session.active_task_id) {
    const current = recordByProject(db, "tasks", session.active_task_id, session.project_id);
    if (IN_FLIGHT_TASK_STATUSES.includes(String(current.status))) {
      if (requestedTaskId && requestedTaskId !== session.active_task_id) {
        throw new Error("Terminal is busy with its active task");
      }
      return current;
    }
  }

  let task: TaskRow | undefined;
  if (requestedTaskId) {
    // 사용자가 목록에서 지목한 태스크를 이 터미널로 수임한다 — 우선순위 큐를 타지 않는다.
    const requested = recordByProject(db, "tasks", requestedTaskId, session.project_id) as unknown as TaskRow;
    if (goalId && requested.goal_id !== goalId) throw new Error("Task does not belong to the selected goal");
    goalId = requested.goal_id;
    if (agentId && requested.assignee_id && requested.assignee_id !== agentId) {
      throw new Error("Task is assigned to another agent");
    }
    if (requested.status !== "todo") throw new Error("Task is not ready to start");
    if (taskBoundToOtherTerminal(db, requestedTaskId, terminalId)) {
      throw new Error("Task is already bound to another terminal");
    }
    if (!dependenciesDone(db, requested)) throw new Error("Task has unfinished dependencies");
    task = requested;
  } else {
    if (!goalId) throw new Error("Select a goal before claiming a task");
    recordByProject(db, "goals", goalId, session.project_id);
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
    task = candidates.find((candidate) => dependenciesDone(db, candidate));
  }
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

export interface TerminalTaskStartResult {
  task: Record<string, unknown>;
  provider: AgentProvider;
  launchKey: string;
  launchState: "requested" | "continued";
}

function preferredProvider(
  db: Database,
  session: SessionRow,
  inputProvider: AgentProvider | null | undefined,
): AgentProvider {
  const requested = inputProvider === undefined ? null : normalizeProvider(inputProvider);
  if (requested) return requested;
  if (session.provider) return session.provider;
  if (session.agent_id) {
    const agent = db.prepare("SELECT provider FROM agents WHERE id = ? AND project_id = ?")
      .get(session.agent_id, session.project_id) as { provider: AgentProvider | null } | undefined;
    if (agent?.provider) return agent.provider;
  }
  const project = db.prepare("SELECT default_provider FROM projects WHERE id = ?")
    .get(session.project_id) as { default_provider: AgentProvider | null } | undefined;
  return project?.default_provider ?? "claude";
}

/**
 * Claims/binds the next task and requests the provider command as one synchronous
 * API operation. The persisted task+provider binding is the idempotency lease:
 * repeating the same request returns `continued` without writing another CLI
 * command. `requested` only proves that the PTY accepted the command, not that the
 * provider became ready. A rejected write restores the task/session DB state.
 */
export function startNextTerminalTask(
  db: Database,
  terminalId: string,
  // taskId를 주면 우선순위 큐 대신 그 태스크를 수임한다 (검증은 claimNextTerminalTask가 수행).
  input: TerminalBindingInput,
  launchProvider: (provider: AgentProvider, launchKey: string) => boolean,
): TerminalTaskStartResult {
  const prepare = db.transaction(() => {
    const before = activeSessionRow(db, terminalId);
    const taskSnapshots = db.prepare(`
      SELECT id, status, assignee_id, started_at FROM tasks
       WHERE project_id = ? AND goal_id = ?
    `).all(before.project_id, input.goalId ?? before.goal_id) as Array<{
      id: string;
      status: TaskStatus;
      assignee_id: string | null;
      started_at: string | null;
    }>;
    const agentSnapshots = db.prepare(`
      SELECT id, status, current_task_id FROM agents WHERE project_id = ?
    `).all(before.project_id) as Array<{ id: string; status: string; current_task_id: string | null }>;
    const leasedTaskBefore = taskSnapshots.find((item) => item.id === before.active_task_id);
    if (leasedTaskBefore && ["in_progress", "in_review", "blocked"].includes(leasedTaskBefore.status)
      && before.provider && input.provider && before.provider !== input.provider) {
      throw new Error(`This task is already running with ${before.provider}`);
    }

    const task = claimNextTerminalTask(db, terminalId, input);
    const bound = activeSessionRow(db, terminalId);
    const provider = preferredProvider(db, bound, input.provider);
    const taskId = String(task.id ?? "");
    if (!taskId) throw new Error("Claimed task has no id");

    const taskBefore = taskSnapshots.find((item) => item.id === taskId) ?? null;
    const launchSuppressedByTaskState = taskBefore?.status === "in_review"
      || taskBefore?.status === "blocked";
    const launchRequired = !launchSuppressedByTaskState && (
      taskBefore?.status === "todo"
      || before.active_task_id !== taskId
      || before.provider !== provider
    );
    const launchKey = `${terminalId}:${taskId}:${provider}`;
    if (!launchSuppressedByTaskState) {
      db.prepare("UPDATE terminal_sessions SET provider = ? WHERE id = ?").run(provider, terminalId);
    }

    return {
      task,
      provider,
      launchKey,
      launchState: launchRequired ? "requested" as const : "continued" as const,
      before,
      launchRequired,
      taskBefore,
      agentBefore: agentSnapshots.find((item) => item.id === bound.agent_id) ?? null,
    };
  });
  const prepared = prepare();
  if (prepared.launchRequired && !launchProvider(prepared.provider, prepared.launchKey)) {
    db.transaction(() => {
      const taskId = String(prepared.task.id);
      if (prepared.taskBefore?.status === "todo") {
        db.prepare(`
          UPDATE tasks SET status = ?, assignee_id = ?, started_at = ?, updated_at = datetime('now')
           WHERE id = ? AND status = 'in_progress'
        `).run(
          prepared.taskBefore.status,
          prepared.taskBefore.assignee_id,
          prepared.taskBefore.started_at,
          taskId,
        );
        if (prepared.agentBefore) {
          db.prepare("UPDATE agents SET status = ?, current_task_id = ? WHERE id = ? AND current_task_id = ?")
            .run(
              prepared.agentBefore.status,
              prepared.agentBefore.current_task_id,
              prepared.agentBefore.id,
              taskId,
            );
        }
      }
      db.prepare(`
        UPDATE terminal_sessions
           SET goal_id = ?, agent_id = ?, active_task_id = ?, provider = ?
         WHERE id = ? AND active_task_id = ? AND provider = ?
      `).run(
        prepared.before.goal_id,
        prepared.before.agent_id,
        prepared.before.active_task_id,
        prepared.before.provider,
        terminalId,
        taskId,
        prepared.provider,
      );
      db.prepare("UPDATE workspaces SET active_goal_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(prepared.before.goal_id, prepared.before.workspace_id);
    })();
    throw new Error("Terminal provider launch failed before the task could start");
  }
  return {
    task: prepared.task,
    provider: prepared.provider,
    launchKey: prepared.launchKey,
    launchState: prepared.launchState,
  };
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
  const message = redactTerminalText(messageInput.trim(), 4_000);
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
    resumeState: null,
  };
}
