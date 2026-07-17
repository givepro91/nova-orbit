import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";

/**
 * W0 마이그레이션 안전화 — legacy DB fixture 검증.
 *
 * fixture 3종(계획 §W0-4):
 *  (a) 구형 tasks 스키마(재생성 트리거되는 vintage) + 실데이터 → migrate 1회 → 전 컬럼·값 보존
 *  (b) 멱등성 — migrate 2회 적용 후 스키마·데이터 무변화
 *  (c) 신형(현행) DB에 migrate 재적용 → 재생성 경로를 타지 않음(무영향)
 * 추가:
 *  (d) 초구형 vintage(후기 컬럼 전부 부재) — "no such column" 클래스 봉인 확인
 *  (e) agents (project_id, name) 중복 정리 + UNIQUE index + INSERT OR IGNORE 실동작
 */

/**
 * 라이브 DB vintage: 'pending_approval'까지는 아는 status CHECK(= 구 probe가 재생성을
 * 스킵시키던 형상) + 이후 ALTER로 붙은 실데이터 컬럼(priority/sort_order/token_usage/
 * cost_usd/last_discarded_diff/retry_count/reassign_count)을 가진 tasks.
 */
function createLiveVintageDb(): Database.Database {
  const db = createDatabase(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mission TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('new', 'local_import', 'github')),
      workdir TEXT NOT NULL DEFAULT '',
      github_config TEXT,
      tech_stack TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'paused')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'waiting_approval', 'paused', 'terminated')),
      system_prompt TEXT NOT NULL DEFAULT '',
      prompt_source TEXT NOT NULL DEFAULT 'auto',
      skills_dir TEXT,
      session_behavior TEXT NOT NULL DEFAULT 'resume-or-new',
      current_task_id TEXT,
      parent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      'references' TEXT NOT NULL DEFAULT '[]',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      parent_task_id TEXT,
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'pending_approval', 'in_progress', 'in_review', 'done', 'blocked')),
      verification_id TEXT,
      started_at TEXT,
      result_summary TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      reassign_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      pid INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'killed')),
      last_output TEXT
    );
  `);
  // 라이브에서 이후 ALTER로 붙은 실데이터 컬럼들 (재생성 시 값 보존이 관건)
  db.exec("ALTER TABLE tasks ADD COLUMN last_discarded_diff TEXT");
  db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'");
  db.exec("ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE tasks ADD COLUMN token_usage INTEGER DEFAULT 0");
  db.exec("ALTER TABLE tasks ADD COLUMN cost_usd REAL DEFAULT 0");
  return db;
}

interface SeededTask {
  id: string;
  status: string;
  priority: string;
  sort_order: number;
  retry_count: number;
  reassign_count: number;
  token_usage: number | null;
  cost_usd: number | null;
  last_discarded_diff: string | null;
  result_summary: string | null;
  started_at: string | null;
  verification_id: string | null;
  parent_task_id: string | null;
  assignee_id: string | null;
}

const SEEDED_TASKS: SeededTask[] = [
  {
    id: "t1", status: "done", priority: "high", sort_order: 7,
    retry_count: 2, reassign_count: 1, token_usage: 12345, cost_usd: 1.23,
    last_discarded_diff: "diff --git a/x.ts b/x.ts\n-old\n+new",
    result_summary: "구현 완료 요약", started_at: "2026-07-01 10:00:00",
    verification_id: "v-1", parent_task_id: null, assignee_id: "a1",
  },
  {
    id: "t2", status: "blocked", priority: "low", sort_order: 2,
    retry_count: 3, reassign_count: 0, token_usage: 999, cost_usd: 0.05,
    last_discarded_diff: null, result_summary: null, started_at: null,
    verification_id: null, parent_task_id: null, assignee_id: "a1",
  },
  {
    id: "t3", status: "pending_approval", priority: "medium", sort_order: 0,
    retry_count: 0, reassign_count: 0, token_usage: 0, cost_usd: 0,
    last_discarded_diff: null, result_summary: null, started_at: null,
    verification_id: null, parent_task_id: null, assignee_id: null,
  },
  {
    id: "t4", status: "in_progress", priority: "critical", sort_order: 1,
    retry_count: 1, reassign_count: 2, token_usage: 42, cost_usd: 0.01,
    last_discarded_diff: null, result_summary: null, started_at: "2026-07-02 09:30:00",
    verification_id: null, parent_task_id: "t1", assignee_id: "a1",
  },
];

function seedLiveVintage(db: Database.Database): void {
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Proj', 'new')").run();
  db.prepare(
    "INSERT INTO agents (id, project_id, name, role, created_at) VALUES ('a1', 'p1', 'Dev', 'backend', '2026-01-01 00:00:00')",
  ).run();
  db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Goal', 'desc')").run();
  const insert = db.prepare(`
    INSERT INTO tasks (
      id, goal_id, project_id, title, description, assignee_id, parent_task_id, status,
      verification_id, started_at, result_summary, retry_count, reassign_count,
      last_discarded_diff, priority, sort_order, token_usage, cost_usd, created_at, updated_at
    ) VALUES (
      @id, 'g1', 'p1', @title, @description, @assignee_id, @parent_task_id, @status,
      @verification_id, @started_at, @result_summary, @retry_count, @reassign_count,
      @last_discarded_diff, @priority, @sort_order, @token_usage, @cost_usd,
      '2026-06-30 08:00:00', '2026-07-03 12:00:00'
    )
  `);
  for (const t of SEEDED_TASKS) {
    insert.run({ ...t, title: `Task ${t.id}`, description: `desc ${t.id}` });
  }
}

function taskColumnNames(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
}

function tasksSchemaSql(db: Database.Database): string {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
  ).get() as { sql: string };
  return row.sql;
}

describe("W0 fixture (a): 구형(라이브 vintage) tasks 재생성 — 전 컬럼·값 보존", () => {
  it("구형 CHECK는 skipped를 거부한다 (전제 확인)", () => {
    const db = createLiveVintageDb();
    seedLiveVintage(db);
    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('t-skip', 'g1', 'p1', 'x', 'skipped')",
      ).run();
    }).toThrow(/CHECK/);
  });

  it("migrate 1회 후 실데이터 값이 전부 보존된다 (retry/reassign 리터럴 0 덮어쓰기 없음)", () => {
    const db = createLiveVintageDb();
    seedLiveVintage(db);
    migrate(db);

    for (const expected of SEEDED_TASKS) {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(expected.id) as any;
      expect(row, `task ${expected.id} row`).toBeTruthy();
      expect(row.status).toBe(expected.status);
      expect(row.priority).toBe(expected.priority);
      expect(row.sort_order).toBe(expected.sort_order);
      expect(row.retry_count).toBe(expected.retry_count);
      expect(row.reassign_count).toBe(expected.reassign_count);
      expect(row.token_usage).toBe(expected.token_usage);
      expect(row.cost_usd).toBe(expected.cost_usd);
      expect(row.last_discarded_diff).toBe(expected.last_discarded_diff);
      expect(row.result_summary).toBe(expected.result_summary);
      expect(row.started_at).toBe(expected.started_at);
      expect(row.verification_id).toBe(expected.verification_id);
      expect(row.parent_task_id).toBe(expected.parent_task_id);
      expect(row.assignee_id).toBe(expected.assignee_id);
      expect(row.created_at).toBe("2026-06-30 08:00:00");
      expect(row.updated_at).toBe("2026-07-03 12:00:00");
      expect(row.title).toBe(`Task ${expected.id}`);
      expect(row.description).toBe(`desc ${expected.id}`);
    }
  });

  it("재생성 후 CHECK가 skipped를 허용하고, 잘못된 status는 여전히 거부한다", () => {
    const db = createLiveVintageDb();
    seedLiveVintage(db);
    migrate(db);

    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('t-skip', 'g1', 'p1', 'x', 'skipped')",
      ).run();
    }).not.toThrow();
    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('t-bogus', 'g1', 'p1', 'x', 'bogus')",
      ).run();
    }).toThrow(/CHECK/);
  });

  it("재생성 스키마는 현행 superset이고 인덱스 4개·FK pragma가 복원된다", () => {
    const db = createLiveVintageDb();
    seedLiveVintage(db);
    migrate(db);

    const cols = taskColumnNames(db);
    for (const col of [
      "task_type", "depends_on", "target_files", "stack_hint", "acceptance_script",
      "provider_trace_resolved_provider", "provider_failover_redispatched",
      "recovery_resume_phase", "recovery_checkpoint_head_sha",
      "requires_human_approval", "approval_reason",
      "execution_run_id", "execution_spec_version_id",
      "verification_id", "updated_at",
    ]) {
      expect(cols, `column ${col}`).toContain(col);
    }

    const indexNames = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'",
    ).all() as { name: string }[]).map((r) => r.name);
    expect(indexNames).toEqual(expect.arrayContaining([
      "idx_tasks_project", "idx_tasks_goal", "idx_tasks_assignee", "idx_tasks_assignee_done",
    ]));

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    // 재생성 이후에도 tasks 트리거는 복원되어 있어야 한다 (DROP TABLE이 트리거를 지우므로)
    const triggerNames = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tasks'",
    ).all() as { name: string }[]).map((r) => r.name);
    expect(triggerNames).toEqual(expect.arrayContaining([
      "tasks_inherit_active_execution_run", "tasks_close_execution_run",
    ]));
  });
});

describe("W0 fixture (b): 멱등성 — migrate 2회 후 스키마·데이터 무변화", () => {
  it("두 번째 migrate는 스키마 SQL과 tasks 데이터를 바꾸지 않는다", () => {
    const db = createLiveVintageDb();
    seedLiveVintage(db);
    migrate(db);

    const sqlAfterFirst = tasksSchemaSql(db);
    const colsAfterFirst = taskColumnNames(db);
    const rowsAfterFirst = JSON.stringify(db.prepare("SELECT * FROM tasks ORDER BY id").all());

    expect(() => migrate(db)).not.toThrow();

    expect(tasksSchemaSql(db)).toBe(sqlAfterFirst);
    expect(taskColumnNames(db)).toEqual(colsAfterFirst);
    expect(JSON.stringify(db.prepare("SELECT * FROM tasks ORDER BY id").all())).toBe(rowsAfterFirst);
  });
});

describe("W0 fixture (c): 신형(현행) DB — 재생성 경로를 타지 않는다", () => {
  it("fresh DB의 base CHECK가 이미 skipped를 알아 재적용 migrate가 무영향이다", () => {
    const db = createDatabase(":memory:");
    migrate(db);

    // fresh DB부터 skipped 삽입 가능 (base CREATE에 CHECK 포함 — 재생성 불필요의 전제)
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Proj', 'new')").run();
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'desc')").run();
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('t1', 'g1', 'p1', 'x', 'skipped')",
    ).run();

    // 재생성이 일어나면 sqlite_master의 tasks SQL 텍스트가 바뀐다(포맷이 다름) —
    // 불변이면 재생성 경로를 타지 않은 것.
    const sqlBefore = tasksSchemaSql(db);
    const rowsBefore = JSON.stringify(db.prepare("SELECT * FROM tasks ORDER BY id").all());

    expect(() => migrate(db)).not.toThrow();

    expect(tasksSchemaSql(db)).toBe(sqlBefore);
    expect(JSON.stringify(db.prepare("SELECT * FROM tasks ORDER BY id").all())).toBe(rowsBefore);
  });
});

describe("W0 추가: 초구형 vintage — 후기 컬럼 전부 부재여도 동적 교집합 복사로 통과", () => {
  it("verification_id/priority 등 없는 초구형 tasks도 migrate가 깨지지 않고 보존한다", () => {
    const db = createDatabase(":memory:");
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mission TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL CHECK (source IN ('new', 'local_import', 'github')),
        workdir TEXT NOT NULL DEFAULT '',
        github_config TEXT,
        tech_stack TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'paused')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'waiting_approval', 'paused', 'terminated')),
        system_prompt TEXT NOT NULL DEFAULT '',
        prompt_source TEXT NOT NULL DEFAULT 'auto',
        skills_dir TEXT,
        session_behavior TEXT NOT NULL DEFAULT 'resume-or-new',
        current_task_id TEXT,
        parent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
        progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'in_review', 'done', 'blocked')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Proj', 'new')").run();
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'desc')").run();
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, description, status) VALUES ('anc-1', 'g1', 'p1', 'Ancient', 'old row', 'done')",
    ).run();

    expect(() => migrate(db)).not.toThrow();

    const row = db.prepare("SELECT * FROM tasks WHERE id = 'anc-1'").get() as any;
    expect(row.title).toBe("Ancient");
    expect(row.description).toBe("old row");
    expect(row.status).toBe("done");
    // 부재했던 컬럼은 superset 기본값으로 채워진다
    expect(row.retry_count).toBe(0);
    expect(row.reassign_count).toBe(0);
    expect(row.priority).toBe("medium");
    expect(row.task_type).toBe("code");
    expect(row.target_files).toBe("[]");
    expect(row.depends_on).toBe("[]");
    expect(row.verification_id).toBeNull();

    // 초구형 CHECK에는 pending_approval도 없었다 — 재생성 후 둘 다 허용
    for (const status of ["pending_approval", "skipped"]) {
      expect(() => {
        db.prepare(
          `INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('anc-${status}', 'g1', 'p1', 'x', '${status}')`,
        ).run();
      }).not.toThrow();
    }
  });
});

describe("W0: agents (project_id, name) 중복 정리 + UNIQUE index", () => {
  function seedDuplicateAgents(db: Database.Database): void {
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Proj', 'new')").run();
    const insertAgent = db.prepare(
      "INSERT INTO agents (id, project_id, name, role, created_at) VALUES (?, 'p1', ?, 'reviewer', ?)",
    );
    insertAgent.run("dup-old", "[Crewdeck] Evaluator", "2026-01-01 00:00:00");
    insertAgent.run("dup-mid", "[Crewdeck] Evaluator", "2026-02-01 00:00:00");
    insertAgent.run("dup-new", "[Crewdeck] Evaluator", "2026-03-01 00:00:00");
    insertAgent.run("child", "Reviewer Child", "2026-03-02 00:00:00");
    db.prepare("UPDATE agents SET parent_id = 'dup-old' WHERE id = 'child'").run();

    db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Goal', 'desc')").run();
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status) VALUES ('td', 'g1', 'p1', 'x', 'dup-old', 'done')",
    ).run();
    const insertSession = db.prepare(
      "INSERT INTO sessions (id, agent_id, status) VALUES (?, ?, 'completed')",
    );
    insertSession.run("s-old", "dup-old");
    insertSession.run("s-mid", "dup-mid");
    insertSession.run("s-new", "dup-new");
  }

  it("최신 1개만 보존하고 sessions/tasks/parent_id 참조를 생존 row로 옮긴다", () => {
    const db = createLiveVintageDb();
    seedDuplicateAgents(db);
    migrate(db);

    const evaluators = db.prepare(
      "SELECT id FROM agents WHERE project_id = 'p1' AND name = '[Crewdeck] Evaluator'",
    ).all() as { id: string }[];
    expect(evaluators.map((r) => r.id)).toEqual(["dup-new"]);

    // sessions는 CASCADE 삭제되지 않고 전부 생존 row로 이관
    const sessions = db.prepare(
      "SELECT id, agent_id FROM sessions ORDER BY id",
    ).all() as { id: string; agent_id: string }[];
    expect(sessions).toHaveLength(3);
    expect(sessions.every((s) => s.agent_id === "dup-new")).toBe(true);

    const task = db.prepare("SELECT assignee_id FROM tasks WHERE id = 'td'").get() as any;
    expect(task.assignee_id).toBe("dup-new");

    const child = db.prepare("SELECT parent_id FROM agents WHERE id = 'child'").get() as any;
    expect(child.parent_id).toBe("dup-new");
  });

  it("UNIQUE index가 생성되어 INSERT OR IGNORE가 실제로 동작한다 (evaluator.ts 경로)", () => {
    const db = createLiveVintageDb();
    seedDuplicateAgents(db);
    migrate(db);

    const index = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agents_project_name'",
    ).get();
    expect(index).toBeTruthy();

    const ignored = db.prepare(
      "INSERT OR IGNORE INTO agents (project_id, name, role, system_prompt) VALUES ('p1', '[Crewdeck] Evaluator', 'reviewer', '')",
    ).run();
    expect(ignored.changes).toBe(0);

    expect(() => {
      db.prepare(
        "INSERT INTO agents (id, project_id, name, role) VALUES ('dup-again', 'p1', '[Crewdeck] Evaluator', 'reviewer')",
      ).run();
    }).toThrow(/UNIQUE/);

    const count = db.prepare(
      "SELECT COUNT(*) as c FROM agents WHERE project_id = 'p1' AND name = '[Crewdeck] Evaluator'",
    ).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("terminal_review_requests.agent_id / verification_issues.assignee_id 참조도 생존 row로 옮긴다", () => {
    // 이 두 테이블은 vintage fixture 시점엔 존재하지 않으므로(migrate가 생성),
    // 현행 DB에서 UNIQUE index를 걷어내 중복을 재현한 뒤 migrate 재적용으로 dedup을 태운다.
    const db = createDatabase(":memory:");
    migrate(db);
    db.exec("DROP INDEX idx_agents_project_name");

    db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'Proj', 'new')").run();
    const insertAgent = db.prepare(
      "INSERT INTO agents (id, project_id, name, role, created_at) VALUES (?, 'p1', ?, 'reviewer', ?)",
    );
    insertAgent.run("dup-old", "[Crewdeck] Evaluator", "2026-01-01 00:00:00");
    insertAgent.run("dup-new", "[Crewdeck] Evaluator", "2026-03-01 00:00:00");
    db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES ('g1', 'p1', 'Goal', 'desc')").run();
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES ('td', 'g1', 'p1', 'x', 'done')",
    ).run();

    db.prepare("INSERT INTO workspaces (id, project_id, goal_id, name) VALUES ('w1', 'p1', 'g1', 'WS')").run();
    db.prepare(
      "INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, agent_id) VALUES ('ts1', 'w1', 'p1', '/bin/zsh', '/tmp', 'dup-old')",
    ).run();
    db.prepare(`
      INSERT INTO terminal_review_requests (id, workspace_id, terminal_session_id, goal_id, task_id, agent_id, summary)
      VALUES ('trr1', 'w1', 'ts1', 'g1', 'td', 'dup-old', 'review me')
    `).run();
    db.prepare("INSERT INTO verifications (id, task_id, verdict) VALUES ('v1', 'td', 'fail')").run();
    db.prepare(`
      INSERT INTO verification_issues (
        id, verification_id, dimension, severity, evidence, repro_command,
        expected_result, actual_result, fix_instruction, assignee_id
      ) VALUES ('vi1', 'v1', 'functionality', 'critical', 'ev', 'cmd', 'exp', 'act', 'fix', 'dup-old')
    `).run();

    migrate(db);

    const evaluators = db.prepare(
      "SELECT id FROM agents WHERE project_id = 'p1' AND name = '[Crewdeck] Evaluator'",
    ).all() as { id: string }[];
    expect(evaluators.map((r) => r.id)).toEqual(["dup-new"]);

    const review = db.prepare("SELECT agent_id FROM terminal_review_requests WHERE id = 'trr1'").get() as any;
    expect(review.agent_id).toBe("dup-new");
    const issue = db.prepare("SELECT assignee_id FROM verification_issues WHERE id = 'vi1'").get() as any;
    expect(issue.assignee_id).toBe("dup-new");
  });

  it("멱등: 중복 정리 후 migrate 재적용해도 agents가 더 줄지 않는다", () => {
    const db = createLiveVintageDb();
    seedDuplicateAgents(db);
    migrate(db);
    const after1 = JSON.stringify(db.prepare("SELECT id, name, parent_id FROM agents ORDER BY id").all());
    expect(() => migrate(db)).not.toThrow();
    const after2 = JSON.stringify(db.prepare("SELECT id, name, parent_id FROM agents ORDER BY id").all());
    expect(after2).toBe(after1);
  });
});
