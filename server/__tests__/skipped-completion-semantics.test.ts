import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createDatabase, migrate } from "../db/schema.js";
import { MAX_TASK_RETRIES, MAX_REASSIGNS } from "../utils/constants.js";
import { isNoDiffAutoPassEligible } from "../core/quality-gate/evaluator.js";

/**
 * W1 완료 의미론 근본 수리 — skipped terminal state.
 *
 * 커버리지 (계획 §W1 테스트 항목):
 *  1. backfill: 구 autoResolve가 done으로 위장시킨 "[자동 건너뜀]" 행 → skipped 정정 (원문 보존·멱등)
 *  2. autoResolve → skipped 전이 (done 승격 아님) + skip_reason + activity 구조 필드
 *  3. progress terminal-inclusive: skipped 포함 100% 도달 (full autopilot 슬롯 점유 방지)
 *  4. discriminator: fix task / plan_review_status='pending' 태스크는 startQueue 자동승인 불가
 * (no-diff auto-pass review 한정은 아래 별도 describe, signal 실패 분류는 detect-agent-failure.test.ts)
 */

function createSessionManager(): SessionManager {
  return {
    spawnAgent: vi.fn(() => {
      throw new Error("no execution in this test");
    }),
    getSession: vi.fn(() => undefined),
    getSessionRecord: vi.fn(() => undefined),
    killSession: vi.fn(),
    killAll: vi.fn(),
    pauseSession: vi.fn(),
    resumeSession: vi.fn(),
    setProviderOverride: vi.fn(),
    clearProviderOverride: vi.fn(),
  } as unknown as SessionManager;
}

function seedProject(db: Database.Database, projectId: string, autopilot: "off" | "goal" | "full"): void {
  db.prepare("INSERT INTO projects (id, name, source, autopilot) VALUES (?, 'test', 'new', ?)").run(projectId, autopilot);
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'Dev', 'backend')").run(`${projectId}-a1`, projectId);
  db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES (?, ?, 'Goal', 'desc')").run(`${projectId}-g1`, projectId);
}

describe("W1 backfill: '[자동 건너뜀]' done → skipped 정정", () => {
  it("status만 skipped로 바꾸고 result_summary 원문을 보존한다 (멱등)", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    seedProject(db, "p-bf", "off");
    const legacySummary = "[자동 건너뜀] 재시도 한도 초과 — 수동 확인 권장";
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status, result_summary) VALUES ('bf-1', 'p-bf-g1', 'p-bf', 'legacy skip', 'done', ?)",
    ).run(legacySummary);
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status, result_summary) VALUES ('bf-2', 'p-bf-g1', 'p-bf', 'real done', 'done', '구현 완료')",
    ).run();

    migrate(db); // backfill은 migrate 본문에서 실행

    const skipped = db.prepare("SELECT status, skip_reason, result_summary FROM tasks WHERE id = 'bf-1'").get() as any;
    expect(skipped.status).toBe("skipped");
    expect(skipped.skip_reason).toBe("retry_exhausted");
    expect(skipped.result_summary).toBe(legacySummary); // P3 — 원문 파괴 금지

    const realDone = db.prepare("SELECT status, skip_reason FROM tasks WHERE id = 'bf-2'").get() as any;
    expect(realDone.status).toBe("done");
    expect(realDone.skip_reason).toBeNull();

    // 멱등: 재적용해도 변화 없음
    migrate(db);
    const again = db.prepare("SELECT status, skip_reason, result_summary FROM tasks WHERE id = 'bf-1'").get() as any;
    expect(again).toEqual(skipped);
  });
});

describe("W1 autoResolve: 영구 blocked → skipped (done 위장 금지)", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  const projectId = "p-ar";

  afterEach(() => {
    scheduler.stopQueue(projectId);
    db.close();
    vi.useRealTimers();
  });

  it("retry+reassign 소진 blocked가 skipped로 전이되고 progress는 terminal-inclusive로 100", async () => {
    vi.useFakeTimers();
    db = createDatabase(":memory:");
    migrate(db);
    seedProject(db, projectId, "off");
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status, result_summary) VALUES ('ar-done', 'p-ar-g1', 'p-ar', 'done task', 'done', '완료 요약')",
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, status, retry_count, reassign_count, result_summary)
       VALUES ('ar-stuck', 'p-ar-g1', 'p-ar', 'stuck task', 'blocked', ?, ?, '마지막 실패 요약')`,
    ).run(MAX_TASK_RETRIES, MAX_REASSIGNS);

    scheduler = createScheduler(db, createSessionManager(), () => {});
    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(5_000);

    const task = db.prepare("SELECT status, skip_reason, result_summary FROM tasks WHERE id = 'ar-stuck'").get() as any;
    expect(task.status).toBe("skipped"); // done 승격 아님
    expect(task.skip_reason).toBe("retry_exhausted");
    expect(task.result_summary).toBe("마지막 실패 요약"); // result_summary 불가침

    // progress = terminal-inclusive → done 1 + skipped 1 / 2 = 100 (슬롯 영구 점유 방지)
    const goal = db.prepare("SELECT progress FROM goals WHERE id = 'p-ar-g1'").get() as any;
    expect(goal.progress).toBe(100);

    // activity: 구조 필드(metadata)가 기계 판독 정본
    const activity = db.prepare(
      "SELECT metadata FROM activities WHERE project_id = ? AND type = 'task_auto_resolved'",
    ).get(projectId) as any;
    expect(activity).toBeTruthy();
    const meta = JSON.parse(activity.metadata);
    expect(meta.taskId).toBe("ar-stuck");
    expect(meta.skipReason).toBe("retry_exhausted");
  });

  it("recovery_manual_action_required=1 이면 건드리지 않는다", async () => {
    vi.useFakeTimers();
    db = createDatabase(":memory:");
    migrate(db);
    seedProject(db, projectId, "off");
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, status, retry_count, reassign_count, recovery_manual_action_required)
       VALUES ('ar-manual', 'p-ar-g1', 'p-ar', 'manual task', 'blocked', ?, ?, 1)`,
    ).run(MAX_TASK_RETRIES, MAX_REASSIGNS);

    scheduler = createScheduler(db, createSessionManager(), () => {});
    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(5_000);

    const task = db.prepare("SELECT status FROM tasks WHERE id = 'ar-manual'").get() as any;
    expect(task.status).toBe("blocked");
  });
});

