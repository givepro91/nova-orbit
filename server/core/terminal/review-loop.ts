import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  TerminalReviewEvidence,
  TerminalReviewRequest,
  TerminalReviewStatus,
  VerificationIssue,
  VerificationResult,
  VerificationScope,
} from "../../../shared/types.js";
import { AGENT_HANDOFF_CONTRACT_VERSION } from "../../../shared/types.js";
import { saveAgentHandoff } from "../agent/handoff-store.js";
import { redactTerminalText } from "./redaction.js";

const MAX_SUMMARY_LENGTH = 4_000;
const MAX_CHANGED_FILES = 100;
const MAX_FILE_LENGTH = 500;
const MAX_VERIFICATION_COMMANDS = 50;
const MAX_COMMAND_LENGTH = 1_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

interface ReviewRow {
  id: string;
  workspace_id: string;
  terminal_session_id: string;
  goal_id: string;
  task_id: string;
  agent_id: string | null;
  status: TerminalReviewStatus;
  scope: VerificationScope;
  summary: string;
  changed_files: string;
  verification_commands: string;
  idempotency_key: string | null;
  attempt: number;
  run_token: string | null;
  previous_verification_id: string | null;
  verification_id: string | null;
  findings: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TerminalRow {
  id: string;
  workspace_id: string;
  project_id: string;
  goal_id: string | null;
  agent_id: string | null;
  active_task_id: string | null;
  provider: string | null;
  status: string;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  goal_id: string;
  project_id: string;
  assignee_id: string | null;
  status: string;
  depends_on: string | null;
  verification_id: string | null;
}

export interface PrepareTerminalReviewInput {
  summary?: unknown;
  changedFiles?: unknown;
  verificationCommands?: unknown;
  scope?: unknown;
  idempotencyKey?: unknown;
}

export interface TerminalReviewRunResult {
  started: boolean;
  stale: boolean;
  review: TerminalReviewRequest;
  task: TaskRow;
  nextReadyTask: TaskRow | null;
  hasNextReadyTask: boolean;
}

export interface PreparedTerminalReview {
  review: TerminalReviewRequest;
  task: TaskRow;
  replayed: boolean;
}

export type TerminalReviewVerifier = (
  taskId: string,
  config: { scope: VerificationScope },
) => Promise<VerificationResult>;

/** Prevent terminal-provided review evidence from becoming a credential log. */
export function sanitizeTerminalReviewEvidenceText(value: string): string {
  return redactTerminalText(value);
}

function sanitizeFindings(issues: VerificationIssue[]): VerificationIssue[] {
  return issues.map((issue) => Object.fromEntries(
    Object.entries(issue).map(([key, value]) => [
      key,
      typeof value === "string" ? sanitizeTerminalReviewEvidenceText(value) : value,
    ]),
  ) as unknown as VerificationIssue);
}

function terminalRow(db: Database, terminalId: string): TerminalRow {
  const row = db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(terminalId) as TerminalRow | undefined;
  if (!row) throw new Error("Terminal not found");
  if (row.status !== "active") throw new Error("Terminal is not active");
  return row;
}

function taskRow(db: Database, taskId: string): TaskRow {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  if (!row) throw new Error("Task not found");
  return row;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function serializeReview(row: ReviewRow): TerminalReviewRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    terminalSessionId: row.terminal_session_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    status: row.status,
    scope: row.scope,
    evidence: {
      summary: row.summary,
      changedFiles: parseJsonArray<string>(row.changed_files),
      verificationCommands: parseJsonArray<string>(row.verification_commands),
    },
    attempt: row.attempt,
    verificationId: row.verification_id,
    findings: parseJsonArray<VerificationIssue>(row.findings),
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reviewRow(db: Database, reviewId: string): ReviewRow {
  const row = db.prepare("SELECT * FROM terminal_review_requests WHERE id = ?").get(reviewId) as ReviewRow | undefined;
  if (!row) throw new Error("Terminal review not found");
  return row;
}

function normalizeStringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  if (value.length > maxItems) throw new Error(`${field} may contain at most ${maxItems} items`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`${field} must contain only strings`);
    const normalized = item.trim();
    if (!normalized) continue;
    if (normalized.includes("\0")) throw new Error(`${field} contains an invalid null byte`);
    if (normalized.length > maxLength) throw new Error(`${field} entries may contain at most ${maxLength} characters`);
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizeEvidence(input: PrepareTerminalReviewInput): TerminalReviewEvidence {
  if (input.summary != null && typeof input.summary !== "string") {
    throw new Error("summary must be a string");
  }
  const summary = String(input.summary ?? "").trim();
  if (summary.length > MAX_SUMMARY_LENGTH) {
    throw new Error(`summary may contain at most ${MAX_SUMMARY_LENGTH} characters`);
  }
  return {
    summary: sanitizeTerminalReviewEvidenceText(summary || "Terminal agent requested Quality Gate review"),
    changedFiles: normalizeStringList(input.changedFiles, "changedFiles", MAX_CHANGED_FILES, MAX_FILE_LENGTH)
      .map(sanitizeTerminalReviewEvidenceText),
    verificationCommands: normalizeStringList(
      input.verificationCommands,
      "verificationCommands",
      MAX_VERIFICATION_COMMANDS,
      MAX_COMMAND_LENGTH,
    ).map(sanitizeTerminalReviewEvidenceText),
  };
}

function normalizeScope(value: unknown): VerificationScope {
  if (value == null || value === "") return "standard";
  if (value !== "lite" && value !== "standard" && value !== "full") {
    throw new Error("scope must be lite, standard, or full");
  }
  return value;
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("idempotencyKey must be a string");
  const key = value.trim();
  if (!key || key.length > 200) throw new Error("idempotencyKey must contain 1 to 200 characters");
  return key;
}

function dependenciesDone(db: Database, task: TaskRow): boolean {
  const dependencies = parseJsonArray<unknown>(task.depends_on ?? "[]")
    .filter((value): value is string => typeof value === "string");
  if (dependencies.length === 0) return true;
  const placeholders = dependencies.map(() => "?").join(",");
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM tasks
     WHERE id IN (${placeholders}) AND status != 'done'
  `).get(...dependencies) as { count: number };
  return row.count === 0;
}

function nextReadyTask(
  db: Database,
  terminalId: string,
  goalId: string,
  agentId: string | null,
): TaskRow | null {
  const candidates = db.prepare(`
    SELECT * FROM tasks
     WHERE goal_id = ? AND status = 'todo' AND parent_task_id IS NULL
       AND (? IS NULL OR assignee_id IS NULL OR assignee_id = ?)
       AND id NOT IN (
         SELECT active_task_id FROM terminal_sessions
          WHERE status = 'active' AND active_task_id IS NOT NULL AND id != ?
       )
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
              sort_order, created_at
  `).all(goalId, agentId, agentId, terminalId) as TaskRow[];
  return candidates.find((candidate) => dependenciesDone(db, candidate)) ?? null;
}

function updateGoalProgress(db: Database, goalId: string): void {
  const stats = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
      FROM tasks WHERE goal_id = ?
  `).get(goalId) as { total: number; done: number | null };
  const progress = stats.total > 0 ? Math.round(((stats.done ?? 0) / stats.total) * 100) : 0;
  db.prepare("UPDATE goals SET progress = ? WHERE id = ?").run(progress, goalId);
}

export function prepareTerminalReview(
  db: Database,
  terminalId: string,
  input: PrepareTerminalReviewInput,
): PreparedTerminalReview {
  const terminal = terminalRow(db, terminalId);
  if (!terminal.active_task_id || !terminal.goal_id) throw new Error("This terminal has no active goal task");
  if (!terminal.agent_id) throw new Error("Select an agent before requesting review");
  const goalId = terminal.goal_id;
  const agentId = terminal.agent_id;
  const task = taskRow(db, terminal.active_task_id);
  if (task.project_id !== terminal.project_id || task.goal_id !== terminal.goal_id) {
    throw new Error("Terminal binding does not match the active task");
  }
  if (terminal.agent_id && task.assignee_id && terminal.agent_id !== task.assignee_id) {
    throw new Error("Terminal agent does not own the active task");
  }
  const evidence = normalizeEvidence(input);
  const scope = normalizeScope(input.scope);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

  const prepare = db.transaction(() => {
    if (idempotencyKey) {
      const replay = db.prepare(`
        SELECT * FROM terminal_review_requests
         WHERE terminal_session_id = ? AND idempotency_key = ?
      `).get(terminalId, idempotencyKey) as ReviewRow | undefined;
      if (replay) return { review: serializeReview(replay), task: taskRow(db, replay.task_id), replayed: true };
    }

    const active = db.prepare(`
      SELECT * FROM terminal_review_requests
       WHERE terminal_session_id = ? AND task_id = ? AND status IN ('pending', 'running')
       ORDER BY rowid DESC LIMIT 1
    `).get(terminalId, task.id) as ReviewRow | undefined;
    if (active) return { review: serializeReview(active), task: taskRow(db, task.id), replayed: true };

    const unresolved = db.prepare(`
      SELECT status FROM terminal_review_requests
       WHERE terminal_session_id = ? AND task_id = ?
       ORDER BY rowid DESC LIMIT 1
    `).get(terminalId, task.id) as { status: TerminalReviewStatus } | undefined;
    if (task.status === "in_review" && unresolved && ["conditional", "error", "timeout"].includes(unresolved.status)) {
      throw new Error("Review requires an explicit retry or user decision");
    }
    if (task.status !== "in_progress") {
      throw new Error(`Task must be in_progress before review (current: ${task.status})`);
    }

    const row = db.prepare(`
      INSERT INTO terminal_review_requests (
        workspace_id, terminal_session_id, goal_id, task_id, agent_id,
        status, scope, summary, changed_files, verification_commands,
        idempotency_key, previous_verification_id
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      terminal.workspace_id,
      terminalId,
      goalId,
      task.id,
      agentId,
      scope,
      evidence.summary,
      JSON.stringify(evidence.changedFiles),
      JSON.stringify(evidence.verificationCommands),
      idempotencyKey,
      task.verification_id,
    ) as ReviewRow;

    const transitioned = db.prepare(`
      UPDATE tasks SET status = 'in_review', result_summary = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'in_progress'
    `).run(evidence.summary, task.id);
    if (transitioned.changes !== 1) throw new Error("Task state changed before review could be prepared");
    db.prepare("UPDATE agents SET status = 'waiting_approval', current_task_id = ? WHERE id = ?")
      .run(task.id, agentId);

    // Native terminal agents are not spawned by SessionManager, but the existing
    // Quality Gate strictly consumes an implementation/fix AgentHandoff. Persist a
    // completed terminal-origin session and the immutable completion evidence in
    // that same contract so createQualityGate().verify() can remain authoritative.
    const implementationSession = db.prepare(`
      INSERT INTO sessions (
        agent_id, task_id, workspace_id, session_key, origin, provider,
        status, ended_at, last_output
      ) VALUES (?, ?, ?, ?, 'terminal', ?, 'completed', datetime('now'), ?)
      RETURNING id
    `).get(
      agentId,
      task.id,
      terminal.workspace_id,
      `terminal-review:${row.id}`,
      terminal.provider,
      evidence.summary,
    ) as { id: string };
    saveAgentHandoff(db, {
      goalId,
      taskId: task.id,
      sessionId: implementationSession.id,
      handoff: {
        version: AGENT_HANDOFF_CONTRACT_VERSION,
        stage: "implementation",
        changed_files: evidence.changedFiles,
        decisions: [evidence.summary],
        unresolved_risks: [],
        reproduction_commands: evidence.verificationCommands,
      },
    });
    return { review: serializeReview(row), task: taskRow(db, task.id), replayed: false };
  });
  return prepare();
}

export function listTerminalReviews(db: Database, terminalId: string): TerminalReviewRequest[] {
  terminalRow(db, terminalId);
  const rows = db.prepare(`
    SELECT * FROM terminal_review_requests
     WHERE terminal_session_id = ? ORDER BY rowid DESC LIMIT 100
  `).all(terminalId) as ReviewRow[];
  return rows.map(serializeReview);
}

export function reconcileInterruptedTerminalReviews(db: Database): number {
  const reconcile = db.transaction(() => {
    const interrupted = db.prepare(`
      SELECT task_id, agent_id FROM terminal_review_requests WHERE status = 'running'
    `).all() as Array<{ task_id: string; agent_id: string | null }>;
    const result = db.prepare(`
      UPDATE terminal_review_requests
         SET status = 'error', run_token = NULL,
             error_message = 'Quality Gate was interrupted by a server restart. Retry verification.',
             completed_at = datetime('now'), updated_at = datetime('now')
       WHERE status = 'running'
    `).run();
    for (const row of interrupted) {
      db.prepare("UPDATE tasks SET status = 'in_review', updated_at = datetime('now') WHERE id = ? AND status != 'done'")
        .run(row.task_id);
      if (row.agent_id) {
        db.prepare("UPDATE agents SET status = 'waiting_approval', current_task_id = ? WHERE id = ? AND status != 'terminated'")
          .run(row.task_id, row.agent_id);
      }
    }
    return result.changes;
  });
  return reconcile();
}

function restoreAuthoritativeVerification(db: Database, reviewId: string): void {
  const review = reviewRow(db, reviewId);
  const authoritative = db.prepare(`
    SELECT verification_id FROM terminal_review_requests
     WHERE task_id = ? AND verification_id IS NOT NULL
     ORDER BY completed_at DESC, rowid DESC LIMIT 1
  `).get(review.task_id) as { verification_id: string } | undefined;
  db.prepare("UPDATE tasks SET verification_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(authoritative?.verification_id ?? review.previous_verification_id, review.task_id);
}

function statusForResult(result: VerificationResult): TerminalReviewStatus {
  if (result.terminationReason === "evaluator_error") return "error";
  if (result.verdict === "pass") return "passed";
  if (result.verdict === "conditional") return "conditional";
  return "fix_required";
}

function isTimeout(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "TimeoutError" || /timed?\s*out|timeout/i.test(message);
}

export async function runTerminalReview(
  db: Database,
  terminalId: string,
  reviewId: string,
  verifier: TerminalReviewVerifier,
  options: { retry?: boolean; timeoutMs?: number } = {},
): Promise<TerminalReviewRunResult> {
  const terminal = terminalRow(db, terminalId);
  const current = reviewRow(db, reviewId);
  if (current.terminal_session_id !== terminalId) throw new Error("Review does not belong to this terminal");
  if (current.status === "running" || current.status === "passed" || current.status === "fix_required") {
    const task = taskRow(db, current.task_id);
    const next = current.status === "passed"
      ? nextReadyTask(db, terminalId, current.goal_id, current.agent_id)
      : null;
    return {
      started: false,
      stale: false,
      review: serializeReview(current),
      task,
      nextReadyTask: next,
      hasNextReadyTask: next !== null,
    };
  }
  const retryable = current.status === "conditional" || current.status === "error" || current.status === "timeout";
  if (retryable && !options.retry) throw new Error(`Review is ${current.status}; explicit retry is required`);
  if (current.status !== "pending" && !retryable) throw new Error(`Review cannot run from status ${current.status}`);

  const runToken = randomUUID();
  const allowedStatuses = retryable
    ? "('conditional', 'error', 'timeout')"
    : "('pending')";
  const claimed = db.prepare(`
    UPDATE terminal_review_requests
       SET status = 'running', run_token = ?, attempt = attempt + 1,
           error_message = NULL, started_at = datetime('now'), completed_at = NULL,
           updated_at = datetime('now')
     WHERE id = ? AND terminal_session_id = ? AND status IN ${allowedStatuses}
  `).run(runToken, reviewId, terminalId);
  if (claimed.changes !== 1) {
    const latest = reviewRow(db, reviewId);
    const task = taskRow(db, latest.task_id);
    return {
      started: false,
      stale: false,
      review: serializeReview(latest),
      task,
      nextReadyTask: null,
      hasNextReadyTask: false,
    };
  }

  const running = reviewRow(db, reviewId);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMarker = Symbol("terminal-review-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const verifierPromise = verifier(running.task_id, { scope: running.scope });
  try {
    const outcome = await Promise.race<VerificationResult | typeof timeoutMarker>([
      verifierPromise,
      new Promise<typeof timeoutMarker>((resolve) => {
        timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
      }),
    ]);

    if (outcome === timeoutMarker) {
      const finalized = db.prepare(`
        UPDATE terminal_review_requests
           SET status = 'timeout', run_token = NULL,
               error_message = 'Quality Gate timed out. Retry verification.',
               completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND run_token = ? AND status = 'running'
      `).run(reviewId, runToken);
      if (finalized.changes === 1) {
        db.prepare("UPDATE tasks SET status = 'in_review', updated_at = datetime('now') WHERE id = ?")
          .run(running.task_id);
      }
      void verifierPromise.then(
        () => restoreAuthoritativeVerification(db, reviewId),
        () => {},
      );
      const review = reviewRow(db, reviewId);
      const task = taskRow(db, review.task_id);
      return {
        started: true,
        stale: finalized.changes !== 1,
        review: serializeReview(review),
        task,
        nextReadyTask: null,
        hasNextReadyTask: false,
      };
    }

    const targetStatus = statusForResult(outcome);
    const finalize = db.transaction(() => {
      const binding = db.prepare(`
        SELECT active_task_id FROM terminal_sessions WHERE id = ? AND status = 'active'
      `).get(terminalId) as { active_task_id: string | null } | undefined;
      const taskBeforeFinalize = db.prepare("SELECT status FROM tasks WHERE id = ?")
        .get(running.task_id) as { status: string } | undefined;
      if (binding?.active_task_id !== running.task_id || taskBeforeFinalize?.status !== "in_review") {
        return false;
      }
      const updated = db.prepare(`
        UPDATE terminal_review_requests
           SET status = ?, run_token = NULL, verification_id = ?, findings = ?,
               error_message = ?, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND run_token = ? AND status = 'running'
      `).run(
        targetStatus,
        outcome.id,
        JSON.stringify(sanitizeFindings(outcome.issues ?? [])),
        targetStatus === "error"
          ? sanitizeTerminalReviewEvidenceText(outcome.issues[0]?.message ?? "Evaluator returned an error result")
          : null,
        reviewId,
        runToken,
      );
      if (updated.changes !== 1) return false;

      if (targetStatus === "passed") {
        db.prepare("UPDATE tasks SET status = 'done', verification_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'in_review'")
          .run(outcome.id, running.task_id);
        if (running.agent_id) {
          db.prepare(`
            UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL
             WHERE id = ? AND current_task_id = ?
          `).run(running.agent_id, running.task_id);
        }
        updateGoalProgress(db, running.goal_id);
      } else if (targetStatus === "fix_required") {
        db.prepare("UPDATE tasks SET status = 'in_progress', verification_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(outcome.id, running.task_id);
        if (running.agent_id) {
          db.prepare("UPDATE agents SET status = 'working', current_task_id = ? WHERE id = ?")
            .run(running.task_id, running.agent_id);
        }
      } else {
        db.prepare("UPDATE tasks SET status = 'in_review', verification_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(outcome.id, running.task_id);
        if (running.agent_id) {
          db.prepare("UPDATE agents SET status = 'waiting_approval', current_task_id = ? WHERE id = ?")
            .run(running.task_id, running.agent_id);
        }
      }
      return true;
    });
    const finalized = finalize();
    if (!finalized) restoreAuthoritativeVerification(db, reviewId);
    const review = reviewRow(db, reviewId);
    const task = taskRow(db, review.task_id);
    const next = review.status === "passed"
      ? nextReadyTask(db, terminalId, review.goal_id, review.agent_id)
      : null;
    return {
      started: true,
      stale: !finalized,
      review: serializeReview(review),
      task,
      nextReadyTask: next,
      hasNextReadyTask: next !== null,
    };
  } catch (error) {
    const status: TerminalReviewStatus = isTimeout(error) ? "timeout" : "error";
    const message = sanitizeTerminalReviewEvidenceText(error instanceof Error ? error.message : String(error));
    const finalized = db.prepare(`
      UPDATE terminal_review_requests
         SET status = ?, run_token = NULL, error_message = ?,
             completed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND run_token = ? AND status = 'running'
    `).run(status, message.slice(0, 2_000), reviewId, runToken);
    if (finalized.changes === 1) {
      db.prepare("UPDATE tasks SET status = 'in_review', updated_at = datetime('now') WHERE id = ?")
        .run(running.task_id);
      if (running.agent_id) {
        db.prepare("UPDATE agents SET status = 'waiting_approval', current_task_id = ? WHERE id = ?")
          .run(running.task_id, running.agent_id);
      }
    }
    const review = reviewRow(db, reviewId);
    const task = taskRow(db, review.task_id);
    return {
      started: true,
      stale: finalized.changes !== 1,
      review: serializeReview(review),
      task,
      nextReadyTask: null,
      hasNextReadyTask: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
