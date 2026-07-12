import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentHandoff } from "../core/agent/handoff.js";
import {
  AgentHandoffPersistenceError,
  getLatestValidAgentHandoff,
  saveAgentHandoff,
} from "../core/agent/handoff-store.js";
import { createDatabase, migrate } from "../db/schema.js";

describe("agent handoff persistence", () => {
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

  function insertSession(id: string, taskId: string | null = "task-1"): void {
    db.prepare("INSERT INTO sessions (id, agent_id, task_id, status) VALUES (?, ?, ?, ?)")
      .run(id, "agent-1", taskId, "completed");
  }

  it("migrates new and existing databases idempotently without backfilling legacy results", () => {
    insertSession("legacy-session");
    db.exec("DROP TABLE agent_handoffs");

    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(agent_handoffs)").all() as { name: string }[];
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "goal_id",
      "task_id",
      "session_id",
      "contract_version",
      "stage",
      "payload",
    ]));
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_handoffs").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT id FROM sessions WHERE id = ?").get("legacy-session"))
      .toEqual({ id: "legacy-session" });
  });

  it("stores complete empty arrays and retrieves by goal, task, and stage", () => {
    insertSession("implementation-session");
    const handoff = createAgentHandoff({ stage: "implementation" });

    const stored = saveAgentHandoff(db, {
      goalId: "goal-1",
      sessionId: "implementation-session",
      handoff,
    });

    expect(stored).toMatchObject({
      goalId: "goal-1",
      taskId: "task-1",
      sessionId: "implementation-session",
      handoff: {
        version: 1,
        stage: "implementation",
        changed_files: [],
        decisions: [],
        unresolved_risks: [],
        reproduction_commands: [],
      },
    });
    expect(getLatestValidAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      stage: "implementation",
    })).toEqual(stored);
  });

  it("selects a later fix handoff instead of the implementation handoff", () => {
    insertSession("implementation-session");
    insertSession("fix-session");
    saveAgentHandoff(db, {
      goalId: "goal-1",
      sessionId: "implementation-session",
      handoff: createAgentHandoff({
        stage: "implementation",
        changed_files: ["server/old.ts"],
      }),
    });
    const fix = saveAgentHandoff(db, {
      goalId: "goal-1",
      sessionId: "fix-session",
      handoff: createAgentHandoff({
        stage: "fix",
        changed_files: ["server/fixed.ts"],
      }),
    });

    expect(getLatestValidAgentHandoff(db, { goalId: "goal-1", taskId: "task-1" }))
      .toEqual(fix);
  });

  it("skips a newer malformed row and returns the latest valid handoff", () => {
    insertSession("valid-session");
    insertSession("invalid-session");
    const valid = saveAgentHandoff(db, {
      goalId: "goal-1",
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

    expect(getLatestValidAgentHandoff(db, { goalId: "goal-1", taskId: "task-1" }))
      .toEqual(valid);
  });

  it("skips a newer row whose task and producing session do not match", () => {
    insertSession("valid-session");
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title) VALUES (?, ?, ?, ?)")
      .run("task-2", "goal-1", "project-1", "Other task");
    insertSession("mismatched-session", "task-2");
    const valid = saveAgentHandoff(db, {
      goalId: "goal-1",
      sessionId: "valid-session",
      handoff: createAgentHandoff({ stage: "implementation" }),
    });
    const invalid = createAgentHandoff({ stage: "fix" });
    db.prepare(`
      INSERT INTO agent_handoffs
        (goal_id, task_id, session_id, contract_version, stage, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("goal-1", "task-1", "mismatched-session", 1, "fix", JSON.stringify(invalid));

    expect(getLatestValidAgentHandoff(db, { goalId: "goal-1", taskId: "task-1" }))
      .toEqual(valid);
  });

  it("rejects invalid handoffs before writing and reports field diagnostics", () => {
    insertSession("invalid-session");

    expect(() => saveAgentHandoff(db, {
      goalId: "goal-1",
      sessionId: "invalid-session",
      handoff: { version: 1, stage: "fix" },
    })).toThrowError(AgentHandoffPersistenceError);

    try {
      saveAgentHandoff(db, {
        goalId: "goal-1",
        sessionId: "invalid-session",
        handoff: { version: 1, stage: "fix" },
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_handoff",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ field: "changed_files", code: "missing_field" }),
        ]),
      });
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_handoffs").get()).toEqual({ count: 0 });
  });

  it("rejects a task-scoped handoff from a session that is not bound to that task", () => {
    insertSession("goal-session", null);

    expect(() => saveAgentHandoff(db, {
      goalId: "goal-1",
      taskId: "task-1",
      sessionId: "goal-session",
      handoff: createAgentHandoff({ stage: "implementation" }),
    })).toThrowError(expect.objectContaining({ code: "session_task_mismatch" }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_handoffs").get()).toEqual({ count: 0 });
  });
});
