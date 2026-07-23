import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { createVerificationRoutes } from "../api/routes/verification.js";
import type { CalibrationStats } from "../../shared/types.js";

const dbs: Database.Database[] = [];
const servers: Server[] = [];

function seedProject(db: Database.Database, projectId: string): void {
  db.prepare("INSERT INTO projects (id, name, source) VALUES (?, ?, 'new')").run(projectId, projectId);
  db.prepare("INSERT INTO goals (id, project_id, description) VALUES (?, ?, 'goal')").run(`g-${projectId}`, projectId);
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'dev', 'coder')").run(`a-${projectId}`, projectId);
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES (?, ?, ?, 'task', 'in_review')",
  ).run(`t-${projectId}`, `g-${projectId}`, projectId);
}

function insertVerification(db: Database.Database, opts: {
  id: string;
  projectId: string;
  verdict: string;
  severity?: string;
  terminationReason?: string | null;
  /** verifications.issues JSON blob (레거시 경로) */
  jsonIssues?: unknown[];
  /** verification_issues 정규화 행 (우선 경로) */
  normalizedIssues?: Array<{ dimension: string; severity: string }>;
}): void {
  db.prepare(`
    INSERT INTO verifications (id, task_id, verdict, severity, termination_reason, issues)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.id,
    `t-${opts.projectId}`,
    opts.verdict,
    opts.severity ?? (opts.verdict === "fail" ? "hard-block" : "auto-resolve"),
    opts.terminationReason ?? null,
    JSON.stringify(opts.jsonIssues ?? []),
  );

  for (const issue of opts.normalizedIssues ?? []) {
    db.prepare(`
      INSERT INTO verification_issues (
        verification_id, dimension, severity, evidence, repro_command,
        expected_result, actual_result, fix_instruction, assignee_id
      ) VALUES (?, ?, ?, 'e', 'npm test', 'ok', 'ng', 'fix it', ?)
    `).run(opts.id, issue.dimension, issue.severity, `a-${opts.projectId}`);
  }
}

async function startApi(db: Database.Database): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api/verifications", createVerificationRoutes({ db, wss: {} as any, broadcast: () => {} } as any));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup(): Promise<{ db: Database.Database; baseUrl: string }> {
  const db = createDatabase(":memory:");
  migrate(db);
  dbs.push(db);
  return { db, baseUrl: await startApi(db) };
}

function fetchCalibration(baseUrl: string, projectId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/verifications/calibration?projectId=${projectId}`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  })));
  for (const db of dbs.splice(0)) db.close();
});

