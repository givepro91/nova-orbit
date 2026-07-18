import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDatabase, migrate } from "../db/schema.js";
import { createVerificationRoutes } from "../api/routes/verification.js";
import { createGoalRoutes } from "../api/routes/goals.js";
import { createFixTasksFromVerification } from "../core/orchestration/engine.js";
import type Database from "better-sqlite3";

/**
 * POST /api/verifications가 verification/task/activity 저장 + WebSocket 발행을
 * transaction/outbox 없이 순차 실행하던 버그의 회귀 테스트. activities INSERT가
 * 실패해도 이미 실행된 verifications INSERT가 커밋된 채로 남아 있었다
 * (HTTP 500이면서 verificationCount:1, activityCount:0인 부분 저장 상태).
 */

const dbs: Database.Database[] = [];

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  dbs.push(db);
  return db;
}

function seedTask(db: Database.Database): string {
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'test', 'new')").run();
  db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'goal')").run();
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'dev', 'coder')").run();
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id) VALUES ('t1', 'g1', 'p1', 'task', 'in_review', 'a1')",
  ).run();
  return "t1";
}

async function startVerificationApi(
  db: Database.Database,
  broadcast: (event: string, data: unknown) => number | void = () => {},
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  const ctx = { db, wss: {} as any, broadcast } as any;
  app.use("/api/verifications", createVerificationRoutes(ctx));
  app.use("/api/goals", createGoalRoutes(ctx));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch { /* best effort */ }
  }
});

