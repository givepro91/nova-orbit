import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type Database from "better-sqlite3";
import { createGoalRoutes } from "../api/routes/goals.js";
import { createWSHandler } from "../api/websocket.js";
import { createDatabase, migrate } from "../db/schema.js";
import { saveSpecDraft } from "../core/goal-spec/spec-approval.js";
import type { GoalSpecStateResponse } from "../../shared/types.js";

const dbs: Database.Database[] = [];
const servers: Server[] = [];
const sockets: WebSocket[] = [];

async function startApi(generateGoalSpec?: (goalId: string) => Promise<unknown>): Promise<{
  db: Database.Database;
  baseUrl: string;
  wsUrl: string;
  broadcasts: Array<{ type: string; payload: unknown }>;
}> {
  const db = createDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'test', 'new')").run();
  db.prepare("INSERT INTO goals (id, project_id, description, spec_approval_required) VALUES ('g1', 'p1', 'goal', 1)").run();
  dbs.push(db);

  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  const app = express();
  app.use(express.json());
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  createWSHandler(wss, "test-key");
  app.use("/api/goals", createGoalRoutes({
    db,
    wss,
    broadcast: (type: string, payload: unknown) => {
      broadcasts.push({ type, payload });
      const message = JSON.stringify({ type, payload });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && (client as any).__authenticated) client.send(message);
      }
    },
    generateGoalSpec,
  } as any));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return {
    db,
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws?token=test-key`,
    broadcasts,
  };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  for (const db of dbs.splice(0)) db.close();
});

const draft = {
  scope: "Goal Spec API",
  out_of_scope: "dashboard editing",
  acceptance_criteria: ["common response"],
  expected_tasks: ["routes"],
  verification_methods: ["HTTP test"],
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function pollSpec(baseUrl: string, expectedStatus: GoalSpecStateResponse["generation_status"]): Promise<GoalSpecStateResponse> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await fetch(`${baseUrl}/api/goals/g1/spec`).then((response) => response.json()) as GoalSpecStateResponse;
    if (state.generation_status === expectedStatus) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for generation_status=${expectedStatus}`);
}

async function connectDashboard(wsUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "connected") resolve();
      else reject(new Error(`Unexpected initial WebSocket message: ${message.type}`));
    });
  });
  return socket;
}

function nextWsMessage(socket: WebSocket): Promise<{ type: string; payload: unknown }> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
}

