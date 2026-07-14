import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type Database from "better-sqlite3";
import { createGoalRoutes } from "../api/routes/goals.js";
import { createDatabase, migrate } from "../db/schema.js";

const dbs: Database.Database[] = [];
const servers: Server[] = [];

async function startApi(): Promise<{
  db: Database.Database;
  baseUrl: string;
  broadcasts: Array<{ type: string; payload: any }>;
}> {
  const db = createDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'test', 'new')").run();
  db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'goal')").run();
  dbs.push(db);

  const broadcasts: Array<{ type: string; payload: any }> = [];
  const app = express();
  app.use(express.json());
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  app.use("/api/goals", createGoalRoutes({
    db,
    wss,
    broadcast: (type: string, payload: unknown) => { broadcasts.push({ type, payload }); },
  } as any));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { db, baseUrl: `http://127.0.0.1:${port}`, broadcasts };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
  for (const db of dbs.splice(0)) db.close();
});

describe("steering routes", () => {
  it("POST queues a note, returns the fixed camelCase shape, and broadcasts", async () => {
    const { baseUrl, db, broadcasts } = await startApi();
    const res = await fetch(`${baseUrl}/api/goals/g1/steering`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "  focus on error handling  " }),
    });
    expect(res.status).toBe(201);
    const note = await res.json() as any;
    expect(note).toMatchObject({
      goalId: "g1",
      content: "focus on error handling", // trimmed
      injected: false,
    });
    expect(typeof note.id).toBe("string");
    expect(typeof note.createdAt).toBe("string");

    // Persisted to the pending queue
    const row = db.prepare("SELECT goal_id, content, injected FROM goal_steering_notes WHERE id = ?").get(note.id) as any;
    expect(row).toMatchObject({ goal_id: "g1", content: "focus on error handling", injected: 0 });

    // Broadcast fired so the dashboard reflects it without polling
    const evt = broadcasts.find((b) => b.type === "steering:submitted");
    expect(evt).toBeDefined();
    expect(evt!.payload.goalId).toBe("g1");
    expect(evt!.payload.note.id).toBe(note.id);
  });

  it("POST rejects blank content with 400 and stores nothing", async () => {
    const { baseUrl, db } = await startApi();
    for (const body of [{ content: "   " }, { content: "" }, {}, { content: 42 }]) {
      const res = await fetch(`${baseUrl}/api/goals/g1/steering`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    const count = db.prepare("SELECT COUNT(*) AS c FROM goal_steering_notes").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("POST to a missing goal returns 404", async () => {
    const { baseUrl } = await startApi();
    const res = await fetch(`${baseUrl}/api/goals/nope/steering`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET returns pending + injected notes in FIFO order", async () => {
    const { baseUrl, db } = await startApi();
    const insert = db.prepare(
      "INSERT INTO goal_steering_notes (id, goal_id, content, injected, injected_at, injected_step, created_at) VALUES (?, 'g1', ?, ?, ?, ?, ?)",
    );
    insert.run("n1", "first", 1, "2026-01-01 00:00:05", "step-a", "2026-01-01 00:00:00");
    insert.run("n2", "second", 0, null, null, "2026-01-01 00:00:01");

    const res = await fetch(`${baseUrl}/api/goals/g1/steering`);
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    expect(list.map((n: any) => n.id)).toEqual(["n1", "n2"]);
    expect(list[0]).toMatchObject({
      id: "n1", goalId: "g1", content: "first",
      injected: true, injectedAt: "2026-01-01 00:00:05", injectedStep: "step-a",
    });
    expect(list[1]).toMatchObject({ id: "n2", injected: false, injectedAt: null, injectedStep: null });
  });

  it("GET on a missing goal returns 404", async () => {
    const { baseUrl } = await startApi();
    const res = await fetch(`${baseUrl}/api/goals/nope/steering`);
    expect(res.status).toBe(404);
  });
});
