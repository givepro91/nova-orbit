# [Design] Phase 2: Production-Ready Safety & Trust

> Nova Engineering — CPS Framework
> 작성일: 2026-04-05
> Plan: plans/phase2-production-ready.md
> X-Verification: verifications/2026-04-05-worktree-vs-branch.md

---

## Context (설계 배경)

### Plan 요약

Crewdeck v0.2.0의 3관점 진단 결과, 6개 스프린트로 Safety → Recovery → Git → Isolation → Trust UX → Claude Native 순서로 구현한다. 안전장치를 먼저 깔고, 핵심 기능을 연결하고, Paperclip 대비 전략적 차별화를 완성한다.

### 설계 원칙

1. **Backward Compatible**: v0.2.0 DB 스키마에 ALTER TABLE로 마이그레이션. 기존 데이터 유실 금지
2. **Fail-Safe**: 모든 git/subprocess 명령은 실패해도 task를 blocked으로 전환 (데이터 유실 없음)
3. **Opt-in Danger**: 위험한 기능(dangerouslySkipPermissions, autoPush)은 명시적 설정 필수
4. **Worktree Default, Branch Fallback**: git repo가 있으면 worktree 격리, 없으면 branch-only (X-Verify 2:1 결과 반영)

---

## Problem (설계 과제)

### 기술적 과제

| # | 과제 | 복잡도 | 기존 접점 |
|---|------|--------|----------|
| 1 | Express 미들웨어 체인에 인증 삽입 (대시보드 정적 파일 제외) | 낮음 | `server/index.ts:58-67` CORS 미들웨어 |
| 2 | 서버 시작 시 DB 상태 복구 (in_progress → todo, orphan PID kill) | 중간 | `server/db/schema.ts` sessions 테이블에 pid 컬럼 이미 존재 |
| 3 | Task 완료 후 git add/commit/push/PR을 engine 파이프라인에 삽입 | 중간 | `engine.ts:200-254` verification 후 transitionTask 호출 지점 |
| 4 | 에이전트별 git worktree 생성/정리 + cwd 변경 | 높음 | `claude-code.ts:92-93` spawn cwd, `github.ts:92-125` createAgentBranch |
| 5 | Task 상태에 pending_approval 추가 + scheduler skip 로직 | 중간 | `schema.ts:64` tasks CHECK, `scheduler.ts:121-131` candidates 쿼리 |
| 6 | session context chain + 에이전트 메모리 파일 | 높음 | `session.ts:41-47` spawn config, `claude-code.ts:293-319` buildTempDir |

### 기존 시스템과의 접점

```
server/index.ts          ← Sprint 1(CORS), Sprint 2(shutdown)
server/db/schema.ts      ← Sprint 2(마이그레이션), Sprint 5(pending_approval)
server/core/agent/
  adapters/claude-code.ts ← Sprint 1(env제한), Sprint 4(worktree cwd), Sprint 6(context)
  session.ts              ← Sprint 2(PID추적), Sprint 4(worktree경로), Sprint 6(메모리)
server/core/orchestration/
  engine.ts               ← Sprint 3(git통합), Sprint 5(approval), Sprint 6(smart resume)
  scheduler.ts            ← Sprint 2(복구), Sprint 5(pending_approval skip)
server/core/project/
  github.ts               ← Sprint 1(URL검증), Sprint 3(stub연결)
server/api/
  websocket.ts            ← Sprint 1(WS인증)
  routes/orchestration.ts ← Sprint 3(git상태), Sprint 5(approve/reject)
```

---

## Solution (설계 상세)

### 전체 아키텍처 변경

```
v0.2.0 Pipeline:
  Task → Agent Execute → Quality Gate → Done/Blocked

v0.3.0 Pipeline (Phase 2):
  Task → [Approval Gate] → Worktree Create → Agent Execute
    → Quality Gate → [PASS] → Git Commit → Push/PR → Worktree Cleanup → Done
                   → [FAIL] → Auto-fix → Re-verify → Blocked/Done
```

---

### Sprint 1: Safety Foundation

#### 1.1 API 인증 미들웨어

**파일**: `server/api/middleware/auth.ts` (신규)

```typescript
// 서버 최초 시작 시 API 키 생성/로드
export function loadOrCreateApiKey(dataDir: string): string {
  const keyPath = join(dataDir, "api-key");
  if (existsSync(keyPath)) return readFileSync(keyPath, "utf-8").trim();
  const key = randomBytes(32).toString("hex");
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

// Express 미들웨어
export function authMiddleware(apiKey: string): RequestHandler {
  return (req, res, next) => {
    // 정적 파일, health check는 인증 제외
    if (!req.path.startsWith("/api/") || req.path === "/api/health") {
      return next();
    }
    // 대시보드 초기 키 전달 엔드포인트
    if (req.path === "/api/auth/key" && req.query.init === "true") {
      // localhost에서만 허용
      const ip = req.ip || req.socket.remoteAddress;
      if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
        return res.json({ key: apiKey });
      }
      return res.status(403).json({ error: "Forbidden" });
    }
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== apiKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
}
```

