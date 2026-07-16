import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRoutes } from "../api/routes/agents.js";
import { createDatabase, migrate } from "../db/schema.js";

const servers: Server[] = [];
const databases: ReturnType<typeof createDatabase>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  databases.splice(0).forEach((db) => db.close());
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function startApi() {
  const workdir = mkdtempSync(join(tmpdir(), "crewdeck-smart-team-"));
  tempDirs.push(workdir);
  mkdirSync(join(workdir, ".claude", "agents"), { recursive: true });
  writeFileSync(join(workdir, ".claude", "agents", "backend.md"), [
    "---", "name: Goal Backend", "role: backend", "---", "Implement the selected goal backend contract.",
  ].join("\n"));
  writeFileSync(join(workdir, ".claude", "agents", "reviewer.md"), [
    "---", "name: Goal Reviewer", "role: reviewer", "---", "Verify the selected goal independently.",
  ].join("\n"));

  const db = createDatabase(":memory:");
  databases.push(db);
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, source, workdir, mission) VALUES (?, ?, ?, ?, ?)")
    .run("p1", "Project", "new", workdir, "Ship reliable operations");
  db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES (?, ?, ?, ?)")
    .run("g1", "p1", "Repair automation evidence", "Make stale evidence impossible to trust");
  db.prepare(`
    INSERT INTO goal_spec_versions
      (id, goal_id, version, scope, acceptance_criteria, expected_tasks, verification_methods, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')
  `).run("spec1", "g1", 1, "Freshness contract", JSON.stringify(["Reject stale snapshots"]), JSON.stringify(["API validator"]), JSON.stringify(["npm test"]));
  db.prepare("UPDATE goals SET execution_spec_version_id = ? WHERE id = ?").run("spec1", "g1");
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, description) VALUES (?, ?, ?, ?, ?)")
    .run("t1", "g1", "p1", "Validate signed timestamps", "Compare source and collection time");
  db.prepare(`
    INSERT INTO agents (id, project_id, name, role, system_prompt, prompt_source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("reviewer1", "p1", "Goal Reviewer", "reviewer", "Verify the selected goal independently.", "project");

  const broadcast = vi.fn();
  const app = express();
  app.use(express.json());
  app.use("/api/agents", createAgentRoutes({ db, broadcast } as any));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return {
    db,
    broadcast,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe("goal-aware smart team routes", () => {
  it("returns a read-only preview scoped to the selected goal plan and tasks", async () => {
    const { db, baseUrl } = await startApi();

    const response = await fetch(`${baseUrl}/api/agents/team-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "p1", goal_id: "g1", mode: "quick" }),
    });

    expect(response.status).toBe(200);
    const preview = await response.json() as any;
    expect(preview.goal).toEqual(expect.objectContaining({
      id: "g1",
      title: "Repair automation evidence",
      hasPlan: true,
      taskCount: 1,
    }));
    expect(preview.preservedExisting).toBe(1);
    expect(preview.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Goal Backend", role: "backend", action: "add" }),
      expect.objectContaining({ name: "Goal Reviewer", role: "reviewer", action: "keep", matchedAgentId: "reviewer1" }),
    ]));
    expect(db.prepare("SELECT COUNT(*) AS count FROM agents").get()).toEqual({ count: 1 });
  });

  it("applies selected changes atomically, preserves existing agents, and makes replay idempotent", async () => {
    const { db, broadcast, baseUrl } = await startApi();
    const candidate = {
      name: "Goal Backend",
      role: "backend",
      systemPrompt: "Own the freshness contract implementation.",
      source: "ai",
      model: "sonnet",
      provider: "codex",
      matchedAgentId: null,
    };

    const apply = () => fetch(`${baseUrl}/api/agents/team-apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "p1", goal_id: "g1", candidates: [candidate] }),
    });
    const first = await apply();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ preserved: 1, created: [{ name: "Goal Backend", provider: "codex", model: "sonnet" }], updated: [], skipped: [] });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agents WHERE project_id = 'p1'").get()).toEqual({ count: 2 });

    const replay = await apply();
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ created: [], updated: [], skipped: [{ name: "Goal Backend" }] });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agents WHERE project_id = 'p1'").get()).toEqual({ count: 2 });
    expect(broadcast).toHaveBeenCalledWith("project:updated", { projectId: "p1" });
  });

  it("rejects invalid providers, duplicate request names, and conflicting existing names without partial writes", async () => {
    const { db, baseUrl } = await startApi();
    const call = (candidates: any[]) => fetch(`${baseUrl}/api/agents/team-apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "p1", goal_id: "g1", candidates }),
    });

    const invalidProvider = await call([{ name: "Backend", role: "backend", provider: "shell", systemPrompt: "", matchedAgentId: null }]);
    expect(invalidProvider.status).toBe(400);

    const duplicates = await call([
      { name: "Backend", role: "backend", provider: null, systemPrompt: "", matchedAgentId: null },
      { name: " backend ", role: "reviewer", provider: null, systemPrompt: "", matchedAgentId: null },
    ]);
    expect(duplicates.status).toBe(409);

    const conflict = await call([{ name: "Goal Reviewer", role: "backend", provider: null, systemPrompt: "", matchedAgentId: null }]);
    expect(conflict.status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS count FROM agents").get()).toEqual({ count: 1 });
  });

  it("updates only the explicitly matched idle agent and refuses active-agent edits", async () => {
    const { db, baseUrl } = await startApi();
    const applyUpdate = () => fetch(`${baseUrl}/api/agents/team-apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: "p1",
        goal_id: "g1",
        candidates: [{
          name: "Goal Reviewer", role: "reviewer", provider: "claude", model: "opus",
          systemPrompt: "Review freshness evidence adversarially.", source: "ai", matchedAgentId: "reviewer1",
        }],
      }),
    });

    const response = await applyUpdate();
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ created: [], updated: [{ id: "reviewer1", provider: "claude", model: "opus" }] });

    db.prepare("UPDATE agents SET status = 'working', current_task_id = 't1' WHERE id = 'reviewer1'").run();
    const blocked = await applyUpdate();
    expect(blocked.status).toBe(409);
  });

  it("rejects goals from another project", async () => {
    const { db, baseUrl } = await startApi();
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p2', 'Other', 'new')").run();

    const response = await fetch(`${baseUrl}/api/agents/team-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "p2", goal_id: "g1", mode: "quick" }),
    });

    expect(response.status).toBe(404);
  });
});
