import type { Database } from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { SessionManager } from "../agent/session.js";
import { parseStreamJson } from "../agent/adapters/stream-parser.js";
import { createQualityGate } from "../quality-gate/evaluator.js";
import { createDelegationEngine } from "./delegation.js";
import { executeGitWorkflow, getDefaultBranch, squashMergeGoal, type GitHubConfig, type GitMode, type GitWorkflowResult } from "../project/git-workflow.js";
import type { WorktreeInfo } from "../project/worktree.js";
import { createLogger } from "../../utils/logger.js";
import { MAX_TITLE_LEN, MAX_DESC_LEN, MAX_SUMMARY_LEN, MAX_TASKS_PER_GOAL, MAX_TASK_RETRIES, MAX_REASSIGNS } from "../../utils/constants.js";
import type { VerificationScope } from "../../../shared/types.js";
import { appendMemory } from "../agent/memory.js";
import { createNovaRulesEngine } from "../nova-rules/index.js";
import { autoDetectScope } from "../quality-gate/evaluator.js";
import { detectAgentRunFailure, classifyAgentFailure } from "../../utils/errors.js";
import { shouldEscalateVerifyCap, escalateVerificationCap } from "./verification-policy.js";

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
  target_files: string | null;  // JSON array of paths (P2: scope anchoring)
  stack_hint: string | null;    // Short stack constraint (P2: scope anchoring)
  depends_on: string | null;    // JSON array of task IDs (DAG dependency)
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

export interface OrchestrationConfig {
  verificationScope: VerificationScope;
  autoFix: boolean;
  maxFixRetries: number;
}

