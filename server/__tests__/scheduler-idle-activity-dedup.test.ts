import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createDatabase, migrate } from "../db/schema.js";

function createSessionManager(): SessionManager {
  return {
    spawnAgent: vi.fn(() => {
      throw new Error("execution slots are already occupied");
    }),
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
 * Regression: "최근 활동" idle-broadcast spam.
 *
 * poll() 은 매 tick(1s) processNextGoal 을 재호출하고, 그 finally 에서 clearActivity()
 * 가 CTO 를 idle 로 되돌린다. Goal Spec 승인 대기(spec_approval_required=1, 미승인) 중이면
 * assertExecutionAllowed 가 매 tick false 라 조기 return → finally clearActivity 가 매 tick
 * 실행된다. 전이 감지 없이 무조건 broadcast 하면 CTO 가 이미 idle 인데도 초당 "agent:status
 * idle" 이 나가 대시보드 활동 로그가 도배된다. 수정 후에는 실제 상태 전이일 때만 broadcast 한다.
 */
describe("scheduler does not spam idle agent:status while gated on spec approval", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  const broadcast = vi.fn();
  const projectId = "project-idle-dedup";

  const idleBroadcastCount = (): number =>
    broadcast.mock.calls.filter(
      ([type, payload]) =>
        type === "agent:status" && payload?.id === "cto-1" && payload?.status === "idle",
    ).length;

  const decomposeActivityCount = (): number =>
    (db.prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE project_id = ? AND message LIKE '태스크 분할 중:%'",
    ).get(projectId) as { count: number }).count;

  beforeEach(() => {
    vi.useFakeTimers();
    broadcast.mockClear();
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO projects (id, name, source, autopilot) VALUES (?, 'test', 'new', 'goal')",
    ).run(projectId);
    // CTO 를 working 으로 시작시켜, 첫 clearActivity 가 진짜 전이(working→idle)로 1회만
    // broadcast 하고 이후 tick 은 스킵되는지 검증한다.
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role, status, current_activity) VALUES ('cto-1', ?, 'cto', 'cto', 'working', 'boot')",
    ).run(projectId);

    // 0-task goal + 스펙은 존재(hasSpec true)하나 승인 필요·미승인 → 실행 게이트가 매 tick 차단.
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description, priority, sort_order, spec_approval_required) VALUES ('gated-goal', ?, 'gated-goal', 'goal', 'critical', 0, 1)",
    ).run(projectId);
    db.prepare(
      `INSERT INTO goal_specs (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by)
       VALUES ('gated-goal', 'ready', '[]', '[]', '[]', '[]', 'ai')`,
    ).run();

    scheduler = createScheduler(db, createSessionManager(), broadcast);
    scheduler.setSpecGenerator(vi.fn(async () => {}));
  });

  afterEach(() => {
    scheduler.stopQueue(projectId);
    db.close();
    vi.useRealTimers();
  });

  it("broadcasts idle at most once across many poll ticks (not once per tick)", async () => {
    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(5_000); // ~5 poll ticks @ 1s

    // 게이트가 계속 막아 decompose 는 시작되지 않는다(= processNextGoal 이 매 tick finally 로 진입).
    expect(scheduler.isRunning(projectId)).toBe(true);
    expect(decomposeActivityCount()).toBe(0);

    // 수정 전: tick 수만큼(≈5) idle broadcast. 수정 후: 실제 전이 1회뿐.
    expect(idleBroadcastCount()).toBeLessThanOrEqual(1);
  });
});
