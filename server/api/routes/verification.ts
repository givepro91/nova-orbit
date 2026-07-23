import { Router } from "express";
import type { AppContext } from "../../index.js";
import { normalizeSeverity } from "../../utils/severity.js";
import { loadProviderConfig } from "../../core/agent/provider.js";
import { serializeTask, selectTaskForResponse } from "./tasks.js";
import { flushVerificationBroadcastOutbox } from "../../core/quality-gate/outbox.js";
import { createFixTasksFromVerification } from "../../core/orchestration/engine.js";
import { classifyFailCause, type FailCauseIssue } from "../../core/quality-gate/fail-cause.js";
import type { CalibrationStats, FailCauseCategory, VerificationLabelValue } from "../../../shared/types.js";

const MANUAL_APPROVAL_ASSIGNEE = "__manual_approval__";

const LABEL_VALUES: readonly VerificationLabelValue[] = ["false_positive", "false_negative", "correct"];

/** verification_labels.cause_category에는 CHECK가 없다(schema.ts) — 어휘는 여기서 강제한다. */
const CAUSE_CATEGORIES: readonly FailCauseCategory[] = [
  "functionality", "dataFlow", "designAlignment", "craft", "edgeCases",
  "fix_round_limit", "evaluator_error", "unclassified",
];

/** decompose 접지 스프린트에서 기록된 fail률 기준선(%) — 이후 판정 변화를 이 값과 대조한다. */
const BASELINE_FAIL_RATE = 48;

