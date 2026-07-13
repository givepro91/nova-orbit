import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAgentBranch } from "./github.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("git-workflow");

// ─── Low-level helper ──────────────────────────────────

/**
 * Execute a git command synchronously.
 * Throws on non-zero exit code.
 */
function gitExec(cwd: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "pipe",
    timeout: 30000,
    encoding: "utf-8",
  });

  // git binary not found
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error("git is not installed or not in PATH");
    }
    throw new Error(`git ${args[0]} spawn error: ${result.error.message}`);
  }

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";

  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
  }

  return { stdout, stderr };
}

/**
 * 커밋용 identity(-c) 인자. 사용자가 git user.name/email을 설정했으면 그대로 존중하고,
 * 둘 중 하나라도 없으면 crewdeck 기본값을 주입한다 — git identity가 설정 안 된 환경에서도
 * crewdeck의 commit이 "empty ident name / Author identity unknown"으로 실패하지 않게 한다.
 * (실측: identity 미설정 시 태스크 결과 커밋이 실패 → goal 브랜치가 비어 squash가 막히고
 *  작업물이 worktree에 미반영으로 남는다.)
 */
function commitIdentityArgs(cwd: string): string[] {
  const configured = (key: string): boolean => {
    const r = spawnSync("git", ["config", key], { cwd, stdio: "pipe", timeout: 5000, encoding: "utf-8" });
    return r.status === 0 && !!r.stdout?.toString().trim();
  };
  if (configured("user.name") && configured("user.email")) return [];
  return ["-c", "user.name=Crewdeck Agent", "-c", "user.email=crewdeck-agent@users.noreply.github.com"];
}

/**
 * repo에 커밋 identity가 없으면 로컬 폴백을 설정한다. worktree는 메인 repo의 config를
 * 공유하므로, 이 한 번의 설정으로 crewdeck-run 커밋은 물론 에이전트가 worktree에서 직접
 * 실행하는 git commit(예: squash 충돌 의미기반 해결)까지 identity 미설정 실패를 막는다.
 * 사용자가 이미 identity를 설정했으면(local/global) 건드리지 않는다.
 */
export function ensureGitIdentity(repoDir: string): void {
  const configured = (key: string): boolean => {
    const r = spawnSync("git", ["config", key], { cwd: repoDir, stdio: "pipe", timeout: 5000, encoding: "utf-8" });
    return r.status === 0 && !!r.stdout?.toString().trim();
  };
  if (configured("user.name") && configured("user.email")) return;
  spawnSync("git", ["config", "user.name", "Crewdeck Agent"], { cwd: repoDir, stdio: "pipe", timeout: 5000 });
  spawnSync("git", ["config", "user.email", "crewdeck-agent@users.noreply.github.com"], { cwd: repoDir, stdio: "pipe", timeout: 5000 });
  log.info(`Set fallback git identity for ${repoDir} (no user.name/email configured)`);
}

// ─── Branch detection ──────────────────────────────────

/**
 * Detect the default branch of a git repository.
 * Checks remote HEAD first, then falls back to checking local branches.
 * Returns "main" if detection fails.
 */
