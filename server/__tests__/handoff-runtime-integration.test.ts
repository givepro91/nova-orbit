import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider, AgentSession } from "../core/agent/adapters/backend.js";
import type { RunResult } from "../core/agent/adapters/claude-code.js";
import { createAgentHandoff } from "../core/agent/handoff.js";
import { saveAgentHandoff } from "../core/agent/handoff-store.js";
import type {
  ExecutionSessionContext,
  SessionManager,
  SessionPromptOptions,
  SessionRecord,
} from "../core/agent/session.js";
import { createDatabase, migrate } from "../db/schema.js";

const backendRuntime = vi.hoisted(() => ({
  send: vi.fn(),
  spawns: [] as Array<{ provider: AgentProvider; config: Record<string, unknown> }>,
}));

vi.mock("../core/agent/adapters/backend.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { EventEmitter: MockEventEmitter } = await import("node:events");
  return {
    ...actual,
    getBackend: (provider: AgentProvider) => ({
      provider,
      isAvailable: async () => true,
      spawn: (config: Record<string, unknown>) => {
        backendRuntime.spawns.push({ provider, config });
        return Object.assign(new MockEventEmitter(), {
          id: `backend-${provider}-${backendRuntime.spawns.length}`,
          status: "idle",
          process: null,
          lastSessionId: null,
          send: (prompt: string) => backendRuntime.send(provider, prompt),
          kill: vi.fn(),
          cleanup: vi.fn(),
        });
      },
    }),
  };
});

import { createSessionManager } from "../core/agent/session.js";
import { createQualityGate } from "../core/quality-gate/evaluator.js";
import { createOrchestrationEngine } from "../core/orchestration/engine.js";
import { approveSpecVersion, saveSpecDraft } from "../core/goal-spec/spec-approval.js";

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewdeck-handoff-runtime-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@crewdeck.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Crewdeck Test"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir });
  return dir;
}

function streamResult(provider: AgentProvider, text: string, sessionId: string): RunResult {
  const stdout = provider === "claude"
    ? [
        JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text }] } }),
        JSON.stringify({ type: "result", session_id: sessionId, result: text }),
      ].join("\n")
    : [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join("\n");
  return { stdout, stderr: "", exitCode: 0, sessionId, provider };
}

function verificationResponse(
  verdict: "pass" | "fail",
  handoffDecision: string,
): string {
  return JSON.stringify({
    verdict,
    severity: verdict === "pass" ? "auto-resolve" : "hard-block",
    dimensionJudgements: [
      { dimension: "functionality", verdict, evidence: "fixture evidence" },
      { dimension: "dataFlow", verdict: "pass", evidence: "fixture evidence" },
      { dimension: "designAlignment", verdict: "pass", evidence: "fixture evidence" },
      { dimension: "craft", verdict, evidence: "fixture evidence" },
      { dimension: "edgeCases", verdict, evidence: "fixture evidence" },
    ],
    dimensions: {
      functionality: { value: verdict === "pass" ? 8 : 2, notes: "fixture" },
      dataFlow: { value: 8, notes: "fixture" },
      designAlignment: { value: 8, notes: "fixture" },
      craft: { value: verdict === "pass" ? 8 : 2, notes: "fixture" },
      edgeCases: { value: verdict === "pass" ? 8 : 2, notes: "fixture" },
    },
    issues: verdict === "pass" ? [] : [{
      dimension: "functionality",
      severity: "critical",
      file: "feature.txt",
      line: 1,
      message: "fixture regression",
      reproCommand: "npm test -- fixture-regression",
      expectedResult: "pass",
      actualResult: "fail",
      fixInstruction: "fix the fixture",
    }],
    knownGaps: [],
    handoff: createAgentHandoff({
      stage: "verification",
      decisions: [handoffDecision],
      unresolved_risks: verdict === "pass" ? [] : ["VERIFICATION_RISK"],
      reproduction_commands: ["npm test -- fixture-regression"],
    }),
  });
}

class PipelineSession extends EventEmitter implements AgentSession {
  process = null;
  status: AgentSession["status"] = "idle";
  lastSessionId: string | null = null;

  constructor(
    readonly id: string,
    private readonly respond: (prompt: string, runtimeId: string) => RunResult,
  ) {
    super();
  }

  async send(prompt: string): Promise<RunResult> {
    const result = this.respond(prompt, `runtime-${this.id}`);
    this.lastSessionId = result.sessionId;
    return result;
  }

  kill(): void {}
  cleanup(): void {}
}

class PipelineSessionManager implements SessionManager {
  private sequence = 0;
  private verificationCount = 0;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly records = new Map<string, SessionRecord>();
  readonly prompts: Array<{ key: string; prompt: string; options?: SessionPromptOptions }> = [];