**적용 지점**: `server/index.ts`에서 CORS 미들웨어 다음에 삽입

```typescript
// server/index.ts 변경
const apiKey = loadOrCreateApiKey(dataDir);
app.use(authMiddleware(apiKey));
```

#### 1.2 CORS 강화

**파일**: `server/index.ts:58-67` 수정

```typescript
// Before (위험):
res.header("Access-Control-Allow-Origin", "*");

// After (안전):
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
];
const origin = req.headers.origin;
if (origin && ALLOWED_ORIGINS.includes(origin)) {
  res.header("Access-Control-Allow-Origin", origin);
}
res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
```

#### 1.3 경로 검증 통일

**파일**: `server/utils/validate-path.ts` (신규)

```typescript
import { resolve } from "node:path";
import { homedir } from "node:os";

export function validateWorkdir(inputPath: string): string {
  const resolved = resolve(inputPath);
  const home = homedir();
  if (!resolved.startsWith(home) && !resolved.startsWith("/tmp")) {
    throw new Error("Path must be within home directory or /tmp");
  }
  return resolved;
}
```

적용: `projects.ts`의 `/analyze`, `/import`, `/github`, `PATCH /:id` 모두 동일 함수 사용

#### 1.4 dangerouslySkipPermissions 제어

**파일**: `server/core/agent/adapters/claude-code.ts:277-279` 수정

```typescript
// Before:
if (config.dangerouslySkipPermissions) {
  args.push("--dangerously-skip-permissions");
}

// After:
if (config.dangerouslySkipPermissions) {
  // 명시적 설정 파일 확인
  const configPath = join(homedir(), ".crewdeck", "config.json");
  let allowed = false;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    allowed = cfg.allowDangerousPermissions === true;
  } catch { /* config 없음 = 불허 */ }
  if (allowed) {
    args.push("--dangerously-skip-permissions");
    log.warn("⚠️  dangerouslySkipPermissions ENABLED — agent has unrestricted access");
  } else {
    log.info("dangerouslySkipPermissions requested but not allowed in config — ignoring");
  }
}
```

#### 1.5 WebSocket 인증

**파일**: `server/api/websocket.ts` — `createWSHandler` 수정

```typescript
export function createWSHandler(wss: WebSocketServer, apiKey: string): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    // 토큰 검증
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    if (token !== apiKey) {
      ws.close(4001, "Unauthorized");
      return;
    }
    // ... 기존 로직
  });
}
```

#### 1.6 subprocess env 제한

**파일**: `server/core/agent/adapters/claude-code.ts:95-99` 수정

```typescript
// Before:
env: { ...process.env, BROWSER: "none", CREWDECK_AGENT_ID: session.id }

// After:
const ALLOWED_ENV_KEYS = [
  "PATH", "HOME", "SHELL", "USER", "LANG", "LC_ALL", "TERM",
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK",
  "NODE_ENV", "TMPDIR", "XDG_CONFIG_HOME",
];
const safeEnv: Record<string, string> = { BROWSER: "none", CREWDECK_AGENT_ID: session.id };
for (const key of ALLOWED_ENV_KEYS) {
  if (process.env[key]) safeEnv[key] = process.env[key]!;
}
// ...
env: safeEnv,
```

---

### Sprint 2: Crash Recovery

#### 2.1 DB 마이그레이션

**파일**: `server/db/schema.ts` — `migrate()` 함수에 추가

```typescript
// sessions.pid 컬럼은 이미 존재 (CREATE TABLE에 포함)
// tasks.started_at 추가
const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
if (!taskCols.some(c => c.name === "started_at")) {
  db.exec("ALTER TABLE tasks ADD COLUMN started_at TEXT");
}

// tasks.result_summary 추가 (Sprint 6용, 여기서 미리)
if (!taskCols.some(c => c.name === "result_summary")) {
  db.exec("ALTER TABLE tasks ADD COLUMN result_summary TEXT");
}

// SQLite busy timeout
db.pragma("busy_timeout = 5000");
```

#### 2.2 Recovery 모듈

**파일**: `server/core/recovery.ts` (신규)

```typescript
export function recoverOnStartup(db: Database): { recoveredTasks: number; killedProcesses: number } {
  let recoveredTasks = 0;
  let killedProcesses = 0;

  // 1. in_progress/in_review 태스크 → todo로 복원
  const stale = db.prepare(
    "UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE status IN ('in_progress', 'in_review')"
  ).run();
  recoveredTasks = stale.changes;

  // 2. 고아 프로세스 정리
  const activeSessions = db.prepare(
    "SELECT id, agent_id, pid FROM sessions WHERE status = 'active' AND pid IS NOT NULL"
  ).all() as { id: string; agent_id: string; pid: number }[];

  for (const s of activeSessions) {
    try {
      process.kill(s.pid, 0); // 프로세스 존재 확인
      process.kill(s.pid, "SIGTERM"); // 정리
      killedProcesses++;
    } catch { /* 이미 죽은 프로세스 */ }
    db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?").run(s.id);
  }

  // 3. 에이전트 상태 초기화
  db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE status = 'working'").run();

  return { recoveredTasks, killedProcesses };
}
```

