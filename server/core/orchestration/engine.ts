import type { Database } from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { SessionManager } from "../agent/session.js";
import { parseAgentOutput } from "../agent/adapters/stream-parser.js";
import { createQualityGate } from "../quality-gate/evaluator.js";
import { createDelegationEngine } from "./delegation.js";
import { artifactsDirForGoal, collectScreenshots, initialWorkReport, generateGoalWorkReport, extractWrapUp } from "./work-report.js";
import { commitTaskResult, executeGitWorkflow, getDefaultBranch, recoverTaskCommitEvidence, squashMergeGoal, type GitHubConfig, type GitMode, type GitWorkflowResult } from "../project/git-workflow.js";
import type { WorktreeInfo } from "../project/worktree.js";
import { createLogger } from "../../utils/logger.js";
import { MAX_TITLE_LEN, MAX_DESC_LEN, MAX_SUMMARY_LEN, MAX_TASKS_PER_GOAL, MAX_TASK_RETRIES, MAX_REASSIGNS, MAX_FIX_ROUNDS, MAX_NO_PROGRESS_ROUNDS, MAX_FIX_TASKS_PER_VERIFICATION } from "../../utils/constants.js";
import type { VerificationResult, VerificationScope } from "../../../shared/types.js";
import { appendMemory } from "../agent/memory.js";
import { createMethodologyEngine } from "../methodology/index.js";
import { autoDetectScope } from "../quality-gate/evaluator.js";
import { AgentError, detectAgentRunFailure, classifyAgentFailure } from "../../utils/errors.js";
import { getBackend } from "../agent/adapters/backend.js";
import { loadProviderConfig } from "../agent/provider.js";
import { escalateVerificationCap, issueSetSignature } from "./verification-policy.js";
import {
  assertExecutionAllowed,
  beginExecutionRun,
  failExecutionRun,
  formatExecutionSpecContext,
  getExecutionSpecByVersionId,
  getTaskExecutionSpec,
} from "../goal-spec/spec-approval.js";

const log = createLogger("orchestration");

// DB row types (snake_case as stored in SQLite)
interface TaskRow {
  id: string;
  goal_id: string;
  project_id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  parent_task_id: string | null;
  status: string;
  verification_id: string | null;
  recovery_resume_phase: "implementation" | "verification" | "fix" | null;
  target_files: string | null;  // JSON array of paths (P2: scope anchoring)
  stack_hint: string | null;    // Short stack constraint (P2: scope anchoring)
  depends_on: string | null;    // JSON array of task IDs (DAG dependency)
  execution_run_id: string | null;
  execution_spec_version_id: string | null;
}
interface ProjectRow {
  id: string;
  name: string;
  mission: string;
  workdir: string;
  autopilot: string; // 'off' | 'goal' | 'full'
}
interface GoalRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  goal_model: string;        // 'legacy' | 'goal_as_unit'
  worktree_path: string | null;
  worktree_branch: string | null;
  acceptance_script: string | null;
  squash_status: string;     // 'none' | 'pending_approval' | 'approved' | 'merged' | 'blocked' | 'triggering'
  squash_commit_sha: string | null;
  qa_regression_task_id: string | null;  // Phase 3: QA 회귀 태스크 ID (1회만 생성)
  skip_adversarial?: number; // 1이면 adversarial 태스크 자동 주입 건너뜀
}
interface AgentRow {
  id: string;
  role: string;
  parent_id: string | null;
}

interface VerificationIssueRow {
  id: string;
  dimension: string;
  severity: "critical" | "high" | "warning" | "info";
  evidence: string;
  repro_command: string;
  expected_result: string;
  actual_result: string;
  fix_instruction: string;
  assignee_id: string;
}

function loadInterruptedFixVerification(db: Database, taskId: string): VerificationResult | null {
  const row = db.prepare(`
    SELECT v.id, v.task_id, v.verdict, v.scope, v.dimensions, v.issues,
           v.severity, v.evaluator_session_id, v.termination_reason, v.created_at
      FROM verification_fix_rounds r
      JOIN verifications v ON v.id = r.source_verification_id
     WHERE r.task_id = ?
     ORDER BY r.round_number DESC, r.started_at DESC
     LIMIT 1
  `).get(taskId) as {
    id: string;
    task_id: string;
    verdict: VerificationResult["verdict"];
    scope: VerificationResult["scope"];
    dimensions: string;
    issues: string;
    severity: VerificationResult["severity"];
    evaluator_session_id: string | null;
    termination_reason: VerificationResult["terminationReason"];
    created_at: string;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    verdict: row.verdict,
    scope: row.scope,
    dimensions: JSON.parse(row.dimensions),
    issues: JSON.parse(row.issues),
    severity: row.severity,
    evaluatorSessionId: row.evaluator_session_id ?? `recovered-${row.id}`,
    terminationReason: row.termination_reason,
    createdAt: row.created_at,
  };
}

export interface CreatedFixTask {
  issueId: string;
  taskId: string;
  title: string;
  description: string;
  assigneeId: string | null;
  status: string;
  created: boolean;
}

export interface FixTaskConversionResult {
  fixTasks: CreatedFixTask[];
  manualApprovalRequired: boolean;
}

const FIX_TASK_PRIORITY: Record<VerificationIssueRow["severity"], "critical" | "high" | "medium" | "low"> = {
  critical: "critical",
  high: "high",
  warning: "medium",
  info: "low",
};

// fan-out 캡 정렬용 severity 랭크 (낮을수록 심각 → 우선 보존). 미지 severity 는 최하위.
const FIX_SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, warning: 2, info: 3 };

// fix task 제목용 dimension 라벨 (dashboard GoalDetail.tsx DIMENSION_LABELS와 정렬).
// 미지의 dimension은 원문 그대로 fallback.
const FIX_DIMENSION_LABELS: Record<string, string> = {
  functionality: "기능",
  dataFlow: "데이터 흐름",
  designAlignment: "설계 일치",
  craft: "완성도",
  edgeCases: "예외 상황",
};

/**
 * fix task 제목을 원본 태스크 제목 기반으로 만든다. 기존엔 verbose한 issue.evidence를
 * 잘라 썼는데(문장 중간 truncate), 분할로 만든 원본 제목을 재사용하고 실패 dimension만
 * 한국어 라벨로 덧붙여 목록에서 읽기 좋게 한다. 중첩 fix에서 "[수정]"이 겹치지 않게
 * prefix만 제거한다(원문 제목에 정상적으로 들어갈 수 있는 "·"는 건드리지 않는다).
 */
function buildFixTaskTitle(sourceTitle: string, dimension: string): string {
  const base = sourceTitle.replace(/^\[수정]\s*/, "").trim();
  const dimLabel = FIX_DIMENSION_LABELS[dimension] ?? dimension;
  return `[수정] ${base} · ${dimLabel}`.slice(0, MAX_TITLE_LEN);
}

/**
 * fix task 제목의 base로 쓸 "근본 원본 태스크" 제목을 찾는다. source가 분할 태스크면
 * 그대로, source가 또다른 fix task(중첩 fix)면 issue→verification→task 체인을 거슬러
 * 올라가 non-fix 원본에 도달한다. 이로써 중첩이 깊어도 제목이 서술형 evidence로 누적되지
 * 않고 항상 [수정] <원본 분할 제목> · <dimension> 형태가 된다. 루프 가드 10.
 */
function resolveRootTaskTitle(db: Database, taskId: string, fallbackTitle: string): string {
  const isFixTask = db.prepare(
    "SELECT 1 AS x FROM verification_issue_tasks WHERE task_id = ? AND relation = 'fix' LIMIT 1",
  );
  const parentOf = db.prepare(`
    SELECT st.id AS id, st.title AS title
    FROM verification_issue_tasks vit
    JOIN verification_issues vi ON vi.id = vit.issue_id
    JOIN verifications v ON v.id = vi.verification_id
    JOIN tasks st ON st.id = v.task_id
    WHERE vit.task_id = ? AND vit.relation = 'fix'
    ORDER BY st.rowid ASC LIMIT 1
  `);
  let cur = taskId;
  let title = fallbackTitle;
  for (let i = 0; i < 10 && isFixTask.get(cur); i++) {
    const parent = parentOf.get(cur) as { id: string; title: string } | undefined;
    if (!parent) break;
    title = parent.title;
    cur = parent.id;
  }
  return title;
}

function buildFixTaskDescription(
  sourceTaskId: string,
  verificationId: string,
  issue: VerificationIssueRow,
): string {
  return [
    "# Quality Gate Fix",
    "",
    `source_task_id: ${sourceTaskId}`,
    `source_verification_id: ${verificationId}`,
    `issue_id: ${issue.id}`,
    `dimension: ${issue.dimension}`,
    `severity: ${issue.severity}`,
    `evidence: ${issue.evidence}`,
    `repro_command: ${issue.repro_command}`,
    `expected_result: ${issue.expected_result}`,
    `actual_result: ${issue.actual_result}`,
    `fix_instruction: ${issue.fix_instruction}`,
    "",
    "Fix ONLY this issue. Run the repro_command and confirm the expected_result before completing.",
  ].join("\n");
}

/**
 * 실패 verification의 normalized issue를 issue별 fix task로 변환한다.
 * task 생성과 issue↔task link 저장은 한 transaction으로 처리하며, 기존 link가
 * 있으면 해당 task를 재사용한다. 유효한 project assignee가 없으면 승인 대기
 * task를 만들고 호출자가 manual_approval 상태를 노출할 수 있게 알린다.
 */
export function createFixTasksFromVerification(
  db: Database,
  verificationId: string,
): FixTaskConversionResult {
  const source = db.prepare(`
    SELECT v.id AS verification_id, v.verdict, t.id AS task_id, t.goal_id,
           t.project_id, t.title, t.assignee_id, t.task_type
    FROM verifications v
    JOIN tasks t ON t.id = v.task_id
    WHERE v.id = ?
  `).get(verificationId) as {
    verification_id: string;
    verdict: string;
    task_id: string;
    goal_id: string;
    project_id: string;
    title: string;
    assignee_id: string | null;
    task_type: string;
  } | undefined;
  if (!source) throw new Error(`Verification ${verificationId} not found`);
  if (source.verdict !== "fail") throw new Error(`Verification ${verificationId} is not failed`);

  const allIssues = db.prepare(`
    SELECT id, dimension, severity, evidence, repro_command, expected_result,
           actual_result, fix_instruction, assignee_id
    FROM verification_issues
    WHERE verification_id = ?
    ORDER BY rowid ASC
  `).all(verificationId) as VerificationIssueRow[];

  // fan-out 캡: 한 검증이 이슈를 대량으로 뱉어도 goal 태스크 목록이 무제한으로 불어나지
  // 않게 severity 우선 top-N 개만 fix task 로 변환한다. critical→high→warning→info 순으로
  // 유지하고(동일 severity 는 원래 순서), 초과분은 드롭하되 조용히 버리지 않고 로그로 남긴다.
  // 드롭된 이슈는 재검증에서 다시 잡히므로 라운드 예산 안에서 자연 우선순위로 수렴한다.
  const issues = [...allIssues]
    .sort((a, b) => (FIX_SEVERITY_RANK[a.severity] ?? 9) - (FIX_SEVERITY_RANK[b.severity] ?? 9))
    .slice(0, MAX_FIX_TASKS_PER_VERIFICATION);
  if (allIssues.length > issues.length) {
    log.warn(
      `Fix fan-out 캡: 검증 ${verificationId} 이슈 ${allIssues.length}개 중 severity 상위 ${issues.length}개만 fix task 생성 (드롭 ${allIssues.length - issues.length}개, 재검증에서 재평가)`,
    );
  }

  const convert = db.transaction((): FixTaskConversionResult => {
    const fixTasks: CreatedFixTask[] = [];
    let nextOrder = ((db.prepare(
      "SELECT MAX(sort_order) AS max_order FROM tasks WHERE goal_id = ?",
    ).get(source.goal_id) as { max_order: number | null }).max_order ?? 0) + 1;

    const findAgent = db.prepare("SELECT id FROM agents WHERE id = ? AND project_id = ?");
    const findLinkedTask = db.prepare(`
      SELECT t.id, t.title, t.description, t.assignee_id, t.status
      FROM verification_issue_tasks vit
      JOIN tasks t ON t.id = vit.task_id
      WHERE vit.issue_id = ? AND vit.relation = 'fix'
      ORDER BY t.created_at ASC, t.rowid ASC
      LIMIT 1
    `);
    const insertTask = db.prepare(`
      INSERT INTO tasks (
        goal_id, project_id, title, description, assignee_id, status,
        priority, sort_order, task_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const insertLink = db.prepare(`
      INSERT INTO verification_issue_tasks (issue_id, task_id, relation)
      VALUES (?, ?, 'fix')
    `);
    const updateLinkedTask = db.prepare(`
      UPDATE tasks
      SET assignee_id = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    const insertActivity = db.prepare(`
      INSERT INTO activities (project_id, agent_id, type, message, metadata)
      VALUES (?, ?, 'task_created', ?, ?)
    `);

    for (const issue of issues) {
      const issueAgent = findAgent.get(issue.assignee_id, source.project_id) as { id: string } | undefined;
      const sourceAgent = source.assignee_id
        ? findAgent.get(source.assignee_id, source.project_id) as { id: string } | undefined
        : undefined;
      const resolvedAssigneeId = issueAgent?.id ?? sourceAgent?.id ?? null;
      const linked = findLinkedTask.get(issue.id) as {
        id: string;
        title: string;
        description: string;
        assignee_id: string | null;
        status: string;
      } | undefined;
      if (linked) {
        let assigneeId = linked.assignee_id;
        let status = linked.status;
        if (!assigneeId && status !== "done") {
          assigneeId = resolvedAssigneeId;
          status = assigneeId && status === "pending_approval" ? "todo" : assigneeId ? status : "pending_approval";
          updateLinkedTask.run(assigneeId, status, linked.id);
        }
        fixTasks.push({
          issueId: issue.id,
          taskId: linked.id,
          title: linked.title,
          description: linked.description,
          assigneeId,
          status,
          created: false,
        });
        continue;
      }

      const assigneeId = resolvedAssigneeId;
      const status = assigneeId ? "todo" : "pending_approval";
      const rootTitle = resolveRootTaskTitle(db, source.task_id, source.title);
      const title = buildFixTaskTitle(rootTitle, issue.dimension);
      const description = buildFixTaskDescription(source.task_id, verificationId, issue);
      const inserted = insertTask.get(
        source.goal_id,
        source.project_id,
        title,
        description,
        assigneeId,
        status,
        FIX_TASK_PRIORITY[issue.severity],
        nextOrder++,
        source.task_type,
      ) as { id: string };
      insertLink.run(issue.id, inserted.id);
      insertActivity.run(
        source.project_id,
        assigneeId,
        `Fix task created: "${title}"`,
        JSON.stringify({
          sourceVerificationId: verificationId,
          sourceTaskId: source.task_id,
          issueId: issue.id,
          manualApprovalRequired: assigneeId === null,
        }),
      );
      fixTasks.push({
        issueId: issue.id,
        taskId: inserted.id,
        title,
        description,
        assigneeId,
        status,
        created: true,
      });
    }

    return {
      fixTasks,
      manualApprovalRequired: fixTasks.some((task) => task.assigneeId === null),
    };
  });

  return convert();
}

export type TaskExecutionStatus = "todo" | "pending_approval" | "in_progress" | "in_review" | "done" | "blocked";

export type TaskExecutionClaim =
  | { claimed: true; taskId: string }
  | {
      claimed: false;
      taskId: string;
      reason: "not_found" | "conflict" | "spec_not_approved";
      error: string;
      status?: TaskExecutionStatus;
      specStatus?: "missing" | "draft" | "changes_pending";
      currentDraftVersion?: number | null;
    };

export interface OrchestrationConfig {
  verificationScope: VerificationScope;
  autoFix: boolean;
  maxFixRetries: number;
}

const DEFAULT_CONFIG: OrchestrationConfig = {
  verificationScope: "standard",
  autoFix: true,
  maxFixRetries: 2,
};

/**
 * Recover task objects from a decomposer JSON response that was truncated
 * mid-output (the common failure mode when the model hits max_tokens).
 *
 * Strategy:
 *   1. Locate `"tasks"` key and the opening `[` of its array.
 *   2. Walk character-by-character with a string-aware brace counter.
 *   3. Every time the brace depth returns to 0 we emit the slice as one
 *      candidate task object and try to JSON.parse it.
 *   4. Trailing unterminated objects are silently skipped.
 *
 * Unlike the previous regex-based recovery this is agnostic to which
 * fields the task object contains — safe across future schema additions.
 */
export function recoverTasksFromPartialJson(raw: string): any[] {
  if (!raw) return [];
  // Find the "tasks": [ start. Accept any whitespace.
  const tasksKeyIdx = raw.search(/"tasks"\s*:\s*\[/);
  if (tasksKeyIdx === -1) return [];
  const arrayStart = raw.indexOf("[", tasksKeyIdx);
  if (arrayStart === -1) return [];

  const tasks: any[] = [];
  let i = arrayStart + 1;
  const len = raw.length;

  while (i < len) {
    // Skip whitespace and commas between objects
    while (i < len && /[\s,]/.test(raw[i] ?? "")) i++;
    if (i >= len) break;
    // Array end
    if (raw[i] === "]") break;
    // Each task must start with an object literal
    if (raw[i] !== "{") {
      i++;
      continue;
    }

    // Walk the object balancing braces, respecting string literals.
    const objStart = i;
    let depth = 0;
    let inString = false;
    let escape = false;

    for (; i < len; i++) {
      const ch = raw[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth++;
        continue;
      }
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          // Complete object — try to parse
          const slice = raw.slice(objStart, i + 1);
          try {
            const parsed = JSON.parse(slice);
            if (parsed && typeof parsed === "object") tasks.push(parsed);
          } catch {
            // Skip malformed object, keep scanning
          }
          i++; // move past the closing brace
          break;
        }
      }
    }

    // If we fell out of the inner loop with depth > 0 the object was
    // truncated — nothing more to recover.
    if (depth !== 0) break;
  }

  return tasks;
}

/**
 * DAG 순환 감지 — DFS 기반. 순환이 있는 노드 경로 배열을 반환한다.
 */
function detectCycles(tasks: Array<{ id: string; depends_on: string[] }>): string[][] {
  const adj = new Map<string, string[]>();
  tasks.forEach((t) => adj.set(t.id, t.depends_on));

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]): void {
    if (color.get(node) === GRAY) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) cycles.push(path.slice(cycleStart).concat(node));
      return;
    }
    if (color.get(node) === BLACK) return;
    color.set(node, GRAY);
    path.push(node);
    for (const dep of adj.get(node) ?? []) dfs(dep, path);
    path.pop();
    color.set(node, BLACK);
  }

  for (const t of tasks) {
    if ((color.get(t.id) ?? WHITE) === WHITE) dfs(t.id, []);
  }
  return cycles;
}

/**
 * Orchestration Engine — Goal → Task decomposition → Agent execution → Verification
 *
 * Pipeline (ported from Crewdeck Orchestrator):
 * 1. Receive goal/task
 * 2. Assign to appropriate agent (Coder)
 * 3. Agent executes via Claude Code session
 * 4. Quality Gate verification (independent Evaluator)
 * 5. If FAIL + autoFix: spawn fix agent → re-verify (max 1 retry)
 * 6. Report results
 */
/**
 * In-flight decompose lock.
 *
 * Two code paths used to call `decomposeGoal` for the same goal at the
 * same time — the scheduler's autopilot loop AND the orchestration API
 * route (or `rescuePendingGoals`). Both called `sessionManager.spawnAgent`
 * with the same `decompose-{goalId}` session key, and the second spawn
 * cleanup()'d the first one's Claude CLI with SIGTERM (exit 143), leaving
 * both callers with an empty stdout and the goal stuck at 0 tasks.
 *
 * A goal-level lock is sufficient because decompose is idempotent: the
 * second caller only needs to see that work is in progress and bail out.
 */