const DEFAULT_CONFIG: OrchestrationConfig = {
  verificationScope: "standard",
  autoFix: true,
  maxFixRetries: 1,
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
 * Pipeline (ported from Nova Orchestrator):
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

      // Atomic guard: prevent duplicate execution of the same task.
      // Two code paths can race here — scheduler.executeOne AND the
      // manual /tasks/:id/execute API route. Without this, both spawn
      // a session for the same agent → the second spawn kills the first
      // → exit 143 (SIGTERM). CAS-style: only the caller that flips
      // the status from todo→in_progress proceeds.
      const cas = db.prepare(
        "UPDATE tasks SET status = 'in_progress', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status IN ('todo', 'pending_approval')",
      ).run(taskId);
      if (cas.changes === 0) {
        // Another caller already claimed this task
        const current = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined;
        throw new Error(`Task already ${current?.status ?? "unknown"} — skipping duplicate execution`);
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
      const workdir = project.workdir || (() => { throw new Error("Project has no workdir configured"); })();
      const { existsSync } = await import("node:fs");
      if (!existsSync(workdir)) {
        throw new Error(`Working directory does not exist: ${workdir}`);
      }

      // Phase 0: Attempt delegation to subordinates (only for root tasks)
      if (!task.parent_task_id) {
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

      // Phase 0.5: Complexity detection + Architect phase (Nova Orchestrator alignment)
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

      if (complexity !== "simple" && !task.parent_task_id && !isReviewerTask) {
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

          const novaRules = createNovaRulesEngine();
          const architectPrompt = buildArchitectPrompt(task, novaRules);
          const archSessionKey = `architect-${taskId}`;
          // 세션 시작 전 dirty 스냅샷 — residue sweep이 "세션 중 새로 생긴 것"만
          // 커밋하도록 기준선을 잡는다. 이게 없으면 사용자가 원래 갖고 있던
          // untracked 자산까지 "architect 잔여물"로 오인해 main에 커밋한다
          // (proof dogfooding: 사용자 목업 PNG 6개가 main에 커밋된 P1).
          const preArchDirty = new Set<string>(await (async () => {
            try {
              const { spawnSync } = await import("node:child_process");
              const pre = spawnSync("git", ["status", "--porcelain"], {
                cwd: workdir, stdio: "pipe", timeout: 5_000, encoding: "utf-8",
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
            const archSession = sessionManager.spawnAgent(ctoAgent.id, workdir, archSessionKey);
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
            archSession.on("nova:error", (error: unknown) => {
              broadcast("system:error", { agentId: ctoAgent.id, agentName: "architect", taskId, error });
            });
            const archResult = await archSession.send(architectPrompt);
            const archParsed = parseStreamJson(archResult.stdout);
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
            // historically has still done so (Nova incident: architect wrote
            // auth-infrastructure.md to project root → every subsequent task's
            // merge-to-main failed for 8h with "Your local changes would be
            // overwritten"). Auto-commit any residue immediately so future
            // merges see a clean tree.
            try {
              const { spawnSync } = await import("node:child_process");
              const statusRes = spawnSync("git", ["status", "--porcelain"], {
                cwd: workdir, stdio: "pipe", timeout: 5_000, encoding: "utf-8",
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
                log.warn(`Architect phase left uncommitted changes despite read-only instruction — auto-committing as docs(nova-architect):\n${realDirty.join("\n").slice(0, 500)}`);
                // 신규 잔여물 경로만 스테이징 — `add -A .`는 사용자의 기존
                // untracked/수정 파일까지 쓸어담아 main을 오염시킨다
                const residuePaths = realDirty.map((line) => {
                  const raw = line.slice(3).replace(/^"|"$/g, "");
                  return raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
                });
                spawnSync("git", [
                  "add", "-A", "--", ...residuePaths,
                ], { cwd: workdir, stdio: "pipe", timeout: 10_000 });
                const commitRes = spawnSync("git", [
                  "commit", "-m",
                  `docs(nova-architect): residue from "${task.title.slice(0, 60)}" architect phase\n\nNova Orbit auto-committed files left by the CTO architect session.\nThis prevents them from blocking subsequent task merges.`,
                ], { cwd: workdir, stdio: "pipe", timeout: 10_000, encoding: "utf-8" });
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

      // Auto-detect verification scope if not explicitly set (Nova §1 alignment)
      const effectiveVerificationScope = opts.verificationScope !== "standard"
        ? opts.verificationScope
        : autoDetectScope(task, undefined);

      // Phase 1: in_progress transition already done by atomic CAS guard above

      // Worktree isolation (Sprint 4): git repo가 있으면 격리된 worktree에서 실행
      // needs_worktree=0인 에이전트(reviewer, qa, 또는 사용자 설정)는 프로젝트 루트에서 실행
      let effectiveWorkdir = workdir;
      let worktreeInfo: WorktreeInfo | null = null;

      // Goal 정보 조회 — goal_model 분기 결정
      const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(task.goal_id) as GoalRow | undefined;
      const isGoalAsUnit = goal?.goal_model === "goal_as_unit";

      if (!needsWorktree) {
        log.info(`Skipping worktree for agent "${agentName}" (needs_worktree=0) — using project root`);
      } else if (isGoalAsUnit) {
        // Goal-as-Unit: 공유 worktree 사용 (Goal 시작 시 1회 생성)
        try {
          const { createGoalWorktree, stashCheckpoint } = await import("../project/worktree.js");

          let goalWorktreePath = goal?.worktree_path;
          let goalWorktreeBranch = goal?.worktree_branch;

          if (!goalWorktreePath) {
            // 첫 태스크: goal worktree 생성
            const goalSlug = (goal?.title || goal?.description || task.goal_id).slice(0, 50);
            const newWorktree = createGoalWorktree(workdir, goalSlug);
            if (newWorktree) {
              goalWorktreePath = newWorktree.path;
              goalWorktreeBranch = newWorktree.branch;
              // goals 테이블에 worktree_path/worktree_branch 저장
              db.prepare(
                "UPDATE goals SET worktree_path = ?, worktree_branch = ? WHERE id = ?",
              ).run(goalWorktreePath, goalWorktreeBranch, task.goal_id);
              log.info(`Goal worktree created: ${goalWorktreePath} (branch: ${goalWorktreeBranch})`);
            } else {
              log.warn(`Goal worktree creation failed — using project root for goal ${task.goal_id}`);
            }
          }

          if (goalWorktreePath) {
            effectiveWorkdir = goalWorktreePath;
            // 태스크 시작 전 stash 체크포인트
            stashCheckpoint(goalWorktreePath, task.id);
            log.info(`Goal-as-Unit: using shared worktree ${goalWorktreePath}`);
          }
        } catch (err: any) {
          log.warn(`Goal-as-Unit worktree setup failed, using project root: ${err.message}`);
        }
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

      // Phase 2: Execute via assigned agent
      let session;
      try {
        session = sessionManager.spawnAgent(task.assignee_id, effectiveWorkdir);
      } catch (spawnErr: any) {
        log.error(`Failed to spawn agent for task "${task.title}"`, spawnErr);
        throw new Error(`Agent spawn failed: ${spawnErr.message}`);
      }

      // Stream agent output to WebSocket
      session.on("output", (text: string) => {
        broadcast("agent:output", { agentId: task.assignee_id, output: text, taskId });
      });

      session.on("rate-limit", (info: { waitMs: number; stderr: string }) => {
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
      session.on("nova:error", (error: unknown) => {
        broadcast("system:error", {
          agentId: task.assignee_id,
          agentName,
          taskId,
          error,
        });
      });
      const execActivity = `task:${task.title?.slice(0, 80) ?? ""}`;
      db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, current_activity = ? WHERE id = ?")
        .run(taskId, execActivity, task.assignee_id);
      broadcast("agent:status", { id: task.assignee_id, name: agentName, status: "working", taskId, activity: execActivity });
      broadcast("task:started", { taskId, agentId: task.assignee_id, startedAt: new Date().toISOString() });

      try {
        const novaRules = createNovaRulesEngine();
        const autoApplyRules = novaRules.getAutoApplyRules();

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
${targetFiles.length > 0 ? `**Modify ONLY these files** (create them if they don't exist yet):
${targetFiles.map((f) => `- \`${f}\``).join("\n")}

If you find yourself about to create a file outside this list, STOP and ask:
"Does the task really require a new file elsewhere, or am I drifting?"` : ""}
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
${previousTaskContext}${priorFailureContext ? `${priorFailureContext}\n\nThe issues above caused previous attempts of THIS task to fail verification.\nThe workspace was restored to its pre-task state, so your implementation must\nsolve the task AND avoid re-introducing every issue listed above.\n` : ""}${scopeAnchor}${architectContext ? `\n## Architecture Design\n${architectContext}\n` : ""}
## Nova Auto-Apply Rules
${autoApplyRules || "Follow clean code conventions and existing patterns."}

## Constraints
- Clean, production-ready code
- Follow existing codebase conventions
- Run lint/type-check before finishing
- DO NOT verify your own work — verification is handled by independent Evaluator
- Fix ONLY what the task requires — do not refactor unrelated code
${!needsWorktree ? `
## Managed Directories — DO NOT TOUCH
You are running directly in the project root (no isolated worktree). The
following directories belong to OTHER concurrent tasks and Nova Orbit's
worktree manager — do NOT create, modify, or delete files inside them:
- \`.nova-worktrees/\`
- \`.claude/worktrees/\`

Any file you create elsewhere in the project will be committed as part of
this task. Prefer returning findings as prose in your response rather than
writing files for review/QA tasks.
` : ""}
When complete, provide a summary of changes made.
`;

        const implResult = await session.send(implementationPrompt);
        const implParsed = parseStreamJson(implResult.stdout);

        // Hard gate: detect silent failures where the CLI crashed, the stream
        // emitted errors, or an API error signature leaked into assistant text.
        // Without this the task gets marked done with garbage like
        // "API Error: Unable to connect to API (ECONNRESET)" as its summary.
        const implFailure = detectAgentRunFailure(implResult, implParsed);
        if (implFailure) {
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
            db.prepare(
              "UPDATE sessions SET token_usage = token_usage + ?, cost_usd = cost_usd + ? WHERE agent_id = ? AND status = 'active'",
            ).run(
              implParsed.usage.inputTokens + implParsed.usage.outputTokens + implParsed.usage.cacheCreationTokens,
              implParsed.usage.totalCostUsd ?? 0,
              task.assignee_id,
            );
          }
          sessionManager.killSession(task.assignee_id);
          // Re-throw so executeTask's catch transitions the task to blocked and
          // the scheduler's retry/reassign budget takes over. This is the ONLY
          // path that prevents silent API failures from being marked done.
          throw implFailure;
        }

        // Update session token usage BEFORE killSession (which sets status='killed')
        if (implParsed.usage) {
          db.prepare(
            "UPDATE sessions SET token_usage = token_usage + ? WHERE agent_id = ? AND status = 'active'",
          ).run(
            implParsed.usage.inputTokens + implParsed.usage.outputTokens + implParsed.usage.cacheCreationTokens,
            task.assignee_id,
          );
        }

        // 구현 세션 즉시 정리 — verification에서 같은 agentId 충돌 방지
        sessionManager.killSession(task.assignee_id);

        // Defensive sweep: reviewer/qa tasks (needs_worktree=0) run at the
        // project root. If they accidentally wrote into managed worktree
        // directories, those writes belong to OTHER tasks — detect and
        // auto-clean the residue so it doesn't pollute this commit or trigger
        // `ignored by .gitignore` errors downstream. Only warns when the dirs
        // actually exist with untracked content; does not touch linked
        // worktrees themselves.
        if (!needsWorktree) {
          try {
            const { spawnSync } = await import("node:child_process");
            const statusRes = spawnSync(
              "git",
              ["status", "--porcelain", "--", ".nova-worktrees/", ".claude/worktrees/"],
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

        // Sprint 6: result_summary 저장 (마지막 500자)
        const summary = (implParsed.text ?? "").slice(-MAX_SUMMARY_LEN);
        db.prepare("UPDATE tasks SET result_summary = ? WHERE id = ?").run(summary, task.id);

        // Sprint 6: 에이전트 메모리에 태스크 완료 기록
        if (task.assignee_id) {
          const dataDir = process.env.NOVA_ORBIT_DATA_DIR || join(process.cwd(), ".nova-orbit");
          const memoryEntry = `Task "${task.title}" completed. Summary: ${summary}`;
          try {
            appendMemory(dataDir, task.assignee_id, memoryEntry);
          } catch (memErr: any) {
            log.warn(`Failed to append agent memory: ${memErr.message}`);
          }
        }

        // Broadcast usage data for dashboard
        if (implParsed.usage) {
          broadcast("task:usage", {
            taskId,
            agentId: task.assignee_id,
            usage: implParsed.usage,
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

        // Subtasks skip verification (design decision: parent task level QG only)
        if (task.parent_task_id) {
          transitionTask(db, broadcast, task, "done");
          return { success: true, verdict: "pass" };
        }

        // Phase 3: Move to review
        transitionTask(db, broadcast, task, "in_review");

        // Phase 4: Quality Gate verification (worktree 경로 전달)
        const verification = await qualityGate.verify(taskId, {
          scope: effectiveVerificationScope,
          workdir: effectiveWorkdir,
        });

        broadcast("verification:result", verification);

        // 검증 라운드 상한 (무한 검토 방지): fail 이 상한만큼 누적된 태스크는
        // fix→재검증을 반복하지 않는다 — 산출물 보존 + 완료 처리 + 이슈는
        // goal 최종 QA 로 이월 (verification-policy.ts 참고).
        if (verification.verdict === "fail" && shouldEscalateVerifyCap(db, task.id)) {
          if (isGoalAsUnit) {
            const { dropCheckpoint } = await import("../project/worktree.js");
            dropCheckpoint(effectiveWorkdir, task.id);
          }
          escalateVerificationCap(db, broadcast, task, verification.issues ?? []);
          if (isGoalAsUnit && task.goal_id) {
            await checkAndTriggerGoalSquash(db, broadcast, task.goal_id, effectiveWorkdir);
          }
          return { success: true, verdict: verification.verdict };
        }

        // Phase 5: Auto-fix if needed
        if (verification.verdict === "fail" && opts.autoFix && opts.maxFixRetries > 0) {
          log.info("Verification FAIL — attempting auto-fix");

          // Sprint 6: Smart Resume — 이전 실패 이력 조회 (공용 헬퍼)
          const failureContext = buildFailureHistoryContext(db, task.id, 2);

          const fixPrompt = `
# Fix Required (Smart Resume)
${failureContext}

The following issues were found during verification:
${verification.issues.map((i) => `- [${i.severity}] ${i.file ?? ""}:${i.line ?? ""} — ${i.message}`).join("\n")}

Fix ONLY these issues. Do not modify other code.
`;
          // Spawn a NEW session for fix (prevent context pollution — Nova rule)
          // Keep agent in 'working' state during fix to prevent scheduler double-assignment
          db.prepare("UPDATE agents SET status = 'working', current_task_id = ?, current_activity = ? WHERE id = ?")
            .run(taskId, `fix:${task.title?.slice(0, 80) ?? ""}`, task.assignee_id);
          const fixSession = sessionManager.spawnAgent(task.assignee_id, effectiveWorkdir);
          fixSession.on("rate-limit", (info: { waitMs: number; stderr: string }) => {
            broadcast("system:rate-limit", {
              agentId: task.assignee_id, agentName, taskId,
              waitMs: info.waitMs, message: info.stderr,
            });
          });
          fixSession.on("nova:error", (error: unknown) => {
            broadcast("system:error", { agentId: task.assignee_id, agentName, taskId, error });
          });
          try {
            const fixResult = await fixSession.send(fixPrompt);
            const fixParsed = parseStreamJson(fixResult.stdout);
            // Same silent-failure gate as the implementation phase — a
            // failed fix attempt must not silently count as a successful fix.
            const fixFailure = detectAgentRunFailure(fixResult, fixParsed);
            if (fixFailure) {
              log.error(`Auto-fix failed [${fixFailure.code}]: ${fixFailure.message}`, {
                taskId,
                taskTitle: task.title,
                detail: fixFailure.detail,
              });
              broadcast("system:error", {
                agentId: task.assignee_id,
                agentName,
                taskId,
                error: fixFailure.toJSON(),
              });
              // Don't throw — let the re-verification decide the task's fate.
              // A failed fix call still leaves the code in its previous state,
              // which the evaluator will still catch.
            }
          } finally {
            sessionManager.killSession(task.assignee_id);
          }

          // Re-verify (worktree 경로 전달)
          const reVerification = await qualityGate.verify(taskId, {
            scope: effectiveVerificationScope,
            workdir: effectiveWorkdir,
          });
          broadcast("verification:result", reVerification);

          // Update task status based on re-verification result
          const rePass = reVerification.verdict === "pass" || reVerification.verdict === "conditional";

          // 재검증 fail 도 라운드 상한에 걸리면 폐기·blocked 대신 완료+이월
          if (!rePass && shouldEscalateVerifyCap(db, task.id)) {
            if (isGoalAsUnit) {
              const { dropCheckpoint } = await import("../project/worktree.js");
              dropCheckpoint(effectiveWorkdir, task.id);
            }
            escalateVerificationCap(db, broadcast, task, reVerification.issues ?? []);
            if (isGoalAsUnit && task.goal_id) {
              await checkAndTriggerGoalSquash(db, broadcast, task.goal_id, effectiveWorkdir);
            }
            return { success: true, verdict: reVerification.verdict };
          }

          if (rePass) {
            if (isGoalAsUnit) {
              // Goal-as-Unit: git workflow 없음, 체크포인트 제거 후 done 전환
              const { dropCheckpoint } = await import("../project/worktree.js");
              dropCheckpoint(effectiveWorkdir, task.id);
              transitionTask(db, broadcast, task, "done");
              await checkAndTriggerGoalSquash(db, broadcast, task.goal_id, effectiveWorkdir);
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
          } else if (isGoalAsUnit) {
            // Goal-as-Unit: QG re-verify FAIL → stash 복원 후 blocked.
            // 복원(폐기) 전에 diff 를 보존한다 — 유효했던 부분 수정까지 증발해
            // 다음 재시도가 백지에서 재작업하던 실측 사고(07-08)의 방지.
            saveDiscardedDiff(db, task.id, effectiveWorkdir);
            try {
              const { restoreCheckpoint } = await import("../project/worktree.js");
              const restored = restoreCheckpoint(effectiveWorkdir, task.id);
              if (!restored) {
                db.prepare(
                  "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'autopilot_warning', ?)",
                ).run(task.project_id, task.assignee_id, `[goal-as-unit] 체크포인트 복원 실패 — 수동 개입 필요: ${task.title}`);
              }
            } catch (restoreErr: any) {
              log.warn(`restoreCheckpoint failed for task ${task.id}: ${restoreErr.message}`);
            }
          }

          transitionTask(db, broadcast, task, rePass ? "done" : "blocked");

          return {
            success: reVerification.verdict === "pass",
            verdict: reVerification.verdict,
          };
        }

        // Update task status based on verification result
        // pass + conditional → done, fail → blocked
        const passed = verification.verdict === "pass" || verification.verdict === "conditional";

        if (passed) {
          if (isGoalAsUnit) {
            // Goal-as-Unit: git workflow 없음, 체크포인트 제거 후 done 전환
            const { dropCheckpoint } = await import("../project/worktree.js");
            dropCheckpoint(effectiveWorkdir, task.id);
            transitionTask(db, broadcast, task, "done");
            await checkAndTriggerGoalSquash(db, broadcast, task.goal_id, effectiveWorkdir);
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

        if (!passed && isGoalAsUnit) {
          // Goal-as-Unit: QG FAIL → stash 복원 후 blocked (폐기 전 diff 보존)
          saveDiscardedDiff(db, task.id, effectiveWorkdir);
          try {
            const { restoreCheckpoint } = await import("../project/worktree.js");
            const restored = restoreCheckpoint(effectiveWorkdir, task.id);
            if (!restored) {
              db.prepare(
                "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'autopilot_warning', ?)",
              ).run(task.project_id, task.assignee_id, `[goal-as-unit] 체크포인트 복원 실패 — 수동 개입 필요: ${task.title}`);
            }
          } catch (restoreErr: any) {
            log.warn(`restoreCheckpoint failed for task ${task.id}: ${restoreErr.message}`);
          }
        }

        transitionTask(db, broadcast, task, passed ? "done" : "blocked");

        return {
          success: verification.verdict === "pass",
          verdict: verification.verdict,
        };
      } catch (err: any) {
        log.error(`Task execution failed: ${task.title}`, err);

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
      try {

      const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as GoalRow | undefined;
      if (!goal) {
        throw new Error(`Goal ${goalId} not found`);
      }

      // H-3: tasks INSERT 전에 미리 goal_model='goal_as_unit' 설정.
      //      tasks INSERT 이후 승격 시 scheduler 가 그 사이에 legacy 경로로 태스크를 pick 할 수 있음.
      if (goal.goal_model !== "goal_as_unit") {
        db.prepare("UPDATE goals SET goal_model = 'goal_as_unit' WHERE id = ?").run(goal.id);
        goal.goal_model = "goal_as_unit";
        log.info(`Goal ${goal.id} pre-upgraded to goal_as_unit before task decomposition`);
      }

      const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(goal.project_id) as ProjectRow | undefined;

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
        session = sessionManager.spawnAgent(agent.id, project?.workdir || process.cwd(), decomposeSessionKey);
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

      // Check if goal has a structured spec for richer context
      const goalSpec = db.prepare("SELECT * FROM goal_specs WHERE goal_id = ?").get(goal.id) as any;
      let specContext = "";
      if (goalSpec) {
        try {
          const prd = JSON.parse(goalSpec.prd_summary || "{}");
          const features = JSON.parse(goalSpec.feature_specs || "[]");
          const flow = JSON.parse(goalSpec.user_flow || "[]");
          const criteria = JSON.parse(goalSpec.acceptance_criteria || "[]");
          const tech = JSON.parse(goalSpec.tech_considerations || "[]");

          // Compact spec: name+priority only (no description), max 5 criteria to minimize token usage
          const featureList = features.slice(0, 8).map((f: any) => `- [${f.priority}] ${f.name}`).join("\n");
          const criteriaList = criteria.slice(0, 5).map((c: string) => `- ${c}`).join("\n");

          specContext = `

## Spec Summary
**Objective**: ${(prd.objective || "N/A").slice(0, 120)}
**Scope**: ${(prd.scope || "N/A").slice(0, 120)}

### Features (${features.length})
${featureList}

### Acceptance Criteria
${criteriaList}
`;
        } catch { /* ignore parse errors, use basic prompt */ }
      }

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
- Verification/review/QA tasks should always have the highest order number (run last)${goalSpec ? "\n- Reference the structured spec above to ensure complete coverage of all features and acceptance criteria" : ""}
- Set "type": task type — determines verification criteria applied
  - "code": source code implementation (default, 5-dimension verification)
  - "content": documentation / copywriting / i18n (3-dimension: Completeness, Consistency, Clarity)
  - "config": infrastructure / environment / CI config (2-dimension: Validity, Security)
  - "review": QA execution / smoke test / integration test (execution-based pass/fail only)

## Required fields per task
- \`target_files\`: array of file paths this task will touch (e.g.
  \`["web/src/app/page.tsx"]\`). Use the project stack above. Empty \`[]\`
  only if you genuinely cannot guess. Evaluator rejects diff/scope drift.
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

      const parsed = parseStreamJson(runResult.stdout);

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

        // Flexible role matching: exact → partial keyword → any coder → first available
        // When multiple agents share the same role, round-robin across them so
        // decomposed tasks are evenly distributed (e.g., frontend-dev-1 and
        // frontend-dev-2 each get roughly half the frontend tasks).
        const roleAssignCount = new Map<string, number>();
        const findAgent = (role: string) => {
          const r = role.toLowerCase();
          // 1) Exact role matches
          const exactMatches = candidates.filter((a) => a.role === r);
          if (exactMatches.length > 0) {
            const count = roleAssignCount.get(r) ?? 0;
            roleAssignCount.set(r, count + 1);
            return exactMatches[count % exactMatches.length];
          }
          // 2) Partial keyword match
          const partialMatches = candidates.filter((a) => r.includes(a.role) || a.role.includes(r));
          if (partialMatches.length > 0) {
            const key = `partial:${r}`;
            const count = roleAssignCount.get(key) ?? 0;
            roleAssignCount.set(key, count + 1);
            return partialMatches[count % partialMatches.length];
          }
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
            INSERT INTO tasks (goal_id, project_id, title, description, assignee_id, status, priority, sort_order, target_files, stack_hint, task_type)
            VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?)
            RETURNING id
          `).get(
            goal.id, goal.project_id, title, description, agent?.id ?? null,
            priority, sortOrder,
            JSON.stringify(targetFiles), stackHint, taskType,
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

      const parsed = parseStreamJson(runResult.stdout);

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
            "INSERT INTO goals (project_id, title, description, priority, sort_order) VALUES (?, ?, ?, ?, ?) RETURNING id",
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
  db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newStatus, task.id);
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
            const { pushBranch } = await import("../project/git-workflow.js");
            pushBranch(projectRoot, targetBranch);
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
async function checkAndTriggerGoalSquash(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
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
    await triggerGoalSquash(db, broadcast, goal, worktreePath);
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

/**
 * Goal 완료 후 squash 파이프라인 시작.
 * 1. acceptance_script 실행 (있을 경우)
 * 2. FAIL → squash_status='blocked'
 * 3. PASS or 없음 → squash_status='pending_approval' + broadcast
 */
async function triggerGoalSquash(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
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
      log.error(`Failed to create QA regression task for goal ${goal.id}: ${(e as Error).message}`);
      // createQARegressionTask 내부에서 blocked 로 설정하지 않은 경우 triggering 복원
      db.prepare(
        "UPDATE goals SET squash_status = 'none' WHERE id = ? AND squash_status = 'triggering'"
      ).run(goal.id);
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
      log.error(`Failed to recreate QA regression task for goal ${goal.id}: ${(e as Error).message}`);
      db.prepare("UPDATE goals SET squash_status = 'none' WHERE id = ? AND squash_status = 'triggering'").run(goal.id);
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
  try {
    const { spawnSync } = await import("node:child_process");
    const { TOOL_STATE_PATHS } = await import("../quality-gate/evaluator.js");
    const st = spawnSync("git", ["status", "--porcelain"], {
      cwd: worktreePath, stdio: "pipe", timeout: 10_000, encoding: "utf-8",
    });
    const hasRealChanges = (st.stdout ?? "").split("\n").filter(Boolean).some((line) => {
      const raw = line.slice(3).replace(/^"|"$/g, "");
      const p = raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
      return !TOOL_STATE_PATHS.some((t: string) => p === t || p.startsWith(`${t}/`));
    });
    if (hasRealChanges) {
      spawnSync("git", [
        "add", "-A", "--", ".",
        ...TOOL_STATE_PATHS.map((p: string) => `:(exclude)${p}`),
      ], { cwd: worktreePath, stdio: "pipe", timeout: 15_000 });
      const commitRes = spawnSync("git", [
        "commit", "-m",
        `chore(goal): 작업물 커밋 — "${(goal.title || goal.description || "").slice(0, 60)}" squash 준비`,
      ], { cwd: worktreePath, stdio: "pipe", timeout: 15_000, encoding: "utf-8" });
      if (commitRes.status === 0) {
        log.info(`Goal ${goal.id} WIP committed to goal branch before squash`);
      } else {
        log.warn(`Goal ${goal.id} WIP commit failed: ${commitRes.stderr?.toString().slice(0, 200)}`);
      }
    }
  } catch (e: any) {
    log.warn(`Goal WIP commit step failed: ${e.message}`);
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

  // 커밋 메시지 자동 생성
  const doneTasks = db.prepare(
    "SELECT title FROM tasks WHERE goal_id = ? AND status = 'done' AND parent_task_id IS NULL ORDER BY sort_order ASC",
  ).all(goal.id) as { title: string }[];
  const commitMessage = buildSquashCommitMessage(goal, doneTasks.map((t) => t.title));

  db.prepare(
    "UPDATE goals SET squash_status = 'pending_approval' WHERE id = ?",
  ).run(goal.id);

  broadcast("goal:squash_ready", {
    goalId: goal.id,
    commitMessage,
    filesChanged,
    acceptanceOutput: "",
  });

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
    db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goal.id);
    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'qa_regression_failed', ?)",
    ).run(
      goal.project_id,
      `QA 회귀 태스크 생성 실패: 에이전트 없음 — "${(goal.title || goal.description || "").slice(0, 60)}"`,
    );
    broadcast("goal:squash_blocked", { goalId: goal.id, reason: "no_agent" });
    throw new Error(`No agent available for QA regression task in project ${goal.project_id}`);
  }

  const desc = [
    "Goal 완료 직전 실전 QA 회귀 테스트.",
    "",
    "수행:",
    "1. 이 worktree 에서 dev 서버 기동 (npm run dev 또는 동등)",
    "2. Goal 의 핵심 기능을 실제 UI 에서 5분간 사용",
    `3. git diff ${baseBranch}...HEAD 전체 리뷰 — 의도하지 않은 변경 없는지`,
    "4. 기존 기능 회귀 체크 (홈 / 주요 페이지 load OK)",
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
  return `${goal.title || goal.description}\n\nTasks:\n${taskBullets}\n\nGenerated by Nova Orbit (Goal-as-Unit)`;
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
 * Detect task complexity aligned with Nova §1.
 * - simple: 1-2 files, single module
 * - moderate: 3-7 files, new feature
 * - complex: 8+ files, multi-module, or high-risk domain
 */
type Complexity = "simple" | "moderate" | "complex";

function detectComplexity(task: TaskRow): Complexity {
  const text = `${task.title} ${task.description}`.toLowerCase();

  // High-risk keywords force escalation (Nova §1: auth/DB/payment → one level up)
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
 * Used for moderate/complex tasks before implementation (Nova Orchestrator Phase 2).
 */
function buildArchitectPrompt(task: TaskRow, novaRules: ReturnType<typeof createNovaRulesEngine>): string {
  const orchestratorProtocol = novaRules.getOrchestratorProtocol();

  // Extract Phase 2 (Design) section from orchestrator protocol
  const phase2Match = orchestratorProtocol.match(/### Phase 2:[\s\S]*?(?=### Phase 3:|### --design-only)/);
  const designGuidance = phase2Match ? phase2Match[0].trim() : "";

  return `# Architecture Design — CPS Pattern

You are the Architect. Design ONLY, do NOT implement.

## ⚠️ CRITICAL: Read-Only Session
**Do NOT create, edit, or modify any files. Do NOT use the Write, Edit, or
NotebookEdit tools.** Respond with the design as text in your stdout
response only. Files created in this session pollute the project root and
break subsequent merge operations (Nova incident: stuck for 8h on merge
conflicts from an architect-created design doc).

You MAY use Read/Glob/Grep to understand the codebase, but absolutely no
writes. If you feel the need to produce a design document file, inline it
into your response instead.

## Task
"${task.title}"
${task.description}

## Design Guidance (from Nova Orchestrator)
${designGuidance || "Write a CPS design: Context → Problem → Solution"}

## Output
Produce a CPS design document with:
1. **Context**: Current project state, relevant files, tech stack
2. **Problem**: What exactly needs to change and why (MECE decomposition)
3. **Solution**: File structure, data flow, API boundaries, implementation order, build/verify commands

Keep the design concise (under 100 lines). Focus on what the implementer needs.
`;
}
