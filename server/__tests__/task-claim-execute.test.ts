import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { claimTaskForExecution, createOrchestrationEngine } from "../core/orchestration/engine.js";
import { createSessionManager } from "../core/agent/session.js";
import { makeSpawnFailedError } from "../utils/errors.js";
import { approveSpecVersion, beginExecutionRun, getExecutionSpec, getSpecState, getTaskExecutionSpec, saveSpecDraft } from "../core/goal-spec/spec-approval.js";
import type Database from "better-sqlite3";
import { createAgentHandoff } from "../core/agent/handoff.js";
import { saveAgentHandoff } from "../core/agent/handoff-store.js";
import { AgentHandoffConsumptionError } from "../core/agent/handoff-consumer.js";

/**
 * task claim + execute 계약 회귀 테스트.
 *
 * 두 회귀를 고정한다:
 *  1. in_progress 태스크 claim 은 conflict + status='in_progress' 로 실패한다
 *     (route 의 409 계약을 구동 — assignee 유무와 무관).
 *  2. claim 성공 후 setup 오류(존재하지 않는 workdir)가 나면 태스크가
 *     in_progress 에 방치되지 않고 blocked 로 해제된다.
 */

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

let seq = 0;

function seedProject(db: Database.Database, workdir: string | null): { projectId: string; agentId: string } {
  const projectId = `p${++seq}`;
  db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES (?, 'test', 'new', ?)").run(projectId, workdir);
  const agentId = `a${seq}`;
  db.prepare(
    "INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'dev', 'backend')",
  ).run(agentId, projectId);
  return { projectId, agentId };
}

function seedGoal(db: Database.Database, projectId: string): string {
  const goalId = `g${++seq}`;
  db.prepare(
    "INSERT INTO goals (id, project_id, description, priority, sort_order) VALUES (?, ?, 'goal', 'medium', 0)",
  ).run(goalId, projectId);
  return goalId;
}

function seedTask(
  db: Database.Database,
  goalId: string,
  projectId: string,
  status: string,
  assigneeId: string | null,
): string {
  const taskId = `t${++seq}`;
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id) VALUES (?, ?, ?, 'task', ?, ?)",
  ).run(taskId, goalId, projectId, status, assigneeId);
  return taskId;
}

function seedDecomposeHandoff(db: Database.Database, goalId: string, agentId: string): void {
  const sessionId = `decompose-${goalId}`;
  db.prepare("INSERT INTO sessions (id, agent_id, task_id, status) VALUES (?, ?, NULL, 'completed')")
    .run(sessionId, agentId);
  saveAgentHandoff(db, {
    goalId,
    taskId: null,
    sessionId,
    handoff: createAgentHandoff({ stage: "decompose" }),
  });
}

