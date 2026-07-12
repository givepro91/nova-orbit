/**
 * 소환(⚡) 컨텍스트 조립 — 실패/이월 task를 손볼 때 그 goal의 상태(기획서·worktree·
 * 최근 판정·최근 출력)를 채팅 세션 spawn 시 시스템 프롬프트에 주입하고, "무엇을 넣었는지"
 * 를 프론트 주입됨 스트립용 칩으로 함께 만든다.
 *
 * session.ts(preamble 주입)와 orchestration.ts chat 핸들러(chips broadcast)가 같은 소스를
 * 쓰도록 순수 함수로 격리한다. taskId가 없거나 없는 항목은 조용히 스킵.
 */
import type Database from "better-sqlite3";
import { formatExecutionSpecContext, getTaskExecutionSpec } from "../goal-spec/spec-approval.js";

export type SummonTone = "pass" | "conditional" | "fail" | "neutral";
export interface SummonChip {
  label: string;
  detail?: string;
  tone: SummonTone;
}
export interface SummonContext {
  /** 시스템 프롬프트에 이어붙일 마크다운 블록 (없으면 ""). */
  preamble: string;
  /** 주입됨 스트립용 칩 (없으면 []). */
  chips: SummonChip[];
}

/** verdict 문자열을 칩 tone으로 정규화 (DB CHECK: pass|conditional|fail). */
function verdictTone(verdict: string): SummonTone {
  if (verdict === "pass" || verdict === "conditional" || verdict === "fail") return verdict;
  return "neutral";
}

/**
 * taskId 기준으로 소환 컨텍스트를 조립한다. task→goal 역참조로 goal 스코프를 읽는다.
 * HTTP 경유 없이 동일 DB 핸들 직접 조회(저렴, 소환은 드문 액션).
 */
export function buildSummonContext(
  db: Database.Database,
  taskId: string | null | undefined,
  options: { includeLastOutput?: boolean } = {},
): SummonContext {
  if (!taskId) return { preamble: "", chips: [] };
  const task = db
    .prepare("SELECT id, goal_id, title, verification_id FROM tasks WHERE id = ?")
    .get(taskId) as { id: string; goal_id: string | null; title: string; verification_id: string | null } | undefined;
  if (!task) return { preamble: "", chips: [] };

  const parts: string[] = [];
  const chips: SummonChip[] = [];

  // 기획서(spec) + worktree — goal 스코프
  if (task.goal_id) {
    const executionSpec = getTaskExecutionSpec(db, task.id);
    if (executionSpec) {
      parts.push(formatExecutionSpecContext(executionSpec).trim());
      chips.push({ label: "기획서", tone: "neutral" });
    } else {
      const legacySpec = db
        .prepare("SELECT prd_summary FROM goal_specs WHERE goal_id = ?")
        .get(task.goal_id) as { prd_summary: string | null } | undefined;
      if (legacySpec?.prd_summary) {
        parts.push(`### 기획서 요약\n${legacySpec.prd_summary}`);
        chips.push({ label: "기획서", tone: "neutral" });
      }
    }

    const goal = db
      .prepare("SELECT title, worktree_path, worktree_branch FROM goals WHERE id = ?")
      .get(task.goal_id) as { title: string; worktree_path: string | null; worktree_branch: string | null } | undefined;
    if (goal?.worktree_path) {
      parts.push(`### 작업 공간(worktree)\n${goal.worktree_path}${goal.worktree_branch ? ` (branch: ${goal.worktree_branch})` : ""}`);
      chips.push({ label: "작업 공간", detail: goal.worktree_branch ?? undefined, tone: "neutral" });
    }
  }

  // 최근 판정 — task.verification_id (evaluator.verify()가 항상 최신으로 갱신)
  if (task.verification_id) {
    const v = db
      .prepare("SELECT verdict, severity, issues FROM verifications WHERE id = ?")
      .get(task.verification_id) as { verdict: string | null; severity: string | null; issues: string | null } | undefined;
    if (v?.verdict) {
      const issuesText = v.issues ? `\n이슈: ${String(v.issues).slice(0, 1500)}` : "";
      parts.push(`### 최근 판정\nverdict=${v.verdict}${v.severity ? ` severity=${v.severity}` : ""}${issuesText}`);
      chips.push({ label: "판정", detail: v.verdict, tone: verdictTone(v.verdict) });
    }
  }

  // 최근 출력 — 이 task의 마지막 세션 last_output 끝부분
  if (options.includeLastOutput !== false) {
    const lastOut = db
      .prepare(
        "SELECT last_output FROM sessions WHERE task_id = ? AND last_output IS NOT NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(taskId) as { last_output: string | null } | undefined;
    if (lastOut?.last_output) {
      const snippet = String(lastOut.last_output).slice(-2000);
      parts.push(`### 최근 출력(끝부분)\n${snippet}`);
      chips.push({ label: "최근 출력", tone: "neutral" });
    }
  }

  const preamble = parts.length
    ? `\n\n## 소환 컨텍스트 — 이 태스크를 손보는 중: "${task.title}"\n\n${parts.join("\n\n")}\n\n---\n`
    : "";
  return { preamble, chips };
}
