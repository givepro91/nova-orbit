import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { createGoalRoutes } from "../api/routes/goals.js";
import { createActivityRoutes } from "../api/routes/activities.js";
import { createOrchestrationEngine } from "../core/orchestration/engine.js";
import type { RunResult } from "../core/agent/adapters/claude-code.js";

// steering-inject.test.ts / steering-routes.test.ts 는 각각 session.ts 주입 로직과
// HTTP route 를 단위로 검증한다. 이 파일은 그 둘을 실제 오케스트레이션 엔진
// (autopilot 이 쓰는 것과 동일한 executeTask 경로) 으로 관통시켜, "활성 Generator
// 세션이 도는 도중 API 로 조향 제출 → 다음 Generator(fix) 스텝 프롬프트에 반영 →
// Evaluator 는 미주입 → activity log 기록"의 전체 계약을 검증한다.
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("../core/agent/adapters/backend.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBackend: () => ({
      provider: "claude",
      isAvailable: async () => true,
      spawn: mocks.spawn,
    }),
  };
});

import { createSessionManager } from "../core/agent/session.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const tempDirs: string[] = [];
const dbs: Database.Database[] = [];
const servers: Server[] = [];
const previousDataDir = process.env.CREWDECK_DATA_DIR;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewdeck-steering-e2e-repo-"));
  tempDirs.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@crewdeck.local");
  git(dir, "config", "user.name", "Crewdeck Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitignore"), ".crewdeck-worktrees/\n.claude/worktrees/\n");
  writeFileSync(join(dir, "README.md"), "# Fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  return dir;
}

function makeDb(): Database.Database {
  const dataDir = mkdtempSync(join(tmpdir(), "crewdeck-steering-e2e-data-"));
  tempDirs.push(dataDir);
  process.env.CREWDECK_DATA_DIR = dataDir;
  const db = createDatabase(join(dataDir, "crewdeck.db"));
  migrate(db);
  dbs.push(db);
  return db;
}

function seedFullAutoProject(db: Database.Database, workdir: string): string {
  const projectId = "project-steering-e2e";
  db.prepare(`
    INSERT INTO projects (id, name, mission, source, workdir, autopilot, base_branch)
    VALUES (?, 'Steering Fixture', 'Ship fixture files', 'local_import', ?, 'full', 'main')
  `).run(projectId, workdir);
  const insertAgent = db.prepare(`
    INSERT INTO agents (id, project_id, name, role, needs_worktree)
    VALUES (?, ?, ?, ?, 1)
  `);
  insertAgent.run("agent-coder", projectId, "Coder", "coder");
  insertAgent.run("agent-reviewer", projectId, "Reviewer", "reviewer");
  return projectId;
}

function streamJson(text: string, sessionId: string): RunResult {
  const stdout = [
    JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text }] } }),
    JSON.stringify({ type: "result", session_id: sessionId, result: text }),
  ].join("\n");
  return { stdout, stderr: "", exitCode: 0, sessionId, provider: "claude" };
}

// 항상 fail — maxFixRetries 를 소진시켜 fix 라운드 이후 즉시 pending_approval 로
// 끝나게 한다 (goal squash/커밋 워크플로까지 갈 필요가 없어 픽스처가 가벼워진다).
function failVerification(): string {
  return `\`\`\`json
{
  "verdict": "fail",
  "severity": "hard-block",
  "dimensionJudgements": [
    { "dimension": "functionality", "verdict": "fail", "evidence": "still failing" },
    { "dimension": "dataFlow", "verdict": "pass", "evidence": "ok" },
    { "dimension": "designAlignment", "verdict": "pass", "evidence": "ok" },
    { "dimension": "craft", "verdict": "fail", "evidence": "missing guard" },
    { "dimension": "edgeCases", "verdict": "fail", "evidence": "no coverage" }
  ],
  "issues": [{
    "dimension": "functionality",
    "severity": "critical",
    "file": "feature-one.txt",
    "line": 1,
    "message": "always fails for this fixture",
    "reproCommand": "npm test -- fixture",
    "expectedResult": "pass",
    "actualResult": "fail",
    "fixInstruction": "fix it"
  }],
  "knownGaps": []
}
\`\`\`

${handoffBlock("verification", ["feature-one.txt"])}`;
}