**적용 지점**: `server/index.ts`에서 `migrate(db)` 직후

```typescript
migrate(db);
const recovery = recoverOnStartup(db);
if (recovery.recoveredTasks > 0 || recovery.killedProcesses > 0) {
  console.log(`  Recovery: ${recovery.recoveredTasks} tasks restored, ${recovery.killedProcesses} orphan processes killed`);
}
```

#### 2.3 PID 추적 강화

**파일**: `server/core/agent/session.ts:50-53` 수정

```typescript
// Before:
db.prepare("INSERT INTO sessions (agent_id, pid, status) VALUES (?, ?, 'active')").run(agentId, null);

// After — 실제 PID 저장 (session.send() 호출 시 proc.pid 사용)
const sessionRow = db.prepare("INSERT INTO sessions (agent_id, status) VALUES (?, 'active') RETURNING id").get(agentId) as { id: string };

// proc.pid는 send() 호출 시 설정됨 — 이벤트로 업데이트
session.on("status", (status: string) => {
  if (status === "working" && session.process?.pid) {
    db.prepare("UPDATE sessions SET pid = ? WHERE id = ?").run(session.process.pid, sessionRow.id);
  }
});
```

#### 2.4 Graceful Shutdown 강화

**파일**: `server/index.ts:129-148` 수정

```typescript
const shutdown = async () => {
  console.log("\n  Shutting down gracefully...");

  // 1. 실행 중 세션 종료
  if (ctx.sessionManager) {
    ctx.sessionManager.killAll();
  }

  // 2. 스케줄러 정지
  if (ctx.scheduler) {
    // 모든 프로젝트 큐 정지
    const projects = db.prepare("SELECT id FROM projects WHERE status = 'active'").all() as { id: string }[];
    for (const p of projects) ctx.scheduler.stopQueue(p.id);
  }

  // 3. Dev server 정리
  devServerManager.stopAll();

  // 4. WebSocket/HTTP 종료
  wss.close();
  server.close();

  // 5. DB 정리: active 세션 → killed
  db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE status = 'active'").run();
  db.close();

  process.exit(0);
};

// 5초 timeout 후 강제 종료
const forceShutdown = () => { setTimeout(() => process.exit(1), 5000); };
process.on("SIGINT", () => { shutdown(); forceShutdown(); });
process.on("SIGTERM", () => { shutdown(); forceShutdown(); });
```

---

### Sprint 3: Git Workflow Pipeline

#### 3.1 Git Workflow 모듈

**파일**: `server/core/project/git-workflow.ts` (신규)

```typescript
import { spawnSync } from "node:child_process";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("git-workflow");
const GIT_TIMEOUT = 30_000;

export interface GitWorkflowResult {
  committed: boolean;
  pushed: boolean;
  prUrl: string | null;
  branch: string | null;
  error: string | null;
}

/**
 * Task 완료 후 git workflow 실행.
 * workdir은 worktree 경로 또는 project.workdir.
 */
export function commitTaskResult(
  workdir: string,
  taskTitle: string,
  agentName: string,
): { committed: boolean; filesChanged: number } {
  // 1. 변경 파일 감지
  const status = gitExec(workdir, ["status", "--porcelain"]);
  if (!status.stdout.trim()) {
    log.info("No changes to commit");
    return { committed: false, filesChanged: 0 };
  }

  const filesChanged = status.stdout.trim().split("\n").length;

  // 2. git add -A (worktree 내 변경사항만)
  gitExec(workdir, ["add", "-A"]);

  // 3. git commit
  const message = `feat(nova-agent): ${taskTitle}\n\nAgent: ${agentName}\nGenerated by Crewdeck`;
  gitExec(workdir, ["commit", "-m", message]);

  log.info(`Committed ${filesChanged} files: ${taskTitle}`);
  return { committed: true, filesChanged };
}

export function pushBranch(workdir: string, branch: string): boolean {
  try {
    gitExec(workdir, ["push", "-u", "origin", branch]);
    log.info(`Pushed branch: ${branch}`);
    return true;
  } catch (err: any) {
    log.error(`Push failed: ${err.message}`);
    return false;
  }
}

export function createPR(
  workdir: string,
  branch: string,
  title: string,
  body: string,
): string | null {
  try {
    const result = spawnSync("gh", [
      "pr", "create",
      "--head", branch,
      "--title", title,
      "--body", body,
    ], { cwd: workdir, stdio: "pipe", timeout: GIT_TIMEOUT });

    if (result.status === 0) {
      const url = result.stdout.toString().trim();
      log.info(`PR created: ${url}`);
      return url;
    }
    log.warn(`gh pr create failed: ${result.stderr?.toString()}`);
    return null;
  } catch {
    return null;
  }
}

function gitExec(cwd: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", timeout: GIT_TIMEOUT });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr?.toString()}`);
  }
  return { stdout: result.stdout?.toString() ?? "", stderr: result.stderr?.toString() ?? "" };
}
```

#### 3.2 Engine 통합

**파일**: `server/core/orchestration/engine.ts` — `executeTask()` 수정

verification PASS 후, `transitionTask(db, broadcast, task, "done")` 직전에 git workflow 삽입:

```typescript
// Phase 4 이후, Phase 5 전에 삽입 (line ~253 부근)
const passed = verification.verdict === "pass" || verification.verdict === "conditional";

