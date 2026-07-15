import { Router } from "express";
import type { AppContext } from "../../index.js";
import {
  createManualWorkspace,
  getWorkspace,
  getWorkspaceDiff,
  getWorkspaceFiles,
  listWorkspaces,
} from "../../core/project/workspace.js";

export function createWorkspaceRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    res.json(listWorkspaces(ctx.db, projectId));
  });

  router.post("/", (req, res) => {
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const baseRef = typeof req.body?.baseRef === "string" ? req.body.baseRef.trim() : undefined;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    if (!name) return res.status(400).json({ error: "name is required" });
    if (name.length > 120) return res.status(400).json({ error: "name is too long (max 120)" });
    if (baseRef && baseRef.length > 200) return res.status(400).json({ error: "baseRef is too long (max 200)" });

    try {
      const workspace = createManualWorkspace(ctx.db, { projectId, name, baseRef });
      ctx.broadcast("workspace:updated", { projectId, workspaceId: workspace.id, state: workspace.state });
      ctx.broadcast("project:updated", { projectId });
      res.status(201).json(workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workspace creation failed";
      if (message === `Project ${projectId} not found`) return res.status(404).json({ error: message });
      res.status(500).json({ error: message });
    }
  });

  router.get("/:id/diff", (req, res) => {
    const result = getWorkspaceDiff(ctx.db, req.params.id);
    if (!result) return res.status(404).json({ error: "Workspace not found" });
    res.json(result);
  });

  router.get("/:id/files", (req, res) => {
    const result = getWorkspaceFiles(ctx.db, req.params.id);
    if (!result) return res.status(404).json({ error: "Workspace not found" });
    res.json(result);
  });

  router.get("/:id", (req, res) => {
    const workspace = getWorkspace(ctx.db, req.params.id);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    res.json(workspace);
  });

  return router;
}
