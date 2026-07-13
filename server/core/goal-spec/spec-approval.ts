import type { Database } from "better-sqlite3";
import type { GoalSpecLegacyContent, GoalSpecStateResponse, GoalSpecVersionSnapshot } from "../../../shared/types.js";

/**
 * 실행 전 Goal Spec 승인 게이트 — immutable version snapshot 저장/승인 계층.
 *
 * 핵심 계약 (docs/design/실행-전-goal-spec-승인-게이트-*.md):
 *  - 저장(POST)은 기존 version 을 수정하지 않고 항상 새 snapshot row 를 만든다.
 *  - approve 는 지정 version 을 immutable approved 로 만들고 goal 의
 *    execution_spec_version_id 를 그 version 으로 고정한다.
 *  - 하나의 서버측 게이트(assertExecutionAllowed)를 모든 실행 경로가 공유한다
 *    (claimTaskForExecution 에서 호출) — 미승인 실행 100% 차단.
 *  - 승인본 자체는 절대 UPDATE/DELETE 하지 않는다(감사 이력 보존). "현재 승인"은
 *    goals.execution_spec_version_id 포인터로만 이동한다.
 *
 * spec_approval_required 는 opt-in marker 다. 이 워크플로(POST /spec-versions)를
 * 거친 goal 만 1 로 켜지고, legacy/기존 autopilot goal(marker 0)은 게이트에서
 * 무조건 통과한다 — 기존 흐름을 바꾸지 않기 위함(설계 pattern 10).
 */

export interface SpecFields {
  scope?: unknown;
  out_of_scope?: unknown;
  acceptance_criteria?: unknown;
  expected_tasks?: unknown;
  verification_methods?: unknown;
}

export type SpecVersion = GoalSpecVersionSnapshot;
export type SpecState = GoalSpecStateResponse;

export type ExecutionGate =
  | { allowed: true }
  | {
      allowed: false;
      reason: "spec_not_approved";
      message: string;
      specStatus: "missing" | "draft" | "changes_pending";
      currentDraftVersion: number | null;
    };

/** 코드가 붙은 도메인 오류 — route 가 HTTP 상태로 매핑한다. */
export class SpecApprovalError extends Error {
  constructor(
    public code: "goal_not_found" | "version_not_found" | "invalid_spec" | "stale_version",
    message: string,
    public location?: string,
  ) {
    super(message);
    this.name = "SpecApprovalError";
  }
}

type SpecVersionRow = {
  id: string;
  goal_id: string;
  version: number;
  scope: string;
  out_of_scope: string;
  acceptance_criteria: string;
  expected_tasks: string;
  verification_methods: string;
  status: "draft" | "approved";
  approved_at: string | null;
  created_at: string;
};

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function serialize(row: SpecVersionRow): SpecVersion {
  return {
    id: row.id,
    version: row.version,
    state: row.status,
    scope: row.scope,
    out_of_scope: row.out_of_scope,
    acceptance_criteria: safeParse(row.acceptance_criteria, []),
    expected_tasks: safeParse(row.expected_tasks, []),
    verification_methods: safeParse(row.verification_methods, []),
    created_at: row.created_at,
    approved_at: row.approved_at ?? null,
  };
}

function normalizeDraftFields(fields: SpecFields): Required<SpecFields> {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new SpecApprovalError("invalid_spec", "spec body must be an object");
  }

  for (const key of ["scope", "out_of_scope"] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== "string") {
      throw new SpecApprovalError("invalid_spec", `${key} must be a string`, key);
    }
  }

  for (const key of ["acceptance_criteria", "expected_tasks", "verification_methods"] as const) {
    const value = fields[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
      throw new SpecApprovalError("invalid_spec", `${key} must be an array of strings`, key);
    }
  }

  return {
    scope: fields.scope ?? "",
    out_of_scope: fields.out_of_scope ?? "",
    acceptance_criteria: fields.acceptance_criteria ?? [],
    expected_tasks: fields.expected_tasks ?? [],
    verification_methods: fields.verification_methods ?? [],
  };
}

