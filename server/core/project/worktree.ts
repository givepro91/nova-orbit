import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("worktree");

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/**
 * Add `.nova-worktrees/` (and `.claude/worktrees/`) to the project's
 * `.gitignore` if not already present. Idempotent — safe to call every
 * time a worktree is created. Prevents the parent repo from tracking
 * worktree HEAD pointers as gitlink noise.
 */
function ensureGitignoreHasWorktreeExcludes(projectWorkdir: string): void {
  const gitignorePath = join(projectWorkdir, ".gitignore");
  const requiredLines = [".nova-worktrees/", ".claude/worktrees/"];
  try {
    let current = "";
    if (existsSync(gitignorePath)) {
      current = readFileSync(gitignorePath, "utf-8");
    }
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    const missing = requiredLines.filter((req) => !lines.includes(req));
    if (missing.length === 0) return;

    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    const block = `${prefix}\n# Crewdeck — agent worktrees (do not commit)\n${missing.join("\n")}\n`;
    if (existsSync(gitignorePath)) {
      appendFileSync(gitignorePath, block);
    } else {
      writeFileSync(gitignorePath, block.replace(/^\n/, ""));
    }
    log.info(`Added worktree excludes to .gitignore: ${missing.join(", ")}`);
  } catch (err: any) {
    log.warn(`Could not update .gitignore at ${projectWorkdir}: ${err.message}`);
  }
}

/**
 * 에이전트별 독립 worktree 생성.
 *
 * 구조: {projectWorkdir}/.nova-worktrees/{agentSlug}-{taskSlug}-{uid}/
 * Branch: agent/{agentSlug}/{taskSlug}-{uid}
 *
 * Fallback: git repo가 아니면 null 반환 → 호출자가 직접 실행 모드로 전환
 */
export function createWorktree(
  projectWorkdir: string,
  agentName: string,
  taskSlug: string,
): WorktreeInfo | null {
  // git repo 확인
  if (!existsSync(join(projectWorkdir, ".git"))) {
    log.info("Not a git repo — skipping worktree isolation");
    return null;
  }

  // Ensure .gitignore excludes the worktree directory so agent tasks don't
  // accidentally commit worktree HEAD pointers as gitlink noise.
  ensureGitignoreHasWorktreeExcludes(projectWorkdir);

  // HEAD에 커밋이 있는지 확인 (빈 repo에서 worktree 생성 불가)
  const headCheck = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 5_000,
  });
  if (headCheck.status !== 0) {
    log.warn("No commits in repo — skipping worktree isolation");
    return null;
  }

  const agentSlug = slugify(agentName).slice(0, 50) || "agent";
  const safeTaskSlug = slugify(taskSlug).slice(0, 40) || "task";
  const uid = randomBytes(4).toString("hex"); // 유일성 보장 — slug 충돌 방지
  const branch = `agent/${agentSlug}/${safeTaskSlug}-${uid}`;
  const worktreePath = join(projectWorkdir, ".nova-worktrees", `${agentSlug}-${safeTaskSlug}-${uid}`);

  // uid가 유일성을 보장하므로 충돌 없음 — 직접 생성
  const result = spawnSync("git", ["worktree", "add", "-b", branch, worktreePath], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 30_000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    // Only retry if the error is branch-related (already exists)
    if (stderr.includes("already exists")) {
      const retryResult = spawnSync("git", ["worktree", "add", worktreePath, branch], {
        cwd: projectWorkdir,
        stdio: "pipe",
        timeout: 30_000,
      });
      if (retryResult.status !== 0) {
        log.error(`Failed to create worktree (retry): ${retryResult.stderr?.toString()}`);
        return null;
      }
    } else {
      log.error(`Failed to create worktree: ${stderr}`);
      return null;
    }
  }

  log.info(`Created worktree: ${worktreePath} (branch: ${branch})`);
  return { path: worktreePath, branch };
}

/**
 * Worktree 디렉토리 + branch 정리.
 * branch 파라미터가 있으면 worktree 제거 후 branch도 삭제.
 */
