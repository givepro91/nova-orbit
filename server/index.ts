import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { resolve, dirname } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDatabase, migrate } from "./db/schema.js";
import { recoverOnStartup, rebroadcastPendingApprovals } from "./core/recovery.js";
import { createProjectRoutes } from "./api/routes/projects.js";
import { createAgentRoutes } from "./api/routes/agents.js";
import { createTaskRoutes } from "./api/routes/tasks.js";
import { createVerificationRoutes } from "./api/routes/verification.js";
import { createGoalRoutes } from "./api/routes/goals.js";
import { createOrchestrationRoutes } from "./api/routes/orchestration.js";
import { createActivityRoutes } from "./api/routes/activities.js";
import { createFsRoutes } from "./api/routes/fs.js";
import { createSessionRoutes } from "./api/routes/sessions.js";
import { createWSHandler } from "./api/websocket.js";
import { agentActivityLog } from "./core/agent/activity-log.js";

import { loadOrCreateApiKey, authMiddleware } from "./api/middleware/auth.js";
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
  // Set by orchestration routes, used by goals/projects autopilot triggers
  orchestrationEngine?: {
    decomposeGoal: (goalId: string) => Promise<{ taskCount: number; projectId: string }>;
    generateGoalsFromMission: (projectId: string) => Promise<{ goalIds: string[] }>;
    executeTask: (taskId: string, config?: any) => Promise<{ success: boolean; verdict: string }>;
  };
  generateGoalSpec?: (goalId: string) => Promise<any>;
  scheduler?: Scheduler;
}

export async function startServer(config: ServerConfig): Promise<void> {
  const { port, dataDir } = config;

  // Ensure data directory exists
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dataDir, { recursive: true });

  // PID lock — prevent multiple concurrent server instances from fighting
  // over the same SQLite file and scheduler polling loop. Observed incident
  // (2026-04-10): 3 stale tsx watch concurrently sessions coexisted for
  // hours, one holding port 7200 while the others tried repeatedly. Stale
  // pid files (dead pid) are overwritten automatically.
  const pidPath = resolve(dataDir, "server.pid");
  if (existsSync(pidPath)) {
    try {
      const existingPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (Number.isFinite(existingPid) && existingPid !== process.pid) {
        let alive = false;
        try {
          process.kill(existingPid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) {
          console.error(
            `\n[crewdeck] 다른 서버 인스턴스가 이미 실행 중입니다 (pid ${existingPid}).`,
          );
          console.error(`  Lock file: ${pidPath}`);
          console.error(`  기존 프로세스를 종료하거나, 응답 없으면 수동으로 lock 파일을 삭제하세요.`);
          process.exit(1);
        }
        console.warn(`[crewdeck] stale pid lock (${existingPid} not alive), overwriting`);
      }
    } catch {
      // unreadable pid file — treat as stale
    }
  }
  try {
    writeFileSync(pidPath, String(process.pid), "utf-8");
  } catch (err: any) {
    console.warn(`[crewdeck] Could not write pid lock: ${err?.message ?? err}`);
  }

  // Initialize database
  const dbPath = resolve(dataDir, "crewdeck.db");
  const db = createDatabase(dbPath);
  migrate(db);
  console.log(`  Database: ${dbPath}`);

  const recovery = recoverOnStartup(db);
  if (recovery.recoveredTasks > 0 || recovery.killedProcesses > 0) {
    console.log(`  Recovery: ${recovery.recoveredTasks} tasks restored, ${recovery.killedProcesses} orphan processes killed`);
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

  // In-memory rate limiter — /api/ 전체: 분당 120요청
  // express-rate-limit 패키지 없이 구현 (zero-dependency)
  {
    const WINDOW_MS = 60_000; // 1분
    const MAX_REQUESTS = 120;
    // key → { count, windowStart }
    const hits = new Map<string, { count: number; windowStart: number }>();

    app.use("/api/", (req, res, next) => {
      const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
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
  app.use(authMiddleware(apiKey, dataDir));

  // HTTP + WebSocket server
  const server = createServer(app);
  // Agent execution can take 10+ minutes — prevent Node.js default 2-min socket timeout
  server.timeout = 0; // Disable HTTP timeout (Claude CLI handles its own timeouts)
  server.keepAliveTimeout = 0;
  // 연결을 항상 수락하되, 인증 여부를 태깅 — proxy EPIPE 방지
  const wss = new WebSocketServer({ server, path: "/ws" });

  const broadcast = (event: string, data: unknown) => {
    const message = JSON.stringify({ type: event, payload: data, timestamp: new Date().toISOString() });
    for (const client of wss.clients) {
      if (client.readyState === 1 && (client as any).__authenticated) {
        try { client.send(message); } catch { /* skip dead client */ }
      }
    }
  };

  const ctx: AppContext = { db, wss, broadcast };

  // Wire the agent activity ring buffer to WebSocket (throttled to 1/sec per agent)
  agentActivityLog.setBroadcaster(broadcast);

  // M-3: pending_approval goal broadcast 재발송 (broadcast 준비 후)
  rebroadcastPendingApprovals(db, broadcast);

  // WebSocket handler
  createWSHandler(wss, apiKey);

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
      const modelMatch = raw.match(/^\s*(.+?)\s*│/);
      res.json({
        raw,
        model: modelMatch?.[1]?.trim() ?? null,
        inputTokensK: tokenMatch ? Number(tokenMatch[1]) : null,
        outputTokensK: tokenMatch ? Number(tokenMatch[2]) : null,
        costUsd: costMatch ? Number(costMatch[1]) : null,
        ratePercent: rateMatch ? Number(rateMatch[1]) : null,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch {
      res.json({ raw: null, error: "Claude status unavailable" });
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
        COALESCE(SUM(s.cost_usd), 0) as todayCost,
        COUNT(*) as todaySessions
      FROM sessions s
      WHERE s.started_at >= ?
    `).get(today) as { todayTokens: number; todayCost: number; todaySessions: number };

    const activeAgents = db.prepare(
      "SELECT COUNT(*) as count FROM agents WHERE status = 'working'",
    ).get() as { count: number };

    res.json({
      activeSessions: stats.activeSessions,
      activeAgents: activeAgents.count,
      totalTokens: stats.totalTokens,
      totalCost: stats.totalCost,
      todayTokens: todayStats.todayTokens,
      todayCost: todayStats.todayCost,
      todaySessions: todayStats.todaySessions,
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
