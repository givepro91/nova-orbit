import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createDatabase, migrate } from "../db/schema.js";

function createSessionManager(): SessionManager {
  return {
    spawnAgent: vi.fn(() => { throw new Error("must not spawn — nothing is executable"); }),
    getSession: vi.fn(() => undefined),
    getSessionRecord: vi.fn(() => undefined),
    killSession: vi.fn(),
    killAll: vi.fn(),
    pauseSession: vi.fn(),
    resumeSession: vi.fn(),
    setProviderOverride: vi.fn(),
    clearProviderOverride: vi.fn(),
  } as SessionManager;
}

/**
 * Regression: PTY 프로젝트가 멈췄을 때 큐를 의심하게 만드는 오진.
 *
 * execution_mode='pty' 에서 태스크를 잇는 주체는 이 큐가 아니라 terminal auto-advance 다.
 * 그런데 stuck 진단은 그걸 모른 채 "큐 상태 확인 필요"라고만 말해, 실제 원인이 터미널 쪽인데
 * 사용자를 정반대로 보냈다 (2026-07-22 실측: tmux 런타임이 사라져 1시간 정지했는데 경고는
 * 내내 큐를 가리켰고, 큐 자체는 running·activeTasks=0 으로 멀쩡했다).
 */
describe("stuck diagnosis names the right subsystem for PTY projects", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  const broadcast = vi.fn();

  const stuckPayloads = () =>
    broadcast.mock.calls.filter(([type]) => type === "autopilot:stuck").map(([, payload]) => payload);

  function seed(projectId: string, executionMode: "pty" | "headless"): void {
    db.prepare(
      "INSERT INTO projects (id, name, source, autopilot, execution_mode) VALUES (?, 'test', 'new', 'goal', ?)",
    ).run(projectId, executionMode);
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role, status) VALUES (?, ?, 'Coder', 'coder', 'idle')",
    ).run(`agent-${projectId}`, projectId);
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description, priority, sort_order) VALUES (?, ?, 'Goal', 'goal', 'medium', 0)",
    ).run(`goal-${projectId}`, projectId);
    // 담당자는 있으나 존재하지 않는 선행 태스크에 묶여 영원히 실행 불가 — 스케줄러는
    // 매 폴 빈손으로 돌아오고 다른 진단 분기(미할당/리뷰어/차단)에는 걸리지 않는다.
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status, sort_order, depends_on)
       VALUES (?, ?, ?, 'Blocked on a missing dependency', ?, 'todo', 0, '["never-exists"]')`,
    ).run(`task-${projectId}`, `goal-${projectId}`, projectId, `agent-${projectId}`);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    broadcast.mockClear();
    db = createDatabase(":memory:");
    migrate(db);
    scheduler = createScheduler(db, createSessionManager(), broadcast);
    scheduler.setSpecGenerator(vi.fn(async () => {}));
  });

  afterEach(() => {
    scheduler.stopQueue("pty-project");
    scheduler.stopQueue("headless-project");
    db.close();
    vi.useRealTimers();
  });

  it("points at the terminal, not the queue, when a PTY project idles", async () => {
    seed("pty-project", "pty");
    scheduler.startQueue("pty-project");
    await vi.advanceTimersByTimeAsync(40_000); // STUCK_POLL_THRESHOLD(30 polls @1s) 초과

    const stuck = stuckPayloads();
    expect(stuck.length).toBeGreaterThan(0);
    expect(stuck[0].code).toBe("pty_idle");
    expect(stuck[0].summary).toContain("터미널");
    expect(stuck[0].summary).not.toContain("큐 상태 확인");
  });

  it("still blames the queue for headless projects", async () => {
    seed("headless-project", "headless");
    scheduler.startQueue("headless-project");
    await vi.advanceTimersByTimeAsync(40_000);

    const stuck = stuckPayloads();
    expect(stuck.length).toBeGreaterThan(0);
    expect(stuck[0].code).toBe("unknown_idle");
  });
});