if (passed) {
  // Git Workflow (Sprint 3)
  const githubConfig = getGitHubConfig(db, task.project_id);
  if (githubConfig) {
    try {
      const gitResult = await executeGitWorkflow(
        project.workdir, // Sprint 4에서 worktree 경로로 교체
        task,
        agentName,
        githubConfig,
      );
      broadcast("task:git", { taskId: task.id, ...gitResult });
    } catch (gitErr: any) {
      log.error(`Git workflow failed for task "${task.title}"`, gitErr);
      // git 실패는 task를 blocked으로 — 코드는 이미 검증됨, git만 실패
      transitionTask(db, broadcast, task, "blocked");
      return { success: false, verdict: "git-error" };
    }
  }
}

transitionTask(db, broadcast, task, passed ? "done" : "blocked");
```

**헬퍼 함수** (같은 파일 하단):

```typescript
function getGitHubConfig(db: Database, projectId: string): GitHubConfig | null {
  const row = db.prepare("SELECT github_config FROM projects WHERE id = ?").get(projectId) as { github_config: string | null } | undefined;
  if (!row?.github_config) return null;
  try { return JSON.parse(row.github_config); } catch { return null; }
}

async function executeGitWorkflow(
  workdir: string,
  task: TaskRow,
  agentName: string,
  config: GitHubConfig,
): Promise<GitWorkflowResult> {
  const { commitTaskResult, pushBranch, createPR } = await import("../project/git-workflow.js");
  const { createAgentBranch } = await import("../project/github.js");

  let branch: string | null = null;

  if (config.prMode) {
    // PR 모드: agent branch 생성 → commit → push → PR
    branch = createAgentBranch(workdir, agentName, task.title);
    const commit = commitTaskResult(workdir, task.title, agentName);
    if (!commit.committed) return { committed: false, pushed: false, prUrl: null, branch, error: null };
    const pushed = pushBranch(workdir, branch);
    const prUrl = pushed ? createPR(workdir, branch, task.title, `Task: ${task.description}`) : null;
    return { committed: true, pushed, prUrl, branch, error: null };
  }

  if (config.autoPush) {
    // Auto-push 모드: main에 commit → push
    const commit = commitTaskResult(workdir, task.title, agentName);
    if (!commit.committed) return { committed: false, pushed: false, prUrl: null, branch: config.branch, error: null };
    const pushed = pushBranch(workdir, config.branch);
    return { committed: true, pushed, prUrl: null, branch: config.branch, error: null };
  }

  // 로컬 모드: commit만
  const commit = commitTaskResult(workdir, task.title, agentName);
  return { committed: commit.committed, pushed: false, prUrl: null, branch: null, error: null };
}
```

---

### Sprint 4: Worktree Isolation

> **X-Verify 결과**: Worktree 2:1 채택. Gemini 지적 반영하여 git repo 없는 프로젝트는 직접 실행(fallback).

#### 4.1 Worktree 모듈

**파일**: `server/core/project/worktree.ts` (신규)

```typescript
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("worktree");

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/**
 * 에이전트별 독립 worktree 생성.
 *
 * 구조: {projectWorkdir}/.nova-worktrees/{agentSlug}-{taskSlug}/
 * Branch: agent/{agentSlug}/{taskSlug}
 *
 * Fallback: git repo가 아니면 null 반환 → 호출자가 직접 실행 모드로 전환
 */
export function createWorktree(
  projectWorkdir: string,
  agentName: string,
  taskSlug: string,
): WorktreeInfo | null {
  // git repo 확인
  if (!existsSync(join(projectWorkdir, ".git"))) {
    log.info("Not a git repo — skipping worktree isolation");
    return null;
  }

  const agentSlug = slugify(agentName);
  const safeTaskSlug = slugify(taskSlug).slice(0, 40);
  const branch = `agent/${agentSlug}/${safeTaskSlug}`;
  const worktreePath = join(projectWorkdir, ".nova-worktrees", `${agentSlug}-${safeTaskSlug}`);

  // 이미 존재하면 정리 후 재생성
  if (existsSync(worktreePath)) {
    removeWorktree(projectWorkdir, worktreePath);
  }

  // main branch의 HEAD에서 worktree 생성
  const result = spawnSync("git", ["worktree", "add", "-b", branch, worktreePath], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 30_000,
  });

  if (result.status !== 0) {
    // branch가 이미 존재할 수 있음 — 기존 branch 사용
    const retryResult = spawnSync("git", ["worktree", "add", worktreePath, branch], {
      cwd: projectWorkdir,
      stdio: "pipe",
      timeout: 30_000,
    });
    if (retryResult.status !== 0) {
      log.error(`Failed to create worktree: ${retryResult.stderr?.toString()}`);
      return null; // fallback to direct execution
    }
  }

  log.info(`Created worktree: ${worktreePath} (branch: ${branch})`);
  return { path: worktreePath, branch };
}

