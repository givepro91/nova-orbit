import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";

function seededDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.exec(`
    INSERT INTO projects (id, name, source) VALUES ('p1', 'P', 'new');
    INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'D');
    INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'A', 'backend');
    INSERT INTO sessions (id, agent_id) VALUES ('s1', 'a1');
  `);
  return db;
}

describe("goal_steering_notes migration", () => {
  it("creates the table with the pending-query columns and is idempotent", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // 두 번 호출해도 안전
    const cols = db.prepare("PRAGMA table_info(goal_steering_notes)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    for (const col of ["id", "goal_id", "session_id", "content", "injected", "injected_at", "injected_step", "created_at"]) {
      expect(names).toContain(col);
    }
  });

  it("rejects blank content via CHECK", () => {
    const db = seededDb();
    expect(() =>
      db.prepare("INSERT INTO goal_steering_notes (goal_id, content) VALUES ('g1', '   ')").run(),
    ).toThrow();
  });

  it("drains pending notes (injected=0) in FIFO order and drops them once injected", () => {
    const db = seededDb();
    const insert = db.prepare(
      "INSERT INTO goal_steering_notes (id, goal_id, session_id, content, created_at) VALUES (?, 'g1', 's1', ?, ?)",
    );
    insert.run("n1", "first", "2026-01-01 00:00:00");
    insert.run("n2", "second", "2026-01-01 00:00:01");

    const pending = () =>
      db
        .prepare("SELECT id FROM goal_steering_notes WHERE goal_id = 'g1' AND injected = 0 ORDER BY created_at ASC")
        .all() as { id: string }[];

    expect(pending().map((r) => r.id)).toEqual(["n1", "n2"]);

    db.prepare(
      "UPDATE goal_steering_notes SET injected = 1, injected_at = datetime('now'), injected_step = 's1' WHERE id = 'n1'",
    ).run();

    expect(pending().map((r) => r.id)).toEqual(["n2"]);
  });

  it("keeps notes when the observed session is deleted (session_id → NULL)", () => {
    const db = seededDb();
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, session_id, content) VALUES ('n1', 'g1', 's1', 'x')").run();
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    const row = db.prepare("SELECT session_id FROM goal_steering_notes WHERE id = 'n1'").get() as { session_id: string | null };
    expect(row.session_id).toBeNull();
  });

  it("cascades note deletion when the goal is removed", () => {
    const db = seededDb();
    db.prepare("INSERT INTO goal_steering_notes (id, goal_id, content) VALUES ('n1', 'g1', 'x')").run();
    db.prepare("DELETE FROM goals WHERE id = 'g1'").run();
    const count = db.prepare("SELECT COUNT(*) AS c FROM goal_steering_notes").get() as { c: number };
    expect(count.c).toBe(0);
  });
});
