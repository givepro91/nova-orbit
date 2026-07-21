import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate } from "../db/schema.js";
import { archiveGoalWorkspace, getWorkspace, listWorkspaces, upsertGoalWorkspace } from "../core/project/workspace.js";

describe("workspace foundation migration", () => {
  it("backfills goal workspaces and task sessions idempotently", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    db.exec(`
      INSERT INTO projects (id, name, source, base_branch)
      VALUES ('p1', 'Project', 'new', 'develop');
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch
      ) VALUES
        ('g1', 'p1', 'Pending goal', 'pending', 'goal_as_unit', NULL, NULL),
        ('g2', 'p1', 'Ready goal', 'ready', 'legacy', '/tmp/workspace-g2', 'agent/goal-g2'),
        ('g3', 'p1', 'Broken goal', 'broken', 'goal_as_unit', '/tmp/incomplete', NULL);
      INSERT INTO agents (id, project_id, name, role)
      VALUES ('a1', 'p1', 'Agent', 'backend');
      INSERT INTO tasks (id, goal_id, project_id, title, assignee_id)
      VALUES ('t2', 'g2', 'p1', 'Task', 'a1');
      INSERT INTO sessions (id, agent_id, task_id)
      VALUES ('s2', 'a1', 't2');
    `);

    migrate(db);
    const first = db.prepare(`
      SELECT id, goal_id, state, worktree_path, worktree_branch, base_ref, setup_progress
        FROM workspaces ORDER BY goal_id
    `).all();
    expect(first).toEqual([
      expect.objectContaining({
        goal_id: "g1", state: "pending", worktree_path: null,
        worktree_branch: null, base_ref: "develop", setup_progress: 0,
      }),
      expect.objectContaining({
        goal_id: "g2", state: "ready", worktree_path: "/tmp/workspace-g2",
        worktree_branch: "agent/goal-g2", base_ref: "develop", setup_progress: 100,
      }),
      expect.objectContaining({
        goal_id: "g3", state: "error", worktree_path: null,
        worktree_branch: null, base_ref: "develop", setup_progress: 0,
      }),
    ]);
    const linked = db.prepare("SELECT workspace_id, origin FROM sessions WHERE id = 's2'").get() as {
      workspace_id: string | null;
      origin: string;
    };
    expect(linked.workspace_id).toBe((first[1] as { id: string }).id);
    expect(linked.origin).toBe("orchestration");

    migrate(db);
    const second = db.prepare("SELECT id, goal_id FROM workspaces ORDER BY goal_id").all();
    expect(second).toEqual(first.map((row) => ({
      id: (row as { id: string }).id,
      goal_id: (row as { goal_id: string }).goal_id,
    })));
  });

  it("enforces one workspace per goal/path and one active row per session key", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    db.exec(`
      INSERT INTO projects (id, name, source) VALUES ('p1', 'Project', 'new');
      INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'Goal');
      INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Agent', 'backend');
      INSERT INTO workspaces (id, project_id, goal_id, name, worktree_path, worktree_branch)
      VALUES ('w1', 'p1', 'g1', 'Workspace', '/tmp/w1', 'agent/w1');
      INSERT INTO sessions (id, agent_id, session_key) VALUES ('s1', 'a1', 'key-1');
    `);

    expect(() => db.prepare(`
      INSERT INTO workspaces (id, project_id, goal_id, name)
      VALUES ('w2', 'p1', 'g1', 'Duplicate goal')
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO workspaces (id, project_id, name, worktree_path, worktree_branch)
      VALUES ('w3', 'p1', 'Duplicate path', '/tmp/w1', 'agent/w3')
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO sessions (id, agent_id, session_key) VALUES ('s2', 'a1', 'key-1')
    `).run()).toThrow();

    db.prepare("UPDATE sessions SET status = 'completed', ended_at = datetime('now') WHERE id = 's1'").run();
    expect(() => db.prepare(`
      INSERT INTO sessions (id, agent_id, session_key) VALUES ('s2', 'a1', 'key-1')
    `).run()).not.toThrow();
  });

  it("promotes one durable goal workspace from pending to ready", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    db.exec(`
      INSERT INTO projects (id, name, source, base_branch)
      VALUES ('p1', 'Project', 'new', 'main');
      INSERT INTO goals (id, project_id, title, description, goal_model)
      VALUES ('g1', 'p1', 'Workspace goal', 'Goal', 'goal_as_unit');
    `);

    const pendingId = upsertGoalWorkspace(db, "g1");
    expect(pendingId).toBeTruthy();
    expect(getWorkspace(db, pendingId!)).toEqual(expect.objectContaining({
      state: "pending",
      setupProgress: 0,
      worktreePath: null,
    }));

    db.prepare(`
      UPDATE goals
         SET worktree_path = '/tmp/workspace-g1', worktree_branch = 'agent/goal-g1'
       WHERE id = 'g1'
    `).run();
    const readyId = upsertGoalWorkspace(db, "g1");

    expect(readyId).toBe(pendingId);
    expect(getWorkspace(db, readyId!)).toEqual(expect.objectContaining({
      state: "ready",
      setupProgress: 100,
      worktreePath: "/tmp/workspace-g1",
      worktreeBranch: "agent/goal-g1",
    }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE goal_id = 'g1'").get())
      .toEqual({ count: 1 });
  });

  it("retires a merged goal workspace and keeps upsert from reviving it", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    db.exec(`
      INSERT INTO projects (id, name, source, base_branch)
      VALUES ('p1', 'Project', 'new', 'main');
      INSERT INTO goals (id, project_id, title, description, goal_model, worktree_path, worktree_branch)
      VALUES ('g1', 'p1', 'Merged goal', 'Goal', 'goal_as_unit', '/tmp/workspace-g1', 'goal/g1');
    `);
    const workspaceId = upsertGoalWorkspace(db, "g1")!;
    expect(getWorkspace(db, workspaceId)).toEqual(expect.objectContaining({ state: "ready" }));

    // squash 승인 경로: worktree 제거 → goals 메타 비움 → Workspace 은퇴
    db.prepare("UPDATE goals SET worktree_path = NULL, worktree_branch = NULL WHERE id = 'g1'").run();
    expect(archiveGoalWorkspace(db, "g1")).toBe(workspaceId);
    expect(getWorkspace(db, workspaceId)).toEqual(expect.objectContaining({
      state: "archived",
      worktreePath: null,
      worktreeBranch: null,
    }));
    expect(listWorkspaces(db, "p1")).toEqual([]);

    // 은퇴 후 재호출은 no-op — 'pending' 잔여 항목으로 되살아나면 안 된다
    expect(archiveGoalWorkspace(db, "g1")).toBeNull();
    expect(upsertGoalWorkspace(db, "g1")).toBe(workspaceId);
    expect(getWorkspace(db, workspaceId)).toEqual(expect.objectContaining({ state: "archived" }));
    expect(listWorkspaces(db, "p1")).toEqual([]);

    // 서버 재시작(migrate 재동기화)도 은퇴를 되돌리지 않는다
    migrate(db);
    expect(getWorkspace(db, workspaceId)).toEqual(expect.objectContaining({ state: "archived" }));
    expect(listWorkspaces(db, "p1")).toEqual([]);
  });

  it("revives an archived goal workspace when the goal gets a new worktree", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    db.exec(`
      INSERT INTO projects (id, name, source, base_branch)
      VALUES ('p1', 'Project', 'new', 'main');
      INSERT INTO goals (id, project_id, title, description, goal_model)
      VALUES ('g1', 'p1', 'Rerun goal', 'Goal', 'goal_as_unit');
    `);
    const workspaceId = upsertGoalWorkspace(db, "g1")!;
    archiveGoalWorkspace(db, "g1");

    db.prepare(`
      UPDATE goals SET worktree_path = '/tmp/workspace-g1-rerun', worktree_branch = 'goal/g1-rerun'
       WHERE id = 'g1'
    `).run();
    expect(upsertGoalWorkspace(db, "g1")).toBe(workspaceId);
    expect(getWorkspace(db, workspaceId)).toEqual(expect.objectContaining({
      state: "ready",
      worktreePath: "/tmp/workspace-g1-rerun",
      archivedAt: null,
    }));
    expect(listWorkspaces(db, "p1")).toHaveLength(1);
  });

  it("backfills workspaces left behind by merged goals", () => {
    const db = createDatabase(":memory:");
    migrate(db);
    db.exec(`
      INSERT INTO projects (id, name, source, base_branch)
      VALUES ('p1', 'Project', 'new', 'main');
      INSERT INTO goals (id, project_id, title, description, goal_model, squash_status)
      VALUES
        ('g1', 'p1', 'Merged goal', 'Goal', 'goal_as_unit', 'merged'),
        ('g2', 'p1', 'Live goal', 'Goal', 'goal_as_unit', 'none');
      INSERT INTO workspaces (id, project_id, goal_id, name, kind, state)
      VALUES
        ('w1', 'p1', 'g1', 'Merged goal', 'goal', 'pending'),
        ('w2', 'p1', 'g2', 'Live goal', 'goal', 'pending');
    `);

    migrate(db);

    expect(getWorkspace(db, "w1")).toEqual(expect.objectContaining({ state: "archived" }));
    expect(getWorkspace(db, "w2")).toEqual(expect.objectContaining({ state: "pending" }));
    expect(listWorkspaces(db, "p1").map((w) => w.id)).toEqual(["w2"]);
  });

  it("backfills merged workspaces whose worktree vanished, but keeps surviving ones", () => {
    const liveWorktree = mkdtempSync(join(tmpdir(), "crewdeck-ws-live-"));
    const goneWorktree = join(tmpdir(), "crewdeck-ws-gone-does-not-exist");
    try {
      const db = createDatabase(":memory:");
      migrate(db);
      db.prepare(`
        INSERT INTO projects (id, name, source, base_branch) VALUES ('p1', 'Project', 'new', 'main')
      `).run();
      db.prepare(`
        INSERT INTO goals (id, project_id, title, description, goal_model, squash_status, worktree_path, worktree_branch)
        VALUES ('g1', 'p1', 'Vanished worktree', 'Goal', 'goal_as_unit', 'merged', ?, 'goal/g1')
      `).run(goneWorktree);
      db.prepare(`
        INSERT INTO goals (id, project_id, title, description, goal_model, squash_status, worktree_path, worktree_branch)
        VALUES ('g2', 'p1', 'Cleanup failed', 'Goal', 'goal_as_unit', 'merged', ?, 'goal/g2')
      `).run(liveWorktree);

      migrate(db);

      const vanished = db.prepare("SELECT * FROM workspaces WHERE goal_id = 'g1'").get() as { id: string };
      const surviving = db.prepare("SELECT * FROM workspaces WHERE goal_id = 'g2'").get() as { id: string };
      // worktree 가 사라졌으면 은퇴시키고
      expect(getWorkspace(db, vanished.id)).toEqual(expect.objectContaining({
        state: "archived",
        worktreePath: null,
      }));
      // 실제로 살아 있으면 남긴다 — 사용자가 WIP 를 확인해야 한다
      expect(getWorkspace(db, surviving.id)).toEqual(expect.objectContaining({
        state: "ready",
        worktreePath: liveWorktree,
      }));
      expect(listWorkspaces(db, "p1").map((w) => w.id)).toEqual([surviving.id]);
    } finally {
      rmSync(liveWorktree, { recursive: true, force: true });
    }
  });
});