export function createVerificationRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

  // List verifications for a task
  router.get("/", (req, res) => {
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 200;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

    // 사람 라벨을 함께 실어 보낸다 — 없으면 새로고침 직후 라벨 칩이 사라진다(1:1 UNIQUE라 행이 늘지 않는다).
    let verifications;
    if (taskId) {
      verifications = db.prepare(`
        SELECT v.*, l.label AS label, l.cause_category AS cause_category,
               l.note AS label_note, l.labeled_at AS labeled_at
        FROM verifications v
        LEFT JOIN verification_labels l ON l.verification_id = v.id
        WHERE v.task_id = ?
        ORDER BY v.created_at DESC LIMIT ?
      `).all(taskId, limit);
    } else if (projectId) {
      verifications = db.prepare(`
        SELECT v.*, t.title AS task_title, l.label AS label, l.cause_category AS cause_category,
               l.note AS label_note, l.labeled_at AS labeled_at
        FROM verifications v
        JOIN tasks t ON v.task_id = t.id
        LEFT JOIN verification_labels l ON l.verification_id = v.id
        WHERE t.project_id = ?
        ORDER BY v.created_at DESC LIMIT ?
      `).all(projectId, limit);
    } else {
      return res.status(400).json({ error: "taskId or projectId query param required" });
    }

    // Parse JSON fields safely — malformed JSON returns empty defaults
    const parsed = (verifications as any[]).map((v) => {
      let dimensions = {};
      let issues: unknown[] = [];
      try { dimensions = JSON.parse(v.dimensions); } catch { /* invalid JSON */ }
      try { issues = JSON.parse(v.issues); } catch { /* invalid JSON */ }
      return { ...v, dimensions, issues };
    });

    res.json(parsed);
  });

  // Aggregated verification stats for a project
  router.get("/stats", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    if (!projectId) {
      return res.status(400).json({ error: "projectId query param required" });
    }

    const verdictRow = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN v.verdict = 'pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN v.verdict = 'conditional' THEN 1 ELSE 0 END) as conditional,
        SUM(CASE WHEN v.verdict = 'fail' THEN 1 ELSE 0 END) as failed
      FROM verifications v
      JOIN tasks t ON v.task_id = t.id
      WHERE t.project_id = ?
    `).get(projectId) as { total: number; passed: number; conditional: number; failed: number };

    const retryRow = db.prepare(`
      SELECT AVG(retry_count) as avg_retries
      FROM tasks
      WHERE project_id = ? AND status = 'done'
    `).get(projectId) as { avg_retries: number | null };

    const total = verdictRow.total ?? 0;
    const passed = verdictRow.passed ?? 0;
    const conditional = verdictRow.conditional ?? 0;
    const failed = verdictRow.failed ?? 0;
    const passRate = total > 0 ? Math.round(((passed + conditional) / total) * 100) : null;
    const avgRetries = retryRow.avg_retries != null ? Math.round(retryRow.avg_retries * 10) / 10 : null;

    res.json({ total, passed, conditional, failed, passRate, avgRetries });
  });

  // Quality Gate 판정 정확도 계측 — 기준선 대비 fail률 델타 + fail 사유 유형 분포 + 사람 라벨 집계
  router.get("/calibration", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    if (!projectId) {
      return res.status(400).json({ error: "projectId query param required" });
    }

    const verdictRow = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN v.verdict = 'pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN v.verdict = 'conditional' THEN 1 ELSE 0 END) as conditional,
        SUM(CASE WHEN v.verdict = 'fail' THEN 1 ELSE 0 END) as failed
      FROM verifications v
      JOIN tasks t ON v.task_id = t.id
      WHERE t.project_id = ?
    `).get(projectId) as { total: number; passed: number; conditional: number; failed: number };

    const failRows = db.prepare(`
      SELECT v.id, v.verdict, v.severity, v.termination_reason, v.issues
      FROM verifications v
      JOIN tasks t ON v.task_id = t.id
      WHERE t.project_id = ? AND v.verdict = 'fail'
    `).all(projectId) as Array<{
      id: string;
      verdict: string;
      severity: string | null;
      termination_reason: string | null;
      issues: string;
    }>;

    // 정규화된 verification_issues를 우선 쓰고, 레거시 행(정규화 레코드 없음)은
    // verifications.issues JSON blob으로 폴백한다 — 폴백이 없으면 축적된 모수의
    // 상당수가 근거 없이 unclassified로 몰린다.
    const issueRows = db.prepare(`
      SELECT i.verification_id, i.dimension, i.severity
      FROM verification_issues i
      JOIN verifications v ON i.verification_id = v.id
      JOIN tasks t ON v.task_id = t.id
      WHERE t.project_id = ? AND v.verdict = 'fail'
    `).all(projectId) as Array<{ verification_id: string; dimension: string; severity: string }>;

    const normalizedIssues = new Map<string, FailCauseIssue[]>();
    for (const row of issueRows) {
      const list = normalizedIssues.get(row.verification_id);
      if (list) list.push(row);
      else normalizedIssues.set(row.verification_id, [row]);
    }

    const causeCounts = new Map<FailCauseCategory, number>();
    for (const row of failRows) {
      let issues = normalizedIssues.get(row.id);
      if (!issues) {
        try {
          const parsed = JSON.parse(row.issues);
          issues = Array.isArray(parsed) ? parsed : [];
        } catch { issues = []; /* invalid JSON */ }
      }
      const category = classifyFailCause({ ...row, issues });
      if (!category) continue;
      causeCounts.set(category, (causeCounts.get(category) ?? 0) + 1);
    }

    const labelRows = db.prepare(`
      SELECT l.label, COUNT(*) as count
      FROM verification_labels l
      JOIN verifications v ON l.verification_id = v.id
      JOIN tasks t ON v.task_id = t.id
      WHERE t.project_id = ?
      GROUP BY l.label
    `).all(projectId) as Array<{ label: string; count: number }>;

    const total = verdictRow.total ?? 0;
    const passed = verdictRow.passed ?? 0;
    const conditional = verdictRow.conditional ?? 0;
    const failed = verdictRow.failed ?? 0;
    const failRate = total > 0 ? Math.round((failed / total) * 1000) / 10 : null;
    const failRateDelta = failRate != null ? Math.round((failRate - BASELINE_FAIL_RATE) * 10) / 10 : null;

    // count 내림차순, 동수는 category 사전순 — 응답이 호출마다 흔들리지 않도록 고정한다.
    const causes = [...causeCounts.entries()]
      .map(([category, count]) => ({
        category,
        count,
        ratio: failed > 0 ? Math.round((count / failed) * 1000) / 1000 : 0,
      }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

    const labelCount = (label: string) => labelRows.find((r) => r.label === label)?.count ?? 0;
    const labels = {
      total: labelRows.reduce((sum, r) => sum + r.count, 0),
      falsePositive: labelCount("false_positive"),
      falseNegative: labelCount("false_negative"),
      correct: labelCount("correct"),
    };

    const response: CalibrationStats = {
      total, passed, conditional, failed,
      failRate,
      baselineFailRate: BASELINE_FAIL_RATE,
      failRateDelta,
      causes,
      labels,
    };
    res.json(response);
  });

  // Create verification result
  router.post("/", (req, res) => {
    const {
      task_id,
      verdict,
      scope = "standard",
      dimensions,
      issues = [],
      severity,
      evaluator_session_id,
      implementation_session_id,
    } = req.body;

    if (!task_id || !verdict) {
      return res.status(400).json({ error: "task_id and verdict are required" });
    }

    // verdict/scope/severity를 CHECK 허용값으로 정규화 — 외부에서 enum 밖 값이 와도
    // INSERT가 throw되지 않도록(evaluator 경로의 VALID_VERDICTS 가드와 동일 패턴).
    const normVerdict = ["pass", "conditional", "fail"].includes(verdict) ? verdict : "fail";
    const normScope = ["lite", "standard", "full"].includes(scope) ? scope : "standard";
    const normSeverity = normalizeSeverity(severity, normVerdict);

    // verification/task/activity 저장 + outbox 등록을 하나의 트랜잭션으로 묶는다 —
    // 도중에 실패하면(예: activities INSERT 실패) 전부 롤백되어 verification만
    // 남는 부분 저장 상태를 방지한다. WebSocket 발행은 커밋 후 outbox로 최소 1회 보장.
    let blockedTask: any = null;
    const persist = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO verifications (
          task_id, verdict, scope, dimensions, issues, severity,
          evaluator_session_id, implementation_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task_id,
        normVerdict,
        normScope,
        JSON.stringify(dimensions ?? {}),
        JSON.stringify(issues),
        normSeverity,
        evaluator_session_id ?? null,
        implementation_session_id ?? null,
      );

      const verification = db.prepare("SELECT * FROM verifications WHERE rowid = ?").get(result.lastInsertRowid) as any;

      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as any;
      const insertIssue = db.prepare(`
        INSERT INTO verification_issues (
          verification_id, dimension, severity, evidence, repro_command,
          expected_result, actual_result, fix_instruction, assignee_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const issue of Array.isArray(issues) ? issues : []) {
        const evidence = issue.evidence ?? issue.message;
        const reproCommand = issue.repro_command ?? issue.reproCommand;
        const expectedResult = issue.expected_result ?? issue.expectedResult;
        const actualResult = issue.actual_result ?? issue.actualResult;
        const fixInstruction = issue.fix_instruction ?? issue.fixInstruction;
        // verification_issues.assignee_id is a deliberate soft reference. Preserve a
        // structurally valid issue even when no agent can be resolved; fix-task
        // conversion turns this sentinel into an unassigned pending-approval task.
        const assigneeId = issue.assignee_id ?? issue.assigneeId ?? task?.assignee_id ?? MANUAL_APPROVAL_ASSIGNEE;
        if (!issue.dimension || !evidence || !reproCommand || !expectedResult ||
            !actualResult || !fixInstruction) continue;
        insertIssue.run(
          verification.id,
          issue.dimension,
          issue.severity,
          evidence,
          reproCommand,
          expectedResult,
          actualResult,
          fixInstruction,
          assigneeId,
        );
      }

      // Update task with verification result
      db.prepare("UPDATE tasks SET verification_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(verification.id, task_id);

      // If hard-block, set task to blocked
      if (normSeverity === "hard-block") {
        db.prepare("UPDATE tasks SET status = 'blocked', updated_at = datetime('now') WHERE id = ?")
          .run(task_id);
        blockedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as any;
      }

      // Log activity
      if (task) {
        db.prepare(`
          INSERT INTO activities (project_id, type, message, metadata)
          VALUES (?, ?, ?, ?)
        `).run(
          task.project_id,
          normVerdict === "pass" ? "verification_pass" : "verification_fail",
          `Task "${task.title}" verification: ${normVerdict.toUpperCase()}`,
          JSON.stringify({ taskId: task_id, verdict: normVerdict, severity: normSeverity }),
        );
      }

      let parsedDimensions: unknown = {};
      let parsedIssues: unknown[] = [];
      try { parsedDimensions = JSON.parse(verification.dimensions); } catch { /* invalid JSON */ }
      try {
        const p = JSON.parse(verification.issues);
        parsedIssues = Array.isArray(p) ? p : [];
      } catch { /* invalid JSON */ }

      const payload = { ...verification, dimensions: parsedDimensions, issues: parsedIssues };
      db.prepare(`
        INSERT INTO verification_broadcast_outbox (verification_id, event_type, payload)
        VALUES (?, 'verification:result', ?)
      `).run(verification.id, JSON.stringify(payload));

      return payload;
    });

    const payload = persist();

    if (blockedTask) broadcast("task:updated", blockedTask);
    flushVerificationBroadcastOutbox(db, broadcast);

    res.status(201).json(payload);
  });

  // Create one fix task per normalized issue from a failed verification
  router.post("/:id/create-fix-task", (req, res) => {
    const { id } = req.params;

    const verification = db.prepare("SELECT id, verdict FROM verifications WHERE id = ?").get(id) as {
      id: string;
      verdict: string;
    } | undefined;
    if (!verification) return res.status(404).json({ error: "Verification not found" });
    if (verification.verdict !== "fail") {
      return res.status(409).json({ error: "Fix tasks can only be created from a failed verification" });
    }

    try {
      const conversion = createFixTasksFromVerification(db, id, broadcast);
      if (conversion.fixTasks.length === 0) {
        return res.status(422).json({ error: "Verification has no valid normalized issues" });
      }

      const globalDefault = loadProviderConfig().defaultProvider;
      const fixTasks = conversion.fixTasks.map((fixTask) => {
        const row = selectTaskForResponse(db, fixTask.taskId);
        if (!row) throw new Error(`Created fix task ${fixTask.taskId} not found`);
        const serialized = serializeTask(row, globalDefault);
        if (fixTask.created) broadcast("task:updated", { ...serialized, action: "created" });
        return serialized;
      });

      res.status(201).json({
        verification_id: id,
        status: conversion.manualApprovalRequired ? "manual_approval" : "fixing",
        fix_tasks: fixTasks,
        issue_task_mappings: conversion.fixTasks.map((fixTask) => ({
          issue_id: fixTask.issueId,
          fix_task_id: fixTask.taskId,
        })),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 사람이 매기는 판정 정확도 라벨 (오탐/미탐/정확). verification 1건당 1행 —
  // 다시 라벨하면 마지막 값이 이긴다. 사람 → 분석 단방향이며 evaluator는 읽지 않는다.
  router.post("/:id/label", (req, res) => {
    const { id } = req.params;
    const { label, cause_category, note } = req.body ?? {};

    if (!LABEL_VALUES.includes(label)) {
      return res.status(400).json({ error: `label must be one of: ${LABEL_VALUES.join(", ")}` });
    }
    const causeCategory = cause_category ?? null;
    if (causeCategory !== null && !CAUSE_CATEGORIES.includes(causeCategory)) {
      return res.status(400).json({ error: `cause_category must be one of: ${CAUSE_CATEGORIES.join(", ")}` });
    }
    const normalizedNote = typeof note === "string" && note.trim() ? note.trim() : null;

    // verifications.task_id는 NOT NULL FK지만, task가 없어도 라벨 자체는 남길 수 있도록
    // LEFT JOIN으로 읽고 activity 기록만 건너뛴다.
    const verification = db.prepare(`
      SELECT v.id, t.project_id, t.title AS task_title
      FROM verifications v
      LEFT JOIN tasks t ON v.task_id = t.id
      WHERE v.id = ?
    `).get(id) as { id: string; project_id: string | null; task_title: string | null } | undefined;
    if (!verification) return res.status(404).json({ error: "Verification not found" });

    const existed = db.prepare("SELECT 1 FROM verification_labels WHERE verification_id = ?").get(id) !== undefined;

    // 라벨 upsert + activity 기록을 하나의 트랜잭션으로 묶는다. WebSocket 발행은 커밋 후 —
    // verification_broadcast_outbox는 CHECK(event_type='verification:result')라 쓸 수 없다.
    const persist = db.transaction(() => {
      db.prepare(`
        INSERT INTO verification_labels (verification_id, label, cause_category, note)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(verification_id) DO UPDATE SET
          label = excluded.label,
          cause_category = excluded.cause_category,
          note = excluded.note,
          labeled_at = datetime('now')
      `).run(id, label, causeCategory, normalizedNote);

      const row = db.prepare(`
        SELECT id, verification_id, label, cause_category, note, labeled_at
        FROM verification_labels WHERE verification_id = ?
      `).get(id) as {
        id: string;
        verification_id: string;
        label: VerificationLabelValue;
        cause_category: FailCauseCategory | null;
        note: string | null;
        labeled_at: string;
      };

      if (verification.project_id) {
        db.prepare(`
          INSERT INTO activities (project_id, type, message, metadata)
          VALUES (?, 'verification_labeled', ?, ?)
        `).run(
          verification.project_id,
          `Task "${verification.task_title}" verification labeled: ${label}`,
          JSON.stringify({ verificationId: id, label, causeCategory }),
        );
      }

      return row;
    });

    const row = persist();

    broadcast("verification:labeled", row);

    res.status(existed ? 200 : 201).json(row);
  });

  return router;
}
