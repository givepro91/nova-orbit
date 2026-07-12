import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type Database from "better-sqlite3";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createDatabase, migrate } from "../db/schema.js";
import { createGoalRoutes } from "../api/routes/goals.js";
import { createProjectRoutes } from "../api/routes/projects.js";
import { parseStreamJson } from "../core/agent/adapters/stream-parser.js";
import { parseCodexJson } from "../core/agent/adapters/codex-stream-parser.js";

const databases: Database.Database[] = [];

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  databases.push(db);
  return db;
}

async function startApi(db: Database.Database): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  const ctx = { db, broadcast: () => {} } as any;
  app.use("/api/goals", createGoalRoutes(ctx));
  app.use("/api/projects", createProjectRoutes(ctx));
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function seedProjectAndGoal(db: Database.Database, projectId: string, goalId: string, title: string): void {
  db.prepare("INSERT INTO projects (id, name, source) VALUES (?, ?, 'new')")
    .run(projectId, `Project ${projectId}`);
  db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES (?, ?, ?, 'test goal')")
    .run(goalId, projectId, title);
}

function seedRun(db: Database.Database, input: {
  id: string;
  goalId: string;
  versionId: string;
  status: "active" | "completed" | "failed";
  startedAt: string;
  endedAt?: string | null;
}): void {
  db.prepare(`
    INSERT INTO goal_spec_versions (id, goal_id, version, status)
    VALUES (?, ?, 1, 'approved')
  `).run(input.versionId, input.goalId);
  db.prepare(`
    INSERT INTO goal_execution_runs
      (id, goal_id, execution_spec_version_id, status, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.id, input.goalId, input.versionId, input.status, input.startedAt, input.endedAt ?? null);
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try { db.close(); } catch { /* best effort */ }
  }
});

describe("goal execution reports", () => {
  it("run 귀속 기록을 provider·재시도·failover·Quality Gate 기준으로 중복 없이 집계한다", async () => {
    const db = createTestDb();
    seedProjectAndGoal(db, "p1", "g1", "Mixed providers");
    seedRun(db, {
      id: "run1",
      goalId: "g1",
      versionId: "v1",
      status: "completed",
      startedAt: "2026-07-12 01:00:00",
      endedAt: "2026-07-12 01:10:00",
    });
    db.prepare(`
      INSERT INTO goal_execution_runs
        (id, goal_id, execution_spec_version_id, status, started_at, ended_at)
      VALUES ('run-earlier', 'g1', 'v1', 'completed', '2026-07-12 00:50:00', '2026-07-12 00:55:00')
    `).run();
    db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g-other', 'p1', 'Other run', 'test')").run();
    seedRun(db, {
      id: "run-other",
      goalId: "g-other",
      versionId: "v-other",
      status: "completed",
      startedAt: "2026-07-12 00:00:00",
      endedAt: "2026-07-12 00:01:00",
    });
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Claude dev', 'backend')").run();
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a2', 'p1', 'Codex QA', 'qa')").run();
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, status, execution_run_id,
        provider_failover_reason_code, provider_failover_user_message,
        provider_failover_from_provider, provider_failover_to_provider,
        provider_failover_redispatched, provider_failover_original_session_id,
        provider_failover_redispatched_session_id, updated_at
      ) VALUES (
        't1', 'g1', 'p1', 'implementation', 'done', 'run1',
        'rate_limit', 'Claude 한도로 Codex에 재디스패치', 'claude', 'codex', 1,
        's1', 's2', '2026-07-12 01:03:00'
      )
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id)
      VALUES ('qa1', 'g1', 'p1', 'goal QA', 'done', 'run1')
    `).run();
    db.prepare("UPDATE goals SET qa_regression_task_id = 'qa1' WHERE id = 'g1'").run();
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, task_id, execution_run_id, provider, status,
        started_at, ended_at, token_usage, cost_usd,
        provider_failover_reason_code, provider_failover_user_message,
        provider_failover_from_provider, provider_failover_to_provider,
        provider_failover_redispatched, provider_failover_original_session_id,
        provider_failover_redispatched_session_id
      ) VALUES (
        's1', 'a1', 't1', 'run1', 'claude', 'failed',
        '2026-07-12 01:00:10', '2026-07-12 01:02:00', 1200, 0.12,
        'rate_limit', 'Claude 한도로 Codex에 재디스패치', 'claude', 'codex', 1, 's1', 's2'
      )
    `).run();
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, task_id, execution_run_id, provider, status,
        started_at, ended_at, token_usage, cost_usd
      ) VALUES (
        's2', 'a2', 't1', 'run1', 'codex', 'completed',
        '2026-07-12 01:03:00', '2026-07-12 01:05:00', 0, 0
      )
    `).run();
    db.prepare(`
      INSERT INTO verifications (id, task_id, verdict, created_at)
      VALUES ('verify1', 't1', 'fail', '2026-07-12 01:06:00')
    `).run();
    db.prepare(`
      INSERT INTO verification_fix_rounds
        (id, task_id, source_verification_id, round_number, assignee_id, session_id, status, started_at, completed_at)
      VALUES
        ('fix1', 't1', 'verify1', 1, 'a1', 's2', 'completed', '2026-07-12 01:06:10', '2026-07-12 01:07:00')
    `).run();
    db.prepare(`
      INSERT INTO verifications (id, task_id, verdict, created_at)
      VALUES ('verify2', 'qa1', 'pass', '2026-07-12 01:09:00')
    `).run();
    db.prepare(`
      INSERT INTO activities (project_id, type, message, metadata, created_at)
      VALUES
        ('p1', 'task_retry', 'Retry attempt 1', '{"taskId":"t1","executionRunId":"run1","retryCount":1,"reassignCount":0}', '2026-07-12 01:02:30'),
        ('p1', 'task_retry', 'Duplicate retry event', '{"taskId":"t1","executionRunId":"run1","retryCount":1,"reassignCount":0}', '2026-07-12 01:02:31'),
        ('p1', 'task_reassigned', 'Escalated to another agent', '{"taskId":"t1","executionRunId":"run1","reassignCount":1}', '2026-07-12 01:02:32'),
        ('p1', 'task_retry', 'Retry after reassignment', '{"taskId":"t1","executionRunId":"run1","retryCount":1,"reassignCount":1}', '2026-07-12 01:02:33'),
        ('p1', 'task_retry', 'Different execution run', '{"taskId":"t1","executionRunId":"run-other","retryCount":2,"reassignCount":1}', '2026-07-12 01:02:34'),
        ('p1', 'task_retry', 'Other task', '{"taskId":"not-in-goal","attemptId":"1"}', '2026-07-12 01:02:32')
    `).run();

    const api = await startApi(db);
    try {
      const response = await fetch(`${api.baseUrl}/api/goals/g1/execution-report`);
      expect(response.status).toBe(200);
      const report = await response.json() as any;

      expect(report).toMatchObject({
        goalId: "g1",
        title: "Mixed providers",
        finalStatus: "completed",
        startedAt: "2026-07-12T00:50:00.000Z",
        endedAt: "2026-07-12T01:10:00.000Z",
        durationMs: 1_200_000,
        retryCount: 3,
        failoverCount: 1,
        evaluationCount: 2,
        fixRoundCount: 1,
        finalVerdict: "pass",
        telemetry: "partial",
        agentRoles: ["backend", "qa"],
      });
      expect(report.providers).toEqual([
        { provider: "claude", sessionCount: 1, tokens: 1200, costUsd: 0.12 },
        { provider: "codex", sessionCount: 1, tokens: null, costUsd: null },
      ]);
      expect(report.history.filter((entry: any) => entry.kind === "failover")).toHaveLength(1);
      expect(report.history.filter((entry: any) => entry.kind === "retry")).toHaveLength(3);
      expect(report.history.filter((entry: any) => entry.kind === "failure")).toEqual([
        expect.objectContaining({ taskId: "t1", summary: "Agent session failed" }),
      ]);
      expect(report.history.map((entry: any) => entry.occurredAt)).toEqual(
        [...report.history.map((entry: any) => entry.occurredAt)].sort(),
      );

      const listResponse = await fetch(`${api.baseUrl}/api/projects/p1/goal-reports`);
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as any;
      const { agentRoles: _agentRoles, history: _history, ...expectedSummary } = report;
      expect(list.reports.find((entry: any) => entry.goalId === "g1")).toEqual(expectedSummary);
    } finally {
      await api.close();
    }
  });

  it("실제 0 사용량은 보고값으로 유지하고 한 session이라도 미보고면 provider 지표만 null 처리한다", async () => {
    const db = createTestDb();
    seedProjectAndGoal(db, "p1", "g-zero", "Reported zero");
    db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g-mixed', 'p1', 'Mixed telemetry', 'test')").run();
    seedRun(db, {
      id: "run-zero", goalId: "g-zero", versionId: "v-zero", status: "completed",
      startedAt: "2026-07-12 05:00:00", endedAt: "2026-07-12 05:01:00",
    });
    seedRun(db, {
      id: "run-mixed", goalId: "g-mixed", versionId: "v-mixed", status: "completed",
      startedAt: "2026-07-12 06:00:00", endedAt: "2026-07-12 06:01:00",
    });
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Agent', 'backend')").run();
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id) VALUES ('t-zero', 'g-zero', 'p1', 'zero', 'done', 'run-zero')").run();
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id) VALUES ('t-mixed', 'g-mixed', 'p1', 'mixed', 'done', 'run-mixed')").run();
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, task_id, execution_run_id, provider, status, started_at, ended_at,
        token_usage, cost_usd, token_usage_reported, cost_usd_reported
      ) VALUES ('s-zero', 'a1', 't-zero', 'run-zero', 'claude', 'completed',
        '2026-07-12 05:00:10', '2026-07-12 05:00:50', 0, 0, 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO activities (project_id, type, message, metadata, created_at)
      VALUES ('p1', 'task_retry', 'Recorded retry',
        '{"taskId":"t-zero","executionRunId":"run-zero","retryCount":1,"reassignCount":0}',
        '2026-07-12 05:00:30')
    `).run();
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, task_id, execution_run_id, provider, status, started_at, ended_at,
        token_usage, cost_usd, token_usage_reported, cost_usd_reported
      ) VALUES
        ('s-reported', 'a1', 't-mixed', 'run-mixed', 'claude', 'completed',
          '2026-07-12 06:00:10', '2026-07-12 06:00:30', 10, 0.01, 1, 1),
        ('s-unreported', 'a1', 't-mixed', 'run-mixed', 'claude', 'completed',
          '2026-07-12 06:00:31', '2026-07-12 06:00:50', 0, 0, NULL, NULL)
    `).run();

    const api = await startApi(db);
    try {
      const zero = await (await fetch(`${api.baseUrl}/api/goals/g-zero/execution-report`)).json() as any;
      expect(zero.providers).toEqual([{ provider: "claude", sessionCount: 1, tokens: 0, costUsd: 0 }]);
      expect(zero.telemetry).toBe("complete");

      const mixed = await (await fetch(`${api.baseUrl}/api/goals/g-mixed/execution-report`)).json() as any;
      expect(mixed.providers).toEqual([{ provider: "claude", sessionCount: 2, tokens: null, costUsd: null }]);
      expect(mixed.telemetry).toBe("partial");
    } finally {
      await api.close();
    }
  });

  it("빈·부분 usage parser 결과를 provider token 미보고로 집계한다", async () => {
    const db = createTestDb();
    seedProjectAndGoal(db, "p1", "g-parser", "Parser telemetry");
    seedRun(db, {
      id: "run-parser", goalId: "g-parser", versionId: "v-parser", status: "completed",
      startedAt: "2026-07-12 06:00:00", endedAt: "2026-07-12 06:01:00",
    });
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Agent', 'backend')").run();
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id) VALUES ('t-parser', 'g-parser', 'p1', 'parser', 'done', 'run-parser')").run();

    const claudeUsage = parseStreamJson(JSON.stringify({
      type: "result", result: "done", usage: {},
    })).usage!;
    const codexUsage = parseCodexJson(JSON.stringify({
      type: "turn.completed", usage: { input_tokens: 12 },
    })).usage!;
    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, agent_id, task_id, execution_run_id, provider, status,
        token_usage, cost_usd, token_usage_reported, cost_usd_reported
      ) VALUES (?, 'a1', 't-parser', 'run-parser', ?, 'completed', ?, 0, ?, ?)
    `);
    insertSession.run(
      "s-claude", "claude", claudeUsage.inputTokens + claudeUsage.outputTokens,
      claudeUsage.tokenUsageReported ? 1 : 0, claudeUsage.costUsdReported ? 1 : 0,
    );
    insertSession.run(
      "s-codex", "codex", codexUsage.inputTokens + codexUsage.outputTokens,
      codexUsage.tokenUsageReported ? 1 : 0, codexUsage.costUsdReported ? 1 : 0,
    );

    const api = await startApi(db);
    try {
      const report = await (await fetch(`${api.baseUrl}/api/goals/g-parser/execution-report`)).json() as any;
      expect(report.providers).toEqual([
        { provider: "claude", sessionCount: 1, tokens: null, costUsd: null },
        { provider: "codex", sessionCount: 1, tokens: null, costUsd: null },
      ]);
      expect(report.telemetry).toBe("partial");
    } finally {
      await api.close();
    }
  });

  it.each([
    {
      name: "terminal run의 종료 경계가 없을 때",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE goal_execution_runs SET ended_at = NULL WHERE id = 'run1'",
      ).run(),
    },
    {
      name: "session provider가 알 수 없을 때",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE sessions SET provider = NULL WHERE id = 's1'",
      ).run(),
    },
    {
      name: "token reported flag가 없을 때",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE sessions SET token_usage_reported = NULL WHERE id = 's1'",
      ).run(),
    },
    {
      name: "cost reported flag가 없을 때",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE sessions SET cost_usd_reported = NULL WHERE id = 's1'",
      ).run(),
    },
    {
      name: "run이 telemetry watermark 이전 legacy일 때",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE goal_execution_runs SET telemetry_contract_version = NULL WHERE id = 'run1'",
      ).run(),
    },
  ])("$name telemetry를 partial로 강등한다", async ({ mutate }) => {
    const db = createTestDb();
    seedProjectAndGoal(db, "p1", "g1", "Telemetry completeness");
    seedRun(db, {
      id: "run1", goalId: "g1", versionId: "v1", status: "completed",
      startedAt: "2026-07-12 05:00:00", endedAt: "2026-07-12 05:01:00",
    });
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Agent', 'backend')").run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id)
      VALUES ('t1', 'g1', 'p1', 'task', 'done', 'run1')
    `).run();
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, task_id, execution_run_id, provider, status, started_at, ended_at,
        token_usage, cost_usd, token_usage_reported, cost_usd_reported
      ) VALUES (
        's1', 'a1', 't1', 'run1', 'claude', 'completed',
        '2026-07-12 05:00:10', '2026-07-12 05:00:50', 10, 0.01, 1, 1
      )
    `).run();
    mutate(db);

    const api = await startApi(db);
    try {
      const report = await (await fetch(`${api.baseUrl}/api/goals/g1/execution-report`)).json() as any;
      expect(report.telemetry).toBe("partial");
    } finally {
      await api.close();
    }
  });

  it("abnormal killed recovery incident를 실패로 보존하고 정상 killed와 failed 중복을 제외한다", async () => {
    const db = createTestDb();
    seedProjectAndGoal(db, "p1", "g1", "Recovery history");
    seedRun(db, {
      id: "run1", goalId: "g1", versionId: "v1", status: "completed",
      startedAt: "2026-07-12 07:00:00", endedAt: "2026-07-12 07:10:00",
    });
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Agent', 'backend')").run();
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id) VALUES ('t1', 'g1', 'p1', 'task', 'done', 'run1')").run();
    db.prepare(`
      INSERT INTO sessions (id, agent_id, task_id, execution_run_id, provider, status, started_at, ended_at)
      VALUES
        ('s-abnormal', 'a1', 't1', 'run1', 'claude', 'killed', '2026-07-12 07:01:00', '2026-07-12 07:02:00'),
        ('s-normal', 'a1', 't1', 'run1', 'claude', 'killed', '2026-07-12 07:03:00', '2026-07-12 07:04:00'),
        ('s-failed', 'a1', 't1', 'run1', 'claude', 'failed', '2026-07-12 07:05:00', '2026-07-12 07:06:00')
    `).run();
    db.prepare(`
      INSERT INTO recovery_incidents (id, goal_id, phase, decision, reason, created_at)
      VALUES
        ('incident-killed', 'g1', 'implementation', 'resume', 'abnormal session exit', '2026-07-12 07:02:00'),
        ('incident-failed', 'g1', 'verification', 'blocked', 'verification process crashed', '2026-07-12 07:06:00')
    `).run();
    db.prepare(`
      INSERT INTO activities (project_id, type, message, metadata, created_at)
      VALUES
        ('p1', 'recovery_incident', 'abnormal', '{"incident_id":"incident-killed","source":"session_exit","taskId":"t1","sessionId":"s-abnormal"}', '2026-07-12 07:02:00'),
        ('p1', 'recovery_manual_action', 'failed', '{"incident_id":"incident-failed","source":"session_exit","taskId":"t1","sessionId":"s-failed"}', '2026-07-12 07:06:00')
    `).run();

    const api = await startApi(db);
    try {
      const report = await (await fetch(`${api.baseUrl}/api/goals/g1/execution-report`)).json() as any;
      expect(report.history.filter((entry: any) => entry.kind === "failure")).toEqual([
        { kind: "failure", occurredAt: "2026-07-12T07:02:00.000Z", taskId: "t1", summary: "abnormal session exit" },
        { kind: "failure", occurredAt: "2026-07-12T07:06:00.000Z", taskId: "t1", summary: "verification process crashed" },
      ]);
    } finally {
      await api.close();
    }
  });

  it("다른 project/run 기록을 섞지 않고 목록을 시작 시각 내림차순·미실행 뒤로 정렬한다", async () => {
    const db = createTestDb();
    seedProjectAndGoal(db, "p1", "g1", "Older");
    db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g-empty', 'p1', 'Empty', 'none')").run();
    db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g-interrupted', 'p1', 'Interrupted', 'legacy records')").run();
    seedRun(db, {
      id: "run1", goalId: "g1", versionId: "v1", status: "failed",
      startedAt: "2026-07-12 01:00:00", endedAt: "2026-07-12 01:01:00",
    });
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Late agent', 'frontend')").run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id, created_at)
      VALUES ('interrupted-task', 'g-interrupted', 'p1', 'legacy interrupted task', 'blocked', NULL, '2026-07-12 00:20:00')
    `).run();
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, task_id, execution_run_id, provider, status,
        started_at, ended_at, token_usage, cost_usd, token_usage_reported, cost_usd_reported
      ) VALUES (
        'interrupted-session', 'a1', 'interrupted-task', NULL, 'claude', 'failed',
        '2026-07-12 00:20:00', '2026-07-12 00:25:00', 50, 0.01, 1, 1
      )
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id, created_at)
      VALUES ('legacy-task', 'g1', 'p1', 'legacy task', 'done', NULL, '2026-07-12 00:30:00')
    `).run();
    db.prepare(`
      INSERT INTO verifications (id, task_id, verdict, created_at)
      VALUES ('legacy-verification', 'legacy-task', 'fail', '2026-07-12 00:40:00')
    `).run();
    db.prepare(`
      INSERT INTO verification_fix_rounds (
        id, task_id, source_verification_id, round_number, assignee_id,
        status, started_at, created_at
      ) VALUES (
        'late-fix', 'legacy-task', 'legacy-verification', 1, 'a1',
        'pending', '2026-07-12 02:00:00', '2026-07-12 00:50:00'
      )
    `).run();
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id, created_at)
      VALUES ('late-task', 'g1', 'p1', 'created after run', 'done', NULL, '2026-07-12 02:00:00')
    `).run();
    db.prepare(`
      INSERT INTO sessions (
        id, agent_id, task_id, execution_run_id, provider, status,
        started_at, ended_at, token_usage, cost_usd
      ) VALUES (
        'late-session', 'a1', 'late-task', NULL, 'claude', 'completed',
        '2026-07-12 02:00:00', '2026-07-12 02:01:00', 5000, 5
      )
    `).run();
    db.prepare(`
      INSERT INTO verifications (id, task_id, verdict, created_at)
      VALUES ('late-verification', 'late-task', 'pass', '2026-07-12 02:01:00')
    `).run();
    seedProjectAndGoal(db, "p2", "g2", "Other project");
    seedRun(db, {
      id: "run2", goalId: "g2", versionId: "v2", status: "completed",
      startedAt: "2026-07-12 03:00:00", endedAt: "2026-07-12 03:20:00",
    });
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a2', 'p2', 'Other', 'cto')").run();
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, execution_run_id) VALUES ('t2', 'g2', 'p2', 'other', 'done', 'run2')").run();
    db.prepare(`
      INSERT INTO sessions (id, agent_id, task_id, execution_run_id, provider, status, token_usage, cost_usd)
      VALUES ('s2', 'a2', 't2', 'run2', 'claude', 'completed', 9999, 99)
    `).run();

    const api = await startApi(db);
    try {
      const response = await fetch(`${api.baseUrl}/api/projects/p1/goal-reports`);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.reports.map((report: any) => report.goalId)).toEqual(["g1", "g-empty", "g-interrupted"]);
      expect(body.reports[0]).toMatchObject({
        finalStatus: "failed",
        providers: [],
        fixRoundCount: 0,
      });
      expect(body.reports[1]).toMatchObject({
        finalStatus: "interrupted",
        startedAt: null,
        endedAt: null,
        durationMs: null,
        telemetry: "none",
        retryCount: 0,
        failoverCount: 0,
        evaluationCount: 0,
        fixRoundCount: 0,
      });
      expect(body.reports[1]).not.toHaveProperty("history");
      expect(body.reports[1]).not.toHaveProperty("agentRoles");
      expect(body.reports[2]).toMatchObject({
        goalId: "g-interrupted",
        finalStatus: "interrupted",
        startedAt: null,
        endedAt: null,
        durationMs: null,
        telemetry: "partial",
      });

      const detailResponse = await fetch(`${api.baseUrl}/api/goals/g1/execution-report`);
      const detail = await detailResponse.json() as any;
      expect(detail.history.filter((entry: any) => entry.kind === "failure")).toEqual([
        expect.objectContaining({ taskId: null, summary: "Goal execution failed" }),
      ]);
    } finally {
      await api.close();
    }
  });

  it("active run은 종료 시각을 계산하지 않고 없는 project·goal은 404를 반환한다", async () => {
    const db = createTestDb();
    seedProjectAndGoal(db, "p1", "g1", "Running");
    db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g-incomplete', 'p1', 'Incomplete boundary', 'test')").run();
    seedRun(db, {
      id: "run1", goalId: "g1", versionId: "v1", status: "active",
      startedAt: "2026-07-12 04:00:00",
    });
    seedRun(db, {
      id: "run-incomplete", goalId: "g-incomplete", versionId: "v-incomplete", status: "failed",
      startedAt: "2026-07-12 05:00:00",
    });
    const api = await startApi(db);
    try {
      const running = await fetch(`${api.baseUrl}/api/goals/g1/execution-report`);
      expect(await running.json()).toMatchObject({
        finalStatus: "running",
        endedAt: null,
        durationMs: null,
        telemetry: "complete",
      });
      const incomplete = await fetch(`${api.baseUrl}/api/goals/g-incomplete/execution-report`);
      expect(await incomplete.json()).toMatchObject({
        finalStatus: "failed",
        startedAt: "2026-07-12T05:00:00.000Z",
        endedAt: null,
        durationMs: null,
        telemetry: "partial",
      });
      expect((await fetch(`${api.baseUrl}/api/goals/missing/execution-report`)).status).toBe(404);
      expect((await fetch(`${api.baseUrl}/api/projects/missing/goal-reports`)).status).toBe(404);
    } finally {
      await api.close();
    }
  });
});
