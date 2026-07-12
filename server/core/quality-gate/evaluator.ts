import type { Database } from "better-sqlite3";
import { spawnSync } from "node:child_process";
import type { SessionManager, SessionRecord } from "../agent/session.js";
import { parseAgentOutput, extractJsonBlock } from "../agent/stream-parser.js";
import { createLogger } from "../../utils/logger.js";
import { normalizeSeverity } from "../../utils/severity.js";
import { createMethodologyEngine } from "../methodology/index.js";
import { flushVerificationBroadcastOutbox } from "./outbox.js";
import type {
  DimensionVerdict,
  IssueSeverity,
  QualityGateDimension,
  VerificationResult,
  VerificationScope,
  Verdict,
  Severity,
  Score,
  VerificationIssue,
  VerificationTerminationReason,
} from "../../../shared/types.js";
import { formatExecutionSpecContext, getTaskExecutionSpec } from "../goal-spec/spec-approval.js";
import { saveAgentHandoff } from "../agent/handoff-store.js";
import { AGENT_HANDOFF_CONTRACT_VERSION } from "../../../shared/types.js";
import {
  AgentHandoffConsumptionError,
  formatConsumedAgentHandoff,
  loadRequiredAgentHandoff,
  recordHandoffPreflightFailure,
} from "../agent/handoff-consumer.js";

const log = createLogger("quality-gate");

function verificationHandoffContract(): string {
  return `
## Required structured handoff
Add this property to the SAME top-level verification JSON object:
\`\`\`json
{
  "handoff": {
    "version": ${AGENT_HANDOFF_CONTRACT_VERSION},
    "stage": "verification",
    "changed_files": [],
    "decisions": [],
    "unresolved_risks": [],
    "reproduction_commands": []
  }
}
\`\`\`
List independently checked files and commands. Keep every array field present; use \`[]\` when empty.
`;
}

export interface QualityGateConfig {
  scope: VerificationScope;
  maxRetries: number;
}

const DEFAULT_CONFIG: QualityGateConfig = {
  scope: "standard",
  maxRetries: 1,
};

function resolveSessionIdentity(
  record: SessionRecord | undefined,
  runtimeSessionId?: string | null,
  fallback?: string | null,
): string | null {
  return runtimeSessionId ?? record?.runtimeSessionId ?? record?.rowId ?? fallback ?? null;
}