export function getDefaultBranch(workdir: string): string {
  // 1. Try remote HEAD (most reliable)
  try {
    const { stdout } = gitExec(workdir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1];
  } catch { /* no remote or no HEAD */ }

  // 2. Check if "main" or "master" exists locally
  try {
    const { stdout } = gitExec(workdir, ["branch", "--list", "main", "master"]);
    const branches = stdout.split("\n").map(b => b.replace(/^\*?\s*/, "").trim()).filter(Boolean);
    if (branches.includes("main")) return "main";
    if (branches.includes("master")) return "master";
  } catch { /* no branches */ }

  // 3. Fallback — check current branch (for repos where HEAD is on a non-standard default)
  try {
    const { stdout } = gitExec(workdir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    if (branch && !branch.startsWith("agent/")) return branch;
  } catch { /* empty repo */ }

  return "main";
}

// ─── Public API ────────────────────────────────────────

/**
 * Directories that Crewdeck and Claude Code manage as linked git worktrees
 * inside the project root. Their HEAD pointer shows up as a gitlink change
 * whenever any worktree commits — but those updates are pure noise for the
 * parent repo. Exclude them from every `git add` to stop polluting main.
 */
const WORKTREE_EXCLUDE_PATHSPECS = [
  ":(exclude,top).crewdeck-worktrees/",
  ":(exclude,top).claude/worktrees/",
];

/**
 * Directory names Crewdeck/Claude manage as linked worktrees. Used to auto-clean
 * residue when a non-worktree phase (reviewer/qa running at project root)
 * accidentally stages them.
 */
export const WORKTREE_DIR_NAMES = [".crewdeck-worktrees", ".claude/worktrees"];

/**
 * Git error classification for autopilot recovery decisions.
 *
 * - recoverable: transient/fixable errors that should NOT permanently block a
 *   task (ignored-file, nothing-to-commit, lock contention). Autopilot should
 *   either auto-fix or soft-retry.
 * - permanent: errors where the same agent + same worktree + same input will
 *   produce the same failure forever (merge conflict, branch already exists,
 *   corrupted index). Skip to next task to avoid budget burn.
 * - benign: not actually an error — no-op completion.
 */
export type GitErrorClass = "recoverable" | "permanent" | "benign";

export interface ClassifiedGitError {
  class: GitErrorClass;
  code: string;
  recoveryHint?: string;
}

/**
 * Classify a git error message so the orchestrator can decide whether to
 * auto-recover, retry, or permanently block a task. Autopilot default stance:
 * prefer recoverable, escalate to permanent only for known-unrecoverable cases.
 */
export function classifyGitError(message: string): ClassifiedGitError {
  const m = message.toLowerCase();

  // Benign — nothing actually wrong
  if (m.includes("nothing to commit") || m.includes("no changes added")) {
    return { class: "benign", code: "nothing-to-commit" };
  }

  // Recoverable — auto-clean and retry
  if (m.includes("ignored by") && m.includes(".gitignore")) {
    return {
      class: "recoverable",
      code: "ignored-file",
      recoveryHint: "Remove ignored worktree residue from staging and re-run add with --ignore-errors",
    };
  }
  if (m.includes("index.lock") || m.includes("unable to create") && m.includes("lock")) {
    return {
      class: "recoverable",
      code: "index-lock",
      recoveryHint: "Wait briefly and retry; another git process was mid-operation",
    };
  }
  if (m.includes("would be overwritten by merge") || m.includes("local changes would be overwritten")) {
    return {
      class: "recoverable",
      code: "local-changes-overwrite",
      recoveryHint: "Stash or commit working tree residue before the merge/checkout",
    };
  }

  // Permanent — same input will keep failing
  if (m.includes("merge conflict") || m.includes("automatic merge failed") || m.includes("conflict (")) {
    return { class: "permanent", code: "merge-conflict" };
  }
  if (m.includes("already exists") && m.includes("branch")) {
    return { class: "permanent", code: "branch-exists" };
  }
  if (m.includes("fatal: not a git repository")) {
    return { class: "permanent", code: "not-a-repo" };
  }
  if (m.includes("refusing to merge unrelated histories")) {
    return { class: "permanent", code: "unrelated-histories" };
  }
  if (m.includes("authentication failed") || m.includes("permission denied (publickey)")) {
    return { class: "permanent", code: "auth-failed" };
  }

  // Unknown — default to recoverable so autopilot gives it a retry instead of
  // burning the task. The scheduler's normal retry budget applies.
  return { class: "recoverable", code: "unknown" };
}

/**
 * Stage all changes and create a commit.
 * Returns { committed: false } when there are no staged changes.
 */
export function commitTaskResult(
  workdir: string,
  taskTitle: string,
  agentName: string,
): { committed: boolean; filesChanged: number } {
  // Detect changes (excluding worktree pointer noise). Without the excludes a
  // task running at project root picks up every sibling worktree's HEAD
  // advance and commits them as gitlink updates — causing either spurious
  // "nothing to commit" errors or empty noise commits (see bug: reviewer
  // tasks being double-executed because their 1st commit committed only a
  // worktree pointer).
  //
  // `-z` gives NUL-separated, unquoted paths — safe for paths with spaces,
  // newlines, or unicode. We parse these into explicit paths and use them to
  // stage. Critically, this avoids `git add -A -- . :(exclude)` which emits
  // "paths ignored by .gitignore" errors when Crewdeck's managed directories
  // (.crewdeck-worktrees/, .claude/worktrees/) exist with content — status
  // already excluded them so explicit add of status-listed paths can't hit
  // an ignored-file error. (Incident: locale-aware reviewer tasks permanent-
  // blocked despite completing their work because of this edge case.)
  const { stdout: statusOutput } = gitExec(workdir, [
    "status",
    "--porcelain",
    "-z",
    "--",
    ".",
    ...WORKTREE_EXCLUDE_PATHSPECS,
  ]);
  if (!statusOutput) {
    log.info("No changes to commit");
    return { committed: false, filesChanged: 0 };
  }

  // Parse NUL-separated porcelain records. Rename/copy entries span two
  // records: [new-path, old-path] — we only stage the new path.
  const records = statusOutput.split("\0").filter(Boolean);
  const dirtyPaths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 3) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    dirtyPaths.push(path);
    // Rename (R) / copy (C) — skip the following old-path record
    if (xy[0] === "R" || xy[0] === "C") i++;
  }

  if (dirtyPaths.length === 0) {
    log.info("No stageable paths after parse — skipping commit");
    return { committed: false, filesChanged: 0 };
  }

  const filesChanged = dirtyPaths.length;

  // Warn if no .gitignore — risk of committing secrets/node_modules
  if (!existsSync(join(workdir, ".gitignore"))) {
    log.warn(`No .gitignore found in ${workdir} — add may stage unwanted files`);
  }

  // Stage ONLY the paths surfaced by status (already exclude-filtered).
  // This replaces the old `git add -A -- . :(exclude)` pattern which could
  // hit "ignored by .gitignore" errors at pathspec-match time.
  gitExec(workdir, ["add", "--", ...dirtyPaths]);

  // Re-verify there's actually something staged.
  const { stdout: stagedDiff } = gitExec(workdir, ["diff", "--cached", "--name-only"]);
  if (!stagedDiff.trim()) {
    log.info("No staged changes after add — skipping commit");
    return { committed: false, filesChanged: 0 };
  }

  // Commit — title은 단일 행으로 sanitize
  const safeTitle = taskTitle.replace(/[\r\n]+/g, " ").slice(0, 72);
  const safeAgent = agentName.replace(/[\r\n]+/g, " ").slice(0, 50);
  const message = `feat(crewdeck-agent): ${safeTitle}\n\nAgent: ${safeAgent}\nGenerated by Crewdeck`;
  gitExec(workdir, [...commitIdentityArgs(workdir), "commit", "-m", message]);

  log.info(`Committed ${filesChanged} file(s): ${taskTitle}`);
  return { committed: true, filesChanged };
}

/**
 * Push the given branch to origin.
 * Returns false (logs only) on failure — never throws.
 */
/**
 * origin에 push 권한이 있는 로컬 gh 계정의 토큰을 찾아 반환한다.
 * 특정 계정을 하드코딩하지 않는다 — 사용자가 로컬에 로그인해 둔 gh 계정들 중
 * 이 repo에 접근 가능한 것을 자동 선택한다(활성/비활성 무관). 다른 사용자가
 * crewdeck을 써도 그 사람의 계정 기준으로 동작한다. 못 찾으면 null →
 * 호출부는 ambient 자격증명(git/gh 기본 동작)으로 진행한다.
 */
export function resolveGitHubToken(workdir: string): string | null {
  const urlRes = spawnSync("git", ["remote", "get-url", "origin"], { cwd: workdir, stdio: "pipe", timeout: 5000, encoding: "utf-8" });
  const url = urlRes.stdout?.toString().trim() ?? "";
  const m = url.match(/github\.com[:/]([^/]+)\/([^/\s.]+)/);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;

  const statusRes = spawnSync("gh", ["auth", "status"], { stdio: "pipe", timeout: 8000, encoding: "utf-8" });
  const statusText = (statusRes.stdout?.toString() ?? "") + (statusRes.stderr?.toString() ?? "");
  const accounts = [...new Set([...statusText.matchAll(/account ([A-Za-z0-9-]+)/g)].map((mm) => mm[1]))];
  if (accounts.length === 0) return null;

  for (const acct of accounts) {
    const tok = spawnSync("gh", ["auth", "token", "-u", acct], { stdio: "pipe", timeout: 5000, encoding: "utf-8" }).stdout?.toString().trim();
    if (!tok) continue;
    const perm = spawnSync("gh", ["api", `repos/${repo}`, "--jq", ".permissions.push"], {
      env: { ...process.env, GH_TOKEN: tok, GH_HOST: "github.com" },
      stdio: "pipe", timeout: 8000, encoding: "utf-8",
    }).stdout?.toString().trim();
    if (perm === "true") {
      log.info(`Resolved gh account with push access to ${repo}: ${acct}`);
      return tok;
    }
  }
  log.warn(`No local gh account has push access to ${repo} — using ambient credentials`);
  return null;
}

