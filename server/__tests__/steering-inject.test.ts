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

/** 마지막 spawn 에 전달된 systemPrompt. */
function lastSystemPrompt(): string {
  const calls = mocks.spawn.mock.calls;
  return (calls[calls.length - 1][0] as { systemPrompt: string }).systemPrompt;
}

describe("steering injection at Generator step boundary", () => {
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
      VALUES ('gen', 'p1', 'Coder', 'backend', 'resume-or-new')
    `).run();
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, session_behavior)
      VALUES ('eval', 'p1', 'Reviewer', 'reviewer', 'resume-or-new')
    `).run();
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'Goal')").run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, assignee_id)
      VALUES ('t1', 'g1', 'p1', 'Task', 'gen')
    `).run();
  });

  it("injects pending notes into the prompt, drains the queue, and logs '조향 주입됨'", () => {
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n1', 'g1', 'use zod for validation')").run();
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n2', 'g1', 'avoid any casts')").run();

    const broadcasts: Array<{ event: string; data: any }> = [];
    const manager = createSessionManager(db, (event, data) => broadcasts.push({ event, data }));

    manager.spawnAgent("gen", "/tmp", undefined, "t1", undefined, {
      omitUnstructuredTaskOutput: true,
      forceNewSession: true,
      injectSteeringForGoalId: "g1",
    });

    // 1) 프롬프트에 조향 문자열이 FIFO 순서로 포함된다
    const prompt = lastSystemPrompt();
    expect(prompt).toContain("사용자 조향 지침");
    expect(prompt).toContain("use zod for validation");
    expect(prompt).toContain("avoid any casts");
    expect(prompt.indexOf("use zod for validation")).toBeLessThan(prompt.indexOf("avoid any casts"));

    // 2) 큐 소진: injected=1, injected_at, injected_step = 이 스텝의 sessions.id
    const step = manager.getSessionRecord("gen")?.rowId;
    expect(step).toBeTruthy();
    const notes = db.prepare(
      "SELECT id, injected, injected_at, injected_step FROM goal_steering_notes WHERE goal_id = 'g1' ORDER BY rowid",
    ).all() as Array<{ id: string; injected: number; injected_at: string | null; injected_step: string | null }>;
    expect(notes.every((n) => n.injected === 1)).toBe(true);
    expect(notes.every((n) => typeof n.injected_at === "string" && n.injected_at.length > 0)).toBe(true);
    expect(notes.every((n) => n.injected_step === step)).toBe(true);

    // 3) activity log '조향 주입됨' + broadcast(activity:created)
    const act = db.prepare(
      "SELECT type, message, metadata FROM activities WHERE type = 'steering_injected'",
    ).get() as { type: string; message: string; metadata: string } | undefined;
    expect(act).toBeDefined();
    expect(act!.message).toContain("조향 주입됨");
    const meta = JSON.parse(act!.metadata);
    expect(meta.goalId).toBe("g1");
    expect(meta.taskId).toBe("t1");
    expect(meta.injectedStep).toBe(step);
    expect(meta.notes.map((n: any) => n.id)).toEqual(["n1", "n2"]);

    const evt = broadcasts.find((b) => b.event === "activity:created");
    expect(evt).toBeDefined();
    expect(evt!.data.type).toBe("steering_injected");
    expect(evt!.data.metadata.injectedStep).toBe(step);

    const steeringEvt = broadcasts.find((b) => b.event === "steering:injected");
    expect(steeringEvt).toBeDefined();
    expect(steeringEvt!.data.injectedStep).toBe(step);
    expect(steeringEvt!.data.injectedAt).toBe(notes[0].injected_at);
  });

  it("does NOT inject into an Evaluator session (no injectSteeringForGoalId) — note stays pending", () => {
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n1', 'g1', 'STEERING_SECRET')").run();

    const manager = createSessionManager(db);
    // Evaluator 세션은 플래그를 세팅하지 않는다 (Generator-Evaluator 분리 유지)
    manager.spawnAgent("eval", "/tmp", "evaluator-t1", "t1", undefined, {
      omitUnstructuredTaskOutput: true,
      forceNewSession: true,
    });

    expect(lastSystemPrompt()).not.toContain("STEERING_SECRET");
    expect(lastSystemPrompt()).not.toContain("사용자 조향 지침");
    const note = db.prepare("SELECT injected FROM goal_steering_notes WHERE id = 'n1'").get() as { injected: number };
    expect(note.injected).toBe(0); // 여전히 pending → 다음 Generator 스텝에서 반영
  });

  it("drains the queue so a later Generator step with no new notes injects nothing", () => {
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n1', 'g1', 'first note')").run();
    const manager = createSessionManager(db);

    // 첫 Generator 스텝 — 주입 + 소진
    manager.spawnAgent("gen", "/tmp", undefined, "t1", undefined, {
      omitUnstructuredTaskOutput: true, forceNewSession: true, injectSteeringForGoalId: "g1",
    });
    expect(lastSystemPrompt()).toContain("first note");
    const firstStep = db.prepare("SELECT injected_step FROM goal_steering_notes WHERE id = 'n1'").get() as { injected_step: string };

    // 두 번째 Generator 스텝 — pending 없음 → 조향 블록 없음, 재주입/재기록 없음
    manager.spawnAgent("gen", "/tmp", undefined, "t1", undefined, {
      omitUnstructuredTaskOutput: true, forceNewSession: true, injectSteeringForGoalId: "g1",
    });
    expect(lastSystemPrompt()).not.toContain("first note");
    expect(lastSystemPrompt()).not.toContain("사용자 조향 지침");

    // 이전 주입 노트는 그대로 (injected_step 불변), activity 는 1건만
    const note = db.prepare("SELECT injected, injected_step FROM goal_steering_notes WHERE id = 'n1'").get() as { injected: number; injected_step: string };
    expect(note.injected).toBe(1);
    expect(note.injected_step).toBe(firstStep.injected_step);
    const count = db.prepare("SELECT COUNT(*) AS c FROM activities WHERE type = 'steering_injected'").get() as { c: number };
    expect(count.c).toBe(1);
  });
});
