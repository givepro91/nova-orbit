import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";

describe("goals.work_report migration", () => {
  it("adds work_report column and is idempotent", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // 두 번 호출해도 안전
    const cols = db.prepare("PRAGMA table_info(goals)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "work_report")).toBe(true);
  });
});
