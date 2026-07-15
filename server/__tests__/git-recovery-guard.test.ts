import { execFileSync } from "node:child_process";
import express from "express";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGoalRoutes } from "../api/routes/goals.js";
import { recoverOnStartup } from "../core/recovery.js";
import { createDatabase, migrate } from "../db/schema.js";
import {
  cleanupStaleWorktrees,
  createGoalWorktree,
  getWorktreeDiffHash,
  inspectWorktreeRecoveryState,
  stashCheckpoint,
} from "../core/project/worktree.js";
import {
  recoverSquashCommitEvidence,
  recoverTaskCommitEvidence,
  squashMergeGoal,
} from "../core/project/git-workflow.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

let repo: string;
let worktree: { path: string; branch: string };

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "crewdeck-git-recovery-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@crewdeck.local");
  git(repo, "config", "user.name", "Crewdeck Test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), ".crewdeck-worktrees/\n.claude/worktrees/\n");
  writeFileSync(join(repo, "app.ts"), "export const value = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const created = createGoalWorktree(repo, "recovery guard");
  if (!created) throw new Error("failed to create goal worktree fixture");
  worktree = created;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("worktree recovery protection", () => {
  it("dirty tracked/untracked snapshot을 멱등적으로 대조하고 불일치 시 파일을 변경하지 않는다", () => {
    writeFileSync(join(worktree.path, "app.ts"), "export const value = 2;\n");
    writeFileSync(join(worktree.path, "new.txt"), "preserve me\n");
    const hash = getWorktreeDiffHash(worktree.path);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    expect(inspectWorktreeRecoveryState(worktree.path, worktree.branch, true, hash)).toMatchObject({
      status: "safe",
      registered: true,
      branch: worktree.branch,
      dirty: true,
      diffHash: hash,
      reasons: [],
    });
    const mismatch = inspectWorktreeRecoveryState(worktree.path, worktree.branch, true, "0".repeat(64));
    expect(mismatch.status).toBe("manual_action_required");
    expect(mismatch.reasons).toContain("dirty worktree diff hash mismatch");
    expect(readFileSync(join(worktree.path, "app.ts"), "utf-8")).toContain("value = 2");
    expect(readFileSync(join(worktree.path, "new.txt"), "utf-8")).toBe("preserve me\n");
  });

  it("branch 불일치를 수동 조치로 차단한다", () => {
    const before = git(worktree.path, "rev-parse", "HEAD");
    const state = inspectWorktreeRecoveryState(worktree.path, "goal/not-this-branch", false, null);
    expect(state.status).toBe("manual_action_required");
    expect(state.reasons.join("\n")).toContain("worktree branch mismatch");
    expect(git(worktree.path, "rev-parse", "HEAD")).toBe(before);
    expect(git(worktree.path, "branch", "--show-current")).toBe(worktree.branch);
  });

  it("시작 정리가 active goal의 checkpoint stash를 삭제하지 않는다", () => {
    writeFileSync(join(worktree.path, "app.ts"), "checkpoint WIP\n");
    expect(stashCheckpoint(worktree.path, "task-recovery")).toBe(true);
    const before = git(repo, "stash", "list");
    expect(before).toContain("crewdeck-checkpoint-task-recovery");

    cleanupStaleWorktrees(repo, [worktree.path]);

    expect(git(repo, "stash", "list")).toBe(before);
    expect(readFileSync(join(worktree.path, "app.ts"), "utf-8")).toBe("checkpoint WIP\n");
  });
});

describe("task commit recovery evidence", () => {
  it("commit 생성 후 DB 기록 전 종료를 구현 완료 승격 후보로 판별한다", () => {
    const checkpoint = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "app.ts"), "export const value = 2;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "task result");
    const taskSha = git(worktree.path, "rev-parse", "HEAD");

    expect(recoverTaskCommitEvidence(worktree.path, checkpoint)).toEqual({
      status: "promote",
      commitSha: taskSha,
    });
    expect(recoverTaskCommitEvidence(worktree.path, checkpoint, taskSha)).toEqual({
      status: "recorded",
      commitSha: taskSha,
    });
  });

  it("dirty, 다중 commit, 유실된 기록 SHA는 자동 승격하지 않는다", () => {
    const checkpoint = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "dirty.txt"), "dirty\n");
    expect(recoverTaskCommitEvidence(worktree.path, checkpoint).status).toBe("manual_action_required");
    rmSync(join(worktree.path, "dirty.txt"));

    for (const value of [2, 3]) {
      writeFileSync(join(worktree.path, "app.ts"), `export const value = ${value};\n`);
      git(worktree.path, "add", ".");
      git(worktree.path, "commit", "-m", `task result ${value}`);
    }
    expect(recoverTaskCommitEvidence(worktree.path, checkpoint)).toMatchObject({
      status: "manual_action_required",
      commitSha: null,
    });
    expect(recoverTaskCommitEvidence(worktree.path, checkpoint, "0".repeat(40))).toMatchObject({
      status: "manual_action_required",
      reason: "recorded task commit is missing",
    });
  });

  it("기록된 task commit 뒤로 HEAD가 더 전진했으면 자동 승격하지 않는다", () => {
    const checkpoint = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "app.ts"), "export const value = 2;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "task result");
    const taskSha = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "unrelated.txt"), "later commit\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "unexpected later commit");

    expect(recoverTaskCommitEvidence(worktree.path, checkpoint, taskSha)).toMatchObject({
      status: "manual_action_required",
      commitSha: null,
      reason: "worktree HEAD does not match recorded task commit",
    });
  });

  it("기록된 task commit과 HEAD가 같아도 worktree가 dirty이면 자동 승격하지 않는다", () => {
    const checkpoint = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "app.ts"), "export const value = 2;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "task result");
    const taskSha = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "dirty.txt"), "uncommitted\n");

    expect(recoverTaskCommitEvidence(worktree.path, checkpoint, taskSha)).toMatchObject({
      status: "manual_action_required",
      commitSha: null,
      reason: "worktree is dirty; commit evidence is ambiguous",
    });
  });

  it("checkpoint 자체나 symbolic ref를 task commit SHA로 오인하지 않는다", () => {
    const checkpoint = git(worktree.path, "rev-parse", "HEAD");
    expect(recoverTaskCommitEvidence(worktree.path, checkpoint, checkpoint).status)
      .toBe("manual_action_required");
    expect(recoverTaskCommitEvidence(worktree.path, checkpoint, "HEAD").status)
      .toBe("manual_action_required");
    expect(recoverTaskCommitEvidence(worktree.path, "HEAD").status)
      .toBe("manual_action_required");
  });
});