export function pushBranch(workdir: string, branch: string, token?: string | null): { ok: boolean; error?: string } {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const result = spawnSync("git", ["push", "-u", "origin", branch], {
    cwd: workdir, stdio: "pipe", timeout: 30000, encoding: "utf-8", env,
  });
  if (result.status === 0) {
    log.info(`Pushed branch: ${branch}`);
    return { ok: true };
  }
  // git의 실제 사유를 그대로 surface — 원격 거부(권한/스코프/non-fast-forward 등)를
  // "Failed to push branch"로 뭉개지 않게 한다. 노이즈 라인은 걷어내고 핵심만 남긴다.
  const raw = (result.stderr?.toString().trim() || result.stdout?.toString().trim() || result.error?.message || "unknown");
  const detail = raw
    .split("\n")
    .filter((l) => l.trim() && !/^To https?:\/\//.test(l.trim()))
    .join(" ")
    .slice(0, 500);
  log.warn(`push failed: ${detail}`);
  return { ok: false, error: detail };
}

/**
 * Merge a branch into the target branch at the project root (not worktree).
 * Used by main_direct mode: worktree branch → main merge.
 */
export function mergeBranch(projectWorkdir: string, sourceBranch: string, targetBranch: string): boolean {
  try {
    gitExec(projectWorkdir, ["checkout", targetBranch]);
    gitExec(projectWorkdir, ["merge", sourceBranch, "--no-ff", "-m", `Merge ${sourceBranch} into ${targetBranch}`]);
    log.info(`Merged ${sourceBranch} → ${targetBranch}`);
    return true;
  } catch (err: any) {
    log.error(`Merge failed (${sourceBranch} → ${targetBranch}): ${err.message}`);
    // Abort merge if in conflict state
    try { gitExec(projectWorkdir, ["merge", "--abort"]); } catch { /* no merge to abort */ }
    try { gitExec(projectWorkdir, ["checkout", targetBranch]); } catch { /* best effort */ }
    return false;
  }
}

/**
 * Sequential merge — 동시 merge 호출 시 큐잉하여 순서대로 실행.
 * git checkout + merge는 atomic하지 않으므로 동시 실행 시 깨질 수 있음.
 * Node.js 단일 프로세스이므로 모듈 레벨 Promise chain이면 충분.
 */
let mergeLock: Promise<void> = Promise.resolve();

export function mergeBranchSequential(
  projectWorkdir: string,
  sourceBranch: string,
  targetBranch: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    mergeLock = mergeLock
      .then(() => {
        resolve(mergeBranch(projectWorkdir, sourceBranch, targetBranch));
      })
      .catch(() => {
        resolve(false);
      });
  });
}

/**
 * Create a pull request via the gh CLI.
 * Returns the PR URL on success, null on failure.
 */
export function createPR(
  workdir: string,
  branch: string,
  title: string,
  body: string,
  token?: string | null,
): string | null {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const result = spawnSync(
    "gh",
    ["pr", "create", "--head", branch, "--title", title, "--body", body],
    { cwd: workdir, stdio: "pipe", timeout: 30000, encoding: "utf-8", env },
  );

  if (result.status === 0) {
    const url = result.stdout?.toString().trim();
    log.info(`PR created: ${url}`);
    return url || null;
  }

  // spawn 자체 실패(ENOENT 등) = gh CLI 미설치 — stderr가 비어 원인이 숨는다
  if (result.error) {
    log.warn(`gh pr create failed: ${result.error.message} — gh CLI가 설치/인증되어 있는지 확인 필요`);
    return null;
  }
  const stderr = result.stderr?.toString() ?? "";
  // 재승인 idempotency: 이미 같은 브랜치로 PR이 열려 있으면 gh가 "already exists: <url>"을
  // 반환한다 — 그 URL을 재사용해 중복 생성/실패를 피한다.
  if (/already exists/i.test(stderr)) {
    const m = stderr.match(/(https?:\/\/\S*?\/pull\/\d+)/);
    if (m) {
      log.info(`PR already exists, reusing: ${m[1]}`);
      return m[1];
    }
  }
  log.warn(`gh pr create failed: ${stderr.trim()}`);
  return null;
}

/**
 * PR URL에서 번호 추출 (.../pull/123 → 123). 실패 시 null.
 */
