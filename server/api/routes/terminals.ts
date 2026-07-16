import { Router } from "express";
import type { TerminalKickoff } from "../../../shared/types.js";
import type { AppContext } from "../../index.js";
import {
  bindTerminalSession,
  claimNextTerminalTask,
  composeTaskKickoffMessage,
  listTerminalDecisions,
  recordTerminalDecision,
  requestTerminalTaskCompletion,
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

  router.post("/:id/claim-next", async (req, res) => {
    try {
      const task = claimNextTerminalTask(ctx.db, req.params.id, {
        goalId: req.body?.goalId,
        agentId: req.body?.agentId,
        provider: req.body?.provider,
      });
      // 수임이 DB 상태로 끝나면 터미널의 에이전트는 아무것도 모른다 — 실행 중인
      // REPL에는 착수 지시를 주입하고, 셸만 있으면 오실행 방지를 위해 아무것도
      // 타이핑하지 않고 agent_not_running으로 UI에 넘긴다.
      const runningProvider = manager.runningAgent(req.params.id);
      const kickoff: TerminalKickoff = runningProvider
        ? {
          status: (await manager.sendAgentMessage(req.params.id, composeTaskKickoffMessage(task))) ? "sent" : "failed",
          provider: runningProvider,
        }
        : { status: "agent_not_running", provider: null };
      const terminal = manager.get(req.params.id);
      ctx.broadcast("task:updated", task);
      if (terminal) ctx.broadcast("terminal:binding", terminal);
      ctx.broadcast("project:updated", { projectId: task.project_id });
      res.json({ task, terminal, kickoff });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not claim the next task";
      res.status(message === "Terminal not found" ? 404 : 409).json({ error: message });
    }
  });

  router.post("/:id/launch", async (req, res) => {
    const provider = req.body?.provider;
    if (provider !== "claude" && provider !== "codex") {
      return res.status(400).json({ error: "provider must be claude or codex" });
    }
    const existing = manager.get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Terminal not found" });
    if (existing.status !== "active") return res.status(409).json({ error: "Terminal is not active" });
    try {
      const runningProvider = manager.runningAgent(req.params.id);
      if (runningProvider && runningProvider !== provider) {
        // 실행 중인 REPL에 `claude` 텍스트를 타이핑하면 대화 메시지로 들어간다 — 차단.
        return res.json({ status: "conflict", runningProvider, kickoffSent: false, terminal: existing });
      }
      bindTerminalSession(ctx.db, req.params.id, { goalId: req.body?.goalId, provider });
      const terminal = manager.get(req.params.id)!;
      const wantKickoff = req.body?.kickoff === true;
      const boundTask = terminal.activeTaskId
        ? { id: terminal.activeTaskId, title: terminal.activeTaskTitle }
        : null;
      let kickoffSent = false;
      if (runningProvider) {
        if (wantKickoff && boundTask) {
          kickoffSent = await manager.sendAgentMessage(req.params.id, composeTaskKickoffMessage(boundTask));
        }
      } else {
        const prompt = wantKickoff && boundTask ? composeTaskKickoffMessage(boundTask) : undefined;
        if (!manager.launchAgentCommand(req.params.id, provider, prompt)) {
          return res.status(409).json({ error: "Could not write to the terminal" });
        }
        kickoffSent = prompt !== undefined;
      }
      ctx.broadcast("terminal:binding", terminal);
      ctx.broadcast("workspace:updated", { workspaceId: terminal.workspaceId, projectId: terminal.projectId });
      res.json({
        status: runningProvider ? "already_running" : "launched",
        runningProvider,
        kickoffSent,
        terminal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Terminal launch failed";
      res.status(409).json({ error: message });
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
