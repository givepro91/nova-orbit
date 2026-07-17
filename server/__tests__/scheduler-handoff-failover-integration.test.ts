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
import { createDatabase, migrate } from "../db/schema.js";
import { approveSpecVersion, saveSpecDraft } from "../core/goal-spec/spec-approval.js";

/**
 * Regression coverage for the gap the previous round left open: the
 * bidirectional failover tests either mocked the whole orchestration engine
 * (scheduler-failure-redispatch-order.test.ts) or drove the quality gate
 * directly without the scheduler (handoff-runtime-integration.test.ts).
 * Neither exercised "scheduler classifies a real failure → redispatches →
 * the real engine/quality-gate path sends the persisted handoff to the
 * alternate backend" end to end. This file wires createScheduler to the
 * REAL (unmocked) orchestration engine and a REAL SessionManager, faking
 * only the backend subprocess boundary.
 */

const backendRuntime = vi.hoisted(() => ({
  sent: [] as Array<{ provider: AgentProvider; prompt: string }>,
  spawns: [] as Array<{ provider: AgentProvider; config: Record<string, unknown> }>,
  handler: null as null | ((provider: AgentProvider, prompt: string, workdir: string) => Promise<RunResult>),
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
        const session = Object.assign(new MockEventEmitter(), {
          id: `backend-${provider}-${backendRuntime.spawns.length}`,
          status: "idle",
          process: null,
          lastSessionId: null,
          kill: vi.fn(),
          cleanup: vi.fn(),
        }) as unknown as AgentSession & EventEmitter;
        session.send = async (prompt: string) => {
          backendRuntime.sent.push({ provider, prompt });
          // Mimic real adapters streaming raw dialogue before a structured
          // result — used to assert the private text never reaches prompts.
          session.emit("output", "PRIVATE_DIALOGUE_MARKER");
          if (!backendRuntime.handler) throw new Error("Test backend handler not configured");
          return backendRuntime.handler(provider, prompt, config.workdir as string);
        };
        return session;
      },
    }),
  };
});

// codexFailover must be deterministic — the real loadProviderConfig() reads
// ~/.crewdeck/config.json, which is environment-dependent.
vi.mock("../core/agent/provider.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadProviderConfig: () => ({
      defaultProvider: "claude",
      codexFailover: true,
      codexModelMap: {},
    }),
  };
});

import { createSessionManager } from "../core/agent/session.js";
import { createOrchestrationEngine } from "../core/orchestration/engine.js";
import { createScheduler } from "../core/orchestration/scheduler.js";

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewdeck-failover-handoff-"));
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

