import type { Database } from "better-sqlite3";
import type { SessionManager } from "../agent/session.js";
import { parseStreamJson } from "../agent/adapters/stream-parser.js";
import { createLogger } from "../../utils/logger.js";
import { MAX_TITLE_LEN, MAX_DESC_LEN } from "../../utils/constants.js";

const log = createLogger("delegation");

const MAX_SUBTASKS = 5;
const MAX_DELEGATION_DEPTH = 1;

interface AgentRow {
  id: string;
  name: string;
  role: string;
  parent_id: string | null;
}

interface TaskRow {
  id: string;
  goal_id: string;
  project_id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  parent_task_id: string | null;
  status: string;
}

export interface DelegationResult {
  delegated: boolean;
  subtaskIds: string[];
}

/**
 * Hierarchical Delegation Engine.
 *
 * When a task is assigned to an agent that has subordinates (children),
 * the agent decomposes the task into subtasks and delegates to children.
 *
 * Safety:
 * - Max 5 subtasks per delegation
 * - Max 1 level of delegation depth (prevents infinite recursion)
 * - Delegation failure → fallback to direct execution
 * - Subtask failure → parent task blocked
 */
function updateGoalProgress(db: Database, goalId: string): void {
  // Atomic UPDATE with clamping — see tasks.ts/engine.ts for identical logic.
  db.prepare(`
    UPDATE goals SET progress = (
      SELECT
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE MAX(0, MIN(100, CAST(ROUND(100.0 * SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) / COUNT(*)) AS INTEGER)))
        END
      FROM tasks WHERE goal_id = ? AND parent_task_id IS NULL
    )
    WHERE id = ?
  `).run(goalId, goalId);
}

/**
 * Lightweight QualityGate interface — accepts any object with a compatible verify().
 * Using a structural type avoids a circular import with quality-gate/evaluator.
 */
interface ParentVerifier {
  verify: (taskId: string, config?: { workdir?: string; scope?: any }) => Promise<{ verdict: string; severity?: string; issues?: unknown[] }>;
}