describe("W1 discriminator: startQueue 자동승인은 legacy plan task만", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  const projectId = "p-disc";

  afterEach(() => {
    scheduler.stopQueue(projectId);
    db.close();
    vi.useRealTimers();
  });

  it("fix task와 plan_review_status='pending' 태스크는 pending_approval 유지, legacy NULL만 todo", () => {
    vi.useFakeTimers();
    db = createDatabase(":memory:");
    migrate(db);
    seedProject(db, projectId, "goal");

    // (a) legacy plan task — plan_review_status NULL, 링크 없음 → 자동승인 대상
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('d-legacy', 'p-disc-g1', 'p-disc', 'legacy plan', 'pending_approval')",
    ).run();
    // (b) 리뷰 게이트 provenance 있는 신규 태스크 → 자동승인 금지 (리뷰어가 처리)
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status, plan_review_status) VALUES ('d-pending', 'p-disc-g1', 'p-disc', 'fresh plan', 'pending_approval', 'pending')",
    ).run();
    // (c) fix task — verification issue에서 파생(relation='fix'), verification_id는 NULL이라
    //     구 discriminator(verifications 프로브)에 안 걸리던 부류 → NOT EXISTS(fix)로 봉인
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('d-source', 'p-disc-g1', 'p-disc', 'source task', 'done')",
    ).run();
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('d-fix', 'p-disc-g1', 'p-disc', 'fix task', 'pending_approval')",
    ).run();
    db.prepare(
      "INSERT INTO verifications (id, task_id, verdict) VALUES ('v-1', 'd-source', 'fail')",
    ).run();
    db.prepare(
      `INSERT INTO verification_issues (id, verification_id, dimension, severity, evidence, repro_command, expected_result, actual_result, fix_instruction, assignee_id)
       VALUES ('vi-1', 'v-1', 'functionality', 'high', 'ev', 'cmd', 'exp', 'act', 'fix it', 'p-disc-a1')`,
    ).run();
    db.prepare(
      "INSERT INTO verification_issue_tasks (issue_id, task_id, relation) VALUES ('vi-1', 'd-fix', 'fix')",
    ).run();

    scheduler = createScheduler(db, createSessionManager(), () => {});
    scheduler.startQueue(projectId); // 자동승인은 startQueue 동기 구간에서 실행

    const statusOf = (id: string) =>
      (db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
    expect(statusOf("d-legacy")).toBe("todo"); // legacy만 소생
    expect(statusOf("d-pending")).toBe("pending_approval"); // 리뷰 게이트 보존
    expect(statusOf("d-fix")).toBe("pending_approval"); // Quality Gate 보존
  });
});

describe("W1 no-diff auto-pass: review 태스크 한정", () => {
  const zeroDiff = { fileCount: 0, untracked: [] as string[] };

  it("review + 변경 없음 + fail → auto-pass 대상", () => {
    expect(isNoDiffAutoPassEligible(zeroDiff, "fail", "hard_blocked", "review")).toBe(true);
  });

  it.each(["code", "content", "config"])("%s 태스크는 변경 없음이어도 evaluator fail 유지", (taskType) => {
    expect(isNoDiffAutoPassEligible(zeroDiff, "fail", "hard_blocked", taskType)).toBe(false);
  });

  it("변경이 있으면(diff 또는 untracked) review여도 auto-pass 아님", () => {
    expect(isNoDiffAutoPassEligible({ fileCount: 2, untracked: [] }, "fail", "hard_blocked", "review")).toBe(false);
    expect(isNoDiffAutoPassEligible({ fileCount: 0, untracked: ["new.ts"] }, "fail", "hard_blocked", "review")).toBe(false);
  });

  it("evaluator_error·pass 판정은 덮지 않는다", () => {
    expect(isNoDiffAutoPassEligible(zeroDiff, "fail", "evaluator_error", "review")).toBe(false);
    expect(isNoDiffAutoPassEligible(zeroDiff, "pass", "passed", "review")).toBe(false);
  });
});