describe("POST /api/verifications — 원자성", () => {
  it("activities insert가 실패하면 verification도 저장되지 않는다", async () => {
    const db = createTestDb();
    const taskId = seedTask(db);
    db.exec(`
      CREATE TRIGGER fail_activities_insert
      BEFORE INSERT ON activities
      BEGIN
        SELECT RAISE(ABORT, 'boom - forced activities insert failure');
      END;
    `);

    const api = await startVerificationApi(db);
    try {
      const res = await fetch(`${api.baseUrl}/api/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_id: taskId, verdict: "pass" }),
      });
      expect(res.status).toBe(500);

      const verificationCount = (db.prepare(
        "SELECT COUNT(*) AS count FROM verifications WHERE task_id = ?",
      ).get(taskId) as { count: number }).count;
      const activityCount = (db.prepare("SELECT COUNT(*) AS count FROM activities").get() as { count: number }).count;
      expect(verificationCount).toBe(0);
      expect(activityCount).toBe(0);
    } finally {
      await api.close();
    }
  });

  it("정상 경로에서는 verification/activity가 함께 저장되고 outbox로 발행된다", async () => {
    const db = createTestDb();
    const taskId = seedTask(db);
    const delivered: Array<{ event: string; payload: any }> = [];

    const api = await startVerificationApi(db, (event, payload) => {
      delivered.push({ event, payload });
      return 1;
    });
    try {
      const res = await fetch(`${api.baseUrl}/api/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task_id: taskId, verdict: "pass" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.task_id).toBe(taskId);
      expect(body.verdict).toBe("pass");

      const verificationCount = (db.prepare(
        "SELECT COUNT(*) AS count FROM verifications WHERE task_id = ?",
      ).get(taskId) as { count: number }).count;
      const activityCount = (db.prepare(
        "SELECT COUNT(*) AS count FROM activities WHERE type = 'verification_pass'",
      ).get() as { count: number }).count;
      expect(verificationCount).toBe(1);
      expect(activityCount).toBe(1);

      expect(delivered).toEqual([{ event: "verification:result", payload: expect.objectContaining({ task_id: taskId, verdict: "pass" }) }]);

      const outboxRow = db.prepare(
        "SELECT delivered_at FROM verification_broadcast_outbox WHERE verification_id = ?",
      ).get(body.id) as { delivered_at: string | null } | undefined;
      expect(outboxRow?.delivered_at).not.toBeNull();
    } finally {
      await api.close();
    }
  });

  it("구조화 issue와 implementation session이 timeline에 보존된다", async () => {
    const db = createTestDb();
    const taskId = seedTask(db);
    const api = await startVerificationApi(db, () => 1);

    try {
      const res = await fetch(`${api.baseUrl}/api/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          verdict: "fail",
          implementation_session_id: "implementation-session-1",
          dimensions: {
            functionality: { value: 3, notes: "repro fails" },
          },
          issues: [{
            dimension: "functionality",
            severity: "high",
            message: "public route issue",
            reproCommand: "npm test -- public-route",
            expectedResult: "pass",
            actualResult: "fail",
            fixInstruction: "fix public route",
          }],
        }),
      });
      expect(res.status).toBe(201);

      const timelineRes = await fetch(`${api.baseUrl}/api/goals/g1/verification-timeline`);
      expect(timelineRes.status).toBe(200);
      const timeline = await timelineRes.json() as any;
      expect(timeline.rounds).toHaveLength(1);
      expect(timeline.rounds[0]).toMatchObject({
        implementation_session_id: "implementation-session-1",
        dimensions: expect.arrayContaining([
          expect.objectContaining({ dimension: "functionality", score: 3, rationale: "repro fails" }),
        ]),
        issues: [expect.objectContaining({
          dimension: "functionality",
          severity: "high",
          evidence: "public route issue",
          repro_command: "npm test -- public-route",
          expected_result: "pass",
          actual_result: "fail",
          fix_instruction: "fix public route",
          assignee_id: "a1",
        })],
      });
    } finally {
      await api.close();
    }
  });

  it("실패 verification의 issue 3개를 각각 fix task로 변환하고 구조화 prompt와 link를 누락 없이 저장한다", async () => {
    const db = createTestDb();
    const taskId = seedTask(db);
    const api = await startVerificationApi(db, () => 1);
    const dimensions = ["functionality", "dataFlow", "craft"];
    const evidences = ["evidence-0", "evidence-1", "e".repeat(2_100)];

    try {
      const verificationRes = await fetch(`${api.baseUrl}/api/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          verdict: "fail",
          issues: dimensions.map((dimension, index) => ({
            dimension,
            severity: index === 0 ? "critical" : index === 1 ? "high" : "warning",
            message: evidences[index],
            reproCommand: `npm test -- issue-${index}`,
            expectedResult: `expected-${index}`,
            actualResult: `actual-${index}`,
            fixInstruction: `fix-${index}`,
          })),
        }),
      });
      expect(verificationRes.status).toBe(201);
      const verification = await verificationRes.json() as { id: string };

      const fixRes = await fetch(`${api.baseUrl}/api/verifications/${verification.id}/create-fix-task`, {
        method: "POST",
      });
      expect(fixRes.status).toBe(201);
      const body = await fixRes.json() as any;
      expect(body.status).toBe("fixing");
      expect(body.fix_tasks).toHaveLength(3);
      expect(body.issue_task_mappings).toHaveLength(3);
      expect(new Set(body.issue_task_mappings.map((mapping: any) => mapping.issue_id)).size).toBe(3);
      expect(new Set(body.issue_task_mappings.map((mapping: any) => mapping.fix_task_id)).size).toBe(3);

      const rows = db.prepare(`
        SELECT vi.dimension, vi.severity, vi.evidence, vi.repro_command,
               vi.expected_result, vi.actual_result, vi.fix_instruction,
               t.description, t.assignee_id, t.status
        FROM verification_issues vi
        JOIN verification_issue_tasks vit ON vit.issue_id = vi.id AND vit.relation = 'fix'
        JOIN tasks t ON t.id = vit.task_id
        WHERE vi.verification_id = ?
        ORDER BY vi.rowid ASC
      `).all(verification.id) as any[];
      expect(rows).toHaveLength(3);
      rows.forEach((row, index) => {
        expect(row).toMatchObject({ assignee_id: "a1", status: "todo" });
        expect(row.description).toContain(`dimension: ${row.dimension}`);
        expect(row.description).toContain(`severity: ${row.severity}`);
        expect(row.description).toContain(`evidence: ${evidences[index]}`);
        expect(row.description).toContain(`repro_command: npm test -- issue-${index}`);
        expect(row.description).toContain(`expected_result: expected-${index}`);
        expect(row.description).toContain(`actual_result: actual-${index}`);
        expect(row.description).toContain(`fix_instruction: fix-${index}`);
      });

      const secondFixRes = await fetch(`${api.baseUrl}/api/verifications/${verification.id}/create-fix-task`, {
        method: "POST",
      });
      expect(secondFixRes.status).toBe(201);
      expect((await secondFixRes.json() as any).issue_task_mappings).toEqual(body.issue_task_mappings);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM verification_issue_tasks vit
        JOIN verification_issues vi ON vi.id = vit.issue_id
        WHERE vi.verification_id = ? AND vit.relation = 'fix'
      `).get(verification.id)).toEqual({ count: 3 });
    } finally {
      await api.close();
    }
  });

  it("fix task cap을 넘긴 verification issue는 드롭 수와 issue id를 activity로 기록·broadcast한다", async () => {
    const db = createTestDb();
    const taskId = seedTask(db);
    const delivered: Array<{ event: string; payload: any }> = [];
    const verification = db.prepare(
      "INSERT INTO verifications (task_id, verdict, issues) VALUES (?, 'fail', '[]') RETURNING id",
    ).get(taskId) as { id: string };
    const insertIssue = db.prepare(`
      INSERT INTO verification_issues (
        id, verification_id, dimension, severity, evidence, repro_command,
        expected_result, actual_result, fix_instruction, assignee_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'a1')
    `);
    const dimensions = ["functionality", "dataFlow", "designAlignment", "craft", "edgeCases"];
    for (let index = 0; index < 7; index++) {
      insertIssue.run(
        `issue-${index}`,
        verification.id,
        dimensions[index % dimensions.length],
        index < 2 ? "critical" : index < 5 ? "high" : "warning",
        `evidence-${index}`,
        `npm test -- issue-${index}`,
        `expected-${index}`,
        `actual-${index}`,
        `fix-${index}`,
      );
    }

    const conversion = createFixTasksFromVerification(db, verification.id, (event, payload) => {
      delivered.push({ event, payload });
    });
    expect(conversion.fixTasks).toHaveLength(5);

    const linkedIssueIds = new Set((db.prepare(`
      SELECT vit.issue_id
      FROM verification_issue_tasks vit
      JOIN verification_issues vi ON vi.id = vit.issue_id
      WHERE vi.verification_id = ? AND vit.relation = 'fix'
    `).all(verification.id) as Array<{ issue_id: string }>).map((row) => row.issue_id));
    const expectedDroppedIssueIds = ["issue-5", "issue-6"];
    expect(linkedIssueIds.size).toBe(5);
    for (const issueId of expectedDroppedIssueIds) expect(linkedIssueIds.has(issueId)).toBe(false);

    const activities = db.prepare(`
      SELECT type, message, metadata
      FROM activities
      WHERE project_id = 'p1' AND type = 'verification_fix_cap_reached'
    `).all() as Array<{ type: string; message: string; metadata: string }>;
    expect(activities).toHaveLength(1);
    expect(activities[0].message).toContain("수정 작업 한도 초과: 2개 검증 이슈 제외");
    expect(JSON.parse(activities[0].metadata)).toMatchObject({
      sourceVerificationId: verification.id,
      sourceTaskId: taskId,
      maxFixTasks: 5,
      droppedCount: 2,
      droppedIssueIds: expectedDroppedIssueIds,
    });

    expect(delivered).toContainEqual({
      event: "activity:created",
      payload: expect.objectContaining({
        projectId: "p1",
        type: "verification_fix_cap_reached",
        metadata: expect.objectContaining({
          droppedCount: 2,
          droppedIssueIds: expectedDroppedIssueIds,
        }),
      }),
    });
  });

  it("fix task assignee를 결정할 수 없으면 manual_approval로 전환한다", async () => {
    const db = createTestDb();
    const taskId = seedTask(db);
    const api = await startVerificationApi(db, () => 1);

    try {
      const verificationRes = await fetch(`${api.baseUrl}/api/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          verdict: "fail",
          issues: [{
            dimension: "functionality",
            severity: "high",
            message: "assignee disappeared",
            reproCommand: "npm test -- missing-assignee",
            expectedResult: "pass",
            actualResult: "fail",
            fixInstruction: "assign an owner and fix",
          }],
        }),
      });
      const verification = await verificationRes.json() as { id: string };

      const initialFixRes = await fetch(`${api.baseUrl}/api/verifications/${verification.id}/create-fix-task`, {
        method: "POST",
      });
      expect(initialFixRes.status).toBe(201);
      expect(await initialFixRes.json()).toMatchObject({ status: "fixing" });

      db.prepare("DELETE FROM agents WHERE id = 'a1'").run();
      const fixRes = await fetch(`${api.baseUrl}/api/verifications/${verification.id}/create-fix-task`, {
        method: "POST",
      });
      expect(fixRes.status).toBe(201);
      const body = await fixRes.json() as any;
      expect(body.status).toBe("manual_approval");
      expect(body.fix_tasks).toEqual([
        expect.objectContaining({ assignee_id: null, status: "pending_approval" }),
      ]);

      const timelineRes = await fetch(`${api.baseUrl}/api/goals/g1/verification-timeline`);
      expect(timelineRes.status).toBe(200);
      expect(await timelineRes.json()).toMatchObject({
        status: "manual_approval",
        reason: "fix_assignee_unavailable",
      });
    } finally {
      await api.close();
    }
  });

  it("원본 task가 미할당이어도 유효 issue를 버리지 않고 manual_approval fix task로 변환한다", async () => {
    const db = createTestDb();
    const taskId = seedTask(db);
    db.prepare("DELETE FROM agents WHERE id = 'a1'").run();
    const api = await startVerificationApi(db, () => 1);

    try {
      const verificationRes = await fetch(`${api.baseUrl}/api/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          verdict: "fail",
          issues: [{
            dimension: "dataFlow",
            severity: "warning",
            message: "unassigned issue evidence",
            reproCommand: "npm test -- unassigned",
            expectedResult: "issue preserved",
            actualResult: "issue dropped",
            fixInstruction: "assign an owner before fixing",
          }],
        }),
      });
      expect(verificationRes.status).toBe(201);
      const verification = await verificationRes.json() as { id: string };
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM verification_issues WHERE verification_id = ?
      `).get(verification.id)).toEqual({ count: 1 });

      const fixRes = await fetch(`${api.baseUrl}/api/verifications/${verification.id}/create-fix-task`, {
        method: "POST",
      });
      expect(fixRes.status).toBe(201);
      expect(await fixRes.json()).toMatchObject({
        status: "manual_approval",
        fix_tasks: [expect.objectContaining({ assignee_id: null, status: "pending_approval" })],
        issue_task_mappings: [expect.objectContaining({
          issue_id: expect.any(String),
          fix_task_id: expect.any(String),
        })],
      });

      const timelineRes = await fetch(`${api.baseUrl}/api/goals/g1/verification-timeline`);
      expect(await timelineRes.json()).toMatchObject({
        status: "manual_approval",
        reason: "fix_assignee_unavailable",
      });
    } finally {
      await api.close();
    }
  });
});