/**
 * 승인 가능 유효성 — draft 저장보다 엄격하다(설계 pattern 1·2).
 * 필수 문자열은 trim 후 비어 있지 않아야 하고, 배열은 최소 1개의 유효 원소를 요구한다.
 * 실패 시 사용자가 고칠 위치(location)를 함께 돌려준다.
 */
export function validateSpecForApproval(spec: SpecVersion): { ok: true } | { ok: false; error: string; location: string } {
  if (spec.scope.trim() === "") {
    return { ok: false, error: "scope is required", location: "scope" };
  }
  for (const key of ["acceptance_criteria", "expected_tasks", "verification_methods"] as const) {
    const values = spec[key];
    if (!Array.isArray(values) || values.filter((value) => typeof value === "string" && value.trim() !== "").length === 0) {
      return { ok: false, error: `${key} must have at least one non-empty entry`, location: key };
    }
  }
  return { ok: true };
}

function goalExists(db: Database, goalId: string): {
  execution_spec_version_id: string | null;
  active_execution_run_id: string | null;
  pending_execution_spec_version_id: string | null;
} {
  const goal = db.prepare(
    "SELECT execution_spec_version_id, active_execution_run_id, pending_execution_spec_version_id FROM goals WHERE id = ?",
  ).get(goalId) as {
    execution_spec_version_id: string | null;
    active_execution_run_id: string | null;
    pending_execution_spec_version_id: string | null;
  } | undefined;
  if (!goal) throw new SpecApprovalError("goal_not_found", "Goal not found");
  return goal;
}

function getActiveRunId(db: Database, goalId: string): string | null {
  return goalExists(db, goalId).active_execution_run_id;
}

function hasInFlightTask(db: Database, goalId: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM tasks WHERE goal_id = ? AND status IN ('in_progress', 'in_review') LIMIT 1",
  ).get(goalId));
}

export interface ExecutionRunSnapshot {
  id: string;
  executionSpecVersionId: string;
}

/**
 * 승인본을 별도 run row에 원자적으로 고정한다. decompose 진입점과 legacy 첫 claim이
 * 함께 사용하며, 이미 열린 run이 있으면 그 immutable snapshot을 그대로 반환한다.
 */
export function beginExecutionRun(
  db: Database,
  goalId: string,
  source: "claim" | "decompose" = "claim",
): ExecutionRunSnapshot | null {
  const tx = db.transaction((): ExecutionRunSnapshot | null => {
    const goal = goalExists(db, goalId);
    if (goal.active_execution_run_id) {
      const active = db.prepare(`
        SELECT id, execution_spec_version_id
        FROM goal_execution_runs
        WHERE id = ? AND goal_id = ? AND status = 'active'
      `).get(goal.active_execution_run_id, goalId) as { id: string; execution_spec_version_id: string } | undefined;
      if (!active) throw new Error(`Active execution run ${goal.active_execution_run_id} is missing`);
      return { id: active.id, executionSpecVersionId: active.execution_spec_version_id };
    }
    if (!goal.execution_spec_version_id) return null;

    const approved = db.prepare(`
      SELECT id FROM goal_spec_versions
      WHERE id = ? AND goal_id = ? AND status = 'approved'
    `).get(goal.execution_spec_version_id, goalId) as { id: string } | undefined;
    if (!approved) return null;

    const runId = (db.prepare("SELECT lower(hex(randomblob(8))) AS id").get() as { id: string }).id;
    db.prepare(`
      INSERT INTO goal_execution_runs (
        id, goal_id, execution_spec_version_id, source, telemetry_contract_version
      ) VALUES (?, ?, ?, ?, 1)
    `).run(runId, goalId, approved.id, source);
    const pinned = db.prepare(`
      UPDATE goals SET active_execution_run_id = ?
      WHERE id = ? AND active_execution_run_id IS NULL
    `).run(runId, goalId);
    if (pinned.changes !== 1) throw new Error(`Failed to pin execution run for goal ${goalId}`);
    db.prepare(`
      UPDATE tasks
      SET execution_run_id = ?, execution_spec_version_id = ?
      WHERE goal_id = ? AND execution_run_id IS NULL AND status NOT IN ('done', 'blocked')
    `).run(runId, approved.id, goalId);
    return { id: runId, executionSpecVersionId: approved.id };
  });
  return tx();
}

