import { existsSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { createLogger } from "../utils/logger.js";
import { cleanupStaleWorktrees } from "./project/worktree.js";

const log = createLogger("recovery");

export interface RecoveryResult {
  recoveredTasks: number;
  killedProcesses: number;
}

export function recoverOnStartup(db: Database): RecoveryResult {
  let recoveredTasks = 0;
  let killedProcesses = 0;

  // 1. in_progress / in_review 태스크 → todo로 복원 (크래시로 중단된 작업)
  const stale = db
    .prepare(
      "UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE status IN ('in_progress', 'in_review')",
    )
    .run();
  recoveredTasks = stale.changes;

  // 2. 고아 프로세스 정리: active 세션 중 pid가 있는 항목 확인 후 SIGTERM
  const activeSessions = db
    .prepare("SELECT id, agent_id, pid FROM sessions WHERE status = 'active' AND pid IS NOT NULL")
    .all() as { id: string; agent_id: string; pid: number }[];

  for (const s of activeSessions) {
    try {
      process.kill(s.pid, 0); // 존재 확인
      process.kill(s.pid, "SIGTERM");
      killedProcesses++;
      log.info(`Killed orphan process pid=${s.pid} (session ${s.id})`);
      db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?").run(s.id);
    } catch (err: any) {
      if (err.code === "ESRCH") {
        // 이미 종료된 프로세스 — DB 정리만
        db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?").run(s.id);
      } else if (err.code === "EPERM") {
        // 권한 부족 — 프로세스가 살아있지만 kill 불가. 무한 재시도 방지를 위해
        // killed로 마킹 (프로세스는 OS가 관리).
        log.warn(`Cannot kill orphan pid=${s.pid} (EPERM) — marking session as killed to prevent retry loop`);
        db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?").run(s.id);
      } else {
        log.error(`Unexpected error killing pid=${s.pid}: ${err.message}`);
        db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?").run(s.id);
      }
    }
  }

  // ALL stale active sessions — not just pid=NULL.
  // On restart, every "active" session is orphaned by definition: the server
  // process that owned them is gone. The pid-based kill above handles sessions
  // whose process is genuinely still running; everything else is a ghost.
  const staleActive = db.prepare(
    "UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE status = 'active'",
  ).run();
  if (staleActive.changes > 0) {
    log.info(`Cleaned ${staleActive.changes} stale active session(s) on startup`);
  }

  // 3. 에이전트 상태 초기화: working → idle, current_task_id 해제
  db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE status = 'working'").run();

  // 3b. goal_specs stuck at '{"_status":"generating"}' → failed
  //
  // If the prior process died mid spec-generation (crash, SIGKILL, tsx watch
  // reload), the placeholder row stays forever and makes processNextGoal
  // short-circuit every poll cycle. Mark any such row as failed so the
  // autopilot can retry or surface the error instead of looping silently.
  const stuckSpecs = db
    .prepare(
      `UPDATE goal_specs
       SET prd_summary = '{"_status":"failed","_error":"Generation interrupted by server restart"}',
           updated_at = datetime('now')
       WHERE prd_summary = '{"_status":"generating"}'`,
    )
    .run();
  if (stuckSpecs.changes > 0) {
    log.warn(`Cleared ${stuckSpecs.changes} stuck goal_specs row(s) left in 'generating' state`);
  }

  // 4. 잔존 worktree + agent branch 정리 (프로젝트별)
  //    단, pending_approval / approved 상태 goal 의 worktree 는 보존
  let cleanedWorktrees = 0;
  const projects = db.prepare("SELECT id, workdir FROM projects WHERE status = 'active' AND workdir != ''").all() as { id: string; workdir: string }[];
  for (const p of projects) {
    try {
      // active goal worktree 경로 수집 — merged 외에는 전부 보존.
      // ⚠ 과거 버전은 'none'도 제외해 "아직 작업 중"(squash 미트리거 = none)인
      // goal의 worktree를 재시작 시 삭제했다 — R2 크래시 복구 E2E에서 WIP 소실로 재현.
      const activeWorktreePaths = (db.prepare(
        `SELECT worktree_path FROM goals
          WHERE project_id = ?
            AND squash_status != 'merged'
            AND worktree_path IS NOT NULL`,
      ).all(p.id) as { worktree_path: string }[]).map((r) => r.worktree_path);

      cleanedWorktrees += cleanupStaleWorktrees(p.workdir, activeWorktreePaths);
    } catch (err: any) {
      log.warn(`Worktree cleanup failed for ${p.workdir}: ${err.message}`);
    }
  }

  // 5. 'triggering' 상태 복구 — 서버가 CAS 진입 후 크래시하면 goal 이 영구 'triggering' 에 고착.
  //    재시작 시 모두 'none' 으로 복원한다.
  recoverTriggeringGoals(db);

  if (recoveredTasks > 0 || killedProcesses > 0 || cleanedWorktrees > 0) {
    log.info(`Recovery complete: ${recoveredTasks} tasks restored, ${killedProcesses} orphan processes killed, ${cleanedWorktrees} stale worktrees cleaned`);
  }

  return { recoveredTasks, killedProcesses };
}

/**
 * 'triggering' 상태 복구 — 서버가 CAS 로 진입한 뒤 크래시하면 goal 이 영구 'triggering' 상태에 고착.
 * 재시작 시 모두 'none' 으로 복원한다.
 */
export function recoverTriggeringGoals(db: Database): void {
  const result = db.prepare(
    "UPDATE goals SET squash_status = 'none' WHERE squash_status = 'triggering'"
  ).run();
  if (result.changes > 0) {
    log.info(`Recovered ${result.changes} goal(s) from 'triggering' state after restart`);
  }
}

/**
 * M-3: 서버 재시작 후 pending_approval 상태 goal 에 대해 goal:squash_ready 재발송.
 * WebSocket 서버와 broadcast 함수가 준비된 이후에 호출해야 한다.
 *
 * - worktree_path 실제 존재 확인
 * - 존재 시 broadcast 재발송 → 사용자가 승인 버튼을 볼 수 있음
 * - 존재 안 하면 squash_status='blocked' + activity 경고 기록
 */
export function rebroadcastPendingApprovals(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
): void {
  const pendingGoals = db.prepare(
    `SELECT g.id, g.title, g.project_id, g.worktree_path, g.worktree_branch
       FROM goals g
      WHERE g.squash_status = 'pending_approval'`,
  ).all() as { id: string; title: string; project_id: string; worktree_path: string | null; worktree_branch: string | null }[];

  for (const goal of pendingGoals) {
    if (goal.worktree_path && existsSync(goal.worktree_path)) {
      broadcast("goal:squash_ready", {
        goalId: goal.id,
        commitMessage: `feat: ${goal.title ?? goal.id}`,
        filesChanged: [],
        acceptanceOutput: "",
      });
      log.info(`Rebroadcast goal:squash_ready for goal ${goal.id} (pending_approval)`);
    } else {
      db.prepare(
        "UPDATE goals SET squash_status = 'blocked' WHERE id = ?",
      ).run(goal.id);
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'goal_squash_blocked', ?)",
      ).run(
        goal.project_id,
        `[recovery] worktree 없음 — squash 차단: ${(goal.title ?? goal.id).slice(0, 80)}`,
      );
      log.warn(`Goal ${goal.id} worktree missing on restart — squash blocked`);
    }
  }
}
