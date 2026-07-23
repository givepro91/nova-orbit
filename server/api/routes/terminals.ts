import { Router } from "express";
import type { AppContext } from "../../index.js";
import type { TerminalActivityKind } from "../../../shared/types.js";
import {
  bindTerminalSession,
  claimNextTerminalTask,
  listTerminalDecisions,
  recordTerminalDecision,
  startNextTerminalTask,
} from "../../core/terminal/session-binding.js";
import {
  listTerminalReviews,
  prepareTerminalReview,
  runTerminalReview,
} from "../../core/terminal/review-loop.js";
import { createQualityGate } from "../../core/quality-gate/evaluator.js";
import { createTerminalActivity } from "../../core/terminal/activity.js";
import { shellQuote } from "../../core/terminal/manager.js";
import { TERMINAL_RESUME_NUDGE, TERMINAL_TASK_KICKOFF, providerLaunchFlags } from "../../../shared/terminal-agent.js";
import { promptLanguageRule } from "../../utils/language.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("terminal-routes");

export function createTerminalRoutes(ctx: AppContext): Router {
  const router = Router();
  const manager = ctx.terminalManager;
  if (!manager) throw new Error("Terminal manager is not configured");

  const reviewErrorStatus = (message: string): number => {
    if (message === "Terminal not found" || message === "Terminal review not found") return 404;
    if (message.includes("must be") || message.includes("may contain") || message.includes("invalid null byte")) return 400;
    return 409;
  };

  const prepareReview = (terminalId: string, body: Record<string, unknown> | undefined) =>
    prepareTerminalReview(ctx.db, terminalId, {
      summary: body?.summary,
      changedFiles: body?.changedFiles,
      verificationCommands: body?.verificationCommands,
      scope: body?.scope,
      idempotencyKey: body?.idempotencyKey,
    });

  const recordActivity = (
    terminalId: string,
    workspaceId: string,
    input: { idempotencyKey: string; kind: TerminalActivityKind; summary: string; metadata?: Record<string, unknown> },
  ) => {
    try {
      const result = createTerminalActivity(ctx.db, { terminalSessionId: terminalId, workspaceId, ...input });
      if (!result.replayed) ctx.broadcast("terminal:activity", result.activity);
    } catch (error) {
      log.warn("Could not append terminal orchestration evidence", {
        terminalId,
        kind: input.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  router.get("/", (req, res) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
    if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
    res.json(manager.list(workspaceId));
  });

  router.post("/", (req, res) => {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId.trim() : "";
    if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
    try {
      if (req.body?.forceNew !== true) {
        const existing = manager.list(workspaceId).find((terminal) => terminal.status === "active");
        if (existing) return res.json(existing);
      }
      const terminal = manager.create(workspaceId, {
        cols: Number(req.body?.cols),
        rows: Number(req.body?.rows),
      });
      ctx.broadcast("workspace:updated", { workspaceId, projectId: terminal.projectId });
      ctx.broadcast("project:updated", { projectId: terminal.projectId });
      res.status(201).json(terminal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Terminal creation failed";
      res.status(message === "Workspace not found" ? 404 : 409).json({ error: message });
    }
  });

  router.get("/:id", (req, res) => {
    const terminal = manager.get(req.params.id);
    if (!terminal) return res.status(404).json({ error: "Terminal not found" });
    res.json(terminal);
  });

  router.patch("/:id/binding", (req, res) => {
    try {
      bindTerminalSession(ctx.db, req.params.id, {
        goalId: req.body?.goalId,
        agentId: req.body?.agentId,
        taskId: req.body?.taskId,
        provider: req.body?.provider,
      });
      const terminal = manager.get(req.params.id);
      if (!terminal) return res.status(404).json({ error: "Terminal not found" });
      ctx.broadcast("terminal:binding", terminal);
      ctx.broadcast("workspace:updated", { workspaceId: terminal.workspaceId, projectId: terminal.projectId });
      res.json(terminal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Terminal binding failed";
      res.status(message === "Terminal not found" ? 404 : 409).json({ error: message });
    }
  });

  router.post("/:id/claim-next", (req, res) => {
    try {
      const task = claimNextTerminalTask(ctx.db, req.params.id, {
        goalId: req.body?.goalId,
        agentId: req.body?.agentId,
        taskId: req.body?.taskId,
        provider: req.body?.provider,
      });
      const terminal = manager.get(req.params.id);
      ctx.broadcast("task:updated", task);
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      ctx.broadcast("project:updated", { projectId: task.project_id });
      res.json({ task, terminal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not claim the next task";
      res.status(message === "Terminal not found" ? 404 : 409).json({ error: message });
    }
  });

  router.post("/:id/start-next", (req, res) => {
    try {
      const current = manager.get(req.params.id);
      if (!current) return res.status(404).json({ error: "Terminal not found" });
      if (current.status !== "active" || current.contextState !== "connected") {
        return res.status(409).json({ error: "Terminal context is not connected" });
      }
      // kickoff 언어 = 대시보드 UI 언어(body.language, "ko"|"en"). 안 넘어오면 프로젝트 언어 따라가기.
      const kickoff = `${TERMINAL_TASK_KICKOFF} ${promptLanguageRule(req.body?.language)}`;
      const result = startNextTerminalTask(ctx.db, req.params.id, {
        goalId: req.body?.goalId,
        agentId: req.body?.agentId,
        taskId: req.body?.taskId,
        provider: req.body?.provider,
      }, (provider) => manager.write(req.params.id, `${provider} ${providerLaunchFlags(provider)} ${shellQuote(kickoff)}\r`));
      const terminal = manager.get(req.params.id);
      ctx.broadcast("task:updated", result.task);
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      ctx.broadcast("project:updated", { projectId: result.task.project_id });
      if (terminal && result.launchState === "requested") {
        const taskTitle = String(result.task.title ?? result.task.id ?? "task");
        recordActivity(req.params.id, terminal.workspaceId, {
          idempotencyKey: `start:${result.launchKey}:task`,
          kind: "task_claimed",
          summary: `Claimed task: ${taskTitle}`,
          metadata: { launchKey: result.launchKey },
        });
        recordActivity(req.params.id, terminal.workspaceId, {
          idempotencyKey: `start:${result.launchKey}:provider`,
          kind: "provider_launch_requested",
          summary: `Requested ${result.provider} in the bound terminal`,
          metadata: { launchKey: result.launchKey },
        });
      }
      res.json({ ...result, terminal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the next task";
      const code = (error as { code?: string } | null)?.code;
      res.status(message === "Terminal not found" ? 404 : 409).json(code ? { error: message, code } : { error: message });
    }
  });

  // 살아 있으나 멈춘 터미널을 사람이 재개한다(자동 재개 아님). 서브상태별로:
  //   force  → 터미널 종료(wedged 대응). 종료 후 복구/auto-advance 가 새 터미널로 재착수하되,
  //            즉시가 아니라 다음 폴/복구 사이클에서 이어진다(브리지 이벤트 없으면 stale 리셋 대기).
  //   shell  → 셸로 빠진 터미널에 provider CLI(kickoff) 재실행
  //   idle   → 프롬프트에서 대기 중인 CLI에 "이어서 계속" 주입
  router.post("/:id/resume", (req, res) => {
    const terminal = manager.get(req.params.id);
    if (!terminal) return res.status(404).json({ error: "Terminal not found" });
    if (terminal.status !== "active") return res.status(409).json({ error: "Terminal is not active" });

    if (req.body?.force === true) {
      manager.kill(req.params.id);
      ctx.broadcast("project:updated", { projectId: terminal.projectId });
      return res.json({ status: "restarting", terminalId: terminal.id });
    }

    const state = manager.resumeState(req.params.id);
    if (!state) return res.status(409).json({ error: "Terminal has nothing to resume" });
    if (terminal.contextState !== "connected") {
      return res.status(409).json({ error: "Terminal context is not connected" });
    }
    const taskId = terminal.activeTaskId;
    if (!taskId) return res.status(409).json({ error: "Terminal is not bound to a task" });

    // 먼저 터미널에 써 넣는다. 실패(pendingInput 버퍼 full 등)하면 상태를 건드리지 않고 409 —
    // 태스크만 in_progress 로 바꾸고 resume_state 를 지워버리면 아무것도 안 도는데 "재개됨"처럼 보인다.
    const written = state === "shell"
      // resumeState 가 provider IS NULL 을 이미 걸러냈으므로 terminal.provider 는 non-null이다.
      ? manager.write(req.params.id,
          `${terminal.provider ?? "claude"} ${providerLaunchFlags(terminal.provider ?? "claude")} `
          + `${shellQuote(`${TERMINAL_TASK_KICKOFF} ${promptLanguageRule(req.body?.language)}`)}\r`)
      : manager.write(req.params.id, `${TERMINAL_RESUME_NUDGE}\r`);
    if (!written) return res.status(409).json({ error: "Could not write to the terminal" });

    // 쓰기가 들어간 뒤에만 상태를 옮긴다: todo/blocked → in_progress (goal 점유 유지로 중복 착수 방지),
    // resume_state 클리어.
    const task = ctx.db.prepare(`
      UPDATE tasks SET status = 'in_progress', updated_at = datetime('now')
       WHERE id = ? AND status IN ('todo', 'blocked') RETURNING *
    `).get(taskId) as Record<string, unknown> | undefined;
    ctx.db.prepare("UPDATE terminal_sessions SET resume_state = NULL WHERE id = ?").run(req.params.id);

    const updated = manager.get(req.params.id);
    if (task) ctx.broadcast("task:updated", task);
    if (updated) ctx.broadcast("terminal:binding", updated);
    ctx.broadcast("project:updated", { projectId: terminal.projectId });
    try {
      ctx.db.prepare("INSERT INTO activities (project_id, type, message) VALUES (?, 'autopilot_warning', ?)")
        .run(terminal.projectId, state === "shell" ? "▶ 터미널 재개: 에이전트 재실행" : "▶ 터미널 재개: 이어서 계속");
    } catch { /* best-effort */ }
    res.json({ status: "resumed", resumeState: state, terminal: updated });
  });

  router.get("/:id/decisions", (req, res) => {
    const terminal = manager.get(req.params.id);
    if (!terminal) return res.status(404).json({ error: "Terminal not found" });
    const goalId = typeof req.query.goalId === "string" ? req.query.goalId : undefined;
    res.json(listTerminalDecisions(ctx.db, terminal.workspaceId, goalId));
  });

  router.post("/:id/decisions", (req, res) => {
    try {
      const result = recordTerminalDecision(ctx.db, req.params.id, String(req.body?.message ?? ""));
      const terminal = manager.get(req.params.id);
      ctx.broadcast("terminal:decision", result.decision);
      if (result.task) ctx.broadcast("task:updated", result.task);
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      res.status(201).json({ ...result, terminal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not record the decision";
      res.status(message === "Terminal not found" ? 404 : 409).json({ error: message });
    }
  });

  router.post("/:id/completion", (req, res) => {
    try {
      const result = prepareReview(req.params.id, req.body);
      const terminal = manager.get(req.params.id);
      ctx.broadcast("task:updated", result.task);
      ctx.broadcast("terminal:review", result.review);
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      ctx.broadcast("project:updated", { projectId: String((result.task as Record<string, unknown>).project_id ?? "") });
      if (terminal) {
        recordActivity(req.params.id, terminal.workspaceId, {
          idempotencyKey: `review:${result.review.id}:completion`,
          kind: "completion_requested",
          summary: result.review.evidence.summary,
          metadata: {
            reviewId: result.review.id,
            changedFilesCount: result.review.evidence.changedFiles.length,
            verificationCommandsCount: result.review.evidence.verificationCommands.length,
          },
        });
      }
      res.json({ ...result, terminal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not request task completion";
      res.status(reviewErrorStatus(message)).json({ error: message });
    }
  });

  router.get("/:id/reviews", (req, res) => {
    try {
      res.json(listTerminalReviews(ctx.db, req.params.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not list terminal reviews";
      res.status(reviewErrorStatus(message)).json({ error: message });
    }
  });

  router.post("/:id/reviews", (req, res) => {
    try {
      const result = prepareReview(req.params.id, req.body);
      const terminal = manager.get(req.params.id);
      ctx.broadcast("task:updated", result.task);
      ctx.broadcast("terminal:review", result.review);
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      if (terminal) {
        recordActivity(req.params.id, terminal.workspaceId, {
          idempotencyKey: `review:${result.review.id}:completion`,
          kind: "completion_requested",
          summary: result.review.evidence.summary,
          metadata: {
            reviewId: result.review.id,
            changedFilesCount: result.review.evidence.changedFiles.length,
            verificationCommandsCount: result.review.evidence.verificationCommands.length,
          },
        });
      }
      res.status(result.replayed ? 200 : 201).json({ ...result, terminal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not prepare terminal review";
      res.status(reviewErrorStatus(message)).json({ error: message });
    }
  });

  router.post("/:id/reviews/:reviewId/verify", async (req, res) => {
    if (!ctx.sessionManager) return res.status(503).json({ error: "Session manager not ready" });
    const qualityGate = createQualityGate(ctx.db, ctx.sessionManager, ctx.broadcast);
    try {
      const result = await runTerminalReview(
        ctx.db,
        req.params.id,
        req.params.reviewId,
        (taskId, config) => qualityGate.verify(taskId, config),
        { retry: req.body?.retry === true },
      );
      const terminal = manager.get(req.params.id);
      ctx.broadcast("terminal:review", result.review);
      ctx.broadcast("task:updated", result.task);
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      ctx.broadcast("project:updated", { projectId: String(result.task.project_id ?? "") });
      if (terminal && !result.stale && result.review.status !== "running" && result.review.status !== "pending") {
        recordActivity(req.params.id, terminal.workspaceId, {
          idempotencyKey: `review:${result.review.id}:attempt:${result.review.attempt}:${result.review.status}`,
          kind: "quality_gate_result",
          summary: `Quality Gate ${result.review.status.replaceAll("_", " ")}`,
          metadata: {
            reviewId: result.review.id,
            status: result.review.status,
            verificationId: result.review.verificationId,
            findingsCount: result.review.findings.length,
            hasNextReadyTask: result.hasNextReadyTask,
          },
        });
      }
      res.json({ ...result, terminal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Quality Gate failed";
      res.status(reviewErrorStatus(message)).json({ error: message });
    }
  });

  router.post("/:id/dismiss", (req, res) => {
    try {
      const terminal = manager.dismiss(req.params.id);
      if (!terminal) return res.status(404).json({ error: "Terminal not found" });
      ctx.broadcast("terminal:dismissed", {
        terminalId: terminal.id,
        workspaceId: terminal.workspaceId,
        projectId: terminal.projectId,
      });
      res.json({ status: "dismissed", terminalId: terminal.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Terminal dismissal failed";
      res.status(message === "Active terminal must be stopped before dismissal" ? 409 : 500).json({ error: message });
    }
  });

  router.delete("/:id", (req, res) => {
    const terminal = manager.kill(req.params.id);
    if (!terminal) return res.status(404).json({ error: "Terminal not found" });
    res.json({ status: "stopping", terminalId: terminal.id });
  });

  return router;
}