const inflightDecompose = new Set<string>();

async function ensureGoalWorktreeRecorded(
  db: Database,
  goal: GoalRow,
  projectWorkdir: string,
): Promise<WorktreeInfo> {
  const existingPath = goal.worktree_path?.trim() ?? "";
  const existingBranch = goal.worktree_branch?.trim() ?? "";

  if (existingPath && existingBranch) {
    const { existsSync } = await import("node:fs");
    if (!existsSync(existingPath)) {
      throw new Error(`Goal worktree path is missing on disk: ${existingPath}`);
    }
    return { path: existingPath, branch: existingBranch };
  }

  if (existingPath || existingBranch) {
    throw new Error(`Goal worktree metadata is incomplete for goal ${goal.id}`);
  }

  const { createGoalWorktree, removeWorktree } = await import("../project/worktree.js");
  const goalSlug = (goal.title || goal.description || goal.id).slice(0, 50);
  const created = createGoalWorktree(projectWorkdir, goalSlug);
  if (!created) {
    throw new Error(`Goal-as-Unit requires an isolated git worktree for goal ${goal.id}`);
  }

  const saved = db.prepare(`
    UPDATE goals
      SET worktree_path = ?, worktree_branch = ?
      WHERE id = ?
        AND COALESCE(worktree_path, '') = ''
        AND COALESCE(worktree_branch, '') = ''
  `).run(created.path, created.branch, goal.id);

  if (saved.changes > 0) {
    goal.worktree_path = created.path;
    goal.worktree_branch = created.branch;
    log.info(`Goal worktree recorded: ${created.path} (branch: ${created.branch})`);
    return created;
  }

  try {
    removeWorktree(projectWorkdir, created.path, created.branch);
  } catch (cleanupErr: any) {
    log.warn(`Unused goal worktree cleanup failed: ${cleanupErr?.message ?? cleanupErr}`);
  }

  const persisted = db.prepare(
    "SELECT worktree_path, worktree_branch FROM goals WHERE id = ?",
  ).get(goal.id) as { worktree_path: string | null; worktree_branch: string | null } | undefined;
  if (persisted?.worktree_path && persisted.worktree_branch) {
    goal.worktree_path = persisted.worktree_path;
    goal.worktree_branch = persisted.worktree_branch;
    return { path: persisted.worktree_path, branch: persisted.worktree_branch };
  }

  throw new Error(`Goal worktree metadata could not be persisted for goal ${goal.id}`);
}

/**
 * Smart Resume: 이전 실패 검증 이력을 프롬프트 블록으로 구성.
 *
 * autoFix(같은 사이클 내 fix)와 재시도 실행(blocked→todo 재픽) 양쪽에서 사용.
 * 재시도 실행은 checkpoint 복원으로 이전 사이클의 작업물이 폐기된 상태에서
 * 시작하므로, 이 블록이 없으면 이전 사이클이 이미 발견한 이슈를 백지에서
 * 다시 밟는다 (토큰 낭비 + 동일 실패 반복). 재배정된 에이전트도 verifications
 * 테이블 기반이라 전임자의 실패 이력을 그대로 받는다.
 */
export function buildFailureHistoryContext(db: Database, taskId: string, limit = 3): string {
  const previousFailures = db.prepare(`
    SELECT v.issues FROM verifications v
    WHERE v.task_id = ? AND v.verdict = 'fail'
    ORDER BY v.created_at DESC LIMIT ?
  `).all(taskId, limit) as { issues: string }[];

  if (previousFailures.length === 0) return "";

  const history = `\n## Previous Failure History\n` +
    previousFailures.map((f, i) => {
      try {
        const issues = JSON.parse(f.issues);
        return `### Attempt ${i + 1} (most recent first)\n` +
          issues.map((issue: any) =>
            `- [${issue.severity}] ${issue.file ?? ""}${issue.line != null ? `:${issue.line}` : ""} — ${issue.message}`
          ).join("\n");
      } catch { return `### Attempt ${i + 1} (most recent first)\n- ${f.issues}`; }
    }).join("\n\n");

  // 폐기된 이전 시도의 diff (검증 fail → checkpoint 복원이 버린 작업) — 참고용.
  // 유효했던 수정을 백지에서 재작성하지 않도록 재시도 프롬프트에 첨부한다.
  const discarded = db.prepare(
    "SELECT last_discarded_diff FROM tasks WHERE id = ?",
  ).get(taskId) as { last_discarded_diff?: string | null } | undefined;
  const diffBlock = discarded?.last_discarded_diff
    ? `\n\n## Discarded diff from a previous attempt (REFERENCE ONLY — review before re-applying)\n\`\`\`diff\n${discarded.last_discarded_diff.slice(0, 20_000)}\n\`\`\``
    : "";

  return history + diffBlock;
}

/**
 * 폐기 직전 working-tree diff 를 태스크에 보존한다 (검증 fail → checkpoint 복원 경로).
 * 다음 재시도의 구현 프롬프트에 참고 자료로 주입돼, 유효했던 부분 수정을
 * 백지에서 재발견하는 낭비를 막는다. 실패해도 복원을 막지 않는다.
 */
export function saveDiscardedDiff(db: Database, taskId: string, workdir: string): void {
  try {
    const out = spawnSync("git", ["diff"], { cwd: workdir, stdio: "pipe", timeout: 10_000 });
    const diff = out.stdout?.toString() ?? "";
    if (diff.trim()) {
      db.prepare("UPDATE tasks SET last_discarded_diff = ? WHERE id = ?").run(diff.slice(0, 20_000), taskId);
    }
  } catch {
    /* diff 보존 실패는 치명적이지 않음 */
  }
}

/**
 * Atomically reserve one task execution slot for its goal.
 *
 * Both scheduler dispatch and the manual execute API use this transaction.
 * The status CAS prevents duplicate ownership of the same task, while the
 * correlated NOT EXISTS preserves both the goal-level sequential execution
 * contract and the one-live-task-per-agent contract. In-progress delegation
 * parents with unfinished children are not live sessions, so they are excluded
 * exactly as they are in the scheduler; an actually running child still blocks
 * every other task in that goal or assigned to the same agent.
 * A claim released back to todo after an environment/setup failure keeps its
 * started_at timestamp as a short database-backed settle lease. This closes
 * the window where another HTTP request that arrived concurrently could claim
 * the same goal after the first spawn failed but before that request ran.
 */
export function claimTaskForExecution(db: Database, taskId: string): TaskExecutionClaim {
  const claim = db.transaction((candidateTaskId: string): TaskExecutionClaim => {
    const existing = db.prepare(`
      SELECT
        task.status,
        task.goal_id,
        task.execution_run_id,
        task.execution_spec_version_id,
        goal.active_execution_run_id,
        goal.execution_spec_version_id AS goal_execution_spec_version_id,
        run.id AS joined_execution_run_id,
        run.status AS execution_run_status,
        run.execution_spec_version_id AS run_execution_spec_version_id
      FROM tasks AS task
      JOIN goals AS goal ON goal.id = task.goal_id
      LEFT JOIN goal_execution_runs AS run
        ON run.id = task.execution_run_id
       AND run.goal_id = task.goal_id
      WHERE task.id = ?
    `).get(candidateTaskId) as {
      status: TaskExecutionStatus;
      goal_id: string;
      execution_run_id: string | null;
      execution_spec_version_id: string | null;
      active_execution_run_id: string | null;
      goal_execution_spec_version_id: string | null;
      joined_execution_run_id: string | null;
      execution_run_status: "active" | "completed" | "failed" | null;
      run_execution_spec_version_id: string | null;
    } | undefined;
    if (!existing) {
      return {
        claimed: false,
        taskId: candidateTaskId,
        reason: "not_found",
        error: "Task not found",
      };
    }

    if (existing.status === "todo" || existing.status === "pending_approval") {
      // A task already owned by a previous run must never be silently reused by a
      // newer approved spec. Re-decomposition creates fresh tasks for the new run.
      // Without this guard beginExecutionRun() would pin v2 while implementation
      // and verification still read the stale task's v1 snapshot.
      if (existing.execution_run_id && existing.execution_run_id !== existing.active_execution_run_id) {
        return {
          claimed: false,
          taskId: candidateTaskId,
          reason: "conflict",
          error: "Task belongs to a previous execution run and must be re-decomposed",
          status: existing.status,
        };
      }
      if (
        existing.execution_run_id
        && (!existing.joined_execution_run_id || existing.execution_run_status !== "active")
      ) {
        return {
          claimed: false,
          taskId: candidateTaskId,
          reason: "conflict",
          error: "Task execution run is missing or inactive and must be re-decomposed",
          status: existing.status,
        };
      }
      if (
        existing.execution_run_id
        && existing.execution_spec_version_id !== existing.run_execution_spec_version_id
      ) {
        return {
          claimed: false,
          taskId: candidateTaskId,
          reason: "conflict",
          error: "Task spec version differs from its execution run and must be re-decomposed",
          status: existing.status,
        };
      }
      if (
        existing.execution_spec_version_id
        && existing.goal_execution_spec_version_id
        && existing.execution_spec_version_id !== existing.goal_execution_spec_version_id
      ) {
        return {
          claimed: false,
          taskId: candidateTaskId,
          reason: "conflict",
          error: "Task spec version differs from the approved execution version and must be re-decomposed",
          status: existing.status,
        };
      }

      const executionGate = assertExecutionAllowed(db, existing.goal_id, candidateTaskId);
      if (!executionGate.allowed) {
        return {
          claimed: false,
          taskId: candidateTaskId,
          reason: executionGate.reason,
          error: executionGate.message,
          status: existing.status,
          specStatus: executionGate.specStatus,
          currentDraftVersion: executionGate.currentDraftVersion,
        };
      }
    }

    const updated = db.prepare(`
      UPDATE tasks AS candidate
      SET status = 'in_progress',
          started_at = strftime('%Y-%m-%d %H:%M:%f', 'now'),
          updated_at = datetime('now')
      WHERE candidate.id = ?
        AND candidate.status IN ('todo', 'pending_approval')
        AND NOT EXISTS (
          SELECT 1 FROM tasks settling
          WHERE settling.goal_id = candidate.goal_id
            AND settling.status = 'todo'
            AND julianday(settling.started_at) > julianday('now', '-5 seconds')
        )
        AND NOT EXISTS (
          SELECT 1 FROM tasks active
          WHERE active.goal_id = candidate.goal_id
            AND active.id != candidate.id
            AND active.status IN ('in_progress', 'in_review')
            AND NOT (
              active.status = 'in_progress'
              AND EXISTS (
                SELECT 1 FROM tasks child
                WHERE child.parent_task_id = active.id
                  AND child.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM tasks agent_active
          WHERE candidate.assignee_id IS NOT NULL
            AND agent_active.assignee_id = candidate.assignee_id
            AND agent_active.id != candidate.id
            AND agent_active.status IN ('in_progress', 'in_review')
            AND NOT (
              agent_active.status = 'in_progress'
              AND EXISTS (
                SELECT 1 FROM tasks child
                WHERE child.parent_task_id = agent_active.id
                  AND child.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
              )
            )
        )
    `).run(candidateTaskId);

    if (updated.changes === 1) {
      beginExecutionRun(db, existing.goal_id);
      return { claimed: true, taskId: candidateTaskId };
    }

    const current = db.prepare(
      "SELECT status FROM tasks WHERE id = ?",
    ).get(candidateTaskId) as { status: TaskExecutionStatus };
    const active = db.prepare(`
      SELECT active.id FROM tasks active
      JOIN tasks candidate ON candidate.goal_id = active.goal_id
      WHERE candidate.id = ?
        AND active.id != candidate.id
        AND active.status IN ('in_progress', 'in_review')
        AND NOT (
          active.status = 'in_progress'
          AND EXISTS (
            SELECT 1 FROM tasks child
            WHERE child.parent_task_id = active.id
              AND child.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
          )
        )
      LIMIT 1
    `).get(candidateTaskId) as { id: string } | undefined;
    const agentActive = db.prepare(`
      SELECT agent_active.id FROM tasks agent_active
      JOIN tasks candidate ON candidate.assignee_id = agent_active.assignee_id
      WHERE candidate.id = ?
        AND agent_active.id != candidate.id
        AND agent_active.status IN ('in_progress', 'in_review')
        AND NOT (
          agent_active.status = 'in_progress'
          AND EXISTS (
            SELECT 1 FROM tasks child
            WHERE child.parent_task_id = agent_active.id
              AND child.status IN ('todo', 'pending_approval', 'in_progress', 'in_review')
          )
        )
      LIMIT 1
    `).get(candidateTaskId) as { id: string } | undefined;
    const settling = db.prepare(`
      SELECT settling.id FROM tasks settling
      JOIN tasks candidate ON candidate.goal_id = settling.goal_id
      WHERE candidate.id = ?
        AND settling.status = 'todo'
        AND julianday(settling.started_at) > julianday('now', '-5 seconds')
      LIMIT 1
    `).get(candidateTaskId) as { id: string } | undefined;

    return {
      claimed: false,
      taskId: candidateTaskId,
      reason: "conflict",
      error: settling
        ? `Goal has a recently released execution claim (${settling.id})`
        : active
        ? `Goal already has an active task (${active.id})`
        : agentActive
        ? `Agent already has an active task (${agentActive.id})`
        : `Task is already ${current.status}`,
      status: current.status,
    };
  });

  return claim.immediate(taskId);
}

