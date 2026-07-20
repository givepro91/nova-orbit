import { Router } from "express";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { AppContext } from "../../index.js";
import { validateWorkdir } from "../../utils/validate-path.js";
import { analyzeProject } from "../../core/project/analyzer.js";
import { connectGitHub } from "../../core/project/github.js";
import { getOriginRemote, listOpenPullRequests } from "../../core/project/git-workflow.js";
import { createLogger } from "../../utils/logger.js";
import { promptLanguageRule } from "../../utils/language.js";
import { loadProviderConfig } from "../../core/agent/provider.js";
import { MAX_TASK_RETRIES, MAX_REASSIGNS } from "../../utils/constants.js";
import { getProjectGoalReports } from "../../core/orchestration/execution-report.js";
import { detectAnomalies } from "../../core/anomalies.js";

const log = createLogger("projects");

export function createProjectRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

  /** Transform raw DB row: parse github_config JSON string → github object for dashboard */
  function toProjectResponse(row: any): any {
    if (!row) return row;
    const { github_config, tech_stack, ...rest } = row;
    return {
      ...rest,
      github: github_config ? (() => { try { return JSON.parse(github_config); } catch { return null; } })() : null,
      tech_stack: tech_stack ? (() => { try { return JSON.parse(tech_stack); } catch { return null; } })() : null,
    };
  }

  // List all projects — enrich each with the execution engine(s) its agents
  // resolve to (agent.provider → project.default_provider → global default),
  // so the sidebar can show whether a project runs on Claude, Codex, or both.
  router.get("/", (_req, res) => {
    const projects = db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as any[];
    const globalDefault = loadProviderConfig().defaultProvider ?? "claude";
    const defaultByProject = new Map<string, string>(
      projects.map((p) => [p.id, p.default_provider || globalDefault]),
    );
    const providerSets = new Map<string, Set<string>>(projects.map((p) => [p.id, new Set<string>()]));
    const agentRows = db.prepare("SELECT project_id, provider FROM agents").all() as { project_id: string; provider: string | null }[];
    for (const a of agentRows) {
      const set = providerSets.get(a.project_id);
      if (!set) continue;
      set.add(a.provider || defaultByProject.get(a.project_id)!);
    }
    // Deterministic order (claude, then codex). Empty project (no agents) falls
    // back to its configured/default engine so the chip still reflects intent.
    const order = ["claude", "codex"];
    res.json(projects.map((p) => {
      const set = providerSets.get(p.id)!;
      const providers = (set.size > 0 ? [...set] : [defaultByProject.get(p.id)!])
        .sort((x, y) => order.indexOf(x) - order.indexOf(y));
      return { ...toProjectResponse(p), providers };
    }));
  });

  // Cross-project live activity — powers the sidebar working/waiting indicators.
  // DB-derived so it survives page reload; returns only non-idle projects (a
  // missing key = idle) to keep the payload small. Structured enum + counts
  // only — no user-facing strings; the dashboard localizes them.
  // NOTE: must be registered before "/:id" or Express captures it as id="activity".
  router.get("/activity", (_req, res) => {
    type Agg = {
      inProgress: number; workingAgents: number; specGen: number; squashRunning: number;
      pending: number; waitingAgents: number; squashPending: number; specPending: number;
    };
    const map = new Map<string, Agg>();
    const bump = (pid: string, key: keyof Agg, n: number) => {
      let a = map.get(pid);
      if (!a) {
        a = { inProgress: 0, workingAgents: 0, specGen: 0, squashRunning: 0, pending: 0, waitingAgents: 0, squashPending: 0, specPending: 0 };
        map.set(pid, a);
      }
      a[key] += n;
    };

    for (const r of db.prepare("SELECT project_id, COUNT(*) c FROM tasks WHERE status = 'in_progress' GROUP BY project_id").all() as any[])
      bump(r.project_id, "inProgress", r.c);
    for (const r of db.prepare("SELECT project_id, COUNT(*) c FROM tasks WHERE status = 'pending_approval' GROUP BY project_id").all() as any[])
      bump(r.project_id, "pending", r.c);
    for (const r of db.prepare("SELECT project_id, status, COUNT(*) c FROM agents WHERE status IN ('working', 'waiting_approval') GROUP BY project_id, status").all() as any[])
      bump(r.project_id, r.status === "working" ? "workingAgents" : "waitingAgents", r.c);
    for (const r of db.prepare("SELECT project_id, squash_status, COUNT(*) c FROM goals WHERE squash_status IN ('resolving', 'triggering', 'pending_approval') GROUP BY project_id, squash_status").all() as any[])
      bump(r.project_id, r.squash_status === "pending_approval" ? "squashPending" : "squashRunning", r.c);
    for (const r of db.prepare(`SELECT g.project_id, COUNT(*) c FROM goal_specs gs JOIN goals g ON g.id = gs.goal_id WHERE gs.prd_summary LIKE '%"_status":"generating"%' GROUP BY g.project_id`).all() as any[])
      bump(r.project_id, "specGen", r.c);
    // Blueprint(기획서) 승인 대기 — 승인 게이트가 실행을 막는 goal(marker on, 미고정, 실제 draft 존재).
    // assertExecutionAllowed / handleDecomposeGoal 게이트 조건과 동일.
    for (const r of db.prepare(`SELECT g.project_id, COUNT(*) c FROM goals g WHERE g.spec_approval_required = 1 AND g.execution_spec_version_id IS NULL AND EXISTS(SELECT 1 FROM goal_spec_versions v WHERE v.goal_id = g.id) GROUP BY g.project_id`).all() as any[])
      bump(r.project_id, "specPending", r.c);

    const out: Record<string, { state: "working" | "waiting"; activeCount: number; specPending: number }> = {};
    for (const [pid, a] of map) {
      const working = a.inProgress > 0 || a.workingAgents > 0 || a.specGen > 0 || a.squashRunning > 0;
      const waiting = a.pending > 0 || a.waitingAgents > 0 || a.squashPending > 0 || a.specPending > 0;
      // specPending 은 별도 필드로만 노출 — 사이드바가 전용 "승인 대기" 칩으로 표시하고,
      // activeCount(일반 작업/승인 집계)와 중복 계산하지 않는다.
      if (working) out[pid] = { state: "working", activeCount: a.inProgress, specPending: a.specPending };
      else if (waiting) out[pid] = { state: "waiting", activeCount: a.pending + a.squashPending + a.waitingAgents, specPending: a.specPending };
    }
    res.json(out);
  });

  // Get single project
  router.get("/:id", (req, res) => {
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(toProjectResponse(project));
  });

  router.get("/:id/goal-reports", (req, res) => {
    const reports = getProjectGoalReports(db, req.params.id);
    if (!reports) return res.status(404).json({ error: "Project not found" });
    res.json(reports);
  });

  /** 관찰 패널 — 상태 사이의 모순만 계산해서 돌려준다. */
  router.get("/:id/anomalies", (req, res) => {
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(detectAnomalies(db, req.params.id));
  });

  // Create project
  router.post("/", (req, res) => {
    const { name, mission, source = "new", workdir = "", github_config, tech_stack } = req.body;

    if (!name) return res.status(400).json({ error: "name is required" });

    // Validate workdir if provided
    let validatedWorkdir = workdir;
    if (workdir && workdir.trim()) {
      try {
        validatedWorkdir = validateWorkdir(workdir);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }
    }

    const result = db.prepare(`
      INSERT INTO projects (name, mission, source, workdir, github_config, tech_stack)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name,
      mission ?? "",
      source,
      validatedWorkdir,
      github_config ? JSON.stringify(github_config) : null,
      tech_stack ? JSON.stringify(tech_stack) : null,
    );

    const project = toProjectResponse(db.prepare("SELECT * FROM projects WHERE rowid = ?").get(result.lastInsertRowid));
    broadcast("project:updated", project);
    res.status(201).json(project);
  });

  // Update project
  router.patch("/:id", (req, res) => {
    // Accept both `github_config` (snake_case) and `github` (camelCase from dashboard)
    const { name, mission, status, workdir: rawWorkdir, tech_stack, autopilot, dev_port, base_branch, default_provider, max_concurrency } = req.body;
    const github_config = req.body.github_config ?? req.body.github;

    // max_concurrency: goal 병렬 상한 (null = 전역 CREWDECK_MAX_CONCURRENCY 상속, 1..16 = 지정)
    if (max_concurrency !== undefined && max_concurrency !== null) {
      const n = Number(max_concurrency);
      if (!Number.isInteger(n) || n < 1 || n > 16) {
        return res.status(400).json({ error: "Invalid max_concurrency — integer 1..16, or null to inherit global default" });
      }
    }

    // default_provider: 프로젝트 기본 실행 백엔드 (null = 전역 기본 상속)
    if (default_provider !== undefined && default_provider !== null && !["claude", "codex"].includes(default_provider)) {
      return res.status(400).json({ error: "Invalid default_provider. Must be one of: claude, codex (or null to inherit global)" });
    }

    // base_branch: squash/PR 반영 대상 브랜치 — 안전한 브랜치명만 허용
    if (base_branch !== undefined) {
      if (
        typeof base_branch !== "string" ||
        base_branch.trim().length === 0 ||
        base_branch.trim().length > 100 ||
        !/^[A-Za-z0-9._/-]+$/.test(base_branch.trim()) ||
        base_branch.trim().startsWith("-")
      ) {
        return res.status(400).json({ error: "Invalid base_branch — use a plain branch name (letters, digits, ., _, /, -)" });
      }
    }
    const existing = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: "Project not found" });

    // Validate workdir if provided
    let workdir = rawWorkdir;
    if (rawWorkdir !== undefined && rawWorkdir !== "") {
      try {
        workdir = validateWorkdir(rawWorkdir);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }
    }

    // Validate autopilot mode
    const VALID_AUTOPILOT = ["off", "goal", "full"];
    if (autopilot !== undefined && !VALID_AUTOPILOT.includes(autopilot)) {
      return res.status(400).json({ error: `Invalid autopilot mode. Must be one of: ${VALID_AUTOPILOT.join(", ")}` });
    }

    // Full mode requires mission and CTO agent
    if (autopilot === "full") {
      const proj = db.prepare("SELECT mission FROM projects WHERE id = ?").get(req.params.id) as any;
      const effectiveMission = mission ?? proj?.mission;
      if (!effectiveMission || effectiveMission.trim() === "") {
        return res.status(400).json({ error: "Full autopilot requires a project mission" });
      }
      const cto = db.prepare("SELECT id FROM agents WHERE project_id = ? AND role = 'cto' LIMIT 1").get(req.params.id);
      if (!cto) {
        return res.status(400).json({ error: "Full autopilot requires a CTO agent in the team" });
      }
    }

    // dev_port: undefined = 변경 없음, null = 초기화(자동할당), number = 지정
    const devPortClause = dev_port !== undefined ? "dev_port = ?," : "";
    const devPortParams = dev_port !== undefined ? [dev_port] : [];

    // default_provider: undefined = 변경 없음, null = 전역 상속으로 초기화, "claude"|"codex" = 지정
    const provClause = default_provider !== undefined ? "default_provider = ?," : "";
    const provParams = default_provider !== undefined ? [default_provider] : [];

    // max_concurrency: undefined = 변경 없음, null = 전역 상속으로 초기화, number = 지정
    const concClause = max_concurrency !== undefined ? "max_concurrency = ?," : "";
    const concParams = max_concurrency !== undefined ? [max_concurrency === null ? null : Number(max_concurrency)] : [];

    db.prepare(`
      UPDATE projects SET
        name = COALESCE(?, name),
        mission = COALESCE(?, mission),
        status = COALESCE(?, status),
        workdir = COALESCE(?, workdir),
        github_config = COALESCE(?, github_config),
        tech_stack = COALESCE(?, tech_stack),
        autopilot = COALESCE(?, autopilot),
        base_branch = COALESCE(?, base_branch),
        ${devPortClause}
        ${provClause}
        ${concClause}
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ?? null,
      mission ?? null,
      status ?? null,
      workdir ?? null,
      github_config ? JSON.stringify(github_config) : null,
      tech_stack ? JSON.stringify(tech_stack) : null,
      autopilot ?? null,
      base_branch !== undefined ? base_branch.trim() : null,
      ...devPortParams,
      ...provParams,
      ...concParams,
      req.params.id,
    );

    const updated = toProjectResponse(db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id));
    broadcast("project:updated", updated);
    broadcast("autopilot:mode-changed", { projectId: req.params.id, mode: autopilot ?? existing.autopilot });
    res.json(updated);

    // Trigger Full autopilot if switching to 'full' from another mode.
    // Skip CTO mission re-generation when incomplete goals already exist —
    // the scheduler will resume them. This prevents accidental goal
    // inflation (and sort_order collisions) when users toggle
    // full → semi → full mid-execution.
    if (autopilot === "full" && existing.autopilot !== "full") {
      const incomplete = db.prepare(
        "SELECT COUNT(*) as cnt FROM goals WHERE project_id = ? AND progress < 100",
      ).get(req.params.id) as { cnt: number };
      if (incomplete.cnt === 0) {
        triggerFullAutopilot(req.params.id);
      } else {
        // Ensure the queue is actually running. If the queue had auto-stopped
        // (e.g. all tasks were blocked without retries when the user switched
        // away), we must restart it so remaining goals can make progress.
        // startQueue is a no-op when the queue is already running.
        if (ctx.scheduler && !ctx.scheduler.isRunning(req.params.id)) {
          ctx.scheduler.startQueue(req.params.id);
          log.info(`Full autopilot re-entry: ${incomplete.cnt} incomplete goal(s) exist, restarted stopped queue`);
        } else {
          log.info(`Full autopilot re-entry: ${incomplete.cnt} incomplete goal(s) exist, queue already running — skipping mission generation`);
        }
      }
    }

    // Autopilot off → goal/full: rescue pending goals AND start queue for
    // existing todo tasks. Without this:
    //   (a) Goals created in manual mode stay at 0 tasks (no decompose)
    //   (b) Already-decomposed goals with todo tasks sit idle (no queue)
    // Both are confusing — user enables autopilot expecting work to start.
    const switchedOn =
      autopilot && autopilot !== "off" && existing.autopilot === "off";
    if (switchedOn) {
      rescuePendingGoals(req.params.id);

      // Start queue if there are existing todo tasks waiting to run
      const existingTodo = db.prepare(
        "SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ? AND status = 'todo' AND assignee_id IS NOT NULL",
      ).get(req.params.id) as { cnt: number };

      if (existingTodo.cnt > 0 && ctx.scheduler) {
        if (!ctx.scheduler.isRunning(req.params.id)) {
          ctx.scheduler.startQueue(req.params.id);
          log.info(`Autopilot on: started queue for ${existingTodo.cnt} existing todo task(s)`);
        }
        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot', ?)",
        ).run(
          req.params.id,
          `자동 실행 시작 — 대기 중인 태스크 ${existingTodo.cnt}개를 자동으로 진행합니다`,
        );
        broadcast("project:updated", { projectId: req.params.id });
      }
    }

    // Autopilot goal/full → off: stop the queue. Previously the PATCH only
    // updated the DB row and broadcast, leaving the scheduler poll loop
    // running in the background. The next poll would still pick `todo`
    // tasks, spawn architect, and the user would see "에이전트가 자꾸
    // 작업하려고 한다" despite manual mode being on. Also clear ghost
    // working agents whose runtime context is gone — without this they
    // get stuck on the dashboard as "working" forever.
    const switchedOff =
      autopilot === "off" && existing.autopilot && existing.autopilot !== "off";
    if (switchedOff) {
      if (ctx.scheduler) {
        try { ctx.scheduler.stopQueue(req.params.id); } catch { /* best-effort */ }
      }
      // Kill active agent sessions so processes stop consuming tokens.
      const activeAgents = db.prepare(
        "SELECT DISTINCT agent_id FROM sessions WHERE status = 'active' AND agent_id IN (SELECT id FROM agents WHERE project_id = ?)",
      ).all(req.params.id) as { agent_id: string }[];
      for (const s of activeAgents) {
        ctx.sessionManager?.killSession(s.agent_id);
      }
      // 진행 중이던 task를 todo로 되돌려 다음 수동 실행 시 깨끗한 상태에서
      // 시작. 비파괴(retry_count 유지)로 둠.
      db.prepare(
        "UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE project_id = ? AND status IN ('in_progress', 'in_review', 'pending_approval')",
      ).run(req.params.id);
      // Working 상태 ghost agent + session 정리.
      db.prepare(
        "UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE project_id = ? AND status = 'working'",
      ).run(req.params.id);
      db.prepare(
        "UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE status = 'active' AND agent_id IN (SELECT id FROM agents WHERE project_id = ?)",
      ).run(req.params.id);
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_off', ?)",
      ).run(
        req.params.id,
        `수동 모드로 전환 — 큐 정지, 진행 중 작업 todo로 되돌림`,
      );
      broadcast("queue:stopped", { projectId: req.params.id });
      broadcast("project:updated", { projectId: req.params.id });
      log.info(`Autopilot off: queue stopped + ghost state cleaned for ${req.params.id}`);
    }
  });

  /**
   * Kick spec generation + decompose for any goal in this project that has
   * progress=0 AND no tasks yet. Runs async; errors are logged and surfaced
   * as activity rows so the dashboard can show them.
   */
  function rescuePendingGoals(projectId: string): void {
    // Sequential goal processing: only rescue the FIRST pending goal by priority,
    // and ONLY if no goal is already in progress. The scheduler's
    // triggerGoalProcessingIfNeeded handles subsequent goals after the current
    // one completes. Rescuing while another goal has active tasks causes
    // parallel spec generation, wasting tokens and violating the 1-goal-at-a-time model.

    // Pre-step: recalculate progress for goals with permanently-blocked tasks.
    // Without this, a goal at 75% (6 done + 2 permanently blocked) looks incomplete
    // and blocks the pending-goal query from finding the real next goal.
    const staleGoals = db.prepare(`
      SELECT g.id, g.progress FROM goals g
      WHERE g.project_id = ? AND g.progress < 100
        AND (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id) > 0
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.goal_id = g.id AND t.status NOT IN ('done', 'blocked', 'skipped')
        )
    `).all(projectId) as { id: string; progress: number }[];

    for (const sg of staleGoals) {
      const stats = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status IN ('done', 'skipped') THEN 1 ELSE 0 END) as done,
               SUM(CASE WHEN status = 'blocked' AND retry_count >= ? AND reassign_count >= ? THEN 1 ELSE 0 END) as perm_blocked
        FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
      `).get(MAX_TASK_RETRIES, MAX_REASSIGNS, sg.id) as { total: number; done: number; perm_blocked: number };

      const effective = stats.total - stats.perm_blocked;
      const progress = effective > 0 ? Math.round((stats.done / effective) * 100) : 100;
      if (progress !== sg.progress) {
        db.prepare("UPDATE goals SET progress = ? WHERE id = ?").run(progress, sg.id);
        log.info(`Rescue pre-step: updated goal ${sg.id} progress ${sg.progress}% → ${progress}% (excluding ${stats.perm_blocked} permanently blocked)`);
        broadcast("project:updated", { projectId });
      }
    }

    // Guard: if any goal still has tasks that can make progress (not done AND
    // not permanently blocked), the scheduler should handle it first.
    // Retryable blocked tasks (retry or reassign budget remaining) count as active.
    const activeGoal = db.prepare(`
      SELECT g.id FROM goals g
      WHERE g.project_id = ? AND g.progress < 100
        AND EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.goal_id = g.id
            AND t.status NOT IN ('done', 'skipped')
            AND NOT (t.status = 'blocked' AND t.retry_count >= ? AND t.reassign_count >= ?)
        )
      LIMIT 1
    `).get(projectId, MAX_TASK_RETRIES, MAX_REASSIGNS) as { id: string } | undefined;

    if (activeGoal) {
      log.info(`Rescue skipped: goal ${activeGoal.id} still has actionable tasks — scheduler will handle it`);
      return;
    }

    const pending = db.prepare(`
      SELECT g.id, g.title, gs.id AS spec_id,
             COALESCE(json_extract(gs.prd_summary, '$._status'), '') AS spec_status
      FROM goals g
      LEFT JOIN goal_specs gs ON gs.goal_id = g.id
      WHERE g.project_id = ?
        AND g.progress < 100
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id)
      ORDER BY
        CASE g.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        g.sort_order ASC,
        g.created_at ASC
      LIMIT 1
    `).all(projectId) as Array<{
      id: string;
      title: string;
      spec_id: string | null;
      spec_status: string;
    }>;

    if (pending.length === 0) return;

    const g = pending[0];
    log.info(
      `Autopilot enabled: rescuing 1 pending goal for project ${projectId} (next by priority: "${g.title}")`,
    );
    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_rescue', ?)",
    ).run(
      projectId,
      `Autopilot 전환 감지 — 다음 목표 기획서/작업 분할 시작: ${g.title.slice(0, 80)}`,
    );
    broadcast("project:updated", { projectId });

    {
      // Case 1: spec missing or failed → generate spec, then decompose
      const needSpec = !g.spec_id || g.spec_status === "failed";
      // Case 2: spec still generating → leave alone, it will trigger
      // decompose itself when the in-flight generation completes
      const stillGenerating = g.spec_status === "generating";

      if (stillGenerating) {
        log.info(`Rescue skipping goal ${g.id} — spec still generating`);
        return;
      }

      if (needSpec) {
        if (!ctx.generateGoalSpec) {
          log.warn(`Rescue cannot run: generateGoalSpec not wired yet for goal ${g.id}`);
          return;
        }
        // Placeholder spec row so UI reflects progress.
        // Use INSERT OR IGNORE + conditional UPDATE to avoid overwriting
        // a user-edited spec that exists but was marked as failed.
        db.prepare(
          `INSERT OR IGNORE INTO goal_specs
             (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by)
           VALUES (?, '{"_status":"generating"}', '[]', '[]', '[]', '[]', 'ai')`,
        ).run(g.id);
        db.prepare(
          `UPDATE goal_specs SET prd_summary = '{"_status":"generating"}', updated_at = datetime('now')
           WHERE goal_id = ? AND json_extract(prd_summary, '$._status') IN ('failed', NULL)`,
        ).run(g.id);
        broadcast("project:updated", { projectId });

        ctx.generateGoalSpec(g.id)
          .then(() => {
            log.info(`Rescue: spec generated for goal ${g.id}, triggering decompose`);
            broadcast("project:updated", { projectId });
            if (ctx.orchestrationEngine) {
              ctx.orchestrationEngine.decomposeGoal(g.id).then(async () => {
                // Plan review gate in goal/full autopilot mode
                const proj = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
                if (proj && (proj.autopilot === "goal" || proj.autopilot === "full")) {
                  await ctx.orchestrationEngine!.applyPlanReviewGate(g.id, { autopilot: proj.autopilot });
                  broadcast("project:updated", { projectId });
                  log.info(`Rescue: plan review gate applied for goal ${g.id}`);
                }
              }).catch((err: any) => {
                log.error(`Rescue decompose failed for goal ${g.id}`, err);
                db.prepare(
                  "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)",
                ).run(
                  projectId,
                  `작업 분할 실패 (${g.title}): ${String(err?.message ?? err).slice(0, 160)}`,
                );
                broadcast("project:updated", { projectId });
              });
            }
          })
          .catch((err: any) => {
            log.error(`Rescue spec generation failed for goal ${g.id}`, err);
            const errorMsg = String(err?.message ?? err).slice(0, 200).replace(/"/g, "'");
            db.prepare(
              "UPDATE goal_specs SET prd_summary = ?, updated_at = datetime('now') WHERE goal_id = ?",
            ).run(
              JSON.stringify({ _status: "failed", _error: errorMsg }),
              g.id,
            );
            broadcast("project:updated", { projectId });
          });
      } else {
        // Case 3: spec already complete → go straight to decompose
        if (!ctx.orchestrationEngine) {
          log.warn(`Rescue cannot run: orchestrationEngine not wired yet for goal ${g.id}`);
          return;
        }
        log.info(`Rescue: spec already exists for goal ${g.id}, triggering decompose directly`);
        ctx.orchestrationEngine.decomposeGoal(g.id).then(async () => {
          // Plan review gate in goal/full autopilot mode
          const proj = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
          if (proj && (proj.autopilot === "goal" || proj.autopilot === "full")) {
            await ctx.orchestrationEngine!.applyPlanReviewGate(g.id, { autopilot: proj.autopilot });
            broadcast("project:updated", { projectId });
            log.info(`Rescue: plan review gate applied for goal ${g.id}`);
          }
        }).catch((err: any) => {
          log.error(`Rescue decompose failed for goal ${g.id}`, err);
          db.prepare(
            "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)",
          ).run(
            projectId,
            `작업 분할 실패 (${g.title}): ${String(err?.message ?? err).slice(0, 160)}`,
          );
          broadcast("project:updated", { projectId });
        });
      }
    }
  }

  // GitHub 연동 판정: 실제 git origin remote를 조회(read-only, gh api 없음).
  // source 문자열이 아니라 실제 remote를 보므로 "로컬 임포트지만 origin이 GitHub"도 잡는다.
  router.get("/:id/git-remote", (req, res) => {
    const project = db.prepare("SELECT workdir FROM projects WHERE id = ?").get(req.params.id) as { workdir: string | null } | undefined;
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.workdir) return res.json({ hasOrigin: false, isGitHub: false, repo: null, remoteUrl: null });
    res.json(getOriginRemote(project.workdir));
  });

  // 프로젝트 origin의 열린 PR 목록 — "아직 main에 반영 안 됨" 신호. gh pr list(수 초 소요).
  router.get("/:id/pull-requests", (req, res) => {
    const project = db.prepare("SELECT workdir FROM projects WHERE id = ?").get(req.params.id) as { workdir: string | null } | undefined;
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.workdir) return res.json({ pullRequests: [] });
    res.json({ pullRequests: listOpenPullRequests(project.workdir) });
  });

  // ─── Agent branch management ───────────────────────────

  /** List unmerged agent/* branches for a project */
  router.get("/:id/branches", (req, res) => {
    const project = db.prepare("SELECT workdir FROM projects WHERE id = ?").get(req.params.id) as { workdir: string } | undefined;
    if (!project?.workdir) return res.status(404).json({ error: "Project not found or no workdir" });

    // spawnSync imported at top level
    const result = spawnSync("git", ["branch", "--list", "agent/*"], {
      cwd: project.workdir, stdio: "pipe", timeout: 10_000, encoding: "utf-8",
    });
    if (result.status !== 0) return res.json({ branches: [] });

    const branches = result.stdout.split("\n")
      .map((b: string) => b.replace(/^\*?\s*/, "").trim())
      .filter((b: string) => b && b.startsWith("agent/"));

    res.json({ branches });
  });

  /**
   * Merge all agent branches via AI agent.
   * Agent resolves conflicts intelligently instead of failing on git merge.
   * Flow: find suitable agent → send merge prompt → agent resolves & commits.
   */
  router.post("/:id/branches/merge-all", async (req, res) => {
    const projectId = req.params.id;
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as any;
    if (!project?.workdir) return res.status(404).json({ error: "Project not found or no workdir" });

    const { getDefaultBranch } = await import("../../core/project/git-workflow.js");
    const targetBranch = getDefaultBranch(project.workdir);

    // List agent branches
    const listResult = spawnSync("git", ["branch", "--list", "agent/*"], {
      cwd: project.workdir, stdio: "pipe", timeout: 10_000, encoding: "utf-8",
    });
    if (listResult.status !== 0) return res.json({ status: "error", error: "Failed to list branches" });

    const branches = listResult.stdout.split("\n")
      .map((b: string) => b.replace(/^\*?\s*/, "").trim())
      .filter((b: string) => b && b.startsWith("agent/"));

    if (branches.length === 0) return res.json({ status: "no_branches" });

    // Find best agent: CTO > any idle coder/backend/frontend > first idle agent
    const agents = db.prepare(
      "SELECT id, name, role, status FROM agents WHERE project_id = ? ORDER BY CASE role WHEN 'cto' THEN 0 WHEN 'backend' THEN 1 WHEN 'frontend' THEN 2 WHEN 'coder' THEN 3 ELSE 9 END"
    ).all(projectId) as any[];

    const agent = agents.find((a: any) => a.status === "idle")
      ?? agents.find((a: any) => a.status !== "working");
    if (!agent) return res.status(409).json({ error: "No available agent — all agents are busy" });

    // Build merge prompt
    const branchList = branches.map(b => `  - ${b}`).join("\n");
    const mergePrompt = `# Branch Merge Task

