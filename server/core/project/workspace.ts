import type { Database } from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createManualWorkspaceWorktree, removeWorktree } from "./worktree.js";

export type WorkspaceKind = "goal" | "manual";
export type WorkspaceState = "pending" | "ready" | "error" | "archived";

interface WorkspaceRow {
  id: string;
  project_id: string;
  goal_id: string | null;
  name: string;
  kind: WorkspaceKind;
  state: WorkspaceState;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_ref: string;
  setup_step: string | null;
  setup_progress: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  session_count: number;
  active_session_count: number;
  terminal_session_count: number;
  active_terminal_session_count: number;
}

export interface WorkspaceReadModel {
  id: string;
  projectId: string;
  goalId: string | null;
  name: string;
  kind: WorkspaceKind;
  state: WorkspaceState;
  worktreePath: string | null;
  worktreeBranch: string | null;
  baseRef: string;
  setupStep: string | null;
  setupProgress: number;
  error: { code: string; message: string } | null;
  pathExists: boolean | null;
  dirty: boolean | null;
  sessionCount: number;
  activeSessionCount: number;
  terminalSessionCount: number;
  activeTerminalSessionCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface WorkspaceDiff {
  diff: string;
  truncated: boolean;
}

export interface WorkspaceFiles {
  files: string[];
  truncated: boolean;
}

const WORKSPACE_SELECT = `
  SELECT
    w.*,
    COUNT(s.id) AS session_count,
    SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END) AS active_session_count,
    (SELECT COUNT(*) FROM terminal_sessions ts WHERE ts.workspace_id = w.id) AS terminal_session_count,
    (SELECT COUNT(*) FROM terminal_sessions ts WHERE ts.workspace_id = w.id AND ts.status = 'active') AS active_terminal_session_count
  FROM workspaces w
  LEFT JOIN sessions s ON s.workspace_id = w.id
`;

function inspectDirty(worktreePath: string | null): { pathExists: boolean | null; dirty: boolean | null } {
  if (!worktreePath) return { pathExists: null, dirty: null };
  if (!existsSync(worktreePath)) return { pathExists: false, dirty: null };

  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 5_000,
    encoding: "utf-8",
  });
  return {
    pathExists: true,
    dirty: result.status === 0 ? Boolean(result.stdout) : null,
  };
}

