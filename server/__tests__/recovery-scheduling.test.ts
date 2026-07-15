import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { rebroadcastPendingApprovals, recoverOnStartup } from "../core/recovery.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createGoalWorktree, getWorktreeDiffHash } from "../core/project/worktree.js";
import type { SessionManager, SessionRecord } from "../core/agent/session.js";
import type { AgentProvider, AgentSession } from "../core/agent/adapters/backend.js";
import type { RunResult } from "../core/agent/adapters/claude-code.js";
import { createAgentHandoff } from "../core/agent/handoff.js";
import { saveAgentHandoff } from "../core/agent/handoff-store.js";
import { readProcessIdentity, readProcessStartIdentity } from "../core/agent/process-identity.js";
import { createWSHandler } from "../api/websocket.js";

type SpawnRecord = {
  sessionId: string;
  agentId: string;
  taskId: string | null;
  workdir: string;
  active: boolean;
};

class PendingSession extends EventEmitter implements AgentSession {
  process = null;
  status: AgentSession["status"] = "idle";
  lastSessionId: string | null = null;

  constructor(
    readonly id: string,
    private readonly record: SpawnRecord,
    private readonly response: (() => Promise<RunResult>) | undefined,
    private readonly onResult: (result: RunResult) => void,
  ) {
    super();
  }

  async send(): Promise<RunResult> {
    this.status = "working";
    if (!this.response) return new Promise<RunResult>(() => {});
    const result = await this.response();
    this.lastSessionId = result.sessionId;
    this.onResult(result);
    return result;
  }

  kill(): void {
    this.status = "completed";
    this.record.active = false;
  }

  cleanup(): void {
    this.kill();
  }
}

class RecoverySessionManager implements SessionManager {
  readonly spawns: SpawnRecord[] = [];
  readonly duplicateLiveSessionIds: string[] = [];
  readonly concurrentWorkdirReuse: string[] = [];
  private readonly sessions = new Map<string, PendingSession>();
  private readonly records = new Map<string, SessionRecord>();

  constructor(
    private readonly db: Database.Database,
    private readonly responses: Partial<Record<string, () => Promise<RunResult>>> = {},
  ) {}

  spawnAgent(
    agentId: string,
    projectWorkdir: string,
    sessionKey?: string,
    taskId?: string | null,
  ): AgentSession {
    const key = sessionKey ?? agentId;
    const live = [...this.spawns].reverse().find(
      (spawn: SpawnRecord) => spawn.active && spawn.agentId === agentId,
    );
    if (live) this.duplicateLiveSessionIds.push(live.sessionId);
    const sessionId = `recovered-session-${this.spawns.length + 1}`;
    const workdirOwner = [...this.spawns].reverse().find(
      (spawn: SpawnRecord) => spawn.active && spawn.workdir === projectWorkdir,
    );
    if (workdirOwner) this.concurrentWorkdirReuse.push(workdirOwner.sessionId);
    const record = {
      sessionId,
      agentId,
      taskId: taskId ?? null,
      workdir: projectWorkdir,
      active: true,
    };
    const session = new PendingSession(
      sessionId,
      record,
      this.responses[agentId],
      (result) => {
        const runtimeSessionId = result.sessionId ?? sessionId;
        const current = this.records.get(key);
        if (current) current.runtimeSessionId = runtimeSessionId;
        this.db.prepare("UPDATE sessions SET runtime_session_id = ? WHERE id = ?")
          .run(runtimeSessionId, sessionId);
      },
    );
    this.spawns.push(record);
    this.sessions.set(key, session);
    this.records.set(key, {
      sessionKey: key,
      agentId,
      rowId: sessionId,
      provider: "claude",
      runtimeSessionId: null,
    });
    this.db.prepare(`
      INSERT INTO sessions (id, agent_id, status, provider, task_id, runtime_session_id)
      VALUES (?, ?, 'active', 'claude', ?, NULL)
    `).run(sessionId, agentId, taskId ?? null);
    return session;
  }

  getSession(key: string): AgentSession | undefined {
    return this.sessions.get(key);
  }

  getSessionRecord(key: string): SessionRecord | undefined {
    return this.records.get(key);
  }

  killSession(key: string): void {
    const record = this.records.get(key);
    this.sessions.get(key)?.cleanup();
    if (record?.rowId) {
      this.db.prepare(`
        UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?
      `).run(record.rowId);
    }
    this.sessions.delete(key);
  }

  killAll(): void {
    for (const key of [...this.sessions.keys()]) this.killSession(key);
  }

  pauseSession(): void {}
  resumeSession(): void {}
  setProviderOverride(_sessionKey: string, _provider: AgentProvider): void {}
  clearProviderOverride(): void {}
}

let repo: string | null = null;
let db: Database.Database | null = null;
let scheduler: ReturnType<typeof createScheduler> | null = null;
let orphanPid: number | null = null;
let orphanDir: string | null = null;