다음 에이전트 브랜치들을 \`${targetBranch}\` 브랜치에 합쳐주세요.

## 브랜치 목록
${branchList}

## 작업 순서
1. 현재 \`${targetBranch}\` 브랜치로 checkout
2. 각 브랜치를 하나씩 merge (--no-ff):
   - 충돌이 없으면 그대로 진행
   - **충돌이 발생하면**: 양쪽 코드를 읽고 의미를 이해한 뒤 올바르게 해결. 두 변경사항을 모두 살리는 방향으로 합치되, 중복이나 문법 오류가 없도록 주의
3. 각 merge 완료 후 해당 브랜치 삭제 (\`git branch -d <branch>\`)
4. 모든 merge 완료 후 최종 상태 확인 (\`git log --oneline -10\`)

## 주의사항
- 절대 코드를 임의로 삭제하지 마세요. 두 브랜치의 변경사항을 모두 보존하세요.
- merge commit 메시지는 \`chore: merge agent branches into ${targetBranch}\` 형식으로.
- push하지 마세요 (로컬 merge만).
- 작업 완료 후 남은 agent/* 브랜치가 없는지 확인하세요.`;

    // Return immediately — run asynchronously via agent
    res.json({ status: "started", agentId: agent.id, agentName: agent.name, branches });

    // Async: spawn agent and execute merge
    const sm = ctx.sessionManager;
    if (!sm) {
      log.error("sessionManager not initialized — cannot merge branches");
      return;
    }
    (async () => {
      db.prepare("UPDATE agents SET status = 'working', current_activity = 'branch_merge' WHERE id = ?").run(agent.id);
      broadcast("agent:status", { id: agent.id, name: agent.name, status: "working", activity: "branch_merge" });
      broadcast("project:branch-merge-started", { projectId, agentId: agent.id, agentName: agent.name, branches });

      let session;
      try {
        session = sm.spawnAgent(agent.id, project.workdir);
        session.on("output", (text: string) => {
          broadcast("agent:output", { agentId: agent.id, output: text });
        });

        const result = await session.send(mergePrompt);
        const { parseAgentOutput } = await import("../../core/agent/adapters/stream-parser.js");
        const parsed = parseAgentOutput(result.stdout, result.provider);

        // Check remaining branches after merge
        const afterResult = spawnSync("git", ["branch", "--list", "agent/*"], {
          cwd: project.workdir, stdio: "pipe", timeout: 10_000, encoding: "utf-8",
        });
        const remaining = (afterResult.stdout?.toString() ?? "").split("\n")
          .map((b: string) => b.replace(/^\*?\s*/, "").trim())
          .filter((b: string) => b && b.startsWith("agent/"));

        const mergedCount = branches.length - remaining.length;

        broadcast("project:branch-merge-complete", {
          projectId,
          agentId: agent.id,
          merged: mergedCount,
          remaining,
          summary: parsed.text?.slice(0, 500) || "",
        });

        db.prepare(
          "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'branch_merge', ?)",
        ).run(projectId, agent.id,
          `Merged ${mergedCount}/${branches.length} agent branches into ${targetBranch}${remaining.length > 0 ? ` (${remaining.length} remaining)` : ""}`);

      } catch (err: any) {
        broadcast("project:branch-merge-complete", {
          projectId, agentId: agent.id, error: err.message, merged: 0, remaining: branches,
        });
      } finally {
        // finally must never throw — wrap each side-effect so a single failure
        // doesn't become an unhandled rejection
        try { sm.killSession(agent.id); } catch (e: any) { log.warn(`merge cleanup: killSession failed — ${e?.message ?? e}`); }
        try {
          db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(agent.id);
        } catch (e: any) { log.warn(`merge cleanup: agent status reset failed — ${e?.message ?? e}`); }
        try { broadcast("agent:status", { id: agent.id, name: agent.name, status: "idle" }); } catch { /* ignore */ }
      }
    })().catch((err: any) => {
      // Defense-in-depth: catch anything the try/catch missed so Node never
      // sees an unhandled promise rejection from this IIFE.
      log.error(`merge-all IIFE crashed unexpectedly: ${err?.message ?? err}`);
    });
  });

  /** Delete all agent branches (force) */
  router.delete("/:id/branches", (req, res) => {
    const project = db.prepare("SELECT workdir FROM projects WHERE id = ?").get(req.params.id) as { workdir: string } | undefined;
    if (!project?.workdir) return res.status(404).json({ error: "Project not found or no workdir" });

    // spawnSync imported at top level
    const listResult = spawnSync("git", ["branch", "--list", "agent/*"], {
      cwd: project.workdir, stdio: "pipe", timeout: 10_000, encoding: "utf-8",
    });
    if (listResult.status !== 0) return res.json({ deleted: [] });

    const branches = listResult.stdout.split("\n")
      .map((b: string) => b.replace(/^\*?\s*/, "").trim())
      .filter((b: string) => b && b.startsWith("agent/"));

    const deleted: string[] = [];
    for (const branch of branches) {
      const r = spawnSync("git", ["branch", "-D", branch], { cwd: project.workdir, stdio: "pipe", timeout: 5_000 });
      if (r.status === 0) deleted.push(branch);
    }

    broadcast("project:branches-deleted", { projectId: req.params.id, deleted });
    res.json({ deleted });
  });

  // AI-powered mission suggestion
  router.post("/:id/suggest-mission", async (req, res) => {
    req.setTimeout(300000);
    res.setTimeout(300000);
    const { language } = req.body ?? {};
    // mode: "options"(기본, 발산 방향 3~4개) | "question"(질문먼저 하이브리드의 1단계).
    // answer: interview 2단계에서 사용자가 고른/입력한 방향 답변(stateless — 세션 유지 없이 파라미터로 재주입).
    const mode = req.body?.mode === "question" ? "question" : "options";
    const answer = typeof req.body?.answer === "string" ? req.body.answer.slice(0, 2000).trim() : "";
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(req.params.id) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    const agent = (db.prepare(
      "SELECT * FROM agents WHERE project_id = ? AND role IN ('cto', 'pm') LIMIT 1",
    ).get(project.id) as any)
      ?? (db.prepare("SELECT * FROM agents WHERE project_id = ? LIMIT 1").get(project.id) as any);

    if (!agent) return res.status(400).json({ error: "No agents available" });

    const techStack = project.tech_stack ? JSON.parse(project.tech_stack) : null;
    const techInfo = techStack
      ? `\nTech Stack: ${techStack.languages?.join(", ")} / ${techStack.frameworks?.join(", ")}`
      : "";

    // Load project docs for context
    let docsContext = "";
    if (project.workdir) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      for (const docFile of ["CLAUDE.md", "README.md"]) {
        const p = path.join(project.workdir, docFile);
        try {
          if (fs.existsSync(p)) {
            docsContext += `\n\n[${docFile}]\n${fs.readFileSync(p, "utf-8").slice(0, 3000)}`;
            break;
          }
        } catch { /* skip */ }
      }
    }

    // Existing goals for context
    const goals = db.prepare("SELECT title FROM goals WHERE project_id = ?").all(project.id) as any[];
    const goalsContext = goals.length > 0
      ? `\n\nExisting goals:\n${goals.map((g: any) => `- ${g.title}`).join("\n")}`
      : "";

    const baseContext = `Project: ${project.name}
Current Mission: ${project.mission || "(not set)"}${techInfo}${goalsContext}${docsContext}`;
    const langRule = promptLanguageRule(language, "Respond in the same language as the project name/docs (Korean if Korean, English if English)");

    // question 모드: 방향을 아직 못 정한 창업자에게 던질 질문 1개 + 선택 칩. (하이브리드 A+B의 1단계)
    // options 모드: 야망 축으로 벌린 발산 방향 3~4개. 이게 이 기능의 핵심(거울 루프 탈출).
    const prompt = mode === "question"
      ? `You are a senior product strategist helping a solo founder decide this project's DIRECTION and AMBITION.
${baseContext}

Ask ONE concise question that would most help the founder decide where to take this project next — focus on direction/ambition (deepen vs expand vs pivot, who to serve, what bet to make), NOT implementation detail. Offer 3-5 short suggested answers the founder can pick from (they can also type their own).

Respond in this EXACT JSON format (no markdown, just raw JSON):
{ "question": "the question", "chips": ["short answer 1", "short answer 2", "short answer 3"] }

Rules:
- The question must be specific to THIS project, not generic
- Chips are short (under 40 chars each), concrete, and span DIFFERENT directions
- ${langRule}`
      : `You are a senior product strategist helping a solo founder set the mission for this project.
${baseContext}${answer ? `\n\nThe founder shared this about their intent/ambition — weave it into the options:\n"${answer}"` : ""}

Generate 3-4 DIVERGENT mission directions — deliberately spread across an ambition axis, NOT paraphrases of one idea.

Rules:
- At least ONE option is "deepen current" — perfect/harden what already exists.
- At least ONE option is "new territory" — a pivot, new capability, or expansion BEYOND what exists today. Go past the docs.
- Each option must differ in DIRECTION, not just wording.
- CLAUDE.md/README describe what EXISTS; at least one option must point beyond them.
- If you cannot ground a "new territory" option in real signal, still offer the most plausible adjacent expansion and say so honestly in its rationale — do NOT fabricate specifics.
- Each "draft" is a ready-to-use mission (1-3 sentences): identity + direction.

Respond in this EXACT JSON format (no markdown, just raw JSON):
{ "options": [ { "label": "short direction label (under 24 chars)", "draft": "the mission text", "rationale": "why this direction / what makes it distinct (1 sentence)" } ] }

Rules:
- ${langRule}`;

    try {
      if (!ctx.sessionManager) {
        return res.status(503).json({ error: "Session manager not ready" });
      }
      const sessionKey = `suggest-mission-${project.id}-${Date.now()}`;
      const session = ctx.sessionManager.spawnAgent(agent.id, project.workdir || process.cwd(), sessionKey);
      try {
        const result = await session.send(prompt);
        if (result.exitCode !== 0 && result.stdout.trim() === "") {
          throw new Error(`CLI failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
        }
        const { parseAgentOutput } = await import("../../core/agent/adapters/stream-parser.js");
        const parsed = parseAgentOutput(result.stdout, result.provider);
        const raw = parsed.text || "";
        if (!raw.trim()) throw new Error(`No text output${parsed.errors.length ? ` — ${parsed.errors.join("; ")}` : ""}`);

        const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/(\{[\s\S]*\})/);
        const jsonStr = jsonMatch ? jsonMatch[1] : raw;
        const suggestion = JSON.parse(jsonStr);

        if (mode === "question") {
          res.json({
            question: {
              text: String(suggestion.question || "").slice(0, 300),
              chips: Array.isArray(suggestion.chips)
                ? suggestion.chips.slice(0, 6).map((c: any) => String(c).slice(0, 80)).filter(Boolean)
                : [],
            },
          });
        } else {
          const opts = Array.isArray(suggestion.options) ? suggestion.options : [];
          res.json({
            options: opts
              .slice(0, 4)
              .map((o: any, i: number) => ({
                id: `o${i + 1}`,
                label: String(o?.label || "").slice(0, 60),
                draft: String(o?.draft || "").slice(0, 600),
                rationale: String(o?.rationale || "").slice(0, 300),
              }))
              .filter((o: any) => o.draft),
          });
        }
      } finally {
        ctx.sessionManager.killSession(sessionKey);
      }
    } catch (err: any) {
      log.error("Failed to suggest mission", err);
      res.status(500).json({ error: err.message || "Mission suggestion failed" });
    }
  });

  // Analyze a local directory (for project import)
  router.post("/analyze", (req, res) => {
    const { path: inputPath } = req.body;
    if (!inputPath) return res.status(400).json({ error: "path is required" });

    let resolved: string;
    try {
      resolved = validateWorkdir(inputPath);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }

    if (!existsSync(resolved)) return res.status(400).json({ error: "Directory not found" });

    try {
      const analysis = analyzeProject(resolved);
      res.json(analysis);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Import a local project (analyze + create + suggest agents)
  router.post("/import", (req, res) => {
    const { path: dirPath, name } = req.body;
    if (!dirPath) return res.status(400).json({ error: "path is required" });

    let resolvedImport: string;
    try {
      resolvedImport = validateWorkdir(dirPath);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }
    if (!existsSync(resolvedImport)) return res.status(400).json({ error: "Directory not found" });

    try {
      const analysis = analyzeProject(resolvedImport);
      const projectName = name || resolvedImport.split("/").pop() || "Imported Project";

      // Create project — auto-fill mission from CLAUDE.md/readme if available
      const result = db.prepare(`
        INSERT INTO projects (name, mission, source, workdir, tech_stack)
        VALUES (?, ?, 'local_import', ?, ?)
      `).run(projectName, analysis.mission || "", resolvedImport, JSON.stringify(analysis.techStack));

      const project = db.prepare("SELECT * FROM projects WHERE rowid = ?").get(result.lastInsertRowid) as any;

      // Create suggested agents
      for (const agent of analysis.suggestedAgents) {
        db.prepare(`
          INSERT INTO agents (project_id, name, role)
          VALUES (?, ?, ?)
        `).run(project.id, agent.name, agent.role);
      }

      const agents = db.prepare("SELECT * FROM agents WHERE project_id = ?").all(project.id);

      broadcast("project:updated", project);
      res.status(201).json({
        project,
        agents,
        analysis,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List project docs (.md files in docs/, plans, references, etc.)
  router.get("/:id/docs", (req, res) => {
    const project = db.prepare("SELECT workdir FROM projects WHERE id = ?").get(req.params.id) as { workdir: string } | undefined;
    if (!project || !project.workdir) return res.status(404).json({ error: "Project not found or no workdir" });

    const docs: Array<{ path: string; name: string; dir: string }> = [];
    const scanDirs = ["docs", "docs/plans", "docs/references", "docs/reviews", "docs/designs"];

    for (const dir of scanDirs) {
      const fullDir = join(project.workdir, dir);
      try {
        const stat = statSync(fullDir);
        if (!stat.isDirectory()) continue;
        const files = readdirSync(fullDir, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile()) continue;
          if (!f.name.endsWith(".md") && !f.name.endsWith(".yaml") && !f.name.endsWith(".yml")) continue;
          const relPath = `${dir}/${f.name}`;
          // Avoid duplicates (docs/plans/x.md seen from both "docs" and "docs/plans")
          if (!docs.some((d) => d.path === relPath)) {
            docs.push({ path: relPath, name: f.name, dir });
          }
        }
      } catch { /* skip non-existent dirs */ }
    }

    // Also scan root-level important files (dedup by lowercase)
    const seenRoot = new Set<string>();
    for (const rootFile of ["CLAUDE.md", "README.md", "readme.md"]) {
      if (seenRoot.has(rootFile.toLowerCase())) continue;
      try {
        statSync(join(project.workdir, rootFile));
        docs.push({ path: rootFile, name: rootFile, dir: "" });
        seenRoot.add(rootFile.toLowerCase());
      } catch { /* skip */ }
    }

    res.json(docs);
  });

  // List .claude/agents/*.md files with content
  router.get("/:id/agent-files", (req, res) => {
    const project = db.prepare("SELECT workdir FROM projects WHERE id = ?").get(req.params.id) as { workdir: string } | undefined;
    if (!project || !project.workdir) return res.status(404).json({ error: "Project not found or no workdir" });

    const agentsDir = resolve(project.workdir, ".claude", "agents");

    // Path traversal guard: agentsDir must be inside workdir
    const resolvedWorkdir = resolve(project.workdir);
    if (!agentsDir.startsWith(resolvedWorkdir + "/") && agentsDir !== resolvedWorkdir) {
      return res.status(400).json({ error: "Invalid path" });
    }

    if (!existsSync(agentsDir)) return res.json([]);

    let files: string[];
    try {
      files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    } catch {
      return res.json([]);
    }

    const result = files.map((filename) => {
      const filePath = resolve(agentsDir, filename);
      // Per-file path traversal guard
      if (!filePath.startsWith(agentsDir + "/") && filePath !== agentsDir) {
        return null;
      }
      try {
        const content = readFileSync(filePath, "utf-8");
        return { filename, content };
      } catch {
        return { filename, content: "" };
      }
    }).filter(Boolean) as Array<{ filename: string; content: string }>;

    res.json(result);
  });

  // Connect GitHub repo (clone + analyze + create project + agents)
  router.post("/github", (req, res) => {
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    // SSRF 방어: HTTP/HTTPS + github.com만 허용
    const trimmedUrl = String(url).trim();
    if (!/^https?:\/\/github\.com\//i.test(trimmedUrl) && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmedUrl)) {
      return res.status(400).json({ error: "Only GitHub HTTPS URLs or owner/repo format allowed" });
    }

    try {
      const dataDir = process.env.CREWDECK_DATA_DIR || ".crewdeck";
      const result = connectGitHub(url, dataDir);
      const projectName = name || url.split("/").pop()?.replace(/\.git$/, "") || "GitHub Project";

      // Validate localPath is within allowed directories
      const validatedPath = validateWorkdir(result.localPath);

      // Create project — auto-fill mission from CLAUDE.md/readme if available
      const dbResult = db.prepare(`
        INSERT INTO projects (name, mission, source, workdir, github_config, tech_stack)
        VALUES (?, ?, 'github', ?, ?, ?)
      `).run(
        projectName,
        result.analysis.mission || "",
        validatedPath,
        // 신규 GitHub 연결 기본은 auto: 승인 시 base 직접 push 가능하면 반영, 불가하면 PR 자동 폴백.
        JSON.stringify({ repoUrl: result.repoUrl, branch: result.branch, autoPush: false, prMode: false, gitMode: "auto" }),
        JSON.stringify(result.analysis.techStack),
      );

      const project = toProjectResponse(db.prepare("SELECT * FROM projects WHERE rowid = ?").get(dbResult.lastInsertRowid));

      // Create suggested agents
      for (const agent of result.analysis.suggestedAgents) {
        db.prepare("INSERT INTO agents (project_id, name, role) VALUES (?, ?, ?)")
          .run(project.id, agent.name, agent.role);
      }

      const agents = db.prepare("SELECT * FROM agents WHERE project_id = ?").all(project.id);

      broadcast("project:updated", project);
      res.status(201).json({ project, agents, analysis: result.analysis, branch: result.branch });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete project — stop scheduler queue + dev server before CASCADE delete
  router.delete("/:id", (req, res) => {
    const projectId = req.params.id;
    // Stop scheduler queue first to prevent accessing deleted resources
    ctx.scheduler?.stopQueue(projectId);
    // Kill any running agent sessions for this project
    const agents = db.prepare("SELECT id FROM agents WHERE project_id = ?").all(projectId) as { id: string }[];
    for (const a of agents) {
      ctx.sessionManager?.killSession(a.id);
    }
    const result = db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    if (result.changes === 0) return res.status(404).json({ error: "Project not found" });
    broadcast("project:updated", { id: projectId, deleted: true });
    res.json({ success: true });
  });

  // Cost tracking: token usage and cost per agent for a project (Sprint 5)
  router.get("/:id/cost", (req, res) => {
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const costs = db.prepare(`
      SELECT
        a.id        AS agentId,
        a.name      AS agentName,
        a.role,
        COALESCE(SUM(s.token_usage), 0) AS totalTokens,
        COALESCE(SUM(s.cost_usd), 0)    AS totalCost,
        -- CLI 실보고(claude)와 토큰 역산 추정치(codex)를 구분: 추정분 합계
        COALESCE(SUM(CASE WHEN COALESCE(s.cost_usd_reported, 0) = 0 THEN s.cost_usd ELSE 0 END), 0) AS estimatedCost
      FROM agents a
      LEFT JOIN sessions s ON s.agent_id = a.id
      WHERE a.project_id = ?
      GROUP BY a.id
      ORDER BY totalCost DESC
    `).all(req.params.id);

    res.json({ costs });
  });

  // --- Full autopilot: generate goals from mission, decompose, run queue ---
  /** Wait for all tasks in a goal to settle (done or permanently blocked) */
  function waitForGoalCompletion(goalId: string, projectId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        // User may have switched mode — bail out
        const current = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as any;
        if (current?.autopilot !== "full") { resolve(); return; }

        const goal = db.prepare("SELECT progress FROM goals WHERE id = ?").get(goalId) as any;
        if (!goal || goal.progress >= 100) { resolve(); return; }

        // All tasks done or permanently blocked → goal is settled
        const stats = db.prepare(`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN status IN ('done', 'blocked', 'skipped') THEN 1 ELSE 0 END) as settled
          FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
        `).get(goalId) as { total: number; settled: number };
        if (stats.total > 0 && stats.settled >= stats.total) { resolve(); return; }

        setTimeout(check, 5000);
      };
      check();
    });
  }

  async function triggerFullAutopilot(projectId: string) {
    if (!ctx.orchestrationEngine || !ctx.scheduler) {
      log.warn("Full autopilot trigger skipped: orchestration not initialized");
      return;
    }

    try {
      log.info(`Full autopilot started for project ${projectId}`);
      broadcast("autopilot:full-status", {
        projectId, phase: "generating_goals", currentGoalIndex: 0, totalGoals: 0,
        message: "CTO가 미션을 분석하고 목표를 생성합니다...",
      });

      // Step 1: CTO generates goals from mission (all at once for roadmap context)
      const { goalIds } = await ctx.orchestrationEngine.generateGoalsFromMission(projectId);

      if (goalIds.length === 0) {
        log.warn("Full autopilot: no goals generated, downgrading to goal mode");
        db.prepare("UPDATE projects SET autopilot = 'goal', updated_at = datetime('now') WHERE id = ?").run(projectId);
        broadcast("autopilot:full-status", { projectId, phase: "completed", message: "생성할 목표가 없습니다" });
        broadcast("autopilot:full-completed", { projectId, reason: "no_goals" });
        broadcast("autopilot:mode-changed", { projectId, mode: "goal" });
        return;
      }

      // Step 2: Sequential pipeline — decompose → execute → wait → next goal
      for (let i = 0; i < goalIds.length; i++) {
        const goalId = goalIds[i];

        // Guard: re-check autopilot mode (user may have switched mid-run)
        const current = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as any;
        if (current?.autopilot !== "full") {
          log.info("Full autopilot: mode changed during execution, stopping");
          broadcast("autopilot:full-status", { projectId, phase: "completed", message: "사용자가 모드를 변경했습니다" });
          return;
        }

        const goal = db.prepare("SELECT title, description FROM goals WHERE id = ?").get(goalId) as any;
        const goalTitle = (goal?.title || goal?.description || "").slice(0, 50);

        try {
          // 2a: Decompose this goal
          broadcast("autopilot:full-status", {
            projectId, phase: "decomposing", currentGoalIndex: i + 1, totalGoals: goalIds.length,
            goalId, message: `Goal ${i + 1}/${goalIds.length} 분해 중: "${goalTitle}"`,
          });
          await ctx.orchestrationEngine.decomposeGoal(goalId);

          // 2b: Plan review gate for this goal (full autopilot)
          await ctx.orchestrationEngine.applyPlanReviewGate(goalId, { autopilot: "full" });
          log.info(`Full autopilot: plan review gate applied for goal ${i + 1}/${goalIds.length}`);

          // 2c: Start queue (if not running)
          if (ctx.scheduler && !ctx.scheduler.isRunning(projectId)) {
            ctx.scheduler.startQueue(projectId);
          }

          // 2d: Wait for this goal to complete before moving to next
          broadcast("autopilot:full-status", {
            projectId, phase: "executing", currentGoalIndex: i + 1, totalGoals: goalIds.length,
            goalId, message: `Goal ${i + 1}/${goalIds.length} 실행 중: "${goalTitle}"`,
          });
          await waitForGoalCompletion(goalId, projectId);

          log.info(`Full autopilot: goal ${i + 1}/${goalIds.length} completed`);
        } catch (err: any) {
          log.error(`Full autopilot: failed on goal ${i + 1}/${goalIds.length}`, err);
          broadcast("autopilot:full-status", {
            projectId, phase: "error", currentGoalIndex: i + 1, totalGoals: goalIds.length,
            goalId, message: `Goal ${i + 1} 실패: ${err.message?.slice(0, 100)}`,
          });
          // Continue with next goal — don't let one failure block all
        }
      }

      // Step 3: Downgrade to 'goal' mode after all goals processed
      db.prepare("UPDATE projects SET autopilot = 'goal', updated_at = datetime('now') WHERE id = ?").run(projectId);
      broadcast("autopilot:full-status", {
        projectId, phase: "completed", currentGoalIndex: goalIds.length, totalGoals: goalIds.length,
        message: `${goalIds.length}개 목표 처리 완료`,
      });
      broadcast("autopilot:full-completed", { projectId, reason: "goals_generated", goalCount: goalIds.length });
      broadcast("autopilot:mode-changed", { projectId, mode: "goal" });
      broadcast("project:updated", { projectId });

      log.info(`Full autopilot completed: ${goalIds.length} goals processed sequentially, downgraded to goal mode`);
    } catch (err: any) {
      log.error(`Full autopilot failed for project ${projectId}`, err);

      // Safety: downgrade to goal mode on failure
      db.prepare("UPDATE projects SET autopilot = 'goal', updated_at = datetime('now') WHERE id = ?").run(projectId);
      broadcast("autopilot:full-status", { projectId, phase: "error", message: `실패: ${err.message?.slice(0, 100)}` });
      broadcast("autopilot:full-completed", { projectId, reason: "error", error: err.message });
      broadcast("autopilot:mode-changed", { projectId, mode: "goal" });

      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_error', ?)",
      ).run(projectId, `Full autopilot failed: ${err.message?.slice(0, 200)}`);
    }
  }

  return router;
}
