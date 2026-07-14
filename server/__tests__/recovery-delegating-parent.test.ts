import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { recoverInterruptedTask, resumeBlockedDelegatingParents } from "../core/recovery.js";
import type Database from "better-sqlite3";

/**
 * 위임 부모(delegating parent) 복구 회귀 테스트 (2026-07-14 실측 deadlock).
 *
 * 버그: 하위 작업으로 분할된 태스크(위임 부모)의 세션이 끊기면, 하위 작업이 goal
 * worktree HEAD 를 정상 전진시킨 것을 recovery 가 leaf 기준 "미기록 커밋"으로 오판해
 * blocked+manual_action 으로 찍음 → goal 동결(pickParallelGoals 제외) → ready 하위
 * 작업이 영영 안 돌아 autopilot self-heal 이 깨진다.
 *
 * 계약:
 * - recoverInterruptedTask: 하위 작업 있는 태스크는 leaf worktree 복구를 건너뛰고
 *   재개 가능한 대기 부모(in_progress)로 resume (checkpoint 무관). leaf 는 기존대로.
 * - resumeBlockedDelegatingParents: 이미 얼어붙은 위임 부모를 재개 + goal 동결 해제.
 */

let seq = 0;

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

function seed(db: Database.Database, opts: { squash?: string } = {}) {
  const pid = `p${++seq}`;
  db.prepare("INSERT INTO projects (id, name, source) VALUES (?, 'test', 'new')").run(pid);
  const gid = `g${seq}`;
  db.prepare(
    "INSERT INTO goals (id, project_id, description, goal_model, worktree_path, worktree_branch, squash_status) VALUES (?, ?, 'goal', 'goal_as_unit', '/tmp/wt', 'goal/x', ?)",
  ).run(gid, pid, opts.squash ?? "none");
  const aid = `a${seq}`;
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'dev', 'backend')").run(aid, pid);
  return { pid, gid, aid };
}

function insTask(
  db: Database.Database,
  pid: string,
  gid: string,
  id: string,
  status: string,
  parent: string | null,
  extra: Record<string, string | number | null> = {},
) {
  const cols = ["id", "goal_id", "project_id", "title", "status", "parent_task_id", ...Object.keys(extra)];
  const vals = [id, gid, pid, "task", status, parent, ...Object.values(extra)];
  db.prepare(
    `INSERT INTO tasks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...vals);
}

const statusOf = (db: Database.Database, id: string) =>
  (db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;

describe("recoverInterruptedTask — 위임 부모", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("하위 작업 있는 태스크는 checkpoint 없이도 block 안 하고 in_progress 로 resume + goal 동결 해제", () => {
    const { pid, gid } = seed(db, { squash: "blocked" }); // 이전 block 이 얼려둔 goal
    // 부모: in_progress, recovery checkpoint 필드 전무(leaf 로 처리되면 'missing checkpoint' block 대상)
    insTask(db, pid, gid, "parent", "in_progress", null, { recovery_manual_action_required: 1 });
    insTask(db, pid, gid, "child", "todo", "parent");

    const decision = recoverInterruptedTask(db, "parent", "startup");
    expect(decision).toBe("resume");
    expect(statusOf(db, "parent")).toBe("in_progress");
    expect((db.prepare("SELECT recovery_manual_action_required rm FROM tasks WHERE id='parent'").get() as { rm: number }).rm).toBe(0);
    // goal 동결(squash_status='blocked')이 'none' 으로 풀려야 파이프라인이 재개된다
    expect((db.prepare("SELECT squash_status s FROM goals WHERE id=?").get(gid) as { s: string }).s).toBe("none");
  });

  it("하위 작업 없는 leaf 는 기존대로 — checkpoint 없으면 block (회귀 방지)", () => {
    const { pid, gid } = seed(db);
    insTask(db, pid, gid, "leaf", "in_progress", null); // 자식 없음 + checkpoint 없음
    const decision = recoverInterruptedTask(db, "leaf", "startup");
    expect(decision).toBe("blocked");
    expect(statusOf(db, "leaf")).toBe("blocked");
  });
});

describe("resumeBlockedDelegatingParents — 기존 stuck self-heal", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("blocked+manual 위임 부모(미완료 하위 ≥1)를 재개하고 goal 동결을 해제한다", () => {
    const { pid, gid } = seed(db, { squash: "blocked" });
    insTask(db, pid, gid, "parent", "blocked", null, {
      recovery_manual_action_required: 1,
      recovery_manual_action_reason: "worktree HEAD mismatch: expected a, got b",
    });
    insTask(db, pid, gid, "c1", "done", "parent");
    insTask(db, pid, gid, "c2", "todo", "parent"); // 미완료 하위

    expect(resumeBlockedDelegatingParents(db)).toBe(1);
    expect(statusOf(db, "parent")).toBe("in_progress");
    const p = db.prepare("SELECT recovery_manual_action_required rm, recovery_manual_action_reason rr FROM tasks WHERE id='parent'").get() as { rm: number; rr: string | null };
    expect(p.rm).toBe(0);
    expect(p.rr).toBeNull();
    expect((db.prepare("SELECT squash_status s FROM goals WHERE id=?").get(gid) as { s: string }).s).toBe("none");
  });

  it("자식 없는 blocked 태스크(진짜 leaf 차단)는 건드리지 않는다", () => {
    const { pid, gid } = seed(db, { squash: "blocked" });
    insTask(db, pid, gid, "leaf", "blocked", null, { recovery_manual_action_required: 1 });
    expect(resumeBlockedDelegatingParents(db)).toBe(0);
    expect(statusOf(db, "leaf")).toBe("blocked");
  });

  it("하위 작업이 모두 done 인 blocked 부모는 재개 대상 아님(진행할 게 없음)", () => {
    const { pid, gid } = seed(db, { squash: "blocked" });
    insTask(db, pid, gid, "parent", "blocked", null, { recovery_manual_action_required: 1 });
    insTask(db, pid, gid, "c1", "done", "parent");
    expect(resumeBlockedDelegatingParents(db)).toBe(0);
    expect(statusOf(db, "parent")).toBe("blocked");
  });

  it("멱등 — 재개 후 두 번째 호출은 0", () => {
    const { pid, gid } = seed(db, { squash: "blocked" });
    insTask(db, pid, gid, "parent", "blocked", null, { recovery_manual_action_required: 1 });
    insTask(db, pid, gid, "c2", "todo", "parent");
    expect(resumeBlockedDelegatingParents(db)).toBe(1);
    expect(resumeBlockedDelegatingParents(db)).toBe(0);
  });
});
