import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { SessionManager } from "../core/agent/session.js";
import { createAgentHandoff } from "../core/agent/handoff.js";
import { saveAgentHandoff } from "../core/agent/handoff-store.js";
import {
  AgentHandoffConsumptionError,
  formatConsumedAgentHandoff,
  loadRequiredAgentHandoff,
} from "../core/agent/handoff-consumer.js";
import { createQualityGate } from "../core/quality-gate/evaluator.js";
import { createDatabase, migrate } from "../db/schema.js";

describe("agent handoff consumption preflight", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES (?, ?, ?, ?)")
      .run("project-1", "Project", "new", "/tmp");
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES (?, ?, ?)")
      .run("goal-1", "project-1", "Goal");
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)")
      .run("agent-1", "project-1", "Generator", "backend");
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)")
      .run("reviewer-1", "project-1", "Reviewer", "reviewer");
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("task-1", "goal-1", "project-1", "Task", "agent-1", "in_review");
  });

  function insertSession(
    id: string,
    agentId = "agent-1",
    taskId: string | null = "task-1",
    lastOutput: string | null = null,
  ): void {
    db.prepare(`
      INSERT INTO sessions (id, agent_id, task_id, status, last_output)
      VALUES (?, ?, ?, 'completed', ?)
    `).run(id, agentId, taskId, lastOutput);
  }

  it("injects the newest fix handoff as a backend-neutral JSON block", () => {
    insertSession("implementation-session");
    insertSession("fix-session");
    saveAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      sessionId: "implementation-session",
      handoff: createAgentHandoff({
        stage: "implementation",
        changed_files: ["server/old.ts"],
      }),
    });
    saveAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      sessionId: "fix-session",
      handoff: createAgentHandoff({
        stage: "fix",
        changed_files: ["server/fixed.ts"],
        reproduction_commands: ["npm test"],
      }),
    });

    const consumed = loadRequiredAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      phase: "verification",
      expectedStages: ["implementation", "fix"],
    });
    const prompt = formatConsumedAgentHandoff(consumed);

    expect(consumed.handoff.stage).toBe("fix");
    expect(prompt).toContain('"changed_files": [\n    "server/fixed.ts"');
    expect(prompt).toContain('"reproduction_commands": [\n    "npm test"');
    expect(prompt).not.toContain("server/old.ts");
  });

  it.each(["claude", "codex"] as const)(
    "passes the same latest fix handoff to the %s evaluator prompt",
    async (provider) => {
      insertSession("implementation-session");
      insertSession("fix-session");
      saveAgentHandoff(db, {
        goalId: "goal-1",
        taskId: "task-1",
        sessionId: "implementation-session",
        handoff: createAgentHandoff({
          stage: "implementation",
          changed_files: ["server/old.ts"],
        }),
      });
      saveAgentHandoff(db, {
        goalId: "goal-1",
        taskId: "task-1",
        sessionId: "fix-session",
        handoff: createAgentHandoff({
          stage: "fix",
          changed_files: ["server/fixed.ts"],
          reproduction_commands: ["npm test"],
        }),
      });

      let sentPrompt = "";
      const session = Object.assign(new EventEmitter(), {
        id: `${provider}-runtime`,
        send: vi.fn(async (prompt: string) => {
          sentPrompt = prompt;
          db.prepare("DELETE FROM goals WHERE id = ?").run("goal-1");
          return { stdout: "", stderr: "", exitCode: 143, provider };
        }),
      });
      const manager = {
        spawnAgent: vi.fn(() => session as never),
        getSession: vi.fn(),
        getSessionRecord: vi.fn(),
        killSession: vi.fn(),
        killAll: vi.fn(),
        pauseSession: vi.fn(),
        resumeSession: vi.fn(),
        setProviderOverride: vi.fn(),
        clearProviderOverride: vi.fn(),
      } satisfies SessionManager;

      await expect(createQualityGate(db, manager).verify("task-1", { workdir: "/tmp" }))
        .rejects.toThrow("deleted during verification");
      expect(sentPrompt).toContain('"stage": "fix"');
      expect(sentPrompt).toContain('"server/fixed.ts"');
      expect(sentPrompt).toContain('"npm test"');
      expect(sentPrompt).not.toContain("server/old.ts");
      expect(sentPrompt).toContain("Independently inspect every path in changed_files");
    },
  );

  it("blocks on the newest malformed row instead of falling back to an older valid handoff", () => {
    insertSession("valid-session");
    insertSession("invalid-session");
    saveAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      sessionId: "valid-session",
      handoff: createAgentHandoff({ stage: "implementation" }),
    });
    db.prepare(`
      INSERT INTO agent_handoffs
        (goal_id, task_id, session_id, contract_version, stage, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "goal-1",
      "task-1",
      "invalid-session",
      1,
      "fix",
      JSON.stringify({ version: 1, stage: "fix" }),
    );

    expect(() => loadRequiredAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      phase: "verification",
      expectedStages: ["implementation", "fix"],
    })).toThrowError(expect.objectContaining({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ field: "changed_files", code: "missing_field" }),
      ]),
    }));
  });

  it.each([
    {
      name: "missing required field",
      contractVersion: 1,
      payload: {
        version: 1,
        stage: "implementation",
        decisions: [],
        unresolved_risks: [],
        reproduction_commands: [],
      },
      expectedDiagnostic: { field: "changed_files", code: "missing_field" },
    },
    {
      name: "unsupported contract version",
      contractVersion: 2,
      payload: {
        version: 2,
        stage: "implementation",
        changed_files: [],
        decisions: [],
        unresolved_risks: [],
        reproduction_commands: [],
      },
      expectedDiagnostic: { field: "version", code: "unsupported_version" },
    },
    {
      name: "invalid required field type",
      contractVersion: 1,
      payload: {
        version: 1,
        stage: "implementation",
        changed_files: "server/index.ts",
        decisions: [],
        unresolved_risks: [],
        reproduction_commands: [],
      },
      expectedDiagnostic: { field: "changed_files", code: "invalid_type" },
    },
  ])("blocks before spawn and records diagnostics for $name", async ({
    contractVersion,
    payload,
    expectedDiagnostic,
  }) => {
    insertSession("invalid-session");
    db.prepare(`
      INSERT INTO agent_handoffs
        (goal_id, task_id, session_id, contract_version, stage, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "goal-1",
      "task-1",
      "invalid-session",
      contractVersion,
      "implementation",
      JSON.stringify(payload),
    );

    const spawnAgent = vi.fn();
    const manager = {
      spawnAgent,
      getSession: vi.fn(),
      getSessionRecord: vi.fn(),
      killSession: vi.fn(),
      killAll: vi.fn(),
      pauseSession: vi.fn(),
      resumeSession: vi.fn(),
      setProviderOverride: vi.fn(),
      clearProviderOverride: vi.fn(),
    } satisfies SessionManager;

    await expect(createQualityGate(db, manager).verify("task-1", { workdir: "/tmp" }))
      .rejects.toBeInstanceOf(AgentHandoffConsumptionError);

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get("task-1"))
      .toEqual({ status: "blocked" });
    const failedSession = db.prepare(`
      SELECT status, pid, last_output FROM sessions
      WHERE task_id = ? AND agent_id = ? ORDER BY rowid DESC LIMIT 1
    `).get("task-1", "reviewer-1") as { status: string; pid: number | null; last_output: string };
    expect(failedSession.status).toBe("failed");
    expect(failedSession.pid).toBeNull();
    expect(JSON.parse(failedSession.last_output)).toMatchObject({
      phase: "verification",
      diagnostics: expect.arrayContaining([
        expect.objectContaining(expectedDiagnostic),
      ]),
    });
    const activity = db.prepare(`
      SELECT type, metadata FROM activities
      WHERE project_id = ? ORDER BY id DESC LIMIT 1
    `).get("project-1") as { type: string; metadata: string };
    expect(activity.type).toBe("handoff_validation_failed");
    expect(JSON.parse(activity.metadata)).toMatchObject({
      taskId: "task-1",
      phase: "verification",
      diagnostics: expect.arrayContaining([expect.objectContaining(expectedDiagnostic)]),
    });
  });

  it("rejects a verification handoff when fix is the required next consumer", () => {
    insertSession("verification-session", "reviewer-1");
    saveAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      sessionId: "verification-session",
      handoff: createAgentHandoff({ stage: "verification" }),
    });

    expect(() => loadRequiredAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      phase: "verification",
      expectedStages: ["implementation", "fix"],
    })).toThrowError(expect.objectContaining({
      diagnostics: [expect.objectContaining({ field: "stage", code: "invalid_value" })],
    }));
  });
});
