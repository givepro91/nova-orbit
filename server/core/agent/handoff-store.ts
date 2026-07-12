import type { Database } from "better-sqlite3";
import type { AgentHandoff, AgentHandoffStage } from "../../../shared/types.js";
import {
  validateAgentHandoff,
  type AgentHandoffDiagnostic,
} from "./handoff.js";

export interface SaveAgentHandoffInput {
  goalId: string;
  taskId?: string | null;
  sessionId: string;
  handoff: unknown;
}

export interface LatestAgentHandoffQuery {
  goalId: string;
  taskId?: string;
  stage?: AgentHandoffStage;
}

export interface StoredAgentHandoff {
  id: number;
  goalId: string;
  taskId: string | null;
  sessionId: string;
  createdAt: string;
  handoff: AgentHandoff;
}

export class AgentHandoffPersistenceError extends Error {
  constructor(
    public code: "invalid_handoff" | "goal_not_found" | "task_goal_mismatch" | "session_not_found" | "session_goal_mismatch" | "session_task_mismatch",
    message: string,
    public diagnostics: AgentHandoffDiagnostic[] = [],
  ) {
    super(message);
    this.name = "AgentHandoffPersistenceError";
  }
}

type SessionRow = { task_id: string | null; project_id: string };
type HandoffRow = {
  id: number;
  goal_id: string;
  task_id: string | null;
  session_id: string;
  contract_version: number;
  stage: string;
  payload: string;
  created_at: string;
};

/** Persists one validated execution result, correlated to its session and task. */
export function saveAgentHandoff(
  db: Database,
  input: SaveAgentHandoffInput,
): StoredAgentHandoff {
  const validation = validateAgentHandoff(input.handoff);
  if (!validation.success) {
    throw new AgentHandoffPersistenceError(
      "invalid_handoff",
      "Agent handoff failed contract validation.",
      validation.diagnostics,
    );
  }

  const save = db.transaction((): StoredAgentHandoff => {
    const goal = db.prepare("SELECT id FROM goals WHERE id = ?").get(input.goalId);
    if (!goal) {
      throw new AgentHandoffPersistenceError("goal_not_found", `Goal '${input.goalId}' was not found.`);
    }

    const session = db.prepare(`
      SELECT sessions.task_id, agents.project_id
      FROM sessions
      JOIN agents ON agents.id = sessions.agent_id
      WHERE sessions.id = ?
    `)
      .get(input.sessionId) as SessionRow | undefined;
    if (!session) {
      throw new AgentHandoffPersistenceError("session_not_found", `Session '${input.sessionId}' was not found.`);
    }
    const goalProject = db.prepare("SELECT project_id FROM goals WHERE id = ?")
      .get(input.goalId) as { project_id: string };
    if (session.project_id !== goalProject.project_id) {
      throw new AgentHandoffPersistenceError(
        "session_goal_mismatch",
        `Session '${input.sessionId}' does not belong to goal '${input.goalId}' project.`,
      );
    }

    const taskId = input.taskId ?? session.task_id;
    if (taskId) {
      const task = db.prepare("SELECT goal_id FROM tasks WHERE id = ?")
        .get(taskId) as { goal_id: string } | undefined;
      if (!task || task.goal_id !== input.goalId) {
        throw new AgentHandoffPersistenceError(
          "task_goal_mismatch",
          `Task '${taskId}' does not belong to goal '${input.goalId}'.`,
        );
      }
    }
    if (session.task_id !== (taskId ?? null)) {
      throw new AgentHandoffPersistenceError(
        "session_task_mismatch",
        `Session '${input.sessionId}' belongs to task '${session.task_id}', not '${taskId ?? "none"}'.`,
      );
    }

    const result = db.prepare(`
      INSERT INTO agent_handoffs
        (goal_id, task_id, session_id, contract_version, stage, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.goalId,
      taskId ?? null,
      input.sessionId,
      validation.data.version,
      validation.data.stage,
      JSON.stringify(validation.data),
    );

    const row = db.prepare("SELECT * FROM agent_handoffs WHERE id = ?")
      .get(result.lastInsertRowid) as HandoffRow;
    return serializeValidRow(row, validation.data);
  });

  return save();
}

/**
 * Returns the newest contract-valid handoff for a goal and optional task/stage.
 * Invalid legacy/corrupt rows are skipped instead of hiding an earlier valid result.
 */
export function getLatestValidAgentHandoff(
  db: Database,
  query: LatestAgentHandoffQuery,
): StoredAgentHandoff | null {
  const clauses = ["goal_id = ?"];
  const params: unknown[] = [query.goalId];
  if (query.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(query.taskId);
  }
  if (query.stage !== undefined) {
    clauses.push("stage = ?");
    params.push(query.stage);
  }

  const rows = db.prepare(`
    SELECT handoff.*
    FROM agent_handoffs AS handoff
    JOIN goals AS goal ON goal.id = handoff.goal_id
    JOIN sessions AS session ON session.id = handoff.session_id
    JOIN agents AS agent ON agent.id = session.agent_id
    LEFT JOIN tasks AS task ON task.id = handoff.task_id
    WHERE ${clauses.map((clause) => `handoff.${clause}`).join(" AND ")}
      AND agent.project_id = goal.project_id
      AND (
        (handoff.task_id IS NULL AND session.task_id IS NULL)
        OR (
          handoff.task_id IS NOT NULL
          AND task.goal_id = handoff.goal_id
          AND session.task_id = handoff.task_id
        )
      )
    ORDER BY handoff.id DESC
  `).all(...params) as HandoffRow[];

  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const validation = validateAgentHandoff(payload);
    if (
      validation.success
      && validation.data.version === row.contract_version
      && validation.data.stage === row.stage
    ) {
      return serializeValidRow(row, validation.data);
    }
  }
  return null;
}

function serializeValidRow(row: HandoffRow, handoff: AgentHandoff): StoredAgentHandoff {
  return {
    id: row.id,
    goalId: row.goal_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    handoff,
  };
}