/** decompose가 task 생성 전에 실패했을 때 pin을 해제하되 감사 run row는 보존한다. */
export function failExecutionRun(db: Database, goalId: string, runId: string): void {
  db.transaction(() => {
    const hasTasks = db.prepare("SELECT 1 FROM tasks WHERE execution_run_id = ? LIMIT 1").get(runId);
    if (hasTasks) return;
    db.prepare(`
      UPDATE goal_execution_runs SET status = 'failed', ended_at = datetime('now')
      WHERE id = ? AND goal_id = ? AND status = 'active'
    `).run(runId, goalId);
    db.prepare(`
      UPDATE goals SET active_execution_run_id = NULL
      WHERE id = ? AND active_execution_run_id = ?
    `).run(goalId, runId);
  })();
}

/**
 * 새 immutable draft snapshot 을 만든다. 기존 version 은 절대 수정하지 않는다.
 * 저장은 이 goal 을 승인 워크플로에 편입시킨다(spec_approval_required = 1).
 * 승인본이 이미 고정돼 있고 활성 실행 run 이 없으면 승인을 무효화한다
 * (execution_spec_version_id = NULL → 재승인 전 실행 차단, 설계 metric 4).
 * 단, 명시적인 active execution run 진행 중이면 현재 실행본을 흔들지 않는다
 * (설계 pattern 8) — 승인 포인터는 그대로 두고 다음 실행용 draft 로만 쌓인다.
 * 순간적인 in-flight 가 아니라 run 수명 기준이므로, 순차 task 사이 공백(직전 task
 * done, 다음 task todo)에 저장된 draft 도 진행 중 run 의 pin 을 무효화하지 않는다.
 */
export function saveSpecDraft(
  db: Database,
  goalId: string,
  fields: SpecFields,
): SpecVersion {
  const normalized = normalizeDraftFields(fields);
  const tx = db.transaction((): SpecVersion => {
    const goal = goalExists(db, goalId);
    const activeRunId = goal.active_execution_run_id
      ?? (goal.execution_spec_version_id && hasInFlightTask(db, goalId) ? beginExecutionRun(db, goalId) : null);

    const nextVersion = (db.prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next FROM goal_spec_versions WHERE goal_id = ?",
    ).get(goalId) as { next: number }).next;

    const info = db.prepare(`
      INSERT INTO goal_spec_versions
        (goal_id, version, scope, out_of_scope, acceptance_criteria, expected_tasks, verification_methods, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')
    `).run(
      goalId,
      nextVersion,
      normalized.scope,
      normalized.out_of_scope,
      JSON.stringify(normalized.acceptance_criteria),
      JSON.stringify(normalized.expected_tasks),
      JSON.stringify(normalized.verification_methods),
    );

    if (goal.execution_spec_version_id && !activeRunId) {
      // 승인 무효화 — 편집이 실행 기준을 벗어나게 했으므로 재승인 전까지 차단.
      db.prepare(
        `UPDATE goals
         SET execution_spec_version_id = NULL,
             pending_execution_spec_version_id = NULL,
             spec_approval_required = 1
         WHERE id = ?`,
      ).run(goalId);
    } else {
      db.prepare("UPDATE goals SET spec_approval_required = 1 WHERE id = ?").run(goalId);
    }

    const row = db.prepare(
      "SELECT * FROM goal_spec_versions WHERE rowid = ?",
    ).get(info.lastInsertRowid) as SpecVersionRow;
    return serialize(row);
  });
  return tx();
}

/**
 * 지정 version 을 immutable approved 로 만들고, 활성 run 이 없을 때만 goal 의
 * execution_spec_version_id 를 그 version 으로 고정한다.
 * 요청에 명시된 version ID 를 그대로 승인한다(최신 추론 금지, 설계 pattern 4).
 * 이미 approved 인 version 재승인은 idempotent — 승인 시각/이력을 중복 생성하지 않는다.
 * 명시적인 active execution run 진행 중 재승인은 새 version 을 approved 로만 확정하고 실행
 * 포인터(pin)는 옮기지 않는다 — 한 run 이 서로 다른 spec version 을 섞어 쓰지 않도록
 * 하고(설계 pattern 7·8), 최신 승인 게이트는 run 종료 후 신규 실행에만 적용한다.
 */
