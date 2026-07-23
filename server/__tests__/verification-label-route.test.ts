import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { createVerificationRoutes } from "../api/routes/verification.js";

/**
 * POST /api/verifications/:id/label — 사람 라벨 upsert.
 * verification 1건당 1행이 유지되고(재라벨 = 마지막 값 승리) 커밋 후 verification:labeled가
 * 발행되는지 확인한다.
 */

const dbs: Database.Database[] = [];
const servers: Server[] = [];
const delivered: Array<{ event: string; payload: any }> = [];

function seedVerification(db: Database.Database, verificationId: string, verdict = "fail"): void {
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'test', 'new')").run();
  db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'goal')").run();
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('t1', 'g1', 'p1', 'task', 'in_review')",
  ).run();
  db.prepare(
    "INSERT INTO verifications (id, task_id, verdict, severity, issues) VALUES (?, 't1', ?, 'hard-block', '[]')",
  ).run(verificationId, verdict);
}

async function setup(): Promise<{ db: Database.Database; baseUrl: string }> {
  const db = createDatabase(":memory:");
  migrate(db);
  dbs.push(db);

  const app = express();
  app.use(express.json());
  app.use("/api/verifications", createVerificationRoutes({
    db,
    wss: {} as any,
    broadcast: (event: string, payload: unknown) => { delivered.push({ event, payload }); return 1; },
  } as any));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return { db, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function postLabel(baseUrl: string, id: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/verifications/${id}/label`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  delivered.length = 0;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  })));
  for (const db of dbs.splice(0)) db.close();
});

describe("POST /api/verifications/:id/label", () => {
  it("최초 라벨은 201로 저장되고 verification:labeled를 발행한다", async () => {
    const { db, baseUrl } = await setup();
    seedVerification(db, "v1");

    const res = await postLabel(baseUrl, "v1", {
      label: "false_positive",
      cause_category: "craft",
      note: "  통과했어야 함  ",
    });
    expect(res.status).toBe(201);

    const body = await res.json() as any;
    expect(body).toMatchObject({
      verification_id: "v1",
      label: "false_positive",
      cause_category: "craft",
      note: "통과했어야 함",
    });
    expect(body.id).toBeTruthy();
    expect(body.labeled_at).toBeTruthy();

    expect(delivered).toEqual([
      { event: "verification:labeled", payload: expect.objectContaining({ verification_id: "v1", label: "false_positive" }) },
    ]);

    const activity = db.prepare(
      "SELECT type, metadata FROM activities WHERE type = 'verification_labeled'",
    ).get() as { type: string; metadata: string } | undefined;
    expect(activity).toBeDefined();
    expect(JSON.parse(activity!.metadata)).toMatchObject({ verificationId: "v1", label: "false_positive" });
  });

  it("같은 verification을 2회 라벨하면 1행만 남고 마지막 값이 이긴다", async () => {
    const { db, baseUrl } = await setup();
    seedVerification(db, "v1");

    const first = await postLabel(baseUrl, "v1", { label: "false_positive", cause_category: "craft", note: "첫 판단" });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;

    const second = await postLabel(baseUrl, "v1", { label: "correct", cause_category: null });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as any;

    // upsert이므로 행 id는 그대로 유지되고 값만 갱신된다.
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody).toMatchObject({ label: "correct", cause_category: null, note: null });

    const rows = db.prepare("SELECT label, cause_category, note FROM verification_labels WHERE verification_id = 'v1'")
      .all() as Array<{ label: string; cause_category: string | null; note: string | null }>;
    expect(rows).toEqual([{ label: "correct", cause_category: null, note: null }]);
  });

  it("존재하지 않는 verification은 404, 라벨을 저장하지 않는다", async () => {
    const { db, baseUrl } = await setup();
    seedVerification(db, "v1");

    const res = await postLabel(baseUrl, "missing", { label: "correct" });
    expect(res.status).toBe(404);

    const count = (db.prepare("SELECT COUNT(*) AS n FROM verification_labels").get() as { n: number }).n;
    expect(count).toBe(0);
    expect(delivered).toEqual([]);
  });

  it("label enum 밖 값과 cause_category 어휘 밖 값은 400", async () => {
    const { db, baseUrl } = await setup();
    seedVerification(db, "v1");

    expect((await postLabel(baseUrl, "v1", { label: "bogus" })).status).toBe(400);
    expect((await postLabel(baseUrl, "v1", {})).status).toBe(400);
    expect((await postLabel(baseUrl, "v1", { label: "correct", cause_category: "typo" })).status).toBe(400);

    const count = (db.prepare("SELECT COUNT(*) AS n FROM verification_labels").get() as { n: number }).n;
    expect(count).toBe(0);
    expect(delivered).toEqual([]);
  });

  it("pass 판정에도 라벨할 수 있다 (미탐 기록)", async () => {
    const { db, baseUrl } = await setup();
    seedVerification(db, "v1", "pass");

    const res = await postLabel(baseUrl, "v1", { label: "false_negative", cause_category: "functionality" });
    expect(res.status).toBe(201);

    const row = db.prepare("SELECT label FROM verification_labels WHERE verification_id = 'v1'")
      .get() as { label: string };
    expect(row.label).toBe("false_negative");
  });

  it("activities insert가 실패하면 라벨도 저장되지 않고 발행도 없다", async () => {
    const { db, baseUrl } = await setup();
    seedVerification(db, "v1");
    db.exec(`
      CREATE TRIGGER fail_activities_insert
      BEFORE INSERT ON activities
      BEGIN
        SELECT RAISE(ABORT, 'boom - forced activities insert failure');
      END;
    `);

    const res = await postLabel(baseUrl, "v1", { label: "correct" });
    expect(res.status).toBe(500);

    const count = (db.prepare("SELECT COUNT(*) AS n FROM verification_labels").get() as { n: number }).n;
    expect(count).toBe(0);
    expect(delivered).toEqual([]);
  });
});

describe("GET /api/verifications — 라벨 동봉", () => {
  it("라벨된 행만 label/label_note를 싣고, 라벨 유무와 무관하게 행 수는 그대로다", async () => {
    const { db, baseUrl } = await setup();
    seedVerification(db, "v1");
    db.prepare(
      "INSERT INTO verifications (id, task_id, verdict, severity, issues) VALUES ('v2', 't1', 'pass', 'auto-resolve', '[]')",
    ).run();

    expect((await postLabel(baseUrl, "v1", { label: "false_positive", note: "통과했어야 함" })).status).toBe(201);

    for (const query of ["projectId=p1", "taskId=t1"]) {
      const rows = await (await fetch(`${baseUrl}/api/verifications?${query}`)).json() as any[];
      expect(rows.length).toBe(2);
      const labeled = rows.find((r) => r.id === "v1");
      const unlabeled = rows.find((r) => r.id === "v2");
      expect(labeled).toMatchObject({ label: "false_positive", label_note: "통과했어야 함" });
      expect(labeled.labeled_at).toBeTruthy();
      // 라벨이 없으면 null — 대시보드는 이 값으로 칩 표시 여부를 정한다.
      expect(unlabeled.label).toBeNull();
      expect(unlabeled.label_note).toBeNull();
    }
  });
});
