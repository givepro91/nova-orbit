import { Router } from "express";
import type { AppContext } from "../../index.js";
import {
  bindTerminalSession,
  claimNextTerminalTask,
  listTerminalDecisions,
  recordTerminalDecision,
  requestTerminalTaskCompletion,
  startNextTerminalTask,
} from "../../core/terminal/session-binding.js";

export function createTerminalRoutes(ctx: AppContext): Router {
  const router = Router();
  const manager = ctx.terminalManager;
  if (!manager) throw new Error("Terminal manager is not configured");

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
      const result = startNextTerminalTask(ctx.db, req.params.id, {
        goalId: req.body?.goalId,
        agentId: req.body?.agentId,
        provider: req.body?.provider,
      }, (provider) => manager.write(req.params.id, `${provider}\r`));
      const terminal = manager.get(req.params.id);
      ctx.broadcast("task:updated", result.task);
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      ctx.broadcast("project:updated", { projectId: result.task.project_id });
      res.json({ ...result, terminal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the next task";
      res.status(message === "Terminal not found" ? 404 : 409).json({ error: message });
    }
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
      const result = requestTerminalTaskCompletion(ctx.db, req.params.id, String(req.body?.summary ?? ""));
      const terminal = manager.get(req.params.id);
      ctx.broadcast("task:updated", result.task);
      ctx.broadcast("terminal:bridge", {
        kind: "task_updated",
        workspaceId: terminal?.workspaceId,
        task: result.task,
        evidence: "evidence" in result ? result.evidence : null,
      });
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      ctx.broadcast("project:updated", { projectId: String((result.task as Record<string, unknown>).project_id ?? "") });
      res.json({ ...result, terminal });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not request task completion";
      res.status(message === "Terminal not found" ? 404 : 409).json({ error: message });
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
