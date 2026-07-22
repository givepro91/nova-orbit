import { Router, type Response } from "express";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import type { AppContext } from "../../index.js";
import { artifactsDirForGoal, buildGoalCommitMessage, removeGoalArtifacts } from "../../core/orchestration/work-report.js";
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
  recoverSquashCommitEvidence,
  worktreeHasUncommittedChanges,
  verifyWorktreeSynced,
  refreshPrState,
  resolveGitHubToken,
  type GitMode,
  type GitHubConfig,
} from "../../core/project/git-workflow.js";
import { runAcceptanceScript, reconcileMergedGoalTasks } from "../../core/orchestration/engine.js";
import { removeWorktree, dropCheckpoint } from "../../core/project/worktree.js";
import { archiveGoalWorkspace } from "../../core/project/workspace.js";
import { MAX_TITLE_LEN, MAX_DESC_LEN } from "../../utils/constants.js";
import type { GoalE2EActivityEvent, GoalE2EStatus, GoalE2EStatusResponse, SteeringNote } from "../../../shared/types.js";
import {
  approveSpecVersion,
  getSpecState,
  saveSpecDraft,
  SpecApprovalError,
} from "../../core/goal-spec/spec-approval.js";
import { getGoalExecutionReport } from "../../core/orchestration/execution-report.js";
import { scrubTaskDependencies } from "./task-dependency-scrub.js";

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
  merge_outcome: string | null;
  pr_state: string | null;
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
  if (goal.squash_status === "merged") {
    // squash_status='merged'는 goal 파이프라인 완료일 뿐 — pr_open은 origin 실제 반영이 아직이다.
    // pr_state로 정직하게 판정한다(F3): 자동화/E2E가 열린 PR을 completed로 오판하지 않게.
    if (goal.merge_outcome === "pr_open") {
      if (goal.pr_state === "merged") return "completed";
      if (goal.pr_state === "closed") return "failed"; // PR 거절/닫힘 = 미반영
      return "pr_open"; // open 또는 미조회 — origin 미반영, 아직 완료 아님
    }
    return "completed"; // applied(origin 반영) / local(로컬 반영) / legacy(null)
  }
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
    const effectiveBaseBranch = baseBranch ?? getDefaultBranch(projectWorkdir);
    const persisted = db.prepare(
      "SELECT squash_checkpoint_base_sha, squash_commit_sha FROM goals WHERE id = ?",
    ).get(goalId) as { squash_checkpoint_base_sha: string | null; squash_commit_sha: string | null } | undefined;
    let checkpointBaseSha = persisted?.squash_checkpoint_base_sha ?? null;
    if (!checkpointBaseSha) {
      const baseHead = spawnSync("git", ["rev-parse", effectiveBaseBranch], {
        cwd: projectWorkdir,
        stdio: "pipe",
        timeout: 10_000,
        encoding: "utf-8",
      });
      if (baseHead.status !== 0 || !baseHead.stdout.trim()) {
        const error = `Squash base checkpoint 생성 실패: ${(baseHead.stderr || baseHead.stdout || "unknown").trim()}`;
        db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goalId);
        return { ok: false, error };
      }
      checkpointBaseSha = baseHead.stdout.trim();
      db.prepare(
        "UPDATE goals SET squash_checkpoint_base_sha = ? WHERE id = ?",
      ).run(checkpointBaseSha, goalId);
    }

    const evidence = recoverSquashCommitEvidence(
      projectWorkdir,
      effectiveBaseBranch,
      goal.worktree_branch,
      checkpointBaseSha,
      persisted?.squash_commit_sha,
      goal.worktree_path,
    );
    if (evidence.status === "manual_action_required") {
      const error = `Squash recovery evidence is ambiguous: ${evidence.reason ?? "unknown"}`;
      db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goalId);
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'git_error', ?)",
      ).run(goal.project_id, `[recovery] ${error.slice(0, 400)}`);
      return { ok: false, error };
    }

    const mergeResult = squashMergeGoal(
      projectWorkdir,
      goal.worktree_branch,
      commitMessage,
      gitMode,
      effectiveBaseBranch,
      {
        existingSquashSha: evidence.commitSha,
        checkpointBaseSha,
      },
    );

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

    // 사용자 WIP 보존 가드: squash 자체는 성공(commit이 base에 반영)했더라도, goal
    // worktree에 미커밋 변경(tracked/untracked WIP)이 남아 있으면 아래 removeWorktree(--force)가
    // 그것을 영구 삭제한다. squash SHA는 보존(재승인 시 재사용)하되 worktree는 지우지 않고
    // blocked + 수동 조치로 남겨 사용자가 WIP를 확인·정리한 뒤 재승인하게 한다.
    if (goal.worktree_path && worktreeHasUncommittedChanges(goal.worktree_path)) {
      db.prepare("UPDATE goals SET squash_status = 'blocked', squash_commit_sha = ? WHERE id = ?")
        .run(mergeResult.sha ?? null, goalId);
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'recovery_manual_action', ?)",
      ).run(
        goal.project_id,
        `[goal-as-unit] Squash는 완료됐으나 goal 작업 공간에 미커밋 변경(WIP)이 남아 자동 정리를 보류합니다 (sha=${mergeResult.sha ?? "none"}). ${String(goal.worktree_path).slice(0, 200)}의 변경을 확인·보존한 뒤 재승인하세요`.slice(0, 400),
      );
      broadcast("goal:squash_blocked", { goalId, reason: "goal worktree has uncommitted changes" });
      broadcast("project:updated", { projectId: goal.project_id });
      return { ok: false, error: "goal worktree has uncommitted changes" };
    }

    // merge는 성공했지만 알릴 것이 있으면 (예: 보존한 로컬 변경 복원 충돌) 활동으로 표면화
    if (mergeResult.warning) {
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'git_warning', ?)",
      ).run(goal.project_id, `[goal-as-unit] ${mergeResult.warning}`);
    }

    // 성공 처리 (goals 테이블에 status 컬럼 없음 — progress=100으로 완료 표현).
    // squash_status='merged'는 "goal 파이프라인 완료", merge_outcome은 "실제 반영 형태"라는
    // 별개 축이다. pr_open이면 실제 origin 반영은 아직이므로 pr_state='open'으로 시작.
    const outcome = mergeResult.outcome ?? null;
    const prState = outcome === "pr_open" ? "open" : null;
    const checkedAt = prState ? new Date().toISOString() : null;
    db.prepare(`
      UPDATE goals
        SET squash_status = 'merged',
            squash_commit_sha = ?,
            progress = 100,
            merge_outcome = ?,
            pr_url = ?,
            pr_number = ?,
            pr_state = ?,
            pr_state_checked_at = ?
        WHERE id = ?
    `).run(
      mergeResult.sha ?? null,
      outcome,
      mergeResult.prUrl ?? null,
      mergeResult.prNumber ?? null,
      prState,
      checkedAt,
      goalId,
    );

    const activityMsg = outcome === "pr_open"
      ? `[goal-as-unit] PR 생성 완료 (머지 대기): ${goal.title?.slice(0, 80)} ${mergeResult.prUrl ?? ""}`.trim()
      : outcome === "local"
        ? `[goal-as-unit] 로컬 반영 완료: ${goal.title?.slice(0, 80)} (sha=${mergeResult.sha ?? "none"})`
        : `[goal-as-unit] main 반영 완료: ${goal.title?.slice(0, 80)} (sha=${mergeResult.sha ?? "none"})`;
    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'goal_merged', ?)",
    ).run(goal.project_id, activityMsg);

    // 반영 시점에 남은 미완료 태스크 종결 — merged goal 불변식(라이브 태스크 없음) 확립.
    // 실패한 auto-fix 라운드가 남긴 [수정] 태스크 등 orphan 을 done 처리해 대시보드
    // 모순 표시("반영됨 + N개 남음")와 scheduler 재디스패치를 막는다.
    reconcileMergedGoalTasks(db, broadcast, goalId);

    // worktree + branch 정리. pr_open도 삭제 — 기존 pr 모드와 동일 동작이며 origin 브랜치·PR은
    // 살아남는다(로컬 worktree/브랜치만 정리). 추가 커밋이 필요하면 재체크아웃(기존 pr 모드 계승).
    if (goal.worktree_path) {
      try {
        removeWorktree(projectWorkdir, goal.worktree_path, goal.worktree_branch);
        db.prepare("UPDATE goals SET worktree_path = NULL, worktree_branch = NULL WHERE id = ?").run(goalId);
        // 작업 공간이 실제로 사라진 시점에만 Workspace 를 은퇴시킨다. cleanup 이
        // 실패하면 worktree 는 살아 있으므로 목록에 남는 편이 정확하다.
        archiveGoalWorkspace(db, goalId);
      } catch (cleanupErr: any) {
        log.warn(`squash-approve: worktree cleanup failed: ${cleanupErr.message}`);
      }
    }

    broadcast("goal:merged", {
      goalId, sha: mergeResult.sha, prUrl: mergeResult.prUrl,
      mergeOutcome: outcome, prNumber: mergeResult.prNumber ?? null, prState,
    });
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
        CASE WHEN gs.id IS NOT NULL OR g.execution_spec_version_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM goal_spec_versions version WHERE version.goal_id = g.id
        ) THEN 1 ELSE 0 END AS has_spec,
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

  router.get("/:goalId/execution-report", (req, res) => {
    const report = getGoalExecutionReport(db, req.params.goalId);
    if (!report) return res.status(404).json({ error: "Goal not found" });
    res.json(report);
  });

  router.get("/:goalId/verification-timeline", (req, res) => {
    const goalId = req.params.goalId;
    const goal = db.prepare("SELECT id FROM goals WHERE id = ?").get(goalId) as { id: string } | undefined;
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    const verifications = db.prepare(`
      SELECT v.id, v.task_id, t.title AS task_title, v.verdict, v.scope, v.severity,
             v.dimensions, v.termination_reason, v.evaluator_session_id,
             v.implementation_session_id, v.created_at
      FROM verifications v
      JOIN tasks t ON t.id = v.task_id
      WHERE t.goal_id = ?
      ORDER BY v.created_at ASC, v.rowid ASC
    `).all(goalId) as any[];

    const judgementStmt = db.prepare(
      "SELECT dimension, verdict, evidence FROM verification_dimension_judgements WHERE verification_id = ?",
    );
    const issueStmt = db.prepare(`
      SELECT vi.id, vi.dimension, vi.severity, vi.evidence, vi.repro_command,
             vi.expected_result, vi.actual_result, vi.fix_instruction, vi.assignee_id,
             (SELECT vit.task_id FROM verification_issue_tasks vit
               WHERE vit.issue_id = vi.id AND vit.relation = 'fix'
               ORDER BY vit.rowid ASC LIMIT 1) AS fix_task_id
      FROM verification_issues vi WHERE vi.verification_id = ?
      ORDER BY vi.rowid ASC
    `);
    const fixRoundStmt = db.prepare(`
      SELECT session_id, runtime_session_id, status
      FROM verification_fix_rounds WHERE source_verification_id = ? ORDER BY round_number ASC
    `);

    const dimensionNames = ["functionality", "dataFlow", "designAlignment", "craft", "edgeCases"];
    const severityForContract = (severity: string): string => {
      if (severity === "warning") return "medium";
      if (severity === "info") return "low";
      return severity;
    };
    // round.verdict 계약 enum: pass|fail|stopped|manual_approval (DB verdict은 pass|conditional|fail만 가능)
    const verdictForContract = (verdict: string): string =>
      verdict === "conditional" ? "manual_approval" : verdict;
    const parseDimensions = (raw: string): Record<string, { value?: number; notes?: string }> => {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    };

    const sourceRounds = verifications.map((verification) => ({
      verification,
      judgements: judgementStmt.all(verification.id) as Array<{
        dimension: string;
        verdict: "pass" | "fail" | "not_applicable";
        evidence: string;
      }>,
      issues: issueStmt.all(verification.id) as Array<{
        id: string;
        dimension: string;
        severity: string;
        evidence: string;
        repro_command: string;
        expected_result: string;
        actual_result: string;
        fix_instruction: string;
        assignee_id: string;
        fix_task_id: string | null;
      }>,
      fixRounds: fixRoundStmt.all(verification.id) as Array<{
        session_id: string | null;
        runtime_session_id: string | null;
        status: string;
      }>,
    }));

    // evidence는 Evaluator가 매 라운드 자유서술로 재작성하므로 fingerprint에 넣지 않는다 —
    // 같은 이슈라도 문구가 달라지면 다른 이슈로 오인해 resolved/regression 판정이 뒤집힌다.
    const issueFingerprint = (issue: { dimension: string; repro_command: string }): string =>
      JSON.stringify([issue.dimension, issue.repro_command.trim()]);
    // issue lifecycle(resolved/regression)은 한 task의 fix 루프 안에서만 의미가 있다.
    // goal에 여러 task가 있으면 verification이 created_at으로 뒤섞이므로, task별로 라운드
    // 순번을 매기고 occurrence도 task 단위로 분리해야 한다 — 그러지 않으면 다른 task의 뒤
    // 라운드(예: PASS)가 이전 task의 미해결 실패를 resolved로 오판한다.
    const taskRoundIndex = new Map<string, number>();
    const taskRoundCount = new Map<string, number>();
    sourceRounds.forEach((round) => {
      const taskId = round.verification.task_id;
      const index = taskRoundCount.get(taskId) ?? 0;
      taskRoundIndex.set(round.verification.id, index);
      taskRoundCount.set(taskId, index + 1);
    });
    const occurrenceKey = (taskId: string, issue: { dimension: string; repro_command: string }): string =>
      `${taskId}::${issueFingerprint(issue)}`;
    const occurrences = new Map<string, number[]>();
    sourceRounds.forEach((round) => {
      const taskIndex = taskRoundIndex.get(round.verification.id) ?? 0;
      for (const issue of round.issues) {
        const key = occurrenceKey(round.verification.task_id, issue);
        const indexes = occurrences.get(key) ?? [];
        indexes.push(taskIndex);
        occurrences.set(key, indexes);
      }
    });

    const rounds = sourceRounds.map((roundData, roundIndex) => {
      const { verification } = roundData;
      // 이 라운드가 속한 task 안에서의 순번/총 라운드 수 — lifecycle 판정은 이 task 기준.
      const taskIndex = taskRoundIndex.get(verification.id) ?? 0;
      const taskTotal = taskRoundCount.get(verification.task_id) ?? 1;
      const scores = parseDimensions(verification.dimensions);
      const judgementByDimension = new Map(roundData.judgements.map((item) => [item.dimension, item]));
      const dimensions = dimensionNames.map((dimension) => {
        const judgement = judgementByDimension.get(dimension);
        const storedScore = scores[dimension];
        const score = typeof storedScore?.value === "number"
          ? storedScore.value
          : judgement?.verdict === "pass" ? 10 : 0;
        return {
          dimension,
          score,
          passed: judgement ? judgement.verdict !== "fail" : score >= 7,
          rationale: judgement?.evidence ?? storedScore?.notes ?? "",
        };
      });

      const issues = roundData.issues.map((issue) => {
        const indexes = occurrences.get(occurrenceKey(verification.task_id, issue)) ?? [];
        const previousIndex = [...indexes].reverse().find((index) => index < taskIndex);
        const nextIndex = indexes.find((index) => index > taskIndex);
        // round 0(task 최초 검증)은 회귀할 이전 상태가 없어 무조건 open. round 0 이후에는
        // 이전 라운드에 없던 이슈(previousIndex undefined)도 fix가 만든 새 실패이므로 regression —
        // 재발(같은 fingerprint가 사라졌다 돌아옴)만 regression인 게 아니다.
        const regressed = taskIndex > 0 && (previousIndex === undefined || previousIndex < taskIndex - 1);
        const status = regressed
          ? "regression"
          : (nextIndex === undefined && taskIndex < taskTotal - 1)
              || (nextIndex !== undefined && nextIndex > taskIndex + 1)
            ? "resolved"
            : "open";
        return {
          issue_id: issue.id,
          status,
          dimension: issue.dimension,
          severity: severityForContract(issue.severity),
          evidence: issue.evidence,
          repro_command: issue.repro_command,
          expected_result: issue.expected_result,
          actual_result: issue.actual_result,
          fix_instruction: issue.fix_instruction,
          assignee_id: issue.assignee_id,
          fix_task_id: issue.fix_task_id,
        };
      });

      return {
        round: roundIndex + 1,
        verification_id: verification.id,
        task_id: verification.task_id,
        task_title: verification.task_title,
        verdict: verdictForContract(verification.verdict),
        reason: verification.termination_reason,
        scope: verification.scope,
        severity: verification.severity,
        implementation_session_id: verification.implementation_session_id ?? "",
        evaluator_session_id: verification.evaluator_session_id ?? "",
        fix_session_ids: [...new Set(roundData.fixRounds
          .map((fixRound) => fixRound.runtime_session_id ?? fixRound.session_id)
          .filter((sessionId): sessionId is string => Boolean(sessionId)))],
        dimensions,
        issues,
        created_at: verification.created_at,
      };
    });

    if (sourceRounds.length === 0) {
      // 아직 검증이 없음 — 계약 enum(passed|fixing|stopped|manual_approval) 밖의 "pending"은 쓸 수 없다.
      // fix 루프가 진행 중도 아니고 승인 대기도 아니므로 "stopped"(진행 정지 상태)로 표현한다.
      return res.json({ goal_id: goalId, status: "stopped", reason: "no_verifications", rounds: [] });
    }

    // goal status는 각 task의 "최신 검증"을 종합한다. 다른 task가 나중에 PASS해도
    // 통과하지 못한 task가 하나라도 있으면 goal은 passed가 아니다 — task마다 fix 루프가
    // 독립이라, 마지막 verification 하나로 goal 전체를 판정하면 다른 task의 PASS가 미해결
    // 실패를 덮어버린다. failing task가 있으면 그중 가장 최근 것을, 없으면 goal 전체의
    // 최신 검증을 대표(governing)로 status/reason을 계산한다. (sourceRounds는
    // created_at ASC, rowid ASC 정렬이므로 index가 클수록 최신)
    const latestIndexByTask = new Map<string, number>();
    sourceRounds.forEach((round, index) => {
      latestIndexByTask.set(round.verification.task_id, index);
    });
    const taskLatestIndexes = [...latestIndexByTask.values()];
    const failingLatestIndexes = taskLatestIndexes.filter(
      (index) => sourceRounds[index].verification.verdict !== "pass",
    );
    const governingIndex = Math.max(
      ...(failingLatestIndexes.length > 0 ? failingLatestIndexes : taskLatestIndexes),
    );
    const latest = sourceRounds[governingIndex];
    const latestVerification = latest.verification;
    const fixInProgress = latest.fixRounds.some((fixRound) =>
      fixRound.status === "pending" || fixRound.status === "running",
    );
    const fixAssigneeApproval = db.prepare(`
      SELECT 1
      FROM verification_issues vi
      JOIN verification_issue_tasks vit ON vit.issue_id = vi.id AND vit.relation = 'fix'
      JOIN tasks fix_task ON fix_task.id = vit.task_id
      WHERE vi.verification_id = ?
        AND fix_task.status = 'pending_approval'
        AND fix_task.assignee_id IS NULL
      LIMIT 1
    `).get(latestVerification.id) !== undefined;
    const status = latestVerification.verdict === "pass"
      ? "passed"
      : latestVerification.verdict === "conditional" || fixAssigneeApproval
        ? "manual_approval"
        : fixInProgress ? "fixing" : "stopped";
    const reason = status === "fixing"
      ? "auto_fix_in_progress"
      : fixAssigneeApproval
        ? "fix_assignee_unavailable"
      : latestVerification.termination_reason
        ?? (latestVerification.verdict === "pass" ? "passed"
          : latestVerification.verdict === "conditional" ? "conditional" : "verification_failed");

    // 미검증 sibling task 누락 방지: governing 로직은 verification이 있는 task만 종합하므로,
    // 순차 실행 중 아직 검증 전인 형제 task(status todo/in_progress 등, verification 없음)가
    // 남아 있어도 먼저 통과한 task 하나로 goal 전체가 passed로 표시된다. 검증되지 않은 미완료
    // task가 하나라도 있으면 goal 커버리지가 불완전하므로 passed로 볼 수 없다 — 검증 기록이
    // 전혀 없을 때(no_verifications)와 같은 "진행 정지" 버킷(stopped)으로 표현한다.
    const unverifiedPending = db.prepare(`
      SELECT COUNT(*) AS count FROM tasks t
      WHERE t.goal_id = ? AND t.parent_task_id IS NULL
        AND t.status IN ('todo', 'in_progress', 'in_review', 'pending_approval', 'blocked')
        AND NOT EXISTS (SELECT 1 FROM verifications v WHERE v.task_id = t.id)
    `).get(goalId) as { count: number };
    const incompleteCoverage = status === "passed" && unverifiedPending.count > 0;

    res.json({
      goal_id: goalId,
      status: incompleteCoverage ? "stopped" : status,
      reason: incompleteCoverage ? "verification_incomplete" : reason,
      rounds,
    });
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
        "INSERT INTO goals (project_id, title, description, priority, \"references\", sort_order, skip_adversarial, acceptance_script, source_material, spec_approval_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
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

  // Delete goal — fully release in-flight ownership before CASCADE delete:
  // task-phase sessions, scheduler flight/retry state, and the goal worktree.
  router.delete("/:id", (req, res) => {
    const goalId = req.params.id;
    // Collect info atomically before delete to hand off session/worktree cleanup.
    // tasks are CASCADE-deleted with the goal, so every id we need for post-commit
    // teardown must be captured inside this transaction.
    type DeleteInfo = {
      projectId: string;
      projectWorkdir: string | null;
      assigneeIds: string[];
      taskIds: string[];
      worktreePath: string | null;
      worktreeBranch: string | null;
    } | null;
    const deleteInfo = db.transaction((): DeleteInfo => {
      const goal = db.prepare(
        "SELECT project_id, worktree_path, worktree_branch FROM goals WHERE id = ?",
      ).get(goalId) as { project_id: string; worktree_path: string | null; worktree_branch: string | null } | undefined;
      if (!goal) return null;
      const tasks = db.prepare(
        "SELECT id, assignee_id, status FROM tasks WHERE goal_id = ?",
      ).all(goalId) as { id: string; assignee_id: string | null; status: string }[];
      const project = db.prepare("SELECT workdir FROM projects WHERE id = ?")
        .get(goal.project_id) as { workdir: string | null } | undefined;
      db.prepare("DELETE FROM goals WHERE id = ?").run(goalId);
      scrubTaskDependencies(db, tasks.map((task) => task.id));
      return {
        projectId: goal.project_id,
        projectWorkdir: project?.workdir ?? null,
        assigneeIds: tasks
          .filter((t) => (t.status === "in_progress" || t.status === "in_review") && t.assignee_id)
          .map((t) => t.assignee_id as string),
        taskIds: tasks.map((t) => t.id),
        worktreePath: goal.worktree_path,
        worktreeBranch: goal.worktree_branch,
      };
    })();

    if (!deleteInfo) return res.status(404).json({ error: "Goal not found" });
    // Kill sessions after commit — side-effects must not run inside the txn
    for (const assigneeId of deleteInfo.assigneeIds) {
      // assignee_id는 이 goal의 (이제 삭제된) task 기준 스냅샷일 뿐 — 위임 대기 부모처럼
      // DB상 in_progress로 남아있는 사이 그 agent가 다른 goal의 새 task를 정상 실행 중일
      // 수 있다. sessionKey가 agentId를 공유하므로, 그 살아있는 세션이 실제로 이 goal의
      // task를 실행 중인지 확인 후에만 죽인다. task_id가 NULL이면(delegation 등 taskId를
      // 안 넘기는 spawn 경로) 이 goal 소속인지 증명할 수 없다 — 증명 안 되면 죽이지 않는다
      // (활성 세션이 없으면 어차피 killSession이 no-op이므로 이 판단에서 제외).
      const activeSession = db.prepare(
        "SELECT task_id FROM sessions WHERE agent_id = ? AND status = 'active' ORDER BY rowid DESC LIMIT 1",
      ).get(assigneeId) as { task_id: string | null } | undefined;
      if (activeSession && (!activeSession.task_id || !deleteInfo.taskIds.includes(activeSession.task_id))) continue;
      try { ctx.sessionManager?.killSession(assigneeId); } catch { /* ignore */ }
    }
    // Kill spec-generation and decompose sessions for this goal
    try { ctx.sessionManager?.killSession(`spec-${goalId}`); } catch { /* ignore */ }
    try { ctx.sessionManager?.killSession(`decompose-${goalId}`); } catch { /* ignore */ }
    // Kill task-phase sessions (architect/evaluator). These use taskId-scoped
    // keys — NOT the assignee agent id — so the assignee kill above misses them.
    // An architect session mid-run keeps the engine spawning the impl session
    // for an already-deleted goal unless we terminate it here.
    for (const taskId of deleteInfo.taskIds) {
      try { ctx.sessionManager?.killSession(`architect-${taskId}`); } catch { /* ignore */ }
      try { ctx.sessionManager?.killSession(`evaluator-${taskId}`); } catch { /* ignore */ }
    }
    // Release scheduler in-flight ownership: spec/decompose lookahead flight,
    // decompose retry backoff, and per-task failover/backfill state.
    try { ctx.scheduler?.cancelGoal(deleteInfo.projectId, goalId, deleteInfo.taskIds); } catch { /* ignore */ }
    // ④ artifacts 수명 — 삭제된 goal 의 수확 산출물(스크린샷 등)도 함께 제거
    removeGoalArtifacts(db, goalId);
    // Tear down the goal worktree + its task checkpoints (best-effort, synchronous
    // so the row and its Git residue disappear together). Drop checkpoints BEFORE
    // removing the worktree — dropCheckpoint reads `git stash list` from inside it.
    if (deleteInfo.worktreePath && deleteInfo.projectWorkdir) {
      try {
        if (existsSync(deleteInfo.worktreePath)) {
          for (const taskId of deleteInfo.taskIds) {
            try { dropCheckpoint(deleteInfo.worktreePath, taskId); } catch { /* ignore */ }
          }
        }
        removeWorktree(deleteInfo.projectWorkdir, deleteInfo.worktreePath, deleteInfo.worktreeBranch ?? undefined);
      } catch (err: any) {
        log.warn(`Goal ${goalId} worktree cleanup failed: ${err?.message ?? err}`);
      }
    }
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
          const cause = parsed.errors.length ? ` — ${parsed.errors.join("; ")}` : "";
          throw new Error(`Goal suggestion produced no text output${cause}`);
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

  const sendSpecError = (res: Response, error: unknown) => {
    if (!(error instanceof SpecApprovalError)) throw error;
    const status = error.code === "goal_not_found" || error.code === "version_not_found"
      ? 404
      : error.code === "stale_version"
        ? 409
        : 400;
    return res.status(status).json({
      error: error.code,
      message: error.message,
      ...(error.location ? { location: error.location } : {}),
    });
  };

  const broadcastSpecUpdate = (goalId: string) => {
    const goal = db.prepare("SELECT project_id FROM goals WHERE id = ?").get(goalId) as { project_id: string } | undefined;
    if (goal) broadcast("project:updated", { projectId: goal.project_id });
  };

  // All three endpoints return the same version-history state representation.
  router.get("/:goalId/spec", (req, res) => {
    try {
      res.json(getSpecState(db, req.params.goalId));
    } catch (error) {
      sendSpecError(res, error);
    }
  });

  router.post("/:goalId/spec", (req, res) => {
    try {
      saveSpecDraft(db, req.params.goalId, req.body ?? {});
      const state = getSpecState(db, req.params.goalId);
      broadcastSpecUpdate(req.params.goalId);
      res.status(201).json(state);
    } catch (error) {
      sendSpecError(res, error);
    }
  });

  router.post("/:goalId/spec/approve", (req, res) => {
    try {
      if (typeof req.body?.version_id !== "string" || req.body.version_id.trim() === "") {
        throw new SpecApprovalError("invalid_spec", "version_id is required", "version_id");
      }
      approveSpecVersion(db, req.params.goalId, req.body.version_id);
      const state = getSpecState(db, req.params.goalId);
      const goal = db.prepare("SELECT project_id FROM goals WHERE id = ?").get(req.params.goalId) as { project_id: string } | undefined;
      broadcastSpecUpdate(req.params.goalId);
      res.json(state);
      if (goal) ctx.scheduler?.notifyGoalReady(goal.project_id);
    } catch (error) {
      sendSpecError(res, error);
    }
  });

  // Update spec manually
  router.patch("/:id/spec", (req, res) => {
    const goalId = req.params.id;
    try {
      const state = getSpecState(db, goalId);
      const latest = state.versions.at(-1);
      if (!latest) return res.status(404).json({ error: "version_not_found", message: "Spec version not found for this goal" });

      saveSpecDraft(db, goalId, {
        scope: req.body?.scope ?? req.body?.prd_summary?.scope ?? latest.scope,
        out_of_scope: req.body?.out_of_scope ?? latest.out_of_scope,
        acceptance_criteria: req.body?.acceptance_criteria ?? latest.acceptance_criteria,
        expected_tasks: req.body?.expected_tasks ?? latest.expected_tasks,
        verification_methods: req.body?.verification_methods ?? latest.verification_methods,
      });
      const updated = getSpecState(db, goalId);
      broadcastSpecUpdate(goalId);
      res.json(updated);
    } catch (error) {
      sendSpecError(res, error);
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

    // Reject a concurrent generation. A single legacy sentinel row can't track
    // two in-flight jobs: if a second generate ran, the first's completion would
    // flip generation_status to idle while the second is still running, so
    // pollers stop early and the late job overwrites (or reverts) the result.
    const existing = db.prepare("SELECT id, prd_summary FROM goal_specs WHERE goal_id = ?").get(goalId) as
      | { id: string; prd_summary: string }
      | undefined;
    if (existing) {
      let alreadyGenerating = false;
      try { alreadyGenerating = JSON.parse(existing.prd_summary)?._status === "generating"; } catch { /* not a sentinel */ }
      if (alreadyGenerating) {
        return res.status(409).json({ error: "Spec generation already in progress", goalId });
      }
    }

    // Mark as generating (client can check this)
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

    const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as any;
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    const currentSpec = getSpecState(db, goalId).versions.at(-1);
    if (!currentSpec) return res.status(404).json({ error: "No spec to refine — generate one first" });

    if (!ctx.generateGoalSpec) {
      return res.status(503).json({ error: "Orchestration engine not ready" });
    }

    // Use the refine function (registered from orchestration routes)
    if (!(ctx as any).refineGoalSpec) {
      return res.status(503).json({ error: "Refine not available" });
    }

    try {
      const result = await (ctx as any).refineGoalSpec(goalId, prompt, currentSpec);
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

    const commitMessage = buildGoalCommitMessage(db, goal);

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

    // degraded 노출: 자동 건너뜀 태스크 — 승인자가 "무엇이 빠진 채 반영되는지" 확인
    // (engine.ts goal:squash_ready broadcast와 동일 형상).
    const skippedTasks = db.prepare(
      "SELECT id, title, skip_reason FROM tasks WHERE goal_id = ? AND status = 'skipped' AND parent_task_id IS NULL ORDER BY sort_order ASC",
    ).all(goal.id) as { id: string; title: string; skip_reason: string | null }[];

    // ③ 화면 증거 맥락 — goal 태스크들이 선언한 사용자 노출 URL 집계 (승인 다이얼로그 칩).
    const affectedUrls = Array.from(new Set(
      (db.prepare("SELECT affected_urls FROM tasks WHERE goal_id = ?").all(goal.id) as { affected_urls: string | null }[])
        .flatMap((r) => {
          try {
            const parsedUrls = JSON.parse(r.affected_urls ?? "[]");
            return Array.isArray(parsedUrls) ? parsedUrls.filter((u: unknown): u is string => typeof u === "string") : [];
          } catch {
            return [];
          }
        }),
    ));

    res.json({
      goalId: goal.id,
      squashStatus: goal.squash_status,
      commitMessage,
      filesChanged,
      acceptanceScript: goal.acceptance_script ?? null,
      // squash 시점에 보존해 둔 실제 실행 출력. 이 필드가 없어서 다이얼로그의 "검증 결과"
      // 칸이 재조회 경로에서 항상 비어 있었다.
      acceptanceOutput: goal.acceptance_output ?? null,
      workReport,
      skippedTasks,
      affectedUrls,
    });
  });

  // ─── 웹 세션 워크스페이스: worktree diff / 파일 목록 (Phase 3) ─────────────

  // GET /goals/:goalId/diff — goal worktree의 unified diff (Diff 탭). squash-preview와
  // 같은 base 결정·git 호출 패턴이나 --name-only 대신 patch 텍스트를 반환한다.
  // worktree가 정리된(merged) goal은 빈 diff.
  router.get("/:goalId/diff", (req, res) => {
    const goal = db.prepare("SELECT worktree_path, project_id FROM goals WHERE id = ?").get(req.params.goalId) as any;
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    if (!goal.worktree_path || !existsSync(goal.worktree_path)) return res.json({ diff: "", truncated: false });
    const project = db.prepare("SELECT base_branch FROM projects WHERE id = ?").get(goal.project_id) as { base_branch?: string } | undefined;
    const baseBranch = project?.base_branch || "main";
    const runGitRaw = (args: string[]): string => {
      try {
        const r = spawnSync("git", args, { cwd: goal.worktree_path, stdio: "pipe", timeout: 15_000, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
        return r.status === 0 ? r.stdout : "";
      } catch { return ""; }
    };
    const committed = runGitRaw(["diff", "--no-color", `${baseBranch}...HEAD`]); // 커밋된 변경
    const uncommitted = runGitRaw(["diff", "--no-color", "HEAD"]);               // 미커밋(WIP)
    let diff = [committed, uncommitted].filter(Boolean).join("\n");
    const MAX = 500 * 1024;
    const truncated = diff.length > MAX;
    if (truncated) diff = diff.slice(0, MAX) + "\n\n... (diff가 너무 커 잘렸습니다)";
    res.json({ diff, truncated });
  });

  // GET /goals/:goalId/files — goal worktree 파일 트리 (작업 공간 탭). .git·node_modules 등 제외.
  router.get("/:goalId/files", (req, res) => {
    const goal = db.prepare("SELECT worktree_path FROM goals WHERE id = ?").get(req.params.goalId) as any;
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    if (!goal.worktree_path || !existsSync(goal.worktree_path)) return res.json({ files: [], truncated: false });
    const IGNORE = new Set([".git", "node_modules", "dist", ".crewdeck", ".crewdeck-worktrees", ".next", "coverage"]);
    const safeReaddir = (dir: string) => {
      try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    };
    const files: string[] = [];
    const MAX_FILES = 800;
    const walk = (dir: string, rel: string): void => {
      if (files.length >= MAX_FILES) return;
      for (const e of safeReaddir(dir)) {
        if (files.length >= MAX_FILES) break;
        if (IGNORE.has(e.name)) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), relPath);
        else files.push(relPath);
      }
    };
    walk(goal.worktree_path, "");
    res.json({ files: files.sort(), truncated: files.length >= MAX_FILES });
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
    if (!["pending_approval", "blocked", "approved"].includes(goal.squash_status)) {
      return res.status(400).json({ error: `Cannot approve — current squash_status is '${goal.squash_status}'` });
    }

    // squash_status = 'approved' 로 전환
    db.prepare("UPDATE goals SET squash_status = 'approved' WHERE id = ?").run(goalId);

    // 커밋 메시지 — 승인 다이얼로그에서 사용자가 편집한 본문이 있으면 그대로 확정하고,
    // 없으면 자동 생성한다(human-in-the-loop: 에이전트 초안을 사람이 검토·수정한 결과).
    const editedMessage = typeof req.body?.commitMessage === "string" ? req.body.commitMessage.trim() : "";
    const commitMessage = editedMessage ? editedMessage.slice(0, 20_000) : buildGoalCommitMessage(db, goal);

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
    // ── 복구 우선 순서 보장 ──
    // 이전에 checkpoint가 저장돼 있으면(= squash를 한 번 시도한 뒤 중단됐을 수 있음),
    // divergence sync(goal 브랜치 자동 merge-in)로 브랜치를 바꾸기 전에 기존 squash 증거를
    // 먼저 확인한다. 이미 squash가 만들어졌거나(promote/recorded) 상태가 모호하면
    // (manual_action_required) 브랜치를 건드리지 않는다 — 재사용/차단은 performSquash가
    // 결정한다. squash가 아직 없을 때(not_created)만 divergence sync를 진행한다.
    let skipDivergenceSync = false;
    const persistedForRecovery = db.prepare(
      "SELECT squash_checkpoint_base_sha, squash_commit_sha FROM goals WHERE id = ?",
    ).get(goalId) as { squash_checkpoint_base_sha: string | null; squash_commit_sha: string | null } | undefined;
    if (persistedForRecovery?.squash_checkpoint_base_sha) {
      const recovery = recoverSquashCommitEvidence(
        projectWorkdir,
        baseBranch,
        goal.worktree_branch,
        persistedForRecovery.squash_checkpoint_base_sha,
        persistedForRecovery.squash_commit_sha,
        goal.worktree_path,
      );
      if (recovery.status !== "not_created") skipDivergenceSync = true;
    }

    const worktreeUsable = !!goal.worktree_path && existsSync(goal.worktree_path);
    if (!skipDivergenceSync && worktreeUsable && detectDivergence(projectWorkdir, baseBranch, goal.worktree_branch)) {
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

  // POST /goals/:goalId/pr-state/refresh — pr_open goal의 실제 GitHub PR 상태를 gh로 재조회.
  // 폴링/웹훅 없음 — 사용자가 대시보드에서 수동 새로고침할 때만 조회한다.
  router.post("/:goalId/pr-state/refresh", (req, res) => {
    const { goalId } = req.params;
    const goal = db.prepare(
      "SELECT g.merge_outcome, g.pr_url, g.project_id, p.workdir AS _workdir FROM goals g JOIN projects p ON g.project_id = p.id WHERE g.id = ?",
    ).get(goalId) as { merge_outcome: string | null; pr_url: string | null; project_id: string; _workdir: string | null } | undefined;
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    if (goal.merge_outcome !== "pr_open" || !goal.pr_url) {
      return res.status(400).json({ error: "이 목표에는 조회할 PR이 없습니다" });
    }
    if (!goal._workdir) return res.status(400).json({ error: "Project has no workdir configured" });

    const token = resolveGitHubToken(goal._workdir);
    const state = refreshPrState(goal._workdir, goal.pr_url, token);
    if (!state) {
      return res.status(502).json({ error: "PR 상태 조회 실패 — gh CLI 설치/인증·네트워크를 확인하세요" });
    }
    const checkedAt = new Date().toISOString();
    db.prepare("UPDATE goals SET pr_state = ?, pr_state_checked_at = ? WHERE id = ?").run(state, checkedAt, goalId);
    broadcast("goal:pr_state", { goalId, prState: state, prStateCheckedAt: checkedAt });
    broadcast("project:updated", { projectId: goal.project_id });
    return res.json({ success: true, prState: state, prStateCheckedAt: checkedAt });
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

  // ─── Steering (실행 중 goal 조향 큐) ─────────────────────
  // 실행 중 Generator 세션을 죽이지 않고 자유 텍스트 조향 노트를 큐잉한다. 실제 주입은
  // 다음 Generator(구현·fix) 스텝 spawn 시점(별도 태스크)이며, 여기서는 저장 + broadcast만 한다.

  /** goal_steering_notes 행 → API(camelCase) 직렬화. POST 응답·GET 목록 공용. */
  const serializeSteeringNote = (row: {
    id: string; goal_id: string; content: string; injected: number;
    injected_at: string | null; injected_step: string | null; created_at: string;
  }): SteeringNote => ({
    id: row.id,
    goalId: row.goal_id,
    content: row.content,
    injected: row.injected === 1,
    injectedAt: row.injected_at,
    injectedStep: row.injected_step,
    createdAt: row.created_at,
  });

  const STEERING_COLUMNS =
    "id, goal_id, content, injected, injected_at, injected_step, created_at";

  // POST /goals/:goalId/steering — 조향 노트 큐잉 (세션 무중단)
  router.post("/:goalId/steering", (req, res) => {
    const { goalId } = req.params;
    const content = (req.body ?? {}).content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return res.status(400).json({ error: "content (non-empty string) is required" });
    }
    const goal = db.prepare("SELECT project_id FROM goals WHERE id = ?").get(goalId) as
      { project_id: string } | undefined;
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    const trimmed = content.trim().slice(0, MAX_DESC_LEN);
    const result = db.prepare(
      "INSERT INTO goal_steering_notes (goal_id, content) VALUES (?, ?)",
    ).run(goalId, trimmed);
    const row = db.prepare(
      `SELECT ${STEERING_COLUMNS} FROM goal_steering_notes WHERE rowid = ?`,
    ).get(result.lastInsertRowid) as Parameters<typeof serializeSteeringNote>[0];
    const note = serializeSteeringNote(row);

    // WS broadcast로 대시보드가 즉시 반영 (DB 직접조회 폴링 대신).
    broadcast("steering:submitted", { goalId, projectId: goal.project_id, note });
    res.status(201).json(note);
  });

  // GET /goals/:goalId/steering — pending + injected 노트 목록 (FIFO)
  router.get("/:goalId/steering", (req, res) => {
    const { goalId } = req.params;
    const goal = db.prepare("SELECT id FROM goals WHERE id = ?").get(goalId) as { id: string } | undefined;
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    const rows = db.prepare(
      `SELECT ${STEERING_COLUMNS} FROM goal_steering_notes WHERE goal_id = ? ORDER BY created_at ASC, rowid ASC`,
    ).all(goalId) as Parameters<typeof serializeSteeringNote>[0][];
    res.json(rows.map(serializeSteeringNote));
  });

  return router;
}