export function parsePrNumber(prUrl: string | null): number | null {
  if (!prUrl) return null;
  const m = prUrl.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * base 브랜치에 branch protection 규칙이 걸려 있는지 best-effort 조회.
 *   gh api repos/{owner}/{repo}/branches/{branch}/protection
 *   200 → 'protected' / 404 → 'unprotected' / 403·기타 → 'unknown'(조회 권한 없음 등)
 * auto 모드 힌트: 'protected'면 직접 push를 생략하고 곧장 PR로 간다(왕복 회피 — admin이
 * bypass 가능한 protection도 PR로 강등되는 과보수 트레이드오프). unprotected/unknown이면
 * 직접 push를 시도하고 실패 시 처리(main_direct=error). 조회 자체가 실패(unknown)해도 무해하다.
 */
export function checkBranchProtection(
  workdir: string,
  branch: string,
  token?: string | null,
): "protected" | "unprotected" | "unknown" {
  const urlRes = spawnSync("git", ["remote", "get-url", "origin"], { cwd: workdir, stdio: "pipe", timeout: 5000, encoding: "utf-8" });
  const url = urlRes.stdout?.toString().trim() ?? "";
  const m = url.match(/github\.com[:/]([^/]+)\/([^/\s.]+)/);
  if (!m) return "unknown";
  const repo = `${m[1]}/${m[2]}`;
  const env = token ? { ...process.env, GH_TOKEN: token, GH_HOST: "github.com" } : process.env;
  const res = spawnSync("gh", ["api", `repos/${repo}/branches/${branch}/protection`], {
    env, stdio: "pipe", timeout: 8000, encoding: "utf-8",
  });
  if (res.status === 0) return "protected";
  const err = (res.stderr?.toString() ?? "") + (res.stdout?.toString() ?? "");
  if (/404|Not Found|not protected/i.test(err)) return "unprotected";
  return "unknown";
}

/**
 * PR의 현재 상태를 gh로 조회. 'open' | 'merged' | 'closed' | null(조회 실패).
 *   gh pr view <n|url> --json state  →  state: OPEN|MERGED|CLOSED
 */
export function refreshPrState(
  workdir: string,
  prRef: string,
  token?: string | null,
): "open" | "merged" | "closed" | null {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const res = spawnSync("gh", ["pr", "view", prRef, "--json", "state"], {
    cwd: workdir, env, stdio: "pipe", timeout: 15000, encoding: "utf-8",
  });
  if (res.status !== 0) return null;
  try {
    const j = JSON.parse(res.stdout?.toString() ?? "{}");
    const s = String(j.state ?? "").toUpperCase();
    if (s === "MERGED") return "merged";
    if (s === "CLOSED") return "closed";
    if (s === "OPEN") return "open";
    return null;
  } catch { return null; }
}

// ─── Goal-as-Unit: Squash Merge ────────────────────────

export interface SquashMergeResult {
  sha: string | null;
  prUrl: string | null;
  /** 실제 반영 형태 — 성공 시 세팅. applied=origin 반영 / pr_open=PR 생성·머지대기 / local=로컬만. */
  outcome?: "applied" | "pr_open" | "local";
  /** pr_open일 때 PR 번호 (이후 상태 조회용). */
  prNumber?: number | null;
  error?: string;
  /** 재시작 전에 이미 생성된 squash commit을 재사용했는지 */
  reused?: boolean;
  /** merge 자체는 성공/실패했지만 사용자에게 알릴 부수 상황 (예: 보존한 로컬 변경 복원 충돌) */
  warning?: string;
}

export interface CommitRecoveryEvidence {
  status: "recorded" | "promote" | "not_created" | "manual_action_required";
  commitSha: string | null;
  reason?: string;
}

function isCanonicalCommitSha(workdir: string, sha: string): boolean {
  if (!/^[0-9a-f]{40}$/.test(sha)) return false;
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
    cwd: workdir,
    stdio: "pipe",
    timeout: 5_000,
  });
  return result.status === 0;
}

function isAncestor(workdir: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: workdir,
    stdio: "pipe",
    timeout: 5_000,
  });
  return result.status === 0;
}

function treesMatch(workdir: string, left: string, right: string): boolean {
  const result = spawnSync("git", ["diff", "--quiet", `${left}^{tree}`, `${right}^{tree}`], {
    cwd: workdir,
    stdio: "pipe",
    timeout: 10_000,
  });
  return result.status === 0;
}

/**
 * Task commit 생성 후 DB 기록 전 종료를 판별한다.
 * checkpoint HEAD의 정확히 한 commit 뒤이고 worktree가 clean할 때만 승격한다.
 */
export function recoverTaskCommitEvidence(
  worktreePath: string,
  checkpointHeadSha: string,
  recordedTaskCommitSha?: string | null,
): CommitRecoveryEvidence {
  try {
    if (!isCanonicalCommitSha(worktreePath, checkpointHeadSha)) {
      return { status: "manual_action_required", commitSha: null, reason: "checkpoint HEAD commit is missing" };
    }

    const status = gitExec(worktreePath, ["status", "--porcelain=v1"]).stdout.trim();
    if (status) {
      return { status: "manual_action_required", commitSha: null, reason: "worktree is dirty; commit evidence is ambiguous" };
    }

    if (recordedTaskCommitSha) {
      if (!isCanonicalCommitSha(worktreePath, recordedTaskCommitSha)) {
        return { status: "manual_action_required", commitSha: null, reason: "recorded task commit is missing" };
      }
      const head = gitExec(worktreePath, ["rev-parse", "HEAD"]).stdout.trim();
      const recordedCount = Number(gitExec(
        worktreePath,
        ["rev-list", "--count", `${checkpointHeadSha}..${recordedTaskCommitSha}`],
      ).stdout.trim());
      if (recordedCount !== 1
        || !isAncestor(worktreePath, checkpointHeadSha, recordedTaskCommitSha)
        || head !== recordedTaskCommitSha) {
        return { status: "manual_action_required", commitSha: null, reason: "worktree HEAD does not match recorded task commit" };
      }
      return { status: "recorded", commitSha: recordedTaskCommitSha };
    }

    const head = gitExec(worktreePath, ["rev-parse", "HEAD"]).stdout.trim();
    if (head === checkpointHeadSha) return { status: "not_created", commitSha: null };
    if (!isAncestor(worktreePath, checkpointHeadSha, head)) {
      return { status: "manual_action_required", commitSha: null, reason: "worktree HEAD diverged from checkpoint HEAD" };
    }
    const count = Number(gitExec(worktreePath, ["rev-list", "--count", `${checkpointHeadSha}..${head}`]).stdout.trim());
    if (count !== 1) {
      return { status: "manual_action_required", commitSha: null, reason: `expected one task commit after checkpoint, found ${count}` };
    }
    return { status: "promote", commitSha: head };
  } catch (err: any) {
    return { status: "manual_action_required", commitSha: null, reason: err.message ?? String(err) };
  }
}

/**
 * goalBranch가 체크아웃된 linked worktree 경로를 read-only로 찾는다. 없으면 null.
 * squash 재사용(promote/recorded) 판정 전에 그 worktree에 사용자 미커밋 변경(WIP)이
 * 남았는지 확인하기 위함 — 재사용 판정은 removeWorktree(--force)로 이어지기 때문.
 */
function findGoalWorktreePath(projectWorkdir: string, goalBranch: string): string | null {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  const targetRef = `refs/heads/${goalBranch}`;
  let currentPath: string | null = null;
  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === targetRef) {
      return currentPath;
    }
  }
  return null;
}

/**
 * worktree에 tracked/untracked 미커밋 변경(WIP)이 있는지 read-only로 검사한다.
 * `git status --porcelain=v1 -z` 출력이 비어 있지 않으면 dirty. worktree가 없으면 false.
 * status를 읽을 수 없으면(손상 등) 판정 불가이므로 안전하게 true(수동 조치)로 취급한다.
 */
export function worktreeHasUncommittedChanges(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
  });
  if (result.status !== 0) return true;
  return !!(result.stdout && result.stdout.length > 0);
}