export function removeWorktree(projectWorkdir: string, worktreePath: string): void {
  try {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: projectWorkdir,
      stdio: "pipe",
      timeout: 15_000,
    });
    log.info(`Removed worktree: ${worktreePath}`);
  } catch (err: any) {
    log.warn(`Failed to remove worktree: ${err.message}`);
  }
}

export function listWorktrees(projectWorkdir: string): string[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 10_000,
  });
  if (result.status !== 0) return [];
  return result.stdout.toString()
    .split("\n")
    .filter(line => line.startsWith("worktree "))
    .map(line => line.replace("worktree ", ""));
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
```

#### 4.2 Engine 통합 — Worktree 적용

**파일**: `server/core/orchestration/engine.ts` — `executeTask()` 수정

Task 시작 전 worktree 생성, 완료 후 정리:

```typescript
// Phase 1 (in_progress 설정) 전에 삽입:
let effectiveWorkdir = workdir;
let worktreeInfo: WorktreeInfo | null = null;

try {
  const { createWorktree } = await import("../project/worktree.js");
  worktreeInfo = createWorktree(workdir, agentName, task.title);
  if (worktreeInfo) {
    effectiveWorkdir = worktreeInfo.path;
    log.info(`Using worktree: ${effectiveWorkdir}`);
  }
} catch (err: any) {
  log.warn(`Worktree creation failed, using direct workdir: ${err.message}`);
}

// session spawn 시 effectiveWorkdir 사용:
session = sessionManager.spawnAgent(task.assignee_id, effectiveWorkdir);

// finally 블록에서 worktree 정리:
finally {
  // ... 기존 agent 상태 리셋 ...
  if (worktreeInfo) {
    const { removeWorktree } = await import("../project/worktree.js");
    removeWorktree(workdir, worktreeInfo.path);
  }
}
```

#### 4.3 Git Workflow — Worktree 경로 사용

Sprint 3의 `executeGitWorkflow()`에서 `workdir` 대신 `effectiveWorkdir`(worktree 경로)를 전달. worktree 내에서 commit → push → PR이 자연스럽게 동작함 (worktree는 이미 독립 branch).

prMode에서 `createAgentBranch()` 호출이 불필요해짐 (worktree 생성 시 이미 branch 생성됨). 조건 분기:

```typescript
if (worktreeInfo) {
  // worktree 모드: branch 이미 존재, commit → push → PR만
  const commit = commitTaskResult(effectiveWorkdir, task.title, agentName);
  if (commit.committed) {
    const pushed = pushBranch(effectiveWorkdir, worktreeInfo.branch);
    if (pushed && config.prMode) {
      createPR(effectiveWorkdir, worktreeInfo.branch, task.title, `Task: ${task.description}`);
    }
  }
} else {
  // 기존 로직 (Sprint 3과 동일)
}
```

---

### Sprint 5: Trust UX

#### 5.1 Task 상태 확장: pending_approval

**파일**: `server/db/schema.ts` — tasks CHECK 수정

```typescript
// 마이그레이션: pending_approval 추가
// SQLite는 CHECK 변경이 불가하므로 테이블 재생성
const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
// pending_approval 지원 여부 테스트
try {
  db.exec("INSERT INTO tasks (goal_id, project_id, title, status) VALUES ('__check__', '__check__', '__check__', 'pending_approval')");
  db.exec("DELETE FROM tasks WHERE goal_id = '__check__'");
} catch {
  // CHECK 실패 → 재생성 (기존 마이그레이션 패턴 따름)
  db.exec(`
    CREATE TABLE tasks_new ( ... status CHECK (... 'pending_approval' ...) ... );
    INSERT INTO tasks_new SELECT * FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
  `);
}
```

**shared/types.ts 수정:**

```typescript
export type TaskStatus =
  | "todo"
  | "pending_approval"  // 신규
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked";
```

#### 5.2 Approval Gate 로직

**파일**: `server/core/orchestration/engine.ts` — `decomposeGoal()` 수정

```typescript
// Goal decomposition 후 task 생성 시:
// autopilot 모드에 관계없이 pending_approval로 생성
const initialStatus = "pending_approval";