function verificationPassResponse(decision: string): string {
  return JSON.stringify({
    verdict: "pass",
    severity: "auto-resolve",
    dimensionJudgements: [
      { dimension: "functionality", verdict: "pass", evidence: "fixture evidence" },
      { dimension: "dataFlow", verdict: "pass", evidence: "fixture evidence" },
      { dimension: "designAlignment", verdict: "pass", evidence: "fixture evidence" },
      { dimension: "craft", verdict: "pass", evidence: "fixture evidence" },
      { dimension: "edgeCases", verdict: "pass", evidence: "fixture evidence" },
    ],
    dimensions: {
      functionality: { value: 8, notes: "fixture" },
      dataFlow: { value: 8, notes: "fixture" },
      designAlignment: { value: 8, notes: "fixture" },
      craft: { value: 8, notes: "fixture" },
      edgeCases: { value: 8, notes: "fixture" },
    },
    issues: [],
    knownGaps: [],
    handoff: createAgentHandoff({
      stage: "verification",
      decisions: [decision],
      reproduction_commands: ["npm test -- fixture-handoff"],
    }),
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("scheduler failure redispatch reaches the real handoff consumption path", () => {
  let db: Database.Database;
  let repo: string;

  beforeEach(() => {
    backendRuntime.sent = [];
    backendRuntime.spawns = [];
    backendRuntime.handler = null;
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
    "scheduler redispatches $from→$to and the alternate backend receives the persisted handoff",
    async ({ from, to }) => {
      db.prepare(`
        INSERT INTO projects (id, name, source, workdir, autopilot)
        VALUES ('p1', 'Project', 'local_import', ?, 'goal')
      `).run(repo);
      db.prepare(`
        INSERT INTO agents (id, project_id, name, role, needs_worktree, provider)
        VALUES ('cto', 'p1', 'CTO', 'cto', 0, NULL),
               ('coder', 'p1', 'Coder', 'coder', 0, NULL),
               ('reviewer', 'p1', 'Reviewer', 'reviewer', 0, ?)
      `).run(from);
      db.prepare(`
        INSERT INTO goals (id, project_id, title, description, priority)
        VALUES ('g1', 'p1', 'Handoff failover pipeline', 'Implement fixture', 'high')
      `).run();
      const draft = saveSpecDraft(db, "g1", {
        scope: "fixture scope",
        out_of_scope: "none",
        acceptance_criteria: ["pipeline passes"],
        expected_tasks: ["implement fixture"],
        verification_methods: ["npm test -- fixture"],
      });
      approveSpecVersion(db, "g1", draft.id);

      const manager = createSessionManager(db);

      // Step 1: decompose directly (not under test) so a real task exists
      // before the scheduler starts driving implementation/verification.
      const decomposeEngine = createOrchestrationEngine(db, manager, () => {});
      let verificationAttempts = 0;
      backendRuntime.handler = async (provider, prompt, workdir) => {
        if (prompt.includes("# Goal Decomposition")) {
          return streamResult(provider, JSON.stringify({
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
            handoff: createAgentHandoff({ stage: "decompose", decisions: ["DECOMPOSE_OK"] }),
          }), "runtime-decompose");
        }
        if (prompt.includes("# Task: Implement fixture")) {
          writeFileSync(join(workdir, "feature.txt"), "broken\n");
          return streamResult(provider, JSON.stringify({
            summary: "implementation complete",
            handoff: createAgentHandoff({
              stage: "implementation",
              changed_files: ["feature.txt"],
              decisions: [`IMPLEMENTATION_HANDOFF_${from.toUpperCase()}_TO_${to.toUpperCase()}`],
              reproduction_commands: ["npm test -- fixture-handoff"],
            }),
          }), "runtime-impl");
        }
        if (prompt.includes("# Plan Review")) {
          // W1: 신규 decompose 태스크(plan_review_status='pending')는 리뷰어 승인으로만
          // todo가 된다 — startQueue legacy 자동승인(fail-open)은 NULL 전용으로 봉인됨.
          const pending = db.prepare(
            "SELECT id FROM tasks WHERE goal_id = 'g1' AND status = 'pending_approval'",
          ).all() as Array<{ id: string }>;
          return streamResult(
            provider,
            "```json\n" + JSON.stringify({
              reviews: pending.map((t) => ({ taskId: t.id, verdict: "approve", reason: "fixture approve" })),
            }) + "\n```",
            "runtime-plan-review",
          );
        }
        if (prompt.includes("Quality Verification")) {
          verificationAttempts++;
          if (verificationAttempts === 1) {
            const error = new Error("rate limit reached") as Error & { recoveryDecision?: string };
            // Presetting recoveryDecision short-circuits abnormal-exit
            // reconciliation so the classified failure (rate_limit) reaches
            // the scheduler's failover branch, exactly like the existing
            // "clean recovery resume" unit test in
            // scheduler-failure-redispatch-order.test.ts.
            error.recoveryDecision = "resume";
            throw error;
          }
          return streamResult(provider, verificationPassResponse("VERIFIED_AFTER_FAILOVER"), "runtime-verify");
        }
        throw new Error(`Unexpected prompt in test fixture: ${prompt.slice(0, 120)}`);
      };

      expect(await decomposeEngine.decomposeGoal("g1")).toMatchObject({ taskCount: 1 });
      // 실제 파이프라인과 동일하게 plan review 게이트를 통과시킨다 (scheduler는 자기가
      // decompose한 goal에만 게이트를 돌리므로, 직접 decompose한 이 fixture는 명시 호출).
      await decomposeEngine.applyPlanReviewGate("g1", { autopilot: "goal" });
      const task = db.prepare("SELECT id FROM tasks WHERE goal_id = 'g1' LIMIT 1").get() as { id: string };
      expect(
        (db.prepare("SELECT status, plan_review_status FROM tasks WHERE id = ?").get(task.id) as { status: string; plan_review_status: string }),
      ).toMatchObject({ status: "todo", plan_review_status: "approved" });

      // Step 2: let the REAL scheduler drive implementation → verification.
      // The first verification attempt fails (rate limit on `from`); the
      // scheduler must classify it, redispatch to `to`, and the retried
      // verification must carry the same persisted implementation handoff.
      const scheduler = createScheduler(db, manager, () => {});
      try {
        scheduler.startQueue("p1");
        await waitUntil(
          () => (db.prepare("SELECT status FROM tasks WHERE id = ?").get(task.id) as { status: string }).status === "done",
          20_000,
        );
      } finally {
        scheduler.stopQueue("p1");
      }

      const finalTask = db.prepare(`
        SELECT status, provider_failover_redispatched, provider_failover_from_provider,
               provider_failover_to_provider
        FROM tasks WHERE id = ?
      `).get(task.id);
      expect(finalTask).toMatchObject({
        status: "done",
        provider_failover_redispatched: 1,
        provider_failover_from_provider: from,
        provider_failover_to_provider: to,
      });

      const verificationSends = backendRuntime.sent.filter(({ prompt }) => prompt.includes("Quality Verification"));
      expect(verificationSends).toHaveLength(2);
      expect(verificationSends[0]?.provider).toBe(from);
      expect(verificationSends[1]?.provider).toBe(to);

      const marker = `IMPLEMENTATION_HANDOFF_${from.toUpperCase()}_TO_${to.toUpperCase()}`;
      expect(verificationSends[0]?.prompt).toContain(marker);
      expect(verificationSends[1]?.prompt).toContain(marker);
      expect(verificationSends[1]?.prompt).toContain("npm test -- fixture-handoff");
      for (const { prompt } of backendRuntime.sent) {
        expect(prompt).not.toContain("PRIVATE_DIALOGUE_MARKER");
      }
    },
    30_000,
  );
});