export function removeWorktree(projectWorkdir: string, worktreePath: string, branch?: string): void {
  // 1. worktree 제거
  try {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: projectWorkdir,
      stdio: "pipe",
      timeout: 15_000,
    });
    log.info(`Removed worktree: ${worktreePath}`);
  } catch (err: any) {
    log.warn(`Failed to remove worktree: ${err.message}`);
  }

  // 2. branch 정리 — 재시도 시 새 브랜치를 생성하므로 실패 브랜치도 강제 삭제
  if (branch) {
    try {
      const result = spawnSync("git", ["branch", "-D", branch], {
        cwd: projectWorkdir,
        stdio: "pipe",
        timeout: 10_000,
      });
      if (result.status === 0) {
        log.info(`Deleted branch: ${branch}`);
      } else {
        log.warn(`Failed to delete branch ${branch}: ${result.stderr?.toString()}`);
      }
    } catch (err: any) {
      log.warn(`Failed to delete branch ${branch}: ${err.message}`);
    }
  }
}

/**
 * 서버 시작 시 잔존 worktree + agent branch 일괄 정리.
 * recovery.ts에서 호출.
 *
 * @param excludePaths - 제외할 worktree 경로 목록 (Goal-as-Unit: squash_status != 'merged'인 goal worktree)
 */
export function cleanupStaleWorktrees(projectWorkdir: string, excludePaths: string[] = []): number {
  if (!existsSync(join(projectWorkdir, ".git"))) return 0;

  let cleaned = 0;
  const worktrees = listWorktrees(projectWorkdir);
  const mainWorktree = projectWorkdir;
  const excludeSet = new Set(excludePaths);

  for (const wt of worktrees) {
    if (wt === mainWorktree) continue; // main worktree는 건드리지 않음
    if (excludeSet.has(wt)) {
      log.info(`Skipping active goal worktree: ${wt}`);
      continue; // Goal-as-Unit: 진행 중 goal worktree는 보존
    }
    if (wt.includes(".nova-worktrees")) {
      removeWorktree(projectWorkdir, wt);
      cleaned++;
    }
  }

  // 잔존 agent/* branch 정리 (goal/* 브랜치는 Goal-as-Unit squash 후 제거하므로 여기서는 제외)
  try {
    const result = spawnSync("git", ["branch", "--list", "agent/*"], {
      cwd: projectWorkdir,
      stdio: "pipe",
      timeout: 10_000,
    });
    if (result.status === 0) {
      const branches = result.stdout.toString().split("\n")
        .map(b => b.trim())
        .filter(b => b && b.startsWith("agent/"));
      for (const b of branches) {
        // 재시도 시 새 브랜치를 생성하므로 stale agent 브랜치는 모두 강제 삭제
        const delResult = spawnSync("git", ["branch", "-D", b], { cwd: projectWorkdir, stdio: "pipe", timeout: 5_000 });
        if (delResult.status === 0) {
          log.info(`Cleaned up stale branch: ${b}`);
          cleaned++;
        } else {
          log.warn(`Failed to clean up stale branch: ${b}`);
        }
      }
    }
  } catch { /* best effort */ }

  // 서버 재시작 시 dangling nova-checkpoint- stash 정리
  try {
    const stashListResult = spawnSync("git", ["stash", "list"], {
      cwd: projectWorkdir,
      stdio: "pipe",
      timeout: 10_000,
      encoding: "utf-8",
    });
    if (stashListResult.status === 0 && stashListResult.stdout) {
      const stashLines = stashListResult.stdout.split("\n").filter(Boolean);
      // 역순으로 처리해야 stash index가 올바름 (뒤에서부터 drop)
      const checkpointIndices: number[] = [];
      stashLines.forEach((line, idx) => {
        if (line.includes("nova-checkpoint-")) {
          checkpointIndices.push(idx);
        }
      });
      // 높은 인덱스부터 drop (낮은 인덱스 변동 방지)
      for (const idx of checkpointIndices.sort((a, b) => b - a)) {
        spawnSync("git", ["stash", "drop", `stash@{${idx}}`], {
          cwd: projectWorkdir,
          stdio: "pipe",
          timeout: 10_000,
        });
        log.info(`Cleaned up stale nova-checkpoint stash at index ${idx}`);
        cleaned++;
      }
    }
  } catch { /* best effort */ }

  if (cleaned > 0) log.info(`Cleaned up ${cleaned} stale worktrees/branches in ${projectWorkdir}`);
  return cleaned;
}

