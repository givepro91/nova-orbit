import { Router } from "express";
import type { AppContext } from "../../index.js";
import type { TaskStatus, TerminalBridgeGoalInput } from "../../../shared/types.js";
import {
  createTerminalBridgeGoal,
  createTerminalBridgeTask,
  finishTerminalBridgeAgentRun,
  getTerminalBridgeContext,
  listTerminalBridgeActivity,
  updateTerminalBridgeTask,
} from "../../core/terminal/bridge.js";
import { recordTerminalDecision } from "../../core/terminal/session-binding.js";

export function createTerminalBridgeRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/context", (req, res) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
    const terminalSessionId = typeof req.query.terminalSessionId === "string" ? req.query.terminalSessionId : undefined;
    if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
    try {
      res.json(getTerminalBridgeContext(ctx.db, workspaceId, terminalSessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read terminal context";
      res.status(message === "Workspace not found" ? 404 : 409).json({ error: message });
    }
  });

  router.get("/events", (req, res) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
    const goalId = typeof req.query.goalId === "string" ? req.query.goalId : undefined;
    const terminalSessionId = typeof req.query.terminalSessionId === "string" ? req.query.terminalSessionId : undefined;
    if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });
    try {
      res.json(listTerminalBridgeActivity(ctx.db, workspaceId, goalId, terminalSessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read terminal activity";
      res.status(message === "Workspace not found" ? 404 : 409).json({ error: message });
    }
  });

  router.post("/goals", (req, res) => {
    try {
      const result = createTerminalBridgeGoal(ctx.db, req.body as TerminalBridgeGoalInput);
      if (!result.replayed) {
        for (const task of result.tasks) ctx.broadcast("task:updated", task);
        ctx.broadcast("goal:created", {
          projectId: result.goal.project_id,
          goalId: result.goal.id,
          originWorkspaceId: req.body.workspaceId,
        });
        ctx.broadcast("terminal:bridge", {
          kind: "goal_created",
          workspaceId: req.body.workspaceId,
          goal: result.goal,
          tasks: result.tasks,
        });
        ctx.broadcast("project:updated", { projectId: result.goal.project_id });
        const projectId = String(result.goal.project_id);
        const project = ctx.db.prepare("SELECT autopilot FROM projects WHERE id = ?").get(projectId) as { autopilot: string } | undefined;
        if (project && project.autopilot !== "off") ctx.scheduler?.notifyGoalReady(projectId);
      }
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create goal";
      res.status(message === "Workspace not found" ? 404 : 400).json({ error: message });
    }
  });

  router.post("/tasks", (req, res) => {
    try {
      const result = createTerminalBridgeTask(ctx.db, {
        workspaceId: req.body?.workspaceId,
        terminalSessionId: req.body?.terminalSessionId,
        clientRequestId: req.body?.clientRequestId,
        goalId: req.body?.goalId,
        task: req.body?.task,
      });
      if (!result.replayed) {
        ctx.broadcast("task:updated", result.task);
        ctx.broadcast("terminal:bridge", { kind: "task_created", workspaceId: req.body.workspaceId, task: result.task });
        ctx.broadcast("project:updated", { projectId: (result.task as Record<string, unknown>).project_id });
      }
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create task";
      res.status(message === "Workspace not found" ? 404 : 400).json({ error: message });
    }
  });

  router.patch("/tasks/:id", (req, res) => {
    try {
      const result = updateTerminalBridgeTask(ctx.db, {
        workspaceId: req.body?.workspaceId,
        terminalSessionId: req.body?.terminalSessionId,
        clientRequestId: req.body?.clientRequestId,
        taskId: req.params.id,
        status: req.body?.status as TaskStatus,
        summary: req.body?.summary,
      });
      if (!result.replayed) {
        ctx.broadcast("task:updated", result.task);
        ctx.broadcast("terminal:bridge", {
          kind: "task_updated",
          workspaceId: req.body.workspaceId,
          task: result.task,
          evidence: "evidence" in result ? result.evidence : null,
        });
        ctx.broadcast("project:updated", { projectId: (result.task as Record<string, unknown>).project_id });
      }
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not update task";
      res.status(message === "Workspace not found" ? 404 : 400).json({ error: message });
    }
  });

  router.post("/agent-exit", (req, res) => {
    try {
      const result = finishTerminalBridgeAgentRun(ctx.db, {
        workspaceId: req.body?.workspaceId,
        terminalSessionId: req.body?.terminalSessionId,
        clientRequestId: req.body?.clientRequestId,
        provider: req.body?.provider,
        exitCode: Number(req.body?.exitCode),
      });
      if (result.task && !result.replayed) {
        ctx.broadcast("task:updated", result.task);
        ctx.broadcast("terminal:bridge", {
          kind: "task_updated",
          workspaceId: req.body.workspaceId,
          task: result.task,
          evidence: "evidence" in result ? result.evidence : null,
        });
        ctx.broadcast("project:updated", { projectId: (result.task as Record<string, unknown>).project_id });
      }
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reconcile agent exit";
      res.status(message === "Workspace not found" ? 404 : 400).json({ error: message });
    }
  });

  router.post("/decisions", (req, res) => {
    try {
      const terminalSessionId = typeof req.body?.terminalSessionId === "string" ? req.body.terminalSessionId : "";
      if (!terminalSessionId) return res.status(400).json({ error: "terminalSessionId is required" });
      const result = recordTerminalDecision(ctx.db, terminalSessionId, String(req.body?.message ?? ""));
      ctx.broadcast("terminal:decision", result.decision);
      if (result.task) ctx.broadcast("task:updated", result.task);
      const terminal = ctx.terminalManager?.get(terminalSessionId);
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not record the decision";
      res.status(message === "Terminal not found" ? 404 : 400).json({ error: message });
    }
  });

  return router;
}
