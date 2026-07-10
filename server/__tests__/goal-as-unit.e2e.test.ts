import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { createGoalRoutes } from "../api/routes/goals.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createOrchestrationEngine } from "../core/orchestration/engine.js";
import { createQualityGate } from "../core/quality-gate/evaluator.js";
import { recoverOnStartup, rebroadcastPendingApprovals } from "../core/recovery.js";
import type { SessionManager, SessionRecord } from "../core/agent/session.js";
import type { AgentProvider, AgentSession } from "../core/agent/adapters/backend.js";
import type { RunResult } from "../core/agent/adapters/claude-code.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const tempDirs: string[] = [];
const dbs: Database.Database[] = [];
const previousDataDir = process.env.CREWDECK_DATA_DIR;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewdeck-goal-e2e-repo-"));
  tempDirs.push(dir);

  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@crewdeck.local");
  git(dir, "config", "user.name", "Crewdeck Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitignore"), ".crewdeck-worktrees/\n.claude/worktrees/\n");
  writeFileSync(join(dir, "README.md"), "# Fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");

  return dir;
}

function addGoalWorktree(repo: string, slug: string): { path: string; branch: string } {
  const branch = `goal/${slug}`;
  const worktreePath = join(repo, ".crewdeck-worktrees", slug);
  mkdirSync(join(repo, ".crewdeck-worktrees"), { recursive: true });
  git(repo, "worktree", "add", "-b", branch, worktreePath, "main");
  return { path: realpathSync(worktreePath), branch };
}

function makeDb(): Database.Database {
  const dataDir = mkdtempSync(join(tmpdir(), "crewdeck-goal-e2e-data-"));
  tempDirs.push(dataDir);
  process.env.CREWDECK_DATA_DIR = dataDir;

  const db = createDatabase(join(dataDir, "crewdeck.db"));
  migrate(db);
  dbs.push(db);
  return db;
}