export function createOrchestrationEngine(
  db: Database,
  sessionManager: SessionManager,
  broadcast: (event: string, data: unknown) => void,
) {
  const qualityGate = createQualityGate(db, sessionManager, broadcast);
  const delegationEngine = createDelegationEngine(db, sessionManager, broadcast, qualityGate);

  return {
    /**
     * Execute a single task: assign → run → verify → (optional fix)
     */
    async executeTask(
      taskId: string,
      config: Partial<OrchestrationConfig> = {},
      existingClaim?: Extract<TaskExecutionClaim, { claimed: true }>,
    ): Promise<{ success: boolean; verdict: string }> {
      const opts = { ...DEFAULT_CONFIG, ...config };
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
      if (!task) throw new Error(`Task ${taskId} not found`);

      const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(task.project_id) as ProjectRow | undefined;
      if (!project) throw new Error(`Project not found`);

      log.info(`Executing task: "${task.title}"`);

      // Pre-check: assignee must exist before any state changes
      if (!task.assignee_id) {
        throw new Error("Task has no assigned agent");
      }

      // Scheduler dispatch claims here; the manual API claims synchronously
      // before returning 202 and passes that ownership into this execution.
      if (!existingClaim || existingClaim.taskId !== taskId) {
        const claim = claimTaskForExecution(db, taskId);
        if (!claim.claimed) {
          throw new Error(`${claim.error} — skipping duplicate execution`);
        }
      }
      // 전체 row 를 보낸다 — 부분 페이로드({taskId, status})는 대시보드 스토어가
      // id 없는 유령 태스크로 append 해 렌더 크래시를 유발했다
      broadcast("task:updated", { ...task, id: taskId, status: "in_progress" });

      // 위임 부모 상태 정직화: 하위 작업이 도는 동안 부모는 '진행 중'이어야 한다.
      // (과거 ghost 복구가 대기 부모를 todo로 되돌린 경우의 복원 — 사용자에겐
      // "할 일"로 보여 멈춘 것으로 오인됐다)
      if (task.parent_task_id) {
        const promoted = db.prepare(
          "UPDATE tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND status = 'todo'",
        ).run(task.parent_task_id);
        if (promoted.changes > 0) {
          const parentRow = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.parent_task_id);
          if (parentRow) broadcast("task:updated", parentRow);
        }
      }

      const agent = db.prepare("SELECT name, role, needs_worktree FROM agents WHERE id = ?").get(task.assignee_id) as { name: string; role: string; needs_worktree: number } | undefined;
      const agentName = agent?.name ?? "";
      const needsWorktree = agent?.needs_worktree ?? 1; // 기본값: 워크트리 생성

      // 클레임 성공 후 · 세션 spawn 전 setup 단계(workdir 확인·goal worktree 준비 등)의
      // 오류는 아래 실행 try 의 catch 범위 밖이라, 그냥 throw 하면 태스크가 영구히
      // in_progress 에 방치된다(스케줄러도 사용자도 다시 집지 못함). 여기서 클레임을
      // 해제해 task_error 는 blocked(재시도 예산 소모), 그 외(env/rate limit)는 todo 로
      // 되돌린 뒤 재던진다. 이미 실행 try 의 catch 가 전이시킨 경우(status!=in_progress)엔
      // no-op 이라 이중 전이가 없다.
      const releaseClaimOnSetupFailure = (err: Error): never => {
        const cur = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
        if (cur?.status === "in_progress") {
          const cls = classifyAgentFailure(err);
          transitionTask(db, broadcast, task, cls === "task_error" ? "blocked" : "todo");
          db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE id = ?")
            .run(task.assignee_id);
          broadcast("agent:status", { id: task.assignee_id, name: agentName, status: "idle" });
        }
        throw err;
      };

      const workdir = project.workdir;
      if (!workdir) {
        releaseClaimOnSetupFailure(new Error("Project has no workdir configured"));
      }
      const { existsSync } = await import("node:fs");
      if (!existsSync(workdir)) {
        releaseClaimOnSetupFailure(new Error(`Working directory does not exist: ${workdir}`));
      }
      // A recovered task has already passed delegation and architecture in its
      // original execution. Re-running either phase could create a new
      // generator session before the persisted verification/fix checkpoint.
      const recoveryResumePhase = task.recovery_resume_phase;

      // Phase 0: Attempt delegation to subordinates (only for root tasks)
      if (!task.parent_task_id && recoveryResumePhase === null) {
        try {
          const delegation = await delegationEngine.attemptDelegation(taskId);
          if (delegation.delegated) {
            log.info(`Task "${task.title}" delegated to ${delegation.subtaskIds.length} subtasks`);
            // Reset agent status — delegation engine's finally already handles this,
            // but ensure it's clean on the return path
            db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE id = ?")
              .run(task.assignee_id);
            broadcast("agent:status", { id: task.assignee_id, name: agentName, status: "idle" });
            return { success: true, verdict: "delegated" };
          }
        } catch (delegationErr: any) {
          log.warn(`Delegation attempt failed, falling back to direct execution: ${delegationErr.message}`);
        }
      }

      // Worktree isolation (Sprint 4): Goal-as-Unit 은 needs_worktree=0이어도
      // goal 공유 worktree에서 실행한다. Legacy direct-root 실행만 프로젝트 루트를 쓴다.
      //
      // 이 해석은 architect phase '전'에 끝내야 한다. goal-as-unit에서 architect
      // 세션이 project root(base branch)에서 돌면, 지시를 어기고 파일을 만들었을 때
      // 아래 residue sweep이 base branch에 커밋을 남겨 '사용자 승인 전 base branch
      // 반영 차단' 계약을 우회한다. architect와 impl은 같은 격리 worktree에서 돈다.
      let effectiveWorkdir = workdir;
      let worktreeInfo: WorktreeInfo | null = null;

      // Goal 정보 조회 — goal_model 분기 결정
      const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(task.goal_id) as GoalRow | undefined;
      const isGoalAsUnit = goal?.goal_model === "goal_as_unit";
      const runsInProjectRoot = !isGoalAsUnit && !needsWorktree;

      if (isGoalAsUnit) {
        // Goal-as-Unit: 공유 worktree 사용 (Goal 시작 시 1회 생성)
        try {
          const { stashCheckpoint } = await import("../project/worktree.js");
          if (!goal) throw new Error(`Goal ${task.goal_id} not found`);

          const goalWorktree = await ensureGoalWorktreeRecorded(db, goal, workdir);
          effectiveWorkdir = goalWorktree.path;
          // 태스크 시작 전 stash 체크포인트
          stashCheckpoint(goalWorktree.path, task.id);
          log.info(`Goal-as-Unit: using shared worktree ${goalWorktree.path}`);
        } catch (err: any) {
          log.error(`Goal-as-Unit worktree setup failed for goal ${task.goal_id}: ${err.message}`);
          releaseClaimOnSetupFailure(err);
        }
      } else if (!needsWorktree) {
        log.info(`Skipping worktree for agent "${agentName}" (needs_worktree=0) — using project root`);
      } else {
        // Legacy: 태스크마다 독립 worktree
        try {
          const { createWorktree } = await import("../project/worktree.js");
          worktreeInfo = createWorktree(workdir, agentName, task.title);
          if (worktreeInfo) {
            effectiveWorkdir = worktreeInfo.path;
            log.info(`Using worktree: ${effectiveWorkdir}`);
          }
        } catch (err: any) {
          log.warn(`Worktree creation failed, using direct workdir: ${err.message}`);
        }
      }

      // Phase 0.5: Complexity detection + Architect phase (Crewdeck Orchestrator alignment)
      //
      // Skip architect phase for reviewer/qa roles: their job is to critique
      // existing code, not to produce a new design. Running architect on a
      // review task wastes a multi-minute CTO session and injects design
      // suggestions that bias the evaluator away from "find problems" stance.
      // Example: a review task that names 3 .py files in its description gets
      // classified as "moderate" by the regex heuristic and burns ~5-10 min
      // on architect output the reviewer never meaningfully uses.
      const reviewerLikeRoles = new Set(["reviewer", "qa", "qa-reviewer"]);
      const isReviewerTask = reviewerLikeRoles.has(agent?.role ?? "");
      const complexity = detectComplexity(task);
      let architectContext = "";

      if (complexity !== "simple" && !task.parent_task_id && !isReviewerTask && recoveryResumePhase === null) {
        const ctoAgent = db.prepare(
          "SELECT * FROM agents WHERE project_id = ? AND role = 'cto' AND id != ? LIMIT 1",
        ).get(task.project_id, task.assignee_id) as AgentRow | undefined;

        if (ctoAgent) {
          log.info(`Architect phase for "${task.title}" (complexity: ${complexity})`);
          // Surface the architect activity on the CTO agent card so the
          // dashboard shows "architect: <task title>" instead of a silent
          // working blob with no current_activity. This mirrors what we
          // did for decompose and for the Evaluator — every multi-minute
          // phase that spawns an agent should identify itself.
          const architectActivity = `architect:${(task.title ?? "").slice(0, 80)}`;
          db.prepare(
            "UPDATE agents SET current_task_id = ?, current_activity = ? WHERE id = ?",
          ).run(taskId, architectActivity, ctoAgent.id);
          broadcast("agent:status", {
            id: ctoAgent.id,
            status: "working",
            taskId,
            activity: architectActivity,
          });
          db.prepare(
            "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'architect_started', ?)",
          ).run(
            task.project_id,
            ctoAgent.id,
            `아키텍처 설계 시작 (${complexity}): "${(task.title ?? "").slice(0, 80)}"`,
          );
          broadcast("project:updated", { projectId: task.project_id });

          const methodology = createMethodologyEngine();
          const architectPrompt = buildArchitectPrompt(task, methodology);
          const archSessionKey = `architect-${taskId}`;
          // 세션 시작 전 dirty 스냅샷 — residue sweep이 "세션 중 새로 생긴 것"만
          // 커밋하도록 기준선을 잡는다. 이게 없으면 사용자가 원래 갖고 있던
          // untracked 자산까지 "architect 잔여물"로 오인해 main에 커밋한다
          // (proof dogfooding: 사용자 목업 PNG 6개가 main에 커밋된 P1).
          const preArchDirty = new Set<string>(await (async () => {
            try {
              const { spawnSync } = await import("node:child_process");
              const pre = spawnSync("git", ["status", "--porcelain"], {
                cwd: effectiveWorkdir, stdio: "pipe", timeout: 5_000, encoding: "utf-8",
              });
              return (pre.stdout ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean)
                .map((line) => {
                  const raw = line.slice(3).replace(/^"|"$/g, "");
                  return raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
                });
            } catch {
              return [] as string[];
            }
          })());
          try {
            const archSession = sessionManager.spawnAgent(ctoAgent.id, effectiveWorkdir, archSessionKey, taskId);
            // Mirror the listeners we attach to the impl session so that
            // architect-phase rate-limits and stream errors also surface to
            // the dashboard (previously they only showed up as an extra
            // architect_started retry with no explanation).
            archSession.on("rate-limit", (info: { waitMs: number; stderr: string }) => {
              broadcast("system:rate-limit", {
                agentId: ctoAgent.id,
                agentName: "architect",
                taskId,
                waitMs: info.waitMs,
                message: info.stderr,
              });
              try {
                db.prepare(
                  "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'rate_limit_hit', ?)",
                ).run(
                  task.project_id,
                  ctoAgent.id,
                  `[architect] Rate limit 감지 (${Math.round(info.waitMs / 1000)}s wait): ${(info.stderr ?? "").slice(0, 300)}`,
                );
              } catch { /* best-effort */ }
            });
            archSession.on("crewdeck:error", (error: unknown) => {
              broadcast("system:error", { agentId: ctoAgent.id, agentName: "architect", taskId, error });
            });
            const archResult = await archSession.send(architectPrompt);
            const archParsed = parseAgentOutput(archResult.stdout, archResult.provider);
            // Silent failure detection — same gate used for impl phase. An
            // architect session that returns exit≠0 or emits only stream
            // errors (including "Empty stdout") has been looking "proceed
            // without design" in logs while silently burning rate-limit
            // budget in repeated retries. Surface it as an activity so the
            // dashboard shows WHY each architect attempt failed.
            const archFailure = detectAgentRunFailure(archResult, archParsed);
            if (archFailure) {
              log.warn(
                `Architect phase silent failure [${archFailure.code}]: ${archFailure.message}`,
                { taskId, detail: archFailure.detail },
              );
              db.prepare(
                "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'architect_failed', ?)",
              ).run(
                task.project_id,
                ctoAgent.id,
                `아키텍처 설계 실패 [${archFailure.code}]: ${archFailure.message.slice(0, 200)}${
                  archFailure.detail ? ` — ${archFailure.detail.slice(0, 200)}` : ""
                }`,
              );
              architectContext = "";
            } else {
              architectContext = archParsed.text ?? "";
              log.info(`Architect design complete for "${task.title}" (${architectContext.length} chars)`);
              db.prepare(
                "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'architect_completed', ?)",
              ).run(
                task.project_id,
                ctoAgent.id,
                `아키텍처 설계 완료 (${architectContext.length}자): "${(task.title ?? "").slice(0, 80)}"`,
              );
            }
          } catch (archErr: any) {
            log.warn(`Architect phase failed, proceeding without design: ${archErr.message}`);
            db.prepare(
              "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'architect_failed', ?)",
            ).run(
              task.project_id,
              ctoAgent.id,
              `아키텍처 설계 예외: ${(archErr?.message ?? String(archErr)).slice(0, 300)}`,
            );
          } finally {
            sessionManager.killSession(archSessionKey);
            // Clear architect activity — killSession resets status but the
            // current_activity string "architect:..." can linger if another
            // code path had already set it. Explicit WHERE guard avoids
            // stomping on activity set by later phases.
            db.prepare(
              "UPDATE agents SET current_activity = NULL WHERE id = ? AND current_activity LIKE 'architect:%'",
            ).run(ctoAgent.id);
            broadcast("agent:status", {
              id: ctoAgent.id,
              status: "idle",
            });
            // Defensive sweep: the architect is told NOT to create files but
            // historically has still done so (Crewdeck incident: architect wrote
            // auth-infrastructure.md to project root → every subsequent task's
            // merge-to-main failed for 8h with "Your local changes would be
            // overwritten"). Auto-commit any residue immediately so future
            // merges see a clean tree.
            try {
              const { spawnSync } = await import("node:child_process");
              const statusRes = spawnSync("git", ["status", "--porcelain"], {
                cwd: effectiveWorkdir, stdio: "pipe", timeout: 5_000, encoding: "utf-8",
              });
              // 도구 상태(.omc 등)는 커밋 대상에서 제외 — untracked로 남아도 머지를
              // 막지 않고, 커밋하면 정크가 사용자 레포 히스토리에 남는다 (R1 발견)
              const { TOOL_STATE_PATHS } = await import("../quality-gate/evaluator.js");
              const dirtyLines = (statusRes.stdout ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
              // 세션 전부터 dirty였던 항목(사용자의 기존 untracked/수정)은 잔여물이 아니다
              const realDirty = dirtyLines.filter((line) => {
                const raw = line.slice(3).replace(/^"|"$/g, "");
                const path = raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
                if (preArchDirty.has(path)) return false;
                return !TOOL_STATE_PATHS.some((t: string) => path === t || path.startsWith(`${t}/`));
              });
              if (realDirty.length > 0) {
                log.warn(`Architect phase left uncommitted changes despite read-only instruction — auto-committing as docs(crewdeck-architect):\n${realDirty.join("\n").slice(0, 500)}`);
                // 신규 잔여물 경로만 스테이징 — `add -A .`는 사용자의 기존
                // untracked/수정 파일까지 쓸어담아 main을 오염시킨다
                const residuePaths = realDirty.map((line) => {
                  const raw = line.slice(3).replace(/^"|"$/g, "");
                  return raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
                });
                spawnSync("git", [
                  "add", "-A", "--", ...residuePaths,
                ], { cwd: effectiveWorkdir, stdio: "pipe", timeout: 10_000 });
                const commitRes = spawnSync("git", [
                  "commit", "-m",
                  `docs(crewdeck-architect): residue from "${task.title.slice(0, 60)}" architect phase\n\nCrewdeck auto-committed files left by the CTO architect session.\nThis prevents them from blocking subsequent task merges.`,
                ], { cwd: effectiveWorkdir, stdio: "pipe", timeout: 10_000, encoding: "utf-8" });
                if (commitRes.status === 0) {
                  db.prepare(
                    "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)"
                  ).run(task.project_id, `Architect가 파일을 생성했습니다 — 자동 커밋으로 충돌 방지: ${realDirty.length}개 파일`);
                }
              }
            } catch (sweepErr: any) {
              log.warn(`Architect residue sweep failed: ${sweepErr.message}`);
            }
          }
        }
      }

      // Auto-detect verification scope if not explicitly set (Crewdeck §1 alignment)
      const effectiveVerificationScope = opts.verificationScope !== "standard"
        ? opts.verificationScope
        : autoDetectScope(task, undefined);

      // Phase 1: in_progress transition already done by atomic CAS guard above

      // Goal 취소 가드: DELETE /goals/:id 가 이 goal 을 지우면 tasks 는 CASCADE 로
      // 사라진다. architect phase 가 도는 사이 삭제가 들어온 경우 여기서 멈추지 않으면
      // 이미 없어진 goal 을 위해 구현 세션을 새로 spawn 하게 된다 (orchestration 잔여).
      // 새 세션 spawn 직전에 태스크 존재를 재확인해 조용히 중단한다.
      const taskStillExists = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
      if (!taskStillExists) {
        log.info(`Task ${taskId} deleted mid-execution (goal cancelled) — aborting before implementation spawn`);
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE id = ?")
          .run(task.assignee_id);
        broadcast("agent:status", { id: task.assignee_id, name: agentName, status: "idle" });
        return { success: false, verdict: "aborted" };
      }

      // Phase 2: Execute via assigned agent
      const resumePhase = isGoalAsUnit ? recoveryResumePhase : null;
      const runsImplementation = resumePhase === null || resumePhase === "implementation";
      // Goal-as-Unit recovery checkpoint. Capture this after the optional
      // architect phase (which can defensively commit residue) and immediately
      // before the implementation process starts.
      if (isGoalAsUnit && resumePhase === null) {
        const { inspectWorktreeRecoveryState } = await import("../project/worktree.js");
        const state = inspectWorktreeRecoveryState(effectiveWorkdir, goal!.worktree_branch!);
        if (state.status !== "safe" || !state.headSha) {
          releaseClaimOnSetupFailure(new Error(`Cannot checkpoint goal worktree: ${state.reasons.join("; ")}`));
        }
        db.prepare(`
          UPDATE tasks SET
            recovery_checkpoint_head_sha = ?,
            recovery_worktree_branch = ?,
            recovery_worktree_dirty = ?,
            recovery_worktree_diff_hash = ?,
            recovery_manual_action_required = 0,
            recovery_manual_action_reason = NULL,
            recovery_commit_ready = 0,
            recovery_commit_sha = NULL,
            recovery_resume_phase = NULL,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          state.headSha,
          goal!.worktree_branch,
          state.dirty ? 1 : 0,
          state.diffHash,
          task.id,
        );
      }

      let session;
      let implementationSessionRowId: string | null = null;
      let abnormalRecoveryDecision: "resume" | "advance" | "wait_approval" | "blocked" | null = null;
      if (runsImplementation) {
        try {
          // taskId를 넘겨 sessions.task_id를 찍는다 — failover 재디스패치 backfill이
          // 이 세션을 task에 정확히 귀속하려면 agent+provider+rowid만으론 부족하다.
          session = sessionManager.spawnAgent(task.assignee_id, effectiveWorkdir, undefined, taskId);
          implementationSessionRowId = sessionManager.getSessionRecord(task.assignee_id)?.rowId ?? null;
        } catch (spawnErr: any) {
          log.error(`Failed to spawn agent for task "${task.title}"`, spawnErr);
          const error = spawnErr instanceof AgentError
            ? spawnErr
            : new Error(`Agent spawn failed: ${spawnErr.message}`);
          return releaseClaimOnSetupFailure(error);
        }
      }

      // Stream agent output to WebSocket
      session?.on("output", (text: string) => {
        broadcast("agent:output", { agentId: task.assignee_id, output: text, taskId });
      });

      session?.on("rate-limit", (info: { waitMs: number; stderr: string }) => {
        broadcast("system:rate-limit", {
          agentId: task.assignee_id,
          agentName,
          taskId,
          waitMs: info.waitMs,
          message: info.stderr,
        });
        // Persist the raw stderr snippet so post-mortem can distinguish a
        // real 429 from noise (stderr gets truncated to 200 chars upstream,
        // which is enough for the quota-exhausted signature).
        try {
          db.prepare(
            "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'rate_limit_hit', ?)",
          ).run(
            task.project_id,
            task.assignee_id,
            `[impl] Rate limit 감지 (${Math.round(info.waitMs / 1000)}s wait): ${(info.stderr ?? "").slice(0, 300)}`,
          );
        } catch { /* best-effort */ }
      });

      // Sprint 5: broadcast structured errors for Trust UX
      session?.on("crewdeck:error", (error: unknown) => {
        broadcast("system:error", {
          agentId: task.assignee_id,
          agentName,
          taskId,
          error,
        });
      });
      const execActivity = `${resumePhase && resumePhase !== "implementation" ? `resume-${resumePhase}` : "task"}:${task.title?.slice(0, 80) ?? ""}`;
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, current_activity = ? WHERE id = ?")
        .run(taskId, execActivity, task.assignee_id);
      broadcast("agent:status", { id: task.assignee_id, name: agentName, status: "working", taskId, activity: execActivity });
      broadcast("task:started", { taskId, agentId: task.assignee_id, startedAt: new Date().toISOString() });

      try {
        const persistGoalTaskCommit = (): void => {
          if (!isGoalAsUnit) return;
          const checkpoint = db.prepare(
            "SELECT recovery_checkpoint_head_sha FROM tasks WHERE id = ?",
          ).get(task.id) as { recovery_checkpoint_head_sha: string | null } | undefined;
          if (!checkpoint?.recovery_checkpoint_head_sha) {
            throw new Error("Goal task recovery checkpoint is missing");
          }
          db.prepare(
            "UPDATE tasks SET recovery_commit_ready = 1, updated_at = datetime('now') WHERE id = ?",
          ).run(task.id);
          commitTaskResult(effectiveWorkdir, task.title, agentName);
          const evidence = recoverTaskCommitEvidence(
            effectiveWorkdir,
            checkpoint.recovery_checkpoint_head_sha,
          );
          if (evidence.status === "manual_action_required") {
            throw new Error(`Goal task commit evidence is ambiguous: ${evidence.reason ?? "unknown"}`);
          }
          if (evidence.commitSha) {
            db.prepare(`
              UPDATE tasks SET recovery_commit_sha = ?, recovery_resume_phase = 'verification',
                updated_at = datetime('now') WHERE id = ?
            `).run(evidence.commitSha, task.id);
          }
        };

        const executionSpecContext = formatExecutionSpecContext(getTaskExecutionSpec(db, task.id));
        if (runsImplementation) {
        const methodology = createMethodologyEngine();
        const autoApplyRules = methodology.getAutoApplyRules();

        // Parse scope-anchoring fields (P2: Pulsar scope-drift fix)
        const targetFiles: string[] = (() => {
          try {
            const parsed = JSON.parse(task.target_files ?? "[]");
            return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
          } catch {
            return [];
          }
        })();
        const stackHint = (task.stack_hint ?? "").trim();

        const scopeAnchor = targetFiles.length > 0 || stackHint
          ? `
## Primary Target — Stay Within Scope
${targetFiles.length > 0 ? `**Expected files** (a planning-time *guess* — follow the real architecture if it differs):
${targetFiles.map((f) => `- \`${f}\``).join("\n")}

If the real structure places this logic elsewhere (e.g. an \`adapters/\`
subdir, a different but equivalent module), use the CORRECT path — do NOT
create a wrong-place file just to match this list. Only avoid drifting into
*unrelated* features.` : ""}
${stackHint ? `\n**Stack constraint:** ${stackHint}

Match the conventions of the nearest existing code in the same stack. Do NOT
introduce a different framework / language / build tool to solve this task.` : ""}
`
          : "";

        // Goal-as-Unit: 이전 태스크 result_summary 체인 주입
        let previousTaskContext = "";
        if (isGoalAsUnit) {
          const prevTasks = db.prepare(`
            SELECT title, result_summary FROM tasks
            WHERE goal_id = ? AND status = 'done' AND result_summary IS NOT NULL
            ORDER BY sort_order ASC, updated_at ASC
          `).all(task.goal_id) as { title: string; result_summary: string }[];
          if (prevTasks.length > 0) {
            previousTaskContext = `\n## 이전 태스크 완료 상태\n${prevTasks.map((t) => `- [완료] ${t.title}: ${t.result_summary.slice(0, 200)}`).join("\n")}\n`;
          }
        }

        // Smart Resume: 재시도/재배정 실행이 이전 사이클의 실패 원인을 알고 시작하도록 주입.
        // (기존에는 autoFix 경로에만 있어, blocked→재시도가 같은 이슈를 백지에서 재발견했다)
        const priorFailureContext = buildFailureHistoryContext(db, task.id);

        const implementationPrompt = `
# Task: ${task.title}

${task.description}
${executionSpecContext}
${previousTaskContext}${priorFailureContext ? `${priorFailureContext}\n\nThe issues above caused previous attempts of THIS task to fail verification.\nThe workspace was restored to its pre-task state, so your implementation must\nsolve the task AND avoid re-introducing every issue listed above.\n` : ""}${scopeAnchor}${architectContext ? `\n## Architecture Design\n${architectContext}\n` : ""}
## Crewdeck Auto-Apply Rules
${autoApplyRules || "Follow clean code conventions and existing patterns."}

## Constraints
- Clean, production-ready code
- Follow existing codebase conventions
- Run lint/type-check before finishing
- DO NOT verify your own work — verification is handled by independent Evaluator
- Fix ONLY what the task requires — do not refactor unrelated code
${runsInProjectRoot ? `
## Managed Directories — DO NOT TOUCH
You are running directly in the project root (no isolated worktree). The
following directories belong to OTHER concurrent tasks and Crewdeck's
worktree manager — do NOT create, modify, or delete files inside them:
- \`.crewdeck-worktrees/\`
- \`.claude/worktrees/\`

Any file you create elsewhere in the project will be committed as part of
this task. Prefer returning findings as prose in your response rather than
writing files for review/QA tasks.
` : ""}
When complete, provide a summary of changes made.
`;

        let implResult;
        try {
          implResult = await session!.send(implementationPrompt);
        } catch (sendErr) {
          abnormalRecoveryDecision = sessionManager.recoverAbnormalExit?.(
            task.assignee_id,
            "implementation",
            "reconcile",
            "implementation session exited before producing a final result",
          ) ?? null;
          throw sendErr;
        }
        const implParsed = parseAgentOutput(implResult.stdout, implResult.provider);

        // Hard gate: detect silent failures where the CLI crashed, the stream
        // emitted errors, or an API error signature leaked into assistant text.
        // Without this the task gets marked done with garbage like
        // "API Error: Unable to connect to API (ECONNRESET)" as its summary.
        const implFailure = detectAgentRunFailure(implResult, implParsed);
        if (implFailure) {
          abnormalRecoveryDecision = sessionManager.recoverAbnormalExit?.(
            task.assignee_id,
            "implementation",
            "reconcile",
            `implementation session failed: ${implFailure.message}`,
          ) ?? null;
          log.error(`Implementation failed [${implFailure.code}]: ${implFailure.message}`, {
            taskId,
            taskTitle: task.title,
            detail: implFailure.detail,
          });
          broadcast("system:error", {
            agentId: task.assignee_id,
            agentName,
            taskId,
            error: implFailure.toJSON(),
          });
          // Persist token usage if any output was produced before the failure
          if (implParsed.usage) {
            const failTokens = implParsed.usage.inputTokens + implParsed.usage.outputTokens + implParsed.usage.cacheCreationTokens;
            db.prepare(
              `UPDATE sessions
                 SET token_usage = token_usage + ?, token_usage_reported = ?,
                     cost_usd = cost_usd + ?, cost_usd_reported = ?
               WHERE id = ?`,
            ).run(
              implParsed.usage.tokenUsageReported ? failTokens : 0,
              implParsed.usage.tokenUsageReported ? 1 : 0,
              implParsed.usage.costUsdReported ? implParsed.usage.totalCostUsd : 0,
              implParsed.usage.costUsdReported ? 1 : 0,
              implementationSessionRowId,
            );
            db.prepare(
              "UPDATE tasks SET token_usage = token_usage + ?, cost_usd = cost_usd + ? WHERE id = ?",
            ).run(failTokens, implParsed.usage.totalCostUsd ?? 0, task.id);
          }
          sessionManager.killSession(task.assignee_id);
          // Re-throw so executeTask's catch transitions the task to blocked and
          // the scheduler's retry/reassign budget takes over. This is the ONLY
          // path that prevents silent API failures from being marked done.
          throw implFailure;
        }

        // Update session token usage BEFORE killSession (which sets status='killed')
        if (implParsed.usage) {
          const implTokens = implParsed.usage.inputTokens + implParsed.usage.outputTokens + implParsed.usage.cacheCreationTokens;
          db.prepare(
            `UPDATE sessions
               SET token_usage = token_usage + ?, token_usage_reported = ?,
                   cost_usd = cost_usd + ?, cost_usd_reported = ?
             WHERE id = ?`,
          ).run(
            implParsed.usage.tokenUsageReported ? implTokens : 0,
            implParsed.usage.tokenUsageReported ? 1 : 0,
            implParsed.usage.costUsdReported ? implParsed.usage.totalCostUsd : 0,
            implParsed.usage.costUsdReported ? 1 : 0,
            implementationSessionRowId,
          );
          // Persist per-task cumulative usage — survives reload and accumulates
          // across retries/fix-rounds so a struggling task shows a growing total.
          db.prepare(
            "UPDATE tasks SET token_usage = token_usage + ?, cost_usd = cost_usd + ? WHERE id = ?",
          ).run(implTokens, implParsed.usage.totalCostUsd ?? 0, task.id);
        }

        // 구현 세션 즉시 정리 — verification에서 같은 agentId 충돌 방지
        sessionManager.killSession(task.assignee_id);

        // Defensive sweep: legacy direct-root reviewer/qa tasks can still write
        // into managed worktree directories. Those writes belong to OTHER tasks,
        // so detect and auto-clean the residue from this commit path.
        if (runsInProjectRoot) {
          try {
            const { spawnSync } = await import("node:child_process");
            const statusRes = spawnSync(
              "git",
              ["status", "--porcelain", "--", ".crewdeck-worktrees/", ".claude/worktrees/"],
              { cwd: effectiveWorkdir, stdio: "pipe", timeout: 5_000, encoding: "utf-8" },
            );
            const dirty = statusRes.stdout?.trim();
            if (dirty) {
              const lines = dirty.split("\n").filter(Boolean);
              log.warn(
                `Reviewer/QA task "${task.title}" left ${lines.length} file(s) in managed worktree dirs — auto-excluded from commit:\n${dirty.slice(0, 400)}`,
              );
              db.prepare(
                "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'autopilot_warning', ?)",
              ).run(
                task.project_id,
                task.assignee_id,
                `리뷰어/QA가 관리 디렉토리에 ${lines.length}개 파일 생성 — 자동으로 commit에서 제외됨`,
              );
            }
          } catch (sweepErr: any) {
            log.warn(`Reviewer residue sweep failed: ${sweepErr.message}`);
          }
        }

        log.info(`Implementation complete for task "${task.title}"`, {
          cost: implParsed.usage?.totalCostUsd,
          tokens: implParsed.usage ? implParsed.usage.inputTokens + implParsed.usage.outputTokens + implParsed.usage.cacheCreationTokens : 0,
          duration: implParsed.usage?.durationMs,
        });

        // The implementation boundary is the durable hand-off to verification.
        // Commit before changing task status so startup can resume verification
        // without ever executing the generator twice.
        persistGoalTaskCommit();

        // Sprint 6: result_summary 저장 — 마무리 텍스트를 문단 경계로 (mid-sentence 잘림 방지)
        const summary = extractWrapUp(implParsed.text ?? "", MAX_SUMMARY_LEN);
        db.prepare("UPDATE tasks SET result_summary = ? WHERE id = ?").run(summary, task.id);

        // Sprint 6: 에이전트 메모리에 태스크 완료 기록
        if (task.assignee_id) {
          const dataDir = process.env.CREWDECK_DATA_DIR || join(process.cwd(), ".crewdeck");
          const memoryEntry = `Task "${task.title}" completed. Summary: ${summary}`;
          try {
            appendMemory(dataDir, task.assignee_id, memoryEntry);
          } catch (memErr: any) {
            log.warn(`Failed to append agent memory: ${memErr.message}`);
          }
        }

        // Broadcast usage data for dashboard — include cumulative per-task totals
        // (matches persisted value + fix-round usage) so the chip is consistent.
        if (implParsed.usage) {
          const taskTotals = db.prepare(
            "SELECT token_usage AS totalTokens, cost_usd AS costUsd FROM tasks WHERE id = ?",
          ).get(task.id) as { totalTokens: number; costUsd: number } | undefined;
          broadcast("task:usage", {
            taskId,
            agentId: task.assignee_id,
            usage: implParsed.usage,
            cumulative: taskTotals ?? null,
          });
        }

        // Broadcast completion
        broadcast("task:completed", {
          taskId,
          agentId: task.assignee_id,
          completedAt: new Date().toISOString(),
        });

        // Log activity
        db.prepare(`
          INSERT INTO activities (project_id, agent_id, type, message)
          VALUES (?, ?, 'task_completed', ?)
        `).run(task.project_id, task.assignee_id, `Completed: ${task.title}`);
        }

        // Subtasks skip verification (design decision: parent task level QG only)
        if (task.parent_task_id) {
          transitionTask(db, broadcast, task, "done");
          return { success: true, verdict: "pass" };
        }

        // Phase 3: Move to review
        transitionTask(db, broadcast, task, "in_review");

        // Phase 4: Quality Gate verification (worktree 경로 전달)
        const verification = resumePhase === "fix"
          ? loadInterruptedFixVerification(db, taskId)
          : await qualityGate.verify(taskId, {
            scope: effectiveVerificationScope,
            workdir: effectiveWorkdir,
          });
        if (!verification) {
          throw new Error(`Interrupted fix checkpoint for task ${taskId} has no source verification`);
        }

        const stopForEvaluatorError = async (result: typeof verification): Promise<boolean> => {
          if (result.terminationReason !== "evaluator_error") return false;
          if (isGoalAsUnit) {
            const { dropCheckpoint } = await import("../project/worktree.js");
            dropCheckpoint(effectiveWorkdir, task.id);
          }
          transitionTask(db, broadcast, task, "blocked");
          db.prepare(`
            INSERT INTO activities (project_id, agent_id, type, message, metadata)
            VALUES (?, ?, 'verification_stopped', ?, ?)
          `).run(
            task.project_id,
            task.assignee_id,
            `Evaluator error stopped verification: ${task.title}`,
            JSON.stringify({
              taskId,
              sourceVerificationId: result.id,
              status: "stopped",
              reason: "evaluator_error",
            }),
          );
          return true;
        };

        if (await stopForEvaluatorError(verification)) {
          return { success: false, verdict: verification.verdict };
        }

        // Phase 5: Auto-fix loop — 통과할 때까지 fix→재검증을 반복(최대 min(opts.maxFixRetries, MAX_FIX_ROUNDS)).
        // 완료가 목적. 인시던트(무한 검토)의 근본원인 scope-creep 은 verdict 범위 정책 + 실패이력
        // 주입으로 이미 차단됐으므로, 라운드를 늘려도 스핀이 아니라 수렴한다. 라운드마다 provider
        // 교차(codex↔claude)로 한 모델이 못 고치면 다른 모델이 시도. 이 루프를 다 쓰고도 실패한
        // 극소수는 goal-as-unit이면 pending_approval(사람 승인)로, 아니면 blocked로 넘긴다.
        let reVerification = verification;
        // evaluator_error(파싱 실패/세션 재사용 위반)는 Generator 코드 결함이 아니라
        // Evaluator 자체의 구조화 출력 실패다 — fix task로 정규화할 필드가 없으므로
        // 이 루프에 넣지 않는다(넣으면 fixTask 0개인 채 generic 프롬프트만 소모).
        const effectiveMaxRounds = Math.min(opts.maxFixRetries, MAX_FIX_ROUNDS);
        const autoFixEligible = verification.verdict === "fail"
          && verification.terminationReason !== "evaluator_error"
          && opts.autoFix && opts.maxFixRetries > 0;
        if (autoFixEligible) {
          const provCfg = loadProviderConfig();
          const lastSess = db.prepare(
            "SELECT provider FROM sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1",
          ).get(task.assignee_id) as { provider: string | null } | undefined;
          const implProvider: "claude" | "codex" = lastSess?.provider === "codex" ? "codex" : "claude";
          const codexAvailable = await getBackend("codex").isAvailable();

          let round = 0;
          // 스톨 감지: 이슈 셋 지문이 연속 동일하면 = fix 가 못 없앰(수렴 실패/외부 blocker) → 조기 escalate
          let prevIssueSig = issueSetSignature(verification.issues);
          let noProgressRounds = 0;
          while (reVerification.verdict === "fail" && round < effectiveMaxRounds) {
            // Goal DELETE can terminate the evaluator/fix subprocess while its
            // send Promise is settling. Never spawn the next auto-fix session
            // or re-verifier after the task has been CASCADE-deleted.
            if (!db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) {
              log.info(`Task ${taskId} deleted during verification — aborting auto-fix`);
              return { success: false, verdict: "aborted" };
            }
            round++;
            const sourceVerificationId = reVerification.id;
            log.info(`Verification FAIL — auto-fix round ${round}/${effectiveMaxRounds}`);
            db.prepare(`
              INSERT INTO activities (project_id, agent_id, type, message, metadata)
              VALUES (?, ?, 'verification_fixing', ?, ?)
            `).run(
              task.project_id,
              task.assignee_id,
              `Auto-fix round ${round}/${effectiveMaxRounds}: ${task.title}`,
              JSON.stringify({
                taskId,
                sourceVerificationId,
                status: "fixing",
                reason: "auto_fix_in_progress",
                round,
                maxRounds: effectiveMaxRounds,
              }),
            );

            const conversion = createFixTasksFromVerification(db, sourceVerificationId);
            for (const fixTask of conversion.fixTasks) {
              if (fixTask.created) {
                broadcast("task:updated", {
                  id: fixTask.taskId,
                  goal_id: task.goal_id,
                  project_id: task.project_id,
                  title: fixTask.title,
                  description: fixTask.description,
                  assignee_id: fixTask.assigneeId,
                  status: fixTask.status,
                  action: "created",
                });
              }
            }
            if (conversion.manualApprovalRequired) {
              transitionTask(db, broadcast, task, "pending_approval");
              db.prepare(`
                INSERT INTO activities (project_id, type, message, metadata)
                VALUES (?, 'verification_manual_approval', ?, ?)
              `).run(
                task.project_id,
              `Fix task assignee unavailable: ${task.title}`,
                JSON.stringify({
                  taskId,
                  sourceVerificationId,
                  status: "manual_approval",
                  reason: "fix_assignee_unavailable",
                }),
              );
              return { success: false, verdict: "conditional" };
            }

            const mappedFixTasks = conversion.fixTasks.filter((fixTask) => fixTask.assigneeId !== null);
            if (mappedFixTasks.length > 0) {
              const placeholders = mappedFixTasks.map(() => "?").join(", ");
              db.prepare(`
                UPDATE tasks SET status = 'pending_approval', updated_at = datetime('now')
                WHERE id IN (${placeholders})
              `).run(...mappedFixTasks.map((fixTask) => fixTask.taskId));
              for (const fixTask of mappedFixTasks) {
                broadcast("task:updated", { id: fixTask.taskId, status: "pending_approval" });
              }
            }

            // 누적 실패 이력 + 이번 라운드 이슈를 함께 주입 (Smart Resume)
            const failureContext = buildFailureHistoryContext(db, task.id, 3);
            const structuredFixPrompts = mappedFixTasks
              .map((fixTask) => fixTask.description)
              .join("\n\n---\n\n");
            const fixPrompt = `
# Fix Required (Smart Resume — round ${round}/${effectiveMaxRounds})
${executionSpecContext}
${failureContext}

${structuredFixPrompts || `The following issues were found during verification:
${reVerification.issues.map((i) => `- [${i.severity}] ${i.file ?? ""}:${i.line ?? ""} — ${i.message}`).join("\n")}`}

Fix ONLY these issues. Do not modify other code.
`;
            // provider 교차: 홀수 라운드는 구현 provider의 반대(codex↔claude), 짝수는 구현 provider.
            // failover 꺼졌거나 codex 미가용이면 교차 없이 같은 provider. 한 모델이 못 고치면 다른 모델이 시도.
            if (provCfg.codexFailover) {
              const wantAlt = round % 2 === 1;
              const target: "claude" | "codex" = wantAlt ? (implProvider === "claude" ? "codex" : "claude") : implProvider;
              const targetAvailable = target === "codex" ? codexAvailable : true;
              if (targetAvailable) {
                sessionManager.setProviderOverride(task.assignee_id, target);
                log.info(`Auto-fix round ${round} provider: ${target}`);
              }
            }

            // Spawn a NEW session for fix (prevent context pollution — Crewdeck rule)
            if (isGoalAsUnit) {
              db.prepare("UPDATE tasks SET recovery_resume_phase = 'fix', updated_at = datetime('now') WHERE id = ?")
                .run(task.id);
            }
            db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, current_activity = ? WHERE id = ?")
              .run(taskId, `fix(${round}): ${task.title?.slice(0, 72) ?? ""}`, task.assignee_id);
            const fixSession = sessionManager.spawnAgent(task.assignee_id, effectiveWorkdir, undefined, taskId);
            const fixSessionRecord = sessionManager.getSessionRecord(task.assignee_id);
            const fixSessionRowId = fixSessionRecord?.rowId && db.prepare(
              "SELECT id FROM sessions WHERE id = ?",
            ).get(fixSessionRecord.rowId)
              ? fixSessionRecord.rowId
              : null;
            // runtime_session_id: session_id(sessions row id)는 evaluator의 runtime
            // session id와 절대 충돌하지 않으므로, 세션 재사용(맥락 누수) 탐지에 쓰일
            // CLI runtime id를 별도로 기록한다. spawn 직후엔 아직 null일 수 있어
            // send() 이후 backfill한다.
            const fixSessionRuntimeId = fixSessionRecord?.runtimeSessionId ?? null;
            db.prepare(`
              INSERT INTO verification_fix_rounds (
                task_id, source_verification_id, round_number, assignee_id,
                session_id, runtime_session_id, status, started_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'running', datetime('now'))
              ON CONFLICT(source_verification_id) DO UPDATE SET
                round_number = excluded.round_number,
                assignee_id = excluded.assignee_id,
                session_id = excluded.session_id,
                runtime_session_id = excluded.runtime_session_id,
                status = 'running',
                started_at = datetime('now'),
                completed_at = NULL
            `).run(taskId, sourceVerificationId, round, task.assignee_id, fixSessionRowId, fixSessionRuntimeId);
            fixSession.on("rate-limit", (info: { waitMs: number; stderr: string }) => {
              broadcast("system:rate-limit", { agentId: task.assignee_id, agentName, taskId, waitMs: info.waitMs, message: info.stderr });
            });
            fixSession.on("crewdeck:error", (error: unknown) => {
              broadcast("system:error", { agentId: task.assignee_id, agentName, taskId, error });
            });
            let fixRuntimeSessionId: string | null = fixSessionRuntimeId;
            let fixRunFailed = false;
            try {
              const fixResult = await fixSession.send(fixPrompt);
              // runtime session id는 send() 이후에야 확정된다 — spawn 시점 null을 교정.
              fixRuntimeSessionId = fixResult.sessionId ?? fixSessionRecord?.runtimeSessionId ?? fixRuntimeSessionId;
              const fixParsed = parseAgentOutput(fixResult.stdout, fixResult.provider);
              // 헤맴 신호: fix 라운드 토큰도 태스크에 누적 (반복 수정할수록 총량↑)
              if (fixParsed.usage) {
                const fixTokens = fixParsed.usage.inputTokens + fixParsed.usage.outputTokens + fixParsed.usage.cacheCreationTokens;
                db.prepare(`
                  UPDATE sessions
                     SET token_usage = token_usage + ?, token_usage_reported = ?,
                         cost_usd = cost_usd + ?, cost_usd_reported = ?
                   WHERE id = ?
                `).run(
                  fixParsed.usage.tokenUsageReported ? fixTokens : 0,
                  fixParsed.usage.tokenUsageReported ? 1 : 0,
                  fixParsed.usage.costUsdReported ? fixParsed.usage.totalCostUsd : 0,
                  fixParsed.usage.costUsdReported ? 1 : 0,
                  fixSessionRowId,
                );
                db.prepare(
                  "UPDATE tasks SET token_usage = token_usage + ?, cost_usd = cost_usd + ? WHERE id = ?",
                ).run(fixTokens, fixParsed.usage.totalCostUsd ?? 0, task.id);
                broadcast("task:usage", { taskId, agentId: task.assignee_id, usage: fixParsed.usage });
              }
              const fixFailure = detectAgentRunFailure(fixResult, fixParsed);
              if (fixFailure) {
                fixRunFailed = true;
                // provider 자체가 죽은 실패(구독 만료/한도/환경)와 "코드를 못 고침"(task_error)을
                // 구분한다. 전자는 이 라운드가 아무것도 고치지 못했으므로 재검증이 무의미하다 —
                // throw해서 scheduler의 백엔드 failover(codex 재디스패치 + loop guard)가 처리하게
                // 한다. 사용자 의도: "claude 만료 → codex로 대체, 둘 다 실패면 노출". codex도
                // 이미 시도됐으면 scheduler loop guard가 쿨다운으로 노출한다.
                const fixClass = classifyAgentFailure(fixFailure, { provider: fixResult.provider });
                if (fixClass !== "task_error") {
                  log.warn(`Auto-fix round ${round} ${fixResult.provider} provider-level 실패(${fixClass}) — scheduler failover에 위임`, { taskId, taskTitle: task.title, detail: fixFailure.detail });
                  throw fixFailure;
                }
                log.error(`Auto-fix round ${round} failed [${fixFailure.code}]: ${fixFailure.message}`, { taskId, taskTitle: task.title, detail: fixFailure.detail });
                broadcast("system:error", { agentId: task.assignee_id, agentName, taskId, error: fixFailure.toJSON() });
                // 정상 종료된 task_error는 재검증이 태스크 운명을 결정한다. 비정상 종료나
                // 의도적 interrupt는 출력이 완결되지 않았으므로 fix 재개 checkpoint를 유지한다.
                if (fixResult.exitCode !== 0 || fixResult.interrupted) {
                  throw fixFailure;
                }
              }
            } catch (err) {
              fixRunFailed = true;
              abnormalRecoveryDecision = sessionManager.recoverAbnormalExit?.(
                task.assignee_id,
                "fix",
                "reconcile",
                "fix session exited before producing a final result",
              ) ?? null;
              throw err;
            } finally {
              db.prepare(`
                UPDATE verification_fix_rounds
                SET status = ?, completed_at = datetime('now'),
                    runtime_session_id = COALESCE(?, runtime_session_id)
                WHERE source_verification_id = ?
              `).run(fixRunFailed ? "failed" : "completed", fixRuntimeSessionId, sourceVerificationId);
              if (mappedFixTasks.length > 0) {
                const placeholders = mappedFixTasks.map(() => "?").join(", ");
                const fixTaskStatus = fixRunFailed ? "pending_approval" : "done";
                db.prepare(`
                  UPDATE tasks SET status = ?, updated_at = datetime('now')
                  WHERE id IN (${placeholders})
                `).run(fixTaskStatus, ...mappedFixTasks.map((fixTask) => fixTask.taskId));
                for (const fixTask of mappedFixTasks) {
                  broadcast("task:updated", { id: fixTask.taskId, status: fixTaskStatus });
                }
              }
              sessionManager.killSession(task.assignee_id);
              sessionManager.clearProviderOverride(task.assignee_id);
            }

            if (!db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) {
              log.info(`Task ${taskId} deleted during auto-fix — aborting before fix commit and re-verification`);
              return { success: false, verdict: "aborted" };
            }
            if (isGoalAsUnit) {
              const currentCommit = db.prepare(
                "SELECT recovery_checkpoint_head_sha, recovery_commit_sha FROM tasks WHERE id = ?",
              ).get(task.id) as {
                recovery_checkpoint_head_sha: string | null;
                recovery_commit_sha: string | null;
              } | undefined;
              if (!currentCommit?.recovery_commit_sha) {
                throw new Error("Goal task fix checkpoint is missing its implementation commit");
              }

              // Make successful fix output durable before spawning the next
              // evaluator. Moving the checkpoint first makes both crash
              // windows deterministic: no new commit => resume fix; exactly
              // one new commit => resume verification.
              db.prepare(`
                UPDATE tasks SET recovery_checkpoint_head_sha = ?,
                  recovery_commit_sha = NULL, recovery_resume_phase = 'fix',
                  updated_at = datetime('now')
                WHERE id = ?
              `).run(currentCommit.recovery_commit_sha, task.id);
              const fixCommit = commitTaskResult(effectiveWorkdir, `${task.title} (fix round ${round})`, agentName);
              const fixEvidence = recoverTaskCommitEvidence(
                effectiveWorkdir,
                currentCommit.recovery_commit_sha,
              );
              if (fixEvidence.status === "manual_action_required") {
                throw new Error(`Goal task fix commit evidence is ambiguous: ${fixEvidence.reason ?? "unknown"}`);
              }
              db.prepare(`
                UPDATE tasks SET recovery_checkpoint_head_sha = ?, recovery_commit_sha = ?,
                  recovery_resume_phase = 'verification',
                  updated_at = datetime('now') WHERE id = ?
              `).run(
                fixCommit.committed
                  ? currentCommit.recovery_commit_sha
                  : currentCommit.recovery_checkpoint_head_sha,
                fixEvidence.commitSha ?? currentCommit.recovery_commit_sha,
                task.id,
              );
            }

            // Re-verify (worktree 경로 전달)
            if (isGoalAsUnit) {
              db.prepare("UPDATE tasks SET recovery_resume_phase = 'verification', updated_at = datetime('now') WHERE id = ?")
                .run(task.id);
            }
            reVerification = await qualityGate.verify(taskId, {
              scope: effectiveVerificationScope,
              workdir: effectiveWorkdir,
            });
            db.prepare(`
              UPDATE verification_fix_rounds
              SET result_verification_id = ?
              WHERE source_verification_id = ?
            `).run(reVerification.id, sourceVerificationId);
            if (await stopForEvaluatorError(reVerification)) {
              return { success: false, verdict: reVerification.verdict };
            }

            // 스톨(비수렴) 조기 종료 — 이슈 셋(severity|file|line)이 직전 라운드와 동일하면
            // fix 가 그 이슈를 못 없앤 것(외부 blocker·수렴 불가). MAX_NO_PROGRESS_ROUNDS 연속
            // 동일하면 남은 라운드를 건너뛰고 escalate(아래 !rePass 경로). 이슈가 옮겨가면 리셋.
            if (reVerification.verdict === "fail") {
              const sig = issueSetSignature(reVerification.issues);
              if (sig && sig === prevIssueSig) {
                noProgressRounds++;
                if (noProgressRounds >= MAX_NO_PROGRESS_ROUNDS) {
                  log.warn(`Auto-fix 스톨 감지 — 이슈 셋이 ${noProgressRounds + 1}라운드 연속 동일(비수렴), round ${round}/${effectiveMaxRounds} 에서 조기 escalate: ${task.title}`);
                  break;
                }
              } else {
                noProgressRounds = 0;
              }
              prevIssueSig = sig;
            }
          }
        }

        // Auto-fix 루프 이후 처리 (초기 pass면 이 블록 스킵하고 아래 정상 경로로).
        if (autoFixEligible) {
          // Update task status based on re-verification result
          const rePass = reVerification.verdict === "pass" || reVerification.verdict === "conditional";

          // maxFixRetries 라운드를 다 쓰고도 fail → goal-as-unit은 자동完료 대신 사람 승인 게이트로
          // 넘긴다(미해결 실패를 조용히 done 처리하지 않는다). 비-goal은 기존대로 blocked.
          if (!rePass) {
            if (isGoalAsUnit) {
              const { dropCheckpoint } = await import("../project/worktree.js");
              dropCheckpoint(effectiveWorkdir, task.id);
              db.prepare("UPDATE verifications SET termination_reason = 'fix_round_limit' WHERE id = ?")
                .run(reVerification.id);
              transitionTask(db, broadcast, task, "pending_approval");
              db.prepare(`
                INSERT INTO activities (project_id, type, message, metadata)
                VALUES (?, 'verification_manual_approval', ?, ?)
              `).run(
                task.project_id,
                `Fix round limit reached (${effectiveMaxRounds}) — manual approval required: ${task.title}`,
                JSON.stringify({
                  taskId,
                  sourceVerificationId: reVerification.id,
                  status: "manual_approval",
                  reason: "fix_round_limit",
                }),
              );
              return { success: false, verdict: "conditional" };
            }
            transitionTask(db, broadcast, task, "blocked");
            return { success: false, verdict: reVerification.verdict };
          }

          // goal-as-unit에서 conditional 재검증은 "통과"가 아니라 "사람 판단 필요" — 자동 done/squash 금지.
          // termination_reason은 이미 evaluator가 저장 시점에 'conditional'로 기록했으므로 덮어쓰지 않는다.
          if (isGoalAsUnit && reVerification.verdict === "conditional") {
            const { dropCheckpoint } = await import("../project/worktree.js");
            dropCheckpoint(effectiveWorkdir, task.id);
            transitionTask(db, broadcast, task, "pending_approval");
            db.prepare(`
              INSERT INTO activities (project_id, type, message, metadata)
              VALUES (?, 'verification_manual_approval', ?, ?)
            `).run(
              task.project_id,
              `Verification returned conditional — manual approval required: ${task.title}`,
              JSON.stringify({
                taskId,
                sourceVerificationId: reVerification.id,
                status: "manual_approval",
                reason: "conditional",
              }),
            );
            return { success: false, verdict: "conditional" };
          }

          if (rePass) {
            if (isGoalAsUnit) {
              // Goal-as-Unit: git workflow 없음, 체크포인트 제거 후 done 전환
              const { dropCheckpoint } = await import("../project/worktree.js");
              dropCheckpoint(effectiveWorkdir, task.id);
              transitionTask(db, broadcast, task, "done");
              await checkAndTriggerGoalSquash(db, broadcast, sessionManager, task.goal_id, effectiveWorkdir);
              return { success: true, verdict: reVerification.verdict };
            }
            const gitResult = await runGitWorkflow(db, broadcast, task, project, agentName, effectiveWorkdir, worktreeInfo?.branch);
            if (gitResult?.error) {
              const errorClass = gitResult.errorClass ?? "permanent";
              const errorCode = gitResult.errorCode ?? "unknown";

              if (errorClass === "benign") {
                log.info(`Re-verify git workflow benign (${errorCode}) — marking done: ${task.title}`);
                transitionTask(db, broadcast, task, "done");
                return { success: true, verdict: reVerification.verdict };
              }
              if (errorClass === "permanent") {
                db.prepare(
                  "UPDATE tasks SET retry_count = ?, reassign_count = ? WHERE id = ?",
                ).run(MAX_TASK_RETRIES, MAX_REASSIGNS, task.id);
              }
              transitionTask(db, broadcast, task, "blocked");
              return { success: false, verdict: "git-error" };
            }
          }

          // 여기 도달 시 rePass === true — fail은 위 !rePass 분기에서 이미 return됨
          transitionTask(db, broadcast, task, "done");

          return {
            success: reVerification.verdict === "pass",
            verdict: reVerification.verdict,
          };
        }

        // Update task status based on verification result
        // pass + conditional → done, fail → blocked
        const passed = verification.verdict === "pass" || verification.verdict === "conditional";

        // goal-as-unit에서 conditional 판정은 "통과"가 아니라 "사람 판단 필요" — 자동 done/squash 금지.
        // termination_reason은 이미 evaluator가 저장 시점에 'conditional'로 기록했으므로 덮어쓰지 않는다.
        if (isGoalAsUnit && verification.verdict === "conditional") {
          const { dropCheckpoint } = await import("../project/worktree.js");
          dropCheckpoint(effectiveWorkdir, task.id);
          transitionTask(db, broadcast, task, "pending_approval");
          db.prepare(`
            INSERT INTO activities (project_id, type, message, metadata)
            VALUES (?, 'verification_manual_approval', ?, ?)
          `).run(
            task.project_id,
            `Verification returned conditional — manual approval required: ${task.title}`,
            JSON.stringify({
              taskId,
              sourceVerificationId: verification.id,
              status: "manual_approval",
              reason: "conditional",
            }),
          );
          return { success: false, verdict: "conditional" };
        }

        if (passed) {
          if (isGoalAsUnit) {
            // Goal-as-Unit: git workflow 없음, 체크포인트 제거 후 done 전환
            const { dropCheckpoint } = await import("../project/worktree.js");
            dropCheckpoint(effectiveWorkdir, task.id);
            transitionTask(db, broadcast, task, "done");
            await checkAndTriggerGoalSquash(db, broadcast, sessionManager, task.goal_id, effectiveWorkdir);
            return { success: true, verdict: verification.verdict };
          }
          const gitResult = await runGitWorkflow(db, broadcast, task, project, agentName, effectiveWorkdir, worktreeInfo?.branch);
          if (gitResult?.error) {
            // Classify the git failure so autopilot can decide: auto-recover
            // (recoverable), skip ahead (permanent), or treat as no-op (benign).
            // Default autopilot stance is to prefer recoverable — permanent
            // is reserved for errors that would deterministically re-fail.
            const errorClass = gitResult.errorClass ?? "permanent";
            const errorCode = gitResult.errorCode ?? "unknown";

            if (errorClass === "benign") {
              // e.g. nothing-to-commit — treat as success
              log.info(`Git workflow benign result for "${task.title}" (${errorCode}) — marking done`);
              transitionTask(db, broadcast, task, "done");
              return { success: true, verdict: verification.verdict };
            }

            if (errorClass === "permanent") {
              // Same input will re-fail — skip ahead to avoid budget burn.
              db.prepare(
                "UPDATE tasks SET retry_count = ?, reassign_count = ? WHERE id = ?",
              ).run(MAX_TASK_RETRIES, MAX_REASSIGNS, task.id);
              transitionTask(db, broadcast, task, "blocked");
              db.prepare(
                "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'git_error', ?)",
              ).run(task.project_id, task.assignee_id, `Permanently blocked — git ${errorCode}: ${task.title}`);
              return { success: false, verdict: "git-error" };
            }

            // Recoverable — let the scheduler's normal retry budget decide.
            // Do NOT force retry_count/reassign_count to MAX. The task goes
            // back to blocked but can be retried by retryBlockedTasks.
            transitionTask(db, broadcast, task, "blocked");
            db.prepare(
              "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'git_error', ?)",
            ).run(task.project_id, task.assignee_id, `Recoverable git error (${errorCode}) — will retry: ${task.title}`);
            return { success: false, verdict: "git-error" };
          }
        }

        // verify FAIL (autoFix 미사용 경로): goal-as-unit은 self-heal 없이 바로 goal-QA 이월
        // (blocked→cross-cycle 재픽 루프 회피, 작업물은 dropCheckpoint로 보존). 비-goal은 기존대로 blocked.
        if (!passed) {
          if (isGoalAsUnit) {
            const { dropCheckpoint } = await import("../project/worktree.js");
            dropCheckpoint(effectiveWorkdir, task.id);
            escalateVerificationCap(db, broadcast, task, verification.issues ?? []);
            if (task.goal_id) {
              await checkAndTriggerGoalSquash(db, broadcast, sessionManager, task.goal_id, effectiveWorkdir);
            }
            return { success: true, verdict: verification.verdict };
          }
          transitionTask(db, broadcast, task, "blocked");
          return { success: false, verdict: verification.verdict };
        }

        transitionTask(db, broadcast, task, "done");

        return {
          success: verification.verdict === "pass",
          verdict: verification.verdict,
        };
      } catch (err: any) {
        log.error(`Task execution failed: ${task.title}`, err);
        abnormalRecoveryDecision = abnormalRecoveryDecision ?? err?.recoveryDecision ?? null;

        // Goal cancellation CASCADE-deletes the task. Treat any subprocess
        // completion racing with that delete as an expected abort and avoid
        // resurrecting task state or entering retry/failover handling.
        if (!db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(task.id)) {
          log.info(`Task ${taskId} deleted mid-execution (goal cancelled) — aborting`);
          return { success: false, verdict: "aborted" };
        }

        // Duplicate execution guard — CAS failed, another caller already claimed it.
        // Do NOT transition or retry — the other execution is handling it.
        if (err.message?.includes("skipping duplicate execution")) {
          log.info(`Duplicate execution suppressed for "${task.title}"`);
          throw err; // Re-throw so caller knows, but no state mutation
        }

        // 책임 소재 분류는 errors.ts의 단일 정본을 사용한다. 태스크 자체 실패만
        // blocked(재시도 예산 소모). 나머지(rate limit·세션 소진·환경 오류)는
        // 전역 상태 문제라 todo로 되돌리고 큐 쿨다운은 scheduler가 담당.
        // ⚠ 과거 1: 환경 오류가 retry=999로 예산 소진 → auto-resolve 가짜 done (R2 E2E).
        // ⚠ 과거 2: 세션 소진(CLI exit 1 + 빈 stderr)이 여기 분류에 없어서 blocked로
        //   빠짐 — 사용량 한도만으로 재시도 2회가 증발, 무고한 태스크가 재배정/스킵
        //   직전까지 감 (탑과 용병단 실측 07-08). scheduler만 알던 분류를 정본으로 승격.
        if (abnormalRecoveryDecision) {
          log.warn(`Task "${task.title}" session exit reconciled as ${abnormalRecoveryDecision}`);
          if (err && typeof err === "object") {
            err.recoveryDecision = abnormalRecoveryDecision;
          }
          throw err;
        }

        const failureClass = classifyAgentFailure(err);
        const fallbackStatus = failureClass === "task_error" ? "blocked" : "todo";
        transitionTask(db, broadcast, task, fallbackStatus);

        if (fallbackStatus === "blocked") {
          const retryInfo = db.prepare("SELECT retry_count FROM tasks WHERE id = ?").get(task.id) as { retry_count: number } | undefined;
          db.prepare(
            "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'task_blocked', ?)",
          ).run(task.project_id, task.assignee_id, `Blocked (retry ${retryInfo?.retry_count ?? 0}): ${task.title} — ${err.message?.slice(0, 200)}`);
          log.warn(`Task "${task.title}" blocked — scheduler will auto-retry if retries remain`);
        } else {
          log.warn(`Task "${task.title}" returned to todo (${failureClass}) — no retry budget consumed, queue cooldown owned by scheduler`);
        }
        throw err;
      } finally {
        // Reset agent status
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE id = ?")
          .run(task.assignee_id);
        broadcast("agent:status", { id: task.assignee_id, name: agentName, status: "idle" });

        // Worktree + branch 정리 (Sprint 4 — legacy 모델만 / Goal-as-Unit은 Goal 완료 시 정리)
        if (worktreeInfo && !isGoalAsUnit) {
          try {
            const { removeWorktree } = await import("../project/worktree.js");
            removeWorktree(workdir, worktreeInfo.path, worktreeInfo.branch);
          } catch (cleanupErr: any) {
            log.warn(`Worktree cleanup failed for ${worktreeInfo.path}: ${cleanupErr?.message ?? cleanupErr}`);
          }
        }
      }
    },

    /**
     * Decompose a goal into tasks using AI.
     * Returns the number of tasks created (used by autopilot to trigger queue).
     */
    async decomposeGoal(goalId: string): Promise<{ taskCount: number; projectId: string }> {
      // Goal-level race guard — see inflightDecompose comment above.
      if (inflightDecompose.has(goalId)) {
        log.warn(`decomposeGoal skipped: another run already in progress for goal ${goalId}`);
        throw new Error(`Decompose already in progress for goal ${goalId}`);
      }

      // Duplicate task guard — prevent re-decomposition when tasks already exist.
      // This is the single authoritative check; callers no longer need their own.
      // The only path that intentionally re-decomposes (manual "작업 분할" button)
      // DELETEs existing tasks before calling this method, so count will be 0.
      // Returns taskCount: 0 on skip so callers don't auto-approve existing tasks.
      const existingTaskCount = (db.prepare(
        "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ?"
      ).get(goalId) as { count: number }).count;
      if (existingTaskCount > 0) {
        const goalRow = db.prepare("SELECT project_id FROM goals WHERE id = ?").get(goalId) as { project_id: string } | undefined;
        log.warn(`decomposeGoal skipped: goal ${goalId} already has ${existingTaskCount} task(s)`);
        return { taskCount: 0, projectId: goalRow?.project_id ?? "" };
      }

      inflightDecompose.add(goalId);
      let executionRun: ReturnType<typeof beginExecutionRun> = null;
      try {

      const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as GoalRow | undefined;
      if (!goal) {
        throw new Error(`Goal ${goalId} not found`);
      }
      const executionGate = assertExecutionAllowed(db, goal.id);
      if (!executionGate.allowed) throw new Error(executionGate.message);
      executionRun = beginExecutionRun(db, goal.id, "decompose");

      // H-3: tasks INSERT 전에 미리 goal_model='goal_as_unit' 설정.
      //      tasks INSERT 이후 승격 시 scheduler 가 그 사이에 legacy 경로로 태스크를 pick 할 수 있음.
      if (goal.goal_model !== "goal_as_unit") {
        db.prepare("UPDATE goals SET goal_model = 'goal_as_unit' WHERE id = ?").run(goal.id);
        goal.goal_model = "goal_as_unit";
        log.info(`Goal ${goal.id} pre-upgraded to goal_as_unit before task decomposition`);
      }

      const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(goal.project_id) as ProjectRow | undefined;
      const projectWorkdir = project?.workdir || (() => { throw new Error("Project has no workdir configured"); })();
      await ensureGoalWorktreeRecorded(db, goal, projectWorkdir);

      log.info(`Decomposing goal: "${goal.title || goal.description}"`);

      // Prefer CTO/lead agent for decomposition; fall back to any agent
      const agent = db.prepare(
        "SELECT * FROM agents WHERE project_id = ? AND role = 'cto' LIMIT 1",
      ).get(goal.project_id) as AgentRow | undefined
        ?? db.prepare(
          "SELECT * FROM agents WHERE project_id = ? LIMIT 1",
        ).get(goal.project_id) as AgentRow | undefined;

      if (!agent) {
        throw new Error("No agents available for task decomposition");
      }

      const decomposeSessionKey = `decompose-${goal.id}`;
      let session;
      try {
        session = sessionManager.spawnAgent(
          agent.id,
          project?.workdir || process.cwd(),
          decomposeSessionKey,
          null,
          executionRun
            ? {
                executionRunId: executionRun.id,
                executionSpecVersionId: executionRun.executionSpecVersionId,
              }
            : undefined,
        );
      } catch (err: any) {
        throw new Error(`Failed to spawn agent for decomposition: ${err.message}`);
      }

      // Make the decompose visible on the agent and in the activity log so
      // the user sees "작업 분할 중..." on the goal card instead of a mute
      // zero-task state. Without this the only signal is "1 agent working"
      // on the sidebar, which does not identify the goal. (Pulsar audit.)
      const decomposeActivity = `decompose:${(goal.title || goal.description || "").slice(0, 80)}`;
      db.prepare(
        "UPDATE agents SET current_task_id = NULL, current_activity = ? WHERE id = ?",
      ).run(decomposeActivity, agent.id);
      broadcast("agent:status", {
        id: agent.id,
        status: "working",
        activity: decomposeActivity,
      });
      db.prepare(
        "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'decompose_started', ?)",
      ).run(
        goal.project_id,
        agent.id,
        `작업 분할 시작: "${(goal.title || goal.description || "").slice(0, 120)}"`,
      );
      broadcast("project:updated", { projectId: goal.project_id });

      // Gather available roles for the prompt
      const availableAgents = db.prepare(
        "SELECT name, role FROM agents WHERE project_id = ? AND role != 'cto'",
      ).all(goal.project_id) as { name: string; role: string }[];
      const roleList = availableAgents.map((a) => `"${a.role}" (${a.name})`).join(", ");

      const executionSpec = getExecutionSpecByVersionId(db, executionRun?.executionSpecVersionId);
      const specContext = formatExecutionSpecContext(executionSpec);

      // Project tech stack context — helps the decomposer fill stack_hint and
      // pick plausible target_files. Without this the decomposer has no idea
      // whether the project uses Next.js vs vanilla JS vs Django etc.
      let projectStackHint = "";
      try {
        const stackRaw = (project as any)?.tech_stack;
        if (stackRaw) {
          const stack = JSON.parse(stackRaw);
          const langs = (stack.languages ?? []).slice(0, 3).join(", ");
          const fws = (stack.frameworks ?? []).slice(0, 3).join(", ");
          projectStackHint = `\n**Project stack**: ${[langs, fws].filter(Boolean).join(" / ") || "unknown"}`;
        }
      } catch { /* ignore */ }

      const decomposePrompt = `
# Goal Decomposition

Break down this goal into concrete, actionable tasks:
${goal.title ? `**${goal.title}**\n` : ""}"${goal.description}"${projectStackHint}
${specContext}
Available team members: ${roleList || "coder"}

Rules:
- Each task should be completable by a single agent
- Include clear acceptance criteria in each task description
- Keep tasks small and focused (1-4 hours each)
- Use the "role" field to assign tasks to available team members
- Set "priority": "critical" | "high" | "medium" | "low" based on importance and dependency
- Set "order": sequential number (1, 2, 3...) reflecting execution order — tasks with dependencies on others must have a higher number
- Set "depends_on": array of order numbers that MUST complete before this task starts. Use [] for tasks with no dependencies. Example: a QA task after tasks 1,2,3 should have "depends_on": [1,2,3]. Independent tasks (e.g. parallel content generation) each get [].
- Verification/review/QA tasks should always have the highest order number (run last)${executionSpec ? "\n- Reference the approved blueprint above to ensure complete coverage of its expected tasks, acceptance criteria, and verification methods" : ""}
- Set "type": task type — determines verification criteria applied
  - "code": source code implementation (default, 5-dimension verification)
  - "content": documentation / copywriting / i18n (3-dimension: Completeness, Consistency, Clarity)
  - "config": infrastructure / environment / CI config (2-dimension: Validity, Security)
  - "review": QA execution / smoke test / integration test (execution-based pass/fail only)

## Required fields per task
- \`target_files\`: best-effort guess of file paths this task will touch (e.g.
  \`["web/src/app/page.tsx"]\`). Use the project stack above. Prefer paths of
  files that ALREADY exist. Empty \`[]\` if you cannot guess confidently — a
  wrong guess is worse than none, since it misleads the implementer and the
  Evaluator treats a different-but-correct path as fine, not a failure.
- \`stack_hint\`: short framework constraint (e.g. "Next.js 16 App Router",
  "FastAPI router"). Empty string if none. Prevents wrong-stack impls.
- \`type\`: one of "code" | "content" | "config" | "review". Default "code".

## Fullstack contract rule (if goal touches backend API AND UI)
The first task that touches the API MUST cite the exact response shape
(field names + types) in its description. Every later task that reads
that endpoint MUST quote the same shape verbatim. Never place a frontend
fetch URL without a matching backend task for the same route+method.
Flag enum values explicitly. — Prevents contract mismatch crashes.

## Bootstrap rule (if goal touches auth / tenants / migrations / seed / gated UI)
Add ONE final "Bootstrap / Entry Point" task that makes the feature
reachable from an empty install via any of: seed script, dev-mode bypass
(env + loopback), login/signup UI, or CLI bootstrap command. Without this
the goal is implemented but unusable. If goal is pure refactor/visual,
write "no bootstrap: non-gated" in the first task's description.

CRITICAL: Keep your response SHORT. Each task description must be under 100 words. Do NOT add lengthy explanations. Total response must fit in 2000 tokens.

Respond in this EXACT JSON format:
\`\`\`json
{
  "tasks": [
    {
      "title": "Task title (concise)",
      "description": "Brief description with key acceptance criteria — max 100 words",
      "role": "${availableAgents[0]?.role ?? "coder"}",
      "priority": "high",
      "order": 1,
      "type": "code",
      "target_files": ["relative/path/to/file.ext"],
      "stack_hint": "Next.js 16 App Router",
      "depends_on": []
    }
  ]
}
\`\`\`
`;

      const runResult = await session.send(decomposePrompt);

      log.info(`Decompose raw: exitCode=${runResult.exitCode}, stdoutLen=${runResult.stdout.length}, stderrLen=${runResult.stderr.length}, stdout500=${runResult.stdout.slice(0, 500)}`);

      const parsed = parseAgentOutput(runResult.stdout, runResult.provider);

      log.info(`Decompose parsed: textLen=${parsed.text.length}, lineCount=${parsed.lineCount}, errors=${parsed.errors.join("; ")}, first200=${parsed.text.slice(0, 200)}`);
      if (runResult.exitCode !== 0) {
        log.error(`Decompose CLI error: stderr=${runResult.stderr.slice(0, 300)}`);
      }

      // Parse tasks from AI response — try ```json first, then raw JSON
      try {
        let jsonMatch = parsed.text.match(/```json\s*([\s\S]*?)\s*```/);
        if (!jsonMatch) {
          // Fallback: try to find raw JSON object with "tasks" array
          jsonMatch = parsed.text.match(/(\{[\s\S]*"tasks"\s*:\s*\[[\s\S]*\][\s\S]*\})/);
        }
        if (!jsonMatch) throw new Error(`No JSON found in decomposition response (textLen=${parsed.text.length}, exitCode=${runResult.exitCode}, stderr=${runResult.stderr.slice(0, 200)}, first300=${parsed.text.slice(0, 300)})`);

        let decomposed: any;
        try {
          decomposed = JSON.parse(jsonMatch[1]);
        } catch (parseErr: any) {
          // Truncated JSON recovery — balanced-brace parser.
          //
          // The previous regex-based recovery assumed a fixed task object
          // shape ending at `"order": <num> }` which broke the moment the
          // decomposer started emitting additional fields like
          // `target_files` / `stack_hint` (added in P2). A task object
          // with arrays and extra fields was no longer matchable.
          //
          // New strategy: scan the raw JSON for the start of the tasks
          // array and then walk character-by-character, tracking string
          // escapes and nested brace depth, to extract every complete
          // top-level object inside that array. Any trailing unterminated
          // object is simply skipped.
          log.warn(`JSON parse failed (${parseErr.message}), attempting balanced-brace recovery`);
          const partialTasks = recoverTasksFromPartialJson(jsonMatch[1] ?? "");
          if (partialTasks.length === 0) throw parseErr;
          log.info(`Recovered ${partialTasks.length} tasks from truncated JSON`);
          decomposed = { tasks: partialTasks };
        }
        const tasks = decomposed.tasks ?? [];

        let safeTasks = tasks.slice(0, MAX_TASKS_PER_GOAL);

        // Phase 3 — S1: Adversarial Task 자동 주입
        // 휴리스틱: 조사성 키워드가 포함된 goal 에 사전 실패 패턴 수집 태스크를 prepend
        const ADVERSARIAL_KEYWORDS_KO = ["감지", "분석", "추출", "파싱", "검증", "탐지", "매칭"];
        const ADVERSARIAL_KEYWORDS_EN = ["detect", "parse", "extract", "analyze", "validate", "match", "find", "scan"];

        const shouldInjectAdversarial = (g: GoalRow): boolean => {
          if (g.skip_adversarial === 1) return false;
          const text = `${g.title ?? ""} ${g.description ?? ""}`.toLowerCase();
          if (text.length < 50) return false; // 너무 단순한 goal 은 제외
          const hasKo = ADVERSARIAL_KEYWORDS_KO.some((k) => text.includes(k));
          const hasEn = ADVERSARIAL_KEYWORDS_EN.some((k) => text.includes(k));
          return hasKo || hasEn;
        };

        const goalSlug = (g: GoalRow): string => {
          const base = (g.title || g.description || "goal").slice(0, 40);
          const normalized = base.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
          // Phase 6 edge fix: slug 에 goal id 6자 suffix → 제목 40자 동일 시 파일 덮어쓰기 방지.
          const shortId = g.id.slice(-6);
          return normalized ? `${normalized}-${shortId}` : shortId;
        };

        if (shouldInjectAdversarial(goal) && safeTasks.length > 0) {
          // C-1: adversarial 자리 확보 — unshift 전에 slice 하여 drop 후 depends_on 정리
          if (safeTasks.length >= MAX_TASKS_PER_GOAL) {
            const dropped = safeTasks.slice(MAX_TASKS_PER_GOAL - 1);
            const droppedOrders = new Set(
              dropped
                .map((t: any) => t.order)
                .filter((o: any) => typeof o === "number"),
            );
            safeTasks = safeTasks.slice(0, MAX_TASKS_PER_GOAL - 1);
            // 드롭된 태스크를 depends_on 으로 참조하던 태스크 정리
            for (const t of safeTasks) {
              if (Array.isArray(t.depends_on)) {
                t.depends_on = t.depends_on.filter((d: any) => !droppedOrders.has(d));
              }
            }
            log.warn(`Adversarial injection: dropped ${dropped.length} low-priority task(s) to fit MAX_TASKS_PER_GOAL`);
          }
          // 기존 태스크들 order +1 (adversarial 이 order=1 을 차지)
          for (const t of safeTasks) {
            if (typeof t.order === "number") t.order += 1;
            // depends_on 의 order 번호도 함께 이동
            if (Array.isArray(t.depends_on)) {
              t.depends_on = t.depends_on.map((n: unknown) => typeof n === "number" ? n + 1 : n);
            }
          }
          const slug = goalSlug(goal);
          safeTasks.unshift({
            title: "[사전 조사] 실세계 실패 패턴 10가지 수집",
            description: [
              "이 기능이 실세계 사용자 데이터에서 실패할 수 있는 10가지 패턴을 수집하라.",
              "",
              "수행:",
              "- 실제 사용자 워크스페이스 샘플링 (이 프로젝트 루트 포함)",
              "- 각 패턴: 입력 예시 + 예상 결과 + 실패 이유",
              `- 결과물: docs/design/${slug}-edge-cases.md 파일 작성`,
              "",
              "이 조사는 후속 구현 태스크의 false-positive 를 예방하기 위함이다.",
            ].join("\n"),
            role: (availableAgents.find((a) => a.role === "qa")?.role) ?? "coder",
            priority: "high",
            order: 1,
            type: "content",
            target_files: [`docs/design/${slug}-edge-cases.md`],
            stack_hint: "",
            depends_on: [],
          });
          log.info(`Adversarial task injected for goal ${goal.id} (slug=${slug})`);
        }

        // Auto-assign agents by role — prefer CTO's children, fallback to all non-CTO
        const projectAgents = db.prepare(
          "SELECT * FROM agents WHERE project_id = ?",
        ).all(goal.project_id) as AgentRow[];

        const ctoAgent = projectAgents.find((a) => a.role === "cto");
        const ctoChildren = ctoAgent
          ? projectAgents.filter((a) => a.parent_id === ctoAgent.id)
          : [];
        // If CTO has no children, use all non-CTO agents as candidates
        const nonCto = projectAgents.filter((a) => a.role !== "cto");
        const candidates = ctoChildren.length > 0 ? ctoChildren : nonCto;

        // Flexible role matching: exact → partial keyword → any coder → first available.
        // Distribution is LEAST-LOADED across same-role agents, seeded from the
        // project-wide existing assignment count. Previously a per-decompose
        // round-robin counter reset to 0 every goal, so each goal's first
        // same-role task landed on candidate index 0 — concentrating every
        // goal's critical path onto one agent and serializing goal-level
        // parallelism (실측: 3 goal의 첫 backend 태스크가 모두 같은 agent). Seeding
        // from live load makes goal B continue where goal A left off.
        const loadByAgent = new Map<string, number>();
        {
          const rows = db.prepare(
            "SELECT assignee_id AS id, COUNT(*) AS c FROM tasks WHERE project_id = ? AND assignee_id IS NOT NULL GROUP BY assignee_id",
          ).all(goal.project_id) as { id: string; c: number }[];
          for (const row of rows) loadByAgent.set(row.id, row.c);
        }
        const pickLeastLoaded = (pool: AgentRow[]): AgentRow => {
          let best = pool[0];
          for (const a of pool) {
            if ((loadByAgent.get(a.id) ?? 0) < (loadByAgent.get(best.id) ?? 0)) best = a;
          }
          loadByAgent.set(best.id, (loadByAgent.get(best.id) ?? 0) + 1);
          return best;
        };
        const findAgent = (role: string) => {
          const r = role.toLowerCase();
          // 1) Exact role matches
          const exactMatches = candidates.filter((a) => a.role === r);
          if (exactMatches.length > 0) return pickLeastLoaded(exactMatches);
          // 2) Partial keyword match
          const partialMatches = candidates.filter((a) => r.includes(a.role) || a.role.includes(r));
          if (partialMatches.length > 0) return pickLeastLoaded(partialMatches);
          // 3) Any worker fallback
          return candidates.find((a) => a.role === "coder" || a.role === "frontend" || a.role === "backend") ??
            candidates[0] ?? projectAgents.find((a) => a.role !== "cto") ?? projectAgents[0] ?? null;
        };

        let created = 0;

        const VALID_PRIORITIES = new Set(["critical", "high", "medium", "low"]);
        const VALID_TASK_TYPES = new Set(["code", "content", "config", "review"]);

        // Phase 1: INSERT all tasks, build order → task ID map for depends_on resolution
        const orderToTaskId = new Map<number, string>();

        for (let i = 0; i < safeTasks.length; i++) {
          const t = safeTasks[i];
          if (!t.title || typeof t.title !== "string") continue;
          const title = t.title.slice(0, MAX_TITLE_LEN);
          const description = typeof t.description === "string" ? t.description.slice(0, MAX_DESC_LEN) : "";
          const agent = findAgent(t.role ?? "coder");
          const priority = VALID_PRIORITIES.has(t.priority) ? t.priority : "medium";
          const sortOrder = typeof t.order === "number" ? t.order : i + 1;
          // P2: scope anchoring — capture target_files + stack_hint from the
          // decomposer so both the Generator prompt and Evaluator check can
          // enforce where code belongs.
          const targetFiles = Array.isArray(t.target_files)
            ? t.target_files.filter((f: unknown) => typeof f === "string" && f.length > 0 && f.length < 260).slice(0, 20)
            : [];
          const stackHint = typeof t.stack_hint === "string" ? t.stack_hint.slice(0, 200) : "";
          // task_type: 유효값이 아니면 기본값 'code' 사용
          const taskType = VALID_TASK_TYPES.has(t.type) ? t.type : "code";
          // Sprint 5: tasks created from decomposition start as pending_approval
          // so the user can review the plan before execution begins
          const row = db.prepare(`
            INSERT INTO tasks (
              goal_id, project_id, title, description, assignee_id, status, priority,
              sort_order, target_files, stack_hint, task_type,
              execution_run_id, execution_spec_version_id
            )
            VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `).get(
            goal.id, goal.project_id, title, description, agent?.id ?? null,
            priority, sortOrder,
            JSON.stringify(targetFiles), stackHint, taskType,
            executionRun?.id ?? null,
            executionRun?.executionSpecVersionId ?? null,
          ) as { id: string } | undefined;

          if (row) {
            orderToTaskId.set(sortOrder, row.id);
            created++;
          }
        }

        // Phase 2: resolve depends_on order numbers → actual task IDs and UPDATE
        for (let i = 0; i < safeTasks.length; i++) {
          const t = safeTasks[i];
          if (!t.title || typeof t.title !== "string") continue;
          const sortOrder = typeof t.order === "number" ? t.order : i + 1;
          const taskId = orderToTaskId.get(sortOrder);
          if (!taskId) continue;

          const rawDeps = Array.isArray(t.depends_on) ? t.depends_on : [];
          const resolvedDeps = rawDeps
            .filter((d: unknown): d is number => typeof d === "number")
            .map((orderNum: number) => orderToTaskId.get(orderNum))
            .filter((id: string | undefined): id is string => id !== undefined && id !== taskId); // exclude self-reference

          if (resolvedDeps.length > 0) {
            db.prepare(
              "UPDATE tasks SET depends_on = ? WHERE id = ?"
            ).run(JSON.stringify(resolvedDeps), taskId);
          }
        }

        // Phase 2 완료 후 DAG 순환 감지 — 순환 발견 시 depends_on 초기화 + activity 기록
        {
          const allTaskIds = Array.from(orderToTaskId.values());
          const insertedTasks = allTaskIds.map((tid) => {
            const row = db.prepare("SELECT id, depends_on FROM tasks WHERE id = ?").get(tid) as { id: string; depends_on: string | null } | undefined;
            if (!row) return null;
            let deps: string[] = [];
            try { deps = row.depends_on ? JSON.parse(row.depends_on) : []; } catch { deps = []; }
            return { id: row.id, depends_on: deps };
          }).filter((r): r is { id: string; depends_on: string[] } => r !== null);

          const cycles = detectCycles(insertedTasks);
          if (cycles.length > 0) {
            const cycleIds = [...new Set(cycles.flat())];
            for (const tid of cycleIds) {
              db.prepare("UPDATE tasks SET depends_on = '[]' WHERE id = ?").run(tid);
            }
            db.prepare(
              "INSERT INTO activities (project_id, type, message) VALUES (?, 'dag_cycle_reset', ?)",
            ).run(
              goal.project_id,
              `의존성 순환 감지 — ${cycleIds.join(", ")} 의 depends_on 초기화`,
            );
            broadcast("project:updated", { projectId: goal.project_id });
            log.warn(`DAG cycles detected and reset for goal ${goal.id}: ${cycleIds.join(", ")}`);
          }
        }

        // 신규 goal은 goal_as_unit 모델로 승격 (legacy goal은 이미 'legacy' 값이므로 덮어쓰지 않음)
        const currentGoal = db.prepare("SELECT goal_model FROM goals WHERE id = ?").get(goal.id) as { goal_model: string } | undefined;
        if (currentGoal?.goal_model === "legacy") {
          db.prepare("UPDATE goals SET goal_model = 'goal_as_unit' WHERE id = ?").run(goal.id);
          log.info(`Goal ${goal.id} upgraded to goal_as_unit model`);
        }

        if (created === 0) {
          throw new Error("Goal decomposition produced no valid tasks");
        }

        log.info(`Created ${created} tasks from goal decomposition`);
        db.prepare(
          "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'decompose_completed', ?)",
        ).run(
          goal.project_id,
          agent.id,
          `작업 분할 완료: ${created}개 태스크 생성 — "${(goal.title || goal.description || "").slice(0, 80)}"`,
        );
        broadcast("project:updated", { projectId: goal.project_id });
        return { taskCount: created, projectId: goal.project_id };
      } catch (err: any) {
        log.error("Failed to parse task decomposition", err);
        db.prepare(
          "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'decompose_failed', ?)",
        ).run(
          goal.project_id,
          agent.id,
          `작업 분할 실패: ${String(err?.message ?? err).slice(0, 140)}`,
        );
        broadcast("project:updated", { projectId: goal.project_id });
        throw err;
      } finally {
        // Cleanup decompose session to free the agent + clear the
        // "decompose:..." activity so the idle broadcast in killSession
        // correctly reflects the agent is no longer working.
        sessionManager.killSession(decomposeSessionKey);
        db.prepare(
          "UPDATE agents SET current_activity = NULL WHERE id = ? AND current_activity LIKE 'decompose:%'",
        ).run(agent.id);
      }

      } catch (err) {
        if (executionRun) failExecutionRun(db, goalId, executionRun.id);
        throw err;
      } finally {
        // Single cleanup point: ensure inflightDecompose is ALWAYS released,
        // whether the inner try-catch-finally ran or an early throw occurred
        // (e.g. goal/project/agent not found).
        inflightDecompose.delete(goalId);
      }
    },

    /**
     * Full Autopilot: CTO generates goals from project mission.
     * Safety: max 5 goals per invocation, auto-downgrades to 'goal' mode after completion.
     */
    async generateGoalsFromMission(projectId: string): Promise<{ goalIds: string[] }> {
      const MAX_AUTO_GOALS = 5;

      const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
      if (!project) throw new Error(`Project ${projectId} not found`);

      if (!project.mission || project.mission.trim() === "") {
        throw new Error("Project has no mission set — cannot generate goals in Full mode");
      }

      // Safety: check if there are already pending/in_progress goals
      const activeGoals = db.prepare(
        "SELECT COUNT(*) as count FROM goals WHERE project_id = ? AND progress < 100",
      ).get(projectId) as { count: number };

      if (activeGoals.count >= MAX_AUTO_GOALS) {
        log.warn(`Full autopilot: project already has ${activeGoals.count} active goals, skipping generation`);
        return { goalIds: [] };
      }

      const remainingSlots = MAX_AUTO_GOALS - activeGoals.count;

      const existingGoals = db.prepare(
        "SELECT title, description, priority, progress FROM goals WHERE project_id = ? ORDER BY created_at",
      ).all(projectId) as { title: string; description: string; priority: string; progress: number }[];

      const ctoAgent = db.prepare(
        "SELECT * FROM agents WHERE project_id = ? AND role = 'cto' LIMIT 1",
      ).get(projectId) as AgentRow | undefined;

      if (!ctoAgent) {
        throw new Error("Full autopilot requires a CTO agent");
      }

      log.info(`Full autopilot: generating goals from mission "${project.mission.slice(0, 50)}..."`);

      // Set CTO activity
      db.prepare("UPDATE agents SET status = 'working', current_activity = 'goal_generation' WHERE id = ?")
        .run(ctoAgent.id);
      broadcast("agent:status", { id: ctoAgent.id, status: "working", activity: "goal_generation" });

      const ctoWorkdir = project.workdir || (() => { throw new Error("Project has no workdir configured"); })();
      const missionSessionKey = `mission-${projectId}-${Date.now()}`;
      const session = sessionManager.spawnAgent(ctoAgent.id, ctoWorkdir, missionSessionKey);

      try {
      const existingGoalsSection = existingGoals.length > 0
        ? `\n**Existing Goals (DO NOT duplicate):**\n${existingGoals.map((g, i) => `${i + 1}. [${g.priority}] ${g.title} — ${g.description.slice(0, 80)}`).join("\n")}\n`
        : "";

      const prompt = `
# Mission Analysis — Goal Generation

You are the CTO. Analyze this project's mission and create actionable goals.

**Mission:** "${project.mission}"
${existingGoalsSection}
Rules:
- Create at most ${remainingSlots} goals
- Each goal should be a clear milestone toward the mission
- Order goals by priority/dependency
- Keep goals achievable (not too broad, not too narrow)${existingGoals.length > 0 ? "\n- DO NOT create goals that overlap or duplicate any existing goal listed above" : ""}

Respond in this EXACT JSON format:
\`\`\`json
{
  "goals": [
    {
      "description": "Goal description",
      "priority": "critical" | "high" | "medium" | "low"
    }
  ]
}
\`\`\`
`;

      const runResult = await session.send(prompt);

      log.info(`Mission analysis raw: exitCode=${runResult.exitCode}, stdoutLen=${runResult.stdout.length}, stderrLen=${runResult.stderr.length}`);

      const parsed = parseAgentOutput(runResult.stdout, runResult.provider);

      log.info(`Mission analysis parsed: textLen=${parsed.text.length}, errors=${parsed.errors.join("; ")}`);

      // Try multiple extraction strategies
      let jsonMatch = parsed.text.match(/```json\s*([\s\S]*?)\s*```/);
      if (!jsonMatch) {
        jsonMatch = parsed.text.match(/(\{[\s\S]*"goals"\s*:\s*\[[\s\S]*\][\s\S]*\})/);
      }
      if (!jsonMatch) throw new Error(`No JSON found in mission analysis response (textLen=${parsed.text.length}, errors=${parsed.errors.join("; ")}, first300=${parsed.text.slice(0, 300)})`);

      let data: any;
      try {
        data = JSON.parse(jsonMatch[1]);
      } catch (parseErr: any) {
        // Truncated JSON recovery: extract complete goal objects from partial JSON
        log.warn(`Mission JSON parse failed (${parseErr.message}), attempting truncated recovery`);
        const partialGoals: any[] = [];
        const goalPattern = /\{\s*"title"\s*:\s*"[^"]+"\s*,\s*"description"\s*:\s*"[^"]*"\s*,\s*"priority"\s*:\s*"[^"]*"\s*\}/g;
        let match;
        while ((match = goalPattern.exec(jsonMatch[1])) !== null) {
          try { partialGoals.push(JSON.parse(match[0])); } catch { /* skip malformed */ }
        }
        if (partialGoals.length === 0) throw parseErr;
        log.info(`Recovered ${partialGoals.length} goals from truncated JSON`);
        data = { goals: partialGoals };
      }

      const goals = (data.goals ?? []).slice(0, remainingSlots);
      const VALID_PRIORITIES = ["critical", "high", "medium", "low"];

      // Validate ALL goals before any INSERT — prevents partial-insert orphans
      // when the loop would throw midway through. Re-index AFTER filtering so
      // sort_order is contiguous (no gaps from dropped entries).
      const validGoals = goals
        .filter((g: any) => g && typeof g.description === "string" && g.description.length > 0)
        .map((g: any, index: number) => ({ g, index }));

      // Offset sort_order so new goals never collide with existing ones.
      // Without this, new goals (sort_order = 0, 1, 2...) would jump above
      // existing same-priority goals in scheduler ordering.
      const sortOrderBase = (db.prepare(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS base FROM goals WHERE project_id = ?",
      ).get(projectId) as { base: number }).base;

      // Wrap inserts in a transaction so partial failures roll back cleanly
      const insertGoals = db.transaction((entries: { g: any; index: number }[]): string[] => {
        const ids: string[] = [];
        for (const { g, index } of entries) {
          const priority = VALID_PRIORITIES.includes(g.priority) ? g.priority : "medium";
          const row = db.prepare(
            "INSERT INTO goals (project_id, title, description, priority, sort_order, goal_model, spec_approval_required) VALUES (?, ?, ?, ?, ?, 'goal_as_unit', 1) RETURNING id",
          ).get(projectId, (g.title ?? g.description).slice(0, 100), g.description.slice(0, 500), priority, sortOrderBase + index) as { id: string };
          ids.push(row.id);
        }
        return ids;
      });

      const goalIds: string[] = insertGoals(validGoals);

      log.info(`Full autopilot: created ${goalIds.length} goals from mission`);
      broadcast("project:updated", { projectId });

      db.prepare(
        "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'goal_created', ?)",
      ).run(projectId, ctoAgent.id, `CTO auto-generated ${goalIds.length} goals from mission`);

      return { goalIds };
      } finally {
        // Cleanup CTO session — 성공/실패 모두
        sessionManager.killSession(missionSessionKey);
      }
    },
  };
}

