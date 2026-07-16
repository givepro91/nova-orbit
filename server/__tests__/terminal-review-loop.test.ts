import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import type { VerificationResult, Verdict } from "../../shared/types.js";
import { createDatabase, migrate } from "../db/schema.js";
import {
  listTerminalReviews,
  prepareTerminalReview,
  reconcileInterruptedTerminalReviews,
  runTerminalReview,
  sanitizeTerminalReviewEvidenceText,
} from "../core/terminal/review-loop.js";
import { startNextTerminalTask } from "../core/terminal/session-binding.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  cleanup.splice(0).reverse().forEach((run) => run());
});

function fixture(): Database {
  const dir = mkdtempSync(join(tmpdir(), "crewdeck-terminal-review-"));
  const db = createDatabase(join(dir, "crewdeck.db"));
  migrate(db);
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'Project', 'local_import', ?)").run(dir);
  db.prepare(`
    INSERT INTO agents (id, project_id, name, role, status, current_task_id)
    VALUES ('a1', 'p1', 'Coder', 'coder', 'working', 't1')
  `).run();
  db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Goal', 'Ship it')").run();
  db.prepare(`
    INSERT INTO workspaces (id, project_id, goal_id, active_goal_id, name, state, worktree_path, worktree_branch)
    VALUES ('w1', 'p1', 'g1', 'g1', 'Workspace', 'ready', ?, 'workspace/g1')
  `).run(dir);
  db.prepare(`
    INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status, sort_order, depends_on)
    VALUES ('t1', 'g1', 'p1', 'Implement', 'a1', 'in_progress', 0, '[]')
  `).run();
  db.prepare(`
    INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status, sort_order, depends_on)
    VALUES ('t2', 'g1', 'p1', 'Follow up', 'a1', 'todo', 1, '["t1"]')
  `).run();
  db.prepare(`
    INSERT INTO terminal_sessions (
      id, workspace_id, project_id, shell, cwd, status, goal_id, agent_id, active_task_id
    ) VALUES ('term1', 'w1', 'p1', '/bin/zsh', ?, 'active', 'g1', 'a1', 't1')
  `).run(dir);
  return db;
}

function verification(db: Database, id: string, verdict: Verdict): VerificationResult {
  const issue = verdict === "pass" ? [] : [{
    id: `issue-${id}`,
    severity: "high" as const,
    message: verdict === "conditional" ? "사용자 확인 필요" : "회귀 테스트 실패",
    suggestion: "수정 후 다시 검증하세요",
  }];
  db.prepare(`
    INSERT INTO verifications (id, task_id, verdict, scope, dimensions, issues, severity, termination_reason)
    VALUES (?, 't1', ?, 'standard', '{}', ?, ?, ?)
  `).run(
    id,
    verdict,
    JSON.stringify(issue),
    verdict === "pass" ? "auto-resolve" : "soft-block",
    verdict === "pass" ? "passed" : verdict === "conditional" ? "conditional" : "hard_blocked",
  );
  db.prepare("UPDATE tasks SET verification_id = ? WHERE id = 't1'").run(id);
  return {
    id,
    taskId: "t1",
    verdict,
    scope: "standard",
    dimensions: {
      functionality: { value: verdict === "pass" ? 10 : 0, notes: "fixture" },
      dataFlow: { value: verdict === "pass" ? 10 : 0, notes: "fixture" },
      designAlignment: { value: verdict === "pass" ? 10 : 0, notes: "fixture" },
      craft: { value: verdict === "pass" ? 10 : 0, notes: "fixture" },
      edgeCases: { value: verdict === "pass" ? 10 : 0, notes: "fixture" },
    },
    issues: issue,
    severity: verdict === "pass" ? "auto-resolve" : "soft-block",
    evaluatorSessionId: `evaluator-${id}`,
    terminationReason: verdict === "pass" ? "passed" : verdict === "conditional" ? "conditional" : "hard_blocked",
    createdAt: new Date().toISOString(),
  };
}