function resolveSessionIdentities(
  record: SessionRecord | undefined,
  runtimeSessionId?: string | null,
  fallback?: string | null,
): string[] {
  return [...new Set([
    runtimeSessionId,
    record?.runtimeSessionId,
    record?.rowId,
    fallback,
  ].filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function buildSessionSeparationFailure(
  taskId: string,
  scope: VerificationScope,
  evaluatorSessionId: string,
  reusedSessionId: string,
  reusedSessionSource: "implementation" | "fix",
): VerificationResult {
  const zero: Score = { value: 0, notes: "Generator-Evaluator session separation failed" };
  return {
    id: "",
    taskId,
    verdict: "fail",
    scope,
    dimensions: {
      functionality: zero,
      dataFlow: zero,
      designAlignment: zero,
      craft: zero,
      edgeCases: zero,
    },
    issues: [{
      id: "issue-evaluator-session-reused",
      severity: "critical",
      message: `Quality Gate가 ${reusedSessionSource === "fix" ? "과거 수정" : "구현"} 세션(${reusedSessionId})을 evaluator_session_id로 재사용했습니다. Generator-Evaluator 분리 계약 위반입니다.`,
      suggestion: "구현·수정 세션과 다른 evaluator sessionKey로 새 세션을 spawn하고, 실제 evaluator session id를 기록하세요.",
    }],
    severity: "hard-block",
    evaluatorSessionId,
    terminationReason: "evaluator_error",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Crewdeck Quality Gate — Generator-Evaluator Separation
 *
 * Core principle: The agent that implements (Generator) and the agent that
 * verifies (Evaluator) are ALWAYS different sessions. This prevents the
 * "marking your own homework" anti-pattern.
 *
 * 5-Dimension Verification (ported from Crewdeck):
 * 1. Functionality — Does the code do what was requested?
 * 2. Data Flow — Input → Save → Load → Display complete?
 * 3. Design Alignment — Matches existing architecture?
 * 4. Craft — Error handling, type safety, edge cases?
 * 5. Edge Cases — Boundary values (0, negative, empty, max) safe?
 *
 * Severity Classification:
 * - auto-resolve: Revertible without external state change
 * - soft-block: Continuing possible but runtime failure risk
 * - hard-block: Data loss/security/irreversible — STOP immediately
 */
export function createQualityGate(
  db: Database,
  sessionManager: SessionManager,
  broadcast: (event: string, data: unknown) => void = () => {},
) {
  return {
    /**
     * Verify a completed task using an independent Evaluator session.
     * The Evaluator has NO context from the Generator — it reads the code fresh.
     */
    async verify(
      taskId: string,
      config: Partial<QualityGateConfig> & { workdir?: string } = {},
    ): Promise<VerificationResult> {
      const opts = { ...DEFAULT_CONFIG, ...config };
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
      if (!task) throw new Error(`Task ${taskId} not found`);

      const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(task.project_id) as any;
      if (!project) throw new Error(`Project ${task.project_id} not found`);

      log.info(`Starting verification for task "${task.title}" [scope: ${opts.scope}]`);

      // Collect a git diff snapshot of what the Generator actually changed.
      // This closes the "scope misread" gap from the Pulsar incident: the
      // evaluator previously had no way to notice when an agent created a
      // vanilla-JS `dashboard/` directory instead of editing `web/src/app/page.tsx`.
      // Goal-as-Unit 태스크는 goal 누적 diff(분기점 이후 커밋+미커밋 전부)를 본다 —
      // 리뷰/QA 태스크가 "자기 diff 없음"으로 오탐 통과하던 R1 결함의 구조적 방지.
      const goalRow = task.goal_id
        ? db.prepare("SELECT goal_model FROM goals WHERE id = ?").get(task.goal_id) as { goal_model?: string } | undefined
        : undefined;
      const goalBase = goalRow?.goal_model === "goal_as_unit"
        ? ((project.base_branch as string | null) || "main")
        : undefined;
      const diffSummary = collectDiffSummary(config.workdir || project.workdir, { goalBase });

      // Build evaluation prompt — 재검증이면 이전 fail 이력 + verdict 범위 정책을
      // 뒤에 붙인다. 이게 없으면 Evaluator 가 매 라운드 전체 표면을 새로 감사해
      // 인접 컴포넌트의 새 이슈로 fail 을 반복한다 (무한 검토, 07-08 실측 7라운드).
      const priorFails = db.prepare(
        "SELECT issues, created_at FROM verifications WHERE task_id = ? AND verdict = 'fail' ORDER BY created_at DESC LIMIT 3",
      ).all(taskId) as { issues: string; created_at: string }[];
      const executionSpecContext = formatExecutionSpecContext(getTaskExecutionSpec(db, taskId));
      // Spawn independent Evaluator session (NOT the Generator session)
      // This is the core Generator-Evaluator separation.
      // Per-task sessionKey lets multiple verifications run concurrently on the
      // same evaluator agent without aborting each other (spawnAgent cleanup
      // only affects the same sessionKey).
      const evaluatorId = `evaluator-${taskId}`;
      const liveImplementationSessionIdentities = task.assignee_id
        ? resolveSessionIdentities(sessionManager.getSessionRecord(task.assignee_id))
        : [];
      const persistedImplementationSessions = task.assignee_id
        ? db.prepare(`
          SELECT id, runtime_session_id
          FROM sessions
          WHERE task_id = ? AND agent_id = ?
        `).all(taskId, task.assignee_id) as Array<{ id: string; runtime_session_id: string | null }>
        : [];
      const implementationSessionIdentities = [...new Set([
        ...liveImplementationSessionIdentities,
        ...persistedImplementationSessions.flatMap((row) => [row.id, row.runtime_session_id])
          .filter((id): id is string => !!id),
      ])];
      const implementationSessionId = implementationSessionIdentities[0] ?? null;
      // 과거 fix session의 두 식별자를 모두 수집한다. session_id(sessions row id)는
      // evaluator의 새 row id와 절대 충돌하지 않으므로, 실제 맥락 누수를 잡는 건
      // runtime_session_id 비교다 — evaluator가 과거 fix 세션의 CLI runtime 대화를
      // 이어받으면 runtime id가 일치한다.
      const fixSessionRows = db.prepare(`
        SELECT session_id, runtime_session_id
        FROM verification_fix_rounds
        WHERE task_id = ? AND (session_id IS NOT NULL OR runtime_session_id IS NOT NULL)
      `).all(taskId) as { session_id: string | null; runtime_session_id: string | null }[];
      const fixSessionIds = new Set<string>();
      for (const row of fixSessionRows) {
        if (row.session_id) fixSessionIds.add(row.session_id);
        if (row.runtime_session_id) fixSessionIds.add(row.runtime_session_id);
      }

      // Find reviewer agent — Generator-Evaluator separation requires a DIFFERENT agent
      // Always exclude the task's assignee (Generator) to prevent self-review
      let evaluatorAgent = db.prepare(
        "SELECT * FROM agents WHERE project_id = ? AND role = 'reviewer' AND id != ?",
      ).get(task.project_id, task.assignee_id) as any;

      if (!evaluatorAgent) {
        evaluatorAgent = db.prepare(
          "SELECT * FROM agents WHERE project_id = ? AND id != ? LIMIT 1",
        ).get(task.project_id, task.assignee_id) as any;
      }

      if (!evaluatorAgent) {
        // Last resort: reuse or create a system reviewer agent
        // INSERT OR IGNORE to prevent race condition when multiple tasks verify simultaneously
        db.prepare(
          "INSERT OR IGNORE INTO agents (project_id, name, role, system_prompt) VALUES (?, '[Crewdeck] Evaluator', 'reviewer', ?)",
        ).run(task.project_id, "You are a code reviewer with an adversarial mindset. Find problems, don't pass them.");
        evaluatorAgent = db.prepare(
          "SELECT * FROM agents WHERE project_id = ? AND name = '[Crewdeck] Evaluator' LIMIT 1",
        ).get(task.project_id) as any;
      }

      try {
        const assertTaskStillExists = (stage: string): void => {
          const exists = db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId);
          if (!exists) {
            throw new Error(`Task ${taskId} deleted during verification (${stage})`);
          }
        };

        const persistVerification = db.transaction((result: VerificationResult): VerificationResult => {
          assertTaskStillExists("persist");
          const verRow = db.prepare(`
            INSERT INTO verifications (task_id, verdict, scope, dimensions, issues, severity, evaluator_session_id, implementation_session_id, termination_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
          `).get(
            taskId,
            result.verdict,
            result.scope,
            JSON.stringify(result.dimensions),
            JSON.stringify(result.issues),
            normalizeSeverity(result.severity, result.verdict),
            result.evaluatorSessionId,
            implementationSessionId,
            result.terminationReason ?? null,
          ) as { id: string };

          const insertJudgement = db.prepare(`
            INSERT INTO verification_dimension_judgements (verification_id, dimension, verdict, evidence)
            VALUES (?, ?, ?, ?)
          `);
          for (const judgement of result.dimensionJudgements ?? []) {
            insertJudgement.run(verRow.id, judgement.dimension, judgement.verdict, judgement.evidence);
          }

          const insertIssue = db.prepare(`
            INSERT INTO verification_issues (
              verification_id, dimension, severity, evidence, repro_command,
              expected_result, actual_result, fix_instruction, assignee_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const issue of result.issues) {
            if (!issue.dimension || !issue.reproCommand || !issue.expectedResult ||
                !issue.actualResult || !issue.fixInstruction) continue;
            insertIssue.run(
              verRow.id,
              issue.dimension,
              issue.severity,
              issue.message,
              issue.reproCommand,
              issue.expectedResult,
              issue.actualResult,
              issue.fixInstruction,
              task.assignee_id,
            );
          }

          db.prepare("UPDATE tasks SET verification_id = ?, updated_at = datetime('now') WHERE id = ?")
            .run(verRow.id, taskId);

          // 판정 저장과 감사 activity를 같은 트랜잭션으로 묶는다 — 저장 직후 프로세스가
          // 죽어도(WebSocket broadcast 유실과 무관하게) verification_pass/fail 감사 row는 남는다.
          db.prepare(`
            INSERT INTO activities (project_id, agent_id, type, message, metadata)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            task.project_id,
            evaluatorAgent.id,
            result.verdict === "pass" ? "verification_pass" : "verification_fail",
            `Task "${task.title}" verification: ${result.verdict.toUpperCase()}`,
            JSON.stringify({
              taskId,
              verdict: result.verdict,
              severity: normalizeSeverity(result.severity, result.verdict),
              status: result.verdict === "pass"
                ? "passed"
                : result.verdict === "conditional" ? "manual_approval" : "stopped",
              reason: result.terminationReason
                ?? (result.verdict === "pass" ? "passed"
                  : result.verdict === "conditional" ? "conditional" : "verification_failed"),
            }),
          );

          const stored = { ...result, id: verRow.id };
          db.prepare(`
            INSERT INTO verification_broadcast_outbox (verification_id, event_type, payload)
            VALUES (?, 'verification:result', ?)
          `).run(verRow.id, JSON.stringify(stored));

          return stored;
        });

        const persistAndPublishVerification = (result: VerificationResult): VerificationResult => {
          const stored = persistVerification(result);
          flushVerificationBroadcastOutbox(db, broadcast);
          return stored;
        };

        const recordSessionSeparationFailure = (
          result: VerificationResult,
          reusedSessionId: string,
          reusedSessionSource: "implementation" | "fix",
        ) => {
          db.prepare(`
            INSERT INTO activities (project_id, agent_id, type, message, metadata)
            VALUES (?, ?, 'verification_fail', ?, ?)
          `).run(
            task.project_id,
            evaluatorAgent.id,
            `Quality Gate session separation failed: ${task.title}`,
            JSON.stringify({
              taskId,
              reason: "evaluator_session_reused",
              implementationSessionId,
              reusedSessionId,
              reusedSessionSource,
              evaluatorSessionId: result.evaluatorSessionId,
            }),
          );
        };

        const failIfEvaluatorReusedGeneratorSession = (
          evaluatorSessionIds: string[],
          reportedEvaluatorSessionId: string,
        ): VerificationResult | null => {
          const reusedImplementationId = evaluatorSessionIds.find((id) => implementationSessionIdentities.includes(id));
          const reusedFixId = evaluatorSessionIds.find((id) => fixSessionIds.has(id));
          const reusedSessionId = reusedImplementationId ?? reusedFixId;
          if (!reusedSessionId) return null;
          const reusedSessionSource = reusedImplementationId ? "implementation" : "fix";
          const failed = buildSessionSeparationFailure(
            taskId,
            opts.scope,
            reportedEvaluatorSessionId,
            reusedSessionId,
            reusedSessionSource,
          );
          const stored = persistAndPublishVerification(failed);
          recordSessionSeparationFailure(stored, reusedSessionId, reusedSessionSource);
          log.error("Generator-Evaluator session separation failed", {
            taskId,
            implementationSessionId,
            reusedSessionId,
            reusedSessionSource,
            evaluatorSessionId: reportedEvaluatorSessionId,
          });
          return stored;
        };

        const evalWorkdir = config.workdir || project.workdir || (() => { throw new Error("Project has no workdir configured"); })();
        let consumedHandoff;
        try {
          consumedHandoff = loadRequiredAgentHandoff(db, {
            goalId: task.goal_id,
            taskId,
            phase: "verification",
            expectedStages: ["implementation", "fix"],
          });
        } catch (error) {
          if (error instanceof AgentHandoffConsumptionError) {
            recordHandoffPreflightFailure(db, {
              projectId: task.project_id,
              goalId: task.goal_id,
              taskId,
              agentId: evaluatorAgent.id,
              phase: "verification",
              error,
            });
            const blockedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
            if (blockedTask) broadcast("task:updated", blockedTask);
          }
          throw error;
        }
        const evaluationPrompt =
          buildEvaluationPrompt(task, project, opts.scope, diffSummary)
          + executionSpecContext
          + formatConsumedAgentHandoff(consumedHandoff)
          + `\nIndependently inspect every path in changed_files and run or validate every reproduction_commands entry.\n`
          + buildReverifyContext(priorFails)
          + verificationHandoffContract();
        const session = sessionManager.spawnAgent(
          evaluatorAgent.id,
          evalWorkdir,
          evaluatorId,
          taskId,
          undefined,
          { omitUnstructuredTaskOutput: true, forceNewSession: true },
        );
        const evaluatorSessionRowId = sessionManager.getSessionRecord(evaluatorId)?.rowId ?? null;
        const persistEvaluatorUsage = (usage: NonNullable<ReturnType<typeof parseAgentOutput>["usage"]>): void => {
          const tokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens;
          db.prepare(`
            UPDATE sessions
               SET token_usage = token_usage + ?,
                   token_usage_reported = MAX(COALESCE(token_usage_reported, 0), ?),
                   cost_usd = cost_usd + ?,
                   cost_usd_reported = MAX(COALESCE(cost_usd_reported, 0), ?)
             WHERE id = ?
          `).run(
            usage.tokenUsageReported ? tokens : 0,
            usage.tokenUsageReported ? 1 : 0,
            usage.costUsdReported ? usage.totalCostUsd : 0,
            usage.costUsdReported ? 1 : 0,
            evaluatorSessionRowId,
          );
        };

        const sendForEvaluation = async (prompt: string) => {
          try {
            const result = await session.send(prompt);
            const parsed = parseAgentOutput(result.stdout, result.provider, "verification");
            if (parsed.usage) persistEvaluatorUsage(parsed.usage);
            // Goal cancellation intentionally terminates the evaluator. A
            // deleted task is an expected abort, not a recovery incident.
            assertTaskStillExists("session response");
            if (result.exitCode !== 0) {
              const recoveryDecision = sessionManager.recoverAbnormalExit?.(
                evaluatorId,
                "verification",
                "reconcile",
                `verification session exited with code ${result.exitCode ?? "signal"}`,
              ) ?? null;
              const error = new Error(`Verification session exited with code ${result.exitCode ?? "signal"}`);
              (error as Error & { recoveryDecision?: string }).recoveryDecision = recoveryDecision ?? undefined;
              throw error;
            }
            return { result, parsed };
          } catch (err) {
            const recoveryDecision = (err as { recoveryDecision?: string })?.recoveryDecision
              ?? sessionManager.recoverAbnormalExit?.(
              evaluatorId,
              "verification",
              "reconcile",
              "verification session exited before producing a final result",
              ) ?? undefined;
            if (err && typeof err === "object") {
              (err as { recoveryDecision?: string }).recoveryDecision = recoveryDecision;
            }
            throw err;
          }
        };

        // Surface the review activity on the evaluator agent so the UI can
        // show "누가 무엇을 검토 중인지". Without this, the evaluator agent
        // just turns "working" in the org chart with no task context.
        const reviewActivity = `review:${(task.title ?? "").slice(0, 80)}`;
        db.prepare(
          "UPDATE agents SET current_task_id = ?, current_activity = ? WHERE id = ?",
        ).run(taskId, reviewActivity, evaluatorAgent.id);
        broadcast("agent:status", {
          id: evaluatorAgent.id,
          name: evaluatorAgent.name,
          status: "working",
          taskId,
          activity: reviewActivity,
        });

        const initialEvaluation = await sendForEvaluation(evaluationPrompt);
        const runResult = initialEvaluation.result;
        let parsed = initialEvaluation.parsed;
        assertTaskStillExists("initial response");
        let evaluatorSessionId = resolveSessionIdentity(
          sessionManager.getSessionRecord(evaluatorId),
          runResult.sessionId,
          session.id,
        ) ?? evaluatorId;
        let evaluatorSessionIdentities = resolveSessionIdentities(
          sessionManager.getSessionRecord(evaluatorId),
          runResult.sessionId,
          session.id,
        );
        const separationFailure = failIfEvaluatorReusedGeneratorSession(evaluatorSessionIdentities, evaluatorSessionId);
        if (separationFailure) return separationFailure;

        // task_type을 전달하여 유형별 임계값 판정에 활용
        const taskType = (task.task_type ?? "code") as string;
        let result = parseVerificationResult(taskId, parsed.text, opts.scope, evaluatorSessionId, taskType);

        // Parse 실패(비-JSON) 또는 구조화 계약 위반(evaluator_error)이면 명시적
        // 신호로 1회 재시도 — 재시도 후에도 실패하면 fail 유지(강등 없음).
        if (
          !parsed.handoff
          || result.issues.some((i) => i.id === "issue-parse-error" || i.id === "issue-evaluator-error")
        ) {
          log.info("Parse failed, retrying with explicit JSON reminder...");
          const retryPrompt = `이전 응답에서 JSON을 파싱하지 못했습니다. 반드시 \`\`\`json 블록으로만 응답하세요.\n\n${evaluationPrompt}`;
          assertTaskStillExists("parse retry");
          const { result: retryResult, parsed: retryParsed } = await sendForEvaluation(retryPrompt);
          assertTaskStillExists("parse retry response");
          evaluatorSessionId = resolveSessionIdentity(
            sessionManager.getSessionRecord(evaluatorId),
            retryResult.sessionId,
            session.id,
          ) ?? evaluatorSessionId;
          evaluatorSessionIdentities = resolveSessionIdentities(
            sessionManager.getSessionRecord(evaluatorId),
            retryResult.sessionId,
            session.id,
          );
          const retrySeparationFailure = failIfEvaluatorReusedGeneratorSession(evaluatorSessionIdentities, evaluatorSessionId);
          if (retrySeparationFailure) return retrySeparationFailure;

          parsed = retryParsed;
          result = parseVerificationResult(taskId, parsed.text, opts.scope, evaluatorSessionId, taskType);
        }

        if (!parsed.handoff) {
          const detail = parsed.handoffDiagnostics
            .map((diagnostic) => `${diagnostic.field}: ${diagnostic.message}`)
            .join("; ");
          throw new Error(`Invalid verification handoff: ${detail || "unknown contract violation"}`);
        }
        const evaluatorSessionRecord = sessionManager.getSessionRecord(evaluatorId);
        if (!evaluatorSessionRecord?.rowId) {
          throw new Error(`Cannot persist verification handoff: evaluator session row is unavailable for '${evaluatorId}'.`);
        }
        saveAgentHandoff(db, {
          goalId: task.goal_id,
          taskId,
          sessionId: evaluatorSessionRecord.rowId,
          handoff: parsed.handoff,
        });

        // 리뷰할 변경이 없으면(git merge/cleanup 등) 막지 않고 통과 — 구 all-zero→conditional 꼼수 대체.
        // ⚠ untracked(신규 미추적 파일)도 0이어야 한다 — goal-as-unit은 WIP가 미커밋이고
        //   신규 파일은 fileCount(=git diff)에 안 잡혀, 이 가드가 없으면 신규파일 태스크가 매번 auto-pass된다.
        if (diffSummary.fileCount === 0 &&
            diffSummary.untracked.length === 0 &&
            result.verdict === "fail" &&
            result.terminationReason !== "evaluator_error") {
          log.warn(`No reviewable changes for "${task.title}" — auto-pass (nothing to verify)`);
          result.verdict = "pass";
          result.severity = "auto-resolve";
          result.issues = [];
          result.terminationReason = "passed";
        }

        result = persistAndPublishVerification(result);

        log.info(`Verification complete: ${result.verdict.toUpperCase()} [${result.severity}]`);
        return result;
      } catch (err) {
        log.error("Verification failed", err);
        throw err;
      } finally {
        // Cleanup evaluator session to prevent leak.
        // killSession resets the agent row to idle (when no sibling sessions
        // remain) — emit a status broadcast so the UI clears the review chip.
        sessionManager.killSession(evaluatorId);
        broadcast("agent:status", {
          id: evaluatorAgent.id,
          name: evaluatorAgent.name,
          status: "idle",
        });
      }
    },
  };
}

/**
 * Auto-detect verification scope based on task characteristics.
 * Aligns with Crewdeck §1: high-risk areas auto-escalate one level.
 */
export function autoDetectScope(
  task: { title: string; description: string; target_files?: string | null },
  changedFileCount?: number,
): VerificationScope {
  const text = `${task.title} ${task.description}`.toLowerCase();

  // Execution-verification tasks ALWAYS use full scope — they need Layer 3
  // to trigger the "you must actually run commands" rule.
  if (isExecutionVerificationTask(task.title, task.description)) return "full";

  // UI 변경은 정적 리뷰로 못 잡는 결함(soft-lock·상태 꼬임·렌더 불일치)이 많다
  // → full(앱 기동 + 브라우저 재현). 조건부 검증: "항상 경량, UI/위험만 풀"의 UI 축.
  let targets: unknown = [];
  try { targets = JSON.parse(task.target_files || "[]"); } catch { /* ignore */ }
  if (Array.isArray(targets) && targets.some((f) => typeof f === "string" && /\.(tsx|jsx|vue|svelte|css|scss)$/i.test(f))) return "full";

  // High-risk patterns always escalate (Crewdeck §1: auth/DB/payment → one level up)
  const highRisk = [
    "auth", "login", "password", "token", "payment", "billing",
    "database", "migration", "schema", "security", "permission", "rbac",
    "encrypt", "decrypt", "secret", "credential",
  ];
  const isHighRisk = highRisk.some((p) => text.includes(p));

  const files = changedFileCount ?? 0;

  if (isHighRisk || files >= 8) return "full";
  if (files >= 3) return "standard";
  return "lite";
}

/**
 * Snapshot of what the Generator actually changed in the workdir. Extracted
 * from git so the Evaluator can compare against the task's stated scope and
 * catch "wrong directory" / "wrong stack" type errors that pure file reads
 * would miss.
 */
interface DiffSummary {
  /** `git diff --stat` output (file list + line counts), or null on error */
  stat: string | null;
  /** Short names of changed files (up to 30), for quick scope check */
  files: string[];
  /** Number of files changed (total, not truncated) */
  fileCount: number;
  /** Untracked files present in the workdir (up to 10) */
  untracked: string[];
  /** Base ref used (HEAD~1 when available, otherwise HEAD) */
  baseRef: string;
  /** Error message if git calls failed (workdir not a repo, etc.) */
  error?: string;
}

// 에이전트 세션이 대상 레포에 남기는 도구 상태 — diff에 섞이면 "변경 파일 있음"으로
// 오인돼 no-changes 가드를 무력화하고 scope check를 오염시킨다 (R1 스모크 재현)
export const TOOL_STATE_PATHS = [".omc", ".playwright-mcp", ".cc-shots", ".crewdeck-worktrees"];
const TOOL_STATE_EXCLUDES = TOOL_STATE_PATHS.map((p) => `:(exclude)${p}`);
const isToolStatePath = (f: string) => TOOL_STATE_PATHS.some((p) => f === p || f.startsWith(`${p}/`));

export function collectDiffSummary(
  workdir: string | undefined,
  opts?: { goalBase?: string },
): DiffSummary {
  const empty: DiffSummary = { stat: null, files: [], fileCount: 0, untracked: [], baseRef: "HEAD" };
  if (!workdir) return { ...empty, error: "No workdir provided" };

  const run = (args: string[]): { stdout: string; ok: boolean } => {
    try {
      const res = spawnSync("git", args, {
        cwd: workdir,
        stdio: "pipe",
        timeout: 5_000,
        encoding: "utf-8",
      });
      return { stdout: (res.stdout ?? "").trim(), ok: res.status === 0 };
    } catch {
      return { stdout: "", ok: false };
    }
  };

  // Detect if this is even a git repo
  const isRepo = run(["rev-parse", "--is-inside-work-tree"]);
  if (!isRepo.ok || isRepo.stdout !== "true") {
    return { ...empty, error: "Workdir is not a git repository" };
  }

  let statCmd: string[];
  let namesCmd: string[];
  let baseRef: string;

  // Goal-as-Unit: 누적 diff = base 브랜치 분기점 이후의 모든 변경 (커밋 + 미커밋).
  // legacy 의 HEAD~1..HEAD 는 "태스크가 커밋했다"는 전제라, WIP 를 미커밋으로
  // 유지하는 Goal-as-Unit 에선 마지막 커밋(잔여물 등)만 보여 diff 가 통째로 틀린다.
  const mergeBase = opts?.goalBase ? run(["merge-base", opts.goalBase, "HEAD"]) : null;
  if (mergeBase?.ok && mergeBase.stdout) {
    baseRef = `${opts!.goalBase} (goal 누적, merge-base ${mergeBase.stdout.slice(0, 8)})`;
    // `git diff <commit>` — 커밋된 것 + staged + unstaged 전부 vs 분기점
    statCmd = ["diff", "--stat", mergeBase.stdout, "--", ".", ...TOOL_STATE_EXCLUDES];
    namesCmd = ["diff", "--name-only", mergeBase.stdout, "--", ".", ...TOOL_STATE_EXCLUDES];
  } else {
    // Does HEAD~1 exist? (fresh repos / worktrees may only have 1 commit)
    const hasParent = run(["rev-parse", "--verify", "HEAD~1"]);
    baseRef = hasParent.ok ? "HEAD~1" : "HEAD";
    statCmd = hasParent.ok
      ? ["diff", "--stat", "HEAD~1..HEAD", "--", ".", ...TOOL_STATE_EXCLUDES]
      : ["show", "--stat", "HEAD", "--", ".", ...TOOL_STATE_EXCLUDES];
    namesCmd = hasParent.ok
      ? ["diff", "--name-only", "HEAD~1..HEAD", "--", ".", ...TOOL_STATE_EXCLUDES]
      : ["show", "--name-only", "--format=", "HEAD", "--", ".", ...TOOL_STATE_EXCLUDES];
  }

  const stat = run(statCmd);
  const names = run(namesCmd);
  const allFiles = names.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  const untracked = run(["ls-files", "--others", "--exclude-standard"]);
  const untrackedFiles = untracked.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => !isToolStatePath(f))
    .slice(0, 10);

  return {
    stat: stat.ok ? stat.stdout.slice(0, 2000) : null, // hard cap to keep prompts small
    files: allFiles.slice(0, 30),
    fileCount: allFiles.length,
    untracked: untrackedFiles,
    baseRef,
  };
}

/**
 * Detect whether a task's stated purpose is "verify that something runs".
 * These tasks MUST NOT pass on file-reading alone — the Evaluator has to
 * actually execute build/dev commands and check process output.
 *
 * Pulsar regression: "프론트엔드 12개 페이지 렌더링 검증" and "전체 로컬
 * 실행 통합 검증 (QA)" were marked done without any shell execution. The
 * Evaluator (an LLM) hallucinated "렌더링 됨" without ever running code.
 */
/**
 * Substring patterns that trigger execution-verification mode regardless of
 * where in title/description they appear. The patterns are intentionally
 * conservative — better to miss a borderline task than to force expensive
 * Layer 3 execution on an unrelated task.
 */
const EXECUTION_VERIFY_PATTERNS: ReadonlyArray<RegExp> = [
  // Korean
  /렌더링 검증/,
  /기동 검증/,
  /실행 검증/,
  /로컬 실행/,
  /빌드 검증/,
  /통합 검증/,
  /통합 테스트/,
  /구동 확인/,
  /스모크 테스트/,
  // English
  /\brendering\b.*(check|verify|verification)/i,
  /\bbuild\b.*(check|verify|verification)/i,
  /\bstartup\b.*(check|verify)/i,
  /\bruntime\b.*(check|verify|test)/i,
  /\bintegration\b.*(test|verify)/i,
  /\bsmoke test\b/i,
  /\be2e\b/i,
  /\bend[-.\s]to[-.\s]end\b/i,
  /verify.*runs locally/i,
];

/**
 * Per-field patterns that only count when the field (usually the title)
 * terminates with the pattern. Prevents false positives like a description
 * casually mentioning "QA" mid-sentence.
 */
const EXECUTION_VERIFY_TERMINAL_PATTERNS: ReadonlyArray<RegExp> = [
  /QA\)?$/,  // ends with "QA" or "QA)" — the Pulsar "…통합 검증 (QA)" case
];

/**
 * Substring patterns that signal a task introduces or modifies a gated /
 * protected / infra surface. Tasks matching these must pass the Empty State
 * Usability check — "can a fresh user/dev actually reach this feature from
 * an empty install?"
 *
 * Motivating regression: a "멀티테넌트 접근 제어 + API 인증" task shipped
 * a complete auth system with users.yaml / api_keys.yaml empty and no
 * /login UI, leaving the dashboard permanently at 401. The previous
 * evaluator never asked "how does the first user get in?".
 */
const GATED_SURFACE_PATTERNS: ReadonlyArray<RegExp> = [
  // Korean
  /인증/,
  /로그인/,
  /로그아웃/,
  /회원가입/,
  /권한/,
  /접근 제어/,
  /테넌트|테넌시|멀티테넌/,
  /마이그레이션/,
  /스키마/,
  /온보딩/,
  /시드/,
  // English
  /\bauth(?:entication|orization)?\b/i,
  /\blogin\b/i,
  /\bsignup\b/i,
  /\bsign-?in\b/i,
  /\brbac\b/i,
  /\bpermission/i,
  /\btenant/i,
  /\bmigration/i,
  /\bschema\b/i,
  /\bonboarding\b/i,
  /\bseed\b/i,
  /\bjwt\b/i,
  /\bapi[- ]?key/i,
  /\btoken/i,
];

export function isGatedSurfaceTask(title: string, description: string): boolean {
  const text = `${title ?? ""}\n${description ?? ""}`;
  return GATED_SURFACE_PATTERNS.some((p) => p.test(text));
}

/**
 * Substring patterns that signal a task crosses the frontend / backend
 * boundary — adding or modifying an API endpoint AND a UI component that
 * consumes it. These tasks are high-risk for **API contract mismatch**:
 * the backend agent and frontend agent can drift into independent schemas
 * and the dashboard crashes at runtime even though both halves pass their
 * own code review (Pulsar audit 2026-04-09 — SLA widget crash, content
 * list 'variant' crash, 5 ghost reliability endpoints).
 */
const FULLSTACK_CONTRACT_PATTERNS: ReadonlyArray<RegExp> = [
  // Korean
  /API\s*(확장|추가|구현)/i,
  /엔드포인트/,
  /프론트엔드.*백엔드|백엔드.*프론트엔드/,
  /대시보드.*API|API.*대시보드/,
  /UI.*API|API.*UI/,
  // English
  /\b(add|implement|extend|new)\b.*\b(endpoint|api route|handler)\b/i,
  /\b(frontend|ui|dashboard)\b.*\b(backend|api)\b/i,
  /\b(backend|api)\b.*\b(frontend|ui|dashboard)\b/i,
  /\bschema\b.*\b(api|response|request)\b/i,
];

export function isFullStackContractTask(
  title: string,
  description: string,
): boolean {
  const text = `${title ?? ""}\n${description ?? ""}`;
  return FULLSTACK_CONTRACT_PATTERNS.some((p) => p.test(text));
}

export function isExecutionVerificationTask(title: string, description: string): boolean {
  const combined = `${title ?? ""}\n${description ?? ""}`;
  if (EXECUTION_VERIFY_PATTERNS.some((p) => p.test(combined))) return true;

  // Terminal patterns: check trimmed title AND trimmed description
  // individually so "Final QA" matches (title ends with QA) but a long
  // description containing the word "QA" in the middle does not.
  const trimmedTitle = (title ?? "").trim();
  const trimmedDesc = (description ?? "").trim();
  for (const pattern of EXECUTION_VERIFY_TERMINAL_PATTERNS) {
    if (pattern.test(trimmedTitle)) return true;
    if (pattern.test(trimmedDesc)) return true;
  }
  return false;
}

function formatDiffSection(diff: DiffSummary): string {
  if (diff.error) {
    return `## Git Diff
_Not available: ${diff.error}_

You must verify by reading files directly. Ask: "Is the task's target
location actually modified? Did the agent touch the right directory?"`;
  }

  if (diff.fileCount === 0 && diff.untracked.length === 0) {
    return `## Git Diff
**WARNING: No files changed** compared to ${diff.baseRef}. If the task was
supposed to produce code changes, this is a red flag — return \`fail\` with
a clear "no changes produced" issue.`;
  }

  const fileList = diff.files.map((f) => `- ${f}`).join("\n");
  const moreFiles = diff.fileCount > diff.files.length
    ? `\n... and ${diff.fileCount - diff.files.length} more file(s)`
    : "";
  const untrackedSection = diff.untracked.length > 0
    ? `\n### Untracked (new, uncommitted) files\n${diff.untracked.map((f) => `- ${f}`).join("\n")}`
    : "";

  return `## Git Diff (vs ${diff.baseRef}) — ${diff.fileCount} file(s) changed

### Changed files
${fileList}${moreFiles}
${untrackedSection}

### Diff stat
\`\`\`
${diff.stat ?? "(stat unavailable)"}
\`\`\`

**SCOPE CHECK — this is a REQUIRED part of your verification:**
1. Do the changed paths match where the task said to implement it?
2. If the task mentions a specific framework or directory, are changes in
   the right place? (Example failure: task says "implement Next.js dashboard
   page" but changes are in \`dashboard/*.js\` vanilla JS instead of
   \`web/src/app/page.tsx\`.)
3. If files you'd expect to be modified are NOT in the list above, flag it
   as a \`fail\` with a "scope mismatch" issue.`;
}

/**
 * 재검증 컨텍스트 + verdict 범위 정책 (pure, 테스트 대상).
 *
 * fail 이력이 있는 태스크의 재검증에서 Evaluator 에게 이전 라운드 이슈를 알려주고,
 * "기존 이슈 미해결 / 수정이 만든 회귀 / 태스크 선언 범위 내 결함"만 fail 사유로
 * 제한한다. 인접 컴포넌트의 신규 발견은 knownGaps 로 보고 — goal 최종 QA 로 이월.
 */
export function buildReverifyContext(priorFails: { issues: string; created_at: string }[]): string {
  if (priorFails.length === 0) return "";
  const rounds = priorFails.map((v, i) => {
    let items: string;
    try {
      const arr = JSON.parse(v.issues);
      items = (Array.isArray(arr) ? arr : [])
        .map((x: any) => {
          const header = `- [${x.severity ?? "?"}] ${x.file ?? ""}${x.line != null ? `:${x.line}` : ""} — ${String(x.message ?? "").slice(0, 200)}`;
          const detail = [
            x.reproCommand ? `  repro: ${String(x.reproCommand)}` : null,
            x.expectedResult ? `  expected: ${String(x.expectedResult).slice(0, 200)}` : null,
            x.actualResult ? `  actual: ${String(x.actualResult).slice(0, 200)}` : null,
          ].filter(Boolean).join("\n");
          return detail ? `${header}\n${detail}` : header;
        })
        .join("\n") || "- (no issue detail)";
    } catch {
      items = `- ${String(v.issues).slice(0, 200)}`;
    }
    return `### Previous round ${i + 1} (${v.created_at}, most recent first)\n${items}`;
  }).join("\n\n");

  return `

## Re-verification Context — READ CAREFULLY
This task already FAILED verification ${priorFails.length} time(s). Previously reported issues:

${rounds}

### Verdict policy for re-verification (STRICT — overrides general rules above)
For each previous issue that lists a \`repro\`, re-run that exact command yourself
and compare against its \`expected\`/\`actual\` before judging it fixed.
FAIL is justified ONLY by:
1. A previously-reported issue above that is still NOT fixed, or
2. A regression introduced by the fixes, or
3. A defect inside THIS task's declared scope (title / description / target files).

Discovering a NEW issue of a similar class in an ADJACENT component, screen,
or file is NOT grounds to fail this task — report such findings in
\`knownGaps\` instead (verdict pass or conditional). They will be routed to
the goal's final QA pass. Expanding the audit surface on every round makes
the task unable to ever complete; your job in re-verification is to judge
whether the previously reported problems were fixed without regression.
`;
}

function buildEvaluationPrompt(
  task: any,
  project: any,
  scope: VerificationScope,
  diff: DiffSummary,
): string {
  const methodology = createMethodologyEngine();
  const verificationProtocol = methodology.getVerificationProtocol(scope);

  // task_type — 유효하지 않은 값은 'code'로 기본 처리
  const VALID_TASK_TYPES = new Set(["code", "content", "config", "review"]);
  const rawTaskType = (task.task_type ?? "code") as string;
  const taskType = VALID_TASK_TYPES.has(rawTaskType) ? rawTaskType : "code";

  // content/config/review 태스크는 scope mismatch 검증이 불필요하므로
  // scope anchor 섹션을 포함하지 않는다 (오탐 방지)
  const isCodeTask = taskType === "code";

  // Parse scope anchoring fields (P2). These are the explicit "where should
  // this code live" hints from task decomposition — if they exist, treat
  // mismatches as hard fails.
  // code 타입이 아닌 경우에는 scope anchor check를 건너뛴다
  const targetFiles: string[] = (() => {
    if (!isCodeTask) return [];
    try {
      const parsed = JSON.parse(task.target_files ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === "string") : [];
    } catch {
      return [];
    }
  })();
  const stackHint = isCodeTask ? (task.stack_hint ?? "").trim() : "";

  // P3: Execution verification enforcement — if the task title/description
  // says "렌더링 검증", "로컬 실행", "smoke test" etc., the Evaluator must
  // NOT pass on file-reading alone. It has to actually run commands.
  const needsExecution = isExecutionVerificationTask(task.title, task.description ?? "");
  const executionGate = needsExecution
    ? `\n## Execution Verification — MANDATORY for this task\n
This task is explicitly an execution-verification task. File-reading alone
is NOT sufficient. You MUST actually run commands in the workdir and report
concrete evidence. Do ALL of the following:

1. **Detect the runtime**: check \`package.json\`, \`pyproject.toml\`,
   \`Dockerfile\`, \`docker-compose.yml\`, \`Makefile\` for the canonical
   start/test commands.
2. **Attempt a build or type-check**: run the project's build or typecheck
   command (e.g., \`pnpm build\`, \`npm run type-check\`,
   \`python -m pytest\`, \`cargo check\`). Report the exit code and the
   last ~20 lines of output.
3. **Attempt runtime startup** (if the task is about running something):
   start the dev server in a background-safe way (e.g., with a 15-second
   timeout), then \`curl\` the expected URL. Report the HTTP status and the
   first 500 bytes of the response body.
4. **If you cannot execute** (sandbox forbids it, no command runner, etc.):
   DO NOT return \`pass\`. Return \`conditional\` and add a \`knownGaps\`
   entry naming exactly which command you needed to run but couldn't.

**Hallucinating success is the worst possible outcome here.** The previous
Pulsar regression happened precisely because evaluators wrote "렌더링 정상"
without ever touching a shell. Do not repeat that.

When you DO run commands, include the command and a short transcript in
your issues[] notes so the reviewer can audit the verification trail.\n`
    : "";

  // P4: Empty State Usability — for tasks introducing gated surfaces
  // (auth, tenants, migrations, etc.), force the evaluator to ask "how does
  // the first user actually reach this?" Without this check, a complete
  // auth system can ship with empty users.yaml and no /login page and
  // still be marked done (Pulsar regression).
  const isGatedSurface = isGatedSurfaceTask(task.title, task.description ?? "");
  const entryPointGate = isGatedSurface
    ? `\n## Entry Point Completeness — MANDATORY for gated features\n
This task touches an authentication / authorisation / tenancy / migration
surface. Code existing is not the same as code being reachable. Ask
yourself EACH of these questions and answer them in your issues[] notes:

1. **Empty state**: In a fresh clone of this repo — empty database, no
   users, no API keys, no env file beyond \`.env.example\` — can a solo
   developer reach the protected feature in under 5 minutes?

2. **First account**: Who is the first user? Is there at least ONE of —
   (a) seed data / fixture creating a default admin account, OR
   (b) a self-service signup endpoint + UI wired to the default route, OR
   (c) a documented dev-bypass flag gated on env + loopback, OR
   (d) a CLI bootstrap command (\`make seed\`, \`npm run bootstrap\`, etc.)

3. **First credential**: If the feature requires API keys / JWT tokens,
   how does the first client obtain one without already being authenticated?
   "Call POST /auth/token" is NOT an answer unless you can also say WHERE
   the caller's credentials came from.

4. **Docs / discoverability**: Is the bootstrap path written down somewhere
   a new developer will actually find it (README, .env.example comments,
   scripts/, not just the PR description)?

5. **Verify against the diff**: Do the changed files actually include the
   bootstrap path you identified above? Or is it only the protected code
   with no matching entry point?

**Verdict rules for this section:**
- If the answer to #1 is "no" OR #2 has no option satisfied: return \`fail\`
  with a "missing entry point" issue naming which bootstrap mechanism is
  missing and where it should live. This is not a nice-to-have — it is
  the difference between "implemented" and "usable".
- If the feature is clearly an internal library / backend-only module with
  no end-user surface, note that explicitly in your notes and proceed.

Past incident: Pulsar shipped a complete JWT + API-Key + RBAC system with
empty \`data/auth/users.yaml\`, empty \`data/auth/api_keys.yaml\`, no
\`/login\` page, and no dev bypass. Every page load hit 401. The task was
marked done because the code existed. Do not repeat that failure mode.\n`
    : "";

  // P5: API Contract Mismatch detection — for tasks that cross the
  // frontend-backend boundary, force the evaluator to compare the
  // request/response schemas on BOTH sides. Multiple Pulsar pages
  // crashed at runtime because the backend agent and frontend agent
  // independently designed incompatible shapes for the same API.
  const isFullstackContract = isFullStackContractTask(
    task.title,
    task.description ?? "",
  );
  const contractGate = isFullstackContract
    ? `\n## API Contract Match — MANDATORY for fullstack tasks\n
This task crosses the frontend-backend boundary (introduces or modifies
an API endpoint AND a UI component that consumes it). You MUST verify
that BOTH sides speak the same schema. Incompatible schemas are the
single most common source of runtime crashes on a "completed" feature.

Do ALL of the following in your review:

1. **Locate the backend handler**: find the route definition file and
   the response model (Pydantic / marshmallow / zod / etc.). Read the
   actual returned fields and their types. Quote them verbatim in your
   notes.

2. **Locate the frontend consumer**: find the fetch call (api.ts,
   hooks/*, components/*) and the TypeScript type it casts the response
   to. Quote the expected fields.

3. **Diff the two schemas field by field**:
   - Same field names? (case sensitive — \`product_slug\` vs \`productSlug\`)
   - Same top-level wrapper? (\`{items: [...]}\` vs \`{products: [...]}\` vs bare array)
   - Same nullability? (optional on one side, required on the other is a crash)
   - Same enum values? (backend emits \`draft\`, frontend switches on \`pending\`)
   - Same units / date formats?

4. **Ghost endpoint check**: for every fetch URL the frontend issues,
   confirm the backend actually registers that exact path and method.
   A call to \`GET /api/v1/dlq/items\` is a ghost if no router defines it.

5. **Error path check**: if the fetch rejects (404, 500, schema error),
   does the UI crash or display a sensible fallback? Look for direct
   property access on possibly-undefined state (\`.length\`, \`.map()\`,
   \`.variant\` without a guard).

**Verdict rules for this section:**
- Any field name / wrapper / enum / nullability divergence → \`fail\`
  with a "contract mismatch" issue citing BOTH sides verbatim.
- Any ghost endpoint → \`fail\` with a "ghost endpoint" issue naming the
  missing route.
- Any unguarded access path that would crash on empty / undefined data
  → \`fail\` with a "runtime crash risk" issue.

Past incidents (Pulsar audit 2026-04-09):
- SLA widget: backend returned \`{items, total_products, healthy_count}\`,
  frontend expected \`{products, overall_level}\` → \`statuses.length\`
  crashed the whole /analytics page.
- Content review table: backend \`status: "draft"\`, frontend map had
  only \`pending / approved / rejected\` → \`status.variant\` undefined
  crash on the whole /content page.
- Reliability page: 5 endpoints (\`/dlq/items\`, \`/health/services\`,
  \`/health/retry-stats\`, \`/health/services/stream\`) completely absent
  from the backend router — 5 404s per page load.

All three were marked "100% complete" at task time. Do not repeat.\n`
    : "";

  let scopeAnchorSection = "";
  if (targetFiles.length > 0 || stackHint) {
    const targetBlock = targetFiles.length > 0
      ? `**Expected target files** (a *best-effort guess* made by the planner
BEFORE implementation — NOT a contract):
${targetFiles.map((f) => `- \`${f}\``).join("\n")}

**SCOPE CHECK**: these paths were guessed up front, so the real architecture
may legitimately place the same logic elsewhere (e.g. the planner guessed
\`server/x/parser.ts\` but the code correctly lives in
\`server/x/adapters/parser.ts\`). A **different path for the same
functionality is CORRECT** — do NOT fail on path drift alone, and do NOT
fail just because an expected file is absent from the diff. Only return
\`fail\` with a "scope mismatch" issue if the diff implements a
**completely different feature or wrong stack** than the task asked for
(e.g. task wants a stream parser but the diff only touches unrelated UI).`
      : "";
    const stackBlock = stackHint
      ? `**Stack constraint**: ${stackHint}

If the changed files don't match this stack (e.g., task says Next.js but
changes are vanilla HTML/CSS/JS), return \`fail\`.`
      : "";

    scopeAnchorSection = `\n## Scope Anchor — strict check\n${targetBlock}\n\n${stackBlock}\n`;
  }

  // ── task_type별 분기 프롬프트 반환 ──────────────────────────────────────
  // content / config / review 태스크는 코드 5차원 검증이 맞지 않는다.
  // 각 유형에 맞는 최소 검증 기준만 적용하여 오탐을 방지한다.

  if (taskType === "content") {
    // content: 3차원 검증 (Completeness, Consistency, Clarity)
    // scope mismatch / data flow / edge cases 제외 — 오탐 원인
    return `# Content Review — Quality Verification (Crewdeck Protocol)

Review the content deliverable for task: "${task.title}"
${task.description ? `\nTask description: ${task.description}` : ""}

## Verification Type: CONTENT
This is a content task (documentation / copywriting / i18n / copy).
Do NOT apply code-specific checks (scope mismatch, data flow, edge cases).

## Score each dimension 0-10:

1. **Completeness** — Does the content cover everything the task required?
2. **Consistency** — Is tone, terminology, and style consistent throughout?
3. **Clarity** — Is the content clear and understandable to the target audience?

## Verdict Rules (content — average 6.0+ → pass):
- **PASS**: All three dimensions average 6.0+, no critical issues
- **CONDITIONAL**: Content mostly complete but minor gaps exist
- **FAIL**: Any dimension below 4.0, or critical accuracy/completeness issue

## Output — respond ONLY with this JSON block:

\`\`\`json
{
  "verdict": "pass",
  "severity": "auto-resolve",
  "dimensionJudgements": [
    { "dimension": "functionality", "verdict": "not_applicable", "evidence": "콘텐츠 태스크 — completeness 점수로 검증" },
    { "dimension": "dataFlow", "verdict": "not_applicable", "evidence": "콘텐츠 태스크 — 데이터 흐름 없음" },
    { "dimension": "designAlignment", "verdict": "not_applicable", "evidence": "콘텐츠 태스크 — consistency 점수로 검증" },
    { "dimension": "craft", "verdict": "not_applicable", "evidence": "콘텐츠 태스크 — clarity 점수로 검증" },
    { "dimension": "edgeCases", "verdict": "not_applicable", "evidence": "콘텐츠 태스크 — 코드 경계값 없음" }
  ],
  "dimensions": {
    "functionality": { "value": 0, "notes": "N/A — content task" },
    "dataFlow": { "value": 0, "notes": "N/A — content task" },
    "designAlignment": { "value": 0, "notes": "N/A — content task" },
    "craft": { "value": 0, "notes": "N/A — content task" },
    "edgeCases": { "value": 0, "notes": "N/A — content task" },
    "completeness": { "value": 8, "notes": "..." },
    "consistency": { "value": 7, "notes": "..." },
    "clarity": { "value": 8, "notes": "..." }
  },
  "issues": [],
  "knownGaps": []
}
\`\`\`

- Dimensions \`functionality\`, \`dataFlow\`, \`designAlignment\`, \`craft\`, \`edgeCases\` must be present but set value=0 and notes="N/A — content task"
- Use \`completeness\`, \`consistency\`, \`clarity\` for the actual evaluation
- \`dimensionJudgements\`: 위 5개 항목을 정확히 한 번씩 포함
- \`issues\`: 문제 발견 시 code 출력 계약과 동일하게 dimension, severity, message,
  reproCommand, expectedResult, actualResult, fixInstruction을 모두 포함. 없으면 빈 배열
`;
  }

  if (taskType === "config") {
    // config: 2차원 검증 (Validity, Security)
    // 설정 파일 / 인프라 / CI — 코드 품질 체크 불필요
    return `# Config Review — Quality Verification (Crewdeck Protocol)

Review the configuration changes for task: "${task.title}"
${task.description ? `\nTask description: ${task.description}` : ""}

## Verification Type: CONFIG
This is a configuration task (infrastructure / environment / CI / deploy config).
Apply only Validity and Security checks.

## Score each dimension 0-10:

1. **Validity** — Is the configuration syntactically correct and functionally valid? (threshold: 8.0+)
2. **Security** — Does the configuration expose secrets, overly broad permissions, or unsafe defaults? (threshold: 8.0+)

## Verdict Rules (config — Validity ≥ 8.0 AND Security ≥ 8.0 → pass):
- **PASS**: Both Validity and Security score 8.0 or above, no critical issues
- **CONDITIONAL**: Valid config but non-critical security concern found
- **FAIL**: Validity < 8.0 (broken config), or Security < 8.0 (security risk)

## Output — respond ONLY with this JSON block:

\`\`\`json
{
  "verdict": "pass",
  "severity": "auto-resolve",
  "dimensionJudgements": [
    { "dimension": "functionality", "verdict": "not_applicable", "evidence": "설정 태스크 — validity 점수로 검증" },
    { "dimension": "dataFlow", "verdict": "not_applicable", "evidence": "설정 태스크 — 데이터 흐름 없음" },
    { "dimension": "designAlignment", "verdict": "not_applicable", "evidence": "설정 태스크 — 설정 체계 정합성은 validity에 반영" },
    { "dimension": "craft", "verdict": "not_applicable", "evidence": "설정 태스크 — security 점수로 검증" },
    { "dimension": "edgeCases", "verdict": "not_applicable", "evidence": "설정 태스크 — validity 점수로 검증" }
  ],
  "dimensions": {
    "functionality": { "value": 0, "notes": "N/A — config task" },
    "dataFlow": { "value": 0, "notes": "N/A — config task" },
    "designAlignment": { "value": 0, "notes": "N/A — config task" },
    "craft": { "value": 0, "notes": "N/A — config task" },
    "edgeCases": { "value": 0, "notes": "N/A — config task" },
    "validity": { "value": 9, "notes": "..." },
    "security": { "value": 8, "notes": "..." }
  },
  "issues": [],
  "knownGaps": []
}
\`\`\`

- Dimensions \`functionality\`, \`dataFlow\`, \`designAlignment\`, \`craft\`, \`edgeCases\` must be present but set value=0 and notes="N/A — config task"
- Use \`validity\` and \`security\` for the actual evaluation
- \`dimensionJudgements\`: 위 5개 항목을 정확히 한 번씩 포함
- \`issues\`: 문제 발견 시 code 출력 계약과 동일하게 dimension, severity, message,
  reproCommand, expectedResult, actualResult, fixInstruction을 모두 포함. 없으면 빈 배열
`;
  }

  if (taskType === "review") {
    // review: 실행 결과 기반 pass/fail — LLM 추론 최소화
    // QA / smoke test / integration test 등 실행 결과를 직접 확인해야 하는 태스크
    return `# Execution Review — Quality Verification (Crewdeck Protocol)

Review the execution results for task: "${task.title}"
${task.description ? `\nTask description: ${task.description}` : ""}

${formatDiffSection(diff)}
${executionGate}

## Verification Type: REVIEW (Execution-based)
This is an execution-verification task. Your verdict is based SOLELY on
whether the execution succeeded — NOT on code quality metrics.

## Verdict Rules (review — execution success → pass):
- **PASS**: Commands executed successfully, all expected outputs confirmed
- **CONDITIONAL**: Could not execute (sandbox limitation) — list what needs manual verification
- **FAIL**: Execution failed, unexpected error, or critical runtime issue found

Do NOT score code quality dimensions. Set all dimension values to 0 with "N/A — review task".

## Output — respond ONLY with this JSON block:

\`\`\`json
{
  "verdict": "pass",
  "severity": "auto-resolve",
  "dimensionJudgements": [
    { "dimension": "functionality", "verdict": "pass", "evidence": "실행 명령과 성공 결과" },
    { "dimension": "dataFlow", "verdict": "not_applicable", "evidence": "실행 검증 태스크 — 별도 데이터 흐름 없음" },
    { "dimension": "designAlignment", "verdict": "not_applicable", "evidence": "실행 검증 태스크 — 설계 리뷰 대상 아님" },
    { "dimension": "craft", "verdict": "not_applicable", "evidence": "실행 검증 태스크 — 코드 품질 리뷰 대상 아님" },
    { "dimension": "edgeCases", "verdict": "not_applicable", "evidence": "실행 검증 태스크 — 지정된 실행 시나리오로 검증" }
  ],
  "dimensions": {
    "functionality": { "value": 0, "notes": "N/A — review task, see execution results" },
    "dataFlow": { "value": 0, "notes": "N/A — review task" },
    "designAlignment": { "value": 0, "notes": "N/A — review task" },
    "craft": { "value": 0, "notes": "N/A — review task" },
    "edgeCases": { "value": 0, "notes": "N/A — review task" }
  },
  "issues": [],
  "knownGaps": []
}
\`\`\`

- Set all dimension values to 0 with notes="N/A — review task"
- \`dimensionJudgements\`: 위 5개 항목을 정확히 한 번씩 포함
- \`issues\`: 실행 실패 발견 시 dimension, severity, message, reproCommand,
  expectedResult, actualResult, fixInstruction을 모두 포함. 없으면 빈 배열
- \`knownGaps\`: commands you needed to run but couldn't execute
`;
  }

  // ── code (기본): 기존 5차원 검증 유지 ─────────────────────────────────
  return `# Code Review — Quality Verification (Crewdeck Protocol)

Review the code changes for task: "${task.title}"
${task.description ? `\nTask description: ${task.description}` : ""}

${formatDiffSection(diff)}
${scopeAnchorSection}${entryPointGate}${contractGate}${executionGate}

## Verification Scope: ${scope.toUpperCase()}

${verificationProtocol || `Scope: ${scope} — Evaluate code quality, correctness, and safety.`}

## Evaluator Stance
"통과시키지 마라. 문제를 찾아라." — Do not rubber-stamp. Find problems.
Code existing is not the same as code working.

## What to check (report real problems as issues — NO scoring):

- **Functionality** — does it do what the task asked for?
- **Data Flow** — Input → Save → Load → Display complete?
- **Design Alignment** — follows existing codebase patterns?
- **Craft & Edge Cases** — error handling, type safety, boundary values (0, negative, empty, max)?

## Verdict Rules:
- **PASS**: All layers for this scope completed, no critical/high issues, AND scope check passed
- **CONDITIONAL**: Code looks correct but Layer 3 (execution) could not be verified → MUST list Known Gaps
- **FAIL**: ANY of the following →
  - Critical or high severity issue found
  - Functionality broken or security/data-loss risk
  - **Scope mismatch — the agent changed the wrong files or created code in the wrong directory/stack**
  - **No files changed when the task required code changes** (check the diff section above)
  - **Gated feature with no entry point — protected code shipped without seed, bypass, signup, or bootstrap** (see Entry Point Completeness section above)
  - **API contract mismatch — frontend type / fetch wrapper / enum does not match backend response schema** (see API Contract Match section)
  - **Ghost endpoint — frontend fetches a URL that no backend router actually registers** (see API Contract Match section)
  - **Runtime crash risk — unguarded property access on possibly-undefined state that would crash on empty data**

${scope === "full" ? `
## CRITICAL: Layer 3 Execution Rule
If you CANNOT execute Layer 3 (no DB, no runtime, no test runner):
- Do NOT return "pass"
- Return "conditional" with Known Gaps listing what needs manual verification
- Example issue: "Layer 3 미수행 — API 서버 기동 후 curl 테스트 필요"
` : ""}

## Output — respond ONLY with this JSON block:

\`\`\`json
{
  "verdict": "pass",
  "severity": "auto-resolve",
  "dimensionJudgements": [
    { "dimension": "functionality", "verdict": "pass", "evidence": "요구 동작 확인 명령/관찰 결과" },
    { "dimension": "dataFlow", "verdict": "pass", "evidence": "Input → Save → Load → Display 확인 결과" },
    { "dimension": "designAlignment", "verdict": "pass", "evidence": "기존 아키텍처 패턴 대조 결과" },
    { "dimension": "craft", "verdict": "pass", "evidence": "타입·오류 처리 검토 결과" },
    { "dimension": "edgeCases", "verdict": "pass", "evidence": "빈 값·경계값 재현 결과" }
  ],
  "issues": [
    {
      "dimension": "functionality",
      "severity": "critical",
      "file": "path/to/file.ts",
      "line": 42,
      "message": "무엇이 왜 잘못됐는지 구체 서술. REQUIRED. 절대 비우지 말 것.",
      "reproCommand": "재현 방법 — 실행한 명령 또는 UI 클릭 경로. 비워두지 말 것.",
      "expectedResult": "기대한 결과",
      "actualResult": "실제 관찰한 결과",
      "fixInstruction": "무엇을 어떻게 고치면 해결되는지 — auto-fix 에이전트가 그대로 읽는다. 비워두지 말 것.",
      "suggestion": "선택 — fixInstruction 요약"
    }
  ],
  "knownGaps": []
}
\`\`\`

- \`verdict\`: "pass" | "conditional" | "fail"
- \`severity\`: "auto-resolve" (minor), "soft-block" (runtime risk), "hard-block" (security/data loss)
- \`dimensionJudgements\`: 5차원(functionality·dataFlow·designAlignment·craft·edgeCases) 각각의
  판정. \`verdict\`는 "pass" | "fail" | "not_applicable", \`evidence\`는 비어있으면 안 된다.
- \`issues\`: only list actual problems found, empty array if none. 각 이슈는 아래
  구조화 필드를 반드시 채운다 — **누락·빈 값·잘못된 enum 은 판정 오류(evaluator_error)로
  거부되어 재검증된다**:
  - \`dimension\`: 위 5차원 중 하나
  - \`severity\`: "critical" | "high" | "warning" | "info"
  - \`reproCommand\`: 재현 명령/경로 — **비우지 말 것** (빈 재현 명령은 거부됨)
  - \`fixInstruction\`: 구체적 수정 지시 — **비우지 말 것** (auto-fix 에이전트가 그대로 읽는다)
  - \`message\`/\`expectedResult\`/\`actualResult\`: 문제·기대·실제를 구체적으로 서술
  **Write in Korean** (기술 용어·식별자·파일 경로는 원문 유지) — dashboard 에 그대로 노출된다.
- \`knownGaps\`: areas that could not be verified (Layer 3 not executed, etc.)
`;
}

// ─── Structured evaluation contract ──────────────────────────────────────
// Quality Gate 판정·수정 루프 구조화: evaluator 가 실패 항목을 fix 태스크로
// 변환할 수 있도록 구조화 필드(dimension·severity·재현 명령·수정 지시)를 강제한다.
// 필드 누락·잘못된 enum·빈 재현 명령은 판정으로 신뢰하지 않고 evaluator_error 로
// 거부한다 — 잘못된 구조의 출력이 거짓 pass/fail 로 흘러가는 것을 막는다.
const QG_DIMENSION_NAMES = ["functionality", "dataFlow", "designAlignment", "craft", "edgeCases"] as const;
const QG_DIMENSIONS = new Set<string>(QG_DIMENSION_NAMES);
const QG_ISSUE_SEVERITIES = new Set<string>(["critical", "high", "warning", "info"]);
const QG_DIMENSION_VERDICTS = new Set<string>(["pass", "fail", "not_applicable"]);
const QG_VERDICTS = new Set<string>(["pass", "conditional", "fail"]);
const QG_SEVERITIES = new Set<string>(["auto-resolve", "soft-block", "hard-block"]);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const pickField = (o: any, ...keys: string[]): unknown => {
  for (const k of keys) if (o != null && o[k] !== undefined) return o[k];
  return undefined;
};

export interface StructuredEvaluationValidation {
  /** The Quality Gate always requires the structured contract. */
  structured: boolean;
  ok: boolean;
  errors: string[];
}

/**
 * Evaluator 구조화 출력 계약 검사 (pure — 테스트 대상).
 *
 * 레거시/부분 출력도 판정으로 받아들이지 않는다. 모든 응답은 정확히 5개 차원
 * 판정과 각 issue의 재현·기대·실제·수정 지시를 제공해야 한다.
 */
export function validateStructuredEvaluation(parsed: any): StructuredEvaluationValidation {
  const errors: string[] = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { structured: true, ok: false, errors: ["evaluation must be an object"] };
  }

  const verdict = pickField(parsed, "verdict");
  if (!QG_VERDICTS.has(verdict as string)) errors.push(`verdict invalid enum: ${JSON.stringify(verdict)}`);
  const severity = pickField(parsed, "severity");
  if (!QG_SEVERITIES.has(severity as string)) errors.push(`severity invalid enum: ${JSON.stringify(severity)}`);

  const rawIssues: any[] = Array.isArray(parsed.issues) ? parsed.issues : [];
  if (!Array.isArray(parsed.issues)) errors.push("issues missing/not array");
  const judgementsRaw = parsed?.dimensionJudgements ?? parsed?.dimension_judgements;
  const judgements: any[] = Array.isArray(judgementsRaw) ? judgementsRaw : [];
  if (!Array.isArray(judgementsRaw)) errors.push("dimensionJudgements missing/not array");
  if (judgements.length !== QG_DIMENSION_NAMES.length) {
    errors.push(`dimensionJudgements must contain exactly ${QG_DIMENSION_NAMES.length} items`);
  }

  const seenDimensions = new Set<string>();
  judgements.forEach((j, i) => {
    const dim = pickField(j, "dimension");
    if (!QG_DIMENSIONS.has(dim as string)) errors.push(`dimensionJudgements[${i}].dimension invalid enum: ${JSON.stringify(dim)}`);
    else if (seenDimensions.has(dim as string)) errors.push(`dimensionJudgements[${i}].dimension duplicate: ${JSON.stringify(dim)}`);
    else seenDimensions.add(dim as string);
    const v = pickField(j, "verdict");
    if (!QG_DIMENSION_VERDICTS.has(v as string)) errors.push(`dimensionJudgements[${i}].verdict invalid enum: ${JSON.stringify(v)}`);
    if (!isNonEmptyString(pickField(j, "evidence"))) errors.push(`dimensionJudgements[${i}].evidence missing/empty`);
  });
  for (const dimension of QG_DIMENSION_NAMES) {
    if (!seenDimensions.has(dimension)) errors.push(`dimensionJudgements missing dimension: ${dimension}`);
  }

  rawIssues.forEach((it, i) => {
    if (it === null || typeof it !== "object" || Array.isArray(it)) {
      errors.push(`issues[${i}] must be an object`);
      return;
    }
    const dim = pickField(it, "dimension");
    if (!QG_DIMENSIONS.has(dim as string)) errors.push(`issues[${i}].dimension invalid enum: ${JSON.stringify(dim)}`);
    const sev = pickField(it, "severity");
    if (!QG_ISSUE_SEVERITIES.has(sev as string)) errors.push(`issues[${i}].severity invalid enum: ${JSON.stringify(sev)}`);
    if (!isNonEmptyString(pickField(it, "message"))) errors.push(`issues[${i}].message missing/empty`);
    if (!isNonEmptyString(pickField(it, "reproCommand", "repro_command", "repro"))) errors.push(`issues[${i}].reproCommand missing/empty`);
    if (!isNonEmptyString(pickField(it, "expectedResult", "expected_result"))) errors.push(`issues[${i}].expectedResult missing/empty`);
    if (!isNonEmptyString(pickField(it, "actualResult", "actual_result"))) errors.push(`issues[${i}].actualResult missing/empty`);
    if (!isNonEmptyString(pickField(it, "fixInstruction", "fix_instruction"))) errors.push(`issues[${i}].fixInstruction missing/empty`);
  });

  // verdict과 issues는 서로를 증명해야 한다 — pass인데 critical/high issue가 남아있거나,
  // fail인데 fix 루프가 실행할 repro가 하나도 없는 상태는 둘 다 신뢰할 수 없는 판정이다.
  if (verdict === "pass" && rawIssues.some((it) => {
    const sev = pickField(it, "severity");
    return sev === "critical" || sev === "high";
  })) {
    errors.push("verdict pass invalid with a critical or high severity issue present");
  }
  if (verdict === "fail" && rawIssues.length === 0) {
    errors.push("verdict fail requires at least one issue");
  }

  return { structured: true, ok: errors.length === 0, errors };
}