/** Centralized task status transition — single source of truth for status changes + goal progress */
function transitionTask(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  task: TaskRow,
  newStatus: string,
): void {
  const clearsRecoveryPhase = newStatus === "done" || newStatus === "pending_approval";
  db.prepare(`
    UPDATE tasks SET status = ?,
      recovery_resume_phase = CASE WHEN ? THEN NULL ELSE recovery_resume_phase END,
      updated_at = datetime('now') WHERE id = ?
  `).run(newStatus, clearsRecoveryPhase ? 1 : 0, task.id);
  broadcast("task:updated", { ...task, status: newStatus });

  // Update agent activity based on task state
  if (newStatus === "in_review" && task.assignee_id) {
    db.prepare("UPDATE agents SET current_activity = ? WHERE id = ?")
      .run(`review:${(task.title ?? "").slice(0, 80)}`, task.assignee_id);
  }

  if (newStatus === "done" && !task.parent_task_id) {
    updateGoalProgress(db, task.goal_id);
  }
}

/** Read github_config JSON from projects table. Returns null if not set. */
function getGitHubConfig(db: Database, projectId: string): GitHubConfig | null {
  const row = db
    .prepare("SELECT github_config FROM projects WHERE id = ?")
    .get(projectId) as { github_config: string | null } | undefined;
  if (!row?.github_config) return null;
  try {
    return JSON.parse(row.github_config) as GitHubConfig;
  } catch {
    return null;
  }
}

