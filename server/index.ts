import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { resolve, dirname, join } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import SQLite from "better-sqlite3";
import { createDatabase, migrate } from "./db/schema.js";
import { providerCliCheck } from "./core/preflight/provider-check.js";
import { pidLockCheck, runStartupPreflight } from "./core/preflight/index.js";
import { loadProviderConfig, setRuntimeProviderSubstitution } from "./core/agent/provider.js";
import { recoverOnStartup, rebroadcastPendingApprovals, resumeBlockedDelegatingParents } from "./core/recovery.js";
import { resumeRecoveredGoalSquashes, reconcileMergedGoalTasks } from "./core/orchestration/engine.js";
import { createProjectRoutes } from "./api/routes/projects.js";
import { createAgentRoutes } from "./api/routes/agents.js";
import { createTaskRoutes } from "./api/routes/tasks.js";
import { createVerificationRoutes } from "./api/routes/verification.js";
import { createGoalRoutes } from "./api/routes/goals.js";
import { createOrchestrationRoutes } from "./api/routes/orchestration.js";
import { createActivityRoutes } from "./api/routes/activities.js";
import { createFsRoutes } from "./api/routes/fs.js";
import { createSessionRoutes } from "./api/routes/sessions.js";
import { createRecoveryRoutes } from "./api/routes/recovery.js";
import { createWorkspaceRoutes } from "./api/routes/workspaces.js";
import { createTerminalRoutes } from "./api/routes/terminals.js";
import { createTerminalBridgeRoutes } from "./api/routes/terminal-bridge.js";
import { createTerminalActivityRoutes } from "./api/routes/terminal-activity.js";
import { createWSHandler } from "./api/websocket.js";
import { TerminalManager, type TerminalCommand } from "./core/terminal/manager.js";
import { reconcileInterruptedTerminalReviews } from "./core/terminal/review-loop.js";
import { agentActivityLog } from "./core/agent/activity-log.js";
import { readLatestCodexRateLimits } from "./core/agent/codex-usage.js";
import { flushVerificationBroadcastOutbox } from "./core/quality-gate/outbox.js";

import { loadOrCreateApiKey, authMiddleware, createScopedTerminalTokenValidator } from "./api/middleware/auth.js";
import type { Database } from "better-sqlite3";
import type { SessionManager } from "./core/agent/session.js";
import type { Scheduler } from "./core/orchestration/scheduler.js";

export interface ServerConfig {
  port: number;
  dataDir: string;
}

