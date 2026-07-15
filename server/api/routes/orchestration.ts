import { Router } from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AppContext } from "../../index.js";
import { createSessionManager } from "../../core/agent/session.js";
import { claimTaskForExecution, createOrchestrationEngine } from "../../core/orchestration/engine.js";
import { createScheduler } from "../../core/orchestration/scheduler.js";
import { createQualityGate } from "../../core/quality-gate/evaluator.js";
import { MAX_PROMPT_LEN, MAX_TITLE_LEN, MAX_DESC_LEN } from "../../utils/constants.js";
import { parseAgentOutput } from "../../core/agent/adapters/stream-parser.js";
import { createLogger } from "../../utils/logger.js";
import { loadProviderConfig } from "../../core/agent/provider.js";
import { serializeTask, selectTaskForResponse } from "./tasks.js";
import { resolveChatSession, chatSessionKey } from "../../core/agent/chat-session.js";
import { ChatEventAssembler } from "../../core/agent/adapters/chat-events.js";
import { buildSummonContext } from "../../core/agent/summon-context.js";
import { assertExecutionAllowed, getSpecState, saveSpecDraft, type SpecVersion } from "../../core/goal-spec/spec-approval.js";
import { snapshotWorkdir, restoreWorkdirSnapshot } from "../../core/project/worktree.js";

const log = createLogger("orchestration");