function makeRepo(): string {
  const path = mkdtempSync(join(tmpdir(), "crewdeck-recovery-scheduling-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.email", "test@crewdeck.local"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Crewdeck Test"], { cwd: path });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: path });
  writeFileSync(join(path, ".gitignore"), ".crewdeck-worktrees/\n.claude/worktrees/\n");
  writeFileSync(join(path, "README.md"), "# recovery fixture\n");
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", ["commit", "-m", "base"], { cwd: path });
  return path;
}

function streamJson(text: string, sessionId: string): RunResult {
  return {
    stdout: [
      JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text }] } }),
      JSON.stringify({ type: "result", session_id: sessionId, result: text }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
    sessionId,
    provider: "claude",
  };
}

function seedTaskHandoff(
  database: Database.Database,
  input: {
    sessionId: string;
    agentId: string;
    stage: "implementation" | "fix" | "verification";
    runtimeSessionId?: string;
    changedFiles?: string[];
  },
): void {
  database.prepare(`
    INSERT OR IGNORE INTO sessions (
      id, agent_id, status, provider, task_id, runtime_session_id, ended_at
    ) VALUES (?, ?, 'completed', 'claude', 'task-recovery', ?, datetime('now'))
  `).run(input.sessionId, input.agentId, input.runtimeSessionId ?? null);
  saveAgentHandoff(database, {
    goalId: "goal-recovery",
    taskId: "task-recovery",
    sessionId: input.sessionId,
    handoff: createAgentHandoff({
      stage: input.stage,
      changed_files: input.changedFiles ?? [],
    }),
  });
}

