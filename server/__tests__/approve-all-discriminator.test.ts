import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createOrchestrationRoutes } from "../api/routes/orchestration.js";
import { createDatabase, migrate } from "../db/schema.js";

/**
 * F3 — approve-all discriminator.
 * bulk 승인은 "일반 계획 승인 대기"만 todo로 전환한다. 제외 대상:
 *  (a) fix-파생(verification_issue_tasks relation='fix')
 *  (b) plan_review_status='failed'
 *  (c) requires_human_approval=1
 * 제외 건수는 응답 excluded로 노출된다. 개별 승인 경로(/tasks/:taskId/approve)는 무변경.
 */

const dbs: Database.Database[] = [];
const servers: Server[] = [];

async function fixture() {
  const db = createDatabase(":memory:");
  migrate(db);
  dbs.push(db);
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Project', 'new')").run();
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Builder', 'coder')").run();
  db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Goal', 'desc')").run();

  const insertTask = db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES (?, 'g1', 'p1', ?, ?)",
  );
  insertTask.run("t-plain", "Plain plan task", "pending_approval");
  insertTask.run("t-fix", "Fix-derived task", "pending_approval");
  insertTask.run("t-failed", "Plan review failed task", "pending_approval");
  insertTask.run("t-human", "Human approval task", "pending_approval");
  insertTask.run("t-todo", "Already running plan", "todo");
  db.prepare("UPDATE tasks SET plan_review_status = 'failed' WHERE id = 't-failed'").run();
  db.prepare("UPDATE tasks SET requires_human_approval = 1 WHERE id = 't-human'").run();

  // t-fix를 fix-파생으로 링크
  db.prepare("INSERT INTO verifications (id, task_id, verdict) VALUES ('v1', 't-plain', 'fail')").run();
  db.prepare(`
    INSERT INTO verification_issues (
      id, verification_id, dimension, severity, evidence, repro_command,
      expected_result, actual_result, fix_instruction, assignee_id
    ) VALUES ('vi1', 'v1', 'functionality', 'critical', 'ev', 'cmd', 'exp', 'act', 'fix', 'a1')
  `).run();
  db.prepare(
    "INSERT INTO verification_issue_tasks (issue_id, task_id, relation) VALUES ('vi1', 't-fix', 'fix')",
  ).run();

  const app = express();
  app.use(express.json());
  app.use("/api/orchestration", createOrchestrationRoutes({
    db,
    broadcast: () => undefined,
  } as any));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { db, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
  for (const db of dbs.splice(0)) db.close();
});

describe("POST /:projectId/tasks/approve-all — discriminator", () => {
  it("혼합 상태에서 일반 계획 승인 대기만 todo 전환, 제외 건수를 응답에 싣는다", async () => {
    const { db, baseUrl } = await fixture();

    const response = await fetch(`${baseUrl}/api/orchestration/p1/tasks/approve-all`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json() as { approved: number; excluded: number };
    expect(body.approved).toBe(1);
    expect(body.excluded).toBe(3);

    const statuses = Object.fromEntries(
      (db.prepare("SELECT id, status FROM tasks").all() as Array<{ id: string; status: string }>)
        .map((row) => [row.id, row.status]),
    );
    expect(statuses["t-plain"]).toBe("todo");
    // fix-파생 / 리뷰 실패 / 사람 승인 필수 → bulk에서 제외, 개별 승인 대기 유지
    expect(statuses["t-fix"]).toBe("pending_approval");
    expect(statuses["t-failed"]).toBe("pending_approval");
    expect(statuses["t-human"]).toBe("pending_approval");
    expect(statuses["t-todo"]).toBe("todo");
  });

  it("제외된 태스크도 개별 승인 경로로는 여전히 승인된다", async () => {
    const { db, baseUrl } = await fixture();

    const response = await fetch(`${baseUrl}/api/orchestration/p1/tasks/t-fix/approve`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 't-fix'").get()).toEqual({ status: "todo" });
  });
});