function seedFullAutoProject(
  db: Database.Database,
  workdir: string,
  opts: { qaNeedsWorktree?: number; reviewerNeedsWorktree?: number; autopilot?: "full" | "goal" } = {},
): string {
  const projectId = "project-full-auto";
  db.prepare(`
    INSERT INTO projects (id, name, mission, source, workdir, autopilot, base_branch)
    VALUES (?, 'Full Auto Fixture', 'Ship fixture files', 'local_import', ?, ?, 'main')
  `).run(projectId, workdir, opts.autopilot ?? "full");

  const insertAgent = db.prepare(`
    INSERT INTO agents (id, project_id, name, role, needs_worktree)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertAgent.run("agent-cto", projectId, "CTO", "cto", 1);
  insertAgent.run("agent-coder", projectId, "Coder", "coder", 1);
  insertAgent.run("agent-qa", projectId, "QA", "qa", opts.qaNeedsWorktree ?? 1);
  insertAgent.run("agent-reviewer", projectId, "Reviewer", "reviewer", opts.reviewerNeedsWorktree ?? 1);

  return projectId;
}

function streamJson(text: string, sessionId = "fake-session"): RunResult {
  const stdout = [
    JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text }] } }),
    JSON.stringify({ type: "result", session_id: sessionId, result: text }),
  ].join("\n");
  return { stdout, stderr: "", exitCode: 0, sessionId, provider: "claude" };
}

function passVerification(): string {
  return `\`\`\`json
{
  "verdict": "pass",
  "severity": "auto-resolve",
  "dimensions": {
    "functionality": { "value": 8, "notes": "fixture pass" },
    "dataFlow": { "value": 8, "notes": "fixture pass" },
    "designAlignment": { "value": 8, "notes": "fixture pass" },
    "craft": { "value": 8, "notes": "fixture pass" },
    "edgeCases": { "value": 8, "notes": "fixture pass" }
  },
  "issues": [],
  "knownGaps": []
}
\`\`\``;
}

let fakeSessionSeq = 0;
let fakeSessionRowSeq = 0;
let missionGenerationCount = 0;

class FakeSession extends EventEmitter implements AgentSession {
  id = `fake-${++fakeSessionSeq}`;
  process = null;
  status: AgentSession["status"] = "idle";
  lastSessionId: string | null = null;

  constructor(
    private readonly workdir: string,
    private readonly runtimeSessionId = `runtime-${fakeSessionSeq}`,
  ) {
    super();
  }

  private stream(text: string): RunResult {
    const result = streamJson(text, this.runtimeSessionId);
    this.lastSessionId = result.sessionId;
    return result;
  }

  async send(message: string): Promise<RunResult> {
    this.status = "working";
    this.emit("status", "working");

    if (message.includes("# Mission Analysis")) {
      missionGenerationCount++;
      if (missionGenerationCount > 1) {
        return this.stream(`\`\`\`json
{"goals":[]}
\`\`\``);
      }
      return this.stream(`\`\`\`json
{"goals":[{"title":"Fixture goal","description":"Add fixture files","priority":"high"}]}
\`\`\``);
    }

    if (message.includes("# Goal Decomposition")) {
      return this.stream(`\`\`\`json
{
  "tasks": [
    {
      "title": "Implement first fixture",
      "description": "Create the first fixture file.",
      "role": "coder",
      "priority": "high",
      "order": 1,
      "type": "code",
      "target_files": ["feature-one.txt"],
      "stack_hint": "Node filesystem/git fixture",
      "depends_on": []
    },
    {
      "title": "Implement second fixture",
      "description": "Create the second fixture file.",
      "role": "coder",
      "priority": "high",
      "order": 2,
      "type": "code",
      "target_files": ["feature-two.txt"],
      "stack_hint": "Node filesystem/git fixture",
      "depends_on": []
    }
  ]
}
\`\`\``);
    }

    if (message.includes("# Task: Implement first fixture")) {
      writeFileSync(join(this.workdir, "feature-one.txt"), "one\n");
      return this.stream("Implemented first fixture.");
    }

    if (message.includes("# Task: Implement second fixture")) {
      writeFileSync(join(this.workdir, "feature-two.txt"), "two\n");
      return this.stream("Implemented second fixture.");
    }

    if (message.includes("# Task: [실전 QA 회귀]")) {
      return this.stream("회귀 없음, 핵심 기능 정상");
    }

    if (message.includes("Quality Verification")) {
      return this.stream(passVerification());
    }

    if (message.includes("\"before\"") && message.includes("\"changed\"")) {
      return this.stream(`\`\`\`json
{"before":"fixture before","changed":"fixture changed","after":"fixture after","notes":""}
\`\`\``);
    }

    return this.stream("No-op.");
  }

  kill(): void {
    this.status = "completed";
  }

  cleanup(): void {
    this.kill();
  }
}

class FakeSessionManager implements SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly records = new Map<string, SessionRecord>();
  readonly spawns: Array<{ agentId: string; workdir: string; sessionKey?: string }> = [];

  constructor(private readonly opts: { reuseEvaluatorRuntimeSession?: boolean } = {}) {}

  spawnAgent(agentId: string, projectWorkdir: string, sessionKey?: string): AgentSession {
    const key = sessionKey ?? agentId;
    this.spawns.push({ agentId, workdir: projectWorkdir, sessionKey });
    const implementationRuntimeId = this.records.get("agent-coder")?.runtimeSessionId ?? undefined;
    const runtimeSessionId = this.opts.reuseEvaluatorRuntimeSession && key.startsWith("evaluator-")
      ? implementationRuntimeId
      : undefined;
    const session = new FakeSession(projectWorkdir, runtimeSessionId);
    const record: SessionRecord = {
      sessionKey: key,
      agentId,
      rowId: `fake-session-row-${++fakeSessionRowSeq}`,
      provider: "claude",
      runtimeSessionId: session.lastSessionId,
    };
    const rawSend = session.send.bind(session);
    session.send = async (message: string) => {
      const result = await rawSend(message);
      record.runtimeSessionId = result.sessionId;
      return result;
    };
    this.sessions.set(key, session);
    this.records.set(key, record);
    return session;
  }

  getSession(agentId: string): AgentSession | undefined {
    return this.sessions.get(agentId);
  }

  getSessionRecord(sessionKey: string): SessionRecord | undefined {
    return this.records.get(sessionKey);
  }

  killSession(agentId: string): void {
    this.sessions.delete(agentId);
  }

  killAll(): void {
    this.sessions.clear();
    this.records.clear();
  }

  pauseSession(): void {}
  resumeSession(): void {}
  setProviderOverride(_sessionKey: string, _provider: AgentProvider): void {}
  clearProviderOverride(): void {}
}

