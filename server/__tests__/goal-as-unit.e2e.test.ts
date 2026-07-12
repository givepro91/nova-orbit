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
import { flushVerificationBroadcastOutbox } from "../core/quality-gate/outbox.js";
import { recoverOnStartup, rebroadcastPendingApprovals } from "../core/recovery.js";
import { approveSpecVersion, saveSpecDraft } from "../core/goal-spec/spec-approval.js";
import type { ExecutionSessionContext, SessionManager, SessionRecord } from "../core/agent/session.js";
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
  "dimensionJudgements": [
    { "dimension": "functionality", "verdict": "pass", "evidence": "fixture functionality" },
    { "dimension": "dataFlow", "verdict": "pass", "evidence": "fixture data flow" },
    { "dimension": "designAlignment", "verdict": "pass", "evidence": "fixture design" },
    { "dimension": "craft", "verdict": "pass", "evidence": "fixture craft" },
    { "dimension": "edgeCases", "verdict": "pass", "evidence": "fixture edge cases" }
  ],
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

function failVerification(): string {
  return `\`\`\`json
{
  "verdict": "fail",
  "severity": "hard-block",
  "dimensionJudgements": [
    { "dimension": "functionality", "verdict": "fail", "evidence": "npm test -- null-case 실패" },
    { "dimension": "dataFlow", "verdict": "pass", "evidence": "저장/조회 경로 확인" },
    { "dimension": "designAlignment", "verdict": "pass", "evidence": "기존 패턴과 일치" },
    { "dimension": "craft", "verdict": "fail", "evidence": "null guard 누락" },
    { "dimension": "edgeCases", "verdict": "fail", "evidence": "null 입력 실패" }
  ],
  "issues": [{
    "dimension": "functionality",
    "severity": "critical",
    "file": "feature-one.txt",
    "line": 1,
    "message": "null 입력에서 crash",
    "reproCommand": "npm test -- null-case",
    "expectedResult": "오류 응답 반환",
    "actualResult": "TypeError 발생",
    "fixInstruction": "null guard를 추가한다"
  }],
  "knownGaps": []
}
\`\`\``;
}

function conditionalVerification(): string {
  return `\`\`\`json
{
  "verdict": "conditional",
  "severity": "soft-block",
  "dimensionJudgements": [
    { "dimension": "functionality", "verdict": "pass", "evidence": "fixture functionality" },
    { "dimension": "dataFlow", "verdict": "pass", "evidence": "fixture data flow" },
    { "dimension": "designAlignment", "verdict": "pass", "evidence": "fixture design" },
    { "dimension": "craft", "verdict": "pass", "evidence": "fixture craft" },
    { "dimension": "edgeCases", "verdict": "pass", "evidence": "fixture edge cases" }
  ],
  "issues": [{
    "dimension": "edgeCases",
    "severity": "warning",
    "file": "feature-one.txt",
    "line": 1,
    "message": "경계값 케이스 미확인",
    "reproCommand": "npm test -- edge-case",
    "expectedResult": "경계값도 통과",
    "actualResult": "미검증",
    "fixInstruction": "경계값 테스트를 추가한다"
  }],
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
    private readonly verificationResponse = passVerification(),
    private readonly decompositionResponse?: string,
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
      if (this.decompositionResponse !== undefined) {
        return this.stream(this.decompositionResponse);
      }
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
      return this.stream(this.verificationResponse);
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
  private verificationSpawnCount = 0;
  private verificationCount = 0;
  readonly spawns: Array<{
    agentId: string;
    workdir: string;
    sessionKey?: string;
    taskId?: string | null;
    executionContext?: ExecutionSessionContext;
  }> = [];
  readonly prompts: string[] = [];

  constructor(private readonly opts: {
    reuseEvaluatorRuntimeSession?: boolean;
    reuseEvaluatorRuntimeSessionId?: string;
    evaluatorRowId?: string;
    verificationResponse?: string;
    verificationResponses?: string[];
    verificationExitCode?: number;
    verificationUsage?: { inputTokens: number; outputTokens: number; costUsd: number };
    failVerificationOnce?: boolean;
    fixWritesChange?: boolean;
    fixExitCode?: number;
    abnormalRecoveryDecision?: "resume" | "advance" | "wait_approval" | "blocked";
    onPrompt?: (message: string) => void;
    decompositionResponse?: string;
  } = {}) {}

  readonly recoveries: Array<{ phase: string; mode: string; reason: string }> = [];

  spawnAgent(
    agentId: string,
    projectWorkdir: string,
    sessionKey?: string,
    taskId?: string | null,
    executionContext?: ExecutionSessionContext,
  ): AgentSession {
    const key = sessionKey ?? agentId;
    this.spawns.push({ agentId, workdir: projectWorkdir, sessionKey, taskId, executionContext });
    const implementationRuntimeId = this.records.get("agent-coder")?.runtimeSessionId ?? undefined;
    const runtimeSessionId = key.startsWith("evaluator-")
      ? (this.opts.reuseEvaluatorRuntimeSessionId
          ?? (this.opts.reuseEvaluatorRuntimeSession ? implementationRuntimeId : undefined))
      : undefined;
    const verificationResponse = key.startsWith("evaluator-") && this.opts.verificationResponses
      ? this.opts.verificationResponses[
          Math.min(this.verificationSpawnCount++, this.opts.verificationResponses.length - 1)
        ]
      : this.opts.verificationResponse;
    const session = new FakeSession(
      projectWorkdir,
      runtimeSessionId,
      verificationResponse,
      this.opts.decompositionResponse,
    );
    const record: SessionRecord = {
      sessionKey: key,
      agentId,
      rowId: key.startsWith("evaluator-") && this.opts.evaluatorRowId
        ? this.opts.evaluatorRowId
        : `fake-session-row-${++fakeSessionRowSeq}`,
      provider: "claude",
      runtimeSessionId: session.lastSessionId,
    };
    const rawSend = session.send.bind(session);
    session.send = async (message: string) => {
      if (this.opts.fixWritesChange && message.includes("# Fix Required")) {
        writeFileSync(join(projectWorkdir, "feature-one.txt"), "fixed\n");
      }
      this.prompts.push(message);
      this.opts.onPrompt?.(message);
      let result = await rawSend(message);
      if (message.includes("Quality Verification") && this.opts.verificationUsage) {
        const usage = this.opts.verificationUsage;
        result = {
          ...result,
          stdout: `${result.stdout}\n${JSON.stringify({
            type: "result",
            session_id: result.sessionId,
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
            },
            total_cost_usd: usage.costUsd,
          })}`,
          exitCode: this.opts.verificationExitCode ?? result.exitCode,
        };
      }
      if (this.opts.fixExitCode !== undefined && message.includes("# Fix Required")) {
        result = { ...result, exitCode: this.opts.fixExitCode };
      }
      if (this.opts.failVerificationOnce && message.includes("Quality Verification") && this.verificationCount++ === 0) {
        result = streamJson(failVerification(), result.sessionId ?? undefined);
      }
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
  recoverAbnormalExit(
    _sessionKey: string,
    phase: "implementation" | "verification" | "fix" | "approval",
    mode: "reconcile" | "advance",
    reason: string,
  ): "resume" | "advance" | "wait_approval" | "blocked" | null {
    this.recoveries.push({ phase, mode, reason });
    return this.opts.abnormalRecoveryDecision ?? null;
  }
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

// 전체 스위트를 병렬로 돌리면 로컬 express 서버로의 fetch가 부하로 간헐적으로
// "fetch failed"/ECONNRESET(연결 단계 리셋)을 낸다. 연결이 서지 않은 것이므로
// 짧은 백오프로 재시도해 flaky 실패를 흡수한다.
async function fetchWithRetry(input: string, init?: RequestInit, attempts = 5): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)));
    }
  }
  throw lastErr;
}

async function readGoalStatus(baseUrl: string, goalId: string): Promise<any> {
  const res = await fetchWithRetry(`${baseUrl}/api/goals/${goalId}/status`);
  expect(res.status).toBe(200);
  return res.json();
}

async function readVerificationTimeline(baseUrl: string, goalId: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/goals/${goalId}/verification-timeline`);
  expect(res.status).toBe(200);
  return res.json();
}

