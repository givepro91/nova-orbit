import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { once } from "node:events";
import Database from "better-sqlite3";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(rootDir, "dist/bin/crewdeck.js");
const QUALITY_GATE_TABLES = [
  "verification_dimension_judgements",
  "verification_issues",
  "verification_fix_rounds",
  "verification_issue_tasks",
  "verification_broadcast_outbox",
];
const QUALITY_GATE_INDEXES = [
  "idx_verification_dimension_judgements_verification",
  "idx_verification_issues_verification",
  "idx_verification_fix_rounds_source_verification",
  "idx_verification_fix_rounds_result_verification",
  "idx_verification_fix_rounds_task_round",
  "idx_verification_issue_tasks_task_relation",
  "idx_verification_broadcast_outbox_pending",
];

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function findAvailablePort() {
  const server = createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Crewdeck exited before becoming healthy (code ${child.exitCode})\n${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        assert.deepEqual(await response.json(), { status: "ok", version: "0.1.0" });
        return;
      }
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health\n${logs()}`);
}

async function startCrewdeck(dataDir) {
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, [cliPath, `--data-dir=${dataDir}`, `--port=${port}`, "--no-open"], {
    cwd: rootDir,
    env: {
      ...process.env,
      CREWDECK_HOST: "127.0.0.1",
      CREWDECK_NO_AUTO_QUEUE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => {
    output = `${output}${chunk}`.slice(-20_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const instance = { child, baseUrl, logs: () => output };
  try {
    await waitForHealth(baseUrl, child, instance.logs);
    return instance;
  } catch (error) {
    await stopCrewdeck(instance);
    throw error;
  }
}

async function stopCrewdeck(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill("SIGTERM");
  const exited = once(instance.child, "exit");
  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(8_000).then(() => true),
  ]);
  if (timedOut && instance.child.exitCode === null) {
    instance.child.kill("SIGKILL");
    await once(instance.child, "exit");
  }
}

function inspectQualityGateSchema(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    );
    const indexes = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name),
    );
    const verificationColumns = new Set(
      db.prepare("PRAGMA table_info(verifications)").all().map((row) => row.name),
    );
    for (const table of QUALITY_GATE_TABLES) assert(tables.has(table), `missing table: ${table}`);
    for (const index of QUALITY_GATE_INDEXES) assert(indexes.has(index), `missing index: ${index}`);
    assert(verificationColumns.has("implementation_session_id"));
    assert(verificationColumns.has("termination_reason"));
  } finally {
    db.close();
  }
}

async function getApiKey(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/key?init=true`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.key, "string");
  assert(body.key.length > 0);
  return body.key;
}

async function fetchJson(url, apiKey, init, expectedStatus) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...init?.headers,
    },
  });
  const body = await response.json();
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus);
  assert(response.ok, `${response.status} ${url}: ${JSON.stringify(body)}`);
  return body;
}

async function verifyDashboard(baseUrl) {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const assetPath = html.match(/<script[^>]+src="([^"]+\.js[^"]*)"/)?.[1];
  assert(assetPath, "dashboard index does not reference a JavaScript asset");
  const assetResponse = await fetch(new URL(assetPath, baseUrl));
  assert.equal(assetResponse.status, 200);
  assert((await assetResponse.arrayBuffer()).byteLength > 0);
}

