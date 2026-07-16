import type { Database } from "better-sqlite3";
import type { AgentProvider, TerminalActivity, TerminalActivityKind } from "../../../shared/types.js";
import {
  redactTerminalText,
  terminalSecretKey,
  TERMINAL_REDACTED,
} from "./redaction.js";

const ACTIVITY_KINDS = new Set<TerminalActivityKind>([
  "task_claimed",
  "provider_launch_requested",
  "provider_started",
  "command_finished",
  "file_changed",
  "verification_run",
  "blocked",
  "decision_recorded",
  "completion_requested",
  "quality_gate_result",
]);
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_METADATA_DEPTH = 6;
const MAX_COLLECTION_ITEMS = 100;
const MAX_STRING_LENGTH = 2_000;

interface TerminalActivityRow {
  id: string;
  idempotency_key: string;
  workspace_id: string;
  terminal_session_id: string;
  project_id: string;
  goal_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  provider: AgentProvider | null;
  kind: TerminalActivityKind;
  summary: string;
  metadata: string;
  created_at: string;
}

interface TerminalBindingRow {
  id: string;
  workspace_id: string;
  project_id: string;
  goal_id: string | null;
  agent_id: string | null;
  active_task_id: string | null;
  provider: AgentProvider | null;
  status: string;
  goal_project_id: string | null;
  task_project_id: string | null;
  task_goal_id: string | null;
  agent_project_id: string | null;
}

export interface CreateTerminalActivityInput {
  workspaceId: string;
  terminalSessionId: string;
  idempotencyKey: string;
  kind: TerminalActivityKind;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface ListTerminalActivitiesInput {
  workspaceId: string;
  goalId?: string;
  taskId?: string;
  terminalSessionId?: string;
  cursor?: string;
  limit?: number;
}

function sanitizeValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (depth > MAX_METADATA_DEPTH) throw new Error(`metadata exceeds maximum depth of ${MAX_METADATA_DEPTH}`);
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactTerminalText(value, MAX_STRING_LENGTH);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new Error("metadata must not contain circular references");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_ITEMS) throw new Error(`metadata arrays are limited to ${MAX_COLLECTION_ITEMS} items`);
      return value.map((item) => sanitizeValue(item, depth + 1, seen));
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_COLLECTION_ITEMS) throw new Error(`metadata objects are limited to ${MAX_COLLECTION_ITEMS} keys`);
    return Object.fromEntries(entries.map(([key, item]) => [
      key.slice(0, 200),
      terminalSecretKey(key) ? TERMINAL_REDACTED : sanitizeValue(item, depth + 1, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

export function sanitizeTerminalActivityMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata == null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("metadata must be a JSON object");
  const sanitized = sanitizeValue(metadata, 0, new Set()) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > MAX_METADATA_BYTES) {
    throw new Error(`metadata is limited to ${MAX_METADATA_BYTES} bytes`);
  }
  return sanitized;
}

function serialize(row: TerminalActivityRow): TerminalActivity {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    workspaceId: row.workspace_id,
    terminalSessionId: row.terminal_session_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    provider: row.provider,
    kind: row.kind,
    summary: row.summary,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function getBinding(db: Database, terminalSessionId: string): TerminalBindingRow {
  const row = db.prepare(`
    SELECT ts.id, ts.workspace_id, ts.project_id, ts.goal_id, ts.agent_id,
           ts.active_task_id, ts.provider, ts.status,
           g.project_id AS goal_project_id,
           t.project_id AS task_project_id, t.goal_id AS task_goal_id,
           a.project_id AS agent_project_id
      FROM terminal_sessions ts
      LEFT JOIN goals g ON g.id = ts.goal_id
      LEFT JOIN tasks t ON t.id = ts.active_task_id
      LEFT JOIN agents a ON a.id = ts.agent_id
     WHERE ts.id = ?
  `).get(terminalSessionId) as TerminalBindingRow | undefined;
  if (!row) throw new Error("Terminal not found");
  if (row.status !== "active") throw new Error("Terminal is not active");
  const inconsistent = (row.goal_id && row.goal_project_id !== row.project_id)
    || (row.active_task_id && (row.task_project_id !== row.project_id || row.task_goal_id !== row.goal_id))
    || (row.agent_id && row.agent_project_id !== row.project_id);
  if (inconsistent) throw new Error("Terminal binding is inconsistent");
  return row;
}

export function createTerminalActivity(
  db: Database,
  input: CreateTerminalActivityInput,
): { activity: TerminalActivity; replayed: boolean } {
  const idempotencyKey = input.idempotencyKey?.trim();
  if (!idempotencyKey || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new Error("idempotencyKey must be 1-128 URL-safe characters");
  }
  if (!ACTIVITY_KINDS.has(input.kind)) throw new Error("Unsupported terminal activity kind");
  const summary = redactTerminalText(input.summary?.trim() ?? "", MAX_STRING_LENGTH);
  if (!summary) throw new Error("summary is required");
  const metadata = sanitizeTerminalActivityMetadata(input.metadata);

  return db.transaction(() => {
    const binding = getBinding(db, input.terminalSessionId);
    if (binding.workspace_id !== input.workspaceId) throw new Error("Terminal does not belong to workspace");
    const existing = db.prepare(`
      SELECT * FROM terminal_activities
       WHERE terminal_session_id = ? AND idempotency_key = ?
    `).get(input.terminalSessionId, idempotencyKey) as TerminalActivityRow | undefined;
    if (existing) return { activity: serialize(existing), replayed: true };

    const id = db.prepare(`
      INSERT INTO terminal_activities (
        idempotency_key, workspace_id, terminal_session_id, project_id,
        goal_id, task_id, agent_id, provider, kind, summary, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      idempotencyKey,
      binding.workspace_id,
      binding.id,
      binding.project_id,
      binding.goal_id,
      binding.active_task_id,
      binding.agent_id,
      binding.provider,
      input.kind,
      summary,
      JSON.stringify(metadata),
    ) as { id: string };
    const inserted = db.prepare("SELECT * FROM terminal_activities WHERE id = ?").get(id.id) as TerminalActivityRow;
    return { activity: serialize(inserted), replayed: false };
  })();
}

export function listTerminalActivities(
  db: Database,
  input: ListTerminalActivitiesInput,
): { items: TerminalActivity[]; nextCursor: string | null } {
  if (!input.workspaceId) throw new Error("workspaceId is required");
  const workspace = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(input.workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  const limit = Math.min(100, Math.max(1, Number.isFinite(input.limit) ? Math.floor(input.limit!) : 50));
  const where = ["workspace_id = ?"];
  const params: unknown[] = [input.workspaceId];
  for (const [column, value] of [
    ["goal_id", input.goalId],
    ["task_id", input.taskId],
    ["terminal_session_id", input.terminalSessionId],
  ] as const) {
    if (value) { where.push(`${column} = ?`); params.push(value); }
  }
  if (input.cursor) {
    const cursor = db.prepare(`
      SELECT created_at, id FROM terminal_activities WHERE id = ? AND workspace_id = ?
    `).get(input.cursor, input.workspaceId) as { created_at: string; id: string } | undefined;
    if (!cursor) throw new Error("Invalid activity cursor");
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  const rows = db.prepare(`
    SELECT * FROM terminal_activities
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(...params, limit + 1) as TerminalActivityRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map(serialize),
    nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
  };
}