/**
 * Squash commit 생성 후 DB 기록 전 종료를 read-only로 판별한다.
 * base HEAD가 checkpoint base의 정확히 한 commit 뒤이며 goal tree와 같을 때만 재사용한다.
 * goalWorktreePath(미전달 시 goalBranch로 자동 해석)에 사용자 미커밋 WIP가 있으면
 * promote/recorded 판정을 취소하고 수동 조치로 차단한다 — 재사용은 worktree 삭제로 이어져
 * WIP를 영구 파괴하기 때문.
 */
export function recoverSquashCommitEvidence(
  projectWorkdir: string,
  baseBranch: string,
  goalBranch: string,
  checkpointBaseSha: string,
  recordedSquashCommitSha?: string | null,
  goalWorktreePath?: string | null,
): CommitRecoveryEvidence {
  try {
    // 재사용(promote/recorded) 직전에만 적용하는 WIP 보존 가드. dirty면 재사용을 막고
    // 수동 조치로 차단한다 (승인 재개 경로가 removeWorktree로 WIP를 지우지 못하게).
    const resolvedWorktree = goalWorktreePath ?? findGoalWorktreePath(projectWorkdir, goalBranch);
    const dirtyGuard = (): CommitRecoveryEvidence | null =>
      resolvedWorktree && worktreeHasUncommittedChanges(resolvedWorktree)
        ? { status: "manual_action_required", commitSha: null, reason: "goal worktree has uncommitted changes (WIP); reuse would discard them" }
        : null;

    if (!isCanonicalCommitSha(projectWorkdir, checkpointBaseSha)) {
      return { status: "manual_action_required", commitSha: null, reason: "checkpoint base commit is missing" };
    }
    const baseHead = gitExec(projectWorkdir, ["rev-parse", baseBranch]).stdout.trim();
    if (recordedSquashCommitSha) {
      if (!isCanonicalCommitSha(projectWorkdir, recordedSquashCommitSha)) {
        return { status: "manual_action_required", commitSha: null, reason: "recorded squash commit is missing" };
      }
      const recordedCount = Number(gitExec(
        projectWorkdir,
        ["rev-list", "--count", `${checkpointBaseSha}..${recordedSquashCommitSha}`],
      ).stdout.trim());
      if (recordedCount !== 1
        || !isAncestor(projectWorkdir, checkpointBaseSha, recordedSquashCommitSha)
        || !isAncestor(projectWorkdir, recordedSquashCommitSha, baseHead)) {
        return { status: "manual_action_required", commitSha: null, reason: "recorded squash commit is not on the base branch" };
      }
      if (!treesMatch(projectWorkdir, recordedSquashCommitSha, goalBranch)) {
        return { status: "manual_action_required", commitSha: null, reason: "recorded squash commit tree does not match goal branch tree" };
      }
      return dirtyGuard() ?? { status: "recorded", commitSha: recordedSquashCommitSha };
    }
    if (baseHead === checkpointBaseSha) return { status: "not_created", commitSha: null };
    if (!isAncestor(projectWorkdir, checkpointBaseSha, baseHead)) {
      return { status: "manual_action_required", commitSha: null, reason: "base branch diverged from checkpoint" };
    }
    const count = Number(gitExec(projectWorkdir, ["rev-list", "--count", `${checkpointBaseSha}..${baseHead}`]).stdout.trim());
    if (count !== 1) {
      return { status: "manual_action_required", commitSha: null, reason: `expected one squash commit after base checkpoint, found ${count}` };
    }
    if (!treesMatch(projectWorkdir, baseHead, goalBranch)) {
      return { status: "manual_action_required", commitSha: null, reason: "base HEAD tree does not match goal branch tree" };
    }
    return dirtyGuard() ?? { status: "promote", commitSha: baseHead };
  } catch (err: any) {
    return { status: "manual_action_required", commitSha: null, reason: err.message ?? String(err) };
  }
}

export interface SquashMergeRecoveryOptions {
  existingSquashSha?: string | null;
  checkpointBaseSha?: string | null;
}

/**
 * pr 경로 공통: goal 브랜치를 push하고 PR을 생성한다 (base 미변형).
 * pr 모드와 auto 폴백이 공유. createPR이 already-exists를 감지하면 그 URL을 재사용(재승인 idempotent).
 */
function prPath(
  workdir: string,
  goalBranch: string,
  commitMessage: string,
  token: string | null,
): SquashMergeResult {
  const pushed = pushBranch(workdir, goalBranch, token);
  if (!pushed.ok) {
    return { sha: null, prUrl: null, error: `브랜치 push 실패 (${goalBranch}): ${pushed.error ?? "unknown"}` };
  }
  const title = commitMessage.split("\n")[0] ?? goalBranch;
  const prUrl = createPR(workdir, goalBranch, title, commitMessage, token);
  if (!prUrl) {
    // 조용히 성공으로 넘기면 사용자는 PR이 생긴 줄 안다 — 명시적으로 실패 반환
    return {
      sha: null, prUrl: null,
      error: `PR 생성 실패 (브랜치 ${goalBranch}는 push됨) — gh CLI 설치/인증 및 원격 저장소 설정을 확인하세요`,
    };
  }
  return { sha: null, prUrl, outcome: "pr_open", prNumber: parsePrNumber(prUrl) };
}

/**
 * Goal 완료 시 goal 브랜치를 squash merge.
 *
 * 모드 (반환 SquashMergeResult.outcome):
 *   local_only   → main 체크아웃 → git merge --squash → git commit (push 없음).           outcome=local
 *   branch_only  → local_only와 동일 (push 없음).                                          outcome=local
 *   main_direct  → squash merge → git push origin main. push 실패 시 reset하지 않고
 *                  error 반환(호출부 blocked, worktree 보존) — 조용한 성공 위장 금지.       outcome=applied | error
 *   auto         → base 건드리기 전 선검증: push 권한 있고 branch protection 없으면
 *                  main_direct처럼 반영, 아니면(권한 없음/protected) base 미변형으로
 *                  goal 브랜치만 push→PR. (F1: 커밋 후 reset하는 파괴적 폴백을 피한다)      outcome=applied | pr_open
 *   pr           → goal 브랜치 push → gh pr create (base 미변형, 사용자가 GitHub에서 머지). outcome=pr_open
 *                  참고: gh CLI 는 `gh pr create --squash` 옵션을 제공하지 않는다.
 *                  squash merge 는 PR 생성 후 `gh pr merge --squash` 또는 GitHub UI 에서만 가능.
 *
 * goalBranch 삭제는 squash 성공 후 호출부에서 수행.
 */