db.prepare(`
  INSERT INTO tasks (goal_id, project_id, title, description, assignee_id, status)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(goal.id, goal.project_id, title, description, agent?.id ?? null, initialStatus);
```

**파일**: `server/core/orchestration/scheduler.ts:121-131` 수정

```sql
-- candidates 쿼리에서 pending_approval 제외
WHERE t.status = 'todo'  -- pending_approval은 여기서 자동 제외됨
```

**파일**: `server/api/routes/orchestration.ts` — 엔드포인트 추가

```typescript
// POST /orchestration/:projectId/tasks/:taskId/approve
router.post("/:projectId/tasks/:taskId/approve", (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
    .get(req.params.taskId, req.params.projectId);
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (task.status !== "pending_approval") return res.status(400).json({ error: "Task is not pending approval" });

  db.prepare("UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE id = ?")
    .run(req.params.taskId);
  broadcast("task:updated", { ...task, status: "todo" });
  res.json({ success: true });
});

// POST /orchestration/:projectId/tasks/:taskId/reject
router.post("/:projectId/tasks/:taskId/reject", (req, res) => {
  // ... 유사 로직, status → blocked, reason 기록
});

// POST /orchestration/:projectId/tasks/approve-all
router.post("/:projectId/tasks/approve-all", (req, res) => {
  const result = db.prepare(
    "UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE project_id = ? AND status = 'pending_approval'"
  ).run(req.params.projectId);
  broadcast("project:updated", { projectId: req.params.projectId });
  res.json({ approved: result.changes });
});
```

#### 5.3 비용 추적

**파일**: `server/core/agent/adapters/stream-parser.ts` 확장

현재 `parseStreamJson()`이 이미 usage 데이터를 파싱함. 추가 필요한 것:

```typescript
// API 엔드포인트
// GET /api/projects/:id/cost
router.get("/:id/cost", (req, res) => {
  const costs = db.prepare(`
    SELECT a.id as agentId, a.name as agentName, a.role,
           SUM(s.token_usage) as totalTokens,
           SUM(s.cost_usd) as totalCost
    FROM agents a
    LEFT JOIN sessions s ON s.agent_id = a.id
    WHERE a.project_id = ?
    GROUP BY a.id
  `).all(req.params.id);
  res.json({ costs });
});
```

#### 5.4 검증 배지 & 에러 메시지

대시보드 변경은 구체적 코드 대신 데이터 계약으로 정의 (아래 Data Contract 참조).

---

### Sprint 6: Claude Native Moat

#### 6.1 Session Context Chain

**파일**: `server/core/agent/session.ts` — spawnAgent 수정

```typescript
// 최근 3개 완료 태스크의 result_summary를 system prompt에 주입
const recentTasks = db.prepare(`
  SELECT title, result_summary FROM tasks
  WHERE assignee_id = ? AND status = 'done' AND result_summary IS NOT NULL
  ORDER BY updated_at DESC LIMIT 3
`).all(agentId) as { title: string; result_summary: string }[];

let contextChain = "";
if (recentTasks.length > 0) {
  contextChain = "\n\n## Recent Task Context\n" +
    recentTasks.map(t => `### ${t.title}\n${t.result_summary}`).join("\n\n");
}

const session = adapter.spawn({
  systemPrompt: resolution.prompt + contextChain,
  // ...
});
```

**파일**: `server/core/orchestration/engine.ts` — 태스크 완료 시 요약 저장

```typescript
// implResult 파싱 후:
const summary = implParsed.text.slice(-500); // 마지막 500자를 요약으로
db.prepare("UPDATE tasks SET result_summary = ? WHERE id = ?").run(summary, task.id);
```

#### 6.2 에이전트 메모리

**파일**: `server/core/agent/memory.ts` (신규)

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MAX_MEMORY_SIZE = 50 * 1024; // 50KB

export function getMemoryPath(dataDir: string, agentId: string): string {
  const dir = join(dataDir, "memory");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.md`);
}

export function loadMemory(dataDir: string, agentId: string): string {
  const path = getMemoryPath(dataDir, agentId);
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  return content.slice(-MAX_MEMORY_SIZE); // 최신 내용 우선
}

export function appendMemory(dataDir: string, agentId: string, entry: string): void {
  const path = getMemoryPath(dataDir, agentId);
  let existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  existing += `\n\n---\n${new Date().toISOString()}\n${entry}`;
  // 크기 초과 시 앞부분 잘라냄
  if (existing.length > MAX_MEMORY_SIZE) {
    existing = existing.slice(-MAX_MEMORY_SIZE);
  }
  writeFileSync(path, existing);
}
```

**buildTempDir에서 메모리 파일 주입** (`claude-code.ts`):

```typescript
// buildTempDir() 내에서:
if (config.memoryContent) {
  writeFileSync(join(tempDir, ".nova-agent-memory.md"), config.memoryContent);
  // --add-dir로 tempDir 전체가 전달되므로 자동 접근 가능
}
```

#### 6.3 Smart Resume

**파일**: `server/core/orchestration/engine.ts` — auto-fix 프롬프트 개선

```typescript
// 기존 fixPrompt에 이전 실패 컨텍스트 추가:
const previousFailures = db.prepare(`
  SELECT v.issues FROM verifications v
  WHERE v.task_id = ? AND v.verdict = 'fail'
  ORDER BY v.created_at DESC LIMIT 2
`).all(task.id) as { issues: string }[];

const failureContext = previousFailures.length > 0
  ? `\n\n## Previous Failure History\n${previousFailures.map((f, i) => `Attempt ${i + 1}: ${f.issues}`).join("\n")}`
  : "";

