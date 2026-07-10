import { Router } from "express";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import type { AppContext } from "../../index.js";
import { artifactsDirForGoal } from "../../core/orchestration/work-report.js";
import { createLogger } from "../../utils/logger.js";
import { promptLanguageRule } from "../../utils/language.js";
import { parseAgentOutput } from "../../core/agent/adapters/stream-parser.js";
import { extractJsonArray } from "../../utils/llm-json.js";
import {
  squashMergeGoal,
  getDefaultBranch,
  detectDivergence,
  predictMergeConflict,
  mergeBaseIntoWorktree,
  verifyWorktreeSynced,
  type GitMode,
  type GitHubConfig,
} from "../../core/project/git-workflow.js";
import { runAcceptanceScript } from "../../core/orchestration/engine.js";
import { removeWorktree } from "../../core/project/worktree.js";
import { MAX_TITLE_LEN, MAX_DESC_LEN } from "../../utils/constants.js";
import type { GoalE2EActivityEvent, GoalE2EStatus, GoalE2EStatusResponse } from "../../../shared/types.js";

/** 아티팩트 서빙 경로 안전화: 화이트리스트 basename만, dir 밖 이탈 차단. 안전하면 절대경로, 아니면 null. */
export function resolveArtifactPath(dir: string, name: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const p = resolve(dir, name);
  if (p !== join(dir, basename(name)) || !p.startsWith(resolve(dir) + "/")) return null;
  return p;
}

const log = createLogger("goals");

/** 에이전트 해결 세션 상한 — 초과 시 세션 킬 + blocked (승인당 1회 시도) */
const SQUASH_RESOLVE_TIMEOUT_MS = 15 * 60_000;
const E2E_STATUS_ACTIVITY_LIMIT = 50;

type GoalE2EStatusGoalRow = {
  id: string;
  project_id: string;
  title: string;
  progress: number | null;
  goal_model: string | null;
  squash_status: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  _raw_prd: string | null;
};

type GoalE2EStatusTaskStats = {
  total: number;
  active: number | null;
  blocked: number | null;
};

function parseSpecStatus(rawPrd: string | null): string | null {
  if (!rawPrd) return null;
  try {
    const prd = JSON.parse(rawPrd);
    return typeof prd?._status === "string" ? prd._status : null;
  } catch {
    return null;
  }
}

function deriveGoalE2EStatus(
  goal: GoalE2EStatusGoalRow,
  taskStats: GoalE2EStatusTaskStats,
  specStatus: string | null,
): GoalE2EStatus {
  if (goal.squash_status === "merged") return "completed";
  if (goal.squash_status === "pending_approval") return "pending_approval";
  if (goal.squash_status === "blocked" || specStatus === "failed") return "failed";
  if ((taskStats.blocked ?? 0) > 0 && (taskStats.active ?? 0) === 0) return "failed";
  if (goal.goal_model !== "goal_as_unit" && (goal.progress ?? 0) >= 100) return "completed";
  return "running";
}

/** goal worktree에서 base merge 충돌을 의미 기반으로 해결시키는 프롬프트 (merge-all 검증 패턴의 squash 각색) */
function buildConflictResolutionPrompt(baseBranch: string, goalBranch: string): string {
  return `# Merge Conflict Resolution — goal 브랜치 동기화

현재 디렉토리는 goal 작업 공간(worktree)이며, 브랜치 \`${goalBranch}\`가 체크아웃되어 있다.
base 브랜치 \`${baseBranch}\`가 이 goal 분기 이후 전진해, merge 시 충돌이 예상된다.

## 작업 순서
1. \`git merge ${baseBranch}\` 실행
2. **충돌이 발생하면**: 양쪽 코드를 읽고 의미를 이해한 뒤 올바르게 해결하라. 두 변경사항의 의도를 모두 살리는 방향으로 합치되, 중복 선언·문법 오류가 없도록 주의.
3. 해결 후 \`git add\` + merge 커밋 완료 (메시지: \`chore(goal): sync with ${baseBranch} — 충돌 해결\`)
4. \`git status\`로 클린 상태 확인. 프로젝트에 타입체크/빌드 명령이 있으면 실행해 문법 무결성을 확인하고, 실패하면 고쳐서 커밋에 포함하라.

## 주의사항
- 절대 코드를 임의로 삭제하지 마라. 양쪽 변경사항을 모두 보존하라.
- \`${baseBranch}\` 브랜치를 checkout하거나 수정하지 마라 — 오직 현재 goal 브랜치에서만 작업.
- push 금지 (로컬 merge만).
- 이 작업 공간 밖의 파일을 건드리지 마라.`;
}