export function squashMergeGoal(
  projectWorkdir: string,
  goalBranch: string,
  commitMessage: string,
  mode: GitMode,
  baseBranch?: string,
  recovery: SquashMergeRecoveryOptions = {},
): SquashMergeResult {
  try {
    if (mode === "pr") {
      // origin 접근 권한 있는 로컬 gh 계정을 자동 선택(하드코딩 없음) → push·PR 모두 그 계정으로.
      // goal 브랜치 push → PR 생성 (사용자가 GitHub UI에서 squash-merge 선택). base 미변형.
      return prPath(projectWorkdir, goalBranch, commitMessage, resolveGitHubToken(projectWorkdir));
    }

    // local_only / main_direct / branch_only: squash merge to base branch
    let defaultBranch: string;
    if (baseBranch) {
      defaultBranch = baseBranch;
    } else {
      try {
        defaultBranch = getDefaultBranch(projectWorkdir);
      } catch {
        defaultBranch = "main";
      }
    }

    if (recovery.existingSquashSha) {
      const existing = recovery.existingSquashSha;
      if (!isCanonicalCommitSha(projectWorkdir, existing)) {
        return { sha: null, prUrl: null, error: `Recorded squash commit is missing: ${existing}` };
      }
      const checkpoint = recovery.checkpointBaseSha;
      if (!checkpoint || !isCanonicalCommitSha(projectWorkdir, checkpoint)) {
        return { sha: null, prUrl: null, error: "Squash checkpoint base commit is missing" };
      }
      const commitCount = Number(gitExec(
        projectWorkdir,
        ["rev-list", "--count", `${checkpoint}..${existing}`],
      ).stdout.trim());
      if (commitCount !== 1 || !isAncestor(projectWorkdir, checkpoint, existing)) {
        return { sha: null, prUrl: null, error: `Recorded squash commit is not directly after checkpoint ${checkpoint}: ${existing}` };
      }
      const baseHead = gitExec(projectWorkdir, ["rev-parse", defaultBranch]).stdout.trim();
      if (!isAncestor(projectWorkdir, existing, baseHead)) {
        return { sha: null, prUrl: null, error: `Recorded squash commit is not on ${defaultBranch}: ${existing}` };
      }
      if (!treesMatch(projectWorkdir, existing, goalBranch)) {
        return { sha: null, prUrl: null, error: `Recorded squash commit tree does not match ${goalBranch}: ${existing}` };
      }
      if (mode === "main_direct" || mode === "auto") {
        const pushed = pushBranch(projectWorkdir, defaultBranch, mode === "auto" ? resolveGitHubToken(projectWorkdir) : undefined);
        if (!pushed.ok) {
          return { sha: null, prUrl: null, error: `Squash commit push failed (${defaultBranch}): ${pushed.error ?? "unknown"}` };
        }
        log.info(`squashMergeGoal: reusing existing squash commit ${existing}`);
        return { sha: existing, prUrl: null, outcome: "applied", reused: true };
      }
      log.info(`squashMergeGoal: reusing existing squash commit ${existing}`);
      return {
        sha: existing, prUrl: null,
        outcome: (mode === "local_only" || mode === "branch_only") ? "local" : "applied",
        reused: true,
      };
    }

    // ── auto 선검증: base를 건드리기 전에 직접 반영 가능한지 판정 ──
    // (F1: push 실패 후 reset --hard로 되돌리는 파괴적 폴백을 피한다 — base 미변형이면
    //  되돌릴 것이 없다. reset --hard는 이 레포가 금지한 패턴이다: 2026-07-08 .gitignore 인시던트.)
    let token: string | null = null;
    let pushBase = (mode === "main_direct");
    if (mode === "auto") {
      token = resolveGitHubToken(projectWorkdir);
      const prot = checkBranchProtection(projectWorkdir, defaultBranch, token);
      if (!token || prot === "protected") {
        // 직접 push 불가(권한 없음 / branch protection) → base 미변형, goal 브랜치만 push→PR
        return prPath(projectWorkdir, goalBranch, commitMessage, token);
      }
      pushBase = true; // unprotected + push 권한 → 직접 반영 시도
    }

    // ── 사용자 잔여 보존 가드 ──
    // base 브랜치 작업 트리에 커밋되지 않은 tracked 변경이 있으면 merge가
    // "would be overwritten by merge"로 거부된다. 과거 복구 로직(reset --hard)은
    // 그 변경을 조용히 파괴했다 (2026-07-08 .gitignore 인시던트). merge 전에
    // stash로 보존하고 종료 시 복원한다. untracked는 merge를 막지 않으니 두 손 안 댄다.
    let stashedResidue = false;
    try {
      const dirty = gitExec(projectWorkdir, ["status", "--porcelain"]).stdout
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("??"));
      if (dirty.length > 0) {
        gitExec(projectWorkdir, ["stash", "push", "-m", "crewdeck-squash-guard"]);
        stashedResidue = true;
        log.info(`squashMergeGoal: stashed ${dirty.length} dirty tracked file(s) before merge`);
      }
    } catch (err: any) {
      log.warn(`squashMergeGoal: residue stash guard failed — ${err.message}`);
    }

    // 보존한 잔여 복원 — pop 충돌 시 half-apply 상태만 걷어내고 stash에 남긴다 (파괴 금지)
    const restoreResidue = (): string | undefined => {
      if (!stashedResidue) return undefined;
      try {
        gitExec(projectWorkdir, ["stash", "pop"]);
        return undefined;
      } catch {
        try { gitExec(projectWorkdir, ["reset", "--merge"]); } catch { /* best effort */ }
        log.warn("squashMergeGoal: stash pop conflicted — residue kept in stash (crewdeck-squash-guard)");
        return "merge 전 보존한 로컬 변경 복원이 충돌했습니다 — `git stash pop`으로 수동 복원하세요 (stash: crewdeck-squash-guard)";
      }
    };

    // base branch 체크아웃
    try {
      gitExec(projectWorkdir, ["checkout", defaultBranch]);
    } catch (err: any) {
      return { sha: null, prUrl: null, error: `Failed to checkout ${defaultBranch}: ${err.message}`, warning: restoreResidue() };
    }

    // squash merge
    try {
      gitExec(projectWorkdir, ["merge", "--squash", goalBranch]);
    } catch (err: any) {
      // 복구: 진행 중 merge 상태만 해제. reset --merge는 merge와 무관한 로컬 변경을
      // 보존한다 — reset --hard는 사용자 uncommitted 변경까지 파괴하므로 금지.
      try { gitExec(projectWorkdir, ["merge", "--abort"]); } catch { /* squash merge는 MERGE_HEAD를 만들지 않는다 */ }
      try { gitExec(projectWorkdir, ["reset", "--merge"]); } catch { /* best effort */ }
      return { sha: null, prUrl: null, error: `Squash merge failed: ${err.message}`, warning: restoreResidue() };
    }

    // commit
    let sha: string | null = null;
    try {
      gitExec(projectWorkdir, [...commitIdentityArgs(projectWorkdir), "commit", "-m", commitMessage]);
      // 커밋 SHA 조회
      const shaResult = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: projectWorkdir,
        stdio: "pipe",
        timeout: 5_000,
        encoding: "utf-8",
      });
      sha = shaResult.status === 0 ? shaResult.stdout.trim().slice(0, 40) : null;
    } catch (err: any) {
      // nothing to commit은 benign
      if (err.message?.includes("nothing to commit") || err.message?.includes("no changes added")) {
        return { sha: null, prUrl: null, error: "nothing-to-commit", warning: restoreResidue() };
      }
      return { sha: null, prUrl: null, error: `Commit failed: ${err.message}`, warning: restoreResidue() };
    }

    const warning = restoreResidue();

    // ── 반영 ──
    if (pushBase) {
      // main_direct(항상) 또는 auto(선검증 통과) — origin에 직접 push
      const pushed = pushBranch(projectWorkdir, defaultBranch, token ?? undefined);
      if (pushed.ok) {
        log.info(`squashMergeGoal: ${goalBranch} → ${defaultBranch} pushed (sha=${sha}, mode=${mode})`);
        return { sha, prUrl: null, outcome: "applied", warning };
      }
      // F1: push 실패해도 reset하지 않는다 — base의 로컬 squash commit은 보존하고
      // 정직하게 error를 반환한다. 호출부가 blocked 처리 + worktree 보존하며, 재승인 시
      // recovery 경로가 이 커밋을 재사용해 재push한다(무한 재squash·이중 반영 방지).
      log.warn(`squashMergeGoal: direct push failed (${defaultBranch}): ${pushed.error} — blocked (sha=${sha})`);
      return {
        sha, prUrl: null,
        error: `직접 push 실패 (${defaultBranch}): ${pushed.error ?? "unknown"} — 권한/branch protection 확인, 또는 gitMode를 'pr'/'auto'로 변경`,
        warning,
      };
    }

    // local_only / branch_only — 로컬에만 반영
    log.info(`squashMergeGoal: ${goalBranch} → ${defaultBranch} (sha=${sha}, mode=${mode}, local)`);
    return { sha, prUrl: null, outcome: "local", warning };
  } catch (err: any) {
    log.error(`squashMergeGoal unexpected error: ${err.message}`);
    return { sha: null, prUrl: null, error: err.message ?? String(err) };
  }
}