describe("GET /api/verifications/calibration", () => {
  it("projectId가 없으면 400", async () => {
    const { baseUrl } = await setup();
    const res = await fetch(`${baseUrl}/api/verifications/calibration`);
    expect(res.status).toBe(400);
  });

  it("검증 0건이면 크래시 없이 빈 상태를 돌려준다 (failRate null, causes 빈 배열)", async () => {
    const { db, baseUrl } = await setup();
    seedProject(db, "p1");

    const res = await fetchCalibration(baseUrl, "p1");
    expect(res.status).toBe(200);
    const body = await res.json() as CalibrationStats;
    expect(body).toMatchObject({
      total: 0, passed: 0, conditional: 0, failed: 0,
      failRate: null, baselineFailRate: 48, failRateDelta: null,
      causes: [],
      labels: { total: 0, falsePositive: 0, falseNegative: 0, correct: 0 },
    });
  });

  it("verdict 건수·fail률·기준선 델타를 계산한다", async () => {
    const { db, baseUrl } = await setup();
    seedProject(db, "p1");
    insertVerification(db, { id: "v1", projectId: "p1", verdict: "pass" });
    insertVerification(db, { id: "v2", projectId: "p1", verdict: "pass" });
    insertVerification(db, { id: "v3", projectId: "p1", verdict: "conditional" });
    insertVerification(db, { id: "v4", projectId: "p1", verdict: "fail" });

    const body = await (await fetchCalibration(baseUrl, "p1")).json() as CalibrationStats;
    expect(body.total).toBe(4);
    expect(body.passed).toBe(2);
    expect(body.conditional).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.failRate).toBe(25);
    expect(body.failRateDelta).toBe(-23);
  });

  it("다른 프로젝트의 verification은 집계에 섞이지 않는다", async () => {
    const { db, baseUrl } = await setup();
    seedProject(db, "p1");
    seedProject(db, "p2");
    insertVerification(db, { id: "v1", projectId: "p1", verdict: "pass" });
    insertVerification(db, {
      id: "v2", projectId: "p2", verdict: "fail",
      normalizedIssues: [{ dimension: "craft", severity: "high" }],
    });

    const body = await (await fetchCalibration(baseUrl, "p1")).json() as CalibrationStats;
    expect(body.total).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.causes).toEqual([]);
  });

  it("정규화 issue와 레거시 JSON blob 양쪽에서 fail 사유를 분류한다", async () => {
    const { db, baseUrl } = await setup();
    seedProject(db, "p1");
    // 정규화 경로
    insertVerification(db, {
      id: "v1", projectId: "p1", verdict: "fail",
      normalizedIssues: [{ dimension: "functionality", severity: "critical" }],
    });
    insertVerification(db, {
      id: "v2", projectId: "p1", verdict: "fail",
      normalizedIssues: [
        { dimension: "craft", severity: "info" },
        { dimension: "functionality", severity: "high" },
      ],
    });
    // 레거시 JSON blob 폴백 (verification_issues 행 없음)
    insertVerification(db, {
      id: "v3", projectId: "p1", verdict: "fail",
      jsonIssues: [{ dimension: "dataFlow", severity: "major" }],
    });
    // termination_reason 우선
    insertVerification(db, {
      id: "v4", projectId: "p1", verdict: "fail", terminationReason: "fix_round_limit",
      normalizedIssues: [{ dimension: "craft", severity: "critical" }],
    });
    // 신호 없음 → unclassified
    insertVerification(db, { id: "v5", projectId: "p1", verdict: "fail" });

    const body = await (await fetchCalibration(baseUrl, "p1")).json() as CalibrationStats;
    expect(body.failed).toBe(5);
    // count 내림차순, 동수는 category 사전순
    expect(body.causes).toEqual([
      { category: "functionality", count: 2, ratio: 0.4 },
      { category: "dataFlow", count: 1, ratio: 0.2 },
      { category: "fix_round_limit", count: 1, ratio: 0.2 },
      { category: "unclassified", count: 1, ratio: 0.2 },
    ]);
  });

  it("깨진 issues JSON은 크래시 없이 unclassified로 분류한다", async () => {
    const { db, baseUrl } = await setup();
    seedProject(db, "p1");
    insertVerification(db, { id: "v1", projectId: "p1", verdict: "fail" });
    db.prepare("UPDATE verifications SET issues = '{not json' WHERE id = 'v1'").run();

    const res = await fetchCalibration(baseUrl, "p1");
    expect(res.status).toBe(200);
    const body = await res.json() as CalibrationStats;
    expect(body.causes).toEqual([{ category: "unclassified", count: 1, ratio: 1 }]);
  });

  it("pass 판정은 fail 사유 분포에 들어가지 않는다", async () => {
    const { db, baseUrl } = await setup();
    seedProject(db, "p1");
    insertVerification(db, {
      id: "v1", projectId: "p1", verdict: "pass",
      jsonIssues: [{ dimension: "craft", severity: "info" }],
    });

    const body = await (await fetchCalibration(baseUrl, "p1")).json() as CalibrationStats;
    expect(body.causes).toEqual([]);
  });

  it("사람 라벨을 오탐/미탐/정탐으로 집계한다", async () => {
    const { db, baseUrl } = await setup();
    seedProject(db, "p1");
    seedProject(db, "p2");
    insertVerification(db, { id: "v1", projectId: "p1", verdict: "fail" });
    insertVerification(db, { id: "v2", projectId: "p1", verdict: "pass" });
    insertVerification(db, { id: "v3", projectId: "p1", verdict: "fail" });
    insertVerification(db, { id: "v4", projectId: "p2", verdict: "fail" });

    const insert = db.prepare("INSERT INTO verification_labels (verification_id, label) VALUES (?, ?)");
    insert.run("v1", "false_positive");
    insert.run("v2", "false_negative");
    insert.run("v3", "correct");
    insert.run("v4", "false_positive"); // 다른 프로젝트 — 집계 제외

    const body = await (await fetchCalibration(baseUrl, "p1")).json() as CalibrationStats;
    expect(body.labels).toEqual({ total: 3, falsePositive: 1, falseNegative: 1, correct: 1 });
  });
});