const fixPrompt = `
# Fix Required (Smart Resume)
${failureContext}

The following issues were found during verification:
${verification.issues.map(i => `- [${i.severity}] ${i.file ?? ""}:${i.line ?? ""} — ${i.message}`).join("\n")}

Fix ONLY these issues. Pay special attention to issues that appeared in previous attempts.
`;
```

#### 6.4 프로젝트 컨텍스트 자동 주입

**파일**: `server/core/agent/session.ts` — spawnAgent에서 프로젝트 정보 주입

```typescript
// 프로젝트 기술 스택 + 최근 git log를 system prompt에 추가
const project = db.prepare("SELECT tech_stack, workdir FROM projects WHERE id = ?")
  .get(agent.project_id) as { tech_stack: string | null; workdir: string } | undefined;

let projectContext = "";
if (project?.tech_stack) {
  const stack = JSON.parse(project.tech_stack);
  projectContext += `\n\n## Project Tech Stack\n- Languages: ${stack.languages?.join(", ")}\n- Frameworks: ${stack.frameworks?.join(", ")}`;
}

// 최근 git log (5개)
try {
  const { execSync } = await import("node:child_process");
  const gitLog = execSync("git log --oneline -5", { cwd: project?.workdir, encoding: "utf-8" });
  projectContext += `\n\n## Recent Git History\n${gitLog}`;
} catch { /* git 없는 프로젝트 */ }
```

---

## 데이터 계약 (Data Contract)

### DB 스키마 변경

| 테이블 | 컬럼 | 타입 | Sprint | 설명 |
|--------|------|------|--------|------|
| tasks | status CHECK | TEXT | 5 | `'pending_approval'` 추가 |
| tasks | started_at | TEXT (ISO 8601) | 2 | 태스크 실행 시작 시각 |
| tasks | result_summary | TEXT | 6 | 태스크 완료 시 마지막 500자 요약 |

### API 엔드포인트 추가

| Method | Path | Sprint | Request | Response |
|--------|------|--------|---------|----------|
| GET | `/api/auth/key?init=true` | 1 | (localhost only) | `{ key: string }` |
| POST | `/api/orchestration/:pid/tasks/:tid/approve` | 5 | - | `{ success: true }` |
| POST | `/api/orchestration/:pid/tasks/:tid/reject` | 5 | `{ reason?: string }` | `{ success: true }` |
| POST | `/api/orchestration/:pid/tasks/approve-all` | 5 | - | `{ approved: number }` |
| GET | `/api/projects/:id/cost` | 5 | - | `{ costs: CostEntry[] }` |

### WebSocket 이벤트 추가

| Event | Sprint | Payload |
|-------|--------|---------|
| `task:git` | 3 | `{ taskId, committed, pushed, prUrl, branch, error }` |
| `task:approval-required` | 5 | `{ taskId, title, description, agentName }` |

### 대시보드 데이터 흐름

| 화면 | 데이터 소스 | Sprint |
|------|------------|--------|
| Task 카드 배지 | `task.verification_id` → verifications 조회 | 5 |
| Approve/Reject 버튼 | `task.status === 'pending_approval'` | 5 |
| 비용 표시 | `GET /api/projects/:id/cost` | 5 |
| Git 상태 | `task:git` WS 이벤트 | 3 |

---

## Sprint Contract (스프린트별 검증 계약)

| Sprint | Done 조건 | 검증 방법 | 검증 명령 | 우선순위 |
|--------|----------|----------|----------|---------|
| 1 | 인증 없는 API 호출이 401 반환 | curl 테스트 | `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/projects` → 401 | Critical |
| 1 | Bearer 토큰으로 API 호출 성공 | curl 테스트 | `KEY=$(cat ~/.crewdeck/api-key) && curl -s -H "Authorization: Bearer $KEY" http://localhost:3000/api/projects` → 200 | Critical |
| 1 | CORS origin이 localhost만 허용 | curl 테스트 | `curl -s -H "Origin: http://evil.com" -I http://localhost:3000/api/health \| grep Access-Control` → origin 미포함 | Critical |
| 1 | dangerouslySkipPermissions가 config 없이 무시됨 | 코드 검증 | `grep -n "allowDangerousPermissions" server/core/agent/adapters/claude-code.ts` → 존재 | Critical |
| 1 | subprocess에 제한된 env만 전달 | 코드 검증 | `grep -n "ALLOWED_ENV_KEYS" server/core/agent/adapters/claude-code.ts` → 존재 | Critical |
| 2 | 서버 재시작 시 in_progress 태스크가 todo로 복원 | DB 상태 확인 | `sqlite3 .crewdeck/crewdeck.db "SELECT count(*) FROM tasks WHERE status='in_progress'"` → 0 (재시작 후) | Critical |
| 2 | sessions 테이블에 pid 저장됨 | DB 검증 | `sqlite3 .crewdeck/crewdeck.db "PRAGMA table_info(sessions)" \| grep pid` → 존재 | Critical |
| 2 | graceful shutdown 시 세션 정리 | 로그 확인 | 서버 SIGTERM → "Shutting down gracefully" 로그 출력 | Nice-to-have |
| 3 | task PASS 후 git commit 생성 | git log 확인 | `git log --oneline -1` → "feat(nova-agent):" 접두사 | Critical |
| 3 | prMode=true 시 PR 생성 | gh 확인 | `gh pr list --head agent/` → PR 존재 | Critical |
| 3 | git 실패 시 task가 blocked 전환 | API 확인 | task.status === "blocked" && verdict === "git-error" | Critical |
| 3 | autoPush/prMode 토글이 실제 동작 | 대시보드 확인 | ProjectSettings에서 토글 변경 → DB github_config 업데이트됨 | Nice-to-have |
| 4 | 에이전트 실행 시 독립 worktree 생성 | 파일시스템 확인 | `ls {workdir}/.nova-worktrees/` → 에이전트명 디렉토리 존재 | Critical |
| 4 | 에이전트 cwd가 worktree 경로 | 로그 확인 | "Using worktree:" 로그에 .nova-worktrees 경로 포함 | Critical |
| 4 | 완료 후 worktree 자동 정리 | 파일시스템 확인 | task 완료 후 `ls {workdir}/.nova-worktrees/` → 해당 디렉토리 없음 | Critical |
| 4 | 2개 에이전트 동시 실행 시 충돌 없음 | 수동 검증 | 2개 task 동시 실행 → 각각 다른 worktree에서 작업 | Critical |
| 5 | Goal decompose 후 task가 pending_approval 상태 | API 확인 | `GET /api/tasks?projectId=X` → status === "pending_approval" | Critical |
| 5 | Approve 버튼 클릭 시 task가 todo로 전환 | API 테스트 | `POST /api/orchestration/:pid/tasks/:tid/approve` → task.status === "todo" | Critical |
| 5 | 에이전트별 비용 합계 표시 | API 확인 | `GET /api/projects/:id/cost` → costs 배열에 totalTokens 포함 | Nice-to-have |
| 6 | 에이전트가 이전 태스크 결과를 참조 | 프롬프트 확인 | system prompt에 "Recent Task Context" 섹션 포함 | Critical |
| 6 | 에이전트 메모리 파일 생성 | 파일 확인 | `ls .crewdeck/memory/` → {agentId}.md 존재 | Critical |
| 6 | 실패 재실행 시 이전 실패 원인 포함 | 프롬프트 확인 | fix prompt에 "Previous Failure History" 섹션 포함 | Nice-to-have |