export function approveSpecVersion(db: Database, goalId: string, versionId: string): SpecVersion {
  const tx = db.transaction((): SpecVersion => {
    goalExists(db, goalId);
    const row = db.prepare(
      "SELECT * FROM goal_spec_versions WHERE id = ? AND goal_id = ?",
    ).get(versionId, goalId) as SpecVersionRow | undefined;
    if (!row) throw new SpecApprovalError("version_not_found", "Spec version not found for this goal");

    // stale version 승인 차단 — 요청 version 이 최신 snapshot 이 아니면 승인 자체를
    // 거부하고(원자적, 같은 트랜잭션 내) execution pointer 는 손대지 않는다.
    const latest = db.prepare(
      "SELECT MAX(version) AS max FROM goal_spec_versions WHERE goal_id = ?",
    ).get(goalId) as { max: number };
    if (row.version !== latest.max) {
      throw new SpecApprovalError("stale_version", "A newer spec version exists; approve the latest version instead");
    }

    const spec = serialize(row);
    const validity = validateSpecForApproval(spec);
    if (!validity.ok) throw new SpecApprovalError("invalid_spec", validity.error, validity.location);

    // 승인본은 immutable — 이미 approved 면 상태를 다시 쓰지 않는다(감사 시각 보존).
    if (row.status !== "approved") {
      db.prepare(
        "UPDATE goal_spec_versions SET status = 'approved', approved_at = datetime('now') WHERE id = ?",
      ).run(versionId);
    }
    // 현재 승인 포인터 이동은 활성 run 이 없을 때만. run 진행 중 재승인은 pin 을
    // 그대로 두어 진행 중 실행이 시작 당시 version 을 계속 쓰게 한다.
    if (!getActiveRunId(db, goalId)) {
      db.prepare(
        `UPDATE goals
         SET execution_spec_version_id = ?,
             pending_execution_spec_version_id = NULL,
             spec_approval_required = 1
         WHERE id = ?`,
      ).run(versionId, goalId);
    } else {
      db.prepare(
        `UPDATE goals
         SET pending_execution_spec_version_id = ?, spec_approval_required = 1
         WHERE id = ?`,
      ).run(versionId, goalId);
    }

    const updated = db.prepare(
      "SELECT * FROM goal_spec_versions WHERE id = ?",
    ).get(versionId) as SpecVersionRow;
    return serialize(updated);
  });
  return tx();
}

/** 공통 조회 응답 — dashboard 가 version·시각 기준으로 이력을 재구성한다(설계 metric 3). */
export function getSpecState(db: Database, goalId: string): SpecState {
  const goal = db.prepare(
    "SELECT execution_spec_version_id, spec_approval_required FROM goals WHERE id = ?",
  ).get(goalId) as { execution_spec_version_id: string | null; spec_approval_required: number } | undefined;
  if (!goal) throw new SpecApprovalError("goal_not_found", "Goal not found");

  const versions = (db.prepare(
    "SELECT * FROM goal_spec_versions WHERE goal_id = ? ORDER BY version ASC",
  ).all(goalId) as SpecVersionRow[]).map(serialize);

  const legacy = db.prepare(
    "SELECT prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by, created_at FROM goal_specs WHERE goal_id = ?",
  ).get(goalId) as {
    prd_summary: string;
    feature_specs: string;
    user_flow: string;
    acceptance_criteria: string;
    tech_considerations: string;
    generated_by: string;
    created_at: string;
  } | undefined;
  const generationMeta = safeParse<{ _status?: string; _error?: string }>(legacy?.prd_summary, {});
  const generationStatus: SpecState["generation_status"] = generationMeta._status === "generating"
    ? "generating"
    : generationMeta._status === "failed"
      ? "failed"
      : "idle";

  // versioned workflow 이전에 만들어진 goal 은 실체가 legacy goal_specs 에만 있다.
  // versions 가 비었을 때만 그 리치 PRD 를 read-only 로 투영한다(신규 goal 은 versions 로 표현).
  const legacySpec = versions.length === 0 && legacy ? projectLegacySpec(legacy) : null;

  const latestVersion = versions.at(-1);
  const hasApprovedVersion = versions.some((version) => version.state === "approved");
  const status: SpecState["status"] = versions.length === 0
    ? "missing"
    : latestVersion?.id !== goal.execution_spec_version_id && hasApprovedVersion
      ? "changes_pending"
      : latestVersion?.id === goal.execution_spec_version_id && latestVersion.state === "approved"
        ? "approved"
        : "draft";

  return {
    goal_id: goalId,
    status,
    generation_status: generationStatus,
    generation_error: generationStatus === "failed" ? generationMeta._error ?? "Generation failed" : null,
    execution_spec_version_id: goal.execution_spec_version_id ?? null,
    versions,
    legacy_spec: legacySpec,
  };
}