function passVerification(): string {
  return `\`\`\`json
{
  "verdict": "pass",
  "severity": "auto-resolve",
  "dimensionJudgements": [
    { "dimension": "functionality", "verdict": "pass", "evidence": "recovered functionality" },
    { "dimension": "dataFlow", "verdict": "pass", "evidence": "recovered data flow" },
    { "dimension": "designAlignment", "verdict": "pass", "evidence": "recovered design" },
    { "dimension": "craft", "verdict": "pass", "evidence": "recovered craft" },
    { "dimension": "edgeCases", "verdict": "pass", "evidence": "recovered edge cases" }
  ],
  "dimensions": {
    "functionality": { "value": 8, "notes": "pass" },
    "dataFlow": { "value": 8, "notes": "pass" },
    "designAlignment": { "value": 8, "notes": "pass" },
    "craft": { "value": 8, "notes": "pass" },
    "edgeCases": { "value": 8, "notes": "pass" }
  },
  "issues": [],
  "knownGaps": [],
  "handoff": {
    "version": 1,
    "stage": "verification",
    "changed_files": [],
    "decisions": [],
    "unresolved_risks": [],
    "reproduction_commands": []
  }
}
\`\`\``;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(() => {
  scheduler?.stopQueue("project-recovery");
  scheduler = null;
  if (orphanPid !== null) {
    try { process.kill(orphanPid, "SIGKILL"); } catch { /* already gone */ }
    orphanPid = null;
  }
  if (db) {
    db.close();
    db = null;
  }
  if (repo) {
    rmSync(repo, { recursive: true, force: true });
    repo = null;
  }
  if (orphanDir) {
    rmSync(orphanDir, { recursive: true, force: true });
    orphanDir = null;
  }
});

describe("restart recovery scheduling integration", () => {
  it("dirty implementation output resumes exactly one implementation session", { timeout: 30_000 }, async () => {
    repo = makeRepo();
    db = createDatabase(":memory:");
    migrate(db);
    const worktree = createGoalWorktree(repo, "manual-recovery");
    if (!worktree) throw new Error("failed to create recovery fixture worktree");
    const checkpoint = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf-8",
    }).trim();

    db.prepare(`
      INSERT INTO projects (id, name, source, workdir, base_branch)
      VALUES ('project-recovery', 'recovery', 'local_import', ?, 'main')
    `).run(repo);
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, needs_worktree)
      VALUES ('agent-recovery', 'project-recovery', 'recovery worker', 'qa', 0)
    `).run();
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch
      ) VALUES ('goal-recovery', 'project-recovery', 'manual recovery', 'manual recovery',
        'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, status, assignee_id,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_worktree_diff_hash
      ) VALUES ('task-recovery', 'goal-recovery', 'project-recovery', 'must not rerun',
        'in_progress', 'agent-recovery', ?, ?, 0, NULL)
    `).run(checkpoint, worktree.branch);
    writeFileSync(join(worktree.path, "unexpected.txt"), "preserve for manual inspection\n");

    expect(recoverOnStartup(db)).toEqual({ recoveredTasks: 1, killedProcesses: 0 });
    expect(recoverOnStartup(db)).toEqual({ recoveredTasks: 0, killedProcesses: 0 });
    db.prepare(`
      UPDATE tasks SET retry_count = 99, reassign_count = 99,
        updated_at = datetime('now', '-1 hour')
      WHERE id = 'task-recovery'
    `).run();

    const sessions = new RecoverySessionManager(db);
    scheduler = createScheduler(db, sessions, () => {});
    scheduler.startQueue("project-recovery");
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(sessions.spawns).toHaveLength(1);
    expect(sessions.spawns[0]).toMatchObject({
      agentId: "agent-recovery",
      taskId: "task-recovery",
      workdir: worktree.path,
    });
    expect(db.prepare(`
      SELECT status, retry_count, recovery_manual_action_required, recovery_resume_phase
      FROM tasks WHERE id = 'task-recovery'
    `).get()).toEqual({
      status: "in_progress",
      retry_count: 99,
      recovery_manual_action_required: 0,
      recovery_resume_phase: "implementation",
    });
    expect(readFileSync(join(worktree.path, "unexpected.txt"), "utf-8"))
      .toBe("preserve for manual inspection\n");
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE goal_id = 'goal-recovery' AND status IN ('in_progress', 'in_review')
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE task_id = 'task-recovery' AND status = 'active'
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT phase, decision FROM recovery_incidents WHERE goal_id = 'goal-recovery'
    `).all()).toEqual([{ phase: "implementation", decision: "resume" }]);
  });

  it("commit 생성 후 DB 기록 전 종료되면 SHA를 승격하고 evaluator 하나만 실행한다", { timeout: 30_000 }, async () => {
    repo = makeRepo();
    db = createDatabase(":memory:");
    migrate(db);
    const worktree = createGoalWorktree(repo, "commit-promotion");
    if (!worktree) throw new Error("failed to create recovery fixture worktree");
    const checkpoint = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.path, encoding: "utf-8" }).trim();
    writeFileSync(join(worktree.path, "promoted.ts"), "export const promoted = true;\n");
    execFileSync("git", ["add", "."], { cwd: worktree.path });
    execFileSync("git", ["commit", "-m", "implementation before db update"], { cwd: worktree.path });
    const promotedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf-8",
    }).trim();

    db.prepare("INSERT INTO projects (id, name, source, workdir, base_branch) VALUES ('project-recovery', 'recovery', 'local_import', ?, 'main')").run(repo);
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, needs_worktree)
      VALUES ('agent-recovery', 'project-recovery', 'generator', 'backend', 0),
             ('reviewer-recovery', 'project-recovery', 'reviewer', 'reviewer', 0)
    `).run();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, goal_model, worktree_path, worktree_branch)
      VALUES ('goal-recovery', 'project-recovery', 'commit promotion', 'commit promotion',
        'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, description, status, assignee_id,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_commit_ready, recovery_commit_sha
      ) VALUES ('task-recovery', 'goal-recovery', 'project-recovery', 'promote unrecorded commit',
        'Resume verification without rerunning the generator.',
        'in_progress', 'agent-recovery', ?, ?, 0, 1, NULL)
    `).run(checkpoint, worktree.branch);
    seedTaskHandoff(db, {
      sessionId: "implementation-row",
      agentId: "agent-recovery",
      stage: "implementation",
      runtimeSessionId: "implementation-runtime",
      changedFiles: ["promoted.ts"],
    });

    recoverOnStartup(db);
    expect(db.prepare(`
      SELECT status, recovery_commit_sha, recovery_resume_phase
      FROM tasks WHERE id = 'task-recovery'
    `).get()).toEqual({
      status: "todo",
      recovery_commit_sha: promotedCommit,
      recovery_resume_phase: "verification",
    });

    const sessions = new RecoverySessionManager(db);
    scheduler = createScheduler(db, sessions, () => {});
    scheduler.startQueue("project-recovery");
    await waitFor(() => sessions.spawns.length === 1, "promoted commit evaluator spawn");

    expect(sessions.spawns).toEqual([
      expect.objectContaining({ agentId: "reviewer-recovery", taskId: "task-recovery", active: true }),
    ]);
    expect(sessions.spawns.some((spawned) => spawned.agentId === "agent-recovery")).toBe(false);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.path, encoding: "utf-8" }).trim())
      .toBe(promotedCommit);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE goal_id = 'goal-recovery' AND status IN ('in_progress', 'in_review')
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE task_id = 'task-recovery' AND status = 'active'
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT phase, decision FROM recovery_incidents WHERE goal_id = 'goal-recovery'
    `).all()).toEqual([{ phase: "implementation", decision: "advance" }]);
  });

  it("성공한 fix commit 후 evaluator 중단 시 fix를 보존하고 새 evaluator만 실행한다", { timeout: 30_000 }, async () => {
    repo = makeRepo();
    db = createDatabase(":memory:");
    migrate(db);
    const worktree = createGoalWorktree(repo, "verification-resume");
    if (!worktree) throw new Error("failed to create recovery fixture worktree");
    writeFileSync(join(worktree.path, "implemented.ts"), "export const implemented = true;\n");
    execFileSync("git", ["add", "."], { cwd: worktree.path });
    execFileSync("git", ["commit", "-m", "implementation checkpoint"], { cwd: worktree.path });
    const implementationCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf-8",
    }).trim();
    writeFileSync(join(worktree.path, "implemented.ts"), "export const implemented = 'fixed';\n");
    execFileSync("git", ["add", "."], { cwd: worktree.path });
    execFileSync("git", ["commit", "-m", "durable fix checkpoint"], { cwd: worktree.path });
    const fixCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf-8",
    }).trim();

    db.prepare("INSERT INTO projects (id, name, source, workdir, base_branch) VALUES ('project-recovery', 'recovery', 'local_import', ?, 'main')").run(repo);
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, needs_worktree)
      VALUES ('agent-recovery', 'project-recovery', 'generator', 'backend', 0),
             ('reviewer-recovery', 'project-recovery', 'reviewer', 'reviewer', 0),
             ('cto-recovery', 'project-recovery', 'architect', 'cto', 0)
    `).run();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, goal_model, worktree_path, worktree_branch)
      VALUES ('goal-recovery', 'project-recovery', 'verification resume', 'verification resume',
        'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, description, status, assignee_id,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_commit_ready, recovery_commit_sha,
        recovery_resume_phase
      ) VALUES ('task-recovery', 'goal-recovery', 'project-recovery', 'verify durable fix',
        'Review the committed fix without rerunning implementation or fix.',
        'in_review', 'agent-recovery', ?, ?, 0, 1, ?, 'verification')
    `).run(implementationCommit, worktree.branch, fixCommit);
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, status, provider, task_id, runtime_session_id, ended_at
      ) VALUES
        ('implementation-row', 'agent-recovery', 'killed', 'claude',
          'task-recovery', 'implementation-runtime', datetime('now')),
        ('fix-row', 'agent-recovery', 'killed', 'claude',
          'task-recovery', 'fix-runtime', datetime('now')),
        ('interrupted-evaluator-row', 'reviewer-recovery', 'killed', 'claude',
          'task-recovery', 'interrupted-evaluator-runtime', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO verifications (
        id, task_id, verdict, scope, dimensions, issues, severity,
        evaluator_session_id, implementation_session_id
      ) VALUES ('prior-fail', 'task-recovery', 'fail', 'standard', '{}', '[]',
        'soft-block', 'prior-evaluator-runtime', 'implementation-row')
    `).run();
    db.prepare(`
      INSERT INTO verification_fix_rounds (
        task_id, source_verification_id, round_number, assignee_id,
        session_id, runtime_session_id, status, started_at, completed_at
      ) VALUES ('task-recovery', 'prior-fail', 1, 'agent-recovery',
        'fix-row', 'fix-runtime', 'completed', datetime('now'), datetime('now'))
    `).run();
    seedTaskHandoff(db, {
      sessionId: "fix-row",
      agentId: "agent-recovery",
      stage: "fix",
      runtimeSessionId: "fix-runtime",
      changedFiles: ["implemented.ts"],
    });

    recoverOnStartup(db);
    expect(db.prepare("SELECT status, recovery_resume_phase FROM tasks WHERE id = 'task-recovery'").get())
      .toEqual({ status: "todo", recovery_resume_phase: "verification" });

    let resolveEvaluator!: (result: RunResult) => void;
    const evaluatorResponse = new Promise<RunResult>((resolve) => { resolveEvaluator = resolve; });
    const sessions = new RecoverySessionManager(db, {
      "reviewer-recovery": () => evaluatorResponse,
    });
    scheduler = createScheduler(db, sessions, () => {});
    scheduler.startQueue("project-recovery");
    await waitFor(() => sessions.spawns.length === 1, "recovered evaluator spawn");

    expect(sessions.spawns).toHaveLength(1);
    expect(sessions.spawns[0]).toMatchObject({
      agentId: "reviewer-recovery",
      taskId: "task-recovery",
      workdir: worktree.path,
    });
    expect(sessions.spawns.some((spawned) => spawned.agentId === "agent-recovery")).toBe(false);
    expect(sessions.spawns[0]?.sessionId).not.toBe("interrupted-evaluator-runtime");
    expect(sessions.concurrentWorkdirReuse).toEqual([]);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.path, encoding: "utf-8" }).trim())
      .toBe(fixCommit);
    expect(readFileSync(join(worktree.path, "implemented.ts"), "utf-8"))
      .toBe("export const implemented = 'fixed';\n");
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE goal_id = 'goal-recovery' AND status IN ('in_progress', 'in_review')
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE task_id = 'task-recovery' AND status = 'active'
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT phase, decision FROM recovery_incidents WHERE goal_id = 'goal-recovery'
    `).all()).toEqual([{ phase: "verification", decision: "advance" }]);

    resolveEvaluator(streamJson(passVerification(), "fresh-evaluator-runtime"));
    await waitFor(
      () => !!db!.prepare("SELECT 1 FROM verifications WHERE task_id = 'task-recovery' AND verdict = 'pass'").get(),
      "persisted recovered verification",
    );
    scheduler.stopQueue("project-recovery");
    expect(db.prepare(`
      SELECT evaluator_session_id, implementation_session_id
      FROM verifications WHERE task_id = 'task-recovery' AND verdict = 'pass'
      ORDER BY created_at DESC LIMIT 1
    `).get()).toEqual({
      evaluator_session_id: "fresh-evaluator-runtime",
      implementation_session_id: "implementation-row",
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE id = 'recovered-session-1' AND task_id = 'task-recovery'
    `).get()).toEqual({ count: 1 });
  });

  it("fix 중단 시 구현 commit을 보존하고 generator fix attempt 하나로 재개한다", { timeout: 30_000 }, async () => {
    repo = makeRepo();
    db = createDatabase(":memory:");
    migrate(db);
    const worktree = createGoalWorktree(repo, "fix-resume");
    if (!worktree) throw new Error("failed to create recovery fixture worktree");
    const checkpoint = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.path, encoding: "utf-8" }).trim();
    writeFileSync(join(worktree.path, "fix-target.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: worktree.path });
    execFileSync("git", ["commit", "-m", "implementation checkpoint"], { cwd: worktree.path });
    const implementationCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf-8",
    }).trim();

    db.prepare("INSERT INTO projects (id, name, source, workdir, base_branch) VALUES ('project-recovery', 'recovery', 'local_import', ?, 'main')").run(repo);
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, needs_worktree)
      VALUES ('agent-recovery', 'project-recovery', 'generator', 'backend', 0),
             ('reviewer-recovery', 'project-recovery', 'reviewer', 'reviewer', 0)
    `).run();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, goal_model, worktree_path, worktree_branch)
      VALUES ('goal-recovery', 'project-recovery', 'fix resume', 'fix resume',
        'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, description, status, assignee_id,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_commit_ready, recovery_commit_sha,
        recovery_resume_phase
      ) VALUES ('task-recovery', 'goal-recovery', 'project-recovery', 'resume interrupted fix',
        'Resume only the interrupted fix.', 'in_review', 'agent-recovery', ?, ?, 0, 1, ?, 'fix')
    `).run(checkpoint, worktree.branch, implementationCommit);
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, status, provider, task_id, runtime_session_id, ended_at
      ) VALUES
        ('implementation-row', 'agent-recovery', 'completed', 'claude',
          'task-recovery', 'implementation-runtime', datetime('now')),
        ('evaluator-row', 'reviewer-recovery', 'completed', 'claude',
          'task-recovery', 'evaluator-runtime', datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO verifications (
        id, task_id, verdict, scope, dimensions, issues, severity,
        evaluator_session_id, implementation_session_id
      ) VALUES ('verification-recovery', 'task-recovery', 'fail', 'standard', '{}',
        '[{"severity":"high","message":"fix target"}]', 'soft-block',
        'evaluator-runtime', 'implementation-runtime')
    `).run();
    seedTaskHandoff(db, {
      sessionId: "evaluator-row",
      agentId: "reviewer-recovery",
      stage: "verification",
      runtimeSessionId: "evaluator-runtime",
    });
    db.prepare(`
      INSERT INTO verification_issues (
        id, verification_id, dimension, severity, evidence, repro_command,
        expected_result, actual_result, fix_instruction, assignee_id
      ) VALUES ('issue-recovery', 'verification-recovery', 'functionality', 'high',
        'fix target is wrong', 'npm test', 'pass', 'fail', 'repair fix target', 'agent-recovery')
    `).run();
    db.prepare(`
      INSERT INTO verification_fix_rounds (
        task_id, source_verification_id, round_number, assignee_id,
        runtime_session_id, status, started_at
      ) VALUES ('task-recovery', 'verification-recovery', 1, 'agent-recovery',
        'interrupted-fix-runtime', 'running', datetime('now'))
    `).run();

    recoverOnStartup(db);
    expect(db.prepare(`
      SELECT status, recovery_commit_sha, recovery_resume_phase
      FROM tasks WHERE id = 'task-recovery'
    `).get()).toEqual({
      status: "todo",
      recovery_commit_sha: implementationCommit,
      recovery_resume_phase: "fix",
    });

    const sessions = new RecoverySessionManager(db);
    scheduler = createScheduler(db, sessions, () => {});
    scheduler.startQueue("project-recovery");
    await waitFor(() => sessions.spawns.length === 1, "recovered fix spawn");

    expect(sessions.spawns).toEqual([
      expect.objectContaining({ agentId: "agent-recovery", taskId: "task-recovery", active: true }),
    ]);
    expect(sessions.spawns.some((spawned) => spawned.agentId === "reviewer-recovery")).toBe(false);
    expect(sessions.spawns[0]?.sessionId).not.toBe("interrupted-fix-runtime");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.path, encoding: "utf-8" }).trim())
      .toBe(implementationCommit);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE goal_id = 'goal-recovery' AND status IN ('in_progress', 'in_review')
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE task_id = 'task-recovery' AND status = 'active'
    `).get()).toEqual({ count: 1 });
    expect(db.prepare(`
      SELECT status, session_id, runtime_session_id
      FROM verification_fix_rounds WHERE source_verification_id = 'verification-recovery'
    `).get()).toEqual({
      status: "running",
      session_id: "recovered-session-1",
      runtime_session_id: null,
    });
    expect(db.prepare(`
      SELECT phase, decision FROM recovery_incidents WHERE goal_id = 'goal-recovery'
    `).all()).toEqual([{ phase: "fix", decision: "advance" }]);
  });

  it("승인 전 종료 시 반복 WebSocket 연결에 commit 보존 상태를 재전달해도 activity는 한 번만 기록한다", async () => {
    repo = makeRepo();
    db = createDatabase(":memory:");
    migrate(db);
    const worktree = createGoalWorktree(repo, "approval-resume");
    if (!worktree) throw new Error("failed to create recovery fixture worktree");
    writeFileSync(join(worktree.path, "approved.ts"), "export const ready = true;\n");
    execFileSync("git", ["add", "."], { cwd: worktree.path });
    execFileSync("git", ["commit", "-m", "approval artifact"], { cwd: worktree.path });
    const taskCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf-8",
    }).trim();

    db.prepare("INSERT INTO projects (id, name, source, workdir, base_branch) VALUES ('project-recovery', 'recovery', 'local_import', ?, 'main')").run(repo);
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, needs_worktree)
      VALUES ('agent-recovery', 'project-recovery', 'generator', 'backend', 0)
    `).run();
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path,
        worktree_branch, squash_status
      ) VALUES ('goal-recovery', 'project-recovery', 'approval resume', 'approval resume',
        'goal_as_unit', ?, ?, 'pending_approval')
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, status, assignee_id,
        recovery_commit_ready, recovery_commit_sha
      ) VALUES ('task-recovery', 'goal-recovery', 'project-recovery', 'approval artifact',
        'done', 'agent-recovery', 1, ?)
    `).run(taskCommit);

    recoverOnStartup(db);
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    const apiKey = "approval-recovery-key";
    const broadcast = (event: string, data: unknown): void => {
      const message = JSON.stringify({ type: event, payload: data });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && (client as any).__authenticated) {
          client.send(message);
        }
      }
    };
    rebroadcastPendingApprovals(db, broadcast);
    createWSHandler(wss, apiKey, () => {
      rebroadcastPendingApprovals(db!, broadcast, { recordIncident: false });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("approval recovery server unavailable");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${apiKey}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${apiKey}`);
    const squashReady = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("goal:squash_ready was not received")), 1_000);
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "goal:squash_ready") {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    const secondSquashReady = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("second goal:squash_ready was not received")), 1_000);
      ws2.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "goal:squash_ready") {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
    try {
      await Promise.all([ws, ws2].map((client) => new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      })));
      await expect(squashReady).resolves.toMatchObject({
        payload: { goalId: "goal-recovery" },
      });
      await expect(secondSquashReady).resolves.toMatchObject({
        payload: { goalId: "goal-recovery" },
      });
    } finally {
      ws.close();
      ws2.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
    expect(db.prepare("SELECT squash_status FROM goals WHERE id = 'goal-recovery'").get())
      .toEqual({ squash_status: "pending_approval" });
    expect(db.prepare("SELECT recovery_commit_sha FROM tasks WHERE id = 'task-recovery'").get())
      .toEqual({ recovery_commit_sha: taskCommit });
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.path, encoding: "utf-8" }).trim())
      .toBe(taskCommit);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT phase, decision FROM recovery_incidents WHERE goal_id = 'goal-recovery'
    `).all()).toEqual([{ phase: "approval", decision: "wait_approval" }]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE project_id = 'project-recovery' AND type = 'recovery_incident'
    `).get()).toEqual({ count: 1 });
  });

  it("process group을 종료해 SIGTERM handler의 detached descendant late write를 막는다", { timeout: 30_000 }, async () => {
    repo = makeRepo();
    db = createDatabase(":memory:");
    migrate(db);
    const worktree = createGoalWorktree(repo, "late-write-guard");
    if (!worktree) throw new Error("failed to create recovery fixture worktree");
    const checkpoint = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf-8",
    }).trim();

    db.prepare(`
      INSERT INTO projects (id, name, source, workdir, base_branch)
      VALUES ('project-recovery', 'recovery', 'local_import', ?, 'main')
    `).run(repo);
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, needs_worktree, status, current_task_id)
      VALUES ('agent-recovery', 'project-recovery', 'recovery worker', 'qa', 0, 'working', 'task-recovery')
    `).run();
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch
      ) VALUES ('goal-recovery', 'project-recovery', 'late write guard', 'late write guard',
        'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, status, assignee_id,
        recovery_checkpoint_head_sha, recovery_worktree_branch, recovery_worktree_dirty
      ) VALUES ('task-recovery', 'goal-recovery', 'project-recovery', 'must not rerun after late write',
        'in_progress', 'agent-recovery', ?, ?, 0)
    `).run(checkpoint, worktree.branch);

    // 재부팅 후 init 에 reparent 된 고아 subprocess 를 흉내낸다: launcher 가 detached
    // 로 orphan 을 띄우고 즉시 종료 → orphan 은 우리 event loop 가 reaping 하지 않는
    // init 자식이 된다(프로덕션과 동일). orphan 의 SIGTERM handler는
    // 500ms 뒤 late.txt를 쓰는 detached descendant를 만든다.
    orphanDir = mkdtempSync(join(tmpdir(), "crewdeck-orphan-"));
    const latePath = join(worktree.path, "late.txt");
    const readyPath = join(orphanDir, "orphan.pid");
    const orphanScript = join(orphanDir, "orphan.cjs");
    writeFileSync(
      orphanScript,
      [
        'const fs = require("fs");',
        'const cp = require("child_process");',
        "const [lp, rp] = process.argv.slice(2);",
        'process.on("SIGTERM", () => {',
        '  const child = cp.spawn(process.execPath, ["-e", "setTimeout(() => require(\\"fs\\").writeFileSync(process.argv[1], \\"late-write\\\\n\\"), 500)", lp], { detached: true, stdio: "ignore" });',
        "  child.unref(); process.exit(0);",
        "});",
        "fs.writeFileSync(rp, String(process.pid));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    const launcher =
      'const cp = require("child_process");' +
      'const g = cp.spawn(process.argv[0], process.argv.slice(1), { detached: true, stdio: "ignore" });' +
      "g.unref(); process.exit(0);";
    spawn(process.execPath, ["-e", launcher, orphanScript, latePath, readyPath], {
      stdio: "ignore",
      env: { ...process.env, CREWDECK_AGENT_ID: "orphan-owner" },
    });

    await waitFor(() => existsSync(readyPath), "orphan subprocess ready");
    orphanPid = Number(readFileSync(readyPath, "utf-8").trim());
    const identity = readProcessIdentity(orphanPid);
    if (!identity) throw new Error("orphan process identity unavailable");
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, status, provider, task_id, pid, process_group_id,
        process_started_at, process_executable, process_parent_id, process_owner_token
      ) VALUES ('orphan-session', 'agent-recovery', 'active', 'claude', 'task-recovery', ?, ?, ?, ?, ?, 'orphan-owner')
    `).run(orphanPid, orphanPid, identity.startToken, identity.executable, identity.parentProcessId);

    recoverOnStartup(db);

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(latePath)).toBe(false);
    expect(db.prepare(`
      SELECT status, recovery_manual_action_required, recovery_manual_action_reason
      FROM tasks WHERE id = 'task-recovery'
    `).get()).toEqual({
      status: "todo",
      recovery_manual_action_required: 0,
      recovery_manual_action_reason: null,
    });
  });

  it("PGID identity가 다르면 무관한 process group을 종료하지 않고 goal을 차단한다", async () => {
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p', 'P', 'new')").run();
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a', 'p', 'A', 'qa')").run();
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g', 'p', 'G')").run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id)
      VALUES ('t', 'g', 'p', 'T', 'in_progress', 'a')
    `).run();

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CREWDECK_AGENT_ID: "start-mismatch-owner" },
    });
    if (!child.pid) throw new Error("identity mismatch fixture did not spawn");
    orphanPid = child.pid;
    await waitFor(() => readProcessStartIdentity(orphanPid!) !== null, "process identity ready");
    const identity = readProcessIdentity(orphanPid);
    if (!identity) throw new Error("identity mismatch fixture unavailable");
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, status, provider, task_id, pid, process_group_id,
        process_started_at, process_executable, process_parent_id, process_owner_token
      ) VALUES ('s', 'a', 'active', 'claude', 't', ?, ?, 'definitely-not-this-process', ?, ?, 'start-mismatch-owner')
    `).run(orphanPid, orphanPid, identity.executable, identity.parentProcessId);

    expect(recoverOnStartup(db)).toEqual({ recoveredTasks: 1, killedProcesses: 0 });
    expect(() => process.kill(orphanPid!, 0)).not.toThrow();
    expect(db.prepare("SELECT status, recovery_manual_action_required FROM tasks WHERE id = 't'").get())
      .toEqual({ status: "blocked", recovery_manual_action_required: 1 });
    expect(db.prepare("SELECT squash_status FROM goals WHERE id = 'g'").get())
      .toEqual({ squash_status: "blocked" });
  });

  it("시작 token이 같아도 executable identity가 다르면 signal을 보내지 않는다", async () => {
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p', 'P', 'new')").run();
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a', 'p', 'A', 'qa')").run();
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g', 'p', 'G')").run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id)
      VALUES ('t', 'g', 'p', 'T', 'in_progress', 'a')
    `).run();

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CREWDECK_AGENT_ID: "executable-mismatch-owner" },
    });
    if (!child.pid) throw new Error("executable mismatch fixture did not spawn");
    orphanPid = child.pid;
    await waitFor(() => readProcessIdentity(orphanPid!) !== null, "process identity ready");
    const identity = readProcessIdentity(orphanPid);
    if (!identity) throw new Error("executable mismatch fixture unavailable");
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, status, provider, task_id, pid, process_group_id,
        process_started_at, process_executable, process_parent_id, process_owner_token
      ) VALUES ('s', 'a', 'active', 'claude', 't', ?, ?, ?, '/not/crewdeck/subprocess', ?, 'executable-mismatch-owner')
    `).run(orphanPid, orphanPid, identity.startToken, identity.parentProcessId);

    expect(recoverOnStartup(db)).toEqual({ recoveredTasks: 1, killedProcesses: 0 });
    expect(() => process.kill(orphanPid!, 0)).not.toThrow();
    expect(db.prepare("SELECT status, recovery_manual_action_required FROM tasks WHERE id = 't'").get())
      .toEqual({ status: "blocked", recovery_manual_action_required: 1 });
  });

  it("restores one interrupted task once and reuses its preserved goal worktree", { timeout: 30_000 }, async () => {
    repo = makeRepo();
    db = createDatabase(":memory:");
    migrate(db);
    const worktree = createGoalWorktree(repo, "restart-contract");
    if (!worktree) throw new Error("failed to create recovery fixture worktree");
    writeFileSync(join(worktree.path, "interrupted.txt"), "preserve this WIP across restart\n");

    db.prepare(`
      INSERT INTO projects (id, name, source, workdir, base_branch)
      VALUES ('project-recovery', 'recovery', 'local_import', ?, 'main')
    `).run(repo);
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, needs_worktree, status, current_task_id)
      VALUES ('agent-recovery', 'project-recovery', 'recovery worker', 'qa', 0, 'working', 'task-recovery')
    `).run();
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch
      ) VALUES ('goal-recovery', 'project-recovery', 'restart contract', 'restart contract',
        'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, description, status, assignee_id, started_at,
        recovery_checkpoint_head_sha, recovery_worktree_branch,
        recovery_worktree_dirty, recovery_worktree_diff_hash
      ) VALUES ('task-recovery', 'goal-recovery', 'project-recovery', 'resume interrupted task',
        'resume once', 'in_progress', 'agent-recovery', datetime('now', '-1 minute'), ?, ?, 1, ?)
    `).run(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree.path, encoding: "utf-8" }).trim(),
      worktree.branch,
      getWorktreeDiffHash(worktree.path),
    );
    db.prepare(`
      INSERT INTO sessions (id, agent_id, status, provider, task_id)
      VALUES ('orphan-session', 'agent-recovery', 'active', 'claude', 'task-recovery')
    `).run();

    const firstRecovery = recoverOnStartup(db);
    const secondRecovery = recoverOnStartup(db);

    expect(firstRecovery).toEqual({ recoveredTasks: 1, killedProcesses: 0 });
    expect(secondRecovery).toEqual({ recoveredTasks: 0, killedProcesses: 0 });
    expect(db.prepare("SELECT status, recovery_manual_action_required FROM tasks WHERE id = 'task-recovery'").get())
      .toEqual({ status: "blocked", recovery_manual_action_required: 1 });
    expect(db.prepare("SELECT squash_status FROM goals WHERE id = 'goal-recovery'").get())
      .toEqual({ squash_status: "blocked" });
    expect(db.prepare(`
      SELECT decision, reason, user_action FROM recovery_incidents
      WHERE goal_id = 'goal-recovery'
    `).get()).toEqual({
      decision: "blocked",
      reason: "active session subprocess could not be confirmed terminated",
      user_action: "worktree와 Git 산출물을 확인한 뒤 수동으로 재개하세요.",
    });
    expect(db.prepare(`
      SELECT type FROM activities
      WHERE project_id = 'project-recovery' AND type = 'recovery_manual_action'
    `).get()).toEqual({ type: "recovery_manual_action" });
    expect(db.prepare("SELECT status FROM sessions WHERE id = 'orphan-session'").get())
      .toEqual({ status: "killed" });
    expect(db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'agent-recovery'").get())
      .toEqual({ status: "idle", current_task_id: null });
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(join(worktree.path, "interrupted.txt"))).toBe(true);

    const sessions = new RecoverySessionManager(db);
    scheduler = createScheduler(db, sessions, () => {});
    scheduler.startQueue("project-recovery");
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(sessions.spawns).toEqual([]);
    expect(sessions.duplicateLiveSessionIds).toEqual([]);
    expect(sessions.concurrentWorkdirReuse).toEqual([]);
    expect(db.prepare("SELECT worktree_path, worktree_branch FROM goals WHERE id = 'goal-recovery'").get())
      .toEqual({ worktree_path: worktree.path, worktree_branch: worktree.branch });
    expect(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf-8" }))
      .toContain(worktree.path);
  });
});