// ─── Goal-as-Unit: integration-time sync helpers ───────
// goal 브랜치는 생성 시점 base에 고정된다. goal 수명주기 동안 base가 전진하면
// (다른 goal squash, 사용자 직접 커밋) squash가 충돌로 실패하므로, 승인 시점에
// divergence를 감지해 base를 goal worktree로 merge-in한 뒤 squash한다.

/** base가 goal 분기 이후 전진했는가 (merge-base ≠ base HEAD). 판정 불가 시 false — 기존 경로 유지. */
export function detectDivergence(projectWorkdir: string, baseBranch: string, goalBranch: string): boolean {
  try {
    const mergeBase = gitExec(projectWorkdir, ["merge-base", baseBranch, goalBranch]).stdout.trim();
    const baseHead = gitExec(projectWorkdir, ["rev-parse", baseBranch]).stdout.trim();
    return mergeBase !== "" && baseHead !== "" && mergeBase !== baseHead;
  } catch {
    return false;
  }
}

/** read-only 충돌 예측 (git merge-tree --write-tree, git ≥ 2.38). exit 0 = 클린, 그 외 = 충돌로 간주. */
export function predictMergeConflict(projectWorkdir: string, baseBranch: string, goalBranch: string): boolean {
  const result = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", baseBranch, goalBranch], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 30_000,
    encoding: "utf-8",
  });
  return result.status !== 0;
}

/** goal worktree에서 base를 merge-in (충돌 없는 케이스 전용). 실패 시 abort 후 실패 반환. */
export function mergeBaseIntoWorktree(worktreePath: string, baseBranch: string): { merged: boolean; error?: string } {
  try {
    gitExec(worktreePath, ["merge", baseBranch, "-m", `chore(goal): sync with ${baseBranch}`]);
    return { merged: true };
  } catch (err: any) {
    try { gitExec(worktreePath, ["merge", "--abort"]); } catch { /* merge 미진행 */ }
    return { merged: false, error: err.message };
  }
}