describe("claimTaskForExecution", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("todo 태스크를 claim 한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(true);
    expect(claim.taskId).toBe(taskId);
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).toBe("in_progress");
  });

  it("이미 in_progress 인 태스크는 conflict + status 로 거절한다 (assignee=NULL 이어도)", () => {
    // route 의 409 계약: assignee 선검사가 아니라 conflict 가 이겨야 한다.
    const { projectId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "in_progress", null);

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("unreachable");
    expect(claim.reason).toBe("conflict");
    expect(claim.status).toBe("in_progress");
  });

  it("존재하지 않는 태스크는 not_found 로 거절한다", () => {
    const claim = claimTaskForExecution(db, "nope");
    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("unreachable");
    expect(claim.reason).toBe("not_found");
  });

  it("승인 필수 goal의 미승인 태스크는 상태 변경 없이 거절한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);

    const claim = claimTaskForExecution(db, taskId);

    expect(claim).toMatchObject({
      claimed: false,
      taskId,
      reason: "spec_not_approved",
      status: "todo",
      specStatus: "missing",
      currentDraftVersion: null,
    });
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).toBe("todo");
  });

  it("실행 중 spec 수정은 기존 in_progress claim의 conflict 계약을 바꾸지 않는다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    const approved = saveSpecDraft(db, goalId, {
      scope: "approved",
      out_of_scope: "none",
      acceptance_criteria: ["pass"],
      expected_tasks: ["implement"],
      verification_methods: ["test"],
    });
    approveSpecVersion(db, goalId, approved.id);
    const taskId = seedTask(db, goalId, projectId, "in_progress", agentId);
    saveSpecDraft(db, goalId, {
      scope: "next run",
      out_of_scope: "none",
      acceptance_criteria: ["pass next"],
      expected_tasks: ["implement next"],
      verification_methods: ["test next"],
    });

    const claim = claimTaskForExecution(db, taskId);

    expect(claim).toMatchObject({
      claimed: false,
      reason: "conflict",
      status: "in_progress",
    });
    expect(db.prepare("SELECT execution_spec_version_id FROM goals WHERE id = ?").get(goalId))
      .toEqual({ execution_spec_version_id: approved.id });
  });

  it("실행 중 draft 저장 후 t1 완료돼도 다음 순차 task는 고정된 승인 version으로 claim 성공한다", () => {
    // Goal 실행 run 은 첫 claim 에서 승인 version 을 고정하고, 실행 중 draft/재승인은
    // 그 run 의 pin 을 바꾸지 않는다. 순차 task 사이에 draft 가 저장돼도 다음 task 는
    // 같은 승인 snapshot 으로 계속 실행돼야 한다.
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    const t1 = seedTask(db, goalId, projectId, "todo", agentId);
    const t2 = seedTask(db, goalId, projectId, "todo", agentId);

    const v1 = saveSpecDraft(db, goalId, {
      scope: "run scope v1",
      out_of_scope: "none",
      acceptance_criteria: ["v1 acceptance"],
      expected_tasks: ["v1 task"],
      verification_methods: ["v1 test"],
    });
    approveSpecVersion(db, goalId, v1.id);

    // 첫 claim = run 시작 → v1 고정.
    expect(claimTaskForExecution(db, t1).claimed).toBe(true);

    // 실행 중 다음 실행용 draft v2 저장.
    const v2 = saveSpecDraft(db, goalId, {
      scope: "run scope v2",
      out_of_scope: "none",
      acceptance_criteria: ["v2 acceptance"],
      expected_tasks: ["v2 task"],
      verification_methods: ["v2 test"],
    });
    expect(v2.version).toBe(2);

    // 현재 in_progress task 완료.
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t1);

    // 같은 run 의 다음 순차 task claim 성공 — v2 draft 가 막지 않는다.
    const claim = claimTaskForExecution(db, t2);
    expect(claim.claimed).toBe(true);

    // pin 은 여전히 v1, 모든 실행 단계가 참조하는 execution spec 도 v1 로 유지된다.
    expect(db.prepare("SELECT execution_spec_version_id FROM goals WHERE id = ?").get(goalId))
      .toEqual({ execution_spec_version_id: v1.id });
    expect(getExecutionSpec(db, goalId)).toMatchObject({ id: v1.id, version: 1, scope: "run scope v1" });
  });

  it("실행 중 다른 version 승인은 활성 run의 고정 version을 바꾸지 않는다", () => {
    // approveSpecVersion 이 실행 중에 포인터를 옮기면 한 run 이 서로 다른 spec version 을
    // 쓰게 된다. 활성 run 진행 중 재승인은 pin 을 유지해야 한다.
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    const t1 = seedTask(db, goalId, projectId, "todo", agentId);

    const v1 = saveSpecDraft(db, goalId, {
      scope: "run scope v1",
      out_of_scope: "none",
      acceptance_criteria: ["v1 acceptance"],
      expected_tasks: ["v1 task"],
      verification_methods: ["v1 test"],
    });
    approveSpecVersion(db, goalId, v1.id);
    expect(claimTaskForExecution(db, t1).claimed).toBe(true);

    const v2 = saveSpecDraft(db, goalId, {
      scope: "run scope v2",
      out_of_scope: "none",
      acceptance_criteria: ["v2 acceptance"],
      expected_tasks: ["v2 task"],
      verification_methods: ["v2 test"],
    });
    approveSpecVersion(db, goalId, v2.id);

    // 실행 중 v2 승인에도 pin 은 v1 로 유지된다.
    expect(db.prepare("SELECT execution_spec_version_id FROM goals WHERE id = ?").get(goalId))
      .toEqual({ execution_spec_version_id: v1.id });
    expect(getExecutionSpec(db, goalId)).toMatchObject({ id: v1.id, version: 1 });
  });

  it("실행 중 승인한 최신 version은 run 종료 후 다음 실행 기준으로 승계한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    const t1 = seedTask(db, goalId, projectId, "todo", agentId);

    const v1 = saveSpecDraft(db, goalId, {
      scope: "run scope v1",
      out_of_scope: "none",
      acceptance_criteria: ["v1 acceptance"],
      expected_tasks: ["v1 task"],
      verification_methods: ["v1 test"],
    });
    approveSpecVersion(db, goalId, v1.id);
    expect(claimTaskForExecution(db, t1).claimed).toBe(true);

    const v2 = saveSpecDraft(db, goalId, {
      scope: "next run scope v2",
      out_of_scope: "none",
      acceptance_criteria: ["v2 acceptance"],
      expected_tasks: ["v2 task"],
      verification_methods: ["v2 test"],
    });
    approveSpecVersion(db, goalId, v2.id);

    expect(db.prepare(`
      SELECT execution_spec_version_id, pending_execution_spec_version_id
      FROM goals WHERE id = ?
    `).get(goalId)).toEqual({
      execution_spec_version_id: v1.id,
      pending_execution_spec_version_id: v2.id,
    });

    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t1);
    expect(getSpecState(db, goalId)).toMatchObject({
      status: "approved",
      execution_spec_version_id: v2.id,
    });
    expect(db.prepare(`
      SELECT active_execution_run_id, execution_spec_version_id, pending_execution_spec_version_id
      FROM goals WHERE id = ?
    `).get(goalId)).toEqual({
      active_execution_run_id: null,
      execution_spec_version_id: v2.id,
      pending_execution_spec_version_id: null,
    });

    const t2 = seedTask(db, goalId, projectId, "todo", agentId);
    expect(claimTaskForExecution(db, t2).claimed).toBe(true);
  });

  it("decompose run은 마지막 구현 task가 아니라 QA regression 완료 후 닫힌다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    const v1 = saveSpecDraft(db, goalId, {
      scope: "v1",
      out_of_scope: "none",
      acceptance_criteria: ["v1 acceptance"],
      expected_tasks: ["v1 task"],
      verification_methods: ["v1 test"],
    });
    approveSpecVersion(db, goalId, v1.id);
    const run = beginExecutionRun(db, goalId, "decompose");
    expect(run).not.toBeNull();
    if (!run) throw new Error("execution run was not created");
    const implementationTaskId = seedTask(db, goalId, projectId, "in_progress", agentId);

    const v2 = saveSpecDraft(db, goalId, {
      scope: "v2",
      out_of_scope: "none",
      acceptance_criteria: ["v2 acceptance"],
      expected_tasks: ["v2 task"],
      verification_methods: ["v2 test"],
    });
    approveSpecVersion(db, goalId, v2.id);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(implementationTaskId);

    expect(db.prepare(`
      SELECT active_execution_run_id, execution_spec_version_id
      FROM goals WHERE id = ?
    `).get(goalId)).toEqual({
      active_execution_run_id: run.id,
      execution_spec_version_id: v1.id,
    });

    const qaTaskId = seedTask(db, goalId, projectId, "in_progress", agentId);
    db.prepare("UPDATE goals SET qa_regression_task_id = ? WHERE id = ?").run(qaTaskId, goalId);
    expect(db.prepare(`
      SELECT execution_run_id, execution_spec_version_id FROM tasks WHERE id = ?
    `).get(qaTaskId)).toEqual({
      execution_run_id: run.id,
      execution_spec_version_id: v1.id,
    });

    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(qaTaskId);
    expect(db.prepare(`
      SELECT active_execution_run_id, execution_spec_version_id
      FROM goals WHERE id = ?
    `).get(goalId)).toEqual({
      active_execution_run_id: null,
      execution_spec_version_id: v2.id,
    });
    expect(db.prepare("SELECT status FROM goal_execution_runs WHERE id = ?").get(run.id))
      .toEqual({ status: "completed" });
  });

  it("실행 중 승인본 뒤 최신 draft가 생기면 run 종료 시 승인본을 승계하지 않는다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    const t1 = seedTask(db, goalId, projectId, "todo", agentId);

    const v1 = saveSpecDraft(db, goalId, {
      scope: "run scope v1",
      out_of_scope: "none",
      acceptance_criteria: ["v1 acceptance"],
      expected_tasks: ["v1 task"],
      verification_methods: ["v1 test"],
    });
    approveSpecVersion(db, goalId, v1.id);
    expect(claimTaskForExecution(db, t1).claimed).toBe(true);

    const v2 = saveSpecDraft(db, goalId, {
      scope: "approved next run scope v2",
      out_of_scope: "none",
      acceptance_criteria: ["v2 acceptance"],
      expected_tasks: ["v2 task"],
      verification_methods: ["v2 test"],
    });
    approveSpecVersion(db, goalId, v2.id);
    saveSpecDraft(db, goalId, {
      scope: "unapproved latest scope v3",
      out_of_scope: "none",
      acceptance_criteria: ["v3 acceptance"],
      expected_tasks: ["v3 task"],
      verification_methods: ["v3 test"],
    });

    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t1);
    expect(getSpecState(db, goalId)).toMatchObject({
      status: "changes_pending",
      execution_spec_version_id: v1.id,
    });
    expect(db.prepare("SELECT pending_execution_spec_version_id FROM goals WHERE id = ?").get(goalId))
      .toEqual({ pending_execution_spec_version_id: null });

    const t2 = seedTask(db, goalId, projectId, "todo", agentId);
    expect(claimTaskForExecution(db, t2)).toMatchObject({
      claimed: false,
      reason: "spec_not_approved",
      specStatus: "changes_pending",
    });
  });

  it("완료된 과거 run의 done task와 신규 todo task를 활성 run으로 결합하지 않는다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    const oldTaskId = seedTask(db, goalId, projectId, "todo", agentId);
    const v1 = saveSpecDraft(db, goalId, {
      scope: "v1",
      out_of_scope: "none",
      acceptance_criteria: ["ok"],
      expected_tasks: ["work"],
      verification_methods: ["test"],
    });
    approveSpecVersion(db, goalId, v1.id);

    expect(claimTaskForExecution(db, oldTaskId).claimed).toBe(true);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(oldTaskId);
    const newTaskId = seedTask(db, goalId, projectId, "todo", agentId);
    saveSpecDraft(db, goalId, {
      scope: "v2 unapproved",
      out_of_scope: "none",
      acceptance_criteria: ["ok"],
      expected_tasks: ["work"],
      verification_methods: ["test"],
    });

    expect(claimTaskForExecution(db, newTaskId)).toMatchObject({
      claimed: false,
      reason: "spec_not_approved",
      specStatus: "changes_pending",
    });
    expect(db.prepare("SELECT active_execution_run_id, execution_spec_version_id FROM goals WHERE id = ?").get(goalId))
      .toEqual({ active_execution_run_id: null, execution_spec_version_id: null });
  });

  it("과거 run의 v1 task를 현재 승인본 v2 실행으로 claim하지 않는다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);

    const v1 = saveSpecDraft(db, goalId, {
      scope: "v1",
      out_of_scope: "none",
      acceptance_criteria: ["v1 accepted"],
      expected_tasks: ["v1 task"],
      verification_methods: ["v1 test"],
    });
    approveSpecVersion(db, goalId, v1.id);
    const staleTaskId = seedTask(db, goalId, projectId, "todo", agentId);
    expect(claimTaskForExecution(db, staleTaskId).claimed).toBe(true);
    const staleRunId = (db.prepare(
      "SELECT execution_run_id FROM tasks WHERE id = ?",
    ).get(staleTaskId) as { execution_run_id: string }).execution_run_id;
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(staleTaskId);

    const v2 = saveSpecDraft(db, goalId, {
      scope: "v2",
      out_of_scope: "none",
      acceptance_criteria: ["v2 accepted"],
      expected_tasks: ["v2 task"],
      verification_methods: ["v2 test"],
    });
    approveSpecVersion(db, goalId, v2.id);
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(staleTaskId);

    expect(claimTaskForExecution(db, staleTaskId)).toMatchObject({
      claimed: false,
      reason: "conflict",
      status: "todo",
      error: "Task belongs to a previous execution run and must be re-decomposed",
    });
    expect(db.prepare(`
      SELECT status, execution_run_id, execution_spec_version_id
      FROM tasks WHERE id = ?
    `).get(staleTaskId)).toEqual({
      status: "todo",
      execution_run_id: staleRunId,
      execution_spec_version_id: v1.id,
    });
    expect(db.prepare(`
      SELECT active_execution_run_id, execution_spec_version_id
      FROM goals WHERE id = ?
    `).get(goalId)).toEqual({
      active_execution_run_id: null,
      execution_spec_version_id: v2.id,
    });
  });

  it("task version 복사본이 누락돼도 claim을 거절하고 조회는 run 고정본을 사용한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    const v1 = saveSpecDraft(db, goalId, {
      scope: "run-v1",
      out_of_scope: "none",
      acceptance_criteria: ["v1 accepted"],
      expected_tasks: ["v1 task"],
      verification_methods: ["v1 test"],
    });
    approveSpecVersion(db, goalId, v1.id);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);
    const run = beginExecutionRun(db, goalId, "decompose");
    const v2 = saveSpecDraft(db, goalId, {
      scope: "run-v2",
      out_of_scope: "none",
      acceptance_criteria: ["v2 accepted"],
      expected_tasks: ["v2 task"],
      verification_methods: ["v2 test"],
    });
    approveSpecVersion(db, goalId, v2.id);
    db.prepare("UPDATE tasks SET execution_spec_version_id = NULL WHERE id = ?").run(taskId);

    expect(run?.executionSpecVersionId).toBe(v1.id);
    expect(getTaskExecutionSpec(db, taskId)).toMatchObject({ id: v1.id, scope: "run-v1" });
    expect(claimTaskForExecution(db, taskId)).toMatchObject({
      claimed: false,
      reason: "conflict",
      status: "todo",
      error: "Task spec version differs from its execution run and must be re-decomposed",
    });
  });

  it("retry budget이 남은 blocked→todo 전환 중에는 active run·pin·execution_run_id를 유지하고 재claim이 성공한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    const t1 = seedTask(db, goalId, projectId, "todo", agentId);

    const v1 = saveSpecDraft(db, goalId, {
      scope: "run scope v1",
      out_of_scope: "none",
      acceptance_criteria: ["v1 acceptance"],
      expected_tasks: ["v1 task"],
      verification_methods: ["v1 test"],
    });
    approveSpecVersion(db, goalId, v1.id);
    expect(claimTaskForExecution(db, t1).claimed).toBe(true);

    const runId = (db.prepare("SELECT active_execution_run_id AS r FROM goals WHERE id = ?").get(goalId) as { r: string }).r;
    expect(runId).not.toBeNull();

    // 실행 중 미승인 v2 draft 저장 — active run 진행 중이므로 pin(v1)은 흔들지 않는다.
    saveSpecDraft(db, goalId, {
      scope: "next run scope v2",
      out_of_scope: "none",
      acceptance_criteria: ["v2 acceptance"],
      expected_tasks: ["v2 task"],
      verification_methods: ["v2 test"],
    });

    // 유일한 task가 일시적으로 blocked — run 이 조기 종료되면 안 된다.
    db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = ?").run(t1);
    expect(db.prepare("SELECT active_execution_run_id AS r FROM goals WHERE id = ?").get(goalId))
      .toEqual({ r: runId });
    expect(db.prepare("SELECT execution_spec_version_id AS v FROM goals WHERE id = ?").get(goalId))
      .toEqual({ v: v1.id });
    expect(db.prepare("SELECT execution_run_id AS r FROM tasks WHERE id = ?").get(t1))
      .toEqual({ r: runId });

    // scheduler retry 와 동일하게 blocked→todo 복구. retryBlockedTasks 는 cooldown(≥10s)
    // 뒤에 재시도하므로 원래 claim 의 started_at 은 5s settling 창을 이미 지난다 — 그 경과를
    // 재현하려 started_at 을 과거로 당긴다(안 그러면 자기 started_at 이 settling 가드를 튕긴다).
    db.prepare(
      "UPDATE tasks SET status = 'todo', retry_count = retry_count + 1, started_at = datetime('now', '-30 seconds') WHERE id = ?",
    ).run(t1);
    expect(db.prepare("SELECT active_execution_run_id AS r FROM goals WHERE id = ?").get(goalId))
      .toEqual({ r: runId });
    expect(db.prepare("SELECT execution_spec_version_id AS v FROM goals WHERE id = ?").get(goalId))
      .toEqual({ v: v1.id });
    expect(db.prepare("SELECT execution_run_id AS r FROM tasks WHERE id = ?").get(t1))
      .toEqual({ r: runId });

    // 재claim 은 기존 run 소속이므로 성공한다.
    expect(claimTaskForExecution(db, t1).claimed).toBe(true);

    // 기존 실행이 실제 종료(done)된 뒤에야 미승인 v2가 신규 실행 재승인을 요구한다.
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(t1);
    expect(db.prepare("SELECT active_execution_run_id AS r FROM goals WHERE id = ?").get(goalId))
      .toEqual({ r: null });
    const t2 = seedTask(db, goalId, projectId, "todo", agentId);
    expect(claimTaskForExecution(db, t2)).toMatchObject({
      claimed: false,
      reason: "spec_not_approved",
      specStatus: "changes_pending",
    });
  });

  it("다른 goal이라도 동일 agent가 실행 중이면 claim을 거절한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const activeGoalId = seedGoal(db, projectId);
    const candidateGoalId = seedGoal(db, projectId);
    const activeTaskId = seedTask(db, activeGoalId, projectId, "in_progress", agentId);
    const candidateTaskId = seedTask(db, candidateGoalId, projectId, "todo", agentId);

    const claim = claimTaskForExecution(db, candidateTaskId);

    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("unreachable");
    expect(claim.reason).toBe("conflict");
    expect(claim.error).toBe(`Agent already has an active task (${activeTaskId})`);
    expect(claim.status).toBe("todo");

    const rows = db.prepare(
      "SELECT id, status FROM tasks WHERE id IN (?, ?) ORDER BY id",
    ).all(activeTaskId, candidateTaskId) as { id: string; status: string }[];
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [activeTaskId]: "in_progress",
      [candidateTaskId]: "todo",
    });
  });
  it("해제된 claim의 settle lease가 유효한 동안 중복 claim을 거절한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);
    db.prepare(`
      UPDATE tasks SET started_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE id = ?
    `).run(taskId);

    const claim = claimTaskForExecution(db, taskId);

    expect(claim).toMatchObject({
      claimed: false,
      reason: "conflict",
      status: "todo",
    });
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId))
      .toEqual({ status: "todo" });
  });

  it("stale settle lease는 회수해 같은 task를 1회만 claim한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);
    db.prepare(`
      UPDATE tasks SET started_at = datetime('now', '-6 seconds')
      WHERE id = ?
    `).run(taskId);

    const first = claimTaskForExecution(db, taskId);
    const duplicate = claimTaskForExecution(db, taskId);

    expect(first).toEqual({ claimed: true, taskId });
    expect(duplicate).toMatchObject({
      claimed: false,
      reason: "conflict",
      status: "in_progress",
    });
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId))
      .toEqual({ status: "in_progress" });
  });
});