/**
 * Run git workflow after a task passes verification.
 * - With githubConfig: full workflow (commit → push → PR)
 * - Without githubConfig: local commit only (코드 보존 — worktree 정리 전 필수)
 * Never throws — git failures must not corrupt already-verified code.
 */
async function runGitWorkflow(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  task: TaskRow,
  _project: ProjectRow,
  agentName: string,
  workdir: string,
  worktreeBranch?: string,
): Promise<GitWorkflowResult | null> {
  const githubConfig = getGitHubConfig(db, task.project_id);

  // github_config 없어도 로컬 commit은 수행 (worktree 정리 전 코드 보존)
  // branch는 반드시 프로젝트 기본 브랜치 — worktree 브랜치를 넣으면 자기 자신에게 머지 시도
  const projectRoot = _project.workdir;
  const defaultBranch = projectRoot ? getDefaultBranch(projectRoot) : "main";
  const effectiveConfig: GitHubConfig = githubConfig ?? {
    repoUrl: "",
    branch: defaultBranch,
    autoPush: false,
    prMode: false,
    gitMode: "local_only",
  };

  const result = executeGitWorkflow(workdir, task.title, agentName, effectiveConfig, {
    overrideBranch: worktreeBranch,
  });

  broadcast("task:git", {
    taskId: task.id,
    committed: result.committed,
    pushed: result.pushed,
    prUrl: result.prUrl,
    branch: result.branch,
    filesChanged: result.filesChanged,
    error: result.error,
  });

  if (result.error) {
    log.error(`Git workflow failed for task "${task.title}": ${result.error}`);
    db.prepare(`
      INSERT INTO activities (project_id, agent_id, type, message)
      VALUES (?, ?, 'git_error', ?)
    `).run(task.project_id, task.assignee_id, `Git error on task "${task.title}": ${result.error}`);
  } else {
    // 워크트리 변경사항을 main에 반영 — 후속 태스크(reviewer, qa 등)가 접근할 수 있도록
    // 모든 git 모드에서 로컬 머지 수행, push는 main_direct에서만
    const gitMode = effectiveConfig.gitMode ??
      (effectiveConfig.prMode ? "pr" : effectiveConfig.autoPush ? "main_direct" : "branch_only");
    if (worktreeBranch && result.committed) {
      const projectRoot = _project.workdir;
      if (projectRoot) {
        const { mergeBranchSequential } = await import("../project/git-workflow.js");
        const targetBranch = effectiveConfig.branch || "main";
        const merged = await mergeBranchSequential(projectRoot, worktreeBranch, targetBranch);
        if (merged) {
          log.info(`Merged ${worktreeBranch} → ${targetBranch}`);
          // main_direct 모드에서만 push (다른 모드에서는 로컬 머지만)
          if (gitMode === "main_direct") {
            const { pushBranch, resolveGitHubToken } = await import("../project/git-workflow.js");
            const pushRes = pushBranch(projectRoot, targetBranch, resolveGitHubToken(projectRoot));
            if (!pushRes.ok) {
              log.warn(`main_direct push failed: ${pushRes.error}`);
              result.error = `자동 push 실패 (${targetBranch}): ${pushRes.error ?? "unknown"}`;
            }
          }
        } else {
          log.warn(`Merge failed — worktree branch ${worktreeBranch} preserved for manual merge`);
          result.error = `Auto-merge failed: ${worktreeBranch} → ${targetBranch}. Manual resolution may be needed.`;
          // 머지 실패를 activity log에 기록하여 대시보드에서 확인 가능
          db.prepare(`
            INSERT INTO activities (project_id, agent_id, type, message)
            VALUES (?, ?, 'git_merge_conflict', ?)
          `).run(task.project_id, task.assignee_id,
            `Auto-merge failed for ${worktreeBranch} → ${targetBranch}. Manual resolution may be needed.`);
        }
      }
    }

    log.info(`Git workflow complete for task "${task.title}"`, {
      committed: result.committed,
      pushed: result.pushed,
      prUrl: result.prUrl,
    });
  }

  return result;
}

