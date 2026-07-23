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

function driverFor(
  db: ReturnType<typeof fixture>,
  opts: { runningAgent?: string | null; outputIdleMs?: number; orphaned?: string[]; resumeState?: "shell" | "idle" | null } = {},
) {
  const writes: Array<{ terminalId: string; data: string }> = [];
  const reapCalls: string[][] = [];
  const manager = {
    get: (id: string) => ({ id, workspaceId: "w1", projectId: "p1", status: "active", contextState: "connected" }),
    write: (terminalId: string, data: string) => { writes.push({ terminalId, data }); return true; },
    create: () => { throw new Error("must not spawn a new terminal — one already holds the task"); },
    runningAgent: () => opts.runningAgent ?? null,
    outputIdleMs: () => opts.outputIdleMs ?? 0,
    resumeState: () => opts.resumeState ?? null,
    reapOrphanedPersistentTerminals: () => {
      // 실물과 같은 계약: 걷어낸 행은 더 이상 active 가 아니므로 다음 호출에선 비어 있다.
      const reaped = reapCalls.length === 0 ? opts.orphaned ?? [] : [];
      for (const id of reaped) {
        db.prepare("UPDATE terminal_sessions SET status = 'interrupted' WHERE id = ?").run(id);
      }
      reapCalls.push(reaped);
      return reaped;
    },
  } as never;
  const sessionManager = {} as never;
  const driver = createTerminalAutoAdvance(db, manager, sessionManager, () => {});
  return { driver, writes, reapCalls };
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

  it("reaps terminals whose runtime vanished before routing the next task", async () => {
    const db = fixture();
    // tmux 서버가 사라지면 DB 는 status='active' 인데 런타임이 없는 유령이 남는다. 걷어내지
    // 않으면 resolveAgentTerminal 이 그 유령을 계속 재사용 대상으로 골라 착수가 영원히 막힌다.
    const { driver, writes, reapCalls } = driverFor(db, { orphaned: ["termFree"] });
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(10_000); // 2 틱
    driver.stop();

    expect(reapCalls[0]).toEqual(["termFree"]);
    expect(reapCalls.length).toBeGreaterThan(1); // 폴마다 확인한다 — 부팅 때 한 번이 아니라
    expect(db.prepare("SELECT status FROM terminal_sessions WHERE id = 'termFree'").get())
      .toEqual({ status: "interrupted" });
    // 유령을 걷어내도 살아 있는 터미널의 라우팅은 그대로다.
    expect(writes.map((w) => w.terminalId)).toEqual(["termHolder"]);
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

  it("blocks an in_progress task whose terminal stopped producing output", async () => {
    const db = fixture();
    // 에이전트 CLI 가 입력 대기(신뢰 온보딩·로그인 만료 등)에 걸린 상태 — 프로세스는 살아 있어
    // runningAgent() 는 '정상 실행 중'으로 보고, 화면이 정지해 출력만 끊긴다.
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'tNext'").run();
    // 실물에선 startNextTerminalTask 가 착수와 함께 provider 를 남긴다 — 그게 "이 터미널이
    // 이 태스크를 집행 중"이라는 표식이고, 스톨 판정은 그 표식이 있을 때만 성립한다.
    db.prepare("UPDATE terminal_sessions SET provider = 'claude' WHERE id = 'termHolder'").run();
    const { driver, writes } = driverFor(db, { runningAgent: "codex", outputIdleMs: 11 * 60_000 });
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(5_000);
    driver.stop();

    const task = db.prepare("SELECT status, result_summary FROM tasks WHERE id = 'tNext'")
      .get() as { status: string; result_summary: string | null };
    expect(task.status).toBe("blocked");
    expect(task.result_summary).toContain("응답 없음");
    expect(writes).toEqual([]); // 멈춘 터미널에 명령을 더 써 넣지 않는다
  });

  it("leaves a task alone while its terminal is still producing output", async () => {
    const db = fixture();
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'tNext'").run();
    // 긴 빌드·테스트 중에도 TUI 는 스피너와 경과시간을 갱신하므로 출력이 이어진다.
    const { driver } = driverFor(db, { runningAgent: "codex", outputIdleMs: 30_000 });
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(5_000);
    driver.stop();

    expect(db.prepare("SELECT status FROM tasks WHERE id = 'tNext'").get()).toEqual({ status: "in_progress" });
  });

  it("does not stall-block a task whose terminal never launched an agent CLI", async () => {
    const db = fixture();
    // 사용자가 진행 중 태스크를 클릭하면 UI 가 새 터미널을 만들어 바인딩한다. goal 이 이미
    // 점유돼 있으면 드라이버는 착수하지 않으므로 그 터미널엔 CLI 가 없고(provider NULL),
    // 빈 셸은 영원히 무출력이다 — 이걸 스톨로 세면 멀쩡한 태스크가 blocked 로 뒤집힌다.
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'tNext'").run();
    const { driver } = driverFor(db, { outputIdleMs: 30 * 60_000 });
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(5_000);
    driver.stop();

    expect(db.prepare("SELECT status FROM tasks WHERE id = 'tNext'").get()).toEqual({ status: "in_progress" });
  });

  it("surfaces a stuck-but-alive terminal as resumable instead of deadlocking silently", async () => {
    const db = fixture();
    // 오류·연결 끊김으로 프롬프트에서 idle 인 CLI 가 tNext(todo)를 foreground 로 쥐고 있다.
    // auto-advance 는 runningAgent 가드로 재착수를 (올바르게) 거부하지만, 예전엔 그게 조용한
    // 교착이었다 — resume sweep 이 그 상태를 resume_state 로 표면화해야 한다.
    const { driver, writes } = driverFor(db, { runningAgent: "codex", resumeState: "idle" });
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(5_000);
    driver.stop();

    // 자동 재개는 하지 않는다 — 명령을 써 넣지 않고 태스크도 건드리지 않는다.
    expect(writes).toEqual([]);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 'tNext'").get()).toEqual({ status: "todo" });
    // 대신 멈춘 터미널이 재개 후보로 표면화된다.
    expect(db.prepare("SELECT resume_state FROM terminal_sessions WHERE id = 'termHolder'").get())
      .toEqual({ resume_state: "idle" });
    const warned = db.prepare(
      "SELECT COUNT(*) AS n FROM activities WHERE project_id = 'p1' AND type = 'autopilot_warning' AND message LIKE '%재개 필요%'",
    ).get() as { n: number };
    expect(warned.n).toBeGreaterThanOrEqual(1);
  });

  it("does not stall-block a task that a headless session owns", async () => {
    const db = fixture();
    // PTY 레인이 없어 스케줄러가 헤드리스로 폴백한 상태(2026-07-22 라이브 실측). 실행은
    // 백그라운드에서 정상 진행 중인데 터미널만 조용하다 — 터미널 무출력은 이 태스크의
    // 정지 신호가 아니다.
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'tNext'").run();
    db.prepare("UPDATE terminal_sessions SET provider = 'claude' WHERE id = 'termHolder'").run();
    db.prepare(
      "INSERT INTO sessions (id, agent_id, task_id, status, origin) "
      + "VALUES ('s1', 'a1', 'tNext', 'active', 'orchestration')",
    ).run();
    const { driver } = driverFor(db, { runningAgent: "codex", outputIdleMs: 11 * 60_000 });
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(5_000);
    driver.stop();

    expect(db.prepare("SELECT status FROM tasks WHERE id = 'tNext'").get()).toEqual({ status: "in_progress" });
  });

  it("blocks the task instead of retrying a review forever", async () => {
    const db = fixture();
    // 게이트가 데이터 상태 때문에 시작조차 못 하는 리뷰 — 재시도로는 절대 안 풀린다.
    db.prepare("UPDATE tasks SET status = 'in_review' WHERE id = 'tNext'").run();
    db.prepare(`
      INSERT INTO terminal_review_requests
        (id, workspace_id, terminal_session_id, goal_id, task_id, agent_id, status, scope, summary, attempt, error_message)
      VALUES ('rev1', 'w1', 'termHolder', 'g1', 'tNext', 'a1', 'error', 'standard', 'done', 3,
              'Handoff stage ''verification'' cannot precede ''verification''')
    `).run();
    const { driver } = driverFor(db);
    vi.useFakeTimers();

    driver.start();
    await vi.advanceTimersByTimeAsync(15_000); // 3 틱 — 상한을 넘겨도 재시도가 늘지 않아야 한다
    driver.stop();

    expect(db.prepare("SELECT status FROM tasks WHERE id = 'tNext'").get()).toEqual({ status: "blocked" });
    // 게이트를 다시 돌리지 않았으므로 attempt 는 그대로여야 한다.
    expect(db.prepare("SELECT attempt, status FROM terminal_review_requests WHERE id = 'rev1'").get())
      .toEqual({ attempt: 3, status: "error" });
    const blocked = db.prepare("SELECT result_summary AS s FROM tasks WHERE id = 'tNext'").get() as { s: string };
    expect(blocked.s).toContain("사람 확인 필요");
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
