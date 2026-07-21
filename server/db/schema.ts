import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

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
      queue_stopped INTEGER NOT NULL DEFAULT 0,
      execution_mode TEXT NOT NULL DEFAULT 'headless' CHECK (execution_mode IN ('headless', 'pty')),
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
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'pending_approval', 'in_progress', 'in_review', 'done', 'blocked', 'skipped')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      verification_id TEXT,
      provider_trace_resolved_provider TEXT,
      provider_trace_resolution_source TEXT,
      provider_failover_reason_code TEXT,
      provider_failover_user_message TEXT,
      provider_failover_from_provider TEXT,
      provider_failover_to_provider TEXT,
      provider_failover_redispatched INTEGER NOT NULL DEFAULT 0,
      provider_failover_loop_guard_blocked INTEGER NOT NULL DEFAULT 0,
      provider_failover_original_session_id TEXT,
      provider_failover_redispatched_session_id TEXT,
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
      implementation_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      termination_reason TEXT CHECK (termination_reason IN ('passed', 'conditional', 'hard_blocked', 'auto_fix_disabled', 'fix_round_limit', 'escalated_to_goal_qa', 'evaluator_error'))
    );

    -- Agent Sessions (Claude Code CLI process tracking)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      pid INTEGER,          -- OS process ID
      process_group_id INTEGER, -- POSIX process group ID for crash-safe tree termination
      process_started_at TEXT, -- OS start identity used to reject reused PID/PGID ownership
      process_executable TEXT, -- executable captured with the start identity
      process_parent_id INTEGER, -- parent at spawn; recovery accepts only it or OS reparenting to PID 1
      process_owner_token TEXT, -- CREWDECK_AGENT_ID captured before spawn for ownership proof
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'killed')),
      provider TEXT,
      provider_trace_resolved_provider TEXT,
      provider_trace_resolution_source TEXT,
      provider_failover_reason_code TEXT,
      provider_failover_user_message TEXT,
      provider_failover_from_provider TEXT,
      provider_failover_to_provider TEXT,
      provider_failover_redispatched INTEGER NOT NULL DEFAULT 0,
      provider_failover_loop_guard_blocked INTEGER NOT NULL DEFAULT 0,
      provider_failover_original_session_id TEXT,
      provider_failover_redispatched_session_id TEXT,
      task_id TEXT,         -- task this session was spawned to execute (redispatch correlation)
      runtime_session_id TEXT, -- provider conversation id (session separation/recovery evidence)
      token_usage INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      token_usage_reported INTEGER,
      cost_usd_reported INTEGER,
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

    -- Durable recovery audit trail. Each row is the user-facing result of one
    -- startup or abnormal-session reconciliation decision.
    CREATE TABLE IF NOT EXISTS recovery_incidents (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK (phase IN ('implementation', 'verification', 'fix', 'approval')),
      decision TEXT NOT NULL CHECK (decision IN ('resume', 'advance', 'wait_approval', 'blocked')),
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      user_action TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_recovery_incidents_goal ON recovery_incidents(goal_id, created_at DESC);
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
  if (!sessionColumns.some((c) => c.name === "token_usage_reported")) {
    db.exec("ALTER TABLE sessions ADD COLUMN token_usage_reported INTEGER");
  }
  if (!sessionColumns.some((c) => c.name === "cost_usd_reported")) {
    db.exec("ALTER TABLE sessions ADD COLUMN cost_usd_reported INTEGER");
  }
  // task_id on sessions — durable session↔task link for failover redispatch
  // correlation. Without it, backfillRedispatchSession can only match by
  // agent_id+provider+rowid, which mis-attributes an unrelated same-agent
  // session that lands in the same rowid window as the real redispatch spawn.
  if (!sessionColumns.some((c) => c.name === "task_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN task_id TEXT");
  }
  if (!sessionColumns.some((c) => c.name === "process_group_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN process_group_id INTEGER");
  }
  if (!sessionColumns.some((c) => c.name === "process_started_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN process_started_at TEXT");
  }
  if (!sessionColumns.some((c) => c.name === "process_executable")) {
    db.exec("ALTER TABLE sessions ADD COLUMN process_executable TEXT");
  }
  if (!sessionColumns.some((c) => c.name === "process_parent_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN process_parent_id INTEGER");
  }
  if (!sessionColumns.some((c) => c.name === "process_owner_token")) {
    db.exec("ALTER TABLE sessions ADD COLUMN process_owner_token TEXT");
  }

  // Agent hierarchy: parent_id + expanded roles
  // SQLite cannot ALTER CHECK constraints, so we recreate the table if needed
  const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  const hasParentId = agentColumns.some((c) => c.name === "parent_id");

  if (!hasParentId) {
    // Recreate agents table with expanded role CHECK + parent_id + prompt_source.
    // FK must be OFF: with FK ON, DROP TABLE agents runs an implicit DELETE whose
    // ON DELETE CASCADE wipes sessions. PRAGMA is a no-op inside a transaction,
    // so toggle it outside; the transaction keeps the swap atomic on crash.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
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
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
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
      // CHECK failed — recreate. FK must be OFF: with FK ON, DROP TABLE agents runs
      // an implicit DELETE whose ON DELETE CASCADE wipes sessions. PRAGMA is a no-op
      // inside a transaction, so toggle it outside; the transaction keeps the swap
      // atomic on crash.
      db.pragma("foreign_keys = OFF");
      try {
        db.transaction(() => {
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
        })();
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }
  }

  // Autopilot column on projects (off | goal | full)
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectColumns.some((c) => c.name === "autopilot")) {
    db.exec("ALTER TABLE projects ADD COLUMN autopilot TEXT NOT NULL DEFAULT 'off'");
  }
  if (!projectColumns.some((c) => c.name === "queue_stopped")) {
    db.exec("ALTER TABLE projects ADD COLUMN queue_stopped INTEGER NOT NULL DEFAULT 0");
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

  // token_usage + cost_usd on tasks (per-task cumulative usage — "헤맴" 프록시).
  // CREATE TABLE defines these but existing DBs need the ALTER; without it the
  // engine's per-task UPDATE throws "no such column" on task completion.
  if (!taskColumns.some((c) => c.name === "token_usage")) {
    db.exec("ALTER TABLE tasks ADD COLUMN token_usage INTEGER DEFAULT 0");
  }
  if (!taskColumns.some((c) => c.name === "cost_usd")) {
    db.exec("ALTER TABLE tasks ADD COLUMN cost_usd REAL DEFAULT 0");
  }

  // tasks status CHECK 확장(재생성)은 migrate() 내 모든 tasks ALTER-add 이후에 있어야
  // 하므로 아래(taskRunCols 블록 뒤)로 이동했다 — "tasks status CHECK recreate" 참조.

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

  // provider on agents — per-agent 실행 백엔드 override ("claude"|"codex"|null)
  // null = project.default_provider → 전역 기본으로 상속 (하위호환: 미설정 = claude)
  if (!agentCols3.some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE agents ADD COLUMN provider TEXT");
  }

  // default_provider on projects — 프로젝트 기본 실행 백엔드 (null = 전역 기본)
  const projectColsProv = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectColsProv.some((c) => c.name === "default_provider")) {
    db.exec("ALTER TABLE projects ADD COLUMN default_provider TEXT");
  }

  // execution_mode on projects — 'headless'(기본, stream-json 무인) | 'pty'(터미널 실행, 실시간 TUI 관찰)
  const projectColsExec = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectColsExec.some((c) => c.name === "execution_mode")) {
    db.exec("ALTER TABLE projects ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'headless'");
  }

  // provider on sessions — 세션이 실제 돈 백엔드 (관찰·비용 귀속·failover 추적)
  const sessionColsProv = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionColsProv.some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT");
  }
  if (!sessionColsProv.some((c) => c.name === "runtime_session_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN runtime_session_id TEXT");
  }
  const sessionProviderTraceColumns = [
    ["provider_trace_resolved_provider", "ALTER TABLE sessions ADD COLUMN provider_trace_resolved_provider TEXT"],
    ["provider_trace_resolution_source", "ALTER TABLE sessions ADD COLUMN provider_trace_resolution_source TEXT"],
    ["provider_failover_reason_code", "ALTER TABLE sessions ADD COLUMN provider_failover_reason_code TEXT"],
    ["provider_failover_user_message", "ALTER TABLE sessions ADD COLUMN provider_failover_user_message TEXT"],
    ["provider_failover_from_provider", "ALTER TABLE sessions ADD COLUMN provider_failover_from_provider TEXT"],
    ["provider_failover_to_provider", "ALTER TABLE sessions ADD COLUMN provider_failover_to_provider TEXT"],
    ["provider_failover_redispatched", "ALTER TABLE sessions ADD COLUMN provider_failover_redispatched INTEGER NOT NULL DEFAULT 0"],
    ["provider_failover_loop_guard_blocked", "ALTER TABLE sessions ADD COLUMN provider_failover_loop_guard_blocked INTEGER NOT NULL DEFAULT 0"],
    ["provider_failover_original_session_id", "ALTER TABLE sessions ADD COLUMN provider_failover_original_session_id TEXT"],
    ["provider_failover_redispatched_session_id", "ALTER TABLE sessions ADD COLUMN provider_failover_redispatched_session_id TEXT"],
  ];
  for (const [name, sql] of sessionProviderTraceColumns) {
    if (!sessionColsProv.some((c) => c.name === name)) {
      db.exec(sql);
    }
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

  // Provider trace on tasks — API contract for resolved backend + failover observability.
  const taskProviderTraceColumns = [
    ["provider_trace_resolved_provider", "ALTER TABLE tasks ADD COLUMN provider_trace_resolved_provider TEXT"],
    ["provider_trace_resolution_source", "ALTER TABLE tasks ADD COLUMN provider_trace_resolution_source TEXT"],
    ["provider_failover_reason_code", "ALTER TABLE tasks ADD COLUMN provider_failover_reason_code TEXT"],
    ["provider_failover_user_message", "ALTER TABLE tasks ADD COLUMN provider_failover_user_message TEXT"],
    ["provider_failover_from_provider", "ALTER TABLE tasks ADD COLUMN provider_failover_from_provider TEXT"],
    ["provider_failover_to_provider", "ALTER TABLE tasks ADD COLUMN provider_failover_to_provider TEXT"],
    ["provider_failover_redispatched", "ALTER TABLE tasks ADD COLUMN provider_failover_redispatched INTEGER NOT NULL DEFAULT 0"],
    ["provider_failover_loop_guard_blocked", "ALTER TABLE tasks ADD COLUMN provider_failover_loop_guard_blocked INTEGER NOT NULL DEFAULT 0"],
    ["provider_failover_original_session_id", "ALTER TABLE tasks ADD COLUMN provider_failover_original_session_id TEXT"],
    ["provider_failover_redispatched_session_id", "ALTER TABLE tasks ADD COLUMN provider_failover_redispatched_session_id TEXT"],
  ];
  for (const [name, sql] of taskProviderTraceColumns) {
    if (!taskColsLate.some((c) => c.name === name)) {
      db.exec(sql);
    }
  }

  // Goal-as-Unit: acceptance_script on tasks — Task 수준 acceptance gate
  if (!taskColsLate.some((c) => c.name === "acceptance_script")) {
    db.exec("ALTER TABLE tasks ADD COLUMN acceptance_script TEXT");
  }

  // Crash recovery evidence — captured immediately before a Goal-as-Unit task
  // starts mutating its shared worktree. Startup recovery compares these
  // values read-only before deciding whether the task may run again.
  const taskRecoveryColumns = [
    ["recovery_checkpoint_head_sha", "ALTER TABLE tasks ADD COLUMN recovery_checkpoint_head_sha TEXT"],
    ["recovery_worktree_branch", "ALTER TABLE tasks ADD COLUMN recovery_worktree_branch TEXT"],
    ["recovery_worktree_dirty", "ALTER TABLE tasks ADD COLUMN recovery_worktree_dirty INTEGER"],
    ["recovery_worktree_diff_hash", "ALTER TABLE tasks ADD COLUMN recovery_worktree_diff_hash TEXT"],
    ["recovery_manual_action_required", "ALTER TABLE tasks ADD COLUMN recovery_manual_action_required INTEGER NOT NULL DEFAULT 0"],
    ["recovery_manual_action_reason", "ALTER TABLE tasks ADD COLUMN recovery_manual_action_reason TEXT"],
    ["recovery_commit_ready", "ALTER TABLE tasks ADD COLUMN recovery_commit_ready INTEGER NOT NULL DEFAULT 0"],
    ["recovery_commit_sha", "ALTER TABLE tasks ADD COLUMN recovery_commit_sha TEXT"],
    ["recovery_resume_phase", "ALTER TABLE tasks ADD COLUMN recovery_resume_phase TEXT CHECK (recovery_resume_phase IN ('implementation', 'verification', 'fix'))"],
  ];
  for (const [name, sql] of taskRecoveryColumns) {
    if (!taskColsLate.some((c) => c.name === name)) db.exec(sql);
  }

  // Plan-review gate: 리뷰어 에이전트 자동 승인 + CEO 에스컬레이션
  // requires_human_approval=1 이면 decompose 계획 리뷰가 사람 승인(pending_approval)으로 남긴다.
  // approval_reason 은 리뷰어/decompose 가 판정한 에스컬레이션·반려 사유.
  const taskPlanReviewColumns = [
    ["requires_human_approval", "ALTER TABLE tasks ADD COLUMN requires_human_approval INTEGER NOT NULL DEFAULT 0"],
    ["approval_reason", "ALTER TABLE tasks ADD COLUMN approval_reason TEXT"],
  ];
  for (const [name, sql] of taskPlanReviewColumns) {
    if (!taskColsLate.some((c) => c.name === name)) db.exec(sql);
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
  if (!goalColsLate.some((c) => c.name === "squash_checkpoint_base_sha")) {
    db.exec("ALTER TABLE goals ADD COLUMN squash_checkpoint_base_sha TEXT");
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

  // acceptance_output on goals — squash 직전 acceptance_script 의 실제 출력.
  // 승인 다이얼로그의 "검증 결과" 칸 데이터. broadcast 만으로는 새로고침·재접속 시 사라져
  // squash-preview 재조회 경로가 빈칸이 되므로 함께 보존한다. work_report 와 분리하는 이유는
  // 비동기 서사 생성이 work_report 를 통째로 덮어써서 같이 두면 유실되기 때문.
  if (!goalColsLate.some((c) => c.name === "acceptance_output")) {
    db.exec("ALTER TABLE goals ADD COLUMN acceptance_output TEXT");
  }

  // source_material on goals — 사용자가 붙여넣은 원본 자료(MD). 있으면 기획서 생성의
  // 1차 근거로 쓴다 (사용자가 미리 준비한 자료 기반 목표+기획서 생성 경로).
  if (!goalColsLate.some((c) => c.name === "source_material")) {
    db.exec("ALTER TABLE goals ADD COLUMN source_material TEXT");
  }

  // 실행 전 Goal Spec 승인 게이트 (immutable version snapshots).
  // execution_spec_version_id: 승인 시 고정되는 실행 기준 version(goal_spec_versions.id).
  //   null = 미승인. 모든 실행 단계가 이 동일 snapshot 을 참조한다.
  // spec_approval_required: opt-in marker. 새 승인 워크플로(POST /spec-versions)를 거친
  //   goal 만 1 이 되어 게이트 적용을 받는다. 기존/legacy goal(0)은 게이트 무조건 통과.
  if (!goalColsLate.some((c) => c.name === "execution_spec_version_id")) {
    db.exec("ALTER TABLE goals ADD COLUMN execution_spec_version_id TEXT");
  }
  if (!goalColsLate.some((c) => c.name === "spec_approval_required")) {
    db.exec("ALTER TABLE goals ADD COLUMN spec_approval_required INTEGER NOT NULL DEFAULT 0");
  }
  if (!goalColsLate.some((c) => c.name === "active_execution_run_id")) {
    db.exec("ALTER TABLE goals ADD COLUMN active_execution_run_id TEXT");
  }
  if (!goalColsLate.some((c) => c.name === "pending_execution_spec_version_id")) {
    db.exec("ALTER TABLE goals ADD COLUMN pending_execution_spec_version_id TEXT");
  }

  // Merge honesty: squash_status='merged'는 "goal 파이프라인 완료"를 뜻할 뿐이라,
  // 실제로 어디에 어떻게 반영됐는지(origin 직접 반영 / PR 생성·머지대기 / 로컬만)를
  // 별도 축으로 기록한다. legacy merged goal은 전부 NULL → 프론트가 기존 "반영 완료"로 폴백.
  //   merge_outcome: 'applied' | 'pr_open' | 'local' | NULL
  //   pr_state:      'open' | 'merged' | 'closed' | NULL (gh 조회 결과, pr_open 한정)
  if (!goalColsLate.some((c) => c.name === "merge_outcome")) {
    db.exec("ALTER TABLE goals ADD COLUMN merge_outcome TEXT");
  }
  if (!goalColsLate.some((c) => c.name === "pr_url")) {
    db.exec("ALTER TABLE goals ADD COLUMN pr_url TEXT");
  }
  if (!goalColsLate.some((c) => c.name === "pr_number")) {
    db.exec("ALTER TABLE goals ADD COLUMN pr_number INTEGER");
  }
  if (!goalColsLate.some((c) => c.name === "pr_state")) {
    db.exec("ALTER TABLE goals ADD COLUMN pr_state TEXT");
  }
  if (!goalColsLate.some((c) => c.name === "pr_state_checked_at")) {
    db.exec("ALTER TABLE goals ADD COLUMN pr_state_checked_at TEXT");
  }

  const taskRunCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  if (!taskRunCols.some((c) => c.name === "execution_run_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN execution_run_id TEXT");
  }
  if (!taskRunCols.some((c) => c.name === "execution_spec_version_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN execution_spec_version_id TEXT");
  }
  // W1: skipped terminal state 부속 컬럼 — 반드시 아래 재생성 블록보다 앞(vintage 경로)이며
  // tasks_new superset 정의에도 동일 컬럼이 포함되어야 한다.
  // skip_reason: 건너뜀 사유 key 값('retry_exhausted' 등) — 표시는 프론트 번역.
  // plan_review_status: 계획 리뷰 provenance(pending/approved/failed). NULL = 리뷰 게이트
  // 도입 전 legacy 태스크만 — startQueue 자동승인은 NULL만 대상으로 한다.
  if (!taskRunCols.some((c) => c.name === "skip_reason")) {
    db.exec("ALTER TABLE tasks ADD COLUMN skip_reason TEXT");
  }
  if (!taskRunCols.some((c) => c.name === "plan_review_status")) {
    db.exec("ALTER TABLE tasks ADD COLUMN plan_review_status TEXT CHECK (plan_review_status IN ('pending', 'approved', 'failed'))");
  }
  const sessionRunCols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionRunCols.some((c) => c.name === "execution_run_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN execution_run_id TEXT");
  }
  if (!sessionRunCols.some((c) => c.name === "execution_spec_version_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN execution_spec_version_id TEXT");
  }

  // tasks status CHECK recreate — 'skipped' terminal state (W0 마이그레이션 안전화).
  // SQLite cannot ALTER CHECK constraints — probe with FK disabled to avoid false positive.
  // Probe는 반드시 CHECK에 '가장 최근 추가된' 상태값('skipped')으로 검사한다. 구 값
  // ('pending_approval') probe는 그 값을 이미 아는 DB에서 재생성을 스킵시켜 새 CHECK가
  // 영영 반영되지 않는다(첫 'skipped' 쓰기에서 CHECK violation 크래시).
  // 이 블록은 migrate() 내 모든 tasks ALTER-add 이후에 위치해야 한다 — 재생성 스키마가
  // 현행 superset이라, 앞에 두면 구형 DB에는 아직 없는 컬럼이 섞인다. tasks 트리거
  // (tasks_inherit_active_execution_run 등)는 DROP TABLE과 함께 사라지지만 아래에서
  // 매 migrate마다 무조건 DROP+CREATE로 재생성되므로 안전하다.
  let needsTasksRecreate = false;
  try {
    db.pragma("foreign_keys = OFF");
    db.exec("INSERT INTO tasks (goal_id, project_id, title, status) VALUES ('__check__', '__check__', '__check__', 'skipped')");
    db.exec("DELETE FROM tasks WHERE goal_id = '__check__'");
  } catch {
    needsTasksRecreate = true;
  } finally {
    db.pragma("foreign_keys = ON");
  }

  if (needsTasksRecreate) {
    // CHECK failed — recreate tasks table with expanded status values.
    // FK must be OFF: with FK ON, DROP TABLE tasks runs an implicit DELETE whose
    // ON DELETE actions ripple into referencing tables, and self-referencing
    // parent_task_id rows would violate during copy. PRAGMA foreign_keys는
    // 트랜잭션 안에서 no-op이므로 반드시 바깥에서 토글하고, 본체는 transaction으로
    // 감싸 중간 크래시 시 원자적으로 롤백되게 한다.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec("DROP TABLE IF EXISTS tasks_new");
        db.exec(`
          CREATE TABLE tasks_new (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
            goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
            parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'pending_approval', 'in_progress', 'in_review', 'done', 'blocked', 'skipped')),
            priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
            sort_order INTEGER NOT NULL DEFAULT 0,
            verification_id TEXT,
            started_at TEXT,
            result_summary TEXT,
            last_discarded_diff TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            reassign_count INTEGER NOT NULL DEFAULT 0,
            token_usage INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0,
            target_files TEXT NOT NULL DEFAULT '[]',
            stack_hint TEXT NOT NULL DEFAULT '',
            task_type TEXT NOT NULL DEFAULT 'code',
            depends_on TEXT NOT NULL DEFAULT '[]',
            provider_trace_resolved_provider TEXT,
            provider_trace_resolution_source TEXT,
            provider_failover_reason_code TEXT,
            provider_failover_user_message TEXT,
            provider_failover_from_provider TEXT,
            provider_failover_to_provider TEXT,
            provider_failover_redispatched INTEGER NOT NULL DEFAULT 0,
            provider_failover_loop_guard_blocked INTEGER NOT NULL DEFAULT 0,
            provider_failover_original_session_id TEXT,
            provider_failover_redispatched_session_id TEXT,
            acceptance_script TEXT,
            recovery_checkpoint_head_sha TEXT,
            recovery_worktree_branch TEXT,
            recovery_worktree_dirty INTEGER,
            recovery_worktree_diff_hash TEXT,
            recovery_manual_action_required INTEGER NOT NULL DEFAULT 0,
            recovery_manual_action_reason TEXT,
            recovery_commit_ready INTEGER NOT NULL DEFAULT 0,
            recovery_commit_sha TEXT,
            recovery_resume_phase TEXT CHECK (recovery_resume_phase IN ('implementation', 'verification', 'fix')),
            requires_human_approval INTEGER NOT NULL DEFAULT 0,
            approval_reason TEXT,
            execution_run_id TEXT,
            execution_spec_version_id TEXT,
            skip_reason TEXT,
            plan_review_status TEXT CHECK (plan_review_status IN ('pending', 'approved', 'failed')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
        // PRAGMA table_info 교집합 동적 컬럼 복사 — 정적 컬럼 나열은 (a) 구형 DB에서
        // "no such column", (b) retry/reassign 같은 실값을 리터럴 0으로 덮는 유실을
        // 재생산한다. 교집합 복사는 두 클래스를 모두 봉인한다.
        const oldTaskCols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
        const newTaskCols = (db.prepare("PRAGMA table_info(tasks_new)").all() as { name: string }[]).map((c) => c.name);
        const copyCols = newTaskCols.filter((c) => oldTaskCols.includes(c)).join(", ");
        db.exec(`INSERT INTO tasks_new (${copyCols}) SELECT ${copyCols} FROM tasks`);
        db.exec(`
          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;
          CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_assignee_done ON tasks(assignee_id, status, updated_at DESC);
        `);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }

  // W1 backfill: autoResolve가 과거에 done으로 승격시킨 "[자동 건너뜀]" 태스크를
  // skipped terminal state로 정정한다. result_summary 원문은 보존(파괴 금지) —
  // status가 skipped로 바뀌면 다시 매칭되지 않으므로 멱등하다.
  // 반드시 CHECK 재생성 블록 + skip_reason ALTER 이후에 실행되어야 한다.
  db.exec(`
    UPDATE tasks
    SET status = 'skipped', skip_reason = 'retry_exhausted'
    WHERE status = 'done' AND result_summary LIKE '[자동 건너뜀]%'
  `);

  // Run FK와 trigger가 참조하기 전에 version 저장소를 먼저 보장한다.
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_spec_versions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      scope TEXT NOT NULL DEFAULT '',
      out_of_scope TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      expected_tasks TEXT NOT NULL DEFAULT '[]',
      verification_methods TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (goal_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_spec_versions_goal ON goal_spec_versions(goal_id);
  `);

  // 실행 snapshot은 goal의 가변 승인 포인터와 분리해 영구 보존한다. decompose 시작 시
  // 한 row를 만들고, 이후 task/session은 이 row와 version id를 직접 기록한다.
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_execution_runs (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      execution_spec_version_id TEXT NOT NULL REFERENCES goal_spec_versions(id),
      telemetry_contract_version INTEGER DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'claim' CHECK (source IN ('claim', 'decompose')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_goal_execution_runs_goal
      ON goal_execution_runs(goal_id, started_at);

    -- 이전 빌드가 active_execution_run_id만 남긴 채 재시작된 경우에도 진행 중 run의
    -- 승인본을 복원한다. 종료된 과거 run은 당시 version을 추론하지 않는다.
    INSERT OR IGNORE INTO goal_execution_runs (id, goal_id, execution_spec_version_id)
    SELECT active_execution_run_id, id, execution_spec_version_id
    FROM goals
    WHERE active_execution_run_id IS NOT NULL
      AND execution_spec_version_id IS NOT NULL;

    UPDATE tasks
    SET execution_spec_version_id = (
      SELECT execution_spec_version_id
      FROM goal_execution_runs
      WHERE id = tasks.execution_run_id
    )
    WHERE execution_spec_version_id IS NULL
      AND execution_run_id IS NOT NULL;

    UPDATE sessions
    SET execution_run_id = (
          SELECT execution_run_id FROM tasks WHERE id = sessions.task_id
        ),
        execution_spec_version_id = (
          SELECT execution_spec_version_id FROM tasks WHERE id = sessions.task_id
        )
    WHERE task_id IS NOT NULL
      AND execution_spec_version_id IS NULL;
  `);
  const executionRunCols = db.prepare("PRAGMA table_info(goal_execution_runs)").all() as { name: string }[];
  if (!executionRunCols.some((column) => column.name === "source")) {
    db.exec("ALTER TABLE goal_execution_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'claim'");
  }
  if (!executionRunCols.some((column) => column.name === "telemetry_contract_version")) {
    // Existing rows predate the complete execution-report telemetry contract.
    // Keep them NULL; beginExecutionRun explicitly marks newly created runs.
    db.exec("ALTER TABLE goal_execution_runs ADD COLUMN telemetry_contract_version INTEGER");
  }
  // tasks_close_execution_run 은 pending 승인본 승계 로직도 담당하므로 기존 DB의
  // 이전 trigger 정의를 반드시 교체한다(CREATE IF NOT EXISTS 만으로는 갱신되지 않음).
  db.exec("DROP TRIGGER IF EXISTS tasks_inherit_active_execution_run");
  db.exec("DROP TRIGGER IF EXISTS tasks_close_execution_run");
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS tasks_inherit_active_execution_run
    AFTER INSERT ON tasks
    WHEN NEW.execution_run_id IS NULL
    BEGIN
      UPDATE tasks
      SET execution_run_id = (SELECT active_execution_run_id FROM goals WHERE id = NEW.goal_id),
          execution_spec_version_id = (
            SELECT run.execution_spec_version_id
            FROM goal_execution_runs AS run
            JOIN goals AS goal ON goal.active_execution_run_id = run.id
            WHERE goal.id = NEW.goal_id
          )
      WHERE id = NEW.id;
    END;

    -- run 종료는 모든 run task 가 terminal(done|skipped)일 때만. 'blocked' 는 종결이 아니다 —
    -- scheduler 의 retryBlockedTasks 가 retry/reassign budget 이 남은 blocked task 를
    -- 다시 todo 로 되돌리기 때문이다. blocked 를 종료로 취급하면 실행 중 일시적으로
    -- blocked 된 유일한 task 가 run 을 조기 종료시켜, 재시도된 동일 task 가 실행 중
    -- 저장한 미승인 draft 의 changes_pending 게이트에 막힌다(승인 후 수정이 기존
    -- 실행에 영향을 주면 안 된다는 요구 위반). budget 소진된 영구 blocked 는
    -- autoResolvePermanentlyBlocked 가 skipped 로 종결하므로 이 trigger 로 정상 종료된다.
    CREATE TRIGGER IF NOT EXISTS tasks_close_execution_run
    AFTER UPDATE OF status ON tasks
    WHEN NEW.execution_run_id IS NOT NULL
      AND NEW.status IN ('done', 'skipped')
      AND (
        (SELECT source FROM goal_execution_runs WHERE id = NEW.execution_run_id) = 'claim'
        OR NEW.id = (SELECT qa_regression_task_id FROM goals WHERE id = NEW.goal_id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks
        WHERE goal_id = NEW.goal_id
          AND execution_run_id = NEW.execution_run_id
          AND status NOT IN ('done', 'skipped')
      )
    BEGIN
      UPDATE goal_execution_runs
      SET status = 'completed', ended_at = datetime('now')
      WHERE id = NEW.execution_run_id AND status = 'active';

      UPDATE goals
      SET execution_spec_version_id = CASE
            WHEN pending_execution_spec_version_id IS NOT NULL
              AND pending_execution_spec_version_id = (
                SELECT id FROM goal_spec_versions
                WHERE goal_id = NEW.goal_id
                ORDER BY version DESC
                LIMIT 1
              )
              AND EXISTS (
                SELECT 1 FROM goal_spec_versions
                WHERE id = pending_execution_spec_version_id
                  AND goal_id = NEW.goal_id
                  AND status = 'approved'
              )
            THEN pending_execution_spec_version_id
            ELSE execution_spec_version_id
          END,
          pending_execution_spec_version_id = NULL,
          active_execution_run_id = NULL
      WHERE id = NEW.goal_id
        AND active_execution_run_id = NEW.execution_run_id;
    END;
  `);

  // Goal Spec Versions — 실행 전 승인 게이트의 immutable snapshot 저장소.
  // 저장(POST)은 기존 row 를 수정하지 않고 매번 새 version row 를 만든다. 승인은
  // 한 row 를 goal 의 execution_spec_version_id 로 고정해, 분해·구현·검증이 정확히
  // 같은 승인본을 참조하게 한다. UNIQUE(goal_id, version) 로 버전 충돌을 막는다.
  const specVersionCols = db.prepare("PRAGMA table_info(goal_spec_versions)").all() as { name: string }[];
  for (const [name, definition] of [
    ["scope", "TEXT NOT NULL DEFAULT ''"],
    ["out_of_scope", "TEXT NOT NULL DEFAULT ''"],
    ["expected_tasks", "TEXT NOT NULL DEFAULT '[]'"],
    ["verification_methods", "TEXT NOT NULL DEFAULT '[]'"],
  ] as const) {
    if (!specVersionCols.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE goal_spec_versions ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS prevent_approved_goal_spec_update
    BEFORE UPDATE ON goal_spec_versions
    WHEN OLD.status = 'approved'
    BEGIN
      SELECT RAISE(ABORT, 'approved goal spec versions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS prevent_approved_goal_spec_delete
    BEFORE DELETE ON goal_spec_versions
    WHEN OLD.status = 'approved'
      AND EXISTS (SELECT 1 FROM goals WHERE id = OLD.goal_id)
    BEGIN
      SELECT RAISE(ABORT, 'approved goal spec versions are immutable');
    END;
  `);

  // base_branch on projects — 기본값 'main', develop/master 등 지원
  const projectColsLate = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectColsLate.some((c) => c.name === "base_branch")) {
    db.exec("ALTER TABLE projects ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'");
  }

  // Quality Gate normalized records. Legacy dimensions/issues JSON remains untouched;
  // rows are only created by the normalized write path once all required data is known.
  const migrateQualityGateSchema = db.transaction(() => {
    const verificationColumns = db.prepare("PRAGMA table_info(verifications)").all() as { name: string }[];
    if (!verificationColumns.some((c) => c.name === "termination_reason")) {
      db.exec(`
        ALTER TABLE verifications ADD COLUMN termination_reason TEXT
          CHECK (termination_reason IN ('passed', 'conditional', 'hard_blocked', 'auto_fix_disabled', 'fix_round_limit', 'escalated_to_goal_qa', 'evaluator_error'))
      `);
    }
    if (!verificationColumns.some((c) => c.name === "implementation_session_id")) {
      db.exec("ALTER TABLE verifications ADD COLUMN implementation_session_id TEXT");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS verification_dimension_judgements (
        verification_id TEXT NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
        dimension TEXT NOT NULL CHECK (dimension IN ('functionality', 'dataFlow', 'designAlignment', 'craft', 'edgeCases')),
        verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'not_applicable')),
        evidence TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
        UNIQUE (verification_id, dimension)
      );

      CREATE TABLE IF NOT EXISTS verification_issues (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        verification_id TEXT NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
        dimension TEXT NOT NULL CHECK (dimension IN ('functionality', 'dataFlow', 'designAlignment', 'craft', 'edgeCases')),
        severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'warning', 'info')),
        evidence TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
        repro_command TEXT NOT NULL CHECK (length(trim(repro_command)) > 0),
        expected_result TEXT NOT NULL CHECK (length(trim(expected_result)) > 0),
        actual_result TEXT NOT NULL CHECK (length(trim(actual_result)) > 0),
        fix_instruction TEXT NOT NULL CHECK (length(trim(fix_instruction)) > 0),
        assignee_id TEXT NOT NULL CHECK (length(trim(assignee_id)) > 0)
      );

      CREATE TABLE IF NOT EXISTS verification_fix_rounds (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        source_verification_id TEXT NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
        result_verification_id TEXT REFERENCES verifications(id) ON DELETE SET NULL,
        round_number INTEGER NOT NULL CHECK (round_number > 0),
        assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        -- CLI runtime session id of the fix session. session_id는 sessions row id라
        -- evaluator의 runtime session id와 절대 충돌하지 않는다 → 세션 재사용(맥락 누수)
        -- 탐지에는 runtime id 비교가 필요하다.
        runtime_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (source_verification_id)
      );

      CREATE TABLE IF NOT EXISTS verification_issue_tasks (
        issue_id TEXT NOT NULL REFERENCES verification_issues(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        relation TEXT NOT NULL CHECK (relation IN ('source', 'fix', 'carryover')),
        PRIMARY KEY (issue_id, task_id, relation)
      );

      CREATE TABLE IF NOT EXISTS verification_broadcast_outbox (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        verification_id TEXT NOT NULL UNIQUE REFERENCES verifications(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type = 'verification:result'),
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_verification_dimension_judgements_verification
        ON verification_dimension_judgements(verification_id);
      CREATE INDEX IF NOT EXISTS idx_verification_issues_verification
        ON verification_issues(verification_id);
      CREATE INDEX IF NOT EXISTS idx_verification_fix_rounds_source_verification
        ON verification_fix_rounds(source_verification_id);
      CREATE INDEX IF NOT EXISTS idx_verification_fix_rounds_result_verification
        ON verification_fix_rounds(result_verification_id);
      CREATE INDEX IF NOT EXISTS idx_verification_fix_rounds_task_round
        ON verification_fix_rounds(task_id, round_number);
      CREATE INDEX IF NOT EXISTS idx_verification_issue_tasks_task_relation
        ON verification_issue_tasks(task_id, relation);
      CREATE INDEX IF NOT EXISTS idx_verification_broadcast_outbox_pending
        ON verification_broadcast_outbox(delivered_at, created_at);
    `);

    // 기존 DB에 runtime_session_id 컬럼 backfill (CREATE TABLE IF NOT EXISTS는 no-op).
    const fixRoundColumns = db.prepare("PRAGMA table_info(verification_fix_rounds)").all() as { name: string }[];
    if (!fixRoundColumns.some((c) => c.name === "runtime_session_id")) {
      db.exec("ALTER TABLE verification_fix_rounds ADD COLUMN runtime_session_id TEXT");
    }
  });
  migrateQualityGateSchema();

  // max_concurrency on projects — per-project goal 병렬 상한 (null = 전역 CREWDECK_MAX_CONCURRENCY 상속).
  // 런타임에 UI/API 로 변경 가능 (스케줄러가 매 사이클 DB 에서 읽음, 재시작 불요).
  const projectColsConc = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
  if (!projectColsConc.some((c) => c.name === "max_concurrency")) {
    db.exec("ALTER TABLE projects ADD COLUMN max_concurrency INTEGER");
  }

  // Provider-neutral agent execution results. This is intentionally a new
  // append-only table: legacy task/session rows remain untouched, while every
  // new handoff can be correlated to its producing session and optional task.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      contract_version INTEGER NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('decompose', 'implementation', 'verification', 'fix')),
      payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_handoffs_goal_latest
      ON agent_handoffs(goal_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_handoffs_goal_stage_latest
      ON agent_handoffs(goal_id, stage, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_handoffs_task_latest
      ON agent_handoffs(task_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_handoffs_session
      ON agent_handoffs(session_id);
  `);

  // 실행 중 goal 조향(steering) 큐. 사용자가 활성 세션을 관찰하며 제출한 자유 텍스트
  // 노트를 큐잉하고, 다음 Generator(구현·fix) 스텝 spawn 시 컨텍스트 체인에 주입한 뒤
  // injected=1 로 소진 마킹한다. 신규 append-only 테이블이라 CREATE IF NOT EXISTS 가
  // 곧 idempotency — ALTER/백필 불필요. Evaluator 세션에는 주입하지 않는다(별도 태스크 책임).
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_steering_notes (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      -- 제출 시점에 관찰 중이던 활성 세션(맥락·추적용). 노트는 다음 스텝의 새 세션에
      -- 반영되므로 관찰 세션이 끝나도 살아남아야 한다 → CASCADE 아닌 SET NULL.
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      content TEXT NOT NULL CHECK (length(trim(content)) > 0),
      injected INTEGER NOT NULL DEFAULT 0 CHECK (injected IN (0, 1)),
      injected_at TEXT,
      -- 반영된 Generator 스텝 식별자(주입 세션/태스크 id). FK 아님 — 세션 정리 후에도
      -- activity log 추적용 기록이 남아야 한다.
      injected_step TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- pending 드레인: goal_id + injected=0 을 created_at 순(FIFO)으로 조회.
    CREATE INDEX IF NOT EXISTS idx_goal_steering_notes_pending
      ON goal_steering_notes(goal_id, injected, created_at);
  `);

  // Terminal-first foundation: a durable workspace identity mirrors the
  // existing Goal-as-Unit worktree contract without changing its execution
  // source of truth. Manual workspaces are reserved for the P1 create flow.
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      goal_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
      active_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'goal' CHECK (kind IN ('goal', 'manual')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'error', 'archived')),
      worktree_path TEXT,
      worktree_branch TEXT,
      base_ref TEXT NOT NULL DEFAULT 'main',
      setup_step TEXT,
      setup_progress INTEGER NOT NULL DEFAULT 0 CHECK (setup_progress BETWEEN 0 AND 100),
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT,
      CHECK (
        (worktree_path IS NULL AND worktree_branch IS NULL)
        OR (worktree_path IS NOT NULL AND worktree_branch IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_project
      ON workspaces(project_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_goal_unique
      ON workspaces(goal_id) WHERE goal_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_path_unique
      ON workspaces(worktree_path) WHERE worktree_path IS NOT NULL;

    CREATE TABLE IF NOT EXISTS terminal_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      shell TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pid INTEGER,
      bridge_token_hash TEXT,
      goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      active_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      provider TEXT CHECK (provider IN ('claude', 'codex')),
      backend TEXT NOT NULL DEFAULT 'pty' CHECK (backend IN ('pty', 'tmux')),
      runtime_id TEXT,
      cols INTEGER NOT NULL DEFAULT 120 CHECK (cols BETWEEN 20 AND 400),
      rows INTEGER NOT NULL DEFAULT 32 CHECK (rows BETWEEN 5 AND 200),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'exited', 'killed', 'interrupted', 'error')),
      exit_code INTEGER,
      last_output TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      dismissed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_sessions_workspace
      ON terminal_sessions(workspace_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status
      ON terminal_sessions(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS terminal_decisions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
      goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_decisions_workspace
      ON terminal_decisions(workspace_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS terminal_activities (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      idempotency_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      provider TEXT CHECK (provider IN ('claude', 'codex')),
      kind TEXT NOT NULL CHECK (kind IN (
        'task_claimed', 'provider_launch_requested', 'provider_started', 'command_finished',
        'file_changed', 'verification_run', 'blocked',
        'decision_recorded', 'completion_requested', 'quality_gate_result'
      )),
      summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 2000),
      metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(terminal_session_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_activities_workspace
      ON terminal_activities(workspace_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_terminal_activities_goal
      ON terminal_activities(goal_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_terminal_activities_task
      ON terminal_activities(task_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_terminal_activities_terminal
      ON terminal_activities(terminal_session_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS terminal_review_requests (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'passed', 'fix_required', 'conditional', 'error', 'timeout')),
      scope TEXT NOT NULL DEFAULT 'standard' CHECK (scope IN ('lite', 'standard', 'full')),
      summary TEXT NOT NULL,
      changed_files TEXT NOT NULL DEFAULT '[]',
      verification_commands TEXT NOT NULL DEFAULT '[]',
      idempotency_key TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      run_token TEXT,
      previous_verification_id TEXT,
      verification_id TEXT REFERENCES verifications(id) ON DELETE SET NULL,
      findings TEXT NOT NULL DEFAULT '[]',
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(terminal_session_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_reviews_session
      ON terminal_review_requests(terminal_session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_terminal_reviews_task
      ON terminal_review_requests(task_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_reviews_active
      ON terminal_review_requests(terminal_session_id, task_id)
      WHERE status IN ('pending', 'running');

    CREATE TABLE IF NOT EXISTS terminal_bridge_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      terminal_session_id TEXT REFERENCES terminal_sessions(id) ON DELETE SET NULL,
      client_request_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('goal_created', 'task_created', 'task_updated')),
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(workspace_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_bridge_events_workspace
      ON terminal_bridge_events(workspace_id, created_at DESC);
  `);

  const terminalGoalColumns = db.prepare("PRAGMA table_info(goals)").all() as { name: string }[];
  if (!terminalGoalColumns.some((c) => c.name === "origin_workspace_id")) {
    db.exec("ALTER TABLE goals ADD COLUMN origin_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL");
  }
  const workspaceColumns = db.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[];
  if (!workspaceColumns.some((c) => c.name === "active_goal_id")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN active_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL");
  }
  db.exec("UPDATE workspaces SET active_goal_id = goal_id WHERE active_goal_id IS NULL AND goal_id IS NOT NULL");
  const terminalSessionColumns = db.prepare("PRAGMA table_info(terminal_sessions)").all() as { name: string }[];
  if (!terminalSessionColumns.some((c) => c.name === "bridge_token_hash")) {
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN bridge_token_hash TEXT");
  }
  if (!terminalSessionColumns.some((c) => c.name === "backend")) {
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'pty'");
  }
  if (!terminalSessionColumns.some((c) => c.name === "runtime_id")) {
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN runtime_id TEXT");
  }
  if (!terminalSessionColumns.some((c) => c.name === "dismissed_at")) {
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN dismissed_at TEXT");
  }
  if (!terminalSessionColumns.some((c) => c.name === "goal_id")) {
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL");
  }
  if (!terminalSessionColumns.some((c) => c.name === "agent_id")) {
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL");
  }
  if (!terminalSessionColumns.some((c) => c.name === "active_task_id")) {
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN active_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL");
  }
  if (!terminalSessionColumns.some((c) => c.name === "provider")) {
    db.exec("ALTER TABLE terminal_sessions ADD COLUMN provider TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_decisions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
      goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_terminal_decisions_workspace
      ON terminal_decisions(workspace_id, created_at DESC);
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_sessions_bridge_token
      ON terminal_sessions(bridge_token_hash) WHERE bridge_token_hash IS NOT NULL;
  `);

  const workspaceSessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!workspaceSessionColumns.some((c) => c.name === "workspace_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL");
  }
  if (!workspaceSessionColumns.some((c) => c.name === "session_key")) {
    db.exec("ALTER TABLE sessions ADD COLUMN session_key TEXT");
  }
  if (!workspaceSessionColumns.some((c) => c.name === "origin")) {
    db.exec("ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'orchestration' CHECK (origin IN ('orchestration', 'terminal'))");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace
      ON sessions(workspace_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_session_key
      ON sessions(session_key, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_session_key
      ON sessions(session_key) WHERE status = 'active' AND session_key IS NOT NULL;
  `);

  // Existing Goal-as-Unit rows become durable workspace identities. The goal
  // worktree columns remain authoritative through P1; this backfill only
  // mirrors them and is safe to run on every startup.
  db.exec(`
    INSERT OR IGNORE INTO workspaces (
      project_id, goal_id, name, kind, state,
      worktree_path, worktree_branch, base_ref, setup_progress,
      error_code, error_message
    )
    SELECT
      g.project_id,
      g.id,
      COALESCE(NULLIF(trim(g.title), ''), NULLIF(trim(g.description), ''), g.id),
      'goal',
      CASE
        WHEN g.worktree_path IS NOT NULL AND g.worktree_branch IS NOT NULL THEN 'ready'
        WHEN g.worktree_path IS NOT NULL OR g.worktree_branch IS NOT NULL THEN 'error'
        ELSE 'pending'
      END,
      CASE WHEN g.worktree_path IS NOT NULL AND g.worktree_branch IS NOT NULL THEN g.worktree_path END,
      CASE WHEN g.worktree_path IS NOT NULL AND g.worktree_branch IS NOT NULL THEN g.worktree_branch END,
      COALESCE(NULLIF(trim(p.base_branch), ''), 'main'),
      CASE
        WHEN g.worktree_path IS NOT NULL AND g.worktree_branch IS NOT NULL THEN 100
        ELSE 0
      END,
      CASE
        WHEN (g.worktree_path IS NULL) != (g.worktree_branch IS NULL) THEN 'incomplete_worktree_metadata'
      END,
      CASE
        WHEN (g.worktree_path IS NULL) != (g.worktree_branch IS NULL)
        THEN 'Goal worktree path and branch must be recorded together'
      END
    FROM goals g
    JOIN projects p ON p.id = g.project_id
    WHERE g.goal_model = 'goal_as_unit'
       OR g.worktree_path IS NOT NULL
       OR g.worktree_branch IS NOT NULL;

    UPDATE workspaces
       SET project_id = (SELECT g.project_id FROM goals g WHERE g.id = workspaces.goal_id),
           name = (SELECT COALESCE(NULLIF(trim(g.title), ''), NULLIF(trim(g.description), ''), g.id)
                     FROM goals g WHERE g.id = workspaces.goal_id),
           state = CASE
             WHEN (SELECT g.worktree_path FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
              AND (SELECT g.worktree_branch FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
             THEN 'ready'
             WHEN (SELECT g.worktree_path FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
               OR (SELECT g.worktree_branch FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
             THEN 'error'
             ELSE 'pending' END,
           worktree_path = CASE
             WHEN (SELECT g.worktree_path FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
              AND (SELECT g.worktree_branch FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
             THEN (SELECT g.worktree_path FROM goals g WHERE g.id = workspaces.goal_id)
           END,
           worktree_branch = CASE
             WHEN (SELECT g.worktree_path FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
              AND (SELECT g.worktree_branch FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
             THEN (SELECT g.worktree_branch FROM goals g WHERE g.id = workspaces.goal_id)
           END,
           base_ref = COALESCE((
             SELECT NULLIF(trim(p.base_branch), '')
               FROM goals g JOIN projects p ON p.id = g.project_id
              WHERE g.id = workspaces.goal_id
           ), 'main'),
           setup_progress = CASE
             WHEN (SELECT g.worktree_path FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
              AND (SELECT g.worktree_branch FROM goals g WHERE g.id = workspaces.goal_id) IS NOT NULL
             THEN 100 ELSE 0 END,
           error_code = CASE
             WHEN ((SELECT g.worktree_path FROM goals g WHERE g.id = workspaces.goal_id) IS NULL)
               != ((SELECT g.worktree_branch FROM goals g WHERE g.id = workspaces.goal_id) IS NULL)
             THEN 'incomplete_worktree_metadata'
           END,
           error_message = CASE
             WHEN ((SELECT g.worktree_path FROM goals g WHERE g.id = workspaces.goal_id) IS NULL)
               != ((SELECT g.worktree_branch FROM goals g WHERE g.id = workspaces.goal_id) IS NULL)
             THEN 'Goal worktree path and branch must be recorded together'
           END,
           archived_at = NULL,
           updated_at = datetime('now')
     WHERE goal_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM goals g
          WHERE g.id = workspaces.goal_id
            AND (g.goal_model = 'goal_as_unit'
              OR g.worktree_path IS NOT NULL
              OR g.worktree_branch IS NOT NULL)
       )
       -- 은퇴한 Workspace 는 이 재동기화가 되살리지 않는다. goal 이 재실행돼
       -- worktree 가 새로 생긴 경우에만 복귀 대상이 된다 (upsertGoalWorkspace 와 동일 규칙).
       AND (
         workspaces.state != 'archived'
         OR EXISTS (
           SELECT 1 FROM goals g
            WHERE g.id = workspaces.goal_id AND g.worktree_path IS NOT NULL
         )
       );

    -- 은퇴 경로가 없던 시절에 쌓인 goal Workspace 정리. squash 가 merged 로 끝나
    -- worktree 까지 사라진 goal 의 Workspace 는 위 재동기화에서 'pending'("준비 중")
    -- 으로 되돌아가, 열 수도 지울 수도 없는 잔여 항목으로 목록에 영구히 남았다.
    UPDATE workspaces
       SET state = 'archived', setup_step = 'archived', setup_progress = 100,
           error_code = NULL, error_message = NULL,
           archived_at = COALESCE(archived_at, datetime('now')),
           updated_at = datetime('now')
     WHERE kind = 'goal'
       AND state != 'archived'
       AND worktree_path IS NULL
       AND goal_id IN (SELECT id FROM goals WHERE squash_status = 'merged');

    UPDATE sessions
       SET workspace_id = (
         SELECT w.id
           FROM tasks t
           JOIN workspaces w ON w.goal_id = t.goal_id
          WHERE t.id = sessions.task_id
       )
     WHERE workspace_id IS NULL
       AND task_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM tasks t
           JOIN workspaces w ON w.goal_id = t.goal_id
          WHERE t.id = sessions.task_id
       );
  `);

  // merged goal 인데 worktree 가 디스크에서 사라진 Workspace 은퇴.
  // 위 SQL backfill 은 worktree_path IS NULL 만 걸러 이 부류를 놓친다 — squash 승인
  // 경로를 정상적으로 타지 않아 goals 메타에 경로가 남은 케이스다. 목록에는 열 수
  // 없는(pathExists=false) 항목으로 뜨고 kind='goal' 이라 지울 수도 없다.
  // 조건을 SQL 로 넓히지 않는 이유: cleanup 실패로 worktree 가 실제로 살아 있는
  // 경우는 사용자가 WIP 를 확인해야 하므로 남겨야 한다. 그 구분은 파일 존재로만 된다.
  const mergedOrphans = db.prepare(`
    SELECT w.id, w.worktree_path
      FROM workspaces w
      JOIN goals g ON g.id = w.goal_id
     WHERE w.kind = 'goal'
       AND w.state != 'archived'
       AND w.worktree_path IS NOT NULL
       AND g.squash_status = 'merged'
  `).all() as { id: string; worktree_path: string }[];
  for (const orphan of mergedOrphans) {
    if (existsSync(orphan.worktree_path)) continue;
    db.prepare(`
      UPDATE workspaces
         SET state = 'archived', worktree_path = NULL, worktree_branch = NULL,
             setup_step = 'archived', setup_progress = 100,
             error_code = NULL, error_message = NULL,
             archived_at = COALESCE(archived_at, datetime('now')),
             updated_at = datetime('now')
       WHERE id = ?
    `).run(orphan.id);
  }

  // agents (project_id, name) 중복 정리 + UNIQUE 보장.
  // evaluator.ts의 "INSERT OR IGNORE INTO agents ..."는 unique index가 없으면 아무것도
  // ignore하지 못해 '[Crewdeck] Evaluator'가 동시 검증마다 중복 생성돼 왔다. 같은
  // (project_id, name) 중 최신 1개(created_at, rowid 기준)만 남기되, 삭제 전 참조를
  // 생존 row로 옮긴다 — sessions는 ON DELETE CASCADE라 그냥 지우면 세션 이력이 유실된다.
  // migrate() 끝에 두는 이유: agents 재생성(DROP TABLE이 index를 함께 지움)과 참조
  // 테이블 생성이 모두 끝난 뒤여야 한다.
  const dupAgentGroups = db.prepare(
    "SELECT project_id, name FROM agents GROUP BY project_id, name HAVING COUNT(*) > 1",
  ).all() as { project_id: string; name: string }[];
  if (dupAgentGroups.length > 0) {
    const dedupeAgents = db.transaction(() => {
      for (const group of dupAgentGroups) {
        const rows = db.prepare(
          "SELECT id FROM agents WHERE project_id = ? AND name = ? ORDER BY created_at DESC, rowid DESC",
        ).all(group.project_id, group.name) as { id: string }[];
        const survivor = rows[0].id;
        const losers = rows.slice(1).map((r) => r.id);
        const ph = losers.map(() => "?").join(",");
        db.prepare(`UPDATE sessions SET agent_id = ? WHERE agent_id IN (${ph})`).run(survivor, ...losers);
        db.prepare(`UPDATE tasks SET assignee_id = ? WHERE assignee_id IN (${ph})`).run(survivor, ...losers);
        db.prepare(`UPDATE activities SET agent_id = ? WHERE agent_id IN (${ph})`).run(survivor, ...losers);
        db.prepare(`UPDATE verification_fix_rounds SET assignee_id = ? WHERE assignee_id IN (${ph})`).run(survivor, ...losers);
        db.prepare(`UPDATE terminal_sessions SET agent_id = ? WHERE agent_id IN (${ph})`).run(survivor, ...losers);
        db.prepare(`UPDATE terminal_activities SET agent_id = ? WHERE agent_id IN (${ph})`).run(survivor, ...losers);
        db.prepare(`UPDATE terminal_decisions SET agent_id = ? WHERE agent_id IN (${ph})`).run(survivor, ...losers);
        db.prepare(`UPDATE terminal_review_requests SET agent_id = ? WHERE agent_id IN (${ph})`).run(survivor, ...losers);
        db.prepare(`UPDATE verification_issues SET assignee_id = ? WHERE assignee_id IN (${ph})`).run(survivor, ...losers);
        // 자식 에이전트의 parent 승계 — 단, 생존 row 자신의 parent가 중복군이면 자기
        // 참조가 되므로 제외하고 NULL로 끊는다.
        db.prepare(`UPDATE agents SET parent_id = ? WHERE parent_id IN (${ph}) AND id != ?`).run(survivor, ...losers, survivor);
        db.prepare(`UPDATE agents SET parent_id = NULL WHERE id = ? AND parent_id IN (${ph})`).run(survivor, ...losers);
        db.prepare(`DELETE FROM agents WHERE id IN (${ph})`).run(...losers);
      }
    });
    dedupeAgents();
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_project_name ON agents(project_id, name)");
}

export function generateId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