export function listWorktrees(projectWorkdir: string): string[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 10_000,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.replace("worktree ", ""));
}

/**
 * Goal 단위 공유 worktree 생성 (Goal-as-Unit 모델).
 *
 * 구조: {projectWorkdir}/.nova-worktrees/goal-{goalSlug}-{uid}/
 * Branch: goal/{goalSlug}-{uid}
 *
 * 태스크마다 새 worktree를 만드는 기존 createWorktree()와 달리,
 * Goal 실행 시작 시 1회만 호출하여 해당 Goal의 모든 태스크가 공유한다.
 */
export function createGoalWorktree(
  projectWorkdir: string,
  goalSlug: string,
): WorktreeInfo | null {
  if (!existsSync(join(projectWorkdir, ".git"))) {
    log.info("Not a git repo — skipping goal worktree isolation");
    return null;
  }

  ensureGitignoreHasWorktreeExcludes(projectWorkdir);

  const headCheck = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 5_000,
  });
  if (headCheck.status !== 0) {
    log.warn("No commits in repo — skipping goal worktree isolation");
    return null;
  }

  const safeSlug = slugify(goalSlug).slice(0, 50) || "goal";
  const uid = randomBytes(4).toString("hex");
  const branch = `goal/${safeSlug}-${uid}`;
  const worktreePath = join(projectWorkdir, ".nova-worktrees", `goal-${safeSlug}-${uid}`);

  const result = spawnSync("git", ["worktree", "add", "-b", branch, worktreePath], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 30_000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    log.error(`Failed to create goal worktree: ${stderr}`);
    return null;
  }

  log.info(`Created goal worktree: ${worktreePath} (branch: ${branch})`);
  return { path: worktreePath, branch };
}

/**
 * 태스크 시작 전 stash 체크포인트 생성.
 * 중복 push 방지: 동일 taskId stash가 이미 있으면 false 반환.
 * 변경사항이 없으면 false 반환.
 */
export function stashCheckpoint(worktreePath: string, taskId: string): boolean {
  const label = `nova-checkpoint-${taskId}`;

  // 중복 체크
  const listResult = spawnSync("git", ["stash", "list"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
  });
  if (listResult.status === 0 && listResult.stdout.includes(label)) {
    log.info(`Stash checkpoint already exists for task ${taskId} — skipping`);
    return false;
  }

  // -u: untracked 포함 — 실패 롤백(clean -fd) 후에도 pre-task untracked 를 복원할 수 있어야 한다
  const pushResult = spawnSync("git", ["stash", "push", "-u", "-m", label], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 15_000,
    encoding: "utf-8",
  });

  if (pushResult.status !== 0) {
    log.warn(`stashCheckpoint failed for task ${taskId}: ${pushResult.stderr?.toString()}`);
    return false;
  }

  // "No local changes to save" 처리
  if (pushResult.stdout?.toString().includes("No local changes")) {
    return false;
  }

  // 스냅샷은 롤백용 백업일 뿐 — 작업 트리는 즉시 원상 복구해 goal WIP 를 유지한다.
  // push 만 하고 두면 이전 태스크들의 미커밋 산출물이 사라진 트리에서 다음 태스크가 실행되고,
  // 성공 시 dropCheckpoint 가 stash 를 지우면서 goal 작업물이 영구 소실된다.
  const applyResult = spawnSync("git", ["stash", "apply", "--index", "stash@{0}"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 15_000,
    encoding: "utf-8",
  });
  if (applyResult.status !== 0) {
    // push 직후의 클린 트리라 충돌 여지가 없지만, 만일 실패하면 pop 으로 원복해 WIP 소실을 막는다
    log.warn(`stashCheckpoint apply-back failed for task ${taskId} — popping to restore WIP: ${applyResult.stderr?.toString()}`);
    spawnSync("git", ["stash", "pop", "--index", "stash@{0}"], {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 15_000,
    });
    return false;
  }

  log.info(`Stash checkpoint created for task ${taskId} (tree preserved)`);
  return true;
}

