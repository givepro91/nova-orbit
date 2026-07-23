import type { AgentProvider } from "./types.js";

export const TERMINAL_AGENT_PROMPT = `Crewdeck lifecycle is mandatory for every user request that may change files or run verification in this terminal.

Before using file-editing or shell tools:
1. Call crewdeck_get_context.
2. When context.sessionBinding.active_task_id exists, that exact Goal·Agent·Task binding is authoritative for this terminal conversation. Work only on that task. Otherwise use context.activeGoal/context.activeTasks or create one non-duplicate goal.
3. Mark an unstarted task in_progress with crewdeck_update_task before working. A task claimed by the Workspace may already be in_progress.

Keep Crewdeck synchronized while you work. After implementation, inspect the resulting files or diff, run appropriate verification, and move the active task to in_review with a concise summary naming changed files and checks. Stop there: you never move a task to done yourself. Crewdeck's Quality Gate runs as a separate reviewer session and is the only thing that promotes in_review to done — the bridge rejects the attempt if you try, so do not retry it. Your transition is todo -> in_progress -> in_review; never skip a phase.

This terminal is bound to one task and agent. When the bound task reaches done, STOP — do not auto-advance to another task in this same conversation. Never claim a task assigned to a different agent, and never verify or review work you implemented; those must run as a separate agent/session (Crewdeck keeps implementation and review separate). Report the remaining tasks and let the user start the next one from Crewdeck, which launches it in its assigned agent's own terminal. If work cannot continue, mark the active task blocked with one concrete question for the user and wait in this same terminal conversation. When the user answers, call crewdeck_record_decision with their resolution before continuing; Crewdeck records the decision and resumes the task.

Do not edit files before a Crewdeck task is in_progress, do not create duplicate goals, and do not claim completion while any task for this objective remains unfinished. Crewdeck is coordination and evidence state; the local Workspace is the source of code changes. Never commit, push, merge, deploy, or perform destructive operations unless the user explicitly requests it.`;

/**
 * 태스크 착수 시 provider CLI에 넘기는 첫 user turn. CLI를 그냥 띄우기만 하면
 * idle 프롬프트에서 멈춰 아무 일도 안 하므로(에이전트는 첫 메시지 없이는 스스로
 * 시작하지 않는다), 이 프롬프트를 positional 인자로 넘겨 CLI가 기동 즉시 소비하게 한다.
 * 상세 lifecycle 계약은 이미 시스템 프롬프트(TERMINAL_AGENT_PROMPT)에 있으므로 짧게 유지한다.
 */
export const TERMINAL_TASK_KICKOFF = "Start the Crewdeck task bound to this terminal: call crewdeck_get_context to read the active Goal/Task/Agent binding, then begin that task.";

/**
 * 프롬프트에서 대기 중인(오류·연결 끊김으로 멈춘) CLI에 주입하는 "이어서 계속" 넛지.
 * 새 대화를 시작하는 게 아니라 직전 작업을 중단 지점부터 잇게 한다 — 화면잠금/네트워크
 * 끊김으로 스트림이 끊긴 뒤 사람이 손으로 "계속"을 쳐 넣던 복구를 그대로 자동화한다.
 */
export const TERMINAL_RESUME_NUDGE = "이전 작업이 오류나 연결 끊김으로 중단됐습니다. 새 작업을 시작하지 말고, crewdeck_get_context로 이 터미널에 바인딩된 태스크를 확인한 뒤 중단 지점부터 이어서 계속하세요. 완료되면 변경 파일과 검증을 요약해 in_review로 넘기세요.";

/**
 * 터미널에서 provider CLI를 띄울 때 붙이는 권한 플래그.
 *
 * 터미널 실행에서 사람은 '보고 개입할 수 있는' 관찰자이지 권한 프롬프트를 답해줘야 하는
 * 당번이 아니다. 플래그가 없으면 kickoff이 첫 파일 쓰기에서 승인 대기로 멈춰, 사람이
 * 터미널을 보고 있지 않는 한 goal 전체가 정지한다. 헤드리스 어댑터와 같은 태세를 쓴다 —
 * 안전 경계는 권한 프롬프트가 아니라 goal 단위 worktree 격리다.
 */
export function providerLaunchFlags(provider: AgentProvider): string {
  return provider === "codex"
    ? "--dangerously-bypass-approvals-and-sandbox"
    : "--permission-mode bypassPermissions";
}