/** 에이전트 충돌 해결 후 기계 검증: 미해결 엔트리 0 + 클린 트리 + base가 goal에 합쳐졌는가. */
export function verifyWorktreeSynced(
  projectWorkdir: string,
  baseBranch: string,
  goalBranch: string,
  worktreePath: string,
): { ok: boolean; reason?: string } {
  try {
    const unmerged = gitExec(worktreePath, ["ls-files", "-u"]).stdout.trim();
    if (unmerged) return { ok: false, reason: "충돌 미해결 항목이 남아 있음 (ls-files -u)" };
    const status = gitExec(worktreePath, ["status", "--porcelain"]).stdout.trim();
    if (status) return { ok: false, reason: "작업 트리가 클린하지 않음 (커밋 누락)" };
    if (detectDivergence(projectWorkdir, baseBranch, goalBranch)) {
      return { ok: false, reason: `${baseBranch}가 goal 브랜치에 merge되지 않음` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err.message };
  }
}

// ─── High-level workflow ───────────────────────────────

export interface GitWorkflowResult {
  committed: boolean;
  pushed: boolean;
  prUrl: string | null;
  branch: string;
  filesChanged: number;
  error?: string;
  /** Classification of `error` — set whenever `error` is present. */
  errorClass?: GitErrorClass;
  /** Fine-grained error code for logging/metrics. */
  errorCode?: string;
}

// auto: base 직접 push 가능하면 반영(main_direct), 불가하면 PR 자동 폴백.
export type GitMode = "branch_only" | "pr" | "main_direct" | "local_only" | "auto";

export interface GitHubConfig {
  repoUrl: string;
  branch: string;
  autoPush: boolean;
  prMode: boolean;
  gitMode?: GitMode;
}

export interface GitWorkflowOptions {
  /** worktree 모드에서 이미 생성된 branch 이름. 설정 시 createAgentBranch를 skip한다. */
  overrideBranch?: string;
}

function assertOverrideBranchCheckout(
  workdir: string,
  overrideBranch: string | undefined,
  baseBranch: string,
): void {
  if (!overrideBranch) return;

  const currentBranch = gitExec(workdir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (currentBranch !== overrideBranch) {
    throw new Error(
      `Refusing to commit task result on ${currentBranch}; expected worktree branch ${overrideBranch} (base branch: ${baseBranch})`,
    );
  }
}

/**
 * Resolve the effective git mode from config.
 * gitMode takes precedence; legacy autoPush/prMode for backward compat.
 *
 * auto → pr 정규화: auto의 선검증-폴백(반영/PR 자동 분기)은 goal-as-unit squash 경로
 * (squashMergeGoal)에서만 구현된다. legacy per-task 경로(executeGitWorkflow)는 auto 케이스가
 * 없어 그대로 두면 local commit only로 조용히 강등된다(반영도 PR도 없음 — 정직성 목적과 정반대).
 * 그 silent degradation을 막기 위해 여기서는 pr로 정규화해 최소한 PR을 만든다.
 */
function resolveGitMode(config: GitHubConfig): GitMode {
  if (config.gitMode) return config.gitMode === "auto" ? "pr" : config.gitMode;
  if (config.prMode) return "pr";
  if (config.autoPush) return "main_direct";
  return "branch_only";
}

/**
 * Execute the full git workflow after a task passes verification.
 *
 * Modes:
 *   local_only    → commit only, no push (로컬 프로젝트 기본값)
 *   branch_only   → agent branch에 commit (push 안함)
 *   pr            → agent branch → push → PR 생성
 *   main_direct   → main에 직접 commit → push (Solo founder 워크플로우)
 */
export function executeGitWorkflow(
  workdir: string,
  taskTitle: string,
  agentName: string,
  githubConfig: GitHubConfig,
  options: GitWorkflowOptions = {},
): GitWorkflowResult {
  const mode = resolveGitMode(githubConfig);
  const { branch: baseBranch } = githubConfig;
  const { overrideBranch } = options;

  let activeBranch = overrideBranch ?? baseBranch;
  let pushed = false;
  let prUrl: string | null = null;

  try {
    assertOverrideBranchCheckout(workdir, overrideBranch, baseBranch);

    if (mode === "local_only") {
      // 로컬 commit만 — push 안함
      const commitResult = commitTaskResult(workdir, taskTitle, agentName);
      return {
        committed: commitResult.committed, pushed: false, prUrl: null,
        branch: activeBranch, filesChanged: commitResult.filesChanged,
      };
    }

    if (mode === "branch_only") {
      // agent branch에 commit — push 안함
      if (!overrideBranch) {
        activeBranch = createAgentBranch(workdir, agentName, taskTitle);
      }
      const commitResult = commitTaskResult(workdir, taskTitle, agentName);
      return {
        committed: commitResult.committed, pushed: false, prUrl: null,
        branch: activeBranch, filesChanged: commitResult.filesChanged,
      };
    }

    if (mode === "pr") {
      // agent branch → commit → push → PR
      if (!overrideBranch) {
        activeBranch = createAgentBranch(workdir, agentName, taskTitle);
      }
      const commitResult = commitTaskResult(workdir, taskTitle, agentName);
      if (!commitResult.committed) {
        return { committed: false, pushed: false, prUrl: null, branch: activeBranch, filesChanged: 0 };
      }
      pushed = pushBranch(workdir, activeBranch).ok;
      if (pushed) {
        const prBody = `Automated task implementation by Crewdeck agent.\n\nTask: ${taskTitle}\nAgent: ${agentName}`;
        prUrl = createPR(workdir, activeBranch, taskTitle, prBody);
      }
      return { committed: true, pushed, prUrl, branch: activeBranch, filesChanged: commitResult.filesChanged };
    }

    if (mode === "main_direct") {
      // main에 직접 commit → push (Solo founder 워크플로우)
      // worktree 모드에서는 worktree branch에서 commit 후 main으로 merge
      if (overrideBranch && overrideBranch !== baseBranch) {
        // worktree branch에서 commit
        const commitResult = commitTaskResult(workdir, taskTitle, agentName);
        if (!commitResult.committed) {
          return { committed: false, pushed: false, prUrl: null, branch: baseBranch, filesChanged: 0 };
        }
        // main으로 merge는 worktree 정리 후 engine에서 처리
        // 여기서는 commit + push만
        pushed = pushBranch(workdir, overrideBranch).ok;
        return { committed: true, pushed, prUrl: null, branch: overrideBranch, filesChanged: commitResult.filesChanged };
      }
      // 직접 main에서 작업 (worktree 없음)
      const commitResult = commitTaskResult(workdir, taskTitle, agentName);
      if (!commitResult.committed) {
        return { committed: false, pushed: false, prUrl: null, branch: baseBranch, filesChanged: 0 };
      }
      pushed = pushBranch(workdir, baseBranch).ok;
      return { committed: true, pushed, prUrl: null, branch: baseBranch, filesChanged: commitResult.filesChanged };
    }

    // fallback — local_only
    const commitResult = commitTaskResult(workdir, taskTitle, agentName);
    return {
      committed: commitResult.committed, pushed: false, prUrl: null,
      branch: activeBranch, filesChanged: commitResult.filesChanged,
    };
  } catch (err: any) {
    const errorMessage = err.message ?? String(err);
    const classified = classifyGitError(errorMessage);
    log.error(`Git workflow failed for task "${taskTitle}" [${classified.class}/${classified.code}]`, err);
    return {
      committed: false,
      pushed: false,
      prUrl: null,
      branch: activeBranch,
      filesChanged: 0,
      error: errorMessage,
      errorClass: classified.class,
      errorCode: classified.code,
    };
  }
}