export function createGoalRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

  /**
   * squashMergeGoal 실행 + 상태/활동/브로드캐스트 일괄 처리.
   * 동기 승인 경로와 비동기 충돌 해결 경로가 공유한다 (HTTP 응답은 호출부 책임).
   */
  const performSquash = (
    goal: any,
    goalId: string,
    projectWorkdir: string,
    commitMessage: string,
    gitMode: GitMode,
    baseBranch?: string,
  ): { ok: boolean; sha?: string | null; prUrl?: string | null; error?: string } => {
    const mergeResult = squashMergeGoal(projectWorkdir, goal.worktree_branch, commitMessage, gitMode, baseBranch);

    if (mergeResult.error) {
      // nothing-to-commit도 실패다 — goal 브랜치에 반영할 커밋이 없다는 건
      // 작업물이 커밋되지 않았거나 소실됐다는 신호. 성공으로 위장하고 worktree를
      // 지우면 작업물이 파괴된다 (R2 E2E에서 merged|sha=NULL로 재현).
      db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goalId);
      const msg = mergeResult.error === "nothing-to-commit"
        ? "[goal-as-unit] Squash 차단: 반영할 커밋이 없음 — goal 브랜치가 비어 있습니다 (작업물 미커밋/소실 가능성, worktree 수동 확인 필요)"
        : `[goal-as-unit] Squash merge 실패: ${mergeResult.error?.slice(0, 300)}`;
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'git_error', ?)",
      ).run(goal.project_id, msg);
      broadcast("goal:squash_failed", { goalId, error: mergeResult.error });
      broadcast("project:updated", { projectId: goal.project_id });
      return { ok: false, error: mergeResult.error };
    }

    // merge는 성공했지만 알릴 것이 있으면 (예: 보존한 로컬 변경 복원 충돌) 활동으로 표면화
    if (mergeResult.warning) {
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'git_warning', ?)",
      ).run(goal.project_id, `[goal-as-unit] ${mergeResult.warning}`);
    }

    // 성공 처리 (goals 테이블에 status 컬럼 없음 — progress=100으로 완료 표현)
    db.prepare(`
      UPDATE goals
        SET squash_status = 'merged',
            squash_commit_sha = ?,
            progress = 100
        WHERE id = ?
    `).run(mergeResult.sha ?? null, goalId);

    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'goal_merged', ?)",
    ).run(goal.project_id, `[goal-as-unit] Goal squash merge 완료: ${goal.title?.slice(0, 80)} (sha=${mergeResult.sha ?? "none"})`);

    // worktree + branch 정리
    if (goal.worktree_path) {
      try {
        removeWorktree(projectWorkdir, goal.worktree_path, goal.worktree_branch);
        db.prepare("UPDATE goals SET worktree_path = NULL, worktree_branch = NULL WHERE id = ?").run(goalId);
      } catch (cleanupErr: any) {
        log.warn(`squash-approve: worktree cleanup failed: ${cleanupErr.message}`);
      }
    }

    broadcast("goal:merged", { goalId, sha: mergeResult.sha, prUrl: mergeResult.prUrl });
    broadcast("project:updated", { projectId: goal.project_id });
    return { ok: true, sha: mergeResult.sha, prUrl: mergeResult.prUrl };
  };

  /**
   * 비동기 충돌 해결 → 검증 → acceptance → squash.
   * 승인 응답은 이미 나갔다 — 진행/결과는 전부 WS 브로드캐스트로 통지.
   * 해결은 goal worktree 안에서만 일어난다 (사용자 base 브랜치 불가침).
   */
  const resolveConflictThenSquash = async (args: {
    goal: any;
    goalId: string;
    projectWorkdir: string;
    baseBranch: string;
    commitMessage: string;
    gitMode: GitMode;
  }): Promise<void> => {
    const { goal, goalId, projectWorkdir, baseBranch, commitMessage, gitMode } = args;
    const worktreePath = goal.worktree_path as string;
    const sessionKey = `squash-resolve:${goalId}`;

    const fail = (reason: string, restoreSha?: string | null) => {
      if (restoreSha) {
        // goal worktree 한정 복원 — 미완성 해결 시도를 걷어낸다 (사용자 base 아님)
        spawnSync("git", ["merge", "--abort"], { cwd: worktreePath, stdio: "pipe", timeout: 15_000 });
        spawnSync("git", ["reset", "--hard", restoreSha], { cwd: worktreePath, stdio: "pipe", timeout: 15_000 });
      }
      db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goalId);
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'git_error', ?)",
      ).run(goal.project_id, `[goal-as-unit] 변경 겹침 해결 실패: ${reason.slice(0, 300)}`);
      broadcast("goal:squash_blocked", { goalId, reason });
      broadcast("project:updated", { projectId: goal.project_id });
      log.warn(`squash-resolve failed for goal ${goalId}: ${reason}`);
    };

    const sm = ctx.sessionManager;
    if (!sm) return fail("sessionManager 미초기화");

    // 해결 담당: CTO 우선, idle 우선 (merge-all과 동일 정책)
    const agents = db.prepare(
      "SELECT id, name, role, status FROM agents WHERE project_id = ? ORDER BY CASE role WHEN 'cto' THEN 0 WHEN 'backend' THEN 1 WHEN 'frontend' THEN 2 WHEN 'coder' THEN 3 ELSE 9 END",
    ).all(goal.project_id) as any[];
    const agent = agents.find((a) => a.status === "idle") ?? agents.find((a) => a.status !== "working");
    if (!agent) return fail("가용 에이전트 없음 — 모든 에이전트가 작업 중입니다. 잠시 후 재시도하세요");

    let preSyncSha: string | null = null;
    const shaResult = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath, stdio: "pipe", timeout: 10_000, encoding: "utf-8",
    });
    if (shaResult.status === 0) preSyncSha = shaResult.stdout.trim();

    db.prepare("UPDATE agents SET status = 'working', current_activity = ? WHERE id = ?")
      .run(`merge:${(goal.title ?? "").slice(0, 80)}`, agent.id);
    broadcast("agent:status", { id: agent.id, name: agent.name, status: "working" });

    try {
      let session;
      try {
        session = sm.spawnAgent(agent.id, worktreePath, sessionKey);
        session.on("output", (text: string) => {
          broadcast("agent:output", { agentId: agent.id, output: text });
        });
        await Promise.race([
          session.send(buildConflictResolutionPrompt(baseBranch, goal.worktree_branch)),
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`해결 세션 타임아웃 (${SQUASH_RESOLVE_TIMEOUT_MS / 60_000}분)`)),
              SQUASH_RESOLVE_TIMEOUT_MS,
            );
            (timer as any).unref?.();
          }),
        ]);
      } catch (err: any) {
        return fail(`에이전트 세션 실패: ${err?.message ?? String(err)}`, preSyncSha);
      } finally {
        try { sm.killSession(sessionKey); } catch { /* already dead */ }
      }

      // 기계 검증 — LLM 자기보고를 믿지 않는다
      const verify = verifyWorktreeSynced(projectWorkdir, baseBranch, goal.worktree_branch, worktreePath);
      if (!verify.ok) return fail(`해결 검증 실패: ${verify.reason}`, preSyncSha);

      // acceptance 재실행 — 해결이 코드를 바꿨으므로 기계 안전망 (사용자 재승인은 없음: 인터뷰 결정)
      if (goal.acceptance_script) {
        const acc = runAcceptanceScript(worktreePath, goal.acceptance_script);
        if (!acc.passed) {
          // 해결 산출물은 보존 (복원하지 않음) — 사유만 표면화하고 blocked
          return fail(`변경 겹침 해결 후 검증 스크립트 실패: ${acc.output.slice(0, 300)}`);
        }
      }

      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'goal_squash_resolved', ?)",
      ).run(goal.project_id, `[goal-as-unit] 변경 겹침 해결 완료 (${agent.name}) — 반영 진행: ${(goal.title ?? "").slice(0, 80)}`);

      performSquash(goal, goalId, projectWorkdir, commitMessage, gitMode, baseBranch);
    } catch (err: any) {
      fail(err?.message ?? String(err), preSyncSha);
    } finally {
      db.prepare("UPDATE agents SET status = 'idle', current_activity = NULL WHERE id = ?").run(agent.id);
      broadcast("agent:status", { id: agent.id, name: agent.name, status: "idle" });
    }
  };

  // List goals by project
  router.get("/", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    if (!projectId) return res.status(400).json({ error: "projectId query param required" });

    const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 200;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

    const goals = db.prepare(
      `SELECT g.*,
        CASE WHEN gs.id IS NOT NULL THEN 1 ELSE 0 END AS has_spec,
        gs.prd_summary AS _raw_prd
       FROM goals g LEFT JOIN goal_specs gs ON g.id = gs.goal_id
       WHERE g.project_id = ? ORDER BY g.priority, g.created_at LIMIT ?`,
    ).all(projectId, limit) as any[];
    // Derive spec_status from prd_summary JSON
    res.json(goals.map((g) => {
      let spec_status: string | null = null;
      if (g._raw_prd) {
        try {
          const prd = JSON.parse(g._raw_prd);
          if (prd._status) spec_status = prd._status; // "generating" | "failed"
        } catch { /* not JSON */ }
      }
      const { _raw_prd, ...rest } = g;
      return { ...rest, spec_status };
    }));
  });

  // E2E status contract for automation: one stable goal-level shape.
  router.get("/:goalId/status", (req, res) => {
    const goal = db.prepare(`
      SELECT g.*, gs.prd_summary AS _raw_prd
      FROM goals g
      LEFT JOIN goal_specs gs ON g.id = gs.goal_id
      WHERE g.id = ?
    `).get(req.params.goalId) as GoalE2EStatusGoalRow | undefined;
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    const taskStats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('todo', 'pending_approval', 'in_progress', 'in_review') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
      FROM tasks
      WHERE goal_id = ? AND parent_task_id IS NULL
    `).get(goal.id) as GoalE2EStatusTaskStats;

    const evaluator = db.prepare(`
      SELECT v.evaluator_session_id
      FROM verifications v
      JOIN tasks t ON t.id = v.task_id
      WHERE t.goal_id = ?
      ORDER BY v.created_at DESC, v.rowid DESC
      LIMIT 1
    `).get(goal.id) as { evaluator_session_id: string | null } | undefined;

    const status = deriveGoalE2EStatus(goal, taskStats, parseSpecStatus(goal._raw_prd));
    const failedGoalCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM goals
      WHERE project_id = ? AND squash_status = 'blocked'
    `).get(goal.project_id) as { count: number };
    const titleNeedle = goal.title.slice(0, 80);

    // activity_events must stay goal-scoped. Prefer explicit metadata links:
    // goalId for goal-level events, taskId/sourceTaskId for task-level events.
    // Older squash/merge failure rows were written without metadata; include only
    // those narrow failure event types when the requested goal is failed and the
    // project has a single blocked goal, or when the message names this goal.
    const activityRows = db.prepare(`
      SELECT type, message, created_at
      FROM (
        SELECT a.id AS id, a.type AS type, a.message AS message, a.created_at AS created_at
        FROM activities a
        WHERE a.project_id = ?
          AND (
            json_extract(a.metadata, '$.goalId') = ?
            OR EXISTS (
              SELECT 1 FROM tasks t
              WHERE t.goal_id = ?
                AND t.id IN (
                  json_extract(a.metadata, '$.taskId'),
                  json_extract(a.metadata, '$.sourceTaskId')
                )
            )
            OR (
              ? = 1
              AND a.metadata IS NULL
              AND a.type IN ('goal_squash_blocked', 'git_error')
              AND (
                ? = 1
                OR (? <> '' AND instr(a.message, ?) > 0)
              )
            )
          )
        ORDER BY a.id DESC
        LIMIT ?
      )
      ORDER BY id ASC
    `).all(
      goal.project_id,
      goal.id,
      goal.id,
      status === "failed" ? 1 : 0,
      failedGoalCount.count === 1 ? 1 : 0,
      titleNeedle,
      titleNeedle,
      E2E_STATUS_ACTIVITY_LIMIT,
    ) as GoalE2EActivityEvent[];

    const response: GoalE2EStatusResponse = {
      goal_id: goal.id,
      status,
      worktree_path: goal.worktree_path || null,
      worktree_branch: goal.worktree_branch || null,
      evaluator_session_id: evaluator?.evaluator_session_id || null,
      approval_required: status === "pending_approval",
      activity_events: activityRows.map((event) => ({
        type: String(event.type ?? ""),
        message: String(event.message ?? ""),
        created_at: String(event.created_at ?? ""),
      })),
    };

    res.json(response);
  });

  // Create goal — triggers autopilot if enabled
  router.post("/", (req, res) => {
    const { project_id, title, description, priority = "medium", references, skip_adversarial, acceptance_script, source_material } = req.body;
    // Input validation: type + length (prevents oversized payloads DoS)
    if (typeof project_id !== "string" || project_id.length === 0) {
      return res.status(400).json({ error: "project_id (string) is required" });
    }
    if (title != null && typeof title !== "string") {
      return res.status(400).json({ error: "title must be a string" });
    }
    if (description != null && typeof description !== "string") {
      return res.status(400).json({ error: "description must be a string" });
    }
    if (acceptance_script != null && typeof acceptance_script !== "string") {
      return res.status(400).json({ error: "acceptance_script must be a string" });
    }
    // Support both: title+description (new) and description-only (legacy)
    const goalTitle = (title ?? "").slice(0, MAX_TITLE_LEN);
    const goalDescription = (description ?? "").slice(0, MAX_DESC_LEN);
    const goalRefs = Array.isArray(references) ? JSON.stringify(references.slice(0, 20)) : "[]";
    if (!goalTitle && !goalDescription) {
      return res.status(400).json({ error: "title or description is required" });
    }

    const VALID_PRIORITIES = ["critical", "high", "medium", "low"];
    if (!VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(", ")}` });
    }

    try {
      // Assign sort_order at end of existing goals so new entries don't
      // collide with (and jump above) existing ones in scheduler ordering.
      const sortOrder = (db.prepare(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM goals WHERE project_id = ?",
      ).get(project_id) as { next: number }).next;

      const skipAdversarialVal = typeof skip_adversarial === "boolean" ? (skip_adversarial ? 1 : 0) : 0;
      const acceptanceVal = typeof acceptance_script === "string" ? (acceptance_script.trim().slice(0, 500) || null) : null;
      // 사용자 원본 자료(MD) — 기획서 생성 근거. 과대 payload 방지로 상한.
      const sourceMaterialVal = typeof source_material === "string" ? (source_material.slice(0, 20000) || null) : null;

      const result = db.prepare(
        "INSERT INTO goals (project_id, title, description, priority, \"references\", sort_order, skip_adversarial, acceptance_script, source_material) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(project_id, goalTitle, goalDescription, priority, goalRefs, sortOrder, skipAdversarialVal, acceptanceVal, sourceMaterialVal);

      const goal = db.prepare("SELECT * FROM goals WHERE rowid = ?").get(result.lastInsertRowid) as any;
      broadcast("project:updated", { projectId: project_id });

      // Check autopilot BEFORE responding so client knows whether to skip its own spec call
      const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(project_id) as { autopilot: string } | undefined;
      const autopilotActive = !!(project && (project.autopilot === "goal" || project.autopilot === "full"));

      res.status(201).json({ ...goal, autopilotHandled: autopilotActive });

      // --- Autopilot trigger (async, after response) ---
      // In autopilot mode: ALWAYS delegate to scheduler regardless of withSpec.
      // The scheduler handles spec→decompose sequentially in priority/sort_order.
      // This prevents parallel spec generation when multiple goals are added at once.
      if (autopilotActive && ctx.scheduler) {
        log.info(`Autopilot: goal ${goal.id} added, notifying scheduler for sequential processing`);
        ctx.scheduler.notifyGoalReady(project_id);
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Update goal progress
  router.patch("/:id", (req, res) => {
    const { title, description, priority, progress, references, acceptance_script } = req.body;
    // Input type validation
    if (title != null && typeof title !== "string") {
      return res.status(400).json({ error: "title must be a string" });
    }
    if (description != null && typeof description !== "string") {
      return res.status(400).json({ error: "description must be a string" });
    }
    if (acceptance_script != null && typeof acceptance_script !== "string") {
      return res.status(400).json({ error: "acceptance_script must be a string" });
    }
    if (progress != null && (typeof progress !== "number" || progress < 0 || progress > 100)) {
      return res.status(400).json({ error: "progress must be a number 0..100" });
    }

    const refsJson = Array.isArray(references) ? JSON.stringify(references.slice(0, 20)) : null;
    const boundedTitle = typeof title === "string" ? title.slice(0, MAX_TITLE_LEN) : null;
    const boundedDesc = typeof description === "string" ? description.slice(0, MAX_DESC_LEN) : null;

    // Transactional update — existence check + UPDATE atomically, prevents
    // race with concurrent DELETE wiping the row between SELECT and UPDATE.
    const update = db.transaction(() => {
      const existing = db.prepare("SELECT id FROM goals WHERE id = ?").get(req.params.id) as { id: string } | undefined;
      if (!existing) return null;
      db.prepare(`
        UPDATE goals SET
          title = COALESCE(?, title),
          description = COALESCE(?, description),
          priority = COALESCE(?, priority),
          progress = COALESCE(?, progress),
          "references" = COALESCE(?, "references")
        WHERE id = ?
      `).run(boundedTitle, boundedDesc, priority ?? null, progress ?? null, refsJson, req.params.id);
      // acceptance_script: 빈 문자열 = 제거 의도이므로 COALESCE 대신 명시 갱신
      if (typeof acceptance_script === "string") {
        db.prepare("UPDATE goals SET acceptance_script = ? WHERE id = ?")
          .run(acceptance_script.trim().slice(0, 500) || null, req.params.id);
      }
      return db.prepare("SELECT * FROM goals WHERE id = ?").get(req.params.id);
    });

    try {
      const updated = update();
      if (!updated) return res.status(404).json({ error: "Goal not found" });
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Delete goal — kill sessions for in-progress tasks before CASCADE delete
  router.delete("/:id", (req, res) => {
    const goalId = req.params.id;
    // Collect info atomically before delete to hand off session cleanup
    type DeleteInfo = { projectId: string; assigneeIds: string[] } | null;
    const deleteInfo = db.transaction((): DeleteInfo => {
      const goal = db.prepare("SELECT project_id FROM goals WHERE id = ?").get(goalId) as { project_id: string } | undefined;
      if (!goal) return null;
      const activeTasks = db.prepare(
        "SELECT assignee_id FROM tasks WHERE goal_id = ? AND status IN ('in_progress', 'in_review') AND assignee_id IS NOT NULL",
      ).all(goalId) as { assignee_id: string }[];
      db.prepare("DELETE FROM goals WHERE id = ?").run(goalId);
      return { projectId: goal.project_id, assigneeIds: activeTasks.map((t) => t.assignee_id) };
    })();

    if (!deleteInfo) return res.status(404).json({ error: "Goal not found" });
    // Kill sessions after commit — side-effects must not run inside the txn
    for (const assigneeId of deleteInfo.assigneeIds) {
      try { ctx.sessionManager?.killSession(assigneeId); } catch { /* ignore */ }
    }
    // Also kill any spec-generation or decompose session for this goal
    try { ctx.sessionManager?.killSession(`spec-${goalId}`); } catch { /* ignore */ }
    try { ctx.sessionManager?.killSession(`decompose-${goalId}`); } catch { /* ignore */ }
    broadcast("project:updated", { projectId: deleteInfo.projectId });
    res.json({ success: true });
  });

  // ─── AI Goal Suggestion ─────────────────────────────────

  // Suggest goals using AI — synchronous (waits for response)
  router.post("/suggest", async (req, res) => {
    // Extend timeout for AI response (up to 5 min)
    req.setTimeout(300000);
    res.setTimeout(300000);
    const { project_id, count: rawCount, language, sourceMaterial } = req.body;
    if (!project_id) return res.status(400).json({ error: "project_id required" });
    const count = Math.max(1, Math.min(10, Number(rawCount) || 3));
    // 사용자가 붙여넣은 원본 자료(MD) — 있으면 이걸 1차 근거로 목표를 "분해"한다.
    const material = typeof sourceMaterial === "string" ? sourceMaterial.slice(0, 20000).trim() : "";

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(project_id) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    // Find CTO or PM or first agent
    const agent = (db.prepare(
      "SELECT * FROM agents WHERE project_id = ? AND role IN ('cto', 'pm') LIMIT 1",
    ).get(project_id) as any)
      ?? (db.prepare(
        "SELECT * FROM agents WHERE project_id = ? LIMIT 1",
      ).get(project_id) as any);

    if (!agent) return res.status(400).json({ error: "No agents available — add agents first" });

    const techStack = project.tech_stack ? JSON.parse(project.tech_stack) : null;
    const techInfo = techStack
      ? `\nTech Stack: ${techStack.languages?.join(", ")} / ${techStack.frameworks?.join(", ")}`
      : "";

    // Existing goals for context
    const existingGoals = db.prepare("SELECT title, description, progress FROM goals WHERE project_id = ?").all(project_id) as any[];
    const goalStatusLabel = (p: number) => (p >= 100 ? "done" : p > 0 ? "in-progress" : "todo");
    const existingContext = existingGoals.length > 0
      ? `\n\nExisting goals (avoid duplicates):\n${existingGoals.map((g: any) => `- [${goalStatusLabel(g.progress ?? 0)}] ${g.title}: ${g.description || ""}`).join("\n")}`
      : "";

    // Load project docs for context
    let docsContext = "";
    if (project.workdir) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      for (const docFile of ["CLAUDE.md", "README.md"]) {
        const p = path.join(project.workdir, docFile);
        try {
          if (fs.existsSync(p)) {
            docsContext += `\n\n[${docFile}]\n${fs.readFileSync(p, "utf-8").slice(0, 2000)}`;
            break; // One file is enough for suggestion context
          }
        } catch { /* skip */ }
      }
    }

    const materialContext = material
      ? `\n\nSOURCE MATERIAL (the user's prepared document — the PRIMARY basis for the goals):\n"""\n${material}\n"""`
      : "";
    const taskLine = material
      ? `Analyze the SOURCE MATERIAL below and decompose it into the natural set of actionable goals it implies — as many as the document genuinely contains (typically 1 to ${count}). Do NOT pad to reach a number; if it describes a single deliverable, return exactly 1.`
      : `Analyze this project and suggest exactly ${count} actionable goals.`;
    const focusRules = material
      ? `- Ground every goal strictly in the SOURCE MATERIAL — titles/descriptions must reflect what the document actually asks for, not generic best practices\n- Split by the document's own natural units (features / sections / milestones); preserve its intent and terminology`
      : `- Focus on what would deliver the most value for this specific project\n- Consider the existing goals and suggest complementary ones`;

    const prompt = `You are a senior product strategist. ${taskLine}

Project: ${project.name}
Mission: ${project.mission || "(not set)"}${techInfo}${existingContext}${docsContext}${materialContext}

Respond in this EXACT JSON format (no markdown, just raw JSON):
[
  {
    "title": "Short goal title (under 60 chars)",
    "description": "2-3 sentence description with context and success criteria",
    "priority": "high|medium|low",
    "reason": "Why this goal matters now (1 sentence)"
  }
]

Rules:
- Each goal should be concrete and actionable, not vague
${focusRules}
- ${promptLanguageRule(language, "Respond in the same language as the project mission/name (Korean if Korean, English if English)")}`;

    try {
      if (!ctx.sessionManager) {
        return res.status(503).json({ error: "Session manager not ready" });
      }
      const suggestKey = `suggest-${project_id}-${Date.now()}`;
      const session = ctx.sessionManager.spawnAgent(agent.id, project.workdir || process.cwd(), suggestKey);
      try {
        const result = await session.send(prompt);

        // Check CLI exit code
        if (result.exitCode !== 0 && result.stdout.trim() === "") {
          const hint = result.stderr.slice(0, 300);
          throw new Error(`Claude Code CLI failed (exit ${result.exitCode}): ${hint}`);
        }

        const parsed = parseAgentOutput(result.stdout, result.provider);
        const raw = parsed.text || "";

        if (!raw.trim()) {
          throw new Error("Goal suggestion produced no text output");
        }

        // Parse JSON from response — 모델이 산문(대괄호 평문 포함)을 반환해도
        // greedy 정규식처럼 크래시하지 않고 깨끗한 에러로 degrade한다.
        const suggestions = extractJsonArray(raw);
        if (!suggestions) {
          throw new Error("Goal suggestion did not return a valid JSON array");
        }

        res.json(suggestions.slice(0, count).map((s: any) => ({
          title: String(s.title || "").slice(0, 100),
          description: String(s.description || "").slice(0, 500),
          priority: ["high", "medium", "low"].includes(s.priority) ? s.priority : "medium",
          reason: String(s.reason || "").slice(0, 200),
        })));
      } finally {
        ctx.sessionManager.killSession(suggestKey);
      }
    } catch (err: any) {
      log.error("Failed to suggest goals", err);
      res.status(500).json({ error: err.message || "Goal suggestion failed", detail: String(err.stack || "").slice(0, 500) });
    }
  });

  // ─── Goal Spec endpoints ───────────────────────────────

  // Get spec for a goal
  router.get("/:id/spec", (req, res) => {
    const spec = db.prepare("SELECT * FROM goal_specs WHERE goal_id = ?").get(req.params.id) as any;
    if (!spec) return res.status(404).json({ error: "Spec not found for this goal" });
    res.json({
      id: spec.id,
      goal_id: spec.goal_id,
      prd_summary: JSON.parse(spec.prd_summary || "{}"),
      feature_specs: JSON.parse(spec.feature_specs || "[]"),
      user_flow: JSON.parse(spec.user_flow || "[]"),
      acceptance_criteria: JSON.parse(spec.acceptance_criteria || "[]"),
      tech_considerations: JSON.parse(spec.tech_considerations || "[]"),
      generated_by: spec.generated_by,
      version: spec.version,
      created_at: spec.created_at,
      updated_at: spec.updated_at,
    });
  });

  // Update spec manually
  router.patch("/:id/spec", (req, res) => {
    const goalId = req.params.id;
    const existing = db.prepare("SELECT * FROM goal_specs WHERE goal_id = ?").get(goalId) as any;
    if (!existing) return res.status(404).json({ error: "Spec not found" });

    const { prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations } = req.body;

    try {
      db.prepare(`
        UPDATE goal_specs SET
          prd_summary = COALESCE(?, prd_summary),
          feature_specs = COALESCE(?, feature_specs),
          user_flow = COALESCE(?, user_flow),
          acceptance_criteria = COALESCE(?, acceptance_criteria),
          tech_considerations = COALESCE(?, tech_considerations),
          generated_by = 'manual',
          version = version + 1,
          updated_at = datetime('now')
        WHERE goal_id = ?
      `).run(
        prd_summary ? JSON.stringify(prd_summary) : null,
        feature_specs ? JSON.stringify(feature_specs) : null,
        user_flow ? JSON.stringify(user_flow) : null,
        acceptance_criteria ? JSON.stringify(acceptance_criteria) : null,
        tech_considerations ? JSON.stringify(tech_considerations) : null,
        goalId,
      );

      const updated = db.prepare("SELECT * FROM goal_specs WHERE goal_id = ?").get(goalId) as any;
      res.json({
        ...updated,
        prd_summary: JSON.parse(updated.prd_summary),
        feature_specs: JSON.parse(updated.feature_specs),
        user_flow: JSON.parse(updated.user_flow),
        acceptance_criteria: JSON.parse(updated.acceptance_criteria),
        tech_considerations: JSON.parse(updated.tech_considerations),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Generate spec using AI — fire-and-forget pattern
  // Returns 202 immediately, generation continues in background.
  // Client polls GET /goals/:id/spec for result.
  router.post("/:id/generate-spec", (req, res) => {
    const goalId = req.params.id;
    const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as any;
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    if (!ctx.generateGoalSpec) {
      return res.status(503).json({ error: "Orchestration engine not ready" });
    }

    // Mark as generating (client can check this)
    const existing = db.prepare("SELECT id FROM goal_specs WHERE goal_id = ?").get(goalId) as any;
    if (!existing) {
      db.prepare(
        "INSERT INTO goal_specs (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by) VALUES (?, '{\"_status\":\"generating\"}', '[]', '[]', '[]', '[]', 'ai')"
      ).run(goalId);
    } else {
      db.prepare("UPDATE goal_specs SET prd_summary = '{\"_status\":\"generating\"}', updated_at = datetime('now') WHERE goal_id = ?").run(goalId);
    }

    // Return immediately
    res.status(202).json({ status: "generating", goalId });

    // Background generation
    ctx.generateGoalSpec(goalId).then(() => {
      log.info(`Spec generated for goal ${goalId}`);
      broadcast("project:updated", { projectId: goal.project_id });

      // Spec complete → notify scheduler so it can decompose in priority order.
      // Previously called triggerAutopilotDecompose directly, which bypassed
      // the scheduler's sequential lock and caused parallel decompose races.
      if (ctx.scheduler) {
        const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(goal.project_id) as { autopilot: string } | undefined;
        if (project && (project.autopilot === "goal" || project.autopilot === "full")) {
          ctx.scheduler.notifyGoalReady(goal.project_id);
        }
      }
    }).catch((err: any) => {
      log.error(`Failed to generate spec for goal ${goalId}`, err);
      // Store failure status as proper JSON (avoid SQL string concat which breaks on quotes)
      const errorMsg = (err.message || "Unknown error").slice(0, 200).replace(/"/g, "'");
      const failedJson = JSON.stringify({ _status: "failed", _error: errorMsg });
      db.prepare("UPDATE goal_specs SET prd_summary = ?, updated_at = datetime('now') WHERE goal_id = ?")
        .run(failedJson, goalId);
      broadcast("project:updated", { projectId: goal.project_id });
    });
  });

  // AI Refine — user sends a custom prompt to modify existing spec
  router.post("/:id/refine-spec", async (req, res) => {
    const goalId = req.params.id;
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required" });
    }

    const specRow = db.prepare("SELECT * FROM goal_specs WHERE goal_id = ?").get(goalId) as any;
    if (!specRow) return res.status(404).json({ error: "No spec to refine — generate one first" });

    const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as any;
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    if (!ctx.generateGoalSpec) {
      return res.status(503).json({ error: "Orchestration engine not ready" });
    }

    // Use the refine function (registered from orchestration routes)
    if (!(ctx as any).refineGoalSpec) {
      return res.status(503).json({ error: "Refine not available" });
    }

    try {
      const result = await (ctx as any).refineGoalSpec(goalId, prompt);
      res.json(result);
    } catch (err: any) {
      log.error(`Failed to refine spec for goal ${goalId}`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Goal-as-Unit: Squash Approve / Cancel ─────────────

  // POST /goals/:goalId/squash-approve — squash merge 승인
  // 승인 다이얼로그 프리뷰 재조회 — squash_ready WS 페이로드를 놓친 경우(페이지
  // 리로드 등)에도 사용자가 무엇을 반영하는지 보고 확정할 수 있어야 한다.
  router.get("/:goalId/squash-preview", (req, res) => {
    const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(req.params.goalId) as any;
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    if (goal.goal_model !== "goal_as_unit") {
      return res.status(400).json({ error: "This goal does not use the Goal-as-Unit model" });
    }

    const doneTasks = db.prepare(
      "SELECT title FROM tasks WHERE goal_id = ? AND status = 'done' AND parent_task_id IS NULL ORDER BY sort_order ASC",
    ).all(goal.id) as { title: string }[];
    const taskBullets = doneTasks.map((t) => `- ${t.title}`).join("\n");
    const commitMessage = `${goal.title || goal.description}\n\nTasks:\n${taskBullets}\n\nGenerated by Crewdeck (Goal-as-Unit)`;

    let filesChanged: string[] = [];
    if (goal.worktree_path && existsSync(goal.worktree_path)) {
      const project = db.prepare("SELECT base_branch FROM projects WHERE id = ?").get(goal.project_id) as { base_branch?: string } | undefined;
      const baseBranch = project?.base_branch || "main";
      const runGit = (args: string[]): string[] => {
        try {
          const r = spawnSync("git", args, { cwd: goal.worktree_path, stdio: "pipe", timeout: 10_000, encoding: "utf-8" });
          return r.status === 0 ? r.stdout.split("\n").map((s: string) => s.trim()).filter(Boolean) : [];
        } catch {
          return [];
        }
      };
      const seen = new Set<string>([
        ...runGit(["diff", "--name-only", `${baseBranch}...HEAD`]), // 커밋된 변경
        ...runGit(["diff", "--name-only", "HEAD"]),                 // 미커밋 변경 (WIP)
        ...runGit(["ls-files", "--others", "--exclude-standard"]),  // untracked
      ]);
      filesChanged = Array.from(seen);
    }

    let workReport = null;
    try { workReport = goal.work_report ? JSON.parse(goal.work_report) : null; } catch { workReport = null; }

    res.json({
      goalId: goal.id,
      squashStatus: goal.squash_status,
      commitMessage,
      filesChanged,
      acceptanceScript: goal.acceptance_script ?? null,
      workReport,
    });
  });

  // 작업 요약 스크린샷 아티팩트 서빙 — /api 마운트라 Bearer 보호됨 (index.ts authMiddleware)
  router.get("/:goalId/artifacts/:name", (req, res) => {
    if (!/^[A-Za-z0-9_-]+$/.test(req.params.goalId)) return res.status(404).json({ error: "Not found" });
    const dir = artifactsDirForGoal(db, req.params.goalId);
    const filePath = resolveArtifactPath(dir, req.params.name);
    if (!filePath || !existsSync(filePath)) return res.status(404).json({ error: "Not found" });
    res.sendFile(filePath);
  });

  router.post("/:goalId/squash-approve", (req, res) => {
    const { goalId } = req.params;
    const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as any;
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    if (goal.goal_model !== "goal_as_unit") {
      return res.status(400).json({ error: "This goal does not use the Goal-as-Unit model" });
    }
    // blocked 도 허용 — squash 실패 후 "재시도"는 승인 재실행과 동일한 경로다
    if (!["pending_approval", "blocked"].includes(goal.squash_status)) {
      return res.status(400).json({ error: `Cannot approve — current squash_status is '${goal.squash_status}'` });
    }

    // squash_status = 'approved' 로 전환
    db.prepare("UPDATE goals SET squash_status = 'approved' WHERE id = ?").run(goalId);

    // 커밋 메시지 자동 생성
    const doneTasks = db.prepare(
      "SELECT title FROM tasks WHERE goal_id = ? AND status = 'done' AND parent_task_id IS NULL ORDER BY sort_order ASC",
    ).all(goalId) as { title: string }[];
    const taskBullets = doneTasks.map((t: { title: string }) => `- ${t.title}`).join("\n");
    const commitMessage = `${goal.title || goal.description}\n\nTasks:\n${taskBullets}\n\nGenerated by Crewdeck (Goal-as-Unit)`;

    // git mode 결정
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(goal.project_id) as any;
    let gitMode: GitMode = "local_only";
    if (project?.github_config) {
      try {
        const ghConfig = JSON.parse(project.github_config) as GitHubConfig;
        if (ghConfig.gitMode) {
          gitMode = ghConfig.gitMode;
        } else if (ghConfig.prMode) {
          gitMode = "pr";
        } else if (ghConfig.autoPush) {
          gitMode = "main_direct";
        }
      } catch { /* ignore */ }
    }

    // worktree_path 존재 확인
    const projectWorkdir = project?.workdir;
    if (!projectWorkdir) {
      db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goalId);
      return res.status(400).json({ error: "Project has no workdir configured" });
    }
    if (!goal.worktree_branch) {
      db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goalId);
      return res.status(400).json({ error: "Goal has no worktree_branch — cannot squash merge" });
    }

    const projectBaseBranch = (db.prepare("SELECT base_branch FROM projects WHERE id = ?").get(goal.project_id) as { base_branch: string | null } | undefined)?.base_branch ?? undefined;
    const baseBranch = projectBaseBranch ?? (() => {
      try { return getDefaultBranch(projectWorkdir); } catch { return "main"; }
    })();

    // ── integration-time 사전 동기화 (spec: .omc/specs/deep-dive-goal-squash-conflict-parallel.md) ──
    // goal 브랜치는 생성 시점 base에 고정된다. base가 전진(다른 goal 반영·사용자
    // 직접 커밋)했으면 squash 전에 base를 goal worktree로 merge-in한다. 충돌이
    // 예측되면 에이전트가 worktree 안에서 의미 기반으로 해결한 뒤 squash한다.
    const worktreeUsable = !!goal.worktree_path && existsSync(goal.worktree_path);
    if (worktreeUsable && detectDivergence(projectWorkdir, baseBranch, goal.worktree_branch)) {
      let needsAgent = predictMergeConflict(projectWorkdir, baseBranch, goal.worktree_branch);
      if (!needsAgent) {
        const sync = mergeBaseIntoWorktree(goal.worktree_path, baseBranch);
        if (sync.merged) {
          db.prepare(
            "INSERT INTO activities (project_id, type, message) VALUES (?, 'goal_squash_synced', ?)",
          ).run(goal.project_id, `[goal-as-unit] ${baseBranch} 전진분을 goal에 자동 동기화 (겹침 없음): ${(goal.title ?? "").slice(0, 80)}`);
        } else {
          needsAgent = true; // 예측과 달리 클린 merge 실패 — 에이전트 해결로 전환
        }
      }
      if (needsAgent) {
        db.prepare("UPDATE goals SET squash_status = 'resolving' WHERE id = ?").run(goalId);
        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'goal_squash_resolving', ?)",
        ).run(goal.project_id, `[goal-as-unit] ${baseBranch} 전진과 변경 겹침 감지 — 에이전트가 goal 작업 공간에서 해결 시작: ${(goal.title ?? "").slice(0, 80)}`);
        broadcast("goal:squash_resolving", { goalId, projectId: goal.project_id });
        broadcast("project:updated", { projectId: goal.project_id });
        // 해결은 수 분 걸릴 수 있다 — 응답은 즉시, 결과는 WS(goal:merged/squash_blocked)로 통지
        res.json({ success: true, resolving: true });
        void resolveConflictThenSquash({ goal, goalId, projectWorkdir, baseBranch, commitMessage, gitMode });
        return;
      }
    }

    const outcome = performSquash(goal, goalId, projectWorkdir, commitMessage, gitMode, baseBranch);
    if (!outcome.ok) {
      return res.status(500).json({ success: false, error: outcome.error });
    }
    return res.json({ success: true, sha: outcome.sha ?? undefined, prUrl: outcome.prUrl ?? undefined });
  });

  // POST /goals/:goalId/squash-cancel — squash_status 복귀 (optional)
  router.post("/:goalId/squash-cancel", (req, res) => {
    const { goalId } = req.params;
    const goal = db.prepare("SELECT id, goal_model, squash_status, project_id FROM goals WHERE id = ?").get(goalId) as any;
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    if (goal.goal_model !== "goal_as_unit") {
      return res.status(400).json({ error: "This goal does not use the Goal-as-Unit model" });
    }
    if (!["pending_approval", "blocked"].includes(goal.squash_status)) {
      return res.status(400).json({ error: `Cannot cancel — current squash_status is '${goal.squash_status}'` });
    }

    db.prepare("UPDATE goals SET squash_status = 'none' WHERE id = ?").run(goalId);
    broadcast("project:updated", { projectId: goal.project_id });
    return res.json({ success: true });
  });

  return router;
}