async function verifyFreshBootstrap(dataDir) {
  let instance;
  try {
    instance = await startCrewdeck(dataDir);
    const dbPath = join(dataDir, "crewdeck.db");
    inspectQualityGateSchema(dbPath);
    await verifyDashboard(instance.baseUrl);

    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM goals").get().count, 0);
    } finally {
      db.close();
    }

    const apiKey = await getApiKey(instance.baseUrl);
    const project = await fetchJson(`${instance.baseUrl}/api/projects`, apiKey, {
      method: "POST",
      body: JSON.stringify({ name: "Startup smoke", mission: "Verify bootstrap", source: "new" }),
    });
    const goal = await fetchJson(`${instance.baseUrl}/api/goals`, apiKey, {
      method: "POST",
      body: JSON.stringify({ project_id: project.id, title: "Fresh goal" }),
    });
    const reportListUrl = `${instance.baseUrl}/api/projects/${project.id}/goal-reports`;
    const reportDetailUrl = `${instance.baseUrl}/api/goals/${goal.id}/execution-report`;
    const unauthenticatedReport = await fetch(reportListUrl);
    assert.equal(unauthenticatedReport.status, 401);
    assert.deepEqual(await unauthenticatedReport.json(), { error: "Unauthorized" });

    const expectedSummary = {
      goalId: goal.id,
      title: "Fresh goal",
      finalStatus: "interrupted",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      providers: [],
      retryCount: 0,
      failoverCount: 0,
      evaluationCount: 0,
      fixRoundCount: 0,
      finalVerdict: null,
      telemetry: "none",
    };
    const reportList = await fetchJson(reportListUrl, apiKey, undefined, 200);
    assert.deepEqual(reportList, { reports: [expectedSummary] });
    const reportDetail = await fetchJson(reportDetailUrl, apiKey, undefined, 200);
    assert.deepEqual(reportDetail, {
      ...expectedSummary,
      agentRoles: [],
      history: [],
    });

    const timeline = await fetchJson(
      `${instance.baseUrl}/api/goals/${goal.id}/verification-timeline`,
      apiKey,
    );
    assert.deepEqual(timeline, {
      goal_id: goal.id,
      status: "stopped",
      reason: "no_verifications",
      rounds: [],
    });
  } finally {
    await stopCrewdeck(instance);
  }
  await assert.rejects(access(join(dataDir, "server.pid")));
}

async function createLegacyDatabase(dataDir) {
  let bootstrapInstance;
  try {
    bootstrapInstance = await startCrewdeck(dataDir);
  } finally {
    await stopCrewdeck(bootstrapInstance);
  }
  await assert.rejects(access(join(dataDir, "server.pid")));

  const db = new Database(join(dataDir, "crewdeck.db"));
  try {
    db.pragma("foreign_keys = ON");
    db.prepare(
      "INSERT INTO projects (id, name, source) VALUES ('legacy-project', 'Legacy project', 'new')",
    ).run();
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description) VALUES ('legacy-goal', 'legacy-project', 'Legacy goal', 'Preserve this goal')",
    ).run();
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('legacy-task', 'legacy-goal', 'legacy-project', 'Legacy task', 'done')",
    ).run();
    db.prepare(
      "INSERT INTO verifications (id, task_id, verdict, dimensions, issues) VALUES ('legacy-verification', 'legacy-task', 'pass', '{}', '[]')",
    ).run();
    db.exec(`
      DROP TABLE verification_broadcast_outbox;
      DROP TABLE verification_issue_tasks;
      DROP TABLE verification_fix_rounds;
      DROP TABLE verification_issues;
      DROP TABLE verification_dimension_judgements;
      ALTER TABLE verifications DROP COLUMN termination_reason;
      ALTER TABLE verifications DROP COLUMN implementation_session_id;
    `);
  } finally {
    db.close();
  }
}

async function verifyUpgradeAndRestart(dataDir) {
  await createLegacyDatabase(dataDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let instance;
    try {
      instance = await startCrewdeck(dataDir);
      const dbPath = join(dataDir, "crewdeck.db");
      inspectQualityGateSchema(dbPath);
      const apiKey = await getApiKey(instance.baseUrl);
      const timeline = await fetchJson(
        `${instance.baseUrl}/api/goals/legacy-goal/verification-timeline`,
        apiKey,
      );
      assert.equal(timeline.goal_id, "legacy-goal");
      assert.equal(timeline.rounds.length, 1);

      const db = new Database(dbPath, { readonly: true });
      try {
        assert.deepEqual(
          db.prepare("SELECT id, task_id, verdict FROM verifications WHERE id = ?").get("legacy-verification"),
          { id: "legacy-verification", task_id: "legacy-task", verdict: "pass" },
        );
      } finally {
        db.close();
      }
    } finally {
      await stopCrewdeck(instance);
    }
    await assert.rejects(access(join(dataDir, "server.pid")));
  }
}

await access(cliPath);
const freshDir = await mkdtemp(join(tmpdir(), "crewdeck-startup-fresh-"));
const upgradeDir = await mkdtemp(join(tmpdir(), "crewdeck-startup-upgrade-"));
try {
  await verifyFreshBootstrap(freshDir);
  await verifyUpgradeAndRestart(upgradeDir);
  console.log("Startup verification passed: fresh bootstrap, authenticated reports, dashboard/API access, upgrade, restart.");
} finally {
  await rm(freshDir, { recursive: true, force: true });
  await rm(upgradeDir, { recursive: true, force: true });
}