describe("squash commit recovery protection", () => {
  it("생성 후 DB 기록 전 squash를 판별하고 승인 대기 재개 시 동일 SHA를 재사용한다", () => {
    const baseSha = git(repo, "rev-parse", "main");
    writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "goal implementation");

    const first = squashMergeGoal(repo, worktree.branch, "feat: recovered goal", "local_only", "main");
    expect(first.error).toBeUndefined();
    expect(first.sha).toBeTruthy();
    const squashSha = first.sha!;
    expect(recoverSquashCommitEvidence(repo, "main", worktree.branch, baseSha)).toEqual({
      status: "promote",
      commitSha: squashSha,
    });

    writeFileSync(join(repo, "local.txt"), "do not touch\n");
    const reused = squashMergeGoal(
      repo,
      worktree.branch,
      "feat: recovered goal",
      "local_only",
      "main",
      { existingSquashSha: squashSha, checkpointBaseSha: baseSha },
    );
    expect(reused).toEqual({ sha: squashSha, prUrl: null, reused: true, outcome: "local" });
    expect(git(repo, "rev-parse", "main")).toBe(squashSha);
    expect(readFileSync(join(repo, "local.txt"), "utf-8")).toBe("do not touch\n");
  });

  it("main_direct 승인 재개가 재사용한 squash SHA를 origin base branch에 push한다", () => {
    const origin = mkdtempSync(join(tmpdir(), "crewdeck-git-recovery-origin-"));
    try {
      git(origin, "init", "--bare");
      git(repo, "remote", "add", "origin", origin);
      git(repo, "push", "-u", "origin", "main");
      const baseSha = git(repo, "rev-parse", "main");

      writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true;\n");
      git(worktree.path, "add", ".");
      git(worktree.path, "commit", "-m", "goal implementation");

      const first = squashMergeGoal(repo, worktree.branch, "feat: recovered goal", "local_only", "main");
      expect(first.error).toBeUndefined();
      const squashSha = first.sha!;
      expect(git(origin, "rev-parse", "main")).toBe(baseSha);

      const reused = squashMergeGoal(
        repo,
        worktree.branch,
        "feat: recovered goal",
        "main_direct",
        "main",
        { existingSquashSha: squashSha, checkpointBaseSha: baseSha },
      );

      expect(reused).toEqual({ sha: squashSha, prUrl: null, reused: true, outcome: "applied" });
      expect(git(repo, "rev-parse", "main")).toBe(squashSha);
      expect(git(origin, "rev-parse", "main")).toBe(squashSha);
    } finally {
      rmSync(origin, { recursive: true, force: true });
    }
  });

  it("기록 squash SHA가 base branch에 없으면 변경 없이 수동 조치로 차단한다", () => {
    writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "goal implementation");
    const goalSha = git(worktree.path, "rev-parse", "HEAD");
    const baseBefore = git(repo, "rev-parse", "main");

    expect(recoverSquashCommitEvidence(repo, "main", worktree.branch, baseBefore, goalSha)).toMatchObject({
      status: "manual_action_required",
      commitSha: null,
    });
    const result = squashMergeGoal(
      repo,
      worktree.branch,
      "feat: must not run",
      "local_only",
      "main",
      { existingSquashSha: goalSha, checkpointBaseSha: baseBefore },
    );
    expect(result.error).toContain("Recorded squash commit is not on main");
    expect(git(repo, "rev-parse", "main")).toBe(baseBefore);
  });

  it("checkpoint 다음의 다른 commit을 squash SHA로 위조해도 goal tree 불일치로 차단한다", () => {
    const baseSha = git(repo, "rev-parse", "main");
    writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "goal implementation");
    writeFileSync(join(repo, "unrelated.txt"), "not a squash\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "unrelated base commit");
    const unrelatedSha = git(repo, "rev-parse", "main");

    const result = squashMergeGoal(
      repo,
      worktree.branch,
      "feat: must not run",
      "local_only",
      "main",
      { existingSquashSha: unrelatedSha, checkpointBaseSha: baseSha },
    );

    expect(result.error).toContain("Recorded squash commit tree does not match");
    expect(git(repo, "rev-parse", "main")).toBe(unrelatedSha);
  });

  it("checkpoint 자체나 symbolic ref를 squash SHA로 오인하지 않는다", () => {
    const checkpoint = git(repo, "rev-parse", "main");
    expect(recoverSquashCommitEvidence(repo, "main", worktree.branch, checkpoint, checkpoint).status)
      .toBe("manual_action_required");
    expect(recoverSquashCommitEvidence(repo, "main", worktree.branch, checkpoint, "main").status)
      .toBe("manual_action_required");
    expect(recoverSquashCommitEvidence(repo, "main", worktree.branch, "HEAD").status)
      .toBe("manual_action_required");

    const result = squashMergeGoal(
      repo,
      worktree.branch,
      "feat: must not run",
      "local_only",
      "main",
      { existingSquashSha: "main" },
    );
    expect(result.error).toContain("Recorded squash commit is missing: main");
    expect(git(repo, "rev-parse", "main")).toBe(checkpoint);

    const equalCheckpoint = squashMergeGoal(
      repo,
      worktree.branch,
      "feat: must not run",
      "local_only",
      "main",
      { existingSquashSha: checkpoint, checkpointBaseSha: checkpoint },
    );
    expect(equalCheckpoint.error).toContain("Recorded squash commit is not directly after checkpoint");
    expect(git(repo, "rev-parse", "main")).toBe(checkpoint);
  });
});