/**
 * legacy goal_specs 행을 read-only PRD 로 투영한다. _status/_error 센티널만 있는
 * 행(생성 중·실패)은 실제 기획서가 아니므로 null 을 돌려준다.
 */
function projectLegacySpec(legacy: {
  prd_summary: string;
  feature_specs: string;
  user_flow: string;
  acceptance_criteria: string;
  tech_considerations: string;
  generated_by: string;
  created_at: string;
}): GoalSpecLegacyContent | null {
  const prd = safeParse<Record<string, unknown>>(legacy.prd_summary, {});
  const featureSpecs = safeParse<unknown[]>(legacy.feature_specs, []);
  const userFlow = safeParse<unknown[]>(legacy.user_flow, []);
  const acceptance = safeParse<unknown[]>(legacy.acceptance_criteria, []);
  const tech = safeParse<unknown[]>(legacy.tech_considerations, []);

  const prdContentKeys = Object.keys(prd).filter((key) => key !== "_status" && key !== "_error");
  const hasContent = prdContentKeys.length > 0
    || featureSpecs.length > 0 || userFlow.length > 0 || acceptance.length > 0 || tech.length > 0;
  if (!hasContent) return null;

  const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

  return {
    prd_summary: {
      background: asString(prd.background),
      objective: asString(prd.objective),
      scope: asString(prd.scope),
      success_metrics: Array.isArray(prd.success_metrics)
        ? prd.success_metrics.filter((entry): entry is string => typeof entry === "string")
        : undefined,
    },
    feature_specs: featureSpecs.filter(isRecord).map((f) => ({
      name: asString(f.name),
      description: asString(f.description),
      requirements: Array.isArray(f.requirements)
        ? f.requirements.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      priority: asString(f.priority),
    })),
    user_flow: userFlow.filter(isRecord).map((step) => ({
      step: typeof step.step === "number" ? step.step : undefined,
      action: asString(step.action),
      expected: asString(step.expected),
    })),
    acceptance_criteria: acceptance.filter((entry): entry is string => typeof entry === "string"),
    tech_considerations: tech.filter((entry): entry is string => typeof entry === "string"),
    generated_by: legacy.generated_by,
    created_at: legacy.created_at,
  };
}

/**
 * 실행에 고정된 승인 snapshot. 분해·구현·검증 단계가 매번 최신을 재조회하지 않고
 * 이 동일 version 을 참조하게 만드는 근거(설계 metric 2). 고정본이 없으면 null.
 */
export function getExecutionSpec(db: Database, goalId: string): SpecVersion | null {
  const row = db.prepare(
    `SELECT version.*
     FROM goals AS goal
     JOIN goal_spec_versions AS version
       ON version.id = goal.execution_spec_version_id
      AND version.goal_id = goal.id
      AND version.status = 'approved'
     WHERE goal.id = ?`,
  ).get(goalId) as SpecVersionRow | undefined;
  return row ? serialize(row) : null;
}