  constructor(private readonly db: Database.Database) {}

  spawnAgent(
    agentId: string,
    projectWorkdir: string,
    sessionKey?: string,
    taskId?: string | null,
    _executionContext?: ExecutionSessionContext,
    options?: SessionPromptOptions,
  ): AgentSession {
    const key = sessionKey ?? agentId;
    const rowId = `pipeline-session-${++this.sequence}`;
    const session = new PipelineSession(rowId, (prompt, runtimeId) => {
      this.prompts.push({ key, prompt, options });
      let text: string;
      if (prompt.includes("# Goal Decomposition")) {
        text = JSON.stringify({
          tasks: [{
            title: "Implement fixture",
            description: "Create feature.txt and verify it.",
            role: "coder",
            priority: "high",
            order: 1,
            type: "code",
            target_files: ["feature.txt"],
            stack_hint: "Node fixture",
            depends_on: [],
          }],
          handoff: createAgentHandoff({
            stage: "decompose",
            decisions: ["DECOMPOSE_HANDOFF_ONLY"],
          }),
        });
      } else if (prompt.includes("# Task: Implement fixture")) {
        writeFileSync(join(projectWorkdir, "feature.txt"), "broken\n");
        text = JSON.stringify({
          summary: "implementation complete",
          handoff: createAgentHandoff({
            stage: "implementation",
            changed_files: ["feature.txt"],
            decisions: ["IMPLEMENTATION_HANDOFF_ONLY"],
            reproduction_commands: ["npm test -- implementation"],
          }),
        });
      } else if (prompt.includes("# Fix Required")) {
        writeFileSync(join(projectWorkdir, "feature.txt"), "fixed\n");
        text = JSON.stringify({
          summary: "fix complete",
          handoff: createAgentHandoff({
            stage: "fix",
            changed_files: ["feature.txt"],
            decisions: ["FIX_HANDOFF_ONLY"],
            reproduction_commands: ["npm test -- fixed"],
          }),
        });
      } else if (prompt.includes("Quality Verification")) {
        text = verificationResponse(
          this.verificationCount++ === 0 ? "fail" : "pass",
          this.verificationCount === 1 ? "VERIFICATION_HANDOFF_ONLY" : "REVERIFICATION_HANDOFF_ONLY",
        );
      } else {
        text = JSON.stringify({ handoff: createAgentHandoff({ stage: "implementation" }) });
      }
      this.db.prepare(`
        UPDATE sessions SET status = 'completed', ended_at = datetime('now'),
          last_output = ?, runtime_session_id = ? WHERE id = ?
      `).run(`PRIVATE_DIALOGUE_${rowId}`, runtimeId, rowId);
      return streamResult("claude", text, runtimeId);
    });
    this.db.prepare(`
      INSERT INTO sessions (id, agent_id, task_id, status, provider)
      VALUES (?, ?, ?, 'active', 'claude')
    `).run(rowId, agentId, taskId ?? null);
    this.sessions.set(key, session);
    this.records.set(key, {
      sessionKey: key,
      agentId,
      rowId,
      provider: "claude",
      runtimeSessionId: null,
    });
    return session;
  }

  getSession(key: string): AgentSession | undefined { return this.sessions.get(key); }
  getSessionRecord(key: string): SessionRecord | undefined { return this.records.get(key); }
  killSession(key: string): void { this.sessions.delete(key); }
  killAll(): void { this.sessions.clear(); }
  pauseSession(): void {}
  resumeSession(): void {}
  setProviderOverride(): void {}
  clearProviderOverride(): void {}
}