describe("Goal Spec routes", () => {
  it("GET, POST, and approve return the common response contract", async () => {
    const { db, baseUrl, wsUrl, broadcasts } = await startApi();
    const primaryDashboard = await connectDashboard(wsUrl);
    const secondaryDashboard = await connectDashboard(wsUrl);

    const missingResponse = await fetch(`${baseUrl}/api/goals/g1/spec`);
    expect(missingResponse.status).toBe(200);
    expect(await missingResponse.json()).toEqual({
      goal_id: "g1",
      status: "missing",
      generation_status: "idle",
      generation_error: null,
      execution_spec_version_id: null,
      versions: [],
      legacy_spec: null,
    });

    const listedMissing = await fetch(`${baseUrl}/api/goals?projectId=p1`).then((response) => response.json()) as any[];
    expect(listedMissing.find((goal) => goal.id === "g1")).toMatchObject({
      has_spec: 0,
      execution_spec_version_id: null,
      spec_approval_required: 1,
    });

    const primaryCreateEvent = nextWsMessage(primaryDashboard);
    const secondaryCreateEvent = nextWsMessage(secondaryDashboard);
    const createResponse = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as GoalSpecStateResponse;
    expect(created).toMatchObject({
      goal_id: "g1",
      status: "draft",
      execution_spec_version_id: null,
      versions: [{ version: 1, state: "draft", ...draft, approved_at: null }],
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM goal_specs WHERE goal_id = ?").get("g1")).toEqual({ count: 0 });
    await expect(primaryCreateEvent).resolves.toMatchObject({ type: "project:updated", payload: { projectId: "p1" } });
    await expect(secondaryCreateEvent).resolves.toMatchObject({ type: "project:updated", payload: { projectId: "p1" } });

    const listedDraft = await fetch(`${baseUrl}/api/goals?projectId=p1`).then((response) => response.json()) as any[];
    expect(listedDraft.find((goal) => goal.id === "g1")).toMatchObject({
      has_spec: 1,
      execution_spec_version_id: null,
      spec_approval_required: 1,
    });

    const primaryApproveEvent = nextWsMessage(primaryDashboard);
    const secondaryApproveEvent = nextWsMessage(secondaryDashboard);
    const approveResponse = await fetch(`${baseUrl}/api/goals/g1/spec/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: created.versions[0].id }),
    });
    expect(approveResponse.status).toBe(200);
    const approved = await approveResponse.json() as GoalSpecStateResponse;
    expect(approved).toMatchObject({
      goal_id: "g1",
      status: "approved",
      execution_spec_version_id: created.versions[0].id,
      versions: [{ id: created.versions[0].id, state: "approved" }],
    });
    expect(approved.versions[0].approved_at).not.toBeNull();
    await expect(primaryApproveEvent).resolves.toMatchObject({ type: "project:updated", payload: { projectId: "p1" } });
    await expect(secondaryApproveEvent).resolves.toMatchObject({ type: "project:updated", payload: { projectId: "p1" } });
    expect(broadcasts).toEqual([
      { type: "project:updated", payload: { projectId: "p1" } },
      { type: "project:updated", payload: { projectId: "p1" } },
    ]);

    const listed = await fetch(`${baseUrl}/api/goals?projectId=p1`).then((response) => response.json()) as any[];
    expect(listed.find((goal) => goal.id === "g1")).toMatchObject({
      has_spec: 1,
      execution_spec_version_id: created.versions[0].id,
      spec_approval_required: 1,
    });
  });

  it("PATCH creates a new versioned draft and invalidates approval", async () => {
    const { baseUrl } = await startApi();
    const created = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    }).then((response) => response.json()) as GoalSpecStateResponse;
    await fetch(`${baseUrl}/api/goals/g1/spec/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: created.versions[0].id }),
    });

    const response = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "edited scope" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "changes_pending",
      execution_spec_version_id: null,
      versions: [
        { version: 1, state: "approved", scope: draft.scope },
        { version: 2, state: "draft", scope: "edited scope", acceptance_criteria: draft.acceptance_criteria },
      ],
    });
  });

  it("PATCH falls back to legacy prd_summary.scope when top-level scope is absent", async () => {
    const { baseUrl } = await startApi();
    const created = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    }).then((response) => response.json()) as GoalSpecStateResponse;
    await fetch(`${baseUrl}/api/goals/g1/spec/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: created.versions[0].id }),
    });

    const response = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prd_summary: { scope: "changed" }, acceptance_criteria: ["changed"] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "changes_pending",
      execution_spec_version_id: null,
      versions: [
        { version: 1, state: "approved", scope: draft.scope },
        { version: 2, state: "draft", scope: "changed", acceptance_criteria: ["changed"] },
      ],
    });
  });

  it("PATCH prefers top-level scope over legacy prd_summary.scope when both are present", async () => {
    const { baseUrl } = await startApi();
    await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });

    const response = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "new scope", prd_summary: { scope: "legacy scope" } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      versions: [
        { version: 1, state: "draft", scope: draft.scope },
        { version: 2, state: "draft", scope: "new scope" },
      ],
    });
  });

  it("polls POST generate-spec from generating to idle with a draft snapshot", async () => {
    const generation = deferred();
    let db!: Database.Database;
    const api = await startApi(async (goalId) => {
      await generation.promise;
      db.prepare("UPDATE goal_specs SET prd_summary = '{}' WHERE goal_id = ?").run(goalId);
      saveSpecDraft(db, goalId, draft);
    });
    db = api.db;

    const response = await fetch(`${api.baseUrl}/api/goals/g1/generate-spec`, { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "generating", goalId: "g1" });

    const generating = await pollSpec(api.baseUrl, "generating");
    expect(generating).toMatchObject({ status: "missing", generation_error: null, versions: [] });

    generation.resolve();
    const success = await pollSpec(api.baseUrl, "idle");
    expect(success).toMatchObject({
      status: "draft",
      generation_error: null,
      versions: [{ version: 1, state: "draft", ...draft }],
    });
  });

  it("rejects a concurrent generate-spec with 409 while one is still in flight", async () => {
    const generation = deferred();
    let db!: Database.Database;
    const api = await startApi(async (goalId) => {
      await generation.promise;
      db.prepare("UPDATE goal_specs SET prd_summary = '{}' WHERE goal_id = ?").run(goalId);
      saveSpecDraft(db, goalId, draft);
    });
    db = api.db;

    const first = await fetch(`${api.baseUrl}/api/goals/g1/generate-spec`, { method: "POST" });
    expect(first.status).toBe(202);

    // Second POST while the first generation is unresolved must be refused so a
    // single legacy sentinel never tracks two concurrent jobs.
    const second = await fetch(`${api.baseUrl}/api/goals/g1/generate-spec`, { method: "POST" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "Spec generation already in progress", goalId: "g1" });

    // GET /spec keeps reporting generating (not idle) while the job runs.
    const inFlight = await fetch(`${api.baseUrl}/api/goals/g1/spec`).then((r) => r.json()) as GoalSpecStateResponse;
    expect(inFlight.generation_status).toBe("generating");

    generation.resolve();
    const success = await pollSpec(api.baseUrl, "idle");
    expect(success).toMatchObject({
      status: "draft",
      versions: [{ version: 1, state: "draft", ...draft }],
    });
  });

  it("polls POST generate-spec from generating to failed with its error", async () => {
    const generation = deferred();
    const { baseUrl } = await startApi(() => generation.promise);

    const response = await fetch(`${baseUrl}/api/goals/g1/generate-spec`, { method: "POST" });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "generating", goalId: "g1" });
    await expect(pollSpec(baseUrl, "generating")).resolves.toMatchObject({ generation_error: null });

    generation.reject(new Error("boom"));
    const failed = await pollSpec(baseUrl, "failed");
    expect(failed).toMatchObject({ status: "missing", generation_error: "boom", versions: [] });
  });

  it("returns stable errors for invalid payload, missing goal, and foreign version", async () => {
    const { db, baseUrl } = await startApi();
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g2', 'p1', 'other')").run();

    const invalid = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft, expected_tasks: "not-an-array" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "invalid_spec",
      message: "expected_tasks must be an array of strings",
      location: "expected_tasks",
    });

    const missingGoal = await fetch(`${baseUrl}/api/goals/unknown/spec`);
    expect(missingGoal.status).toBe(404);
    expect(await missingGoal.json()).toMatchObject({ error: "goal_not_found" });

    const created = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    }).then((response) => response.json()) as GoalSpecStateResponse;
    const foreignVersion = await fetch(`${baseUrl}/api/goals/g2/spec/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: created.versions[0].id }),
    });
    expect(foreignVersion.status).toBe(404);
    expect(await foreignVersion.json()).toMatchObject({ error: "version_not_found" });
  });

  it("rejects approving a stale version once a newer draft exists, and keeps the execution pointer untouched", async () => {
    const { baseUrl } = await startApi();

    const v1 = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    }).then((response) => response.json()) as GoalSpecStateResponse;
    const v1Id = v1.versions[0].id;

    await fetch(`${baseUrl}/api/goals/g1/spec/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: v1Id }),
    });

    await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft, scope: "v3 draft" }),
    });

    const staleApprove = await fetch(`${baseUrl}/api/goals/g1/spec/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: v1Id }),
    });
    expect(staleApprove.status).toBe(409);
    expect(await staleApprove.json()).toMatchObject({ error: "stale_version" });

    const state = await fetch(`${baseUrl}/api/goals/g1/spec`).then((response) => response.json()) as GoalSpecStateResponse;
    expect(state.status).toBe("changes_pending");
    expect(state.execution_spec_version_id).toBeNull();
  });
});
