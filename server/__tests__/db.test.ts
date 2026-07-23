import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase, migrate } from '../db/schema.js';
import type Database from 'better-sqlite3';

function createTestDb(): Database.Database {
  const db = createDatabase(':memory:');
  migrate(db);
  return db;
}

describe('createDatabase + migrate', () => {
  it('creates database without error', () => {
    expect(() => createTestDb()).not.toThrow();
  });

  it('creates all expected tables', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('goals');
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('verifications');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('activities');
    expect(tableNames).toContain('verification_dimension_judgements');
    expect(tableNames).toContain('verification_issues');
    expect(tableNames).toContain('verification_fix_rounds');
    expect(tableNames).toContain('verification_issue_tasks');
    expect(tableNames).toContain('verification_broadcast_outbox');
    expect(tableNames).toContain('verification_labels');
  });

  it('creates the Quality Gate columns and indexes required by the timeline API', () => {
    const db = createTestDb();
    const verificationColumns = db
      .prepare('PRAGMA table_info(verifications)')
      .all() as { name: string }[];
    const indexRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as { name: string }[];

    expect(verificationColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['implementation_session_id', 'termination_reason']),
    );
    expect(indexRows.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'idx_verification_dimension_judgements_verification',
        'idx_verification_issues_verification',
        'idx_verification_fix_rounds_source_verification',
        'idx_verification_fix_rounds_result_verification',
        'idx_verification_fix_rounds_task_round',
        'idx_verification_issue_tasks_task_relation',
        'idx_verification_broadcast_outbox_pending',
      ]),
    );
  });

  it('migrate is idempotent (run twice, no error)', () => {
    const db = createDatabase(':memory:');
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
  });

  it('upgrades a legacy verification schema idempotently without losing rows', () => {
    const db = createDatabase(':memory:');
    migrate(db);
    db.prepare(
      "INSERT INTO projects (id, name, source) VALUES ('legacy-project', 'Legacy', 'new')",
    ).run();
    db.prepare(
      "INSERT INTO goals (id, project_id, description) VALUES ('legacy-goal', 'legacy-project', 'Keep me')",
    ).run();
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title) VALUES ('legacy-task', 'legacy-goal', 'legacy-project', 'Keep me')",
    ).run();
    db.prepare(
      "INSERT INTO verifications (id, task_id, verdict) VALUES ('legacy-verification', 'legacy-task', 'pass')",
    ).run();

    db.exec(`
      DROP TABLE verification_labels;
      DROP TABLE verification_broadcast_outbox;
      DROP TABLE verification_issue_tasks;
      DROP TABLE verification_fix_rounds;
      DROP TABLE verification_issues;
      DROP TABLE verification_dimension_judgements;
      ALTER TABLE verifications DROP COLUMN termination_reason;
      ALTER TABLE verifications DROP COLUMN implementation_session_id;
    `);

    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();

    const verification = db
      .prepare('SELECT id, task_id, verdict FROM verifications WHERE id = ?')
      .get('legacy-verification');
    const verificationColumns = db
      .prepare('PRAGMA table_info(verifications)')
      .all() as { name: string }[];

    expect(verification).toEqual({
      id: 'legacy-verification',
      task_id: 'legacy-task',
      verdict: 'pass',
    });
    expect(verificationColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['implementation_session_id', 'termination_reason']),
    );
  });

  it('keeps one verification_labels row per verification (UNIQUE upsert) and cascades on delete', () => {
    const db = createTestDb();
    db.prepare("INSERT INTO projects (id, name, source) VALUES ('cal-project', 'Cal', 'new')").run();
    db.prepare(
      "INSERT INTO goals (id, project_id, description) VALUES ('cal-goal', 'cal-project', 'Calibrate')",
    ).run();
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title) VALUES ('cal-task', 'cal-goal', 'cal-project', 'Calibrate')",
    ).run();
    db.prepare(
      "INSERT INTO verifications (id, task_id, verdict) VALUES ('cal-verification', 'cal-task', 'fail')",
    ).run();

    const upsert = db.prepare(`
      INSERT INTO verification_labels (verification_id, label, cause_category, note)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(verification_id) DO UPDATE SET
        label = excluded.label,
        cause_category = excluded.cause_category,
        note = excluded.note,
        labeled_at = datetime('now')
    `);
    upsert.run('cal-verification', 'false_positive', 'craft', '통과했어야 함');
    upsert.run('cal-verification', 'correct', 'functionality', '재검토 결과 정상 판정');

    const rows = db
      .prepare('SELECT id, label, cause_category, note FROM verification_labels WHERE verification_id = ?')
      .all('cal-verification') as { id: string; label: string; cause_category: string; note: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('correct');
    expect(rows[0].cause_category).toBe('functionality');
    expect(rows[0].note).toBe('재검토 결과 정상 판정');
    expect(rows[0].id).toMatch(/^[0-9a-f]{16}$/);

    // label CHECK — 별도 verification으로 UNIQUE 위반과 분리해서 확인.
    db.prepare(
      "INSERT INTO verifications (id, task_id, verdict) VALUES ('cal-verification-2', 'cal-task', 'pass')",
    ).run();
    expect(() =>
      db
        .prepare("INSERT INTO verification_labels (verification_id, label) VALUES ('cal-verification-2', 'bogus')")
        .run(),
    ).toThrow(/CHECK constraint failed/);

    db.prepare("DELETE FROM verifications WHERE id = 'cal-verification'").run();
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM verification_labels').get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});

describe('Project CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('inserts a project and selects it back', () => {
    db.prepare(
      `INSERT INTO projects (id, name, mission, source) VALUES (?, ?, ?, ?)`
    ).run('proj1', 'Test Project', 'Build something', 'new');

    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj1') as any;
    expect(row.name).toBe('Test Project');
    expect(row.mission).toBe('Build something');
    expect(row.source).toBe('new');
    expect(row.status).toBe('active');
  });

  it('updates a project field', () => {
    db.prepare(
      `INSERT INTO projects (id, name, mission, source) VALUES (?, ?, ?, ?)`
    ).run('proj2', 'Old Name', '', 'local_import');

    db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).run('New Name', 'proj2');

    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get('proj2') as any;
    expect(row.name).toBe('New Name');
  });

  it('deletes a project', () => {
    db.prepare(
      `INSERT INTO projects (id, name, mission, source) VALUES (?, ?, ?, ?)`
    ).run('proj3', 'To Delete', '', 'new');

    db.prepare(`DELETE FROM projects WHERE id = ?`).run('proj3');

    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj3');
    expect(row).toBeUndefined();
  });

  it('rejects invalid source value', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO projects (id, name, mission, source) VALUES (?, ?, ?, ?)`
      ).run('proj4', 'Bad Source', '', 'invalid_source');
    }).toThrow();
  });
});

describe('Agent creation with project foreign key', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(
      `INSERT INTO projects (id, name, mission, source) VALUES (?, ?, ?, ?)`
    ).run('proj-fk', 'FK Project', '', 'new');
  });

  it('inserts an agent linked to a project', () => {
    db.prepare(
      `INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)`
    ).run('agent1', 'proj-fk', 'Developer', 'coder');

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent1') as any;
    expect(row.project_id).toBe('proj-fk');
    expect(row.role).toBe('coder');
    expect(row.status).toBe('idle');
  });

  it('cascades delete: removing project removes its agents', () => {
    db.prepare(
      `INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)`
    ).run('agent2', 'proj-fk', 'Reviewer', 'reviewer');

    db.prepare(`DELETE FROM projects WHERE id = ?`).run('proj-fk');

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent2');
    expect(row).toBeUndefined();
  });

  it('rejects agent with non-existent project_id', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)`
      ).run('agent3', 'no-such-project', 'Ghost', 'coder');
    }).toThrow();
  });

  it('accepts arbitrary role values (role CHECK constraint intentionally removed)', () => {
    // Custom project-defined agents (.claude/agents/*.md) can declare any role,
    // so the schema migration drops the legacy role CHECK — see schema.ts migrate().
    db.prepare(
      `INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)`
    ).run('agent4', 'proj-fk', 'X', 'growth_hacker');

    const row = db.prepare('SELECT role FROM agents WHERE id = ?').get('agent4') as any;
    expect(row.role).toBe('growth_hacker');
  });
});