export interface AppContext {
  db: Database;
  wss: WebSocketServer;
  broadcast: (event: string, data: unknown) => void;
  sessionManager?: SessionManager;
  terminalManager?: TerminalManager;
  // Set by orchestration routes, used by goals/projects autopilot triggers
  orchestrationEngine?: {
    decomposeGoal: (goalId: string) => Promise<{ taskCount: number; projectId: string }>;
    generateGoalsFromMission: (projectId: string) => Promise<{ goalIds: string[] }>;
    executeTask: (taskId: string, config?: any) => Promise<{ success: boolean; verdict: string }>;
    applyPlanReviewGate: (goalId: string, config: { autopilot: string; taskIds?: string[] }) => Promise<void>;
  };
  generateGoalSpec?: (goalId: string) => Promise<any>;
  scheduler?: Scheduler;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function terminalBridgeCommand(entry: "crewdeck-sync" | "crewdeck-mcp"): TerminalCommand {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  if (currentFile.endsWith(".ts")) {
    return {
      command: resolve(currentDir, "../node_modules/.bin/tsx"),
      args: [resolve(currentDir, `../bin/${entry}.ts`)],
    };
  }
  return {
    command: process.execPath,
    args: [resolve(currentDir, `../bin/${entry}.js`)],
  };
}

/** 기존 DB를 건드리지 않고 고유한 새 디렉토리로 시작하는 안전한 임시 복구 명령. */
function isolatedDataDirectoryCommand(dataDir: string, port: number): string {
  const template = join(dataDir, "recovery-XXXXXX");
  return `npx crewdeck --data-dir="$(mktemp -d ${shellQuote(template)})" --port=${port}`;
}

export async function startServer(config: ServerConfig): Promise<void> {
  const { port, dataDir } = config;

  const dbPath = resolve(dataDir, "crewdeck.db");

  // 프로젝트/에이전트별 provider override 진단은 DB를 일반 모드로
  // 열거나 PID lock을 기록하기 전에 수행한다. createDatabase()는 호출 즉시
  // journal_mode=WAL을 적용하므로, 진단 실패 시 영속 DB를 변경하지 않으려면
  // 기존 DB는 read-only로만 조회해야 한다.
  if (existsSync(dbPath)) {
    const overrideProviders = new Set<string>();
    await runStartupPreflight([{
      id: "database",
      required: true,
      run: () => {
        try {
          const inspectionDb = new SQLite(dbPath, {
            readonly: true,
            fileMustExist: true,
          });
          try {
            const globalDefault = loadProviderConfig().defaultProvider;

            // PRAGMA table_info 는 존재하지 않는 테이블에 대해 빈 결과를 돌려준다.
            const hasColumn = (table: string, column: string): boolean =>
              (inspectionDb.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
                .some((c) => c.name === column);

            if (hasColumn("projects", "default_provider")) {
              for (const row of inspectionDb.prepare(
                "SELECT DISTINCT default_provider AS provider FROM projects WHERE status = 'active' AND default_provider IS NOT NULL",
              ).all() as { provider: string }[]) {
                overrideProviders.add(row.provider);
              }
            }
            if (hasColumn("agents", "provider")) {
              for (const row of inspectionDb.prepare(
                "SELECT DISTINCT a.provider AS provider FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.provider IS NOT NULL AND p.status = 'active' AND a.status != 'terminated'",
              ).all() as { provider: string }[]) {
                overrideProviders.add(row.provider);
              }
            }
            overrideProviders.delete(globalDefault);
          } finally {
            inspectionDb.close();
          }

          return {
            status: "pass" as const,
            summary: "기존 데이터베이스 read-only 검사 성공",
            detail: "provider override 설정을 DB 변경 없이 읽었습니다.",
            recoveryCommands: [],
          };
        } catch (error) {
          return {
            status: "fail" as const,
            summary: "기존 Crewdeck 데이터베이스를 읽을 수 없습니다.",
            detail:
              `${errorMessage(error)} 기존 DB를 복원하거나, ` +
              "아래 명령으로 기존 DB를 건드리지 않는 새 데이터 디렉토리를 사용하세요.",
            recoveryCommands: [isolatedDataDirectoryCommand(dataDir, port)],
          };
        }
      },
    }]);

    for (const provider of overrideProviders) {
      const check = providerCliCheck({
        agent: { provider },
        // 복구 재실행 명령이 현재 --data-dir·--port을 잃고 기본 위치로 별도 서버를
        // 시작하지 않도록 이 호출의 실행 컨텍스트를 함께 싣는다.
        restart: { dataDir, port },
        onResolved: (decision) => {
          if (decision.usedFallback && (provider === "claude" || provider === "codex")) {
            setRuntimeProviderSubstitution(provider, decision.provider);
          }
        },
      });
      await runStartupPreflight([{
        ...check,
        id: `provider-cli:${provider}`,
      }]);
    }
  }

  // Ensure data directory exists
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dataDir, { recursive: true });

  // PID lock — prevent multiple concurrent server instances from fighting
  // over the same SQLite file and scheduler polling loop. Observed incident
  // (2026-04-10): 3 stale tsx watch concurrently sessions coexisted for
  // hours, one holding port 7200 while the others tried repeatedly.
  //
  // 살아있는 인스턴스 탐지를 preflight 항목([pid-lock])으로 돌려, 요청 포트가
  // 비어 있어도 lock 충돌을 항목별 FAIL·안전한 복구 명령으로 노출한다. server.pid
  // 의 PID 는 재사용된 무관한 프로세스일 수 있어 '다른 서버 인스턴스'로 단정하지
  // 않는다. stale/없는 pid 파일은 아래에서 자동으로 덮어쓴다.
  const pidPath = resolve(dataDir, "server.pid");
  await runStartupPreflight([pidLockCheck(dataDir)]);
  try {
    writeFileSync(pidPath, String(process.pid), "utf-8");
  } catch (err: any) {
    console.warn(`[crewdeck] Could not write pid lock: ${err?.message ?? err}`);
  }

  // Initialize database only after every required diagnostic has passed.
  const db = createDatabase(dbPath);
  migrate(db);
  console.log(`  Database: ${dbPath}`);

  const recovery = recoverOnStartup(db);
  if (recovery.recoveredTasks > 0 || recovery.killedProcesses > 0) {
    console.log(`  Recovery: ${recovery.recoveredTasks} tasks restored, ${recovery.killedProcesses} orphan processes killed`);
  }
  const recoveredTerminalReviews = reconcileInterruptedTerminalReviews(db);
  if (recoveredTerminalReviews > 0) {
    console.log(`  Recovery: ${recoveredTerminalReviews} terminal Quality Gate review(s) made retryable`);
  }

  // 이 계약 배포 이전에 blocked+manual_action 으로 얼어붙은 위임 부모(delegating parent) self-heal
  // — HEAD-mismatch 오판으로 막혀 goal 전체가 deadlock 된 것을 재개해 autopilot 이 이어가게 한다.
  const resumedParents = resumeBlockedDelegatingParents(db);
  if (resumedParents > 0) {
    console.log(`  Recovery: resumed ${resumedParents} stuck delegating parent task(s)`);
  }

  // 반영(merged)됐지만 미완료 태스크가 남은 goal 정합화 — 반영 중 크래시나 과거 반영에서
  // 놓친 orphan 태스크를 종결해 "merged goal 은 라이브 태스크를 갖지 않는다" 불변식을 복원한다
  // (기동 시점엔 WS 클라이언트가 없어 broadcast 는 no-op — 대시보드는 접속 시 REST 로 최신 상태를 받는다).
  {
    const mergedGoalsWithLiveTasks = db.prepare(
      "SELECT DISTINCT g.id FROM goals g JOIN tasks t ON t.goal_id = g.id WHERE g.squash_status = 'merged' AND t.status != 'done'",
    ).all() as { id: string }[];
    let reconciledTaskCount = 0;
    for (const g of mergedGoalsWithLiveTasks) {
      reconciledTaskCount += reconcileMergedGoalTasks(db, () => {}, g.id);
    }
    if (reconciledTaskCount > 0) {
      console.log(`  Reconciliation: closed ${reconciledTaskCount} leftover task(s) on ${mergedGoalsWithLiveTasks.length} merged goal(s)`);
    }
  }

  // Express app
  const app = express();
  app.use(express.json());

  // CORS for dashboard dev server — localhost origins only
  // CORS: 대시보드 dev (5173) + 서버 자체 (동적 포트)
  const ALLOWED_ORIGINS = [
    "http://localhost:5173",
    `http://localhost:${port}`,
    "http://127.0.0.1:5173",
    `http://127.0.0.1:${port}`,
  ];
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // In-memory rate limiter — /api/ 전체 (express-rate-limit 없이 zero-dependency)
  //
  // ⚠ trust proxy가 없어 req.ip는 소켓 주소다. Tailscale serve로 노출하면 프록시가
  // loopback으로 재접속하므로 모든 tailnet 클라이언트가 127.0.0.1 한 버킷으로 합산된다
  // → 대시보드의 정상 재조회(오케스트레이션 중 refresh 폭주)가 429를 유발했다.
  // 따라서 loopback은 제한 면제(접근 통제는 tailnet + API 키가 담당)하고,
  // 직접 네트워크 노출(CREWDECK_HOST=0.0.0.0) 대비로 비-loopback만 제한한다.
  {
    const WINDOW_MS = 60_000; // 1분
    const MAX_REQUESTS = Number(process.env.CREWDECK_RATE_LIMIT) || 600; // 분당 (env override)
    const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
    // key → { count, windowStart }
    const hits = new Map<string, { count: number; windowStart: number }>();

    app.use("/api/", (req, res, next) => {
      const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
      // loopback(로컬 + Tailscale serve 프록시)은 제한하지 않는다
      if (LOOPBACK.has(key)) return next();
      const now = Date.now();
      const entry = hits.get(key);

      if (!entry || now - entry.windowStart >= WINDOW_MS) {
        hits.set(key, { count: 1, windowStart: now });
        return next();
      }

      entry.count += 1;
      if (entry.count > MAX_REQUESTS) {
        const retryAfter = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
        res.set("Retry-After", String(retryAfter));
        return res.status(429).json({ error: "Too Many Requests", retryAfter });
      }
      next();
    });
  }

  // API authentication
  const apiKey = loadOrCreateApiKey(dataDir);
  app.use(authMiddleware(apiKey, dataDir, createScopedTerminalTokenValidator(db)));

  // HTTP + WebSocket server
  const server = createServer(app);
  // Agent execution can take 10+ minutes — prevent Node.js default 2-min socket timeout
  server.timeout = 0; // Disable HTTP timeout (Claude CLI handles its own timeouts)
  server.keepAliveTimeout = 0;
  // 연결을 항상 수락하되, 인증 여부를 태깅 — proxy EPIPE 방지
  const wss = new WebSocketServer({ server, path: "/ws" });

  // 반환값 = 실제 전송에 성공한 인증된 client 수. quality-gate outbox가 이 수로
  // "진짜 전달됐는지"를 판단한다 (0이면 아직 아무도 못 받은 것 — delivered 처리 금지).
  const broadcast = (event: string, data: unknown): number => {
    const message = JSON.stringify({ type: event, payload: data, timestamp: new Date().toISOString() });
    let sent = 0;
    for (const client of wss.clients) {
      if (client.readyState === 1 && (client as any).__authenticated) {
        try { client.send(message); sent++; } catch { /* skip dead client */ }
      }
    }
    return sent;
  };

  const terminalManager = new TerminalManager(db, ({ type, payload }) => {
    const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
    for (const client of wss.clients) {
      const terminalIds = (client as any).__terminalIds as Set<string> | undefined;
      if (client.readyState === 1 && (client as any).__authenticated && terminalIds?.has(payload.terminalId)) {
        try { client.send(message); } catch { /* skip dead client */ }
      }
    }
    if (type === "terminal:exit") {
      broadcast("workspace:updated", { workspaceId: payload.workspaceId, projectId: payload.projectId });
      broadcast("project:updated", { projectId: payload.projectId });
    }
  }, {
    dataDir,
    apiBaseUrl: `http://127.0.0.1:${port}/api`,
    syncCommand: terminalBridgeCommand("crewdeck-sync"),
    mcpCommand: terminalBridgeCommand("crewdeck-mcp"),
  });
  const ctx: AppContext = { db, wss, broadcast, terminalManager };

  // Wire the agent activity ring buffer to WebSocket (throttled to 1/sec per agent)
  agentActivityLog.setBroadcaster(broadcast);

  // M-3: pending_approval goal broadcast 재발송 (broadcast 준비 후)
  rebroadcastPendingApprovals(db, broadcast);

  // WebSocket handler
  createWSHandler(wss, apiKey, () => {
    flushVerificationBroadcastOutbox(db, broadcast);
    // Startup reconciliation runs before any client can connect. Replay the
    // preserved approval surface after authentication without duplicating the
    // durable recovery incident/activity recorded above.
    rebroadcastPendingApprovals(db, broadcast, { recordIncident: false });
  }, {
    onTerminalSubscribe: (ws, terminalId) => {
      const terminal = terminalManager.get(terminalId);
      if (!terminal) return;
      try {
        ws.send(JSON.stringify({
          type: "terminal:snapshot",
          payload: { terminalId, data: terminal.output, status: terminal.status, exitCode: terminal.exitCode },
          timestamp: new Date().toISOString(),
        }));
      } catch { /* client disconnected */ }
    },
    onTerminalInput: (terminalId, data) => { terminalManager.write(terminalId, data); },
    onTerminalResize: (terminalId, cols, rows) => { terminalManager.resize(terminalId, cols, rows); },
  });

  // API routes
  app.use("/api/projects", createProjectRoutes(ctx));
  app.use("/api/agents", createAgentRoutes(ctx));
  app.use("/api/goals", createGoalRoutes(ctx));
  app.use("/api/tasks", createTaskRoutes(ctx));
  app.use("/api/verifications", createVerificationRoutes(ctx));
  app.use("/api/orchestration", createOrchestrationRoutes(ctx));
  app.use("/api/activities", createActivityRoutes(ctx));
  app.use("/api/fs", createFsRoutes());
  app.use("/api/sessions", createSessionRoutes(ctx));
  app.use("/api/recovery", createRecoveryRoutes(ctx));
  app.use("/api/workspaces", createWorkspaceRoutes(ctx));
  app.use("/api/terminals", createTerminalRoutes(ctx));
  app.use("/api/terminal-activities", createTerminalActivityRoutes(ctx));
  app.use("/api/terminal-bridge/activity", createTerminalActivityRoutes(ctx, { requireTerminalSessionIdForList: true }));
  app.use("/api/terminal-bridge", createTerminalBridgeRoutes(ctx));

  if (ctx.sessionManager) {
    void resumeRecoveredGoalSquashes(db, broadcast, ctx.sessionManager).catch((err) => {
      console.warn(`[crewdeck] Could not resume recovered goal squash pipeline: ${err?.message ?? err}`);
    });
  }

  // Health check
  app.get("/api/health", (_req, res) => {
    let version = "unknown";
    try {
      // dev: server/../package.json · dist: dist/server/../../package.json
      const here = dirname(fileURLToPath(import.meta.url));
      const pkgPath = [resolve(here, "..", "package.json"), resolve(here, "..", "..", "package.json")]
        .find((p) => existsSync(p));
      if (pkgPath) version = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
    } catch { /* fallback */ }
    res.json({ status: "ok", version });
  });

  // Claude Code status — read from ~/.claude/tmux-status (written by statusline.sh)
  const claudeStatusPath = resolve(process.env.HOME ?? "", ".claude", "tmux-status");
  app.get("/api/claude-status", (_req, res) => {
    try {
      const raw = readFileSync(claudeStatusPath, "utf-8").trim();
      const stat = statSync(claudeStatusPath);
      // Parse: " Opus 4.6 (1M context) │ ctx:8% │ ↑6K ↓24K │ $1.87 │ 5h:8%"
      const tokenMatch = raw.match(/↑(\d+)K\s*↓(\d+)K/);
      const costMatch = raw.match(/\$([0-9.]+)/);
      const rateMatch = raw.match(/5h:(\d+)%/);
      const weekMatch = raw.match(/7d:(\d+)%/);
      const modelMatch = raw.match(/^\s*(.+?)\s*│/);
      res.json({
        raw,
        model: modelMatch?.[1]?.trim() ?? null,
        inputTokensK: tokenMatch ? Number(tokenMatch[1]) : null,
        outputTokensK: tokenMatch ? Number(tokenMatch[2]) : null,
        costUsd: costMatch ? Number(costMatch[1]) : null,
        ratePercent: rateMatch ? Number(rateMatch[1]) : null,
        weekPercent: weekMatch ? Number(weekMatch[1]) : null,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch {
      res.json({ raw: null, error: "Claude status unavailable" });
    }
  });

  // Codex(GPT) 구독 사용량 — 최신 rollout 파일의 rate_limits (Claude 5h/7d 와 대칭)
  app.get("/api/codex-status", (_req, res) => {
    try {
      const rl = readLatestCodexRateLimits();
      if (!rl) {
        res.json({ available: false });
        return;
      }
      res.json({ available: true, ...rl });
    } catch {
      res.json({ available: false });
    }
  });

  // Crewdeck own session stats — independent of terminal Claude session
  app.get("/api/crewdeck-status", (_req, res) => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const stats = db.prepare(`
      SELECT
        COUNT(CASE WHEN s.status = 'active' THEN 1 END) as activeSessions,
        COALESCE(SUM(s.token_usage), 0) as totalTokens,
        COALESCE(SUM(s.cost_usd), 0) as totalCost
      FROM sessions s
    `).get() as { activeSessions: number; totalTokens: number; totalCost: number };

    const todayStats = db.prepare(`
      SELECT
        COALESCE(SUM(s.token_usage), 0) as todayTokens,
        COALESCE(SUM(s.cost_usd), 0) as todayCost
      FROM sessions s
      WHERE s.started_at >= ?
    `).get(today) as { todayTokens: number; todayCost: number };

    // 오늘 완료(merge)된 goal 수 — goal_merged activity 로 정확히 카운트.
    // (세션 누적 수는 goal-as-unit 의 fix/failover 반복량에 좌우되는 노이즈라 완료 goal 로 대체)
    const todayCompletedGoals = db.prepare(`
      SELECT COUNT(*) as count FROM activities
      WHERE type = 'goal_merged' AND created_at >= ?
    `).get(today) as { count: number };

    const activeAgents = db.prepare(
      "SELECT COUNT(*) as count FROM agents WHERE status = 'working'",
    ).get() as { count: number };

    // provider별(claude/codex) 활성 세션 + 오늘 토큰 — Codex 는 창 % 를 못 얻으므로 활성/토큰만.
    const providerRows = db.prepare(`
      SELECT COALESCE(provider, 'claude') AS provider,
             COUNT(CASE WHEN status = 'active' THEN 1 END) AS active,
             COALESCE(SUM(CASE WHEN started_at >= ? THEN token_usage ELSE 0 END), 0) AS todayTokens
      FROM sessions GROUP BY COALESCE(provider, 'claude')
    `).all(today) as { provider: string; active: number; todayTokens: number }[];
    const byProvider: Record<"claude" | "codex", { active: number; todayTokens: number }> = {
      claude: { active: 0, todayTokens: 0 },
      codex: { active: 0, todayTokens: 0 },
    };
    for (const r of providerRows) {
      const key = r.provider === "codex" ? "codex" : "claude";
      byProvider[key].active += r.active;
      byProvider[key].todayTokens += r.todayTokens;
    }

    res.json({
      activeSessions: stats.activeSessions,
      activeAgents: activeAgents.count,
      totalTokens: stats.totalTokens,
      totalCost: stats.totalCost,
      todayTokens: todayStats.todayTokens,
      todayCost: todayStats.todayCost,
      todayCompletedGoals: todayCompletedGoals.count,
      byProvider,
    });
  });

  // Serve dashboard (production build)
  // In dev: ../dashboard/dist, in built: ../dashboard (copied by build:dashboard)
  const serverDir = import.meta.dirname ?? __dirname;
  const dashboardPaths = [
    resolve(serverDir, "../dashboard"),       // built (dist/dashboard/)
    resolve(serverDir, "../dashboard/dist"),   // dev fallback
  ];
  const dashboardDist = dashboardPaths.find((p) => {
    try { return existsSync(resolve(p, "index.html")); } catch { return false; }
  }) ?? dashboardPaths[0];

  app.use(express.static(dashboardDist));
  app.get("/{*splat}", (_req, res) => {
    const indexPath = resolve(dashboardDist, "index.html");
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: "Dashboard not built. Run: npm run build:dashboard" });
    }
  });