function toReadModel(row: WorkspaceRow): WorkspaceReadModel {
  const health = inspectDirty(row.worktree_path);
  return {
    id: row.id,
    projectId: row.project_id,
    goalId: row.goal_id,
    name: row.name,
    kind: row.kind,
    state: row.state,
    worktreePath: row.worktree_path,
    worktreeBranch: row.worktree_branch,
    baseRef: row.base_ref,
    setupStep: row.setup_step,
    setupProgress: row.setup_progress,
    error: row.error_code && row.error_message
      ? { code: row.error_code, message: row.error_message }
      : null,
    pathExists: health.pathExists,
    dirty: health.dirty,
    sessionCount: Number(row.session_count ?? 0),
    activeSessionCount: Number(row.active_session_count ?? 0),
    terminalSessionCount: Number(row.terminal_session_count ?? 0),
    activeTerminalSessionCount: Number(row.active_terminal_session_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function listWorkspaces(db: Database, projectId?: string): WorkspaceReadModel[] {
  const rows = projectId
    ? db.prepare(`${WORKSPACE_SELECT} WHERE w.project_id = ? GROUP BY w.id ORDER BY w.created_at DESC`).all(projectId)
    : db.prepare(`${WORKSPACE_SELECT} GROUP BY w.id ORDER BY w.created_at DESC`).all();
  return (rows as WorkspaceRow[]).map(toReadModel);
}

export function getWorkspace(db: Database, workspaceId: string): WorkspaceReadModel | null {
  const row = db.prepare(`${WORKSPACE_SELECT} WHERE w.id = ? GROUP BY w.id`).get(workspaceId) as WorkspaceRow | undefined;
  return row ? toReadModel(row) : null;
}

export function createManualWorkspace(
  db: Database,
  input: { projectId: string; name: string; baseRef?: string },
): WorkspaceReadModel {
  const project = db.prepare(`
    SELECT id, workdir, COALESCE(NULLIF(trim(base_branch), ''), 'main') AS base_ref
      FROM projects
     WHERE id = ? AND status = 'active'
  `).get(input.projectId) as { id: string; workdir: string; base_ref: string } | undefined;
  if (!project) throw new Error(`Project ${input.projectId} not found`);
  if (!project.workdir.trim()) throw new Error(`Project ${input.projectId} has no workdir`);

  const name = input.name.trim();
  if (!name) throw new Error("Workspace name is required");
  const baseRef = input.baseRef?.trim() || project.base_ref;
  const workspaceId = (db.prepare(`
    INSERT INTO workspaces (
      project_id, name, kind, state, base_ref, setup_step, setup_progress
    ) VALUES (?, ?, 'manual', 'pending', ?, 'creating_worktree', 10)
    RETURNING id
  `).get(project.id, name, baseRef) as { id: string }).id;

  const created = createManualWorkspaceWorktree(project.workdir, name, baseRef);
  if (!created) {
    db.prepare(`
      UPDATE workspaces
         SET state = 'error', setup_step = 'worktree_failed', setup_progress = 0,
             error_code = 'worktree_create_failed',
             error_message = 'Git worktree를 만들 수 없습니다. 프로젝트 경로와 기준 브랜치를 확인하세요.',
             updated_at = datetime('now')
       WHERE id = ?
    `).run(workspaceId);
    return getWorkspace(db, workspaceId)!;
  }

  try {
    db.prepare(`
      UPDATE workspaces
         SET state = 'ready', worktree_path = ?, worktree_branch = ?,
             setup_step = 'ready', setup_progress = 100,
             error_code = NULL, error_message = NULL,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(created.path, created.branch, workspaceId);
  } catch (error) {
    removeWorktree(project.workdir, created.path, created.branch);
    throw error;
  }
  return getWorkspace(db, workspaceId)!;
}

export function getWorkspaceDiff(db: Database, workspaceId: string): WorkspaceDiff | null {
  const workspace = db.prepare(`
    SELECT worktree_path, base_ref FROM workspaces WHERE id = ?
  `).get(workspaceId) as { worktree_path: string | null; base_ref: string } | undefined;
  if (!workspace) return null;
  if (!workspace.worktree_path || !existsSync(workspace.worktree_path)) {
    return { diff: "", truncated: false };
  }
  const runGit = (args: string[], acceptedStatuses = [0]): string => {
    try {
      const result = spawnSync("git", args, {
        cwd: workspace.worktree_path!,
        stdio: "pipe",
        timeout: 15_000,
        encoding: "utf-8",
        maxBuffer: 20 * 1024 * 1024,
      });
      return result.status != null && acceptedStatuses.includes(result.status) ? result.stdout : "";
    } catch {
      return "";
    }
  };
  const committed = runGit(["diff", "--no-color", `${workspace.base_ref}...HEAD`]);
  const uncommitted = runGit(["diff", "--no-color", "HEAD"]);
  const untrackedFiles = runGit(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .slice(0, 100);
  const untracked = untrackedFiles.map((file) => runGit(
    ["diff", "--no-index", "--no-color", "--", "/dev/null", file],
    [0, 1],
  ));
  let diff = [committed, uncommitted, ...untracked].filter(Boolean).join("\n");
  const max = 500 * 1024;
  const truncated = diff.length > max;
  if (truncated) diff = `${diff.slice(0, max)}\n\n... (diff가 너무 커 잘렸습니다)`;
  return { diff, truncated };
}

export function getWorkspaceFiles(db: Database, workspaceId: string): WorkspaceFiles | null {
  const workspace = db.prepare("SELECT worktree_path FROM workspaces WHERE id = ?").get(workspaceId) as {
    worktree_path: string | null;
  } | undefined;
  if (!workspace) return null;
  if (!workspace.worktree_path || !existsSync(workspace.worktree_path)) {
    return { files: [], truncated: false };
  }

  const ignore = new Set([".git", "node_modules", "dist", ".crewdeck", ".crewdeck-worktrees", ".next", "coverage"]);
  const files: string[] = [];
  const maxFiles = 800;
  const walk = (dir: string, relative: string): void => {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (ignore.has(entry.name)) continue;
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relativePath);
      else files.push(relativePath);
    }
  };
  walk(workspace.worktree_path, "");
  return { files: files.sort(), truncated: files.length >= maxFiles };
}

/**
 * Mirrors the current goal worktree into the durable Workspace identity.
 * goals.worktree_path/worktree_branch remain authoritative in P0/P1.
 */
export function upsertGoalWorkspace(db: Database, goalId: string): string | null {
  const goal = db.prepare(`
    SELECT g.id, g.project_id, g.title, g.description, g.goal_model,
           g.worktree_path, g.worktree_branch, p.base_branch
      FROM goals g
      JOIN projects p ON p.id = g.project_id
     WHERE g.id = ?
  `).get(goalId) as {
    id: string;
    project_id: string;
    title: string;
    description: string;
    goal_model: string;
    worktree_path: string | null;
    worktree_branch: string | null;
    base_branch: string | null;
  } | undefined;
  if (!goal) throw new Error(`Goal ${goalId} not found`);
  if (goal.goal_model !== "goal_as_unit" && !goal.worktree_path && !goal.worktree_branch) return null;
  if (Boolean(goal.worktree_path) !== Boolean(goal.worktree_branch)) {
    throw new Error(`Goal worktree metadata is incomplete for goal ${goal.id}`);
  }

  const name = goal.title.trim() || goal.description.trim() || goal.id;
  const state: WorkspaceState = goal.worktree_path ? "ready" : "pending";
  const progress = state === "ready" ? 100 : 0;
  const baseRef = goal.base_branch?.trim() || "main";

  const existing = db.prepare("SELECT id FROM workspaces WHERE goal_id = ?").get(goal.id) as { id: string } | undefined;
  let workspaceId: string;
  if (existing) {
    db.prepare(`
      UPDATE workspaces
         SET project_id = ?, name = ?, kind = 'goal', state = ?,
             worktree_path = ?, worktree_branch = ?, base_ref = ?,
             setup_progress = ?, error_code = NULL, error_message = NULL,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(
      goal.project_id,
      name,
      state,
      goal.worktree_path,
      goal.worktree_branch,
      baseRef,
      progress,
      existing.id,
    );
    workspaceId = existing.id;
  } else {
    workspaceId = (db.prepare(`
      INSERT INTO workspaces (
        project_id, goal_id, name, kind, state,
        worktree_path, worktree_branch, base_ref, setup_progress
      ) VALUES (?, ?, ?, 'goal', ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      goal.project_id,
      goal.id,
      name,
      state,
      goal.worktree_path,
      goal.worktree_branch,
      baseRef,
      progress,
    ) as { id: string }).id;
  }

  return workspaceId;
}
