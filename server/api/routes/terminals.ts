import { Router } from "express";
import type { AppContext } from "../../index.js";

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

  router.delete("/:id", (req, res) => {
    const terminal = manager.kill(req.params.id);
    if (!terminal) return res.status(404).json({ error: "Terminal not found" });
    res.json({ status: "stopping", terminalId: terminal.id });
  });

  return router;
}