export function parseVerificationResult(
  taskId: string,
  rawOutput: string,
  scope: VerificationScope,
  evaluatorSessionId: string,
  taskType: string = "code",
): VerificationResult {
  const defaultScore: Score = { value: 0, notes: "Evaluation failed — could not parse result" };
  const parseErrorIssue: VerificationIssue = {
    id: "issue-parse-error",
    severity: "high",
    message: "Evaluation parse error — the evaluator did not return valid JSON",
    suggestion: "Re-run verification to get a proper evaluation result",
  };
  const defaultResult: VerificationResult = {
    id: "",
    taskId,
    verdict: "fail" as Verdict,
    scope,
    dimensions: {
      functionality: defaultScore,
      dataFlow: defaultScore,
      designAlignment: defaultScore,
      craft: defaultScore,
      edgeCases: defaultScore,
    },
    issues: [parseErrorIssue],
    severity: "soft-block" as Severity,
    evaluatorSessionId,
    terminationReason: "evaluator_error",
    createdAt: new Date().toISOString(),
  };

  try {
    // Extract JSON from the output (shared, provider-agnostic extractor).
    const jsonStr = extractJsonBlock(rawOutput);
    if (jsonStr === null) {
      log.warn("Could not parse verification JSON, returning fail");
      return defaultResult;
    }

    const parsed = JSON.parse(jsonStr);

    // 구조화 계약 위반은 어떤 verdict도 신뢰하지 않고 evaluator_error로 거부한다.
    const structuredValidation = validateStructuredEvaluation(parsed);
    if (!structuredValidation.ok) {
      log.warn("Structured evaluation rejected — evaluator_error", structuredValidation.errors);
      return {
        ...defaultResult,
        issues: [{
          id: "issue-evaluator-error",
          severity: "high",
          message: `Evaluator 구조화 출력 계약 위반 — ${structuredValidation.errors.slice(0, 8).join("; ")}`,
          suggestion: "5개 dimensionJudgements와 각 issue의 필수 구조화 필드를 모두 채워 다시 출력하세요.",
        }],
      };
    }

    const dimensionJudgements = (parsed.dimensionJudgements ?? parsed.dimension_judgements).map((judgement: any) => ({
      dimension: judgement.dimension as QualityGateDimension,
      verdict: judgement.verdict as DimensionVerdict,
      evidence: String(judgement.evidence).trim(),
    }));
    const scoreFor = (dimension: QualityGateDimension): Score => {
      const judgement = dimensionJudgements.find((item: { dimension: QualityGateDimension }) => item.dimension === dimension)!;
      return {
        value: judgement.verdict === "pass" ? 10 : 0,
        notes: judgement.evidence,
      };
    };

    const dimensions = {
      functionality: scoreFor("functionality"),
      dataFlow: scoreFor("dataFlow"),
      designAlignment: scoreFor("designAlignment"),
      craft: scoreFor("craft"),
      edgeCases: scoreFor("edgeCases"),
    };

    // Trust the evaluator agent's verdict — do NOT override based on score averages.
    // The evaluator may FAIL a task with high dimension scores if it found a critical
    // issue (e.g., security vulnerability) that doesn't map neatly to any dimension.
    // Overriding FAIL→PASS based on avg score was a Critical bug (Crewdeck gap analysis).
    let verdict = parsed.verdict as Verdict;

    // ── task_type별 임계값 검사 ────────────────────────────────────────────
    // 에이전트가 반환한 verdict를 기반으로 하되, 유형별 최소 임계값 미달 시
    // fail로 강제 전환한다. pass→fail 방향만 허용 (fail→pass 금지).
    let thresholdIssue: VerificationIssue | null = null;
    if (taskType === "content" && verdict === "pass") {
      // content: Completeness, Consistency, Clarity 평균 6.0+ 필요
      const completeness = (parsed.dimensions?.completeness?.value ?? 0) as number;
      const consistency = (parsed.dimensions?.consistency?.value ?? 0) as number;
      const clarity = (parsed.dimensions?.clarity?.value ?? 0) as number;
      const contentAvg = (completeness + consistency + clarity) / 3;
      if (contentAvg < 6.0) {
        verdict = "fail";
        thresholdIssue = {
          id: "issue-content-threshold",
          dimension: "craft",
          severity: "high",
          message: `콘텐츠 품질 점수 평균이 통과 임계값에 미달했습니다 (${contentAvg.toFixed(1)} < 6.0).`,
          reproCommand: `Crewdeck Quality Gate 재검증: task=${taskId}, type=content`,
          expectedResult: "completeness, consistency, clarity 평균이 6.0 이상",
          actualResult: `completeness=${completeness}, consistency=${consistency}, clarity=${clarity}, average=${contentAvg.toFixed(1)}`,
          fixInstruction: "평균 6.0 미만을 만든 completeness, consistency, clarity 항목의 지적을 보완한 뒤 동일 Quality Gate를 재실행합니다.",
          suggestion: "임계값 미달 차원의 콘텐츠를 보완하세요.",
        };
        log.info(`content task 임계값 미달 (avg=${contentAvg.toFixed(1)} < 6.0) → fail 전환`);
      }
    } else if (taskType === "config" && verdict === "pass") {
      // config: Validity ≥ 8.0 AND Security ≥ 8.0 필요
      const validity = (parsed.dimensions?.validity?.value ?? 0) as number;
      const security = (parsed.dimensions?.security?.value ?? 0) as number;
      if (validity < 8.0 || security < 8.0) {
        verdict = "fail";
        thresholdIssue = {
          id: "issue-config-threshold",
          dimension: validity < 8.0 ? "functionality" : "craft",
          severity: "high",
          message: `설정 품질 점수가 통과 임계값에 미달했습니다 (validity=${validity}, security=${security}; 각 8.0 이상 필요).`,
          reproCommand: `Crewdeck Quality Gate 재검증: task=${taskId}, type=config`,
          expectedResult: "validity와 security가 모두 8.0 이상",
          actualResult: `validity=${validity}, security=${security}`,
          fixInstruction: "8.0 미만인 validity 또는 security 항목의 설정 결함을 보완한 뒤 동일 Quality Gate를 재실행합니다.",
          suggestion: "임계값 미달 설정 항목을 보완하세요.",
        };
        log.info(`config task 임계값 미달 (validity=${validity}, security=${security}) → fail 전환`);
      }
    }
    // review 타입은 에이전트의 실행 결과 verdict를 그대로 신뢰 (별도 임계값 없음)
    // code 타입은 에이전트의 verdict를 그대로 신뢰 (기존 동작 유지)

    const issues: VerificationIssue[] = parsed.issues.map((issue: any, i: number) => ({
      id: `issue-${i}`,
      dimension: issue.dimension as QualityGateDimension,
      severity: issue.severity as IssueSeverity,
      file: issue.file,
      line: issue.line,
      message: issue.message.trim(),
      reproCommand: String(pickField(issue, "reproCommand", "repro_command", "repro")).trim(),
      expectedResult: String(pickField(issue, "expectedResult", "expected_result")).trim(),
      actualResult: String(pickField(issue, "actualResult", "actual_result")).trim(),
      fixInstruction: String(pickField(issue, "fixInstruction", "fix_instruction")).trim(),
      suggestion: issue.suggestion ?? issue.fixInstruction ?? issue.fix_instruction,
    }));
    if (thresholdIssue) issues.push(thresholdIssue);

    // Also correct severity based on actual issues
    const hasCritical = issues.some((i: any) => i.severity === "critical");
    const severity: Severity = hasCritical ? "hard-block" : normalizeSeverity(parsed.severity, verdict);

    // 통과·중단·수동 승인 이유 추적: evaluator 가 스스로 판정할 수 있는 사유만
    // 기록한다. auto_fix_disabled/fix_round_limit/escalated_to_goal_qa 는 engine 소관.
    let terminationReason: VerificationTerminationReason | null = null;
    if (verdict === "pass") terminationReason = "passed";
    else if (verdict === "conditional") terminationReason = "conditional";
    else if (severity === "hard-block") terminationReason = "hard_blocked";

    return {
      ...defaultResult,
      verdict,
      severity,
      dimensions,
      dimensionJudgements,
      issues,
      terminationReason,
    };
  } catch (err) {
    log.warn("Failed to parse verification result", err);
    return defaultResult;
  }
}