describe("executeTask — claim 해제", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("claim 성공 후 workdir 부재 오류가 나면 태스크를 in_progress 에 방치하지 않고 blocked 로 해제한다", async () => {
    const missingWorkdir = "/nonexistent/crewdeck-test-workdir-does-not-exist";
    const { projectId, agentId } = seedProject(db, missingWorkdir);
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);

    const sessionManager = createSessionManager(db);
    const engine = createOrchestrationEngine(db, sessionManager, () => {});

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");

    await expect(engine.executeTask(taskId, {}, claim)).rejects.toThrow(/Working directory does not exist/);

    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).not.toBe("in_progress");
    expect(row.status).toBe("blocked");
  });

  it("decompose handoff가 없으면 delegation·implementation subprocess spawn 전에 차단한다", async () => {
    const { projectId, agentId } = seedProject(db, process.cwd());
    db.prepare("UPDATE agents SET needs_worktree = 0 WHERE id = ?").run(agentId);
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);
    const baseSessionManager = createSessionManager(db);
    const spawnAgent = vi.fn(baseSessionManager.spawnAgent);
    const engine = createOrchestrationEngine(db, { ...baseSessionManager, spawnAgent }, () => {});
    const claim = claimTaskForExecution(db, taskId);
    if (!claim.claimed) throw new Error("unreachable");

    await expect(engine.executeTask(taskId, {}, claim))
      .rejects.toBeInstanceOf(AgentHandoffConsumptionError);

    expect(spawnAgent).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId))
      .toEqual({ status: "blocked" });
    expect(db.prepare(`
      SELECT status, pid FROM sessions WHERE task_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(taskId)).toEqual({ status: "failed", pid: null });
  });

  it("claim 성공 후 session spawn 오류가 나면 태스크를 in_progress 에 방치하지 않고 blocked 로 해제한다", async () => {
    const { projectId, agentId } = seedProject(db, process.cwd());
    db.prepare("UPDATE agents SET needs_worktree = 0 WHERE id = ?").run(agentId);
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);
    seedDecomposeHandoff(db, goalId, agentId);

    const baseSessionManager = createSessionManager(db);
    const spawnAgent = vi.fn(() => {
      throw new Error("synthetic spawn failure");
    });
    const engine = createOrchestrationEngine(
      db,
      { ...baseSessionManager, spawnAgent },
      () => {},
    );

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");

    await expect(engine.executeTask(taskId, {}, claim)).rejects.toThrow(
      /Agent spawn failed: synthetic spawn failure/,
    );

    expect(spawnAgent).toHaveBeenCalledOnce();
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).not.toBe("in_progress");
    expect(row.status).toBe("blocked");
  });

  it("session spawn AgentError의 code·detail을 보존하고 env_error는 todo로 해제한다", async () => {
    const { projectId, agentId } = seedProject(db, process.cwd());
    db.prepare("UPDATE agents SET needs_worktree = 0 WHERE id = ?").run(agentId);
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);
    seedDecomposeHandoff(db, goalId, agentId);
    const spawnError = makeSpawnFailedError("codex not installed");

    const baseSessionManager = createSessionManager(db);
    const engine = createOrchestrationEngine(
      db,
      { ...baseSessionManager, spawnAgent: vi.fn(() => { throw spawnError; }) },
      () => {},
    );

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");

    await expect(engine.executeTask(taskId, {}, claim)).rejects.toBe(spawnError);
    expect(spawnError.code).toBe("SPAWN_FAILED");
    expect(spawnError.detail).toBe("codex not installed");

    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).toBe("todo");
  });
});