describe("handoff production runtime integration", () => {
  let db: Database.Database;
  let repo: string;

  beforeEach(() => {
    backendRuntime.send.mockReset();
    backendRuntime.spawns.length = 0;
    repo = makeRepo();
    db = createDatabase(":memory:");
    migrate(db);
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    { from: "claude", to: "codex" },
    { from: "codex", to: "claude" },
  ] as const)(
    "real SessionManager sends the persisted handoff to the $from→$to replacement backend",
    async ({ from, to }) => {
      db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'Project', 'new', ?)")
        .run(repo);
      db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'Goal')").run();
      db.prepare(`
        INSERT INTO agents (id, project_id, name, role, provider)
        VALUES ('worker', 'p1', 'Worker', 'backend', ?),
               ('reviewer', 'p1', 'Reviewer', 'reviewer', NULL)
      `).run(from);
      db.prepare(`
        INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status)
        VALUES ('t1', 'g1', 'p1', 'Task', 'worker', 'in_review')
      `).run();
      db.prepare(`
        INSERT INTO sessions (id, agent_id, task_id, status, provider, last_output)
        VALUES ('implementation-session', 'worker', 't1', 'completed', ?, 'PRIVATE_IMPLEMENTATION_DIALOGUE')
      `).run(from);
      saveAgentHandoff(db, {
        goalId: "g1",
        taskId: "t1",
        sessionId: "implementation-session",
        handoff: createAgentHandoff({
          stage: "implementation",
          changed_files: ["feature.txt"],
          decisions: ["PERSISTED_IMPLEMENTATION_HANDOFF"],
          reproduction_commands: ["npm test -- handoff"],
        }),
      });
      const manager = createSessionManager(db);
      manager.setProviderOverride("evaluator-t1", to);
      backendRuntime.send.mockImplementation(async (provider: AgentProvider, prompt: string) =>
        streamResult(provider, verificationResponse("pass", "VERIFIED"), `runtime-${provider}`));

      await createQualityGate(db, manager).verify("t1", { workdir: repo });

      expect(backendRuntime.spawns).toHaveLength(1);
      expect(backendRuntime.spawns[0]).toMatchObject({
        provider: to,
        config: { provider: to, sessionBehavior: "new", resumeSessionId: null },
      });
      const sentPrompt = backendRuntime.send.mock.calls[0]?.[1] as string;
      expect(sentPrompt).toContain("PERSISTED_IMPLEMENTATION_HANDOFF");
      expect(sentPrompt).toContain('"npm test -- handoff"');
      expect(sentPrompt).not.toContain("PRIVATE_IMPLEMENTATION_DIALOGUE");
      expect(db.prepare(`
        SELECT provider FROM sessions WHERE task_id = 't1' AND agent_id = 'reviewer'
        ORDER BY rowid DESC LIMIT 1
      `).get()).toEqual({ provider: to });
    },
  );

  it("runs decompose→implementation→verification→fix→reverification with only the latest structured handoff", { timeout: 20_000 }, async () => {
    db.prepare(`
      INSERT INTO projects (id, name, source, workdir, autopilot)
      VALUES ('p1', 'Project', 'local_import', ?, 'goal')
    `).run(repo);
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, needs_worktree)
      VALUES ('cto', 'p1', 'CTO', 'cto', 0),
             ('coder', 'p1', 'Coder', 'coder', 0),
             ('reviewer', 'p1', 'Reviewer', 'reviewer', 0)
    `).run();
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description, priority)
      VALUES ('g1', 'p1', 'Handoff pipeline', 'Implement fixture', 'high')
    `).run();
    const draft = saveSpecDraft(db, "g1", {
      scope: "fixture scope",
      out_of_scope: "none",
      acceptance_criteria: ["pipeline passes"],
      expected_tasks: ["implement fixture"],
      verification_methods: ["npm test -- fixture"],
    });
    approveSpecVersion(db, "g1", draft.id);
    const manager = new PipelineSessionManager(db);
    const engine = createOrchestrationEngine(db, manager, () => {});

    expect(await engine.decomposeGoal("g1")).toMatchObject({ taskCount: 1 });
    const task = db.prepare("SELECT id FROM tasks WHERE goal_id = 'g1' LIMIT 1").get() as { id: string };
    const result = await engine.executeTask(task.id, { autoFix: true, maxFixRetries: 1 });

    expect(result).toEqual({ success: true, verdict: "pass" });
    const implementationPrompt = manager.prompts.find(({ prompt }) => prompt.includes("# Task: Implement fixture"))!;
    const verificationPrompts = manager.prompts.filter(({ prompt }) => prompt.includes("Quality Verification"));
    const fixPrompt = manager.prompts.find(({ prompt }) => prompt.includes("# Fix Required"))!;
    expect(implementationPrompt.prompt).toContain("DECOMPOSE_HANDOFF_ONLY");
    expect(verificationPrompts[0]?.prompt).toContain("IMPLEMENTATION_HANDOFF_ONLY");
    expect(fixPrompt.prompt).toContain("VERIFICATION_HANDOFF_ONLY");
    expect(verificationPrompts[1]?.prompt).toContain("FIX_HANDOFF_ONLY");
    expect(verificationPrompts[1]?.prompt).not.toContain("IMPLEMENTATION_HANDOFF_ONLY");
    for (const { prompt } of manager.prompts) {
      expect(prompt).not.toContain("PRIVATE_DIALOGUE_");
    }
    for (const entry of [implementationPrompt, fixPrompt, ...verificationPrompts]) {
      expect(entry.options).toMatchObject({ forceNewSession: true, omitUnstructuredTaskOutput: true });
    }
    expect(db.prepare(`
      SELECT stage FROM agent_handoffs WHERE goal_id = 'g1' ORDER BY id
    `).all()).toEqual([
      { stage: "decompose" },
      { stage: "implementation" },
      { stage: "verification" },
      { stage: "fix" },
      { stage: "verification" },
    ]);
  });
});