/**
 * 태스크 done 전환 후 Goal-as-Unit squash 트리거 여부 확인.
 * 남은 태스크가 0이면 triggerGoalSquash() 호출.
 *
 * CAS 락: squash_status = 'triggering' 으로 조건부 UPDATE → changes === 0 이면 이미 다른 호출이 진입한 것으로 중복 방지.
 */
export async function checkAndTriggerGoalSquash(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  sessionManager: SessionManager,
  goalId: string,
  worktreePath: string,
): Promise<void> {
  // CAS: squash_status 가 'none' 인 경우에만 'triggering' 으로 전환 (원자적 mutex)
  const cas = db.prepare(
    "UPDATE goals SET squash_status = 'triggering' WHERE id = ? AND squash_status = 'none' AND goal_model = 'goal_as_unit'",
  ).run(goalId);
  if (cas.changes === 0) {
    // 이미 다른 호출이 진입했거나, goal_model != goal_as_unit 이거나, squash_status != 'none'
    return;
  }

  // CAS 성공 — 이제 남은 태스크 확인 (triggering 상태이므로 다른 호출은 진입 불가)
  const remaining = (db.prepare(
    "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ? AND status != 'done' AND parent_task_id IS NULL",
  ).get(goalId) as { count: number }).count;

  if (remaining > 0) {
    // 아직 미완 태스크 있음 — triggering 해제하여 이후 호출이 재시도 가능하게 복원
    db.prepare(
      "UPDATE goals SET squash_status = 'none' WHERE id = ? AND squash_status = 'triggering'",
    ).run(goalId);
    return;
  }

  const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as GoalRow | undefined;
  if (!goal) {
    db.prepare(
      "UPDATE goals SET squash_status = 'none' WHERE id = ? AND squash_status = 'triggering'",
    ).run(goalId);
    return;
  }

  log.info(`All tasks done for goal ${goalId} — triggering squash`);
  try {
    await triggerGoalSquash(db, broadcast, sessionManager, goal, worktreePath);
  } catch (err) {
    // triggerGoalSquash 실패 시 triggering 해제 (내부에서 blocked 설정 안 된 경우 복원)
    const currentStatus = (db.prepare("SELECT squash_status FROM goals WHERE id = ?").get(goalId) as { squash_status: string } | undefined)?.squash_status;
    if (currentStatus === "triggering") {
      db.prepare(
        "UPDATE goals SET squash_status = 'none' WHERE id = ? AND squash_status = 'triggering'",
      ).run(goalId);
    }
    throw err;
  }
}