/**
 * 태스크 실패(blocked) 시 stash 체크포인트 복원.
 * stash 목록에서 taskId를 찾아 `git stash pop --index stash@{N}` 수행.
 * 충돌 시 git checkout -- . + git stash drop 후 false 반환.
 */
export function restoreCheckpoint(worktreePath: string, taskId: string): boolean {
  const label = `nova-checkpoint-${taskId}`;

  const listResult = spawnSync("git", ["stash", "list"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
  });

  if (listResult.status !== 0) {
    log.warn(`restoreCheckpoint: git stash list failed for task ${taskId}`);
    return false;
  }

  const lines = listResult.stdout.split("\n").filter(Boolean);
  const idx = lines.findIndex((line) => line.includes(label));

  // 실패한 태스크가 남긴 변경을 먼저 폐기한다 — checkpoint 는 pre-task 스냅샷이다.
  // (stashCheckpoint 가 apply 로 트리를 유지하므로, pop 전에 트리를 비워야 충돌하지 않는다)
  const discardTaskChanges = () => {
    spawnSync("git", ["checkout", "--", "."], { cwd: worktreePath, stdio: "pipe", timeout: 10_000 });
    spawnSync("git", ["clean", "-fd"], { cwd: worktreePath, stdio: "pipe", timeout: 10_000 });
  };

  if (idx === -1) {
    // 스냅샷 없음 = pre-task 트리가 깨끗했음 → 실패 태스크의 변경만 폐기하면 복원 완료
    log.info(`restoreCheckpoint: no checkpoint for task ${taskId} — pre-task tree was clean, discarding task changes`);
    discardTaskChanges();
    return true;
  }

  discardTaskChanges();
  const stashRef = `stash@{${idx}}`;
  const popResult = spawnSync("git", ["stash", "pop", "--index", stashRef], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 15_000,
    encoding: "utf-8",
  });

  if (popResult.status !== 0) {
    // 충돌 발생 — 강제 복구
    log.warn(`restoreCheckpoint conflict for task ${taskId} — forcing checkout`);
    spawnSync("git", ["checkout", "--", "."], { cwd: worktreePath, stdio: "pipe", timeout: 10_000 });
    spawnSync("git", ["stash", "drop", stashRef], { cwd: worktreePath, stdio: "pipe", timeout: 10_000 });
    return false;
  }

  log.info(`Restored stash checkpoint for task ${taskId}`);
  return true;
}

/**
 * 태스크 성공 시 stash 체크포인트 제거.
 * 실패는 무시 (best-effort).
 */
export function dropCheckpoint(worktreePath: string, taskId: string): void {
  const label = `nova-checkpoint-${taskId}`;

  const listResult = spawnSync("git", ["stash", "list"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
  });

  if (listResult.status !== 0) return;

  const lines = listResult.stdout.split("\n").filter(Boolean);
  const idx = lines.findIndex((line) => line.includes(label));
  if (idx === -1) return;

  const stashRef = `stash@{${idx}}`;
  spawnSync("git", ["stash", "drop", stashRef], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
  });

  log.info(`Dropped stash checkpoint for task ${taskId}`);
}

// 한글 보존 slug — engine.ts goalSlug와 동일 문자 클래스 (D-3: 한글 제목이 통째로 소거돼
// goal-goal-xxx 무의미 이름이 되던 문제). NFC 정규화로 macOS NFD 입력도 흡수.
function slugify(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