describe("production recovery wiring", () => {
  it("startup이 checkpoint 다음의 구현 commit을 같은 SHA로 보존하고 검증부터 재개한다", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    const checkpoint = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "recovered.ts"), "export const recovered = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "verified task result");
    const taskSha = git(worktree.path, "rev-parse", "HEAD");

    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p', 'p', 'local_import', ?)").run(repo);
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, goal_model, worktree_path, worktree_branch)
      VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, status,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_commit_ready
      ) VALUES ('t', 'g', 'p', 't', 'in_progress', ?, ?, 0, 1)
    `).run(checkpoint, worktree.branch);

    expect(recoverOnStartup(db).recoveredTasks).toBe(1);
    expect(db.prepare("SELECT status, recovery_commit_sha, recovery_resume_phase FROM tasks WHERE id = 't'").get())
      .toEqual({ status: "todo", recovery_commit_sha: taskSha, recovery_resume_phase: "verification" });
    expect(db.prepare("SELECT type FROM activities WHERE project_id = 'p' ORDER BY id DESC LIMIT 1").get())
      .toEqual({ type: "recovery_promoted" });
    db.close();
  });

  it("fix session 중단 시 구현 commit과 dirty fix를 보존하고 fix부터 재개한다", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    const checkpoint = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "implementation.ts"), "export const value = 1;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "implementation checkpoint");
    const taskSha = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "implementation.ts"), "export const value = 2;\n");

    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p', 'p', 'local_import', ?)").run(repo);
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a', 'p', 'generator', 'backend')").run();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, goal_model, worktree_path, worktree_branch)
      VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, status, assignee_id,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_commit_ready, recovery_commit_sha
      ) VALUES ('t', 'g', 'p', 't', 'in_review', 'a', ?, ?, 0, 1, ?)
    `).run(checkpoint, worktree.branch, taskSha);
    const verification = db.prepare(`
      INSERT INTO verifications (
        task_id, verdict, scope, dimensions, issues, severity, evaluator_session_id
      ) VALUES ('t', 'fail', 'standard', '{}', '[]', 'soft-block', 'evaluator-runtime')
      RETURNING id
    `).get() as { id: string };
    db.prepare(`
      INSERT INTO verification_fix_rounds (
        task_id, source_verification_id, round_number, assignee_id, status, started_at
      ) VALUES ('t', ?, 1, 'a', 'running', datetime('now'))
    `).run(verification.id);
    for (const suffix of ["one", "two"]) {
      db.prepare(`
        INSERT INTO verification_issues (
          id, verification_id, dimension, severity, evidence, repro_command,
          expected_result, actual_result, fix_instruction, assignee_id
        ) VALUES (?, ?, 'functionality', 'high', ?, 'npm test', 'pass', 'fail', 'fix it', 'a')
      `).run(`issue-${suffix}`, verification.id, `issue ${suffix}`);
      db.prepare(`
        INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id, sort_order)
        VALUES (?, 'g', 'p', ?, 'in_progress', 'a', ?)
      `).run(`fix-${suffix}`, `fix ${suffix}`, suffix === "one" ? 1 : 2);
      db.prepare(`
        INSERT INTO verification_issue_tasks (issue_id, task_id, relation)
        VALUES (?, ?, 'fix')
      `).run(`issue-${suffix}`, `fix-${suffix}`);
    }

    recoverOnStartup(db);

    expect(db.prepare(`
      SELECT status, recovery_resume_phase, recovery_commit_sha FROM tasks WHERE id = 't'
    `).get()).toEqual({
      status: "todo",
      recovery_resume_phase: "fix",
      recovery_commit_sha: taskSha,
    });
    expect(readFileSync(join(worktree.path, "implementation.ts"), "utf-8"))
      .toBe("export const value = 2;\n");
    expect(db.prepare("SELECT id, status FROM tasks WHERE id LIKE 'fix-%' ORDER BY id").all())
      .toEqual([
        { id: "fix-one", status: "pending_approval" },
        { id: "fix-two", status: "pending_approval" },
      ]);
    expect(db.prepare("SELECT squash_status FROM goals WHERE id = 'g'").get())
      .toEqual({ squash_status: "none" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM recovery_incidents WHERE goal_id = 'g'").get())
      .toEqual({ count: 1 });
    db.close();
  });

  it("fix commit 직전 중단 시 이동된 checkpoint와 dirty fix를 보존하고 fix부터 재개한다", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    writeFileSync(join(worktree.path, "implementation.ts"), "export const value = 1;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "implementation checkpoint");
    const implementationSha = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "implementation.ts"), "export const value = 2;\n");

    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p', 'p', 'local_import', ?)").run(repo);
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, goal_model, worktree_path, worktree_branch)
      VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, status,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_commit_ready, recovery_commit_sha,
        recovery_resume_phase
      ) VALUES ('t', 'g', 'p', 't', 'in_review', ?, ?, 0, 1, NULL, 'fix')
    `).run(implementationSha, worktree.branch);

    recoverOnStartup(db);

    expect(db.prepare(`
      SELECT status, recovery_resume_phase, recovery_commit_sha,
             recovery_manual_action_required
      FROM tasks WHERE id = 't'
    `).get()).toEqual({
      status: "todo",
      recovery_resume_phase: "fix",
      recovery_commit_sha: null,
      recovery_manual_action_required: 0,
    });
    expect(readFileSync(join(worktree.path, "implementation.ts"), "utf-8"))
      .toBe("export const value = 2;\n");
    expect(git(worktree.path, "rev-parse", "HEAD")).toBe(implementationSha);
    expect(db.prepare(`
      SELECT decision FROM recovery_incidents WHERE goal_id = 'g'
    `).get()).toEqual({ decision: "resume" });
    db.close();
  });

  it.each([
    {
      name: "recorded commit 이후 HEAD 전진",
      mutate: () => {
        writeFileSync(join(worktree.path, "unexpected.ts"), "export const unexpected = true;\n");
        git(worktree.path, "add", ".");
        git(worktree.path, "commit", "-m", "unexpected later commit");
      },
      reason: "worktree HEAD does not match recorded task commit",
    },
    {
      name: "recorded commit 이후 dirty 변경",
      mutate: () => {
        writeFileSync(join(worktree.path, "preserve.txt"), "do not overwrite\n");
      },
      reason: "worktree is dirty; commit evidence is ambiguous",
    },
  ])("startup이 $name 상태를 done으로 승격하지 않는다", ({ mutate, reason }) => {
    const db = createDatabase(":memory:");
    migrate(db);
    const checkpoint = git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(join(worktree.path, "recovered.ts"), "export const recovered = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "verified task result");
    const taskSha = git(worktree.path, "rev-parse", "HEAD");
    mutate();
    const headBeforeRecovery = git(worktree.path, "rev-parse", "HEAD");

    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p', 'p', 'local_import', ?)").run(repo);
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, goal_model, worktree_path, worktree_branch)
      VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, status,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_commit_ready, recovery_commit_sha
      ) VALUES ('t', 'g', 'p', 't', 'in_progress', ?, ?, 0, 1, ?)
    `).run(checkpoint, worktree.branch, taskSha);

    recoverOnStartup(db);

    expect(db.prepare(`
      SELECT status, recovery_manual_action_required, recovery_manual_action_reason
      FROM tasks WHERE id = 't'
    `).get()).toEqual({
      status: "blocked",
      recovery_manual_action_required: 1,
      recovery_manual_action_reason: reason,
    });
    expect(git(worktree.path, "rev-parse", "HEAD")).toBe(headBeforeRecovery);
    if (reason.startsWith("worktree is dirty")) {
      expect(readFileSync(join(worktree.path, "preserve.txt"), "utf-8")).toBe("do not overwrite\n");
    }
    db.close();
  });

  it("startup이 구현 중 dirty 산출물을 보존하고 구현 단계부터 재개한다", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    const checkpoint = git(worktree.path, "rev-parse", "HEAD");
    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p', 'p', 'local_import', ?)").run(repo);
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, goal_model, worktree_path, worktree_branch)
      VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, status,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_worktree_diff_hash
      ) VALUES ('t', 'g', 'p', 't', 'in_progress', ?, ?, 0, NULL)
    `).run(checkpoint, worktree.branch);
    writeFileSync(join(worktree.path, "preserve.txt"), "do not overwrite\n");

    recoverOnStartup(db);

    expect(db.prepare(`
      SELECT status, recovery_manual_action_required, recovery_manual_action_reason, recovery_resume_phase
      FROM tasks WHERE id = 't'
    `).get()).toEqual({
      status: "todo",
      recovery_manual_action_required: 0,
      recovery_manual_action_reason: null,
      recovery_resume_phase: "implementation",
    });
    expect(db.prepare("SELECT squash_status FROM goals WHERE id = 'g'").get()).toEqual({ squash_status: "none" });
    expect(readFileSync(join(worktree.path, "preserve.txt"), "utf-8")).toBe("do not overwrite\n");
    db.close();
  });

  it("승인 API가 checkpoint로 판별한 기존 squash SHA를 origin/main에 push한 후 merged 처리한다", async () => {
    const db = createDatabase(":memory:");
    migrate(db);
    const origin = mkdtempSync(join(tmpdir(), "crewdeck-git-recovery-api-origin-"));
    git(origin, "init", "--bare");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "main");
    writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "goal implementation");
    const checkpoint = git(repo, "rev-parse", "main");
    const first = squashMergeGoal(repo, worktree.branch, "feat: recovered goal", "local_only", "main");
    const squashSha = first.sha!;

    db.prepare("INSERT INTO projects (id, name, source, workdir, base_branch, github_config) VALUES ('p', 'p', 'local_import', ?, 'main', ?)")
      .run(repo, JSON.stringify({ gitMode: "main_direct" }));
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch,
        squash_status, squash_checkpoint_base_sha
      ) VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?, 'blocked', ?)
    `).run(worktree.path, worktree.branch, checkpoint);
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('t', 'g', 'p', 't', 'done')").run();

    const app = express();
    app.use(express.json());
    app.use("/api/goals", createGoalRoutes({ db, broadcast: () => {} } as any));
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/goals/g/squash-approve`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, sha: squashSha });
      expect(db.prepare("SELECT squash_status, squash_commit_sha FROM goals WHERE id = 'g'").get())
        .toEqual({ squash_status: "merged", squash_commit_sha: squashSha });
      expect(git(repo, "rev-parse", "main")).toBe(squashSha);
      expect(git(origin, "rev-parse", "main")).toBe(squashSha);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(origin, { recursive: true, force: true });
    }
  });

  it("승인 재개 시 goal 작업 공간에 미커밋 WIP가 있으면 worktree·WIP를 지우지 않고 blocked로 남긴다", async () => {
    const db = createDatabase(":memory:");
    migrate(db);
    writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "goal implementation");
    const checkpoint = git(repo, "rev-parse", "main");
    // squash commit은 생성됐으나 DB 기록 전 서버가 죽음 (squash_commit_sha 미기록)
    const first = squashMergeGoal(repo, worktree.branch, "feat: recovered goal", "local_only", "main");
    const squashSha = first.sha!;
    // 사용자가 goal 작업 공간에 남긴 미커밋 WIP (tracked 수정 + untracked)
    writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true; // user WIP\n");
    writeFileSync(join(worktree.path, "user-wip.txt"), "preserve me\n");

    db.prepare("INSERT INTO projects (id, name, source, workdir, base_branch) VALUES ('p', 'p', 'local_import', ?, 'main')").run(repo);
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch,
        squash_status, squash_checkpoint_base_sha
      ) VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?, 'blocked', ?)
    `).run(worktree.path, worktree.branch, checkpoint);
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('t', 'g', 'p', 't', 'done')").run();

    const app = express();
    app.use(express.json());
    app.use("/api/goals", createGoalRoutes({ db, broadcast: () => {} } as any));
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/goals/g/squash-approve`, { method: "POST" });
      expect(response.status).toBe(500);
      expect((await response.json() as { success: boolean }).success).toBe(false);
      // squash는 되돌리지 않되(base 유지), worktree·WIP·goal 브랜치는 그대로 보존
      expect(db.prepare("SELECT squash_status FROM goals WHERE id = 'g'").get()).toMatchObject({ squash_status: "blocked" });
      expect(existsSync(worktree.path)).toBe(true);
      expect(readFileSync(join(worktree.path, "user-wip.txt"), "utf-8")).toBe("preserve me\n");
      expect(readFileSync(join(worktree.path, "feature.ts"), "utf-8")).toContain("user WIP");
      expect(git(repo, "rev-parse", "main")).toBe(squashSha);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it("신규 승인에서 fresh squash 성공 후에도 미커밋 WIP가 있으면 removeWorktree를 호출하지 않는다", async () => {
    const db = createDatabase(":memory:");
    migrate(db);
    writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "goal implementation");
    const baseBefore = git(repo, "rev-parse", "main");
    // 아직 squash된 적 없음(checkpoint 미저장). 사용자가 작업 공간에 WIP를 남긴 채 승인.
    writeFileSync(join(worktree.path, "user-wip.txt"), "preserve me\n");

    db.prepare("INSERT INTO projects (id, name, source, workdir, base_branch) VALUES ('p', 'p', 'local_import', ?, 'main')").run(repo);
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch, squash_status
      ) VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?, 'pending_approval')
    `).run(worktree.path, worktree.branch);
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('t', 'g', 'p', 't', 'done')").run();

    const app = express();
    app.use(express.json());
    app.use("/api/goals", createGoalRoutes({ db, broadcast: () => {} } as any));
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/goals/g/squash-approve`, { method: "POST" });
      expect(response.status).toBe(500);
      // fresh squash 자체는 base에 반영됐고(SHA 기록), worktree·WIP는 삭제되지 않고 blocked
      const row = db.prepare("SELECT squash_status, squash_commit_sha, worktree_path FROM goals WHERE id = 'g'").get() as {
        squash_status: string; squash_commit_sha: string | null; worktree_path: string | null;
      };
      expect(row.squash_status).toBe("blocked");
      expect(row.squash_commit_sha).toBeTruthy();
      expect(row.worktree_path).toBe(worktree.path); // worktree_path=NULL 정리가 실행되지 않음
      expect(git(repo, "rev-parse", "main")).toBe(row.squash_commit_sha);
      expect(git(repo, "rev-parse", "main")).not.toBe(baseBefore);
      expect(existsSync(worktree.path)).toBe(true);
      expect(readFileSync(join(worktree.path, "user-wip.txt"), "utf-8")).toBe("preserve me\n");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it("checkpoint 저장 전 approved 상태로 중단되면 startup이 blocked로 복구하고 재승인이 checkpoint 계산부터 정상 완료된다", async () => {
    const db = createDatabase(":memory:");
    migrate(db);
    writeFileSync(join(worktree.path, "feature.ts"), "export const feature = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "goal implementation");

    db.prepare("INSERT INTO projects (id, name, source, workdir, base_branch) VALUES ('p', 'p', 'local_import', ?, 'main')").run(repo);
    // squash-approve 핸들러가 squash_status='approved' 를 먼저 커밋하고, 이후
    // performSquash 에서 checkpoint 를 별도로 저장하기 직전에 서버가 죽은 상황.
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch,
        squash_status, squash_checkpoint_base_sha
      ) VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?, 'approved', NULL)
    `).run(worktree.path, worktree.branch);
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('t', 'g', 'p', 't', 'done')").run();

    recoverOnStartup(db);
    expect(db.prepare("SELECT squash_status, squash_checkpoint_base_sha FROM goals WHERE id = 'g'").get())
      .toEqual({ squash_status: "blocked", squash_checkpoint_base_sha: null });

    const app = express();
    app.use(express.json());
    app.use("/api/goals", createGoalRoutes({ db, broadcast: () => {} } as any));
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/goals/g/squash-approve`, { method: "POST" });
      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; sha?: string };
      expect(body.success).toBe(true);
      expect(db.prepare("SELECT squash_status, squash_commit_sha FROM goals WHERE id = 'g'").get())
        .toEqual({ squash_status: "merged", squash_commit_sha: body.sha });
      expect(git(repo, "rev-parse", "main")).toBe(body.sha);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });

  it("완료된 squash 증거가 있으면 startup이 동일 SHA를 보존해 승인 대기로 복귀한다", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    writeFileSync(join(worktree.path, "completed-squash.ts"), "export const recovered = true;\n");
    git(worktree.path, "add", ".");
    git(worktree.path, "commit", "-m", "goal ready for squash");
    const checkpoint = git(repo, "rev-parse", "main");
    const squash = squashMergeGoal(repo, worktree.branch, "feat: recovered approval", "local_only", "main");
    expect(squash.sha).toBeTruthy();

    db.prepare("INSERT INTO projects (id, name, source, workdir, base_branch) VALUES ('p', 'p', 'local_import', ?, 'main')").run(repo);
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch,
        squash_status, squash_checkpoint_base_sha
      ) VALUES ('g', 'p', 'g', 'g', 'goal_as_unit', ?, ?, 'approved', ?)
    `).run(worktree.path, worktree.branch, checkpoint);

    recoverOnStartup(db);

    expect(db.prepare("SELECT squash_status, squash_commit_sha FROM goals WHERE id = 'g'").get())
      .toEqual({ squash_status: "pending_approval", squash_commit_sha: squash.sha });
    expect(db.prepare(`
      SELECT phase, decision FROM recovery_incidents WHERE goal_id = 'g' ORDER BY created_at DESC LIMIT 1
    `).get()).toEqual({ phase: "approval", decision: "wait_approval" });
    expect(git(repo, "rev-parse", "main")).toBe(squash.sha);
    db.close();
  });
});
