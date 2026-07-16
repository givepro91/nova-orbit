import { Router } from "express";
import type { AppContext } from "../../index.js";
import type { TerminalActivityKind } from "../../../shared/types.js";
import { createTerminalActivity, listTerminalActivities } from "../../core/terminal/activity.js";

function errorStatus(message: string): number {
  if (message === "Terminal not found" || message === "Workspace not found") return 404;
  if (message === "Terminal does not belong to workspace") return 403;
  if (message === "Terminal is not active" || message === "Terminal binding is inconsistent") return 409;
  return 400;
}

export function createTerminalActivityRoutes(
  ctx: AppContext,
  options: { requireTerminalSessionIdForList?: boolean } = {},
): Router {
  const router = Router();

  router.get("/", (req, res) => {
    try {
      const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
      const terminalSessionId = typeof req.query.terminalSessionId === "string" ? req.query.terminalSessionId : undefined;
      if (options.requireTerminalSessionIdForList && !terminalSessionId) {
        return res.status(400).json({ error: "terminalSessionId is required" });
      }
      res.json(listTerminalActivities(ctx.db, {
        workspaceId,
        goalId: typeof req.query.goalId === "string" ? req.query.goalId : undefined,
        taskId: typeof req.query.taskId === "string" ? req.query.taskId : undefined,
        terminalSessionId,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
        limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not list terminal activity";
      res.status(errorStatus(message)).json({ error: message });
    }
  });

  router.post("/", (req, res) => {
    try {
      const result = createTerminalActivity(ctx.db, {
        workspaceId: typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "",
        terminalSessionId: typeof req.body?.terminalSessionId === "string" ? req.body.terminalSessionId : "",
        idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : "",
        kind: req.body?.kind as TerminalActivityKind,
        summary: typeof req.body?.summary === "string" ? req.body.summary : "",
        metadata: req.body?.metadata,
      });
      if (!result.replayed) ctx.broadcast("terminal:activity", result.activity);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not record terminal activity";
      res.status(errorStatus(message)).json({ error: message });
    }
  });

  return router;
}
