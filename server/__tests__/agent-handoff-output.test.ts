import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { parseAgentOutput } from "../core/agent/adapters/stream-parser.js";
import { saveAgentHandoff } from "../core/agent/handoff-store.js";
import { createDatabase, migrate } from "../db/schema.js";
import type { AgentHandoffStage } from "../../shared/types.js";

function claudeOutput(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

function codexOutput(text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text },
  });
}

describe("agent output handoff extraction", () => {
  it.each([
    ["claude", claudeOutput] as const,
    ["codex", codexOutput] as const,
  ])("extracts the same implementation handoff from %s", (provider, wrap) => {
    const text = JSON.stringify({
      handoff: {
        version: 1,
        stage: "implementation",
        changed_files: [],
        decisions: ["공통 parser 경로 사용"],
        unresolved_risks: [],
        reproduction_commands: [],
      },
    });

    const parsed = parseAgentOutput(wrap(text), provider, "implementation");

    expect(parsed.handoff).toEqual({
      version: 1,
      stage: "implementation",
      changed_files: [],
      decisions: ["공통 parser 경로 사용"],
      unresolved_risks: [],
      reproduction_commands: [],
    });
    expect(parsed.handoffDiagnostics).toEqual([]);
  });

  it.each([
    ["claude", claudeOutput] as const,
    ["codex", codexOutput] as const,
  ])("rejects missing required array fields from %s instead of normalizing them", (provider, wrap) => {
    const text = JSON.stringify({
      handoff: {
        version: 1,
        stage: "implementation",
        decisions: ["ok"],
      },
    });

    const parsed = parseAgentOutput(wrap(text), provider, "implementation");

    expect(parsed.handoff).toBeNull();
    expect(parsed.handoffDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "changed_files", code: "missing_field" }),
      expect.objectContaining({ field: "unresolved_risks", code: "missing_field" }),
      expect.objectContaining({ field: "reproduction_commands", code: "missing_field" }),
    ]));
  });

  it("extracts a handoff next to decomposition payload fields", () => {
    const parsed = parseAgentOutput(claudeOutput(JSON.stringify({
      tasks: [{ title: "첫 작업" }],
      handoff: {
        version: 1,
        stage: "decompose",
        changed_files: [],
        decisions: [],
        unresolved_risks: [],
        reproduction_commands: [],
      },
    })), "claude", "decompose");

    expect(parsed.handoff?.stage).toBe("decompose");
  });

  it("does not mistake unstructured prose for a valid handoff", () => {
    const parsed = parseAgentOutput(
      codexOutput("변경 파일은 없고 위험도 없습니다. 작업을 완료했습니다."),
      "codex",
      "fix",
    );

    expect(parsed.handoff).toBeNull();
    expect(parsed.handoffDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "handoff", code: "missing_field" }),
    ]));
  });

  it("rejects a handoff nested below another top-level property", () => {
    const parsed = parseAgentOutput(claudeOutput(JSON.stringify({
      result: {
        handoff: {
          version: 1,
          stage: "implementation",
          changed_files: [],
          decisions: [],
          unresolved_risks: [],
          reproduction_commands: [],
        },
      },
    })), "claude", "implementation");

    expect(parsed.handoff).toBeNull();
    expect(parsed.handoffDiagnostics[0]).toMatchObject({
      field: "handoff",
      code: "missing_field",
    });
  });

  it("rejects malformed array values instead of normalizing them", () => {
    const parsed = parseAgentOutput(claudeOutput(JSON.stringify({
      handoff: {
        version: 1,
        stage: "verification",
        changed_files: "server/index.ts",
      },
    })), "claude", "verification");

    expect(parsed.handoff).toBeNull();
    expect(parsed.handoffDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "changed_files", code: "invalid_type" }),
    ]));
  });

  it("rejects a valid handoff for the wrong execution stage", () => {
    const parsed = parseAgentOutput(codexOutput(JSON.stringify({
      handoff: {
        version: 1,
        stage: "implementation",
        changed_files: [],
        decisions: [],
        unresolved_risks: [],
        reproduction_commands: [],
      },
    })), "codex", "fix");

    expect(parsed.handoff).toBeNull();
    expect(parsed.handoffDiagnostics[0]).toMatchObject({ field: "stage", code: "invalid_value" });
  });
});

describe("agent output handoff persistence boundary", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source) VALUES (?, ?, ?)")
      .run("project-1", "Project", "new");
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES (?, ?, ?)")
      .run("goal-1", "project-1", "Goal");
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)")
      .run("agent-1", "project-1", "Agent", "backend");
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title) VALUES (?, ?, ?, ?)")
      .run("task-1", "goal-1", "project-1", "Task");
  });

  it.each([
    ["decompose", "claude"],
    ["implementation", "codex"],
    ["verification", "claude"],
    ["fix", "codex"],
  ] as Array<[AgentHandoffStage, "claude" | "codex"]>)(
    "persists a parsed %s handoff with its producing session",
    (stage, provider) => {
      const sessionId = `${stage}-session`;
      const taskId = stage === "decompose" ? null : "task-1";
      db.prepare("INSERT INTO sessions (id, agent_id, task_id, status) VALUES (?, ?, ?, ?)")
        .run(sessionId, "agent-1", taskId, "completed");
      const text = JSON.stringify({
        handoff: {
          version: 1,
          stage,
          changed_files: [],
          decisions: [],
          unresolved_risks: [],
          reproduction_commands: [],
        },
      });
      const raw = provider === "claude" ? claudeOutput(text) : codexOutput(text);
      const parsed = parseAgentOutput(raw, provider, stage);

      const stored = saveAgentHandoff(db, {
        goalId: "goal-1",
        taskId,
        sessionId,
        handoff: parsed.handoff,
      });

      expect(stored).toMatchObject({ sessionId, taskId, handoff: { stage } });
    },
  );

  it.each([
    ["claude", claudeOutput] as const,
    ["codex", codexOutput] as const,
  ])("does not persist an agent handoff from %s that omits required arrays", (provider, wrap) => {
    const sessionId = `${provider}-incomplete-session`;
    db.prepare("INSERT INTO sessions (id, agent_id, task_id, status) VALUES (?, ?, ?, ?)")
      .run(sessionId, "agent-1", "task-1", "completed");
    const parsed = parseAgentOutput(wrap(JSON.stringify({
      handoff: {
        version: 1,
        stage: "implementation",
        decisions: ["producer omission"],
      },
    })), provider, "implementation");

    expect(parsed.handoff).toBeNull();
    expect(() => saveAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      sessionId,
      handoff: parsed.handoff,
    })).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_handoffs WHERE session_id = ?")
      .get(sessionId)).toEqual({ count: 0 });
  });

  it("does not write a rejected parser result", () => {
    db.prepare("INSERT INTO sessions (id, agent_id, task_id, status) VALUES (?, ?, ?, ?)")
      .run("invalid-session", "agent-1", "task-1", "completed");
    const parsed = parseAgentOutput(
      codexOutput(JSON.stringify({ result: { handoff: { version: 1, stage: "fix" } } })),
      "codex",
      "fix",
    );

    expect(() => saveAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      sessionId: "invalid-session",
      handoff: parsed.handoff,
    })).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_handoffs").get()).toEqual({ count: 0 });
  });
});