  // Bind to localhost only by default (security: prevent network exposure)
  const host = process.env.CREWDECK_HOST ?? "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`  Server listening on ${host}:${port}`);

    // Auto-resume queues for autopilot projects after startup
    // CREWDECK_NO_AUTO_QUEUE=true disables this (useful during development to prevent
    // token waste when the server restarts frequently).
    if (ctx.scheduler && !process.env.CREWDECK_NO_AUTO_QUEUE) {
      const autopilotProjects = db.prepare(
        "SELECT id, name, autopilot FROM projects WHERE status = 'active' AND autopilot != 'off'",
      ).all() as { id: string; name: string; autopilot: string }[];

      for (const p of autopilotProjects) {
        if (!ctx.scheduler.isRunning(p.id)) {
          console.log(`  Auto-starting queue for autopilot project "${p.name}" (mode: ${p.autopilot})`);
          ctx.scheduler.startQueue(p.id);
        }
      }
    } else if (process.env.CREWDECK_NO_AUTO_QUEUE) {
      console.log("  Auto-queue disabled (CREWDECK_NO_AUTO_QUEUE is set)");
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n  Shutting down gracefully...");

    // 1. 실행 중인 에이전트 세션 종료
    if (ctx.sessionManager) {
      ctx.sessionManager.killAll();
    }
    ctx.terminalManager?.killAll();

    // 2. 스케줄러 정지: 모든 active 프로젝트 큐 중단
    if (ctx.scheduler) {
      const projects = db.prepare("SELECT id FROM projects WHERE status = 'active'").all() as { id: string }[];
      for (const p of projects) ctx.scheduler.stopQueue(p.id);
    }

    // 3. WebSocket / HTTP 종료
    wss.close();
    server.close();

    // 5. DB 정리: active 세션 → killed, DB 닫기
    db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE status = 'active'").run();
    db.close();

    // 6. PID lock 해제 — 내 pid인 경우에만 (stale lock overwrite 방지)
    try {
      if (existsSync(pidPath)) {
        const owned = readFileSync(pidPath, "utf-8").trim();
        if (owned === String(process.pid)) unlinkSync(pidPath);
      }
    } catch { /* best-effort */ }

    process.exit(0);
  };

  // 5초 timeout 후 강제 종료 (shutdown이 hang하는 경우 대비)
  process.on("SIGINT", () => { shutdown().finally(() => setTimeout(() => process.exit(1), 5000)); });
  process.on("SIGTERM", () => { shutdown().finally(() => setTimeout(() => process.exit(1), 5000)); });

  // Prevent server crash on unhandled errors
  process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught exception (server kept alive):", err.message);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] Unhandled rejection (server kept alive):", reason);
  });
}

// Auto-start when run directly (dev mode: tsx watch server/index.ts)
const isDirectRun = process.argv[1]?.endsWith("server/index.ts") ||
                    process.argv[1]?.endsWith("server/index.js");
if (isDirectRun) {
  const port = parseInt(process.env.PORT || "7200", 10);
  const dataDir = resolve(process.cwd(), process.env.CREWDECK_DATA_DIR || ".crewdeck");
  startServer({ port, dataDir }).catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