async function readSquashPreview(baseUrl: string, goalId: string): Promise<any> {
  const res = await fetchWithRetry(`${baseUrl}/api/goals/${goalId}/squash-preview`);
  expect(res.status).toBe(200);
  return res.json();
}

async function approveSquash(baseUrl: string, goalId: string): Promise<any> {
  const res = await fetchWithRetry(`${baseUrl}/api/goals/${goalId}/squash-approve`, {
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
  it("분해·구현·검증이 승인된 동일 snapshot을 사용하고 legacy 변경을 무시한다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-approved-spec-context";
    let approvedDuringDecompose = false;
    const sessions = new FakeSessionManager({
      onPrompt: (message) => {
        if (!message.includes("# Goal Decomposition") || approvedDuringDecompose) return;
        approvedDuringDecompose = true;
        const nextVersion = saveSpecDraft(db, goalId, {
          scope: "approved-v2 scope",
          out_of_scope: "excluded-v2",
          acceptance_criteria: ["v2 acceptance"],
          expected_tasks: ["v2 expected task"],
          verification_methods: ["v2 verification"],
        });
        approveSpecVersion(db, goalId, nextVersion.id);
      },
    });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority)
      VALUES (?, ?, 'Approved blueprint fixture', 'goal', 'high')
    `).run(goalId, projectId);
    const approvedVersion = saveSpecDraft(db, goalId, {
      scope: "approved-v1 scope",
      out_of_scope: "excluded-v1",
      acceptance_criteria: ["approved acceptance"],
      expected_tasks: ["approved expected task"],
      verification_methods: ["approved verification"],
    });
    approveSpecVersion(db, goalId, approvedVersion.id);
    db.prepare(`
      INSERT INTO goal_specs
        (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by)
      VALUES (?, ?, '[]', '[]', '[]', '[]', 'manual')
    `).run(goalId, JSON.stringify({ scope: "unapproved legacy scope" }));

    const engine = createOrchestrationEngine(db, sessions, () => {});
    const decomposed = await engine.decomposeGoal(goalId);
    expect(decomposed.taskCount).toBeGreaterThan(0);
    const task = db.prepare(`
      SELECT id, execution_run_id, execution_spec_version_id
      FROM tasks WHERE goal_id = ? ORDER BY sort_order ASC LIMIT 1
    `).get(goalId) as {
      id: string;
      execution_run_id: string;
      execution_spec_version_id: string;
    };
    expect(task.execution_run_id).toBeTruthy();
    expect(task.execution_spec_version_id).toBe(approvedVersion.id);
    expect(db.prepare(`
      SELECT execution_spec_version_id FROM goal_execution_runs WHERE id = ?
    `).get(task.execution_run_id)).toEqual({ execution_spec_version_id: approvedVersion.id });
    expect(sessions.spawns.find((spawn) => spawn.sessionKey === `decompose-${goalId}`)?.executionContext)
      .toEqual({
        executionRunId: task.execution_run_id,
        executionSpecVersionId: approvedVersion.id,
      });
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(task.id);

    const result = await engine.executeTask(task.id, { autoFix: false });
    expect(result.verdict).toBe("pass");

    const relevantPrompts = sessions.prompts.filter((prompt) =>
      prompt.includes("# Goal Decomposition") ||
      prompt.includes("# Task: Implement first fixture") ||
      prompt.includes("Quality Verification"),
    );
    expect(relevantPrompts).toHaveLength(3);
    for (const prompt of relevantPrompts) {
      expect(prompt).toContain(`id: ${approvedVersion.id}`);
      expect(prompt).toContain("approved-v1 scope");
      expect(prompt).toContain("excluded-v1");
      expect(prompt).toContain("approved acceptance");
      expect(prompt).toContain("approved expected task");
      expect(prompt).toContain("approved verification");
      expect(prompt).not.toContain("unapproved legacy scope");
      expect(prompt).not.toContain("approved-v2 scope");
    }
  });

  it("유효 task가 없는 decompose는 run을 failed로 닫고 pin을 해제한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-empty-decomposition";
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority)
      VALUES (?, ?, 'Empty decomposition', 'goal', 'high')
    `).run(goalId, projectId);
    const version = saveSpecDraft(db, goalId, {
      scope: "scope",
      out_of_scope: "none",
      acceptance_criteria: ["accepted"],
      expected_tasks: ["task"],
      verification_methods: ["test"],
    });
    approveSpecVersion(db, goalId, version.id);
    const engine = createOrchestrationEngine(
      db,
      new FakeSessionManager({ decompositionResponse: '```json\n{"tasks":[]}\n```' }),
      () => {},
    );

    await expect(engine.decomposeGoal(goalId)).rejects.toThrow("produced no valid tasks");
    expect(db.prepare(`
      SELECT active_execution_run_id FROM goals WHERE id = ?
    `).get(goalId)).toEqual({ active_execution_run_id: null });
    expect(db.prepare(`
      SELECT status, execution_spec_version_id
      FROM goal_execution_runs WHERE goal_id = ?
    `).get(goalId)).toEqual({
      status: "failed",
      execution_spec_version_id: version.id,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE goal_id = ?").get(goalId))
      .toEqual({ count: 0 });
  });

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

  it("구조화 판정과 이슈를 normalized tables에 함께 저장한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-normalized-verification";
    const taskId = "task-normalized-verification";
    const sessions = new FakeSessionManager({ verificationResponse: failVerification() });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Normalized verification', 'Persist structured result', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Structured failure', 'Persist all evaluator fields.', 'agent-coder', 'in_review', 'code')
    `).run(taskId, goalId, projectId);
    writeFileSync(join(repo, "feature-one.txt"), "changed\n");

    const result = await createQualityGate(db, sessions, () => {}).verify(taskId, {
      scope: "full",
      workdir: repo,
    });

    expect(result.verdict).toBe("fail");
    expect(result.dimensionJudgements).toHaveLength(5);
    expect(db.prepare(
      "SELECT count(*) AS count FROM verification_dimension_judgements WHERE verification_id = ?",
    ).get(result.id)).toEqual({ count: 5 });
    expect(db.prepare(`
      SELECT dimension, severity, evidence, repro_command, expected_result,
             actual_result, fix_instruction, assignee_id
      FROM verification_issues WHERE verification_id = ?
    `).get(result.id)).toMatchObject({
      dimension: "functionality",
      severity: "critical",
      evidence: "null 입력에서 crash",
      repro_command: "npm test -- null-case",
      expected_result: "오류 응답 반환",
      actual_result: "TypeError 발생",
      fix_instruction: "null guard를 추가한다",
      assignee_id: "agent-coder",
    });
  });

  it("evaluator가 usage를 보고한 뒤 non-zero 종료해도 실패 비용을 저장한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-failed-evaluator-usage";
    const taskId = "task-failed-evaluator-usage";
    const evaluatorRowId = "eval-row";
    const sessions = new FakeSessionManager({
      evaluatorRowId,
      verificationExitCode: 1,
      verificationUsage: { inputTokens: 100, outputTokens: 20, costUsd: 0.03 },
    });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Failed evaluator usage', 'Persist usage before exit failure', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Failed evaluator', 'Evaluator exits after reporting usage.', 'agent-coder', 'in_review', 'code')
    `).run(taskId, goalId, projectId);
    db.prepare(`
      INSERT INTO sessions (id, agent_id, status, provider, task_id)
      VALUES (?, 'agent-reviewer', 'active', 'claude', ?)
    `).run(evaluatorRowId, taskId);

    await expect(createQualityGate(db, sessions, () => {}).verify(taskId, {
      scope: "full",
      workdir: repo,
    })).rejects.toThrow("Verification session exited with code 1");

    expect(db.prepare(`
      SELECT token_usage, cost_usd, token_usage_reported, cost_usd_reported
      FROM sessions WHERE id = ?
    `).get(evaluatorRowId)).toEqual({
      token_usage: 120,
      cost_usd: 0.03,
      token_usage_reported: 1,
      cost_usd_reported: 1,
    });
  });

  it("판정·감사 저장 후 broadcast가 실패해도 outbox에서 재전송한다", { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-verification-outbox";
    const taskId = "task-verification-outbox";
    const sessions = new FakeSessionManager();

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Verification outbox', 'Persist before broadcast', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Outbox fixture', 'Persist event.', 'agent-coder', 'in_review', 'code')
    `).run(taskId, goalId, projectId);
    writeFileSync(join(repo, "outbox.txt"), "changed\n");

    const result = await createQualityGate(db, sessions, (event) => {
      if (event === "verification:result") throw new Error("socket unavailable");
    }).verify(taskId, { scope: "full", workdir: repo });

    expect(result.verdict).toBe("pass");
    expect(db.prepare("SELECT count(*) AS count FROM verifications WHERE id = ?").get(result.id))
      .toEqual({ count: 1 });
    const passActivity = db.prepare(`
      SELECT metadata FROM activities
      WHERE project_id = ? AND type = 'verification_pass'
      ORDER BY id DESC LIMIT 1
    `).get(projectId) as { metadata: string } | undefined;
    expect(JSON.parse(passActivity?.metadata ?? "{}")).toMatchObject({
      taskId,
      status: "passed",
      reason: "passed",
    });
    expect(db.prepare(`
      SELECT delivered_at, attempts, last_error
      FROM verification_broadcast_outbox WHERE verification_id = ?
    `).get(result.id)).toMatchObject({
      delivered_at: null,
      attempts: 1,
      last_error: "socket unavailable",
    });

    const replayed: Array<{ event: string; payload: any }> = [];
    expect(flushVerificationBroadcastOutbox(db, (event, payload) => replayed.push({ event, payload }))).toBe(1);
    expect(replayed).toEqual([{
      event: "verification:result",
      payload: expect.objectContaining({ id: result.id, taskId, verdict: "pass" }),
    }]);
    expect(db.prepare(`
      SELECT delivered_at, attempts FROM verification_broadcast_outbox WHERE verification_id = ?
    `).get(result.id)).toMatchObject({ delivered_at: expect.any(String), attempts: 2 });
  });

  it("verification timeline API가 공개 계약과 issue lifecycle을 다중 라운드로 반환한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-verification-timeline";
    const taskId = "task-verification-timeline";
    const fixTaskId = "task-verification-fix";

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Verification timeline', 'Expose rounds', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Timeline fixture', 'Expose rounds.', 'agent-coder', 'in_review', 'code')
    `).run(taskId, goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Fix timeline fixture', 'Fix issue.', 'agent-coder', 'done', 'code')
    `).run(fixTaskId, goalId, projectId);

    const scores = JSON.stringify(Object.fromEntries([
      "functionality", "dataFlow", "designAlignment", "craft", "edgeCases",
    ].map((dimension) => [dimension, { value: 8, notes: `${dimension} notes` }])));
    const insertVerification = db.prepare(`
      INSERT INTO verifications (
        id, task_id, verdict, scope, dimensions, severity,
        evaluator_session_id, implementation_session_id, termination_reason, created_at
      ) VALUES (?, ?, ?, 'full', ?, ?, ?, ?, ?, ?)
    `);
    insertVerification.run("verification-1", taskId, "fail", scores, "soft-block", "eval-1", "impl-1", null, "2026-07-10 01:00:00");
    insertVerification.run("verification-2", taskId, "pass", scores, "auto-resolve", "eval-2", "impl-2", "passed", "2026-07-10 02:00:00");
    insertVerification.run("verification-3", taskId, "fail", scores, "hard-block", "eval-3", "impl-3", "hard_blocked", "2026-07-10 03:00:00");

    const insertJudgement = db.prepare(`
      INSERT INTO verification_dimension_judgements (verification_id, dimension, verdict, evidence)
      VALUES (?, ?, 'pass', ?)
    `);
    for (const verificationId of ["verification-1", "verification-2", "verification-3"]) {
      for (const dimension of ["functionality", "dataFlow", "designAlignment", "craft", "edgeCases"]) {
        insertJudgement.run(verificationId, dimension, `${verificationId}-${dimension}`);
      }
    }

    const insertIssue = db.prepare(`
      INSERT INTO verification_issues (
        id, verification_id, dimension, severity, evidence, repro_command,
        expected_result, actual_result, fix_instruction, assignee_id
      ) VALUES (?, ?, 'functionality', ?, 'same failure', 'npm test -- same',
                'pass', 'fail', 'fix it', 'agent-coder')
    `);
    insertIssue.run("issue-first", "verification-1", "warning");
    insertIssue.run("issue-regression", "verification-3", "info");
    db.prepare(`
      INSERT INTO verification_issue_tasks (issue_id, task_id, relation)
      VALUES ('issue-first', ?, 'fix')
    `).run(fixTaskId);
    db.prepare(`
      INSERT INTO verification_fix_rounds (
        task_id, source_verification_id, round_number, assignee_id,
        runtime_session_id, status, result_verification_id
      ) VALUES (?, 'verification-1', 1, 'agent-coder', 'fix-runtime-1', 'completed', 'verification-2')
    `).run(taskId);

    const api = await startGoalApi(db);
    try {
      const timeline = await readVerificationTimeline(api.baseUrl, goalId);
      expect(timeline).toMatchObject({
        goal_id: goalId,
        status: "stopped",
        reason: "hard_blocked",
      });
      expect(timeline.rounds).toHaveLength(3);
      expect(timeline.rounds[0]).toMatchObject({
        round: 1,
        implementation_session_id: "impl-1",
        evaluator_session_id: "eval-1",
        fix_session_ids: ["fix-runtime-1"],
        dimensions: expect.arrayContaining([
          expect.objectContaining({ dimension: "functionality", score: 8, passed: true, rationale: "verification-1-functionality" }),
        ]),
        issues: [expect.objectContaining({
          issue_id: "issue-first",
          status: "resolved",
          severity: "medium",
          fix_task_id: fixTaskId,
        })],
      });
      expect(timeline.rounds[2].issues).toEqual([
        expect.objectContaining({ issue_id: "issue-regression", status: "regression", severity: "low", fix_task_id: null }),
      ]);
    } finally {
      await api.close();
    }
  });

  it("verification timeline API는 다른 task의 PASS로 미해결 실패를 resolved/passed로 오판하지 않는다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-verification-timeline-multitask";
    const failedTaskId = "task-timeline-multitask-failed";
    const passedTaskId = "task-timeline-multitask-passed";

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Multitask timeline', 'Independent tasks must not cross-resolve', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Failing fixture', 'Has an unresolved failure.', 'agent-coder', 'in_review', 'code')
    `).run(failedTaskId, goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Passing fixture', 'Independent passing task.', 'agent-coder', 'done', 'code')
    `).run(passedTaskId, goalId, projectId);

    const scores = JSON.stringify(Object.fromEntries([
      "functionality", "dataFlow", "designAlignment", "craft", "edgeCases",
    ].map((dimension) => [dimension, { value: 8, notes: `${dimension} notes` }])));
    const insertVerification = db.prepare(`
      INSERT INTO verifications (
        id, task_id, verdict, scope, dimensions, severity,
        evaluator_session_id, implementation_session_id, termination_reason, created_at
      ) VALUES (?, ?, ?, 'full', ?, ?, ?, ?, ?, ?)
    `);
    // task A는 실패(미해결 이슈), task B는 그 뒤에 PASS를 저장한다.
    insertVerification.run("verification-mt-fail", failedTaskId, "fail", scores, "hard-block", "eval-a", "impl-a", null, "2026-07-10 01:00:00");
    insertVerification.run("verification-mt-pass", passedTaskId, "pass", scores, "auto-resolve", "eval-b", "impl-b", "passed", "2026-07-10 02:00:00");

    db.prepare(`
      INSERT INTO verification_issues (
        id, verification_id, dimension, severity, evidence, repro_command,
        expected_result, actual_result, fix_instruction, assignee_id
      ) VALUES ('issue-mt-open', 'verification-mt-fail', 'functionality', 'high', 'still failing',
                'npm test -- mt', 'pass', 'fail', 'fix it', 'agent-coder')
    `).run();

    const api = await startGoalApi(db);
    try {
      const timeline = await readVerificationTimeline(api.baseUrl, goalId);
      // 다른 task의 PASS가 goal 전체를 passed로 만들면 안 된다 — task A는 여전히 실패.
      expect(timeline.status).toBe("stopped");
      expect(timeline.reason).toBe("verification_failed");
      expect(timeline.rounds).toHaveLength(2);
      const failRound = timeline.rounds.find((round: any) => round.task_id === failedTaskId);
      // task A의 이슈는 task B의 뒤 라운드로 resolved 처리되면 안 된다 — open 유지.
      expect(failRound.issues).toEqual([
        expect.objectContaining({ issue_id: "issue-mt-open", status: "open" }),
      ]);
    } finally {
      await api.close();
    }
  });

  it("verification timeline API는 검증 안 된 형제 task가 남아 있으면 먼저 통과한 task로 goal을 passed 표시하지 않는다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-verification-timeline-unverified-sibling";
    const passedTaskId = "task-timeline-sibling-passed";
    const pendingTaskId = "task-timeline-sibling-pending";

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Unverified sibling timeline', 'A passes while B is still unverified', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    // task A는 통과·완료, task B는 아직 실행 전(검증 기록 없음).
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Passing fixture', 'Passes first.', 'agent-coder', 'done', 'code')
    `).run(passedTaskId, goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Pending fixture', 'Not verified yet.', 'agent-coder', 'todo', 'code')
    `).run(pendingTaskId, goalId, projectId);

    const scores = JSON.stringify(Object.fromEntries([
      "functionality", "dataFlow", "designAlignment", "craft", "edgeCases",
    ].map((dimension) => [dimension, { value: 8, notes: `${dimension} notes` }])));
    db.prepare(`
      INSERT INTO verifications (
        id, task_id, verdict, scope, dimensions, severity,
        evaluator_session_id, implementation_session_id, termination_reason, created_at
      ) VALUES ('verification-sibling-pass', ?, 'pass', 'full', ?, 'auto-resolve', 'eval-a', 'impl-a', 'passed', '2026-07-10 01:00:00')
    `).run(passedTaskId, scores);

    const api = await startGoalApi(db);
    try {
      const timeline = await readVerificationTimeline(api.baseUrl, goalId);
      // task A만 통과했다고 goal 전체가 passed가 되면 안 된다 — task B는 아직 미검증.
      expect(timeline.status).toBe("stopped");
      expect(timeline.reason).toBe("verification_incomplete");
      expect(timeline.rounds).toHaveLength(1);
    } finally {
      await api.close();
    }
  });

  it("verification timeline API는 fix 라운드 이후 처음 나타난 새 이슈도 regression으로 판정한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-verification-timeline-new-regression";
    const taskId = "task-verification-timeline-new-regression";

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'New regression timeline', 'Expose new-issue regression', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Timeline fixture', 'Expose rounds.', 'agent-coder', 'in_review', 'code')
    `).run(taskId, goalId, projectId);

    const scores = JSON.stringify(Object.fromEntries([
      "functionality", "dataFlow", "designAlignment", "craft", "edgeCases",
    ].map((dimension) => [dimension, { value: 8, notes: `${dimension} notes` }])));
    const insertVerification = db.prepare(`
      INSERT INTO verifications (
        id, task_id, verdict, scope, dimensions, severity,
        evaluator_session_id, implementation_session_id, termination_reason, created_at
      ) VALUES (?, ?, ?, 'full', ?, ?, ?, ?, ?, ?)
    `);
    insertVerification.run("verification-nr-1", taskId, "fail", scores, "soft-block", "eval-1", "impl-1", null, "2026-07-10 01:00:00");
    insertVerification.run("verification-nr-2", taskId, "fail", scores, "soft-block", "eval-2", "impl-2", null, "2026-07-10 02:00:00");

    const insertJudgement = db.prepare(`
      INSERT INTO verification_dimension_judgements (verification_id, dimension, verdict, evidence)
      VALUES (?, ?, 'pass', ?)
    `);
    for (const verificationId of ["verification-nr-1", "verification-nr-2"]) {
      for (const dimension of ["functionality", "dataFlow", "designAlignment", "craft", "edgeCases"]) {
        insertJudgement.run(verificationId, dimension, `${verificationId}-${dimension}`);
      }
    }

    // round 0의 이슈는 fix로 해결되고, round 1(fix 이후)에 이전에 없던 새 이슈가 등장한다.
    db.prepare(`
      INSERT INTO verification_issues (
        id, verification_id, dimension, severity, evidence, repro_command,
        expected_result, actual_result, fix_instruction, assignee_id
      ) VALUES ('issue-nr-original', 'verification-nr-1', 'functionality', 'high', 'original failure',
                'npm test -- original', 'pass', 'fail', 'fix it', 'agent-coder')
    `).run();
    db.prepare(`
      INSERT INTO verification_issues (
        id, verification_id, dimension, severity, evidence, repro_command,
        expected_result, actual_result, fix_instruction, assignee_id
      ) VALUES ('issue-nr-new', 'verification-nr-2', 'craft', 'high', 'brand new failure introduced by the fix',
                'npm test -- new', 'pass', 'fail', 'fix it', 'agent-coder')
    `).run();

    const api = await startGoalApi(db);
    try {
      const timeline = await readVerificationTimeline(api.baseUrl, goalId);
      expect(timeline.rounds).toHaveLength(2);
      expect(timeline.rounds[1].issues).toEqual([
        expect.objectContaining({ issue_id: "issue-nr-new", status: "regression" }),
      ]);
    } finally {
      await api.close();
    }
  });

  it("verification timeline API는 같은 라운드에서 resolved와 regression을 동시에 판정한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-verification-timeline-simultaneous";
    const taskId = "task-verification-timeline-simultaneous";

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Simultaneous resolved+regression', 'One round both resolves an issue and regresses another', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Timeline fixture', 'Expose rounds.', 'agent-coder', 'in_review', 'code')
    `).run(taskId, goalId, projectId);

    const scores = JSON.stringify(Object.fromEntries([
      "functionality", "dataFlow", "designAlignment", "craft", "edgeCases",
    ].map((dimension) => [dimension, { value: 8, notes: `${dimension} notes` }])));
    const insertVerification = db.prepare(`
      INSERT INTO verifications (
        id, task_id, verdict, scope, dimensions, severity,
        evaluator_session_id, implementation_session_id, termination_reason, created_at
      ) VALUES (?, ?, ?, 'full', ?, ?, ?, ?, ?, ?)
    `);
    // round 0: issue-sim-c1만 발견. round 1: c1은 그대로 남아 있다가 round 2에서 사라지므로
    // (이 라운드 기준으로) resolved, 동시에 이전에 없던 c2가 새로 등장해 regression — 한 라운드의
    // issues 배열 안에 두 상태가 공존해야 한다. round 2: fix 완료로 이슈 없음(pass).
    insertVerification.run("verification-sim-1", taskId, "fail", scores, "soft-block", "eval-sim-1", "impl-sim-1", null, "2026-07-10 01:00:00");
    insertVerification.run("verification-sim-2", taskId, "fail", scores, "soft-block", "eval-sim-2", "impl-sim-2", null, "2026-07-10 02:00:00");
    insertVerification.run("verification-sim-3", taskId, "pass", scores, "auto-resolve", "eval-sim-3", "impl-sim-3", "passed", "2026-07-10 03:00:00");

    const insertIssue = db.prepare(`
      INSERT INTO verification_issues (
        id, verification_id, dimension, severity, evidence, repro_command,
        expected_result, actual_result, fix_instruction, assignee_id
      ) VALUES (?, ?, ?, 'high', ?, ?, 'pass', 'fail', 'fix it', 'agent-coder')
    `);
    insertIssue.run("issue-sim-c1", "verification-sim-1", "functionality", "continuing failure", "npm test -- c1");
    insertIssue.run("issue-sim-c1-round2", "verification-sim-2", "functionality", "continuing failure", "npm test -- c1");
    insertIssue.run("issue-sim-c2", "verification-sim-2", "craft", "brand new failure introduced by the fix", "npm test -- c2");

    const api = await startGoalApi(db);
    try {
      const timeline = await readVerificationTimeline(api.baseUrl, goalId);
      expect(timeline.rounds).toHaveLength(3);
      // round 1: c1은 다음 라운드에도 그대로 등장하므로 아직 open.
      expect(timeline.rounds[0].issues).toEqual([
        expect.objectContaining({ issue_id: "issue-sim-c1", status: "open" }),
      ]);
      // round 2: 같은 이슈(issue-sim-c1-round2)는 round 3에서 사라지므로 resolved,
      // 새로 나타난 issue-sim-c2는 regression — 한 라운드 안에서 두 상태가 동시에 나온다.
      expect(timeline.rounds[1].issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ issue_id: "issue-sim-c1-round2", status: "resolved" }),
          expect.objectContaining({ issue_id: "issue-sim-c2", status: "regression" }),
        ]),
      );
      expect(timeline.rounds[1].issues).toHaveLength(2);
    } finally {
      await api.close();
    }
  });

  it("verification timeline API가 검증 기록이 없는 goal에도 계약 enum 안의 status를 반환한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-verification-timeline-empty";

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Empty timeline fixture', 'No verifications yet', 'high', 'goal_as_unit')
    `).run(goalId, projectId);

    const api = await startGoalApi(db);
    try {
      const timeline = await readVerificationTimeline(api.baseUrl, goalId);
      expect(["passed", "fixing", "stopped", "manual_approval"]).toContain(timeline.status);
      expect(timeline.rounds).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it("verification timeline API가 conditional 판정을 계약 enum(manual_approval)으로 매핑한다", async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-verification-timeline-conditional";
    const taskId = "task-verification-timeline-conditional";

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Conditional timeline fixture', 'Expose conditional round', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Conditional fixture', 'Expose conditional round.', 'agent-coder', 'in_review', 'code')
    `).run(taskId, goalId, projectId);
    db.prepare(`
      INSERT INTO verifications (id, task_id, verdict, scope, termination_reason)
      VALUES ('verification-conditional', ?, 'conditional', 'standard', 'conditional')
    `).run(taskId);

    const api = await startGoalApi(db);
    try {
      const timeline = await readVerificationTimeline(api.baseUrl, goalId);
      expect(timeline.rounds).toHaveLength(1);
      expect(["pass", "fail", "stopped", "manual_approval"]).toContain(timeline.rounds[0].verdict);
      expect(timeline.rounds[0].verdict).toBe("manual_approval");
      expect(timeline.status).toBe("manual_approval");
    } finally {
      await api.close();
    }
  });

  it("evaluator가 과거 fix session의 runtime 세션을 재사용하면 판정을 저장하지 않고 분리 실패한다", { timeout: 20_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-fix-session-separation";
    const taskId = "task-fix-session-separation";
    // sessions row id(세션 DB row)와 CLI runtime session id는 별개다. evaluator는
    // 항상 새 row로 spawn되므로 row id는 절대 충돌하지 않고, 실제 맥락 누수는 runtime
    // 대화를 이어받을 때(runtime id 일치) 발생한다 → 이 조건이 프로덕션에서 가능한 조건.
    const fixSessionRowId = "fix-session-row";
    const fixRuntimeSessionId = "runtime-fix-round-1";
    const sourceVerificationId = "source-verification";

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Fix session separation', 'Reject previous fix session', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Fix session fixture', 'Reject reused fix session.', 'agent-coder', 'in_review', 'code')
    `).run(taskId, goalId, projectId);
    db.prepare("INSERT INTO sessions (id, agent_id, status) VALUES (?, 'agent-coder', 'completed')")
      .run(fixSessionRowId);
    db.prepare(`
      INSERT INTO verifications (id, task_id, verdict, scope, evaluator_session_id)
      VALUES (?, ?, 'fail', 'full', 'old-evaluator')
    `).run(sourceVerificationId, taskId);
    db.prepare(`
      INSERT INTO verification_fix_rounds (
        task_id, source_verification_id, round_number, assignee_id,
        session_id, runtime_session_id, status
      ) VALUES (?, ?, 1, 'agent-coder', ?, ?, 'completed')
    `).run(taskId, sourceVerificationId, fixSessionRowId, fixRuntimeSessionId);

    const sessions = new FakeSessionManager({ reuseEvaluatorRuntimeSessionId: fixRuntimeSessionId });
    const result = await createQualityGate(db, sessions, () => {}).verify(taskId, {
      scope: "full",
      workdir: repo,
    });

    expect(result.verdict).toBe("fail");
    expect(result.evaluatorSessionId).toBe(fixRuntimeSessionId);
    expect(result.issues[0]?.id).toBe("issue-evaluator-session-reused");
    expect(result.issues[0]?.message).toContain("과거 수정 세션");

    // 판정이 실제로 저장됐는지 + 재사용 activity가 fix source로 남는지 확인
    const activity = db.prepare(`
      SELECT metadata FROM activities
      WHERE project_id = ? AND type = 'verification_fail'
      ORDER BY id DESC LIMIT 1
    `).get(projectId) as { metadata: string } | undefined;
    expect(JSON.parse(activity?.metadata ?? "{}")).toMatchObject({
      taskId,
      reason: "evaluator_session_reused",
      reusedSessionSource: "fix",
      reusedSessionId: fixRuntimeSessionId,
    });
  });

  it("auto-fix 루프는 maxFixRetries 라운드만 소진하고 goal-as-unit 태스크를 pending_approval로 넘긴다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-fix-round-limit";
    const taskId = "task-fix-round-limit";
    const sessions = new FakeSessionManager({ verificationResponse: failVerification() });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Fix round limit fixture', 'Always-fail verification', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'todo', 'code')
    `).run(taskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, () => {});
    const result = await engine.executeTask(taskId, { autoFix: true, maxFixRetries: 1 });

    expect(result).toEqual({ success: false, verdict: "conditional" });

    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(task.status).toBe("pending_approval");

    const fixRounds = db.prepare(
      "SELECT COUNT(*) AS count FROM verification_fix_rounds WHERE task_id = ?",
    ).get(taskId) as { count: number };
    expect(fixRounds.count).toBe(1);

    const latestVerification = db.prepare(
      "SELECT termination_reason FROM verifications WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(taskId) as { termination_reason: string | null };
    expect(latestVerification.termination_reason).toBe("fix_round_limit");

    const activity = db.prepare(`
      SELECT message, metadata FROM activities
      WHERE project_id = ? AND type = 'verification_manual_approval'
      ORDER BY id DESC LIMIT 1
    `).get(projectId) as { message: string; metadata: string } | undefined;
    expect(activity?.message).toContain("Fix round limit reached");
    expect(JSON.parse(activity?.metadata ?? "{}")).toMatchObject({
      taskId,
      status: "manual_approval",
      reason: "fix_round_limit",
    });

    const fixingActivity = db.prepare(`
      SELECT metadata FROM activities
      WHERE project_id = ? AND type = 'verification_fixing'
      ORDER BY id DESC LIMIT 1
    `).get(projectId) as { metadata: string } | undefined;
    expect(JSON.parse(fixingActivity?.metadata ?? "{}")).toMatchObject({
      taskId,
      status: "fixing",
      reason: "auto_fix_in_progress",
      round: 1,
      maxRounds: 1,
    });
  });

  it("fail → fix → conditional 재검증은 done/squash로 자동완료하지 않고 pending_approval로 넘긴다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-reverify-conditional";
    const taskId = "task-reverify-conditional";
    const sessions = new FakeSessionManager({
      verificationResponses: [failVerification(), conditionalVerification()],
    });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Reverify conditional fixture', 'Fail then conditional on reverify', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'todo', 'code')
    `).run(taskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, () => {});
    const result = await engine.executeTask(taskId, { autoFix: true, maxFixRetries: 2 });

    expect(result).toEqual({ success: false, verdict: "conditional" });

    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(task.status).toBe("pending_approval");

    const latestVerification = db.prepare(
      "SELECT termination_reason FROM verifications WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(taskId) as { termination_reason: string | null };
    expect(latestVerification.termination_reason).toBe("conditional");

    const activity = db.prepare(`
      SELECT message, metadata FROM activities
      WHERE project_id = ? AND type = 'verification_manual_approval'
      ORDER BY id DESC LIMIT 1
    `).get(projectId) as { message: string; metadata: string } | undefined;
    expect(activity?.message).toContain("conditional");
    expect(JSON.parse(activity?.metadata ?? "{}")).toMatchObject({
      taskId,
      status: "manual_approval",
      reason: "conditional",
    });
  });

  it("evaluator_error 판정은 fix 루프에 진입하지 않고 fix session을 스폰하지 않는다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-evaluator-error-skip";
    const taskId = "task-evaluator-error-skip";
    // dimensionJudgements가 없는 구조화 계약 위반 응답 — parseVerificationResult가
    // 매번 evaluator_error로 거부한다(1회 내부 재시도까지 포함).
    const brokenEvaluation = "```json\n{\"verdict\":\"fail\",\"severity\":\"hard-block\",\"issues\":[]}\n```";
    const sessions = new FakeSessionManager({ verificationResponse: brokenEvaluation });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Evaluator error fixture', 'Always-broken verification output', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'todo', 'code')
    `).run(taskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, () => {});
    const result = await engine.executeTask(taskId, { autoFix: true, maxFixRetries: 2 });

    expect(result).toEqual({ success: false, verdict: "fail" });

    // fix 루프에 들어가지 않았어야 한다 — fix round record가 전혀 생기지 않는다.
    const fixRounds = db.prepare(
      "SELECT COUNT(*) AS count FROM verification_fix_rounds WHERE task_id = ?",
    ).get(taskId) as { count: number };
    expect(fixRounds.count).toBe(0);

    const latestVerification = db.prepare(
      "SELECT termination_reason FROM verifications WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(taskId) as { termination_reason: string | null };
    expect(latestVerification.termination_reason).toBe("evaluator_error");

    const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(task.status).toBe("blocked");

    const stoppedActivity = db.prepare(`
      SELECT metadata FROM activities
      WHERE project_id = ? AND type = 'verification_stopped'
      ORDER BY id DESC LIMIT 1
    `).get(projectId) as { metadata: string } | undefined;
    expect(JSON.parse(stoppedActivity?.metadata ?? "{}")).toMatchObject({
      taskId,
      status: "stopped",
      reason: "evaluator_error",
    });

    const qaRegressionTasks = db.prepare(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE goal_id = ? AND title LIKE '[실전 QA 회귀]%'
    `).get(goalId) as { count: number };
    expect(qaRegressionTasks.count).toBe(0);
  });

  it("변경 파일이 없어도 evaluator_error를 pass로 덮어쓰지 않고 stopped로 종료한다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-no-change-evaluator-error";
    const taskId = "task-no-change-evaluator-error";
    const brokenEvaluation = "```json\n{\"verdict\":\"fail\",\"severity\":\"hard-block\",\"issues\":[]}\n```";
    const sessions = new FakeSessionManager({ verificationResponse: brokenEvaluation });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'No-change evaluator error', 'Evaluator contract failure without a diff', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'No-op implementation', 'Produce no file changes.', 'agent-coder', 'todo', 'code')
    `).run(taskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, () => {});
    const result = await engine.executeTask(taskId, { autoFix: true, maxFixRetries: 2 });

    expect(result).toEqual({ success: false, verdict: "fail" });
    expect(db.prepare(
      "SELECT status FROM tasks WHERE id = ?",
    ).get(taskId)).toEqual({ status: "blocked" });
    expect(db.prepare(
      "SELECT verdict, termination_reason FROM verifications WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(taskId)).toEqual({ verdict: "fail", termination_reason: "evaluator_error" });
  });

  it("수정 후 재검증의 evaluator_error도 fix_round_limit으로 덮지 않고 stopped로 종료한다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-reverify-evaluator-error";
    const taskId = "task-reverify-evaluator-error";
    const brokenEvaluation = "```json\n{\"verdict\":\"fail\",\"severity\":\"hard-block\",\"issues\":[]}\n```";
    const sessions = new FakeSessionManager({
      verificationResponses: [failVerification(), brokenEvaluation],
    });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Reverify evaluator error', 'Stop after broken re-verification', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'todo', 'code')
    `).run(taskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, () => {});
    const result = await engine.executeTask(taskId, { autoFix: true, maxFixRetries: 2 });

    expect(result).toEqual({ success: false, verdict: "fail" });
    expect(db.prepare(
      "SELECT status FROM tasks WHERE id = ?",
    ).get(taskId)).toEqual({ status: "blocked" });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM verification_fix_rounds WHERE task_id = ?",
    ).get(taskId)).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT termination_reason FROM verifications WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(taskId)).toEqual({ termination_reason: "evaluator_error" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM activities
      WHERE project_id = ? AND type = 'verification_manual_approval'
    `).get(projectId)).toEqual({ count: 0 });

    const stoppedActivity = db.prepare(`
      SELECT metadata FROM activities
      WHERE project_id = ? AND type = 'verification_stopped'
      ORDER BY id DESC LIMIT 1
    `).get(projectId) as { metadata: string } | undefined;
    expect(JSON.parse(stoppedActivity?.metadata ?? "{}")).toMatchObject({
      taskId,
      status: "stopped",
      reason: "evaluator_error",
    });
  });

  it("non-zero fix 종료는 재검증을 spawn하지 않고 fix 재개 지점을 유지한다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-nonzero-fix";
    const taskId = "task-nonzero-fix";
    const sessions = new FakeSessionManager({
      verificationResponse: failVerification(),
      fixExitCode: 1,
      abnormalRecoveryDecision: "resume",
    });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Non-zero fix fixture', 'Stop before re-verification', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'todo', 'code')
    `).run(taskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, () => {});
    await expect(engine.executeTask(taskId, { autoFix: true, maxFixRetries: 2 })).rejects.toThrow();

    expect(sessions.spawns.filter((spawn) => spawn.sessionKey?.startsWith("evaluator-"))).toHaveLength(1);
    expect(sessions.recoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "fix", mode: "reconcile" }),
    ]));
    expect(db.prepare(`
      SELECT recovery_resume_phase FROM tasks WHERE id = ?
    `).get(taskId)).toEqual({ recovery_resume_phase: "fix" });
    expect(db.prepare(`
      SELECT status FROM verification_fix_rounds WHERE task_id = ?
    `).get(taskId)).toEqual({ status: "failed" });
  });

  it("성공한 fix를 commit해 재검증 중단 후에도 verification만 재개한다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-fix-reverify-recovery";
    const taskId = "task-fix-reverify-recovery";
    const brokenEvaluation = "```json\n{\"verdict\":\"fail\",\"severity\":\"hard-block\",\"issues\":[]}\n```";
    const sessions = new FakeSessionManager({
      verificationResponses: [failVerification(), brokenEvaluation],
      fixWritesChange: true,
    });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Fix reverify recovery', 'Preserve successful fix output', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'todo', 'code')
    `).run(taskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, () => {});
    await engine.executeTask(taskId, { autoFix: true, maxFixRetries: 2 });

    const task = db.prepare(`
      SELECT worktree_path, recovery_checkpoint_head_sha, recovery_commit_sha, recovery_resume_phase
      FROM tasks JOIN goals ON goals.id = tasks.goal_id WHERE tasks.id = ?
    `).get(taskId) as {
      worktree_path: string;
      recovery_checkpoint_head_sha: string;
      recovery_commit_sha: string;
      recovery_resume_phase: string;
    };
    expect(git(task.worktree_path, "status", "--porcelain")).toBe("");
    expect(task.recovery_resume_phase).toBe("verification");
    expect(git(task.worktree_path, "rev-parse", "HEAD")).toBe(task.recovery_commit_sha);
    expect(git(task.worktree_path, "rev-list", "--count", `${task.recovery_checkpoint_head_sha}..HEAD`)).toBe("1");

    db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = ?").run(taskId);
    recoverOnStartup(db);
    expect(db.prepare(`
      SELECT status, recovery_resume_phase, recovery_manual_action_required FROM tasks WHERE id = ?
    `).get(taskId)).toEqual({
      status: "todo",
      recovery_resume_phase: "verification",
      recovery_manual_action_required: 0,
    });
  });

  it("auto-fix 세션을 실행 task에 귀속시킨다", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedFullAutoProject(db, repo);
    const goalId = "goal-auto-fix-session-owner";
    const taskId = "task-auto-fix-session-owner";
    const sessions = new FakeSessionManager({ failVerificationOnce: true });

    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority, goal_model)
      VALUES (?, ?, 'Auto-fix ownership fixture', 'Verify task_id on fix sessions', 'high', 'goal_as_unit')
    `).run(goalId, projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
      VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'todo', 'code')
    `).run(taskId, goalId, projectId);

    const engine = createOrchestrationEngine(db, sessions, () => {});
    await engine.executeTask(taskId);

    const generatorSpawns = sessions.spawns.filter((spawn) => spawn.agentId === "agent-coder");
    expect(generatorSpawns).toHaveLength(2);
    expect(generatorSpawns.every((spawn) => spawn.taskId === taskId)).toBe(true);
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

  it("검증 후 task commit이 실패하면 task를 차단하고 squash 승인을 열지 않는다", { timeout: 30_000 }, async () => {
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
    await expect(engine.executeTask(implTaskId, { autoFix: false }))
      .rejects.toThrow("wip commit rejected");

    const goal = db.prepare(
      "SELECT squash_status, squash_commit_sha FROM goals WHERE id = ?",
    ).get(goalId) as { squash_status: string; squash_commit_sha: string | null } | undefined;
    expect(goal?.squash_status).toBe("none");
    expect(goal?.squash_commit_sha).toBeNull();
    expect(events.some((e) => e.event === "goal:squash_ready")).toBe(false);
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(implTaskId))
      .toMatchObject({ status: "blocked" });
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
      .toMatchObject({ status: "blocked" });
    expect(broadcasts).toContainEqual(expect.objectContaining({
      event: "goal:squash_ready",
      data: expect.objectContaining({ goalId: pendingGoalId }),
    }));

    const api = await startGoalApi(db);
    try {
      const runningStatus = await readGoalStatus(api.baseUrl, runningGoalId);
      expect(runningStatus).toMatchObject({
        goal_id: runningGoalId,
        status: "failed",
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
    scheduler.setSpecGenerator(async (goalId) => {
      saveSpecDraft(db, goalId, {
        scope: "fixture scope",
        out_of_scope: "none",
        acceptance_criteria: ["fixture files are implemented"],
        expected_tasks: ["implement fixture files"],
        verification_methods: ["run fixture verification"],
      });
      db.prepare("UPDATE goal_specs SET prd_summary = ? WHERE goal_id = ?")
        .run(JSON.stringify({ scope: "fixture scope" }), goalId);
    });
    const api = await startGoalApi(db);
    missionGenerationCount = 0;

    try {
      const initialMainCount = Number(git(repo, "rev-list", "--count", "main"));

      scheduler.startQueue(projectId);

      const generatedGoal = await waitFor(() => {
        const row = db.prepare(`
          SELECT g.id, version.id AS version_id
          FROM goals g
          JOIN goal_spec_versions version ON version.goal_id = g.id
          WHERE g.project_id = ? AND version.status = 'draft'
          ORDER BY g.created_at ASC, version.version DESC
          LIMIT 1
        `).get(projectId) as { id: string; version_id: string } | undefined;
        return row ?? null;
      }, "Full Auto goal spec draft");
      approveSpecVersion(db, generatedGoal.id, generatedGoal.version_id);
      scheduler.notifyGoalReady(projectId);

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
      expect(Number(git(repo, "rev-list", "--count", readyGoal.worktree_branch!))).toBe(initialMainCount + 2);
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
      // squash 커밋 제목 = conventional prefix(work-report commitType) + goal 제목.
      expect(mainSubjects.split("\n")[0]).toMatch(/^(feat|fix|update|docs|refactor|chore|test): Fixture goal$/);
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