export function getExecutionSpecByVersionId(db: Database, versionId: string | null | undefined): SpecVersion | null {
  if (!versionId) return null;
  const row = db.prepare(
    "SELECT * FROM goal_spec_versions WHERE id = ? AND status = 'approved'",
  ).get(versionId) as SpecVersionRow | undefined;
  return row ? serialize(row) : null;
}

/** 구현·검증은 task에 복사된 version이 아니라 귀속 run의 immutable snapshot을 읽는다. */
export function getTaskExecutionSpec(db: Database, taskId: string): SpecVersion | null {
  const row = db.prepare(`
    SELECT version.*
    FROM tasks AS task
    JOIN goal_execution_runs AS run
      ON run.id = task.execution_run_id
     AND run.goal_id = task.goal_id
    JOIN goal_spec_versions AS version
      ON version.id = run.execution_spec_version_id
     AND version.goal_id = task.goal_id
     AND version.status = 'approved'
    WHERE task.id = ?
  `).get(taskId) as SpecVersionRow | undefined;
  return row ? serialize(row) : null;
}

/** 승인된 동일 snapshot을 분해·구현·검증 prompt에 넣는 공통 표현. */
export function formatExecutionSpecContext(spec: SpecVersion | null): string {
  if (!spec) return "";
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n") || "- None";
  return `
## Approved Goal Blueprint (immutable execution version ${spec.version}, id: ${spec.id})
**Scope**: ${spec.scope || "N/A"}
**Out of scope**: ${spec.out_of_scope || "N/A"}

### Acceptance Criteria
${list(spec.acceptance_criteria)}

### Expected Tasks
${list(spec.expected_tasks)}

### Verification Methods
${list(spec.verification_methods)}
`;
}

/**
 * 공용 서버측 실행 게이트. claimTaskForExecution 이 매 claim 직전에 호출하므로
 * 수동 실행·scheduler·rescue·재시작 복구가 모두 이 하나의 판정을 통과한다.
 * marker 가 꺼진(0) goal(legacy/기존 autopilot)은 무조건 허용 — 기존 흐름 불변.
 */
export function assertExecutionAllowed(db: Database, goalId: string, taskId?: string): ExecutionGate {
  const goal = db.prepare(
    "SELECT execution_spec_version_id, spec_approval_required FROM goals WHERE id = ?",
  ).get(goalId) as { execution_spec_version_id: string | null; spec_approval_required: number } | undefined;
  if (!goal) return { allowed: true }; // 없는 goal 은 하위 not_found 경로가 처리
  if (goal.spec_approval_required !== 1) return { allowed: true };

  const executionSpec = getExecutionSpec(db, goalId);
  const state = getSpecState(db, goalId);
  // 신규 실행: 최신 승인본이 실행 pin 과 일치할 때만 시작을 허용한다.
  if (state.status === "approved" && executionSpec) return { allowed: true };
  // 활성 run 계속: 이미 승인 version 으로 pin 된 run 이 진행 중이면, 실행 중 저장된
  // draft/재승인이 남은 순차 task 를 막지 않는다. 그 편집은 다음 신규 run 만 게이팅하며
  // 현재 run 은 시작 당시 고정된 승인 snapshot 을 계속 참조한다(설계 pattern 7·8).
  const activeRunId = getActiveRunId(db, goalId);
  if (executionSpec && activeRunId && taskId) {
    const member = db.prepare(
      "SELECT 1 FROM tasks WHERE id = ? AND goal_id = ? AND execution_run_id = ?",
    ).get(taskId, goalId, activeRunId);
    if (member) return { allowed: true };
  }

  const latestVersion = state.versions.at(-1)?.version ?? null;
  const specStatus = state.status === "approved" ? "draft" : state.status;
  const message = specStatus === "missing"
    ? "Goal spec is missing and must be approved before execution"
    : specStatus === "changes_pending"
      ? "Goal spec has unapproved changes and requires re-approval before execution"
      : "Goal spec draft requires approval before execution";
  return {
    allowed: false,
    reason: "spec_not_approved",
    message,
    specStatus,
    currentDraftVersion: latestVersion,
  };
}