describe('Goal + Task creation with progress', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(
      `INSERT INTO projects (id, name, mission, source) VALUES (?, ?, ?, ?)`
    ).run('proj-g', 'Goal Project', '', 'new');
    db.prepare(
      `INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)`
    ).run('agent-g', 'proj-g', 'Dev', 'coder');
  });

  it('inserts a goal with default progress 0', () => {
    db.prepare(
      `INSERT INTO goals (id, project_id, description) VALUES (?, ?, ?)`
    ).run('goal1', 'proj-g', 'Launch MVP');

    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get('goal1') as any;
    expect(row.description).toBe('Launch MVP');
    expect(row.progress).toBe(0);
    expect(row.priority).toBe('medium');
  });

  it('updates goal progress', () => {
    db.prepare(
      `INSERT INTO goals (id, project_id, description) VALUES (?, ?, ?)`
    ).run('goal2', 'proj-g', 'Ship feature');

    db.prepare(`UPDATE goals SET progress = ? WHERE id = ?`).run(75, 'goal2');

    const row = db.prepare('SELECT progress FROM goals WHERE id = ?').get('goal2') as any;
    expect(row.progress).toBe(75);
  });

  it('rejects progress outside 0-100', () => {
    db.prepare(
      `INSERT INTO goals (id, project_id, description) VALUES (?, ?, ?)`
    ).run('goal3', 'proj-g', 'Bad progress');

    expect(() => {
      db.prepare(`UPDATE goals SET progress = ? WHERE id = ?`).run(150, 'goal3');
    }).toThrow();
  });

  it('inserts a task linked to goal and project', () => {
    db.prepare(
      `INSERT INTO goals (id, project_id, description) VALUES (?, ?, ?)`
    ).run('goal4', 'proj-g', 'Auth feature');

    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, assignee_id) VALUES (?, ?, ?, ?, ?)`
    ).run('task1', 'goal4', 'proj-g', 'Implement login', 'agent-g');

    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task1') as any;
    expect(row.title).toBe('Implement login');
    expect(row.status).toBe('todo');
    expect(row.assignee_id).toBe('agent-g');
  });

  it('calculates progress from task statuses', () => {
    db.prepare(
      `INSERT INTO goals (id, project_id, description) VALUES (?, ?, ?)`
    ).run('goal5', 'proj-g', 'Multi-task goal');

    const insertTask = db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, status) VALUES (?, ?, ?, ?, ?)`
    );
    insertTask.run('t1', 'goal5', 'proj-g', 'Task A', 'done');
    insertTask.run('t2', 'goal5', 'proj-g', 'Task B', 'done');
    insertTask.run('t3', 'goal5', 'proj-g', 'Task C', 'todo');
    insertTask.run('t4', 'goal5', 'proj-g', 'Task D', 'todo');

    const { total, done } = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
      FROM tasks WHERE goal_id = ?
    `).get('goal5') as any;

    const progress = Math.round((done / total) * 100);
    expect(progress).toBe(50);
  });
});
