import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("../core/agent/adapters/backend.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBackend: () => ({
      provider: "claude",
      isAvailable: async () => true,
      spawn: mocks.spawn,
    }),
  };
});

import { createSessionManager } from "../core/agent/session.js";

describe("structured handoff session isolation", () => {
  let db: Database.Database;

  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation(() => Object.assign(new EventEmitter(), {
      id: "fresh-runtime",
      status: "idle",
      process: null,
      lastSessionId: null,
      send: vi.fn(),
      kill: vi.fn(),
      cleanup: vi.fn(),
    }));
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'Project', 'new', '/tmp')").run();
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, session_behavior)
      VALUES ('a1', 'p1', 'Agent', 'backend', 'resume-or-new')
    `).run();
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'Goal')").run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, assignee_id)
      VALUES ('t1', 'g1', 'p1', 'Task', 'a1')
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, agent_id, task_id, status, ended_at, last_output)
      VALUES ('prior-session', 'a1', 't1', 'completed', datetime('now'), 'UNSTRUCTURED_SECRET')
    `).run();
  });

  it("forces a fresh provider conversation and omits prior last_output", () => {
    const manager = createSessionManager(db);

    manager.spawnAgent(
      "a1",
      "/tmp",
      "evaluator-t1",
      "t1",
      undefined,
      { omitUnstructuredTaskOutput: true, forceNewSession: true },
    );

    expect(mocks.spawn).toHaveBeenCalledOnce();
    const config = mocks.spawn.mock.calls[0][0] as {
      sessionBehavior: string;
      resumeSessionId: string | null;
      systemPrompt: string;
    };
    expect(config.sessionBehavior).toBe("new");
    expect(config.resumeSessionId).toBeNull();
    expect(config.systemPrompt).not.toContain("UNSTRUCTURED_SECRET");
    expect(config.systemPrompt).not.toContain("최근 출력(끝부분)");
  });
});