// Generator(implementation/fix) 단계는 응답 텍스트에 top-level `handoff` 객체가
// 없으면 engine.ts 의 persistRequiredHandoff 가 즉시 실패시킨다(계약 위반).
// 실 Claude Code 응답은 늘 이 블록을 포함하므로 픽스처도 동일하게 채운다.
function handoffBlock(stage: "implementation" | "fix" | "verification", changedFiles: string[]): string {
  return `\`\`\`json
{
  "handoff": {
    "version": 1,
    "stage": "${stage}",
    "changed_files": ${JSON.stringify(changedFiles)},
    "decisions": [],
    "unresolved_risks": [],
    "reproduction_commands": []
  }
}
\`\`\``;
}

async function waitFor(
  read: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(async () => {
  mocks.spawn.mockReset();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch { /* best effort */ }
  }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (previousDataDir === undefined) {
    delete process.env.CREWDECK_DATA_DIR;
  } else {
    process.env.CREWDECK_DATA_DIR = previousDataDir;
  }
});

describe("Steering E2E — real orchestration engine drives injection & Generator/Evaluator separation", () => {
  it(
    "mid-flight API 조향 제출 → 다음 Generator(fix) 스텝에 주입, Evaluator 미주입, session 안 죽음, activity log 기록",
    { timeout: 30_000 },
    async () => {
      const repo = makeRepo();
      const db = makeDb();
      const projectId = seedFullAutoProject(db, repo);
      const goalId = "goal-steering-e2e";
      const taskId = "task-steering-e2e";

      db.prepare(`
        INSERT INTO goals (id, project_id, title, description, priority, goal_model)
        VALUES (?, ?, 'Steering fixture', 'Verify steering injection over a real fix round', 'high', 'goal_as_unit')
      `).run(goalId, projectId);
      db.prepare(`
        INSERT INTO tasks (id, goal_id, project_id, title, description, assignee_id, status, task_type)
        VALUES (?, ?, ?, 'Implement first fixture', 'Create the first fixture file.', 'agent-coder', 'todo', 'code')
      `).run(taskId, goalId, projectId);

      const STEER_CONTENT = "add rate-limit guard before shipping (E2E steering marker)";

      // 각 spawn 을 "이 스텝의 systemPrompt" 로 라벨링해 기록한다. systemPrompt 는
      // spawn 시점(session.ts)에 조향 블록이 붙는 지점이라, 실제 turn 메시지("# Task:
      // ...", "Quality Verification", "# Fix Required")로 스텝을 식별하고 그 스텝을
      // 낳은 spawn 호출의 config.systemPrompt 를 함께 남긴다.
      const records: Array<{ marker: string; systemPrompt: string }> = [];
      const spawnedSessions: Array<{ kill: ReturnType<typeof vi.fn> }> = [];
      let verifyCount = 0;
      let releaseImplGate!: () => void;
      const implGate = new Promise<void>((resolve) => { releaseImplGate = resolve; });

      mocks.spawn.mockImplementation((config: { workdir: string; systemPrompt: string }) => {
        const session = Object.assign(new EventEmitter(), {
          id: `fake-session-${spawnedSessions.length + 1}`,
          process: null,
          status: "idle" as const,
          lastSessionId: null,
          kill: vi.fn(),
          cleanup: vi.fn(),
          send: vi.fn(async (message: string): Promise<RunResult> => {
            if (message.includes("# Task: Implement first fixture")) {
              writeFileSync(join(config.workdir, "feature-one.txt"), "one\n");
              records.push({ marker: "implementation", systemPrompt: config.systemPrompt });
              // 활성 Generator 세션이 "실행 중"인 상태를 재현하려고 여기서 멈춘다 —
              // 테스트가 이 사이 API 로 조향을 제출하고, 세션이 안 죽는지 관찰한 뒤 풀어준다.
              await implGate;
              return streamJson(
                `Implemented first fixture.\n\n${handoffBlock("implementation", ["feature-one.txt"])}`,
                "impl-runtime-session",
              );
            }
            if (message.includes("Quality Verification")) {
              verifyCount++;
              records.push({ marker: verifyCount === 1 ? "verify" : "reverify", systemPrompt: config.systemPrompt });
              return streamJson(failVerification(), `verify-runtime-session-${verifyCount}`);
            }
            if (message.includes("# Fix Required")) {
              writeFileSync(join(config.workdir, "feature-one.txt"), "fixed\n");
              records.push({ marker: "fix", systemPrompt: config.systemPrompt });
              return streamJson(
                `Fixed the issue.\n\n${handoffBlock("fix", ["feature-one.txt"])}`,
                "fix-runtime-session",
              );
            }
            records.push({ marker: "other", systemPrompt: config.systemPrompt });
            return streamJson("No-op.", "noop-runtime-session");
          }),
        });
        spawnedSessions.push(session);
        return session;
      });

      const broadcasts: Array<{ event: string; data: any }> = [];
      const broadcast = (event: string, data: unknown) => broadcasts.push({ event, data });
      const sessionManager = createSessionManager(db, broadcast);
      const engine = createOrchestrationEngine(db, sessionManager, broadcast);

      // 실 HTTP API 경유 — steering 제출/조회 + activity log 조회 (curl 과 동일 계약)
      const app = express();
      app.use(express.json());
      app.use("/api/goals", createGoalRoutes({ db, wss: {} as any, broadcast } as any));
      app.use("/api/activities", createActivityRoutes({ db, wss: {} as any, broadcast } as any));
      const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      // autopilot 이 실행하는 것과 동일한 경로 — decompose 는 이미 끝난 상태로 두고
      // (task 는 status='todo' 로 직접 시딩) executeTask 로 구현→검증→fix 를 태운다.
      const execPromise = engine.executeTask(taskId, { autoFix: true, maxFixRetries: 1 });

      await waitFor(() => records.some((r) => r.marker === "implementation"), "implementation spawn to start");
      expect(spawnedSessions).toHaveLength(1);
      const implSession = spawnedSessions[0];

      // 활성 Generator 세션이 도는 도중 실 API 로 조향 제출
      const submitRes = await fetch(`${baseUrl}/api/goals/${goalId}/steering`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: STEER_CONTENT }),
      });
      expect(submitRes.status).toBe(201);
      const submittedNote = await submitRes.json() as { id: string; injected: boolean; createdAt: string };
      expect(submittedNote.injected).toBe(false);

      // 세션은 kill/restart 되지 않고 healthy 상태 유지 — 제출은 DB insert + broadcast 뿐,
      // 실행 중인 세션의 프로세스 수명주기에는 손대지 않는다. (subprocess 의 실제 exit 143
      // 여부는 real child_process 가 필요해 blueprint 의 수동 검증 항목으로 남는다.)
      expect(implSession.kill).not.toHaveBeenCalled();

      // 이제 현재 스텝(implementation)을 마저 끝내고 verify → fix → reverify 로 진행시킨다
      releaseImplGate();

      const result = await execPromise;
      expect(result).toEqual({ success: false, verdict: "conditional" });

      // 전체 실행 동안 활성 세션은 한 번도 kill 되지 않았다
      expect(implSession.kill).not.toHaveBeenCalled();

      const implRecord = records.find((r) => r.marker === "implementation");
      const verifyRecord = records.find((r) => r.marker === "verify");
      const fixRecord = records.find((r) => r.marker === "fix");
      const reverifyRecord = records.find((r) => r.marker === "reverify");
      expect(implRecord).toBeDefined();
      expect(verifyRecord).toBeDefined();
      expect(fixRecord).toBeDefined();
      expect(reverifyRecord).toBeDefined();

      // 제출 시점보다 먼저 spawn 된 implementation 스텝의 프롬프트에는 없다
      expect(implRecord!.systemPrompt).not.toContain(STEER_CONTENT);
      // Evaluator(verify/reverify) 는 Generator-Evaluator 분리로 절대 주입되지 않는다
      expect(verifyRecord!.systemPrompt).not.toContain(STEER_CONTENT);
      expect(verifyRecord!.systemPrompt).not.toContain("사용자 조향 지침");
      expect(reverifyRecord!.systemPrompt).not.toContain(STEER_CONTENT);
      expect(reverifyRecord!.systemPrompt).not.toContain("사용자 조향 지침");
      // 다음 Generator(fix) 스텝 경계에서 반영된다
      expect(fixRecord!.systemPrompt).toContain("사용자 조향 지침");
      expect(fixRecord!.systemPrompt).toContain(STEER_CONTENT);

      // 큐 소진 — injected=1, injected_at, injected_step = fix 라운드의 session row id
      const fixRound = db.prepare(
        "SELECT session_id FROM verification_fix_rounds WHERE task_id = ?",
      ).get(taskId) as { session_id: string | null };
      expect(fixRound.session_id).toBeTruthy();

      const noteRow = db.prepare(
        "SELECT injected, injected_at, injected_step FROM goal_steering_notes WHERE id = ?",
      ).get(submittedNote.id) as { injected: number; injected_at: string | null; injected_step: string | null };
      expect(noteRow.injected).toBe(1);
      expect(noteRow.injected_at).toBeTruthy();
      expect(noteRow.injected_step).toBe(fixRound.session_id);

      // curl 대체 — 실 HTTP activity log API 로 '조향 주입됨' 확인 (제출 시각·반영 스텝·내용)
      const activitiesRes = await fetch(`${baseUrl}/api/activities?projectId=${projectId}`);
      expect(activitiesRes.status).toBe(200);
      const activities = await activitiesRes.json() as Array<{
        type: string; message: string; metadata: any; createdAt: string;
      }>;
      const injectedActivity = activities.find((a) => a.type === "steering_injected");
      expect(injectedActivity).toBeDefined();
      expect(injectedActivity!.message).toContain("조향 주입됨");
      expect(injectedActivity!.message).toContain(STEER_CONTENT);
      expect(injectedActivity!.metadata.injectedStep).toBe(fixRound.session_id);
      expect(injectedActivity!.metadata.taskId).toBe(taskId);
      expect(injectedActivity!.metadata.notes).toEqual([
        expect.objectContaining({ id: submittedNote.id, content: STEER_CONTENT }),
      ]);
      // 제출 시각이 반영(injected) 시각보다 앞선다
      expect(new Date(submittedNote.createdAt).getTime())
        .toBeLessThanOrEqual(new Date(injectedActivity!.createdAt).getTime());

      // GET /goals/:id/steering 로도 동일한 반영 상태를 조회할 수 있다
      const listRes = await fetch(`${baseUrl}/api/goals/${goalId}/steering`);
      expect(listRes.status).toBe(200);
      const list = await listRes.json() as Array<{ id: string; injected: boolean; injectedStep: string | null; injectedAt: string | null; content: string }>;
      const persisted = list.find((n) => n.id === submittedNote.id);
      expect(persisted).toMatchObject({ injected: true, content: STEER_CONTENT, injectedStep: fixRound.session_id });
      expect(persisted!.injectedAt).toBeTruthy();

      // 실시간 관찰 계약 — 대시보드가 폴링 없이 반영을 인지할 수 있도록 broadcast 도 발화한다
      const submittedEvt = broadcasts.find((b) => b.event === "steering:submitted");
      expect(submittedEvt).toBeDefined();
      const injectedEvt = broadcasts.find((b) => b.event === "steering:injected");
      expect(injectedEvt).toBeDefined();
      expect(injectedEvt!.data.injectedStep).toBe(fixRound.session_id);
    },
  );
});
