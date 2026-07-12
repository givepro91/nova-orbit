import type { Database } from "better-sqlite3";
import type { AgentHandoff, AgentHandoffStage } from "../../../shared/types.js";
import {
  validateAgentHandoff,
  type AgentHandoffDiagnostic,
} from "./handoff.js";

interface HandoffCandidateRow {
  id: number;
  goal_id: string;
  task_id: string | null;
  session_id: string;
  contract_version: number;
  stage: string;
  payload: string;
  created_at: string;
}

export interface RequiredAgentHandoff {
  id: number;
  sessionId: string;
  createdAt: string;
  handoff: AgentHandoff;
}

export class AgentHandoffConsumptionError extends Error {
  constructor(
    public phase: AgentHandoffStage,
    public diagnostics: AgentHandoffDiagnostic[],
  ) {
    super(`Cannot start ${phase}: ${diagnostics.map((diagnostic) => `${diagnostic.field}: ${diagnostic.message}`).join("; ")}`);
    this.name = "AgentHandoffConsumptionError";
  }
}

function invalidValue(field: string, message: string): AgentHandoffDiagnostic {
  return { field, code: "invalid_value", message };
}

/**
 * Loads and strictly validates the immediately preceding task handoff.
 * The newest row is authoritative: a malformed newer row blocks execution
 * instead of silently falling back to an older, stale handoff.
 */
export function loadRequiredAgentHandoff(
  db: Database,
  input: {
    goalId: string;
    taskId: string | null;
    phase: AgentHandoffStage;
    expectedStages: readonly AgentHandoffStage[];
  },
): RequiredAgentHandoff {
  const taskScope = input.taskId === null
    ? "handoff.task_id IS NULL AND session.task_id IS NULL"
    : "handoff.task_id = ? AND task.id = handoff.task_id AND task.goal_id = handoff.goal_id AND session.task_id = handoff.task_id";
  const row = db.prepare(`
    SELECT handoff.*
    FROM agent_handoffs AS handoff
    JOIN sessions AS session ON session.id = handoff.session_id
    LEFT JOIN tasks AS task ON task.id = handoff.task_id
    WHERE handoff.goal_id = ?
      AND ${taskScope}
    ORDER BY handoff.id DESC
    LIMIT 1
  `).get(...(input.taskId === null ? [input.goalId] : [input.goalId, input.taskId])) as HandoffCandidateRow | undefined;

  if (!row) {
    throw new AgentHandoffConsumptionError(input.phase, [{
      field: "$",
      code: "missing_field",
      message: `Required preceding handoff (${input.expectedStages.join(" | ")}) was not found.`,
    }]);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new AgentHandoffConsumptionError(input.phase, [invalidValue("$", "Handoff payload is not valid JSON.")]);
  }

  const validation = validateAgentHandoff(payload);
  if (!validation.success) {
    throw new AgentHandoffConsumptionError(input.phase, validation.diagnostics);
  }

  const diagnostics: AgentHandoffDiagnostic[] = [];
  if (validation.data.version !== row.contract_version) {
    diagnostics.push(invalidValue(
      "version",
      `Handoff payload version '${validation.data.version}' does not match stored contract version '${row.contract_version}'.`,
    ));
  }
  if (validation.data.stage !== row.stage) {
    diagnostics.push(invalidValue(
      "stage",
      `Handoff payload stage '${validation.data.stage}' does not match stored stage '${row.stage}'.`,
    ));
  }
  if (!input.expectedStages.includes(validation.data.stage)) {
    diagnostics.push(invalidValue(
      "stage",
      `Handoff stage '${validation.data.stage}' cannot precede '${input.phase}'; expected ${input.expectedStages.join(" | ")}.`,
    ));
  }
  if (diagnostics.length > 0) {
    throw new AgentHandoffConsumptionError(input.phase, diagnostics);
  }

  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    handoff: validation.data,
  };
}

/** Provider-neutral prompt block shared by Claude and Codex adapters. */
export function formatConsumedAgentHandoff(required: RequiredAgentHandoff): string {
  return `
## Previous stage handoff (authoritative)
Use this structured handoff instead of inferring context from prior conversation.
\`\`\`json
${JSON.stringify(required.handoff, null, 2)}
\`\`\`
`;
}

/** Persists a pre-spawn failure without creating a provider subprocess. */
export function recordHandoffPreflightFailure(
  db: Database,
  input: {
    projectId: string;
    goalId: string;
    taskId: string;
    agentId: string;
    phase: AgentHandoffStage;
    error: AgentHandoffConsumptionError;
  },
): string {
  const metadata = JSON.stringify({
    goalId: input.goalId,
    taskId: input.taskId,
    phase: input.phase,
    diagnostics: input.error.diagnostics,
  });
  return db.transaction(() => {
    const session = db.prepare(`
      INSERT INTO sessions (agent_id, task_id, status, ended_at, last_output)
      VALUES (?, ?, 'failed', datetime('now'), ?)
      RETURNING id
    `).get(input.agentId, input.taskId, metadata) as { id: string };
    db.prepare("UPDATE tasks SET status = 'blocked', updated_at = datetime('now') WHERE id = ?")
      .run(input.taskId);
    db.prepare(`
      INSERT INTO activities (project_id, agent_id, type, message, metadata)
      VALUES (?, ?, 'handoff_validation_failed', ?, ?)
    `).run(
      input.projectId,
      input.agentId,
      input.error.message.slice(0, 500),
      metadata,
    );
    return session.id;
  })();
}