---

## 관통 검증 조건 (End-to-End)

| # | 시작점 (사용자 행동) | 종착점 (결과 확인) | 우선순위 |
|---|---------------------|-------------------|---------|
| 1 | 대시보드에서 Goal "로그인 페이지 구현" 생성 + Autopilot | Task들이 pending_approval 상태로 대시보드에 표시 | Critical |
| 2 | pending_approval Task를 Approve 클릭 | Task가 todo → in_progress → worktree에서 실행 → Quality Gate → PASS → git commit → Done | Critical |
| 3 | Task가 git commit + push + PR | GitHub에서 PR 확인 가능 (prMode=true일 때) | Critical |
| 4 | 서버를 kill -9로 강제 종료 후 재시작 | 실행 중이던 task가 todo로 복원, 고아 프로세스 정리됨, 대시보드에서 정상 표시 | Critical |
| 5 | 에이전트가 Task A 완료 후 Task B 실행 | Task B의 프롬프트에 Task A 결과 요약 포함 | Nice-to-have |
| 6 | API 토큰 없이 curl로 API 호출 | 401 Unauthorized 응답 | Critical |

---

## 평가 기준 (Evaluation Criteria)

- **기능**: Sprint Contract의 모든 Critical 조건 PASS
- **설계 품질**: 기존 v0.2.0 코드와 일관된 패턴 (createLogger, broadcast, DB row types)
- **단순성**: 신규 모듈은 최소 3개 (auth.ts, recovery.ts, git-workflow.ts, worktree.ts, memory.ts), 각각 단일 책임
- **안전성**: 모든 git/subprocess 명령에 timeout, 실패 시 structured error

---

## 역방향 검증 체크리스트

- [x] Plan의 7개 MECE 문제 영역이 모두 설계에 반영됨
  - Trust Boundary → Sprint 1 (인증, CORS, 경로, 권한, WS, env)
  - E2E 미검증 → Sprint 2-4에서 실제 파이프라인 연결로 해소
  - Git Workflow → Sprint 3
  - 작업 격리 → Sprint 4
  - 복원력 → Sprint 2
  - Approval UX → Sprint 5
  - 차별화 해자 → Sprint 6
- [x] Paperclip 대비 차별화: Sprint 6의 Context Chain + 에이전트 메모리는 Paperclip에 없는 기능
- [x] X-Verify 결과 반영: Worktree 기본 + git repo 없으면 null fallback (Gemini 지적 수용)
- [x] 엣지 케이스:
  - git repo가 아닌 프로젝트 → worktree skip, 직접 실행
  - gh CLI 미설치 → PR 생성 skip (fail-silent)
  - rate limit 중 git workflow → 발생 불가 (verification PASS 후에만 git 실행)
  - 대규모 repo에서 worktree 느림 → worktree add는 O(파일수)이나 max 3개이므로 수용 가능
