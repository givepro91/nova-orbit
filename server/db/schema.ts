import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(`
    -- Projects
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name TEXT NOT NULL,
      mission TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('new', 'local_import', 'github')),
      workdir TEXT NOT NULL DEFAULT '',
      github_config TEXT, -- JSON: { repoUrl, branch, autoPush, prMode }
      tech_stack TEXT,    -- JSON: { languages, frameworks, buildTool, ... }
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'paused')),
      autopilot TEXT NOT NULL DEFAULT 'off' CHECK (autopilot IN ('off', 'goal', 'full')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Agents
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'waiting_approval', 'paused', 'terminated')),
      system_prompt TEXT NOT NULL DEFAULT '',
      skills_dir TEXT,
      session_behavior TEXT NOT NULL DEFAULT 'resume-or-new',
      current_task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Goals
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      'references' TEXT NOT NULL DEFAULT '[]',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'pending_approval', 'in_progress', 'in_review', 'done', 'blocked')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      verification_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Verification Logs (Crewdeck Quality Gate results)
    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'conditional', 'fail')),
      scope TEXT NOT NULL DEFAULT 'standard' CHECK (scope IN ('lite', 'standard', 'full')),
      dimensions TEXT NOT NULL DEFAULT '{}', -- JSON: { functionality, dataFlow, ... }
      issues TEXT NOT NULL DEFAULT '[]',     -- JSON array of issues
      severity TEXT NOT NULL DEFAULT 'auto-resolve' CHECK (severity IN ('auto-resolve', 'soft-block', 'hard-block')),
      evaluator_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Agent Sessions (Claude Code CLI process tracking)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      pid INTEGER,          -- OS process ID
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'killed')),
      token_usage INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      last_output TEXT      -- Last output snippet for display
    );

    -- Activity Log (timeline feed)
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      type TEXT NOT NULL, -- 'task_started', 'task_completed', 'verification_pass', 'verification_fail', etc.
      message TEXT NOT NULL,
      metadata TEXT,     -- JSON
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_verifications_task ON verifications(task_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_activities_project ON activities(project_id);
  `);

  // Incremental migrations for existing databases

  // prompt_source 컬럼 추가 (기존 DB 호환)
  const agentColumnsEarly = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  const hasPromptSource = agentColumnsEarly.some((c) => c.name === "prompt_source");
  if (!hasPromptSource) {
    db.exec("ALTER TABLE agents ADD COLUMN prompt_source TEXT NOT NULL DEFAULT 'auto'");
  }

  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const hasTokenUsage = sessionColumns.some((c) => c.name === "token_usage");
  const hasCostUsd = sessionColumns.some((c) => c.name === "cost_usd");

  if (!hasTokenUsage) {
    db.exec("ALTER TABLE sessions ADD COLUMN token_usage INTEGER DEFAULT 0");
  }
  if (!hasCostUsd) {
    db.exec("ALTER TABLE sessions ADD COLUMN cost_usd REAL DEFAULT 0");
  }

  // Agent hierarchy: parent_id + expanded roles
  // SQLite cannot ALTER CHECK constraints, so we recreate the table if needed
  const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  const hasParentId = agentColumns.some((c) => c.name === "parent_id");

  if (!hasParentId) {
    // Recreate agents table with expanded role CHECK + parent_id + prompt_source
    db.exec("DROP TABLE IF EXISTS agents_new");
    db.exec(`
      CREATE TABLE agents_new (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
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
      INSERT INTO agents_new (id, project_id, name, role, status, system_prompt, prompt_source, skills_dir, session_behavior, current_task_id, created_at)
        SELECT id, project_id, name, role, status, COALESCE(system_prompt, ''), 'auto', skills_dir, COALESCE(session_behavior, 'resume-or-new'), current_task_id, COALESCE(created_at, datetime('now')) FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents_new RENAME TO agents;
      CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    `);
  } else {
    // role CHECK constraint removed — test with arbitrary role to detect legacy constraint
    let needsAgentsRecreate = false;
    try {
      db.pragma("foreign_keys = OFF");
      db.exec("INSERT INTO agents (project_id, name, role) VALUES ('__check__', '__check__', '__any_role__')");
      db.exec("DELETE FROM agents WHERE project_id = '__check__'");
    } catch {
      needsAgentsRecreate = true;
    } finally {
      db.pragma("foreign_keys = ON");
    }
    if (needsAgentsRecreate) {
      // CHECK failed — recreate
      db.exec("DROP TABLE IF EXISTS agents_new");
      db.exec(`
        CREATE TABLE agents_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
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
        INSERT INTO agents_new (id, project_id, name, role, status, system_prompt, prompt_source, skills_dir, session_behavior, current_task_id, parent_id, created_at)
          SELECT id, project_id, name, role, status, COALESCE(system_prompt, ''), COALESCE(prompt_source, 'auto'), skills_dir, COALESCE(session_behavior, 'resume-or-new'), current_task_id, parent_id, COALESCE(created_at, datetime('now')) FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_new RENAME TO agents;
        CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
      `);
    }
  }

  // Autopilot column on projects (off | goal | full)
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectColumns.some((c) => c.name === "autopilot")) {
    db.exec("ALTER TABLE projects ADD COLUMN autopilot TEXT NOT NULL DEFAULT 'off'");
  }

  // parent_task_id on tasks (for hierarchical delegation subtasks)
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  if (!taskColumns.some((c) => c.name === "parent_task_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE");
  }

  // started_at on tasks (Sprint 2: crash recovery)
  if (!taskColumns.some((c) => c.name === "started_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN started_at TEXT");
  }

  // result_summary on tasks (Sprint 6: context chain, added here early)
  if (!taskColumns.some((c) => c.name === "result_summary")) {
    db.exec("ALTER TABLE tasks ADD COLUMN result_summary TEXT");
  }

  // 폐기 diff 보존 — 검증 fail → checkpoint 복원이 버린 작업의 참고 사본 (재시도 프롬프트 주입용)
  if (!taskColumns.some((c) => c.name === "last_discarded_diff")) {
    db.exec("ALTER TABLE tasks ADD COLUMN last_discarded_diff TEXT");
  }

  // priority + sort_order on tasks (task execution ordering)
  if (!taskColumns.some((c) => c.name === "priority")) {
    db.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'");
  }
  if (!taskColumns.some((c) => c.name === "sort_order")) {
    db.exec("ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
  }

  // retry_count + reassign_count on tasks (auto-retry blocked tasks)
  if (!taskColumns.some((c) => c.name === "retry_count")) {
    db.exec("ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!taskColumns.some((c) => c.name === "reassign_count")) {
    db.exec("ALTER TABLE tasks ADD COLUMN reassign_count INTEGER NOT NULL DEFAULT 0");
  }

  // pending_approval status on tasks (Sprint 5: Trust UX)
  // SQLite cannot ALTER CHECK constraints — test with FK disabled to avoid false positive
  let needsTasksRecreate = false;
  try {
    db.pragma("foreign_keys = OFF");
    db.exec("INSERT INTO tasks (goal_id, project_id, title, status) VALUES ('__check__', '__check__', '__check__', 'pending_approval')");
    db.exec("DELETE FROM tasks WHERE goal_id = '__check__'");
  } catch {
    needsTasksRecreate = true;
  } finally {
    db.pragma("foreign_keys = ON");
  }

  if (needsTasksRecreate) {
    // CHECK failed — recreate tasks table with expanded status values
    // FK must be OFF during data migration to avoid self-reference violations
    // Wrapped in try/finally to guarantee FK is re-enabled even on crash
    try {
      db.pragma("foreign_keys = OFF");
      db.exec("DROP TABLE IF EXISTS tasks_new");
      db.exec(`
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
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
        INSERT INTO tasks_new (id, goal_id, project_id, title, description, assignee_id, parent_task_id, status, verification_id, started_at, result_summary, retry_count, reassign_count, created_at, updated_at)
          SELECT id, goal_id, project_id, title, COALESCE(description, ''), assignee_id, parent_task_id,
                 COALESCE(status, 'todo'), verification_id, started_at, result_summary, 0, 0,
                 COALESCE(created_at, datetime('now')), COALESCE(updated_at, datetime('now'))
          FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
      `);
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }

  // needs_worktree on agents — false for read-only roles (reviewer, qa) or user-configured
  // 사용자가 커스텀 에이전트를 만들 때도 직접 설정 가능
  const agentCols2 = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!agentCols2.some((c) => c.name === "needs_worktree")) {
    db.exec("ALTER TABLE agents ADD COLUMN needs_worktree INTEGER NOT NULL DEFAULT 1");
    // 기존 reviewer/qa 에이전트는 워크트리 불필요로 설정
    db.exec("UPDATE agents SET needs_worktree = 0 WHERE role IN ('reviewer', 'qa')");
  }

  // 기존 트리거 제거 — needs_worktree는 사용자가 UI에서 직접 설정
  db.exec("DROP TRIGGER IF EXISTS trg_agent_needs_worktree");

  // Composite index for session context chain queries (Sprint 6)
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_assignee_done ON tasks(assignee_id, status, updated_at DESC)");

  // title column on goals (separate title from description)
  const goalColumns = db.prepare("PRAGMA table_info(goals)").all() as { name: string }[];
  if (!goalColumns.some((c) => c.name === "title")) {
    db.exec("ALTER TABLE goals ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    // Backfill: existing goals use first 100 chars of description as title
    db.exec("UPDATE goals SET title = SUBSTR(description, 1, 100) WHERE title = ''");
  }

  // references column on goals (JSON array of file paths or URLs)
  if (!goalColumns.some((c) => c.name === "references")) {
    db.exec("ALTER TABLE goals ADD COLUMN 'references' TEXT NOT NULL DEFAULT '[]'");
  }

  // sort_order on goals (manual reordering)
  if (!goalColumns.some((c) => c.name === "sort_order")) {
    db.exec("ALTER TABLE goals ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
  }

  // Goal Specs table (Structured Planning — ManyFast-inspired)
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_specs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      goal_id TEXT NOT NULL UNIQUE REFERENCES goals(id) ON DELETE CASCADE,
      prd_summary TEXT NOT NULL DEFAULT '{}',
      feature_specs TEXT NOT NULL DEFAULT '[]',
      user_flow TEXT NOT NULL DEFAULT '[]',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      tech_considerations TEXT NOT NULL DEFAULT '[]',
      generated_by TEXT NOT NULL DEFAULT 'ai' CHECK (generated_by IN ('ai', 'manual')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_goal_specs_goal ON goal_specs(goal_id);
  `);

  // current_activity on agents — what the agent is currently doing (human-readable)
  const agentCols3 = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!agentCols3.some((c) => c.name === "current_activity")) {
    db.exec("ALTER TABLE agents ADD COLUMN current_activity TEXT");
  }

  // model on agents — per-agent model override (opus/sonnet/haiku/null)
  // null = use role default from ROLE_DEFAULT_MODEL
  if (!agentCols3.some((c) => c.name === "model")) {
    db.exec("ALTER TABLE agents ADD COLUMN model TEXT");
  }

  // target_files + stack_hint on tasks — scope anchoring (Pulsar scope-drift fix)
  // When set, the Generator prompt includes "Primary target: <paths>" and
  // the Evaluator checks that the diff actually touches those paths.
  const taskColsLate = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  if (!taskColsLate.some((c) => c.name === "target_files")) {
    // JSON array of file paths the task should modify. Example: ["web/src/app/page.tsx"]
    db.exec("ALTER TABLE tasks ADD COLUMN target_files TEXT NOT NULL DEFAULT '[]'");
  }
  if (!taskColsLate.some((c) => c.name === "stack_hint")) {
    // Short free-text constraint. Example: "Next.js 16 App Router, Tailwind 4"
    db.exec("ALTER TABLE tasks ADD COLUMN stack_hint TEXT NOT NULL DEFAULT ''");
  }

  // task_type on tasks — 태스크 유형별 검증 기준 차별화
  // 유효값: 'code' | 'content' | 'config' | 'review'
  // 기존 태스크는 'code' 기본값으로 처리
  if (!taskColsLate.some((c) => c.name === "task_type")) {
    db.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'code'");
  }

  // depends_on on tasks — DAG dependency support (JSON array of task IDs)
  // 기존 태스크는 '[]'이므로 동작 변화 없음
  if (!taskColsLate.some((c) => c.name === "depends_on")) {
    db.exec("ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'");
  }

  // Goal-as-Unit: acceptance_script on tasks — Task 수준 acceptance gate
  if (!taskColsLate.some((c) => c.name === "acceptance_script")) {
    db.exec("ALTER TABLE tasks ADD COLUMN acceptance_script TEXT");
  }

  // Goal-as-Unit: goals 테이블 컬럼 추가
  // 증분 마이그레이션 — 기존 goals는 DEFAULT 값으로 자동 적용 (legacy 호환)
  const goalColsLate = db.prepare("PRAGMA table_info(goals)").all() as { name: string }[];
  if (!goalColsLate.some((c) => c.name === "goal_model")) {
    db.exec("ALTER TABLE goals ADD COLUMN goal_model TEXT NOT NULL DEFAULT 'legacy'");
  }
  if (!goalColsLate.some((c) => c.name === "worktree_path")) {
    db.exec("ALTER TABLE goals ADD COLUMN worktree_path TEXT");
  }
  if (!goalColsLate.some((c) => c.name === "worktree_branch")) {
    db.exec("ALTER TABLE goals ADD COLUMN worktree_branch TEXT");
  }
  if (!goalColsLate.some((c) => c.name === "acceptance_script")) {
    db.exec("ALTER TABLE goals ADD COLUMN acceptance_script TEXT");
  }
  if (!goalColsLate.some((c) => c.name === "squash_commit_sha")) {
    db.exec("ALTER TABLE goals ADD COLUMN squash_commit_sha TEXT");
  }
  if (!goalColsLate.some((c) => c.name === "squash_status")) {
    db.exec("ALTER TABLE goals ADD COLUMN squash_status TEXT NOT NULL DEFAULT 'none'");
  }

  // Phase 3: QA 회귀 태스크 ID — squash 진입 전 1회만 생성 보장 (idempotent)
  if (!goalColsLate.some((c) => c.name === "qa_regression_task_id")) {
    db.exec("ALTER TABLE goals ADD COLUMN qa_regression_task_id TEXT");
  }

  // skip_adversarial on goals — 1이면 adversarial 태스크 자동 주입 건너뜀
  if (!goalColsLate.some((c) => c.name === "skip_adversarial")) {
    db.exec("ALTER TABLE goals ADD COLUMN skip_adversarial INTEGER NOT NULL DEFAULT 0");
  }

  // work_report on goals — before/after 서사 요약 + 스크린샷 메타 (JSON, nullable)
  if (!goalColsLate.some((c) => c.name === "work_report")) {
    db.exec("ALTER TABLE goals ADD COLUMN work_report TEXT");
  }

  // base_branch on projects — 기본값 'main', develop/master 등 지원
  const projectColsLate = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectColsLate.some((c) => c.name === "base_branch")) {
    db.exec("ALTER TABLE projects ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'");
  }

}

export function generateId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