async function startGoalApi(db: Database.Database): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use("/api/goals", createGoalRoutes({
    db,
    wss: {} as any,
    broadcast: () => {},
  }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

async function readGoalStatus(baseUrl: string, goalId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/goals/${goalId}/status`);
  expect(res.status).toBe(200);
  return res.json();
}

async function readSquashPreview(baseUrl: string, goalId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/goals/${goalId}/squash-preview`);
  expect(res.status).toBe(200);
  return res.json();
}

async function approveSquash(baseUrl: string, goalId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/goals/${goalId}/squash-approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function waitFor<T>(
  read: () => T | null | undefined | false,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch { /* best effort */ }
  }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (previousDataDir === undefined) {
    delete process.env.CREWDECK_DATA_DIR;
  } else {
    process.env.CREWDECK_DATA_DIR = previousDataDir;
  }
});

describe("Goal-as-Unit E2E — Full Auto worktree 기록", () => {
  it("status API가 metadata 없는 goal-level squash 실패 activity를 failed goal에 포함한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-blocked-status-activity";
    const message = "[goal-as-unit] Squash 차단: legacy activity without metadata";

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model, squash_status)
      VALUES (?, ?, 'Blocked status fixture', 'Verify legacy blocked activity', 'high', 'goal_as_unit', 'blocked')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO activities (project_id, type, message)
      VALUES (?, 'goal_squash_blocked', ?)
    `).run(projectId, message);

    const api = await startGoalApi(db);
    try {
      const status = await readGoalStatus(api.baseUrl, goalId);
      expect(status.status).toBe("failed");
      expect(status.activity_events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "goal_squash_blocked",
          message,
        }),
      ]));
    } finally {
      await api.close();
    }
  });

  it("Quality Gate가 구현 세션을 evaluator_session_id로 재사용하면 fail verification과 activity를 남긴다", { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-session-separation";
    const taskId = "task-session-separation";
    const sessions = new FakeSessionManager({ reuseEvaluatorRuntimeSession: true });
    const api = await startGoalApi(db);

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Session separation fixture', 'Verify evaluator session separation', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'in_review', 'code')
    `).run(taskId, goalId, projectId);

    try {
      const implementationSession = sessions.spawnAgent("agent-coder", repo);
      const implementationResult = await implementationSession.send("# Task: Implement first fixture");
      const implementationSessionId = implementationResult.sessionId;
      sessions.killSession("agent-coder");

      const qualityGate = createQualityGate(db, sessions, () => {});
      const result = await qualityGate.verify(taskId, { scope: "standard", workdir: repo });

      expect(result.verdict).toBe("fail");
      expect(result.evaluatorSessionId).toBe(implementationSessionId);
      expect(result.issues[0]?.id).toBe("issue-evaluator-session-reused");

      const verificationRow = db.prepare(`
        SELECT verdict, evaluator_session_id, issues
        FROM verifications
        WHERE task_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get(taskId) as { verdict: string; evaluator_session_id: string | null; issues: string } | undefined;
      expect(verificationRow?.verdict).toBe("fail");
      expect(verificationRow?.evaluator_session_id).toBe(implementationSessionId);
      expect(JSON.parse(verificationRow?.issues ?? "[]")[0]?.id).toBe("issue-evaluator-session-reused");

      const activity = db.prepare(`
        SELECT type, message, metadata
        FROM activities
        WHERE project_id = ? AND type = 'verification_fail'
        ORDER BY id DESC
        LIMIT 1
      `).get(projectId) as { type: string; message: string; metadata: string } | undefined;
      expect(activity?.message).toContain("session separation failed");
      expect(JSON.parse(activity?.metadata ?? "{}")).toMatchObject({
        taskId,
        reason: "evaluator_session_reused",
        implementationSessionId,
        evaluatorSessionId: implementationSessionId,
      });

      const status = await readGoalStatus(api.baseUrl, goalId);
      expect(status.evaluator_session_id).toBe(implementationSessionId);
      expect(status.activity_events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "verification_fail",
          message: expect.stringContaining("session separation failed"),
        }),
      ]));
    } finally {
      await api.close();
    }
  });

  it("QA 회귀 태스크 생성이 누락되면 squash를 차단하고 activity log에 단계 실패를 남긴다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-qa-regression-missing";
    const taskId = "task-last-implementation";
    const sessions = new FakeSessionManager();
    let agentsRemoved = false;

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'QA regression missing fixture', 'Verify QA regression failure activity', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'todo', 'code')
    `).run(taskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, (event) => {
      if (event !== "verification:result" || agentsRemoved) return;
      agentsRemoved = true;
      db.prepare("DELETE FROM agents WHERE project_id = ?").run(projectId);
    });

    const result = await engine.executeTask(taskId, { autoFix: false });
    expect(result).toMatchObject({ success: true, verdict: "pass" });

    const qaTask = db.prepare(`
      SELECT id FROM tasks
      WHERE goal_id = ? AND title = '[실전 QA 회귀] 앱 실행 + 전체 diff 리뷰'
    `).get(goalId) as { id: string } | undefined;
    expect(qaTask).toBeUndefined();

    const goal = db.prepare(`
      SELECT squash_status, qa_regression_task_id
      FROM goals WHERE id = ?
    `).get(goalId) as { squash_status: string; qa_regression_task_id: string | null } | undefined;
    expect(goal?.squash_status).toBe("blocked");
    expect(goal?.qa_regression_task_id).toBeNull();

    const activity = db.prepare(`
      SELECT type, message, metadata
      FROM activities
      WHERE project_id = ? AND type = 'qa_regression_failed'
      ORDER BY id DESC
      LIMIT 1
    `).get(projectId) as { type: string; message: string; metadata: string } | undefined;
    expect(activity?.message).toContain("QA 회귀 태스크 생성 실패");
    expect(activity?.message).toContain("squash 차단");
    expect(JSON.parse(activity?.metadata ?? "{}")).toMatchObject({
      goalId,
      reason: "no_agent",
      sourceTaskId: taskId,
    });
  });

  it("구현/QA는 PASS했지만 goal 브랜치에 반영할 커밋이 없으면 pending_approval 대신 squash를 차단한다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-empty-branch";
    const qaTaskId = "task-qa-regression-done";
    const implTaskId = "task-impl-no-changes";
    const sessions = new FakeSessionManager();

    // qa_regression_task_id 를 이미 done QA 태스크로 채워 squash 진입 조건을 만족시킨다.
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model, qa_regression_task_id, squash_status)
      VALUES (?, ?, 'Empty branch fixture', 'No file changes produced', 'high', 'goal_as_unit', ?, 'none')
    `).run(goalId, projectId, qaTaskId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, '[실전 QA 회귀] 앱 실행 + 전체 diff 리뷰', 'QA regression', 'agent-qa', 'done', 'qa')
    `).run(qaTaskId, goalId, projectId);
    // 구현 태스크: 에이전트가 파일을 만들지 않음 (FakeSession 기본 No-op) → goal 브랜치가 빈 채로 남는다.
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'No-op implementation', 'Produce no file changes.', 'agent-coder', 'todo', 'code')
    `).run(implTaskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, () => {});
    const result = await engine.executeTask(implTaskId, { autoFix: false });
    expect(result).toMatchObject({ success: true, verdict: "pass" });

    // 계약: 반영할 커밋이 없으면 승인 게이트(pending_approval)가 아니라 blocked 여야 한다.
    const goal = db.prepare(
      "SELECT squash_status, squash_commit_sha FROM goals WHERE id = ?",
    ).get(goalId) as { squash_status: string; squash_commit_sha: string | null } | undefined;
    expect(goal?.squash_status).toBe("blocked");
    expect(goal?.squash_commit_sha).toBeNull();

    const activity = db.prepare(`
      SELECT type, message FROM activities
      WHERE project_id = ? AND type = 'goal_squash_blocked'
      ORDER BY id DESC LIMIT 1
    `).get(projectId) as { type: string; message: string } | undefined;
    expect(activity?.message).toContain("반영할 커밋이 없음");
  });

  it("기존 커밋이 있어도 마지막 WIP commit이 실패하면 pending_approval 대신 squash를 차단한다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-wip-commit-fail";
    const qaTaskId = "task-qa-regression-done-wip-fail";
    const implTaskId = "task-impl-second-wip-fail";
    const goalBranch = "goal/wip-commit-fail-fixture";
    const worktreePath = join(repo, ".crewdeck-worktrees", "goal-wip-commit-fail-fixture");
    const sessions = new FakeSessionManager();
    const events: Array<{ event: string; data: any }> = [];

    mkdirSync(join(repo, ".crewdeck-worktrees"), { recursive: true });
    git(repo, "worktree", "add", "-b", goalBranch, worktreePath, "main");
    writeFileSync(join(worktreePath, "feature-one.txt"), "one\n");
    git(worktreePath, "add", "feature-one.txt");
    git(worktreePath, "commit", "-m", "feature one already committed");
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho wip commit rejected >&2\nexit 1\n");
    chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);

    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, priority, goal_model,
        qa_regression_task_id, squash_status, worktree_path, worktree_branch,
        acceptance_script
      )
      VALUES (?, ?, 'WIP commit fail fixture', 'Block approval when WIP commit fails', 'high', 'goal_as_unit',
        ?, 'none', ?, ?, 'test -f feature-one.txt && test -f feature-two.txt')
    `).run(goalId, projectId, qaTaskId, worktreePath, goalBranch);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, '[실전 QA 회귀] 앱 실행 + 전체 diff 리뷰', 'QA regression', 'agent-qa', 'done', 'qa')
    `).run(qaTaskId, goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement second fixture', 'Create the second fixture file.', 'agent-coder', 'todo', 'code')
    `).run(implTaskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, (event, data) => events.push({ event, data }));
    const result = await engine.executeTask(implTaskId, { autoFix: false });
    expect(result).toMatchObject({ success: true, verdict: "pass" });

    const goal = db.prepare(
      "SELECT squash_status, squash_commit_sha FROM goals WHERE id = ?",
    ).get(goalId) as { squash_status: string; squash_commit_sha: string | null } | undefined;
    expect(goal?.squash_status).toBe("blocked");
    expect(goal?.squash_commit_sha).toBeNull();
    expect(events.some((e) => e.event === "goal:squash_ready")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      event: "goal:squash_blocked",
      data: expect.objectContaining({ goalId, reason: "wip-commit-failed" }),
    }));

    const activity = db.prepare(`
      SELECT type, message FROM activities
      WHERE project_id = ? AND type = 'goal_squash_blocked'
      ORDER BY id DESC LIMIT 1
    `).get(projectId) as { type: string; message: string } | undefined;
    expect(activity?.message).toContain("WIP commit 실패");
    expect(git(worktreePath, "status", "--porcelain")).toContain("feature-two.txt");
  });

  it("서버 재시작 후 running/pending_approval goal의 worktree, evaluator 기록, activity_events를 복구한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const runningGoalId = "goal-restart-running";
    const pendingGoalId = "goal-restart-pending";
    const runningTaskId = "task-restart-running";
    const pendingTaskId = "task-restart-pending";
    const runningWorktree = addGoalWorktree(repo, "restart-running");
    const pendingWorktree = addGoalWorktree(repo, "restart-pending");
    const broadcasts: Array<{ event: string; data: any }> = [];

    writeFileSync(join(runningWorktree.path, "running-recovery.txt"), "running worktree must survive restart\n");
    writeFileSync(join(pendingWorktree.path, "pending-recovery.txt"), "pending approval worktree must survive restart\n");

    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, priority, goal_model,
        squash_status, worktree_path, worktree_branch
      )
      VALUES (?, ?, 'Restart running fixture', 'Recover running goal state', 'high', 'goal_as_unit',
        'none', ?, ?)
    `).run(runningGoalId, projectId, runningWorktree.path, runningWorktree.branch);
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, priority, goal_model,
        squash_status, worktree_path, worktree_branch
      )
      VALUES (?, ?, 'Restart pending fixture', 'Recover pending approval state', 'high', 'goal_as_unit',
        'pending_approval', ?, ?)
    `).run(pendingGoalId, projectId, pendingWorktree.path, pendingWorktree.branch);

    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement restart fixture', 'Interrupted during verification.', 'agent-coder', 'in_review', 'code')
    `).run(runningTaskId, runningGoalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement pending fixture', 'Ready for approval before restart.', 'agent-coder', 'done', 'code')
    `).run(pendingTaskId, pendingGoalId, projectId);

    db.prepare(`
      INSERT INTO verifications (id, task_id, verdict, scope, issues, evaluator_session_id)
      VALUES ('verification-restart-running', ?, 'fail', 'standard',
        '[{"severity":"hard-block","message":"failure visible after restart"}]',
        'eval-running-before-restart')
    `).run(runningTaskId);
    db.prepare("UPDATE tasks SET verification_id = 'verification-restart-running' WHERE id = ?")
      .run(runningTaskId);
    db.prepare(`
      INSERT INTO verifications (id, task_id, verdict, scope, evaluator_session_id)
      VALUES ('verification-restart-pending', ?, 'pass', 'standard', 'eval-pending-before-restart')
    `).run(pendingTaskId);
    db.prepare("UPDATE tasks SET verification_id = 'verification-restart-pending' WHERE id = ?")
      .run(pendingTaskId);

    db.prepare(`
      INSERT INTO activities (project_id, type, message, metadata)
      VALUES (?, 'verification_fail', ?, ?)
    `).run(
      projectId,
      "[restart] Quality Gate failed before server restart",
      JSON.stringify({ goalId: runningGoalId, taskId: runningTaskId, checkpoint: "quality-gate" }),
    );
    db.prepare(`
      INSERT INTO activities (project_id, type, message, metadata)
      VALUES (?, 'qa_regression_created', ?, ?)
    `).run(
      projectId,
      "[restart] QA regression completed before approval wait",
      JSON.stringify({ goalId: pendingGoalId, sourceTaskId: pendingTaskId, checkpoint: "qa-regression" }),
    );

    const recovery = recoverOnStartup(db);
    rebroadcastPendingApprovals(db, (event, data) => broadcasts.push({ event, data }));

    expect(recovery.recoveredTasks).toBe(1);
    expect(existsSync(runningWorktree.path)).toBe(true);
    expect(existsSync(pendingWorktree.path)).toBe(true);
    expect(existsSync(join(runningWorktree.path, "running-recovery.txt"))).toBe(true);
    expect(existsSync(join(pendingWorktree.path, "pending-recovery.txt"))).toBe(true);
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(runningTaskId))
      .toMatchObject({ status: "todo" });
    expect(broadcasts).toContainEqual(expect.objectContaining({
      event: "goal:squash_ready",
      data: expect.objectContaining({ goalId: pendingGoalId }),
    }));

    const api = await startGoalApi(db);
    try {
      const runningStatus = await readGoalStatus(api.baseUrl, runningGoalId);
      expect(runningStatus).toMatchObject({
        goal_id: runningGoalId,
        status: "running",
        worktree_path: runningWorktree.path,
        worktree_branch: runningWorktree.branch,
        evaluator_session_id: "eval-running-before-restart",
        approval_required: false,
      });
      expect(runningStatus.activity_events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "verification_fail",
          message: expect.stringContaining("Quality Gate failed before server restart"),
        }),
      ]));
      expect(runningStatus.activity_events.map((event: any) => event.message))
        .not.toContain("[restart] QA regression completed before approval wait");

      const pendingStatus = await readGoalStatus(api.baseUrl, pendingGoalId);
      expect(pendingStatus).toMatchObject({
        goal_id: pendingGoalId,
        status: "pending_approval",
        worktree_path: pendingWorktree.path,
        worktree_branch: pendingWorktree.branch,
        evaluator_session_id: "eval-pending-before-restart",
        approval_required: true,
      });
      expect(pendingStatus.activity_events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "qa_regression_created",
          message: expect.stringContaining("QA regression completed"),
        }),
      ]));
      expect(pendingStatus.activity_events.map((event: any) => event.message))
        .not.toContain("[restart] Quality Gate failed before server restart");
    } finally {
      await api.close();
    }
  });

  it("QA와 acceptance_script PASS 후 pending_approval과 squash preview를 남기고 승인 전 base branch를 건드리지 않는다", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo, {
      qaNeedsWorktree: 0,
      reviewerNeedsWorktree: 0,
      autopilot: "goal",
    });
    const goalId = "goal-approval-gate";
    const sessions = new FakeSessionManager();
    const scheduler = createScheduler(db, sessions, () => {});
    const api = await startGoalApi(db);
    const markerDir = mkdtempSync(join(tmpdir(), "crewdeck-acceptance-marker-"));
    tempDirs.push(markerDir);
    const acceptanceMarker = join(markerDir, "ran");
    const acceptanceScript = `test -f feature-one.txt && test -f feature-two.txt && printf acceptance-ran > ${shellQuote(acceptanceMarker)}`;

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model, acceptance_script)
      VALUES (?, ?, 'Approval gate fixture', 'Verify approval gate state after acceptance', 'high', 'goal_as_unit', ?)
    `).run(goalId, projectId, acceptanceScript);

    try {
      const initialMainHead = git(repo, "rev-parse", "main");
      const initialMainCount = Number(git(repo, "rev-list", "--count", "main"));

      scheduler.startQueue(projectId);

      const readyGoal = await waitFor(() => {
        const row = db.prepare(`
          SELECT squash_status, squash_commit_sha, worktree_path, worktree_branch
          FROM goals WHERE id = ?
        `).get(goalId) as {
          squash_status: string;
          squash_commit_sha: string | null;
          worktree_path: string | null;
          worktree_branch: string | null;
        } | undefined;
        return row?.squash_status === "pending_approval" ? row : null;
      }, "pending approval after QA and acceptance", 30_000);
      scheduler.stopQueue(projectId);

      expect(readyGoal.squash_status).toBe("pending_approval");
      expect(readyGoal.squash_commit_sha).toBeNull();
      expect(readyGoal.worktree_path).toBeTruthy();
      expect(readyGoal.worktree_branch).toMatch(/^goal\/approval-gate-fixture-/);
      expect(existsSync(readyGoal.worktree_path!)).toBe(true);
      expect(existsSync(acceptanceMarker)).toBe(true);

      const qaTask = db.prepare(`
        SELECT t.status
        FROM tasks t
        JOIN goals g ON g.qa_regression_task_id = t.id
        WHERE g.id = ?
      `).get(goalId) as { status: string } | undefined;
      expect(qaTask?.status).toBe("done");

      expect(git(repo, "rev-parse", "main")).toBe(initialMainHead);
      expect(Number(git(repo, "rev-list", "--count", "main"))).toBe(initialMainCount);
      expect(existsSync(join(repo, "feature-one.txt"))).toBe(false);
      expect(existsSync(join(repo, "feature-two.txt"))).toBe(false);
      expect(git(repo, "status", "--porcelain")).toBe("");

      const status = await readGoalStatus(api.baseUrl, goalId);
      expect(status.status).toBe("pending_approval");
      expect(status.approval_required).toBe(true);
      expect(status.worktree_path).toBe(readyGoal.worktree_path);
      expect(status.worktree_branch).toBe(readyGoal.worktree_branch);

      const preview = await readSquashPreview(api.baseUrl, goalId);
      expect(preview).toMatchObject({
        goalId,
        squashStatus: "pending_approval",
        acceptanceScript,
      });
      expect(Object.prototype.hasOwnProperty.call(preview, "workReport")).toBe(true);
      expect(preview.commitMessage).toContain("Approval gate fixture");
      expect(preview.commitMessage).toContain("- Implement first fixture");
      expect(preview.commitMessage).toContain("- Implement second fixture");
      expect(preview.commitMessage).toContain("Generated by Crewdeck (Goal-as-Unit)");
      expect(preview.filesChanged.sort()).toEqual(["feature-one.txt", "feature-two.txt"]);
      expect(preview.workReport).toHaveProperty("summaryStatus");
      expect(["pending", "ready", "failed"]).toContain(preview.workReport.summaryStatus);
      expect(Array.isArray(preview.workReport.screenshots)).toBe(true);

      expect(git(repo, "rev-parse", "main")).toBe(initialMainHead);
      expect(Number(git(repo, "rev-list", "--count", "main"))).toBe(initialMainCount);
    } finally {
      scheduler.stopQueue(projectId);
      await api.close();
    }
  });

  it("Full Auto goal 실행 시 worktree_path/branch를 DB와 status API에 남기고 base branch에는 태스크별 commit을 만들지 않는다", { timeout: 60_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo, { qaNeedsWorktree: 0, reviewerNeedsWorktree: 0 });
    const sessions = new FakeSessionManager();
    const scheduler = createScheduler(db, sessions, () => {});
    const api = await startGoalApi(db);
    missionGenerationCount = 0;

    try {
      const initialMainCount = Number(git(repo, "rev-list", "--count", "main"));

      scheduler.startQueue(projectId);

      const goalAfterFirst = await waitFor(() => {
        const row = db.prepare(`
          SELECT id, worktree_path, worktree_branch
          FROM goals
          WHERE project_id = ? AND worktree_path IS NOT NULL AND worktree_branch IS NOT NULL
          ORDER BY created_at ASC
          LIMIT 1
        `).get(projectId) as { id: string; worktree_path: string | null; worktree_branch: string | null } | undefined;
        return row?.worktree_path && row?.worktree_branch ? row : null;
      }, "Full Auto goal worktree metadata");
      const goalId = goalAfterFirst.id;

      const tasks = await waitFor(() => {
        const rows = db.prepare(`
          SELECT id, title, status FROM tasks
          WHERE goal_id = ? AND title LIKE 'Implement %'
          ORDER BY sort_order ASC
        `).all(goalId) as { id: string; title: string; status: string }[];
        return rows.length === 2 ? rows : null;
      }, "decomposed implementation tasks");
      expect(tasks.map((t) => t.title)).toEqual([
        "Implement first fixture",
        "Implement second fixture",
      ]);

      expect(goalAfterFirst.worktree_path).toBeTruthy();
      expect(goalAfterFirst.worktree_branch).toMatch(/^goal\/fixture-goal-/);
      expect(existsSync(goalAfterFirst.worktree_path!)).toBe(true);
      expect(git(goalAfterFirst.worktree_path!, "rev-parse", "--abbrev-ref", "HEAD"))
        .toBe(goalAfterFirst.worktree_branch);
      expect(Number(git(repo, "rev-list", "--count", "main"))).toBe(initialMainCount);

      const statusAfterFirst = await readGoalStatus(api.baseUrl, goalId);
      expect(statusAfterFirst.status).toBe("running");
      expect(statusAfterFirst.worktree_path).toBe(goalAfterFirst.worktree_path);
      expect(statusAfterFirst.worktree_branch).toBe(goalAfterFirst.worktree_branch);

      await waitFor(() => {
        const rows = db.prepare(`
          SELECT title, status FROM tasks
          WHERE goal_id = ? AND title LIKE 'Implement %'
          ORDER BY sort_order ASC
        `).all(goalId) as { title: string; status: string }[];
        return rows.length === 2 && rows.every((t) => t.status === "done") ? rows : null;
      }, "implementation tasks done");
      expect(Number(git(repo, "rev-list", "--count", "main"))).toBe(initialMainCount);
      expect(existsSync(join(repo, "feature-one.txt"))).toBe(false);
      expect(existsSync(join(repo, "feature-two.txt"))).toBe(false);
      expect(git(repo, "status", "--porcelain")).toBe("");

      await waitFor(() => {
        const row = db.prepare(`
          SELECT id, status FROM tasks
          WHERE goal_id = ? AND title = '[실전 QA 회귀] 앱 실행 + 전체 diff 리뷰'
        `).get(goalId) as { id: string; status: string } | undefined;
        return row?.status === "done" ? row : null;
      }, "QA regression task done");
      const qaSpawn = sessions.spawns.find((spawn) => spawn.agentId === "agent-qa");
      expect(qaSpawn?.workdir).toBe(goalAfterFirst.worktree_path);
      expect(Number(git(repo, "rev-list", "--count", "main"))).toBe(initialMainCount);

      const readyGoal = await waitFor(() => {
        const row = db.prepare(`
          SELECT squash_status, worktree_path, worktree_branch
          FROM goals WHERE id = ?
        `).get(goalId) as { squash_status: string; worktree_path: string | null; worktree_branch: string | null } | undefined;
        return row?.squash_status === "pending_approval" ? row : null;
      }, "pending approval squash gate");
      scheduler.stopQueue(projectId);

      expect(readyGoal.squash_status).toBe("pending_approval");
      expect(readyGoal.worktree_path).toBe(goalAfterFirst.worktree_path);
      expect(readyGoal.worktree_branch).toBe(goalAfterFirst.worktree_branch);
      expect(Number(git(repo, "rev-list", "--count", readyGoal.worktree_branch!))).toBe(initialMainCount + 1);
      expect(existsSync(join(repo, "feature-one.txt"))).toBe(false);
      expect(existsSync(join(repo, "feature-two.txt"))).toBe(false);
      expect(git(repo, "status", "--porcelain")).toBe("");

      const statusBeforeApproval = await readGoalStatus(api.baseUrl, goalId);
      expect(statusBeforeApproval.status).toBe("pending_approval");
      expect(statusBeforeApproval.worktree_path).toBe(readyGoal.worktree_path);
      expect(statusBeforeApproval.worktree_branch).toBe(readyGoal.worktree_branch);

      const preApproveSubjects = git(repo, "log", "--pretty=%s", "main");
      expect(preApproveSubjects).not.toContain("Implement first fixture");
      expect(preApproveSubjects).not.toContain("Implement second fixture");

      const approval = await approveSquash(api.baseUrl, goalId);
      expect(approval.success).toBe(true);
      expect(approval.sha).toBeTruthy();
      expect(Number(git(repo, "rev-list", "--count", "main"))).toBe(initialMainCount + 1);
      expect(git(repo, "show", "main:feature-one.txt")).toBe("one");
      expect(git(repo, "show", "main:feature-two.txt")).toBe("two");

      const mainSubjects = git(repo, "log", "--pretty=%s", "main");
      expect(mainSubjects.split("\n")[0]).toBe("Fixture goal");
      expect(mainSubjects).not.toContain("Implement first fixture");
      expect(mainSubjects).not.toContain("Implement second fixture");
      expect(existsSync(join(repo, "feature-one.txt"))).toBe(true);
      expect(existsSync(join(repo, "feature-two.txt"))).toBe(true);
    } finally {
      scheduler.stopQueue(projectId);
      await api.close();
    }
  });
});