/** Continue the normal Goal-as-Unit completion pipeline for tasks promoted
 * from verified commit evidence during startup recovery. */
export async function resumeRecoveredGoalSquashes(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  sessionManager: SessionManager,
): Promise<void> {
  const goals = db.prepare(`
    SELECT DISTINCT g.id, g.worktree_path
      FROM goals g
      JOIN tasks t ON t.goal_id = g.id
     WHERE g.goal_model = 'goal_as_unit'
       AND g.squash_status = 'none'
       AND g.worktree_path IS NOT NULL
       AND t.status = 'done'
       AND t.recovery_commit_ready = 1
       AND t.recovery_commit_sha IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM tasks remaining
          WHERE remaining.goal_id = g.id
            AND remaining.parent_task_id IS NULL
            AND remaining.status != 'done'
       )
  `).all() as Array<{ id: string; worktree_path: string }>;
  for (const goal of goals) {
    await checkAndTriggerGoalSquash(db, broadcast, sessionManager, goal.id, goal.worktree_path);
  }
}

/**
 * Goal 완료 후 squash 파이프라인 시작.
 * 1. acceptance_script 실행 (있을 경우)
 * 2. FAIL → squash_status='blocked'
 * 3. PASS or 없음 → squash_status='pending_approval' + broadcast
 */
