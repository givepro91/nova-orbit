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

  /** 터미널 성공 RunResult (exit 0, 중단 아님) — 조향 소진 커밋 조건. */
  const okResult = { stdout: "", stderr: "", exitCode: 0, sessionId: null, provider: "claude" as const };
  /** 다음 send 호출이 돌려줄 결과 — session.ts 가 send 를 래핑하므로(spawn 시 bind)
   *  spawn 이후 mock 교체가 불가능하다. 호출 시점에 이 변수를 읽어 흉내낸다. */
  let sendOutcome: typeof okResult & { interrupted?: boolean } = okResult;

  beforeEach(() => {
    sendOutcome = okResult;
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation(() => Object.assign(new EventEmitter(), {
      id: "fresh-runtime",
      status: "idle",
      process: null,
      lastSessionId: null,
      send: vi.fn(async () => sendOutcome),
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

  it("injects pending notes into the prompt, drains after send success + engine commit, and logs '조향 주입됨'", async () => {
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n1', 'g1', 'use zod for validation')").run();
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n2', 'g1', 'avoid any casts')").run();

    const broadcasts: Array<{ event: string; data: any }> = [];
    const manager = createSessionManager(db, (event, data) => broadcasts.push({ event, data }));

    const session = manager.spawnAgent("gen", "/tmp", undefined, "t1", undefined, {
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

    // 1.5) 소진 이연: send 가 성공하기 전까진 pending(injected=0) 그대로.
    // send 성공 전의 commit 호출은 미무장 no-op 이다.
    const pendingCount = () => (db.prepare(
      "SELECT COUNT(*) AS c FROM goal_steering_notes WHERE goal_id = 'g1' AND injected = 0",
    ).get() as { c: number }).c;
    expect(pendingCount()).toBe(2);
    manager.commitSteeringInjection?.("gen");
    expect(pendingCount()).toBe(2);
    await session.send("go");

    // 1.6) 소진 이연 2단계: send 터미널 성공만으로는 소진되지 않는다 — engine 이
    // detectAgentRunFailure(소프트 실패) 판정을 통과한 뒤 명시 커밋해야 소진된다.
    expect(pendingCount()).toBe(2);
    manager.commitSteeringInjection?.("gen");

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

  it("drains the queue so a later Generator step with no new notes injects nothing", async () => {
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n1', 'g1', 'first note')").run();
    const manager = createSessionManager(db);

    // 첫 Generator 스텝 — 주입 + send 성공 + engine 커밋 → 소진
    const first = manager.spawnAgent("gen", "/tmp", undefined, "t1", undefined, {
      omitUnstructuredTaskOutput: true, forceNewSession: true, injectSteeringForGoalId: "g1",
    });
    expect(lastSystemPrompt()).toContain("first note");
    await first.send("go");
    manager.commitSteeringInjection?.("gen");
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

  it("keeps notes pending when send fails, re-injects on the next spawn, and marks only after a successful send", async () => {
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n1', 'g1', 'retry me')").run();
    const manager = createSessionManager(db);

    // 스텝 1 — 주입됐지만 send 가 비정상 종료(exit 1) → 미소진(pending 유지)
    const failing = manager.spawnAgent("gen", "/tmp", undefined, "t1", undefined, {
      omitUnstructuredTaskOutput: true, forceNewSession: true, injectSteeringForGoalId: "g1",
    });
    expect(lastSystemPrompt()).toContain("retry me");
    sendOutcome = { ...okResult, exitCode: 1, stderr: "boom" };
    await failing.send("go");
    // 실패한 send 뒤의 commit 호출은 미무장 no-op — engine 이 실수로 불러도 소진되지 않는다
    manager.commitSteeringInjection?.("gen");
    const pending = db.prepare("SELECT injected FROM goal_steering_notes WHERE id = 'n1'").get() as { injected: number };
    expect(pending.injected).toBe(0); // 실패 → 미소진, activity 도 없다
    expect((db.prepare("SELECT COUNT(*) AS c FROM activities WHERE type = 'steering_injected'").get() as { c: number }).c).toBe(0);

    // 스텝 2 — failover 재디스패치/다음 스텝의 새 spawn 에서 같은 노트가 재주입된다
    const retry = manager.spawnAgent("gen", "/tmp", undefined, "t1", undefined, {
      omitUnstructuredTaskOutput: true, forceNewSession: true, injectSteeringForGoalId: "g1",
    });
    expect(lastSystemPrompt()).toContain("retry me");
    const secondStep = manager.getSessionRecord("gen")?.rowId;

    // send 터미널 성공 + engine 커밋 → 이 스텝(sessions.id)으로 소진 마킹, activity 1건
    sendOutcome = okResult;
    await retry.send("go");
    manager.commitSteeringInjection?.("gen");
    const marked = db.prepare("SELECT injected, injected_step FROM goal_steering_notes WHERE id = 'n1'").get() as {
      injected: number; injected_step: string;
    };
    expect(marked.injected).toBe(1);
    expect(marked.injected_step).toBe(secondStep);
    expect((db.prepare("SELECT COUNT(*) AS c FROM activities WHERE type = 'steering_injected'").get() as { c: number }).c).toBe(1);

    // 같은 세션에서 send/commit 이 또 성공해도(once 가드) 재마킹·activity 중복이 없다
    await retry.send("again");
    manager.commitSteeringInjection?.("gen");
    expect((db.prepare("SELECT COUNT(*) AS c FROM activities WHERE type = 'steering_injected'").get() as { c: number }).c).toBe(1);
  });

  it("soft failure: send 가 exit 0 으로 끝나도 engine 이 커밋하지 않으면 미소진(pending 유지)", async () => {
    // exit 0 이지만 stream error·API error leak 으로 detectAgentRunFailure 가 실패
    // 판정하는 런 — engine 은 commitSteeringInjection 을 호출하지 않는다. 이때 조향이
    // 소진되면 실패한 런에 조향을 태운 것이 된다 (F1 회귀 케이스).
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n1', 'g1', 'do not burn me')").run();
    const manager = createSessionManager(db);

    const session = manager.spawnAgent("gen", "/tmp", undefined, "t1", undefined, {
      omitUnstructuredTaskOutput: true, forceNewSession: true, injectSteeringForGoalId: "g1",
    });
    expect(lastSystemPrompt()).toContain("do not burn me");
    await session.send("go"); // exit 0 — 하지만 engine 판정 실패 가정: commit 미호출

    const note = db.prepare("SELECT injected FROM goal_steering_notes WHERE id = 'n1'").get() as { injected: number };
    expect(note.injected).toBe(0); // pending 유지 → 다음 Generator 스텝에서 재주입
    expect((db.prepare("SELECT COUNT(*) AS c FROM activities WHERE type = 'steering_injected'").get() as { c: number }).c).toBe(0);
  });

  it("does not drain when the turn was intentionally interrupted (steer/abort)", async () => {
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n1', 'g1', 'keep me')").run();
    const manager = createSessionManager(db);

    const session = manager.spawnAgent("gen", "/tmp", undefined, "t1", undefined, {
      omitUnstructuredTaskOutput: true, forceNewSession: true, injectSteeringForGoalId: "g1",
    });
    sendOutcome = { ...okResult, interrupted: true };
    await session.send("go");
    // interrupted 는 무장 자체가 안 된다 — commit 을 불러도 no-op
    manager.commitSteeringInjection?.("gen");
    const note = db.prepare("SELECT injected FROM goal_steering_notes WHERE id = 'n1'").get() as { injected: number };
    expect(note.injected).toBe(0); // 개입으로 끊긴 턴 — 다음 스텝에서 재주입
  });
});