export function createDelegationEngine(
  db: Database,
  sessionManager: SessionManager,
  broadcast: (event: string, data: unknown) => void,
  parentVerifier?: ParentVerifier,
) {
  return {
    /**
     * Attempt to delegate a task to the assignee's subordinates.
     * Returns { delegated: false } if no subordinates or delegation not appropriate.
     */
    async attemptDelegation(taskId: string): Promise<DelegationResult> {
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (!task.assignee_id) return { delegated: false, subtaskIds: [] };

      // Guard: don't delegate subtasks (prevent recursion)
      if (task.parent_task_id !== null) {
        return { delegated: false, subtaskIds: [] };
      }

      // Guard: don't re-delegate if subtasks already exist (prevents duplicate creation
      // when parent is reset to todo by stale-task recovery or retry logic)
      const existingSubtasks = db.prepare(
        "SELECT COUNT(*) as count FROM tasks WHERE parent_task_id = ?",
      ).get(taskId) as { count: number };
      if (existingSubtasks.count > 0) {
        const nonTerminal = db.prepare(
          "SELECT COUNT(*) as count FROM tasks WHERE parent_task_id = ? AND status IN ('todo', 'pending_approval', 'in_progress', 'in_review')",
        ).get(taskId) as { count: number };

        if (nonTerminal.count > 0) {
          log.info(`Task ${taskId} already has ${existingSubtasks.count} subtasks (${nonTerminal.count} active) — skipping re-delegation, waiting`);
          // Re-mark parent as in_progress so subtask completion flow works
          db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND status = 'todo'").run(taskId);
          return { delegated: true, subtaskIds: [] };
        }

        // 하위 작업이 전부 종결됐는데 부모가 다시 실행됐다 = 마지막 하위 작업 완료
        // 시점의 checkParentCompletion 을 놓친 상태 (당시 부모가 todo 로 리셋돼 CAS
        // 불발 등). 완료 신호는 다시 오지 않으므로 여기서 직접 완료 흐름을 밟는다.
        // 방치하면 "대기 → 30분 뒤 ghost 복구(todo) → 재픽 → 대기" 무한 루프 (07-08 실측).
        //
        // 단, 직전 검증이 이미 fail 이면 검증을 반복하지 않는다 — 그 사이 아무도
        // 코드를 고치지 않았으므로 같은 실패가 예산 소진까지 반복된다 (08:20 실측:
        // fail 10초 뒤 재픽 → 동일 검증 재실행). 위임하지 않고 부모가 직접 수정
        // 패스를 실행하게 한다 — Smart Resume 이 실패 이력을 프롬프트에 주입한다.
        const latestVerdict = db.prepare(
          "SELECT verdict FROM verifications WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
        ).get(taskId) as { verdict: string } | undefined;

        if (latestVerdict?.verdict === "fail") {
          log.info(`Task ${taskId}: subtasks terminal but latest verification failed — running parent fix pass directly (no re-verify-only loop)`);
          return { delegated: false, subtaskIds: [] };
        }

        log.info(`Task ${taskId}: all ${existingSubtasks.count} subtasks terminal — running parent completion now`);
        db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND status = 'todo'").run(taskId);
        await this.checkParentCompletion(taskId);
        return { delegated: true, subtaskIds: [] };
      }

      // Check delegation depth — count parent chain
      let depth = 0;
      let current: string | null = task.parent_task_id;
      while (current) {
        depth++;
        if (depth > MAX_DELEGATION_DEPTH) {
          log.warn(`Delegation depth exceeded for task ${taskId}, executing directly`);
          return { delegated: false, subtaskIds: [] };
        }
        const parent = db.prepare("SELECT parent_task_id FROM tasks WHERE id = ?").get(current) as { parent_task_id: string | null } | undefined;
        current = parent?.parent_task_id ?? null;
      }

      // Find subordinates of the assignee
      const subordinates = db.prepare(
        "SELECT * FROM agents WHERE parent_id = ? AND project_id = (SELECT project_id FROM agents WHERE id = ?)",
      ).all(task.assignee_id, task.assignee_id) as AgentRow[];

      if (subordinates.length === 0) {
        return { delegated: false, subtaskIds: [] };
      }

      log.info(`Attempting delegation for task "${task.title}" — ${subordinates.length} subordinates available`);

      // Ask the parent agent to decompose the task for its team
      const parentAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assignee_id) as AgentRow | undefined;
      if (!parentAgent) return { delegated: false, subtaskIds: [] };

      const project = db.prepare("SELECT workdir FROM projects WHERE id = ?").get(task.project_id) as { workdir: string } | undefined;
      const workdir = project?.workdir || process.cwd();

      let session;
      try {
        session = sessionManager.spawnAgent(parentAgent.id, workdir);
      } catch (err: any) {
        log.error(`Failed to spawn agent for delegation: ${err.message}`);
        return { delegated: false, subtaskIds: [] };
      }

      const subordinateList = subordinates.map((s) => `- ${s.name} (${s.role})`).join("\n");

      const prompt = `
# Task Delegation

You are "${parentAgent.name}" (${parentAgent.role}). You need to delegate the following task to your team members.

**Task:** ${task.title}
**Description:** ${task.description}

**Your team:**
${subordinateList}

Rules:
- Break the task into at most ${MAX_SUBTASKS} subtasks
- Each subtask must be assignable to one of your team members
- Specify which team member should handle each subtask by their role
- Keep subtasks focused and concrete

Respond in this EXACT JSON format:
\`\`\`json
{
  "subtasks": [
    {
      "title": "Subtask title",
      "description": "What to do",
      "role": "team member's role"
    }
  ]
}
\`\`\`
`;

      try {
        const result = await session.send(prompt);
        const parsed = parseStreamJson(result.stdout);

        const jsonMatch = parsed.text.match(/```json\s*([\s\S]*?)\s*```/);
        if (!jsonMatch) {
          log.warn("No JSON in delegation response, falling back to direct execution");
          return { delegated: false, subtaskIds: [] };
        }

        const data = JSON.parse(jsonMatch[1]);
        const subtasks = (data.subtasks ?? []).slice(0, MAX_SUBTASKS);

        if (subtasks.length === 0) {
          return { delegated: false, subtaskIds: [] };
        }

        // Create subtasks and assign to subordinates
        const findSubordinate = (role: string) =>
          subordinates.find((s) => s.role === role) ??
          subordinates[0]; // fallback to first subordinate

        const subtaskIds: string[] = [];

        for (const st of subtasks) {
          if (!st.title || typeof st.title !== "string") continue;
          const assignee = findSubordinate(st.role ?? subordinates[0].role);
          const row = db.prepare(`
            INSERT INTO tasks (goal_id, project_id, title, description, assignee_id, parent_task_id)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING id
          `).get(
            task.goal_id,
            task.project_id,
            st.title.slice(0, MAX_TITLE_LEN),
            (st.description ?? "").slice(0, MAX_DESC_LEN),
            assignee.id,
            taskId,
          ) as { id: string };
          subtaskIds.push(row.id);
        }

        log.info(`Delegated task "${task.title}" into ${subtaskIds.length} subtasks`);

        // Mark parent task as in_progress (subtasks will drive completion)
        db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?").run(taskId);

        broadcast("task:delegated", {
          taskId,
          parentAgentId: parentAgent.id,
          parentAgentName: parentAgent.name,
          subtaskCount: subtaskIds.length,
          subtaskIds,
        });
        broadcast("project:updated", { projectId: task.project_id });

        db.prepare(
          "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'task_delegated', ?)",
        ).run(task.project_id, parentAgent.id, `${parentAgent.name} delegated "${task.title}" into ${subtaskIds.length} subtasks`);

        return { delegated: true, subtaskIds };
      } catch (err: any) {
        log.error(`Delegation failed for task "${task.title}": ${err.message}`);
        // Fallback: execute directly without delegation
        return { delegated: false, subtaskIds: [] };
      } finally {
        // Only reset agent if session was actually spawned
        // (spawnAgent failure returns early before this try block)
        if (session) {
          sessionManager.killSession(parentAgent.id);
          db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(parentAgent.id);
          broadcast("agent:status", { id: parentAgent.id, name: parentAgent.name, status: "idle" });
        }
      }
    },

    /**
     * Check if all subtasks of a parent task are done.
     * If so, verify the parent via Quality Gate (when a verifier is provided)
     * and transition to done/blocked based on the verdict.
     * If any subtask is blocked, mark parent as blocked immediately.
     *
     * Callers invoke this fire-and-forget; errors are caught and logged internally.
     */
    async checkParentCompletion(parentTaskId: string): Promise<void> {
      const subtasks = db.prepare(
        "SELECT status FROM tasks WHERE parent_task_id = ?",
      ).all(parentTaskId) as { status: string }[];

      if (subtasks.length === 0) return;

      const allDone = subtasks.every((s) => s.status === "done");
      const anyBlocked = subtasks.some((s) => s.status === "blocked");
      const allFinished = subtasks.every((s) => s.status === "done" || s.status === "blocked");

      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parentTaskId) as TaskRow;
      if (!task) return;

      if (allDone) {
        // CAS guard: atomically transition parent to in_review. Prevents duplicate
        // verification when multiple subtasks finish concurrently — only the first
        // caller wins the CAS. 'todo' 도 허용: ghost 복구/재시도 분류가 부모를 todo 로
        // 되돌린 채 마지막 하위 작업이 완료되면, in_progress 한정 CAS 는 불발되고
        // 완료 신호가 영영 다시 오지 않는다 (07-08 실측 — 30분 ghost 루프의 시작점).
        const cas = db.prepare(
          "UPDATE tasks SET status = 'in_review', updated_at = datetime('now') WHERE id = ? AND status IN ('in_progress', 'todo')",
        ).run(parentTaskId);
        if (cas.changes === 0) return; // already transitioned by concurrent caller

        broadcast("task:updated", { ...task, status: "in_review" });

        if (!parentVerifier) {
          // No verifier wired in — fall back to immediate done (legacy behavior)
          db.prepare("UPDATE tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?")
            .run(parentTaskId);
          broadcast("task:updated", { ...task, status: "done" });
          updateGoalProgress(db, task.goal_id);
          log.info(`Parent task ${parentTaskId} completed (no verifier) — all subtasks done`);
          return;
        }

        // Run Quality Gate verification on the aggregated subtask changes
        try {
          log.info(`Parent task ${parentTaskId}: all subtasks done, running verification`);
          const verification = await parentVerifier.verify(parentTaskId, {});
          broadcast("verification:result", verification);

          const passed = verification.verdict === "pass" || verification.verdict === "conditional";
          const finalStatus = passed ? "done" : "blocked";
          db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?")
            .run(finalStatus, parentTaskId);
          broadcast("task:updated", { ...task, status: finalStatus });

          if (passed) {
            updateGoalProgress(db, task.goal_id);
            log.info(`Parent task ${parentTaskId} verified PASS`);
          } else {
            log.warn(`Parent task ${parentTaskId} verification FAILED (${verification.verdict})`);
            db.prepare(
              "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'verification_fail', ?)"
            ).run(task.project_id, task.assignee_id, `Parent task blocked after verification: ${task.title}`);
          }
        } catch (verifyErr: any) {
          log.error(`Parent verification crashed for ${parentTaskId}: ${verifyErr.message}`);
          // Revert to done so we don't lose the subtask work — flag for manual review
          db.prepare("UPDATE tasks SET status = 'done', updated_at = datetime('now') WHERE id = ?")
            .run(parentTaskId);
          broadcast("task:updated", { ...task, status: "done" });
          updateGoalProgress(db, task.goal_id);
          db.prepare(
            "INSERT INTO activities (project_id, agent_id, type, message) VALUES (?, ?, 'verification_error', ?)"
          ).run(task.project_id, task.assignee_id, `Parent verification error (marked done): ${task.title} — ${verifyErr.message?.slice(0, 160)}`);
        }
      } else if (anyBlocked && allFinished) {
        // Only block parent when all subtasks have finished (some done, some blocked)
        db.prepare("UPDATE tasks SET status = 'blocked', updated_at = datetime('now') WHERE id = ?")
          .run(parentTaskId);
        broadcast("task:updated", { ...task, status: "blocked" });
        log.warn(`Parent task ${parentTaskId} blocked — subtask(s) failed`);
      }
      // else: subtasks still in progress/in_review — do nothing, wait for next check
    },
  };
}