async function triggerGoalSquash(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  sessionManager: SessionManager,
  goal: GoalRow,
  worktreePath: string,
): Promise<void> {
  // early return: 이미 처리 완료된 상태는 재진입 차단
  if (
    goal.squash_status === "blocked" ||
    goal.squash_status === "approved" ||
    goal.squash_status === "merged"
  ) return;

  // baseBranch 는 QA 태스크 description + squash merge 모두에서 사용 — 함수 상단에서 한 번만 조회
  const projectRow = db.prepare("SELECT base_branch FROM projects WHERE id = ?").get(goal.project_id) as { base_branch: string | null } | undefined;
  const baseBranch = projectRow?.base_branch || "main";

  // Phase 3 — S2: QA 회귀 태스크 생성 + squash 진입 전 차단
  // qa_regression_task_id 가 없으면 첫 호출 → QA 태스크 생성 후 대기
  if (!goal.qa_regression_task_id) {
    let qaTaskId: string;
    try {
      qaTaskId = createQARegressionTask(db, broadcast, goal, baseBranch);
    } catch (e) {
      const err = e as Error;
      const reason = err.message.includes("No agent available") ? "no_agent" : "create_failed";
      log.error(`Failed to create QA regression task for goal ${goal.id}: ${err.message}`);
      blockGoalForQARegressionFailure(
        db,
        broadcast,
        goal,
        reason,
        `QA 회귀 태스크 생성 실패 — squash 차단: "${(goal.title || goal.description || "").slice(0, 60)}" — ${err.message.slice(0, 180)}`,
      );
      return;
    }
    db.prepare("UPDATE goals SET qa_regression_task_id = ?, squash_status = 'none' WHERE id = ?").run(qaTaskId, goal.id);
    log.info(`QA regression task ${qaTaskId} created for goal ${goal.id}, waiting for completion`);
    broadcast("goal:qa_regression_created", { goalId: goal.id, qaTaskId });
    return; // squash 진행 안 함 — QA 태스크 done 대기
  }

  // qa_regression_task_id 가 있으면 해당 태스크 상태 확인
  const qaTask = db.prepare("SELECT status FROM tasks WHERE id = ?").get(goal.qa_regression_task_id) as { status: string } | undefined;
  if (!qaTask) {
    // 태스크가 삭제됐으면 재생성 (recovery)
    log.warn(`QA regression task ${goal.qa_regression_task_id} not found for goal ${goal.id} — recreating`);
    try {
      const newTaskId = createQARegressionTask(db, broadcast, goal, baseBranch);
      db.prepare("UPDATE goals SET qa_regression_task_id = ?, squash_status = 'none' WHERE id = ?").run(newTaskId, goal.id);
    } catch (e) {
      const err = e as Error;
      const reason = err.message.includes("No agent available") ? "no_agent" : "recreate_failed";
      log.error(`Failed to recreate QA regression task for goal ${goal.id}: ${err.message}`);
      blockGoalForQARegressionFailure(
        db,
        broadcast,
        goal,
        reason,
        `QA 회귀 태스크 재생성 실패 — squash 차단: "${(goal.title || goal.description || "").slice(0, 60)}" — ${err.message.slice(0, 180)}`,
      );
    }
    return;
  }
  if (qaTask.status !== "done") {
    log.info(`QA regression task ${goal.qa_regression_task_id} still ${qaTask.status}, waiting`);
    // triggering 해제 — 다음 태스크 done 이벤트에서 재시도 가능
    db.prepare("UPDATE goals SET squash_status = 'none' WHERE id = ? AND squash_status = 'triggering'").run(goal.id);
    return;
  }
  // C-2: QA done 이지만 이미 pending_approval 이면 재broadcast 생략
  if (goal.squash_status === "pending_approval") {
    log.info(`Goal ${goal.id} already in pending_approval — skip re-broadcast`);
    return;
  }
  // QA 태스크 done → 이후 acceptance_script + pending_approval 경로 진행

  if (goal.acceptance_script) {
    const scriptResult = runAcceptanceScript(worktreePath, goal.acceptance_script);
    if (!scriptResult.passed) {
      db.prepare(
        "UPDATE goals SET squash_status = 'blocked' WHERE id = ?",
      ).run(goal.id);
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'goal_squash_blocked', ?)",
      ).run(goal.project_id, `[goal-as-unit] Acceptance script FAIL — squash 차단: ${goal.title?.slice(0, 80)}\n${scriptResult.output.slice(0, 500)}`);
      broadcast("goal:squash_blocked", { goalId: goal.id, output: scriptResult.output });
      log.warn(`Goal ${goal.id} squash blocked by acceptance script`);
      return;
    }
    log.info(`Goal ${goal.id} acceptance script PASS`);
  }

  // Goal 누적 WIP를 goal 브랜치에 커밋 — 에이전트가 스스로 커밋했는지에 의존하지 않는다.
  // 이 단계가 없으면 merge --squash가 nothing-to-commit으로 끝나 승인이 빈 머지가 되고,
  // 승인 라우트의 정리 단계가 worktree/브랜치와 함께 작업물을 삭제한다 (R2 E2E 발견).
  let wipCommitFailure: string | null = null;
  try {
    const { spawnSync } = await import("node:child_process");
    const { TOOL_STATE_PATHS } = await import("../quality-gate/evaluator.js");
    const st = spawnSync("git", ["status", "--porcelain"], {
      cwd: worktreePath, stdio: "pipe", timeout: 10_000, encoding: "utf-8",
    });
    if (st.status !== 0) {
      wipCommitFailure = `git status failed: ${(st.stderr || st.stdout || "").toString().slice(0, 200)}`;
    } else {
      const hasRealChanges = (st.stdout ?? "").split("\n").filter(Boolean).some((line) => {
        const raw = line.slice(3).replace(/^"|"$/g, "");
        const p = raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
        return !TOOL_STATE_PATHS.some((t: string) => p === t || p.startsWith(`${t}/`));
      });
      if (hasRealChanges) {
        // `-A -- .` 는 global+local gitignore 를 존중해 도구 상태 경로(.omc 등)를
        // 자동 skip 한다. `:(exclude)<p>` pathspec 은 최상위 경로만 막아 중첩된
        // `server/.omc` 같은 ignored 를 못 걸러 "paths are ignored" fatal 을
        // 유발했다(WIP commit 실패 → 반영 차단). exclude 없이도 오염이 없어 제거한다.
        const addRes = spawnSync("git", [
          "add", "-A", "--", ".",
        ], { cwd: worktreePath, stdio: "pipe", timeout: 15_000, encoding: "utf-8" });
        if (addRes.status !== 0) {
          wipCommitFailure = `git add failed: ${(addRes.stderr || addRes.stdout || "").toString().slice(0, 200)}`;
        } else {
          const commitRes = spawnSync("git", [
            "commit", "-m",
            `chore(goal): 작업물 커밋 — "${(goal.title || goal.description || "").slice(0, 60)}" squash 준비`,
          ], { cwd: worktreePath, stdio: "pipe", timeout: 15_000, encoding: "utf-8" });
          if (commitRes.status === 0) {
            log.info(`Goal ${goal.id} WIP committed to goal branch before squash`);
          } else {
            wipCommitFailure = `git commit failed: ${(commitRes.stderr || commitRes.stdout || "").toString().slice(0, 200)}`;
          }
        }
      }
    }
  } catch (e: any) {
    wipCommitFailure = `WIP commit step failed: ${e.message}`;
  }
  if (wipCommitFailure) {
    db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goal.id);
    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'goal_squash_blocked', ?)",
    ).run(
      goal.project_id,
      `[goal-as-unit] Squash 차단: WIP commit 실패 — 미커밋 작업물이 남아 있어 승인 게이트로 넘길 수 없습니다: ${goal.title?.slice(0, 80) ?? ""}\n${wipCommitFailure}`,
    );
    broadcast("goal:squash_blocked", { goalId: goal.id, reason: "wip-commit-failed" });
    broadcast("project:updated", { projectId: goal.project_id });
    log.warn(`Goal ${goal.id} squash blocked — ${wipCommitFailure}`);
    return;
  }

  // 변경된 파일 목록 수집
  // H-2: 태스크들이 commit 완료된 상태이므로 "git diff HEAD"는 빈 결과.
  //      goal branch 에서 base_branch 대비 변경된 파일을 수집한다.
  let filesChanged: string[] = [];
  try {
    const { spawnSync } = await import("node:child_process");
    const diffResult = spawnSync("git", ["diff", "--name-only", `${baseBranch}...HEAD`], {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 10_000,
      encoding: "utf-8",
    });
    if (diffResult.status === 0) {
      filesChanged = diffResult.stdout.split("\n").filter(Boolean);
    }
    // fallback: base_branch 가 없는 경우 (initial commit 등) log 기반 수집
    if (filesChanged.length === 0) {
      const logResult = spawnSync(
        "git",
        ["log", "--name-only", "--pretty=format:", `${baseBranch}..HEAD`],
        { cwd: worktreePath, stdio: "pipe", timeout: 10_000, encoding: "utf-8" },
      );
      if (logResult.status === 0) {
        const seen = new Set<string>();
        for (const line of logResult.stdout.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) seen.add(trimmed);
        }
        filesChanged = Array.from(seen);
      }
    }
  } catch { /* best effort */ }

  // Squash 준비 계약: goal 브랜치에 반영할 커밋이 없으면 pending_approval 로 넘기지 않는다.
  // 에이전트가 실제 파일 변경을 만들지 않아 goal 브랜치에 커밋이 없으면 승인 게이트를
  // 띄우지 않는다. 이 상태에서 승인하면 squashMergeGoal 이 nothing-to-commit 으로
  // blocked 되어 '승인=빈 머지'가 된다 (R1 verify 발견).
  // 따라서 여기서 곧바로 blocked 처리해 계약을 지킨다 (acceptance-script FAIL 과 동일 경로).
  if (filesChanged.length === 0) {
    db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goal.id);
    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'goal_squash_blocked', ?)",
    ).run(
      goal.project_id,
      `[goal-as-unit] Squash 차단: 반영할 커밋이 없음 — goal 브랜치가 비어 있습니다 (작업물 미커밋/pre-commit hook 실패 가능성, worktree 수동 확인 필요): ${goal.title?.slice(0, 80) ?? ""}`,
    );
    broadcast("goal:squash_blocked", { goalId: goal.id, reason: "nothing-to-commit" });
    broadcast("project:updated", { projectId: goal.project_id });
    log.warn(`Goal ${goal.id} squash blocked — no committed changes on goal branch (filesChanged empty)`);
    return;
  }

  // 커밋 메시지 자동 생성
  const doneTasks = db.prepare(
    "SELECT title, result_summary FROM tasks WHERE goal_id = ? AND status = 'done' AND parent_task_id IS NULL ORDER BY sort_order ASC",
  ).all(goal.id) as { title: string; result_summary: string | null }[];
  const commitMessage = buildSquashCommitMessage(goal, doneTasks.map((t) => t.title));

  // 스크린샷 인라인 수집 (fs-only·best-effort) — 게이트에 즉시 실린다
  let workReport = initialWorkReport([]);
  try {
    const destDir = artifactsDirForGoal(db, goal.id);
    workReport = initialWorkReport(collectScreenshots(worktreePath, destDir));
    db.prepare("UPDATE goals SET work_report = ? WHERE id = ?").run(JSON.stringify(workReport), goal.id);
  } catch (e: any) {
    log.warn(`Screenshot collect failed for goal ${goal.id}: ${e.message}`);
  }

  db.prepare(
    "UPDATE goals SET squash_status = 'pending_approval' WHERE id = ?",
  ).run(goal.id);

  broadcast("goal:squash_ready", {
    goalId: goal.id,
    commitMessage,
    filesChanged,
    acceptanceOutput: "",
    workReport,
  });

  // LLM 서사 요약은 비동기 (큐/게이트 블로킹 금지) — 완료 시 goal:work_report 후속 이벤트
  void generateGoalWorkReport(
    db, broadcast, sessionManager, goal, doneTasks, filesChanged, workReport.screenshots,
  ).catch((e) => log.warn(`Work report generation failed for goal ${goal.id}: ${e.message}`));

  log.info(`Goal ${goal.id} squash ready — pending_approval`);
}

/**
 * Phase 3 — S2: Goal 완료 직전 실전 QA 회귀 태스크 생성.
 * qa || reviewer 에이전트에 배정. 한 번만 생성 (idempotent 보장은 호출자 책임).
 */
function createQARegressionTask(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  goal: GoalRow,
  baseBranch: string = "main",
): string {
  // H-2: fallback chain — qa → reviewer → qa-*/test-* → coder → non-cto → any
  const assignee =
    (db.prepare("SELECT id FROM agents WHERE project_id = ? AND role = 'qa' LIMIT 1").get(goal.project_id) as { id: string } | undefined) ??
    (db.prepare("SELECT id FROM agents WHERE project_id = ? AND role = 'reviewer' LIMIT 1").get(goal.project_id) as { id: string } | undefined) ??
    (db.prepare("SELECT id FROM agents WHERE project_id = ? AND (role LIKE 'qa%' OR role LIKE 'test%') LIMIT 1").get(goal.project_id) as { id: string } | undefined) ??
    (db.prepare("SELECT id FROM agents WHERE project_id = ? AND role = 'coder' LIMIT 1").get(goal.project_id) as { id: string } | undefined) ??
    (db.prepare("SELECT id FROM agents WHERE project_id = ? AND role != 'cto' LIMIT 1").get(goal.project_id) as { id: string } | undefined) ??
    (db.prepare("SELECT id FROM agents WHERE project_id = ? LIMIT 1").get(goal.project_id) as { id: string } | undefined);

  if (!assignee) {
    throw new Error(`No agent available for QA regression task in project ${goal.project_id}`);
  }

  const desc = [
    "Goal 완료 직전 실전 QA 회귀 테스트.",
    "",
    "⚠ 상시(standing) 서비스 보호: 이 worktree 가 상시 실행 중인 서비스와 같은 코드베이스일 수 있다(dogfooding).",
    "`npm run dev`·`npm start`·`scripts/service-macos.sh`·`predev.sh`·`launchctl bootout`·고정 포트 프로세스 `kill` 등",
    "상시/production 서비스를 내리는 명령을 절대 실행하지 말 것 — 지금 이 오케스트레이션 자신을 종료시킨다.",
    "",
    "수행:",
    "1. Goal 의 핵심 기능을 검증한다. dev 서버가 필요하면 반드시 임시/격리 포트로 띄우고(고정 포트 재사용 금지),",
    "   이미 떠 있는 인스턴스가 있으면 그것을 사용한다. 실행이 여의치 않으면 build + test + 정적 리뷰로 대체.",
    `2. git diff ${baseBranch}...HEAD 전체 리뷰 — 의도하지 않은 변경 없는지`,
    "3. 기존 기능 회귀 체크 (build/test 통과, 핵심 경로 정상)",
    "",
    "결과물:",
    "- PASS: description 업데이트 \"회귀 없음, 핵심 기능 정상\"",
    "- FAIL: 발견 이슈 나열 → Fix 태스크 수동 추가 필요",
    "",
    "이 태스크가 done 돼야 squash 단계로 진입한다.",
  ].join("\n");

  const maxOrder = (db.prepare(
    "SELECT MAX(sort_order) as m FROM tasks WHERE goal_id = ?",
  ).get(goal.id) as { m: number | null })?.m ?? 0;

  const row = db.prepare(`
    INSERT INTO tasks (goal_id, project_id, title, description, assignee_id, status, priority, sort_order, task_type)
    VALUES (?, ?, ?, ?, ?, 'todo', 'critical', ?, 'review')
    RETURNING id
  `).get(
    goal.id,
    goal.project_id,
    "[실전 QA 회귀] 앱 실행 + 전체 diff 리뷰",
    desc,
    assignee?.id ?? null,
    maxOrder + 1,
  ) as { id: string };

  db.prepare(
    "INSERT INTO activities (project_id, type, message) VALUES (?, 'qa_regression_created', ?)",
  ).run(
    goal.project_id,
    `QA 회귀 태스크 생성: "${(goal.title || goal.description || "").slice(0, 60)}" — squash 진입 전 필수`,
  );
  broadcast("project:updated", { projectId: goal.project_id });

  return row.id;
}

function blockGoalForQARegressionFailure(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  goal: GoalRow,
  reason: string,
  message: string,
): void {
  db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goal.id);
  const sourceTask = db.prepare(`
    SELECT id FROM tasks
    WHERE goal_id = ? AND parent_task_id IS NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get(goal.id) as { id: string } | undefined;
  db.prepare(
    "INSERT INTO activities (project_id, type, message, metadata) VALUES (?, 'qa_regression_failed', ?, ?)",
  ).run(
    goal.project_id,
    message,
    JSON.stringify({
      goalId: goal.id,
      reason,
      sourceTaskId: sourceTask?.id ?? null,
    }),
  );
  broadcast("goal:squash_blocked", { goalId: goal.id, reason });
  broadcast("project:updated", { projectId: goal.project_id });
}

/**
 * acceptance_script 실행.
 * spawnSync, 타임아웃 2분, stdin=/dev/null, 종료코드 0 = PASS.
 * (goals 라우트의 squash 충돌 해결 후 재검증에서도 사용)
 */
export function runAcceptanceScript(
  workdir: string,
  script: string,
  timeoutMs: number = 120_000,
): { passed: boolean; output: string } {
  const result = spawnSync("sh", ["-c", script], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    encoding: "utf-8",
  });

  const rawOutput = [result.stdout ?? "", result.stderr ?? ""].join("\n").trim();
  const output = rawOutput.slice(0, 1000);

  if (result.error) {
    // ETIMEDOUT or SIGKILL
    return { passed: false, output: `Script error: ${result.error.message}\n${output}` };
  }

  const passed = result.status === 0;
  return { passed, output };
}

/**
 * Goal squash commit 메시지 자동 생성.
 */
function buildSquashCommitMessage(goal: GoalRow, taskTitles: string[]): string {
  const taskBullets = taskTitles.map((t) => `- ${t}`).join("\n");
  return `${goal.title || goal.description}\n\nTasks:\n${taskBullets}\n\nGenerated by Crewdeck (Goal-as-Unit)`;
}

function updateGoalProgress(db: Database, goalId: string): void {
  // Atomic UPDATE to avoid SELECT-then-UPDATE race with concurrent task updates.
  // Clamped to 0..100 defensively.
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

/**
 * Detect task complexity aligned with Crewdeck §1.
 * - simple: 1-2 files, single module
 * - moderate: 3-7 files, new feature
 * - complex: 8+ files, multi-module, or high-risk domain
 */
type Complexity = "simple" | "moderate" | "complex";

function detectComplexity(task: TaskRow): Complexity {
  const text = `${task.title} ${task.description}`.toLowerCase();

  // High-risk keywords force escalation (Crewdeck §1: auth/DB/payment → one level up)
  const highRisk = [
    "auth", "payment", "migration", "security", "schema", "deploy",
    "database", "credential", "permission", "billing", "encrypt",
  ];
  if (highRisk.some((k) => text.includes(k))) return "complex";

  // Estimate from description patterns
  const filePatterns = text.match(/\.(ts|js|tsx|jsx|py|go|rs|css|html|vue|svelte)\b/g);
  const estimatedFiles = filePatterns?.length ?? 0;

  if (estimatedFiles >= 8) return "complex";
  if (estimatedFiles >= 3) return "moderate";

  // Check for multi-module indicators
  const multiModule = ["multiple files", "여러 파일", "across modules", "다중 모듈", "refactor"];
  if (multiModule.some((k) => text.includes(k))) return "moderate";

  return "simple";
}

/**
 * Build architect prompt for CPS design phase.
 * Used for moderate/complex tasks before implementation (Crewdeck Orchestrator Phase 2).
 */
function buildArchitectPrompt(task: TaskRow, methodology: ReturnType<typeof createMethodologyEngine>): string {
  const orchestratorProtocol = methodology.getOrchestratorProtocol();

  // Extract Phase 2 (Design) section from orchestrator protocol
  const phase2Match = orchestratorProtocol.match(/### Phase 2:[\s\S]*?(?=### Phase 3:|### --design-only)/);
  const designGuidance = phase2Match ? phase2Match[0].trim() : "";

  return `# Architecture Design — CPS Pattern

You are the Architect. Design ONLY, do NOT implement.

## ⚠️ CRITICAL: Read-Only Session
**Do NOT create, edit, or modify any files. Do NOT use the Write, Edit, or
NotebookEdit tools.** Respond with the design as text in your stdout
response only. Files created in this session pollute the project root and
break subsequent merge operations (Crewdeck incident: stuck for 8h on merge
conflicts from an architect-created design doc).

You MAY use Read/Glob/Grep to understand the codebase, but absolutely no
writes. If you feel the need to produce a design document file, inline it
into your response instead.

## Task
"${task.title}"
${task.description}

## Design Guidance (from Crewdeck Orchestrator)
${designGuidance || "Write a CPS design: Context → Problem → Solution"}

## Output
Produce a CPS design document with:
1. **Context**: Current project state, relevant files, tech stack
2. **Problem**: What exactly needs to change and why (MECE decomposition)
3. **Solution**: File structure, data flow, API boundaries, implementation order, build/verify commands

Keep the design concise (under 100 lines). Focus on what the implementer needs.
`;
}