describe("terminal Quality Gate review loop", () => {
  it("freezes bounded completion evidence and replays the same request idempotently", () => {
    const db = fixture();
    const first = prepareTerminalReview(db, "term1", {
      summary: "구현과 검증 완료",
      changedFiles: ["server/a.ts", "server/a.ts", "server/b.ts"],
      verificationCommands: ["npm test", "npm run typecheck"],
      idempotencyKey: "completion-1",
    });
    const replay = prepareTerminalReview(db, "term1", {
      summary: "이 값으로 덮어쓰면 안 됨",
      idempotencyKey: "completion-1",
    });

    expect(first.review.evidence).toEqual({
      summary: "구현과 검증 완료",
      changedFiles: ["server/a.ts", "server/b.ts"],
      verificationCommands: ["npm test", "npm run typecheck"],
    });
    expect(replay.review.id).toBe(first.review.id);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.review.evidence.summary).toBe("구현과 검증 완료");
    expect(replay.task.status).toBe("in_review");
    expect(db.prepare(`
      SELECT handoff.stage, handoff.payload, session.origin, session.task_id
        FROM agent_handoffs handoff JOIN sessions session ON session.id = handoff.session_id
    `).get()).toMatchObject({
      stage: "implementation",
      origin: "terminal",
      task_id: "t1",
      payload: expect.stringContaining('"reproduction_commands":["npm test","npm run typecheck"]'),
    });
    expect(() => prepareTerminalReview(db, "term1", { changedFiles: "server/a.ts" }))
      .toThrow("changedFiles must be an array of strings");
  });

  it("redacts credentials before review evidence is persisted", async () => {
    const db = fixture();
    const prepared = prepareTerminalReview(db, "term1", {
      summary: "Authorization: Bearer eyJ.secret",
      changedFiles: ["https://user:password@example.test/private"],
      verificationCommands: ["API_TOKEN=sk-live-secret DATABASE_PASSWORD='hunter2' npm test"],
    });
    expect(prepared.review.evidence).toEqual({
      summary: "Authorization: Bearer [REDACTED]",
      changedFiles: ["https://[REDACTED]@example.test/private"],
      verificationCommands: ["API_TOKEN=[REDACTED] DATABASE_PASSWORD=[REDACTED] npm test"],
    });

    const errored = await runTerminalReview(
      db,
      "term1",
      prepared.review.id,
      async () => { throw new Error("Bearer runtime-secret API_KEY=abc123"); },
    );
    expect(errored.review.errorMessage).toBe("Bearer [REDACTED] API_KEY=[REDACTED]");
    expect(sanitizeTerminalReviewEvidenceText("postgres://admin:pw@db/test"))
      .toBe("postgres://[REDACTED]@db/test");
  });

  it("deduplicates concurrent verify calls and exposes the next ready task after PASS", async () => {
    const db = fixture();
    const prepared = prepareTerminalReview(db, "term1", { summary: "ready" });
    let resolve!: (result: VerificationResult) => void;
    const verifier = vi.fn(() => new Promise<VerificationResult>((done) => { resolve = done; }));

    const firstRun = runTerminalReview(db, "term1", prepared.review.id, verifier);
    await vi.waitFor(() => {
      expect(listTerminalReviews(db, "term1")[0]?.status).toBe("running");
    });
    const duplicate = await runTerminalReview(db, "term1", prepared.review.id, verifier);
    expect(duplicate).toMatchObject({ started: false, stale: false, review: { status: "running" } });
    expect(verifier).toHaveBeenCalledTimes(1);
    const launches: string[] = [];
    const startDuringReview = startNextTerminalTask(db, "term1", {}, (provider) => {
      launches.push(provider);
      return true;
    });
    expect(startDuringReview).toMatchObject({ launchState: "continued", task: { id: "t1", status: "in_review" } });
    expect(launches).toEqual([]);
    expect(db.prepare("SELECT provider FROM terminal_sessions WHERE id = 'term1'").get())
      .toEqual({ provider: null });

    resolve(verification(db, "v-pass", "pass"));
    const completed = await firstRun;
    expect(completed).toMatchObject({
      started: true,
      stale: false,
      review: { status: "passed", verificationId: "v-pass" },
      task: { id: "t1", status: "done", verification_id: "v-pass" },
      nextReadyTask: { id: "t2", status: "todo" },
      hasNextReadyTask: true,
    });
    expect(db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'a1'").get())
      .toEqual({ status: "idle", current_task_id: null });
    expect(db.prepare("SELECT active_task_id FROM terminal_sessions WHERE id = 'term1'").get())
      .toEqual({ active_task_id: "t1" });
  });

  it("returns FAIL to the same terminal for a fix, then accepts a new completion and PASS", async () => {
    const db = fixture();
    const first = prepareTerminalReview(db, "term1", { summary: "first attempt" });
    const failed = await runTerminalReview(
      db,
      "term1",
      first.review.id,
      async () => verification(db, "v-fail", "fail"),
    );

    expect(failed).toMatchObject({
      review: { status: "fix_required", verificationId: "v-fail" },
      task: { status: "in_progress" },
      hasNextReadyTask: false,
    });
    expect(db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'a1'").get())
      .toEqual({ status: "working", current_task_id: "t1" });

    const second = prepareTerminalReview(db, "term1", { summary: "fixed", idempotencyKey: "completion-2" });
    expect(second.review.id).not.toBe(first.review.id);
    const passed = await runTerminalReview(
      db,
      "term1",
      second.review.id,
      async () => verification(db, "v-repass", "pass"),
    );
    expect(passed).toMatchObject({ review: { status: "passed" }, task: { status: "done" } });
  });

  it("keeps CONDITIONAL distinct and requires an explicit retry", async () => {
    const db = fixture();
    const prepared = prepareTerminalReview(db, "term1", { summary: "needs decision" });
    const conditional = await runTerminalReview(
      db,
      "term1",
      prepared.review.id,
      async () => verification(db, "v-conditional", "conditional"),
    );
    expect(conditional).toMatchObject({ review: { status: "conditional" }, task: { status: "in_review" } });
    await expect(runTerminalReview(
      db,
      "term1",
      prepared.review.id,
      async () => verification(db, "never", "pass"),
    )).rejects.toThrow("explicit retry is required");

    const retried = await runTerminalReview(
      db,
      "term1",
      prepared.review.id,
      async () => verification(db, "v-after-decision", "pass"),
      { retry: true },
    );
    expect(retried).toMatchObject({ review: { status: "passed", attempt: 2 }, task: { status: "done" } });
  });

  it("does not let a stale run token overwrite the authoritative verification", async () => {
    const db = fixture();
    const prepared = prepareTerminalReview(db, "term1", { summary: "stale callback" });
    let resolve!: (result: VerificationResult) => void;
    const running = runTerminalReview(
      db,
      "term1",
      prepared.review.id,
      () => new Promise<VerificationResult>((done) => { resolve = done; }),
    );
    await vi.waitFor(() => {
      expect(listTerminalReviews(db, "term1")[0]?.status).toBe("running");
    });

    const current = verification(db, "v-current", "pass");
    db.prepare(`
      UPDATE terminal_review_requests
         SET status = 'passed', run_token = NULL, verification_id = 'v-current', completed_at = datetime('now')
       WHERE id = ?
    `).run(prepared.review.id);
    db.prepare("UPDATE tasks SET status = 'done', verification_id = 'v-current' WHERE id = 't1'").run();
    resolve(verification(db, "v-stale", "pass"));

    const result = await running;
    expect(result.stale).toBe(true);
    expect(result.review.verificationId).toBe(current.id);
    expect(db.prepare("SELECT verification_id FROM tasks WHERE id = 't1'").get())
      .toEqual({ verification_id: "v-current" });
  });

  it("keeps TIMEOUT retryable and discards a late evaluator result", async () => {
    const db = fixture();
    verification(db, "v-before-timeout", "pass");
    const prepared = prepareTerminalReview(db, "term1", { summary: "slow evaluator" });
    let resolve!: (result: VerificationResult) => void;
    const run = runTerminalReview(
      db,
      "term1",
      prepared.review.id,
      () => new Promise<VerificationResult>((done) => { resolve = done; }),
      { timeoutMs: 5 },
    );

    const timedOut = await run;
    expect(timedOut).toMatchObject({
      review: { status: "timeout", attempt: 1 },
      task: { status: "in_review" },
    });
    resolve(verification(db, "v-too-late", "pass"));
    await vi.waitFor(() => {
      expect(db.prepare("SELECT verification_id FROM tasks WHERE id = 't1'").get())
        .toEqual({ verification_id: "v-before-timeout" });
    });
  });

  it("marks an interrupted running review retryable after restart reconciliation", () => {
    const db = fixture();
    const prepared = prepareTerminalReview(db, "term1", { summary: "restart" });
    db.prepare(`
      UPDATE terminal_review_requests SET status = 'running', run_token = 'old-run', attempt = 1 WHERE id = ?
    `).run(prepared.review.id);

    expect(reconcileInterruptedTerminalReviews(db)).toBe(1);
    expect(listTerminalReviews(db, "term1")[0]).toMatchObject({
      status: "error",
      errorMessage: expect.stringContaining("server restart"),
    });
    expect(db.prepare("SELECT status FROM tasks WHERE id = 't1'").get()).toEqual({ status: "in_review" });
    expect(db.prepare("SELECT status FROM agents WHERE id = 'a1'").get()).toEqual({ status: "waiting_approval" });
  });
});
