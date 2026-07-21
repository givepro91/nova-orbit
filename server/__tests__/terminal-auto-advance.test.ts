import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { createTerminalAutoAdvance } from "../core/terminal/auto-advance.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  cleanup.splice(0).reverse().forEach((run) => run());
  vi.useRealTimers();
});

/**
 * 라이브에서 관측된 정지 상태를 그대로 재현한다:
 * 한 워크스페이스에 active 터미널이 둘, 하나는 아직 todo 인 다음 태스크를 이미 쥐고 있고
 * 다른 하나는 skipped 태스크를 쥐고 있어 '유휴'로 보인다.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "crewdeck-auto-advance-"));
  const db = createDatabase(join(dir, "crewdeck.db"));
  migrate(db);
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare(
    "INSERT INTO projects (id, name, source, workdir, execution_mode, default_provider) "
    + "VALUES ('p1', 'Project', 'local_import', ?, 'pty', 'claude')",
  ).run(dir);
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'Coder', 'coder')").run();
  db.prepare("INSERT INTO goals (id, project_id, title, description, sort_order) VALUES ('g1', 'p1', 'Goal', 'Ship it', 0)").run();
  db.prepare(`
    INSERT INTO workspaces (id, project_id, goal_id, active_goal_id, name, kind, state, worktree_path, worktree_branch)
    VALUES ('w1', 'p1', 'g1', 'g1', 'Workspace', 'goal', 'ready', ?, 'workspace/g1')
  `).run(dir);
  // 다음 ready 태스크 — 아직 todo 인데 termHolder 가 이미 붙들고 있다.
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status, sort_order, depends_on) "
    + "VALUES ('tNext', 'g1', 'p1', 'Next up', 'a1', 'todo', 0, '[]')",
  ).run();
  // termFree 가 쥔 태스크 — skipped 라 '유휴 터미널' 조건에 걸린다.
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status, sort_order, depends_on) "
    + "VALUES ('tSkipped', 'g1', 'p1', 'Abandoned', 'a1', 'skipped', 1, '[]')",
  ).run();
  db.prepare(
    "INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, status, goal_id, agent_id, active_task_id) "
    + "VALUES ('termHolder', 'w1', 'p1', '/bin/zsh', ?, 'active', 'g1', 'a1', 'tNext')",
  ).run(dir);
  db.prepare(
    "INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, status, goal_id, agent_id, active_task_id) "
    + "VALUES ('termFree', 'w1', 'p1', '/bin/zsh', ?, 'active', 'g1', 'a1', 'tSkipped')",
  ).run(dir);
  return db;
}

function driverFor(db: ReturnType<typeof fixture>, opts: { runningAgent?: string | null } = {}) {
  const writes: Array<{ terminalId: string; data: string }> = [];
  const manager = {
    get: (id: string) => ({ id, workspaceId: "w1", projectId: "p1", status: "active", contextState: "connected" }),
    write: (terminalId: string, data: string) => { writes.push({ terminalId, data }); return true; },
    create: () => { throw new Error("must not spawn a new terminal — one already holds the task"); },
    runningAgent: () => opts.runningAgent ?? null,
  } as never;
  const sessionManager = {} as never;
  const driver = createTerminalAutoAdvance(db, manager, sessionManager, () => {});
  return { driver, writes };
}

describe("terminal auto-advance", () => {
  it("starts the next task on the terminal that already holds it instead of deadlocking", async () => {
    const db = fixture();
    const { driver, writes } = driverFor(db);
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(5_000);
    driver.stop();

    // 라우팅이 termHolder 로 가야 한다. termFree 로 가면 session-binding 이
    // "Task is already bound to another terminal" 로 거부하고 폴마다 무한 반복된다.
    expect(writes.map((w) => w.terminalId)).toEqual(["termHolder"]);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'tNext'").get()).toEqual({ status: "in_progress" });
    expect(db.prepare("SELECT active_task_id FROM terminal_sessions WHERE id = 'termHolder'").get())
      .toEqual({ active_task_id: "tNext" });
  });

  it("does not type a shell command into a terminal already running an agent CLI", async () => {
    const db = fixture();
    // 이전 턴을 끝낸 codex TUI 가 foreground 에 남아 있는 상태(라이브 실측).
    const { driver, writes } = driverFor(db, { runningAgent: "codex" });
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(5_000);
    driver.stop();

    // 셸이 아니라 TUI 입력창에 들어가므로 아무것도 쓰면 안 되고, 태스크를 in_progress 로
    // 표시해서도 안 된다 — 표시만 되고 실제로는 아무것도 안 도는 상태가 만들어진다.
    expect(writes).toEqual([]);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'tNext'").get()).toEqual({ status: "todo" });
  });

  it("leaves the task alone when another agent's terminal holds it", async () => {
    const db = fixture();
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a2', 'p1', 'Other', 'coder')").run();
    db.prepare("UPDATE terminal_sessions SET agent_id = 'a2' WHERE id = 'termHolder'").run();
    const { driver, writes } = driverFor(db);
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(5_000);
    driver.stop();

    // 어디로 라우팅해도 거부되는 상태 — 조용히 넘겨야 한다(에러 로그를 5초마다 쌓지 않는다).
    expect(writes).toEqual([]);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'tNext'").get()).toEqual({ status: "todo" });
  });
});