export function createOrchestrationRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

  const sessionManager = createSessionManager(db, broadcast);
  const engine = createOrchestrationEngine(db, sessionManager, broadcast);
  const scheduler = createScheduler(db, sessionManager, broadcast);
  const qualityGate = createQualityGate(db, sessionManager, broadcast);

  // Expose sessionManager on ctx so other routes (e.g. agent delete) can kill sessions
  ctx.sessionManager = sessionManager;

  /**
   * Extract goal + tasks from CTO agent JSON response and auto-create them.
   * Shared by /agents/:agentId/prompt and /multi-prompt.
   */
  function extractAndCreateCtoGoal(
    projectId: string,
    agentId: string,
    text: string,
    fallbackDesc: string,
  ): boolean {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ??
                      text.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    if (!jsonMatch) return false;

    const jsonStr = jsonMatch[1] ?? jsonMatch[0];
    let data: any;
    try {
      data = JSON.parse(jsonStr);
    } catch (parseErr: any) {
      log.warn(`extractAndCreateCtoGoal: JSON parse failed (${parseErr.message})`);
      return false;
    }
    const tasks = data?.tasks ?? [];
    if (!Array.isArray(tasks) || tasks.length === 0) return false;

    const goalDesc = data.goal ?? data.analysis ?? fallbackDesc.slice(0, 200);
    // Assign sort_order at end so this goal doesn't jump above existing ones.
    const sortOrder = (db.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM goals WHERE project_id = ?",
    ).get(projectId) as { next: number }).next;
    const goalRow = db.prepare(
      "INSERT INTO goals (project_id, title, description, priority, sort_order, spec_approval_required) VALUES (?, ?, ?, 'high', ?, 1) RETURNING id",
    ).get(projectId, goalDesc.slice(0, 100), goalDesc, sortOrder) as { id: string } | undefined;

    if (!goalRow) return false;

    const projectAgents = db.prepare("SELECT * FROM agents WHERE project_id = ?").all(projectId) as any[];
    const ctoAgent = projectAgents.find((a: any) => a.role === "cto");
    const candidates = ctoAgent
      ? projectAgents.filter((a: any) => a.parent_id === ctoAgent.id)
      : projectAgents.filter((a: any) => a.role !== "cto");

    const findAgentForRole = (role: string) =>
      candidates.find((a: any) => a.role === role) ??
      candidates.find((a: any) => a.role === "coder") ??
      candidates[0] ?? null;

    for (const t of tasks) {
      if (!t.title || typeof t.title !== "string") continue;
      const assignee = findAgentForRole(t.role ?? "coder");
      db.prepare(
        "INSERT INTO tasks (goal_id, project_id, title, description, assignee_id, status) VALUES (?, ?, ?, ?, ?, 'pending_approval')",
      ).run(goalRow.id, projectId, t.title.slice(0, MAX_TITLE_LEN), (t.description ?? "").slice(0, MAX_DESC_LEN), assignee?.id ?? null);
    }

    broadcast("project:updated", { projectId });
    db.prepare(
      "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'task_completed', ?)",
    ).run(projectId, agentId, `CTO created goal "${goalDesc.slice(0, 50)}" with ${tasks.length} tasks`);

    return true;
  }

  // Execute a single task
  router.post("/tasks/:taskId/execute", async (req, res) => {
    const { taskId } = req.params;
    const { verificationScope = "standard" } = req.body ?? {};

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Conflict(409) must win over the assignee check: an already-running task
    // (in_progress, even with a null assignee) has to report the 409 contract,
    // not 400. So claim first, then validate the assignee.
    const claim = claimTaskForExecution(db, taskId);
    if (!claim.claimed) {
      if (claim.reason === "not_found") {
        return res.status(404).json({ error: claim.error });
      }
      if (claim.reason === "spec_not_approved") {
        return res.status(409).json({
          error: claim.reason,
          message: claim.error,
          goalId: task.goal_id,
          specStatus: claim.specStatus,
          currentDraftVersion: claim.currentDraftVersion,
        });
      }
      return res.status(409).json({
        error: claim.error,
        taskId: claim.taskId,
        status: claim.status,
      });
    }

    // Claim succeeded (was todo/pending_approval). If there's no assignee to run
    // it, release the claim so it doesn't strand in 'in_progress', then reject.
    if (!task.assignee_id) {
      db.prepare(
        "UPDATE tasks SET status = ?, started_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'in_progress'",
      ).run(task.status, taskId);
      broadcast("task:updated", { ...task });
      return res.status(400).json({ error: "Task has no assigned agent" });
    }

    // Start execution asynchronously, return immediately
    res.status(202).json({ status: "started", taskId });

    // Yield before starting setup/spawn so requests that arrived together all
    // contend on the in_progress CAS first. Without this boundary a fast setup
    // failure can release the first claim back to todo while a concurrent HTTP
    // handler is still waiting, allowing that handler to return a second 202
    // and create another session for the same task.
    setImmediate(() => {
      void engine.executeTask(taskId, { verificationScope }, claim).then((result) => {
        broadcast("task:updated", { taskId, ...result });
      }).catch((err: any) => {
        // 실행 실패 시 engine 이 이미 claim 을 해제하며 실제 상태(todo/blocked)로
        // 전이·broadcast 했다. 여기서 고정 'blocked' 를 다시 쏘면 DB(예: todo)와 UI 가
        // 어긋난다(scheduler 재실행 상태와 대시보드 불일치). DB 의 실제 상태를 다시 읽어
        // 그대로 반영한다.
        const cur = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
        if (cur) {
          broadcast("task:updated", { ...cur, error: err.message });
        } else {
          broadcast("task:updated", { taskId, status: "blocked", error: err.message });
        }
      });
    });
  });

  // Decompose a goal into tasks (waits for completion)
  router.post("/goals/:goalId/decompose", (req, res) => {
    const { goalId } = req.params;

    const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as any;
    if (!goal) return res.status(404).json({ error: "Goal not found" });

    const executionGate = assertExecutionAllowed(db, goalId);
    if (!executionGate.allowed) {
      return res.status(409).json({
        error: executionGate.reason,
        message: executionGate.message,
        goalId,
        specStatus: executionGate.specStatus,
        currentDraftVersion: executionGate.currentDraftVersion,
      });
    }

    // Allow re-decompose unless tasks are actively running (in_progress / in_review)
    const existingTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE goal_id = ?").get(goalId) as any;
    if (existingTasks.count > 0) {
      const runningTasks = db.prepare(
        "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ? AND status IN ('in_progress', 'in_review')"
      ).get(goalId) as any;
      if (runningTasks.count > 0) {
        return res.status(409).json({ error: "Goal has tasks currently running. Stop them first to re-decompose." });
      }
      // Kill sessions for assigned agents before deleting
      const assigned = db.prepare(
        "SELECT assignee_id FROM tasks WHERE goal_id = ? AND assignee_id IS NOT NULL"
      ).all(goalId) as { assignee_id: string }[];
      for (const t of assigned) {
        ctx.sessionManager?.killSession(t.assignee_id);
      }
      db.prepare("DELETE FROM tasks WHERE goal_id = ?").run(goalId);
      broadcast("project:updated", { projectId: goal.project_id });
    }

    // Return immediately — decompose runs in background
    res.status(202).json({ status: "decomposing", goalId });

    // Background decompose
    engine.decomposeGoal(goalId).then(async () => {
      broadcast("project:updated", { projectId: goal.project_id });

      // Plan review gate if project is in autopilot mode (reviewer approves/
      // rejects/escalates each task instead of a blanket auto-approve).
      const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(goal.project_id) as { autopilot: string } | undefined;
      if (project && (project.autopilot === "goal" || project.autopilot === "full")) {
        await engine.applyPlanReviewGate(goalId, { autopilot: project.autopilot });
        broadcast("project:updated", { projectId: goal.project_id });
        // Auto-start queue so approved (→todo) tasks get consumed
        if (ctx.scheduler && !ctx.scheduler.isRunning(goal.project_id)) {
          ctx.scheduler.startQueue(goal.project_id);
        }
      }

      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_created', ?)",
      ).run(goal.project_id, `Tasks created for goal: "${(goal.title || goal.description).slice(0, 80)}"`);
      broadcast("project:updated", { projectId: goal.project_id });
    }).catch((err: any) => {
      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_error', ?)",
      ).run(goal.project_id, `Task decompose failed: ${err.message?.slice(0, 200)}`);
      broadcast("project:updated", { projectId: goal.project_id });
    });
  });

  // Verify a task (Quality Gate only, no execution)
  // If verdict is pass, auto-approves the task to done
  router.post("/tasks/:taskId/verify", async (req, res) => {
    const { taskId } = req.params;
    const { scope = "standard" } = req.body ?? {};

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Return immediately, run verification asynchronously
    res.json({ status: "verifying", taskId });

    try {
      const result = await qualityGate.verify(taskId, { scope });
      // verification_id linkage is handled inside qualityGate.verify() via RETURNING

      // Auto-approve on pass
      if (result.verdict === "pass") {
        db.prepare("UPDATE tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?")
          .run(taskId);

        const goalRow = db.prepare("SELECT goal_id FROM tasks WHERE id = ?").get(taskId) as any;
        if (goalRow?.goal_id) {
          const stats = db.prepare(`
            SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
            FROM tasks WHERE goal_id = ?
          `).get(goalRow.goal_id) as { total: number; done: number };
          const progress = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
          db.prepare("UPDATE goals SET progress = ? WHERE id = ?").run(progress, goalRow.goal_id);
        }

        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_approved', ?)",
        ).run(task.project_id, `Verified & approved: ${task.title}`);
      }

      const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task:updated", updated);
    } catch (err: any) {
      // Read actual DB state — evaluator may have set it to 'blocked'
      const currentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task:updated", currentTask ?? { taskId, status: "in_review", error: err.message });
    }
  });

  // Send a direct prompt to an agent
  router.post("/agents/:agentId/prompt", async (req, res) => {
    const { agentId } = req.params;
    const { message } = req.body ?? {};

    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "message is required" });
    }
    if (message.length > MAX_PROMPT_LEN) {
      return res.status(400).json({ error: `Message too long (max ${MAX_PROMPT_LEN.toLocaleString()} chars)` });
    }

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (agent.status === "working") {
      return res.status(409).json({ error: "Agent is already working" });
    }

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(agent.project_id) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    const workdir = project.workdir || (() => { throw new Error("Project has no workdir configured"); })();

    // Build org context so the agent knows the team structure
    const projectAgents = db.prepare("SELECT id, name, role, parent_id FROM agents WHERE project_id = ?").all(agent.project_id) as any[];
    const contextParts: string[] = [];

    if (projectAgents.length > 1) {
      const parent = projectAgents.find((a: any) => a.id === agent.parent_id);
      const subordinates = projectAgents.filter((a: any) => a.parent_id === agentId);
      const peers = agent.parent_id
        ? projectAgents.filter((a: any) => a.parent_id === agent.parent_id && a.id !== agentId)
        : [];

      const lines: string[] = [`[Org Context] You are "${agent.name}" (${agent.role}).`];
      if (parent) lines.push(`You report to "${parent.name}" (${parent.role}).`);
      if (subordinates.length > 0) {
        lines.push(`Your team: ${subordinates.map((s: any) => `${s.name}(${s.role})`).join(", ")}.`);
      }
      if (peers.length > 0) {
        lines.push(`Peers: ${peers.map((p: any) => `${p.name}(${p.role})`).join(", ")}.`);
      }
      contextParts.push(lines.join(" "));
    }

    // Build project state context — goals, tasks, blockers
    const goals = db.prepare("SELECT id, description, priority, progress FROM goals WHERE project_id = ? ORDER BY created_at DESC LIMIT 5").all(agent.project_id) as any[];
    if (goals.length > 0) {
      const goalLines = goals.map((g: any) => {
        const desc = (g.description || "").slice(0, 80);
        return `- "${desc}" (${g.progress}%, priority: ${g.priority})`;
      });
      contextParts.push(`[Current Goals]\n${goalLines.join("\n")}`);
    }

    const activeTasks = db.prepare(`
      SELECT t.id, t.title, t.status, t.assignee_id, a.name AS assignee_name
      FROM tasks t LEFT JOIN agents a ON a.id = t.assignee_id
      WHERE t.project_id = ? AND t.status NOT IN ('done')
      ORDER BY t.created_at DESC LIMIT 20
    `).all(agent.project_id) as any[];
    if (activeTasks.length > 0) {
      const taskLines = activeTasks.map((t: any) => {
        const assignee = t.assignee_name ? ` → ${t.assignee_name}` : " (unassigned)";
        return `- [${t.status}] "${t.title}"${assignee}`;
      });
      contextParts.push(`[Active Tasks]\n${taskLines.join("\n")}`);
    }

    const orgContext = contextParts.length > 0 ? contextParts.join("\n\n") + "\n\n" : "";

    // Return immediately — run asynchronously
    res.json({ status: "started", agentId });

    (async () => {
      // Update agent status to working
      const activityLabel = message.slice(0, 50).replace(/\n/g, " ");
      db.prepare("UPDATE agents SET status = 'working', current_activity = ? WHERE id = ?").run(activityLabel, agentId);
      broadcast("agent:status", { id: agentId, name: agent.name, status: "working", activity: activityLabel });

      let session;
      try {
        session = sessionManager.spawnAgent(agentId, workdir);

        // Stream output to WebSocket
        session.on("output", (text: string) => {
          broadcast("agent:output", { agentId, output: text });
        });

        const result = await session.send(orgContext + message.trim());

        // Parse result text for broadcast
        const { parseAgentOutput } = await import("../../core/agent/adapters/stream-parser.js");
        const parsed = parseAgentOutput(result.stdout, result.provider);

        // Detect empty/failed response
        if (parsed.text === "" && result.stdout.length > 0) {
          const errMsg = parsed.errors.length > 0
            ? parsed.errors.join("; ")
            : `Parsed ${parsed.lineCount} lines but got empty text (exitCode: ${result.exitCode})`;
          console.error(`[orchestration] Agent ${agent.name} (${agentId}): ${errMsg}`);
          console.error(`[orchestration] Raw stdout first 500 chars:`, result.stdout.slice(0, 500));
        }
        if (parsed.text === "" && result.stdout.length === 0) {
          console.error(`[orchestration] Agent ${agent.name} (${agentId}): Empty stdout — CLI produced no output (exitCode: ${result.exitCode}, stderr: ${result.stderr.slice(0, 300)})`);
        }

        // If CTO agent: try to extract goal + tasks from response and auto-create
        let autoCreated = false;
        if (agent.role === "cto" && parsed.text !== "") {
          try {
            autoCreated = extractAndCreateCtoGoal(project.id, agentId, parsed.text, message.trim());
          } catch (ctoErr: any) {
            console.error(`[orchestration] CTO JSON extraction failed:`, ctoErr.message);
          }
        }

        // Build broadcast payload — include errors if text is empty
        const broadcastPayload: Record<string, unknown> = {
          agentId,
          result: parsed.text,
          exitCode: result.exitCode,
          autoCreated,
        };
        if (parsed.text === "" && parsed.errors.length > 0) {
          broadcastPayload.error = parsed.errors.join("; ");
        }
        if (parsed.text === "" && result.exitCode !== 0) {
          broadcastPayload.error = broadcastPayload.error
            ? `${broadcastPayload.error} | stderr: ${result.stderr.slice(0, 300)}`
            : `CLI exited with code ${result.exitCode}: ${result.stderr.slice(0, 300)}`;
        }

        broadcast("agent:prompt-complete", broadcastPayload);

        // Broadcast usage data for StatusBar (same event as task execution)
        if (parsed.usage) {
          broadcast("task:usage", {
            taskId: null,
            agentId,
            usage: parsed.usage,
          });
        }

        if (!autoCreated) {
          db.prepare(
            "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'task_completed', ?)",
          ).run(project.id, agentId, parsed.text === "" ? `Direct prompt failed: empty response` : `Direct prompt completed`);
        }
      } catch (err: any) {
        broadcast("agent:prompt-complete", {
          agentId,
          result: null,
          error: err.message,
        });
      } finally {
        // Always kill session and reset agent status — prevents stuck 'working' state
        sessionManager.killSession(agentId);
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(agentId);
        broadcast("agent:status", { id: agentId, name: agent.name, status: "idle" });
      }
    })();
  });

  // 채팅 큐(Phase 4a) — 실행 중(working) 세션에 온 메시지를 쌓고 턴 종료 후 자동 전송한다.
  const chatQueues = new Map<string, { message: string; taskId: string | null }[]>();
  const chatDraining = new Set<string>();

  // 턴 경계 코드 체크포인트(Phase 4b) — 각 턴 시작 전 작업 트리를 비파괴 스냅샷한다.
  // commit=복원 대상 SHA, tree=변경 없음 dedup 키. in-memory라 서버 재시작 시 자연 소멸.
  const chatCheckpoints = new Map<string, { turn: number; commit: string; tree: string; at: string }[]>();
  const MAX_CHECKPOINTS = 20;

  function resolveChatWorkdir(agentId: string, workspaceId?: string | null): string | null {
    if (workspaceId) {
      const workspace = db.prepare(`
        SELECT w.worktree_path
          FROM workspaces w
          JOIN agents a ON a.project_id = w.project_id
         WHERE w.id = ? AND a.id = ? AND w.state = 'ready'
      `).get(workspaceId, agentId) as { worktree_path: string | null } | undefined;
      return workspace?.worktree_path && existsSync(workspace.worktree_path)
        ? workspace.worktree_path
        : null;
    }
    const project = db.prepare(`
      SELECT p.workdir
        FROM agents a
        JOIN projects p ON p.id = a.project_id
       WHERE a.id = ?
    `).get(agentId) as { workdir: string } | undefined;
    return project?.workdir || null;
  }

  // 턴 시작 전 스냅샷을 기록하고 목록을 broadcast. 직전 스냅샷과 tree가 같으면(변경 없음) 스킵한다.
  // git repo가 아니거나 실패하면 조용히 건너뛴다(체크포인트 없이도 대화는 정상 진행).
  function recordCheckpoint(agentId: string, workspaceId?: string | null): void {
    const workdir = resolveChatWorkdir(agentId, workspaceId);
    if (!workdir) return;
    const snap = snapshotWorkdir(workdir);
    if (!snap) return;
    const key = chatSessionKey(agentId, workspaceId);
    const list = chatCheckpoints.get(key) ?? [];
    if (list.length > 0 && list[list.length - 1].tree === snap.tree) return; // 변경 없음 — 중복 스냅샷 스킵
    const lastTurn = list.length > 0 ? list[list.length - 1].turn : 0;
    list.push({ turn: lastTurn + 1, commit: snap.commit, tree: snap.tree, at: new Date().toISOString() });
    if (list.length > MAX_CHECKPOINTS) list.splice(0, list.length - MAX_CHECKPOINTS);
    chatCheckpoints.set(key, list);
    broadcast("chat:event", {
      agentId, workspaceId: workspaceId ?? null, sessionKey: key, seq: -1,
      event: { kind: "checkpoint", items: list.map((c) => ({ commit: c.commit, turn: c.turn, at: c.at })) },
    });
  }

  // 큐에 쌓인 메시지를 순차 전송(keep-alive resume). 세션이 사라졌으면(중단) 큐를 비운다.
  async function drainChatQueue(agentId: string, workspaceId?: string | null): Promise<void> {
    const key = chatSessionKey(agentId, workspaceId);
    if (chatDraining.has(key)) return; // 이미 drain 중 — 재진입 방지
    chatDraining.add(key);
    try {
      for (;;) {
        const queue = chatQueues.get(key);
        if (!queue || queue.length === 0) break;
        const next = queue.shift()!;
        broadcast("chat:event", { agentId, workspaceId: workspaceId ?? null, sessionKey: key, seq: -1, event: { kind: "queue", remaining: queue.length } });
        const session = ctx.sessionManager?.getSession(key);
        if (!session) { chatQueues.delete(key); break; } // 세션 중단됨 → 큐 폐기
        const provider = ctx.sessionManager!.getSessionRecord(key)?.provider ?? "claude";
        const assembler = new ChatEventAssembler(provider);
        let seq = 0;
        const onOutput = (text: string) => {
          for (const event of assembler.push(text)) broadcast("chat:event", { agentId, workspaceId: workspaceId ?? null, sessionKey: key, seq: seq++, event });
        };
        session.on("output", onOutput);
        recordCheckpoint(agentId, workspaceId); // 턴 시작 전 코드 스냅샷(비파괴)
        try { await session.send(next.message); } catch { /* 실패해도 다음 큐 계속 */ } finally { session.off("output", onOutput); }
      }
    } finally {
      chatDraining.delete(key);
    }
  }

  // 대화형 채팅 — 세션을 죽이지 않고(keep-alive) 멀티턴 resume. 구조화 이벤트 broadcast.
  router.post("/agents/:agentId/chat", async (req, res) => {
    const { agentId } = req.params;
    const message: string = (req.body?.message ?? "").toString();
    // 소환(⚡): 실패/이월 task에서 온 채팅이면 그 taskId로 goal 컨텍스트를 주입한다.
    const taskId: string | null = req.body?.taskId ?? null;
    const workspaceId = typeof req.body?.workspaceId === "string" && req.body.workspaceId.trim()
      ? req.body.workspaceId.trim()
      : null;
    // 끼어들기(steer, Phase 4b) — ⌘⏎. 실행 중이면 현재 턴 중단+resume, idle이면 일반 전송.
    const steer: boolean = req.body?.steer === true;
    if (!message.trim()) return res.status(400).json({ error: "message is required" });
    if (message.length > MAX_PROMPT_LEN) {
      return res.status(400).json({ error: `message too long (max ${MAX_PROMPT_LEN})` });
    }
    if (!ctx.sessionManager) return res.status(503).json({ error: "Session manager not ready" });

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(agent.project_id) as any;
    if (workspaceId) {
      const workspace = db.prepare(`
        SELECT project_id, state, worktree_path FROM workspaces WHERE id = ?
      `).get(workspaceId) as { project_id: string; state: string; worktree_path: string | null } | undefined;
      if (!workspace || workspace.project_id !== agent.project_id) {
        return res.status(404).json({ error: "Workspace not found for this agent project" });
      }
      if (workspace.state !== "ready" || !workspace.worktree_path || !existsSync(workspace.worktree_path)) {
        return res.status(409).json({ error: "Workspace is not ready" });
      }
    }
    const workdir = resolveChatWorkdir(agentId, workspaceId) ?? project?.workdir ?? process.cwd();
    const key = chatSessionKey(agentId, workspaceId);

    // 끼어들기(steer) — 실행 중인 턴을 중단하고 이 메시지를 다음 턴으로 최우선 이어붙인다(resume).
    // 큐 맨 앞에 unshift + 현재 턴 kill(). 중단된 턴의 finally가 drainChatQueue를 돌려 이 메시지를
    // 즉시 다음 턴으로 보낸다 — 별도 send 경로 없이 기존 drain 재사용이라 이중 전송이 없다.
    // idle이면 steer 플래그를 무시하고 아래 일반 전송 경로로 떨어진다(설계 표: idle ⌘⏎ = 전송).
    if (steer) {
      const existing = ctx.sessionManager.getSession(key);
      if (existing && existing.status === "working") {
        const q = chatQueues.get(key) ?? [];
        q.unshift({ message: message.trim(), taskId });
        chatQueues.set(key, q);
        broadcast("chat:event", { agentId, workspaceId, sessionKey: key, seq: -1, event: { kind: "queue", remaining: q.length } });
        existing.kill(); // SIGTERM(+SIGKILL 에스컬레이션) — interrupted resolve, resume용 sessionId 보존
        return res.json({ status: "steering", queued: q.length });
      }
    }

    // taskId는 새 spawn 시에만 세션 프롬프트에 주입된다(reused=true면 이미 살아있는 세션).
    const resolved = resolveChatSession(ctx.sessionManager, agentId, workdir, taskId, workspaceId);
    if ("busy" in resolved) {
      // 실행 중 — 409 대신 큐에 쌓고 턴 종료 후 자동 전송(Phase 4a).
      const q = chatQueues.get(key) ?? [];
      q.push({ message: message.trim(), taskId });
      chatQueues.set(key, q);
      broadcast("chat:event", { agentId, workspaceId, sessionKey: key, seq: -1, event: { kind: "queue", remaining: q.length } });
      return res.json({ status: "queued", queued: q.length });
    }

    // 새 세션 spawn + 소환(taskId)이면 "무엇을 주입했는지" 칩을 주입됨 스트립용으로 1회 broadcast.
    if (!resolved.reused && taskId) {
      const { chips } = buildSummonContext(db, taskId);
      if (chips.length > 0) {
        broadcast("chat:event", {
          agentId,
          workspaceId,
          sessionKey: key,
          seq: -1,
          event: { kind: "context", items: chips },
        });
      }
    }

    const session = ctx.sessionManager.getSession(key)!;
    // 이 세션에 실제로 해석된 provider(claude/codex). SessionManager가 spawn 시 sessions row에
    // 기록하고 getSessionRecord로 노출한다(session.ts SessionRecord.provider). AgentSession 자체엔
    // provider 필드가 없으므로 record에서 읽는다. 없으면 claude 폴백.
    const provider = ctx.sessionManager.getSessionRecord(key)?.provider ?? "claude";
    const assembler = new ChatEventAssembler(provider);
    let seq = 0;

    const onOutput = (text: string) => {
      for (const event of assembler.push(text)) {
        broadcast("chat:event", { agentId, workspaceId, sessionKey: key, seq: seq++, event });
      }
    };
    session.on("output", onOutput);
    recordCheckpoint(agentId, workspaceId); // 턴 시작 전 코드 스냅샷(비파괴) — "코드만 되돌리기" 지점

    try {
      const result = await session.send(message.trim());
      // steer로 중단된 턴이면 "interrupted"로 정직 보고(다음 턴은 finally의 drain이 이어간다).
      res.json({ status: result.interrupted ? "interrupted" : "done", agentId, workspaceId });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "chat failed" });
    } finally {
      session.off("output", onOutput); // ⚠ killSession 하지 않음 — keep-alive
      void drainChatQueue(agentId, workspaceId); // 턴 종료 후 큐에 쌓인 메시지 자동 전송(백그라운드)
    }
  });

  // 채팅 중단(Phase 4a) — 실행 중 턴 kill + 큐 비우기. ⚠ chatSessionKey 경유(raw agentId kill과 다른 키).
  router.post("/agents/:agentId/chat/abort", (req, res) => {
    const { agentId } = req.params;
    const workspaceId = typeof req.body?.workspaceId === "string" && req.body.workspaceId.trim()
      ? req.body.workspaceId.trim()
      : null;
    if (!ctx.sessionManager) return res.status(503).json({ error: "Session manager not ready" });
    const key = chatSessionKey(agentId, workspaceId);
    chatQueues.delete(key);
    ctx.sessionManager.killSession(key);
    broadcast("chat:event", { agentId, workspaceId, sessionKey: key, seq: -1, event: { kind: "queue", remaining: 0 } });
    const agent = db.prepare("SELECT status FROM agents WHERE id = ?").get(agentId) as { status: string } | undefined;
    broadcast("agent:status", { id: agentId, status: agent?.status ?? "idle" });
    res.json({ status: "aborted", agentId, workspaceId });
  });

  // 코드만 되돌리기(Phase 4b) — 이 세션 체크포인트 목록의 스냅샷으로 작업 트리를 되돌린다.
  // 임의 ref checkout 방지: commit이 목록에 있을 때만 허용(안전). 편집만 되돌리고 신규 파일은 안 지운다.
  router.post("/agents/:agentId/chat/restore", (req, res) => {
    const { agentId } = req.params;
    const commit: string = (req.body?.commit ?? "").toString();
    const workspaceId = typeof req.body?.workspaceId === "string" && req.body.workspaceId.trim()
      ? req.body.workspaceId.trim()
      : null;
    const key = chatSessionKey(agentId, workspaceId);
    const cp = (chatCheckpoints.get(key) ?? []).find((c) => c.commit === commit);
    if (!cp) return res.status(404).json({ error: "checkpoint not found" });

    const workdir = resolveChatWorkdir(agentId, workspaceId);
    if (!workdir) return res.status(400).json({ error: "no workdir" });

    if (!restoreWorkdirSnapshot(workdir, commit)) {
      return res.status(500).json({ error: "restore failed" });
    }
    // 스레드에 되돌림 사실을 note로 남긴다(사용자 가시성).
    broadcast("chat:event", { agentId, workspaceId, sessionKey: key, seq: -1, event: { kind: "text", text: `↩ 코드를 턴 ${cp.turn} 시점으로 되돌렸습니다.` } });
    res.json({ status: "restored", commit, turn: cp.turn, workspaceId });
  });

  // Send a prompt to multiple agents sequentially
  router.post("/multi-prompt", async (req, res) => {
    const { agentIds, message, projectId } = req.body ?? {};

    if (!Array.isArray(agentIds) || agentIds.length < 2) {
      return res.status(400).json({ error: "agentIds must be an array of at least 2" });
    }
    if (agentIds.length > 10) {
      return res.status(400).json({ error: "Maximum 10 agents per multi-prompt" });
    }
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "message is required" });
    }
    if (message.length > MAX_PROMPT_LEN) {
      return res.status(400).json({ error: `Message too long (max ${MAX_PROMPT_LEN.toLocaleString()} chars)` });
    }
    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "projectId is required" });
    }

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    // Validate all agents exist and are not working
    const agentList: any[] = [];
    for (const agentId of agentIds) {
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
      if (!agent) return res.status(404).json({ error: `Agent ${agentId} not found` });
      if (agent.status === "working") {
        return res.status(409).json({ error: `Agent "${agent.name}" is already working` });
      }
      agentList.push(agent);
    }

    const sessionId = `multi-${randomUUID().slice(0, 12)}`;

    // Return immediately — run asynchronously
    res.json({ status: "started", sessionId });

    (async () => {
      const workdir = project.workdir || (() => { throw new Error("Project has no workdir configured"); })();
      const results: { agentId: string; agentName: string; result: string }[] = [];

      for (let i = 0; i < agentList.length; i++) {
        const agent = agentList[i];

        // Build prompt with previous context
        let prompt: string;
        if (i === 0) {
          prompt = message.trim();
        } else {
          const discussionLines = results
            .map((r) => {
              const prevAgent = agentList.find((a) => a.id === r.agentId)!;
              return `### ${r.agentName} (${prevAgent.role})의 의견:\n${r.result}`;
            })
            .join("\n\n---\n\n");

          prompt = `## 이전 논의\n\n${discussionLines}\n\n---\n\n## 당신의 차례\n\n위 논의를 참고하여 다음 질문에 답해주세요:\n${message.trim()}`;
        }

        // Mark agent as working
        const multiActivity = message.slice(0, 50).replace(/\n/g, " ");
        db.prepare("UPDATE agents SET status = 'working', current_activity = ? WHERE id = ?").run(multiActivity, agent.id);
        broadcast("agent:status", { id: agent.id, name: agent.name, status: "working", activity: multiActivity });

        let agentResult = "";
        let session: any;
        try {
          session = sessionManager.spawnAgent(agent.id, workdir);

          session.on("output", (text: string) => {
            broadcast("agent:output", { agentId: agent.id, output: text });
          });

          const execResult = await session.send(prompt);

          const { parseAgentOutput } = await import("../../core/agent/adapters/stream-parser.js");
          const parsed = parseAgentOutput(execResult.stdout, execResult.provider);
          agentResult = parsed.text;
        } catch (err: any) {
          agentResult = `[Error: ${err.message}]`;
        } finally {
          db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(agent.id);
          broadcast("agent:status", { id: agent.id, name: agent.name, status: "idle" });
        }

        results.push({ agentId: agent.id, agentName: agent.name, result: agentResult });
        broadcast("multi-prompt:agent-done", {
          sessionId,
          agentId: agent.id,
          agentName: agent.name,
          result: agentResult,
          index: i,
          total: agentList.length,
        });
      }

      // If the last agent is CTO, try to auto-create goal + tasks
      let autoCreated = false;
      const lastAgent = agentList[agentList.length - 1];
      if (lastAgent.role === "cto") {
        try {
          const lastResult = results[results.length - 1].result;
          autoCreated = extractAndCreateCtoGoal(project.id, lastAgent.id, lastResult, message.trim());
        } catch {
          // JSON parsing failed — show text result only
        }
      }

      if (!autoCreated) {
        db.prepare(
          "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_completed', ?)",
        ).run(project.id, `Multi-prompt completed (${agentList.length} agents)`);
      }

      broadcast("multi-prompt:complete", {
        sessionId,
        results,
        autoCreated,
      });
    })();
  });

  // Kill an agent session
  router.post("/agents/:agentId/kill", (req, res) => {
    const { agentId } = req.params;
    sessionManager.killSession(agentId);
    res.json({ status: "killed", agentId });
  });

  // Kill all sessions
  router.post("/sessions/kill-all", (_req, res) => {
    sessionManager.killAll();
    res.json({ status: "all_killed" });
  });

  // Pause an agent session
  router.post("/agents/:agentId/pause", (req, res) => {
    const { agentId } = req.params;
    try {
      sessionManager.pauseSession(agentId);
      broadcast("agent:status", { id: agentId, status: "paused" });
      res.json({ status: "paused", agentId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Resume a paused agent session
  router.post("/agents/:agentId/resume", (req, res) => {
    const { agentId } = req.params;
    try {
      sessionManager.resumeSession(agentId);
      broadcast("agent:status", { id: agentId, status: "working" });
      res.json({ status: "resumed", agentId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Check queue status for a project (extended with pause info)
  router.get("/projects/:projectId/queue-status", (req, res) => {
    const { projectId } = req.params;
    const state = scheduler.getQueueState(projectId);
    res.json({ ...state, projectId });
  });

  // Start priority queue for a project
  router.post("/projects/:projectId/run-queue", (req, res) => {
    const { projectId } = req.params;

    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    if (scheduler.isRunning(projectId)) {
      return res.status(409).json({ error: "Queue already running for this project" });
    }

    scheduler.startQueue(projectId);
    res.json({ status: "queue_started", projectId });
  });

  // Reassign all tasks — clear assignees and re-run auto-assignment
  router.post("/projects/:projectId/reassign-all", (req, res) => {
    const { projectId } = req.params;
    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    const count = scheduler.reassignAll(projectId);
    res.json({ status: "reassigned", count, projectId });
  });

  // Stop priority queue for a project
  router.post("/projects/:projectId/stop-queue", (req, res) => {
    const { projectId } = req.params;

    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    scheduler.stopQueue(projectId);
    res.json({ status: "queue_stopped", projectId });
  });

  // Resume a paused queue (manual resume after rate limit)
  router.post("/projects/:projectId/resume-queue", (req, res) => {
    const { projectId } = req.params;

    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    if (!scheduler.isPaused(projectId)) {
      return res.status(400).json({ error: "Queue is not paused" });
    }

    scheduler.resumeQueue(projectId);
    res.json({ status: "queue_resumed", projectId });
  });

  // Helper: auto-resume queue for autopilot projects when todo tasks appear
  function ensureQueueRunning(projectId: string): void {
    if (ctx.scheduler?.isRunning(projectId)) return;
    const project = db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
    if (project && (project.autopilot === "goal" || project.autopilot === "full")) {
      ctx.scheduler?.startQueue(projectId);
    }
  }

  // ─── Approval Gate (Sprint 5) ──────────────────────────────────────────────

  // Approve a single pending_approval task → todo
  router.post("/:projectId/tasks/:taskId/approve", (req, res) => {
    const { projectId, taskId } = req.params;

    const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
      .get(taskId, projectId) as any;
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "pending_approval") {
      return res.status(400).json({ error: `Task is not pending approval. Current status: '${task.status}'` });
    }

    db.prepare("UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE id = ?")
      .run(taskId);

    const updated = serializeTask(selectTaskForResponse(db, taskId)!, loadProviderConfig().defaultProvider);
    broadcast("task:updated", updated);
    broadcast("project:updated", { projectId });

    // Auto-resume queue if autopilot is on and queue is stopped
    ensureQueueRunning(projectId);

    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_approved', ?)",
    ).run(projectId, `Approved for execution: ${task.title}`);

    res.json({ success: true, task: updated });
  });

  // Reject a single pending_approval task → blocked (with optional reason)
  router.post("/:projectId/tasks/:taskId/reject", (req, res) => {
    const { projectId, taskId } = req.params;
    const { reason } = req.body ?? {};

    const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
      .get(taskId, projectId) as any;
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "pending_approval") {
      return res.status(400).json({ error: `Task is not pending approval. Current status: '${task.status}'` });
    }

    // Append rejection reason to description if provided
    const newDesc = reason
      ? `${task.description}\n\n--- Rejection Reason ---\n${reason}`
      : task.description;

    db.prepare(
      "UPDATE tasks SET status = 'blocked', description = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(newDesc, taskId);

    const updated = serializeTask(selectTaskForResponse(db, taskId)!, loadProviderConfig().defaultProvider);
    broadcast("task:updated", updated);
    broadcast("project:updated", { projectId });

    db.prepare(
      "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_rejected', ?)",
    ).run(projectId, `Rejected: ${task.title}${reason ? ` — ${reason}` : ""}`);

    res.json({ success: true, task: updated });
  });

  // Approve all pending_approval tasks for a project → todo
  router.post("/:projectId/tasks/approve-all", (req, res) => {
    const { projectId } = req.params;

    const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as any;
    if (!project) return res.status(404).json({ error: "Project not found" });

    const result = db.prepare(
      "UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE project_id = ? AND status = 'pending_approval'",
    ).run(projectId);

    // Single batch broadcast instead of N+1 individual queries
    broadcast("project:updated", { projectId });

    if (result.changes > 0) {
      // Auto-resume queue if autopilot is on and queue is stopped
      ensureQueueRunning(projectId);

      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'task_approved', ?)",
      ).run(projectId, `Approved all ${result.changes} pending tasks`);
    }

    res.json({ approved: result.changes });
  });

  // ─── Goal Spec Generator (ManyFast-inspired structured planning) ───

  async function generateGoalSpec(goalId: string): Promise<any> {
    const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as any;
    if (!goal) throw new Error(`Goal ${goalId} not found`);

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(goal.project_id) as any;

    // Use CTO or first agent for spec generation
    const agent = (db.prepare(
      "SELECT * FROM agents WHERE project_id = ? AND role = 'cto' LIMIT 1",
    ).get(goal.project_id) as any)
      ?? (db.prepare(
        "SELECT * FROM agents WHERE project_id = ? LIMIT 1",
      ).get(goal.project_id) as any);

    if (!agent) throw new Error("No agents available for spec generation");

    const techStack = project?.tech_stack ? JSON.parse(project.tech_stack) : null;
    const techInfo = techStack
      ? `\nTech Stack: ${techStack.languages?.join(", ")} / ${techStack.frameworks?.join(", ")}`
      : "";

    // Load project docs for richer spec context
    let projectDocsContext = "";
    const loadedPaths = new Set<string>();

    if (project?.workdir) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const exists = fs.existsSync, readFile = fs.readFileSync, readdir = fs.readdirSync;
      const pathJoin = path.join;
      const pathResolve = path.resolve;
      const workdirAbs = pathResolve(project.workdir);
      const docParts: string[] = [];
      let docLen = 0;
      const DOC_LIMIT = 6000; // Keep total docs under ~1500 tokens
      const PER_FILE_LIMIT = 2000; // 한 파일이 전체를 독점하지 않도록

      // Path traversal guard: resolved path must stay inside workdir
      const withinWorkdir = (abs: string): boolean => {
        const normalized = pathResolve(abs);
        return normalized === workdirAbs || normalized.startsWith(workdirAbs + path.sep);
      };

      // 1) User-selected references first (highest priority)
      if (goal.references) {
        try {
          const refs = JSON.parse(goal.references);
          if (Array.isArray(refs)) {
            for (const ref of refs) {
              if (docLen >= DOC_LIMIT) break;
              if (typeof ref !== "string" || ref.length === 0) continue;
              // Reject absolute paths and anything that escapes workdir
              const fullPath = pathResolve(workdirAbs, ref);
              if (!withinWorkdir(fullPath)) {
                log.warn(`Rejected goal reference outside workdir: ${ref}`);
                continue;
              }
              if (!exists(fullPath)) continue;
              try {
                const c = readFile(fullPath, "utf-8").slice(0, Math.min(PER_FILE_LIMIT, DOC_LIMIT - docLen));
                docParts.push(`### ${ref}\n${c}`);
                docLen += c.length;
                loadedPaths.add(ref);
              } catch { /* skip unreadable */ }
            }
          }
        } catch { /* ignore parse errors */ }
      }

      // 2) Auto-discover remaining docs (skip already loaded)
      const docDirs = ["docs/plans", "docs/references", "docs/reviews"];
      for (const dir of docDirs) {
        const full = pathJoin(project.workdir, dir);
        if (!exists(full)) continue;
        try {
          for (const f of readdir(full).filter((f: string) => f.endsWith(".md")).slice(0, 3)) {
            const relPath = `${dir}/${f}`;
            if (loadedPaths.has(relPath) || docLen >= DOC_LIMIT) continue;
            const c = readFile(pathJoin(full, f), "utf-8").slice(0, Math.min(PER_FILE_LIMIT, DOC_LIMIT - docLen));
            docParts.push(`### ${relPath}\n${c}`);
            docLen += c.length;
            loadedPaths.add(relPath);
          }
        } catch { /* skip */ }
      }

      if (docParts.length > 0) {
        projectDocsContext = `\n\n## Project Reference Documents (${docParts.length} files)\n${docParts.join("\n\n")}`;
      }
    }

    // 사용자가 붙여넣은 원본 자료 — 있으면 기획서의 1차 근거(authoritative)로 삼는다.
    const sourceMaterialContext = goal.source_material
      ? `\n\n## User-Provided Source Material (AUTHORITATIVE — base the spec primarily on this)\n"""\n${String(goal.source_material).slice(0, 12000)}\n"""`
      : "";

    const specPrompt = `
# Goal Spec Generation

You are a senior product manager. Produce an execution-ready spec for this goal — the single approved blueprint that task decomposition, implementation, and the Quality Gate all follow.

**Project**: ${project?.name || "Unknown"}${techInfo}
**Goal**: ${goal.title ? `"${goal.title}"` : `"${goal.description}"`}${goal.title && goal.description ? `\n**Details**: ${goal.description}` : ""}${projectDocsContext}${sourceMaterialContext}

Return ONLY this JSON (no surrounding prose) in this EXACT format:
\`\`\`json
{
  "scope": "What this goal includes — the boundary of work to be done",
  "out_of_scope": "What is explicitly excluded, to prevent scope creep",
  "acceptance_criteria": ["Given X, when Y, then Z"],
  "expected_tasks": ["Concrete unit of work this goal will be decomposed into"],
  "verification_methods": ["How an acceptance criterion is proven — build passes, unit test, E2E flow, manual check"]
}
\`\`\`

Rules:
- Be specific to this project and goal, not generic.
${goal.source_material ? "- The Source Material above is the user's prepared brief — treat it as the primary source of truth. Derive scope, out_of_scope, acceptance criteria, expected tasks and verification methods from it (preserve its intent, scope and terminology); do not invent scope it doesn't imply.\n" : ""}- scope and out_of_scope are prose strings; the other three are arrays of non-empty strings.
- acceptance_criteria: Given/When/Then format, one testable outcome each.
- expected_tasks: 3-7 concrete tasks in rough execution order (planned units before approval, not the final task list).
- verification_methods: actual ways to verify the acceptance criteria (build/test/E2E/manual), referencing the real tech stack — NOT architectural advice.
- Keep it concise but complete.
`;

    const specSessionKey = `spec-${goalId}`;
    let session;
    try {
      session = sessionManager.spawnAgent(agent.id, project?.workdir || process.cwd(), specSessionKey);
      const result = await session.send(specPrompt);

      // Check CLI exit code
      if (result.exitCode !== 0 && result.stdout.trim() === "") {
        const hint = result.stderr.slice(0, 300);
        throw new Error(`Claude Code CLI failed (exit ${result.exitCode}): ${hint}`);
      }

      const parsed = parseAgentOutput(result.stdout, result.provider);

      if (!parsed.text || parsed.text.trim() === "") {
        throw new Error(`Spec generation produced no text output. Errors: ${parsed.errors.join("; ") || "none"}`);
      }

      // Try multiple JSON extraction strategies
      let specData: any;
      const jsonMatch = parsed.text.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        specData = JSON.parse(jsonMatch[1]);
      } else {
        // Fallback: try to find raw JSON object with an acceptance_criteria key
        const rawJsonMatch = parsed.text.match(/\{[\s\S]*"acceptance_criteria"[\s\S]*\}/);
        if (rawJsonMatch) {
          specData = JSON.parse(rawJsonMatch[0]);
        } else {
          throw new Error("No JSON found in spec generation response");
        }
      }

      const asStringArray = (value: any): string[] =>
        Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim() !== "") : [];

      // Persist the generated spec directly as a flat draft snapshot. This IS
      // the execution contract — decompose, implementation, and the Quality
      // Gate read only this (via getExecutionSpec/formatExecutionSpecContext).
      // No rich→flat projection: the model produces the flat shape itself, so
      // out_of_scope and verification_methods are first-class (not "" / tech
      // considerations), and feature priority/user_flow — which nothing
      // downstream consumed — are no longer generated.
      const savedVersion = saveSpecDraft(db, goalId, {
        scope: typeof specData.scope === "string" ? specData.scope : "",
        out_of_scope: typeof specData.out_of_scope === "string" ? specData.out_of_scope : "",
        acceptance_criteria: asStringArray(specData.acceptance_criteria),
        expected_tasks: asStringArray(specData.expected_tasks),
        verification_methods: asStringArray(specData.verification_methods),
      });

      // Clear the '{"_status":"generating"}' sentinel on the legacy goal_specs
      // row so _status pollers (goals.ts), the scheduler hasSpec check, and the
      // summon-context legacy fallback observe a completed spec. We keep only a
      // minimal prd_summary (scope) — the rich PRD columns are intentionally
      // left empty because nothing downstream reads them.
      const minimalPrd = JSON.stringify({ scope: savedVersion.scope });
      const existing = db.prepare("SELECT id FROM goal_specs WHERE goal_id = ?").get(goalId) as { id: string } | undefined;
      if (existing) {
        db.prepare(`
          UPDATE goal_specs SET
            prd_summary = ?, feature_specs = '[]', user_flow = '[]',
            acceptance_criteria = ?, tech_considerations = '[]',
            generated_by = 'ai', version = version + 1, updated_at = datetime('now')
          WHERE goal_id = ?
        `).run(minimalPrd, JSON.stringify(savedVersion.acceptance_criteria), goalId);
      } else {
        db.prepare(`
          INSERT INTO goal_specs (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by)
          VALUES (?, ?, '[]', '[]', ?, '[]', 'ai')
        `).run(goalId, minimalPrd, JSON.stringify(savedVersion.acceptance_criteria));
      }

      broadcast("project:updated", { projectId: goal.project_id });

      db.prepare(
        "INSERT INTO activities (project_id, type, message) VALUES (?, 'spec_generated', ?)",
      ).run(goal.project_id, `Structured spec generated for goal: "${(goal.title || goal.description).slice(0, 80)}"`);

      // NOTE: Decompose는 호출자(goals.ts triggerAutopilotDecompose, scheduler processNextGoal,
      // POST /goals)가 직접 처리한다. 여기서 추가로 트리거하면 동일한 sessionKey
      // (`decompose-${goalId}`)로 두 번 spawn되면서 race condition 발생 → 첫 번째
      // 세션이 SIGTERM으로 죽고 textLen=0/exitCode=null로 실패한다.

      return getSpecState(db, goalId);
    } catch (err: any) {
      // Clear the '{"_status":"generating"}' placeholder so the row doesn't
      // stay stuck forever. A stuck 'generating' row makes processNextGoal
      // short-circuit on every poll cycle (isGenerating branch), which
      // historically triggered the scheduleNextPoll timer-leak bug and
      // saturated the event loop. Even with that bug fixed, leaving the
      // placeholder means the goal can never progress — surface the failure.
      try {
        const errorMsg = (err?.message ?? String(err)).slice(0, 500);
        const failedJson = JSON.stringify({ _status: "failed", _error: errorMsg });
        const existingRow = db.prepare("SELECT id FROM goal_specs WHERE goal_id = ?").get(goalId);
        if (existingRow) {
          db.prepare("UPDATE goal_specs SET prd_summary = ?, updated_at = datetime('now') WHERE goal_id = ?")
            .run(failedJson, goalId);
        }
        broadcast("project:updated", { projectId: goal.project_id });
      } catch (cleanupErr) {
        log.warn(`Failed to mark goal_specs as failed for ${goalId}: ${(cleanupErr as any)?.message}`);
      }
      throw err;
    } finally {
      if (session) sessionManager.killSession(specSessionKey);
    }
  }

  // ─── Refine Goal Spec with custom prompt ───
  async function refineGoalSpec(goalId: string, userPrompt: string, currentSpec: SpecVersion): Promise<any> {
    const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as any;
    if (!goal) throw new Error("Goal not found");

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(goal.project_id) as any;

    const agent = (db.prepare(
      "SELECT * FROM agents WHERE project_id = ? AND role = 'cto' LIMIT 1",
    ).get(goal.project_id) as any)
      ?? (db.prepare(
        "SELECT * FROM agents WHERE project_id = ? LIMIT 1",
      ).get(goal.project_id) as any);

    if (!agent) throw new Error("No agents available");

    const refinePrompt = `
# Spec Refinement

You are refining an existing structured spec based on the user's request.

**Goal**: ${goal.title ? `"${goal.title}"` : `"${goal.description}"`}${goal.title && goal.description ? `\n**Details**: ${goal.description}` : ""}

**Current Spec**:
\`\`\`json
${JSON.stringify(currentSpec, null, 2)}
\`\`\`

**User's Request**: "${userPrompt}"

Apply the user's request to modify the spec. Return the COMPLETE updated spec in this EXACT JSON format:
\`\`\`json
{
  "scope": "...",
  "out_of_scope": "...",
  "acceptance_criteria": ["Given X, when Y, then Z"],
  "expected_tasks": ["..."],
  "verification_methods": ["..."]
}
\`\`\`

Rules:
- Only change what the user asked for — preserve everything else
- Return the COMPLETE spec, not just the changed parts
- Keep existing items unless explicitly asked to remove them
`;

    const refineSessionKey = `refine-${goalId}`;
    let session;
    try {
      session = sessionManager.spawnAgent(agent.id, project?.workdir || process.cwd(), refineSessionKey);
      const result = await session.send(refinePrompt);
      const parsed = parseAgentOutput(result.stdout, result.provider);

      const jsonMatch = parsed.text.match(/```json\s*([\s\S]*?)\s*```/);
      const refined = JSON.parse(jsonMatch?.[1] ?? parsed.text.trim());

      // Persist the refined result as a new immutable draft snapshot so the
      // common read contract (GET /spec) and the approval gate observe this
      // version — mirror the generate path. Without this, refine only touched
      // the legacy goal_specs row and goal_spec_versions never grew, so UI and
      // execution kept using the prior (approved) snapshot.
      saveSpecDraft(db, goalId, {
        scope: refined.scope ?? currentSpec.scope,
        out_of_scope: refined.out_of_scope ?? currentSpec.out_of_scope,
        acceptance_criteria: refined.acceptance_criteria ?? currentSpec.acceptance_criteria,
        expected_tasks: refined.expected_tasks ?? currentSpec.expected_tasks,
        verification_methods: refined.verification_methods ?? currentSpec.verification_methods,
      });
      broadcast("project:updated", { projectId: goal.project_id });
      return getSpecState(db, goalId);
    } finally {
      if (session) sessionManager.killSession(refineSessionKey);
    }
  }

  // Expose engine, scheduler, spec generator, and refiner on ctx
  ctx.orchestrationEngine = engine;
  ctx.generateGoalSpec = generateGoalSpec;
  (ctx as any).refineGoalSpec = refineGoalSpec;
  ctx.scheduler = scheduler;

  // Register spec generator with scheduler for full autopilot cycle
  scheduler.setSpecGenerator(generateGoalSpec);

  return router;
}
