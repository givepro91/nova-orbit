// Shared constants across server modules

// --- Agent roles ---
export const VALID_ROLES = [
  "coder", "reviewer", "marketer", "designer", "qa", "custom",
  "cto", "pm", "backend", "frontend", "ux", "devops",
] as const;

// --- Text limits ---
export const MAX_TITLE_LEN = 200;
export const MAX_DESC_LEN = 2000;
export const MAX_PROMPT_LEN = 50_000;
export const MAX_SUMMARY_LEN = 500;
export const MAX_TASKS_PER_GOAL = 10;

// --- Scheduler ---
// Poll interval when idle (no work). Executor loop uses a short 100ms follow-up
// after task completion, so this only affects the "waiting for new work" path.
// 1s provides snappier response for manual task additions without significant load.
export const POLL_INTERVAL_MS = parseInt(process.env.CREWDECK_POLL_INTERVAL_MS ?? "1000", 10);
export const BACKOFF_BASE_MS = parseInt(process.env.CREWDECK_BACKOFF_BASE_MS ?? "60000", 10);
export const BACKOFF_MAX_MS = parseInt(process.env.CREWDECK_BACKOFF_MAX_MS ?? "300000", 10);
export const MAX_CONSECUTIVE_RATE_LIMITS = parseInt(process.env.CREWDECK_MAX_RATE_LIMITS ?? "3", 10);
/** Long cooldown after hitting MAX_CONSECUTIVE_RATE_LIMITS. Previously the
 *  queue fully stopped here and a human had to resume manually. Now it
 *  sleeps for this duration and retries once, so overnight / long-running
 *  autopilot sessions self-heal as soon as the API budget replenishes. */
export const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.CREWDECK_RATE_LIMIT_COOLDOWN_MS ?? "900000", 10); // 15 min
// 동시 실행 태스크 상한 = 동시에 진행되는 goal 수 상한 (goal 간 병렬).
// goal "내부"는 항상 순차 1 — 같은 goal 의 태스크를 병렬로 돌리면 선행 출력이
// 반영되기 전에 후행이 출발해 맥락 엇갈림/false-positive 를 만든다 (품질 > wall-clock).
// goal 간에는 worktree 격리로 독립성이 구조적으로 보장되므로 병렬이 안전하다.
export const DEFAULT_MAX_CONCURRENCY = parseInt(process.env.CREWDECK_MAX_CONCURRENCY ?? "2", 10);

// --- Agent execution ---
export const TASK_TIMEOUT_MS = parseInt(process.env.CREWDECK_TASK_TIMEOUT_MS ?? "600000", 10); // 10 min default
export const RATE_LIMIT_WAIT_MS = parseInt(process.env.CREWDECK_RATE_LIMIT_WAIT_MS ?? "60000", 10);
export const SIGKILL_TIMEOUT_MS = 5000;

// --- Agent model defaults ---
// Opus for planning/architecture roles, Sonnet for implementation/review.
// null = use Claude Code CLI default (user's account setting).
// Agents can override via the `model` column in the DB.
export const ROLE_DEFAULT_MODEL: Record<string, string | null> = {
  cto: "opus",
  pm: "opus",
  backend: "sonnet",
  frontend: "sonnet",
  devops: "sonnet",
  qa: "sonnet",
  reviewer: "sonnet",
  ux: "sonnet",
  marketer: "sonnet",
  coder: "sonnet",
  designer: "sonnet",
  custom: null, // user decides
};

// --- Task retry ---
export const MAX_TASK_RETRIES = parseInt(process.env.CREWDECK_MAX_TASK_RETRIES ?? "2", 10);
export const MAX_REASSIGNS = parseInt(process.env.CREWDECK_MAX_REASSIGNS ?? "1", 10); // max agent switches per task
// 태스크당 검증 fail 라운드 상한 — 도달 시 blocked 대신 완료 처리 + 미해결 이슈를
// goal 최종 QA로 이월 (verification-policy.ts). Evaluator 범위 확장 무한 검토 방지.
export const MAX_VERIFY_FAIL_ROUNDS = parseInt(process.env.CREWDECK_MAX_VERIFY_FAIL_ROUNDS ?? "3", 10);
// auto-fix 반복 상한 — verify FAIL 시 통과할 때까지 fix→재검증을 반복하는 최대 라운드.
// 완료가 목적: 넉넉히 돌린다. scope-creep(인시던트 근본원인)은 verdict 범위 정책 + 실패이력
// 주입으로 이미 차단돼 라운드를 늘려도 스핀이 아니라 수렴. 라운드마다 provider 교차(codex↔claude).
export const MAX_FIX_ROUNDS = parseInt(process.env.CREWDECK_MAX_FIX_ROUNDS ?? "6", 10);
// auto-fix 스톨 상한 — fix→재검증에서 이슈 셋(severity|file|line)이 연속 N라운드 동일하면
// (= fix 가 그 이슈를 못 없앰: 외부 blocker·수렴 불가) MAX_FIX_ROUNDS 다 돌기 전 조기 종료 후 escalate.
// 이슈가 라운드마다 옮겨다니면(진짜 진전) 카운터가 리셋돼 안 걸린다 → false-bail 0. 0/1 이면 사실상 비활성.
export const MAX_NO_PROGRESS_ROUNDS = parseInt(process.env.CREWDECK_MAX_NO_PROGRESS_ROUNDS ?? "2", 10);
// 검증당 생성 fix task 상한 — 한 검증이 이슈를 대량으로 뱉어도 goal 태스크 목록이
// 무제한으로 불어나지 않게 severity 우선 top-N만 fix task 로 만든다(무한 아님, 무제한
// fan-out 차단). MAX_TASKS_PER_GOAL 은 decompose 에만 걸리고 fix 생성엔 안 걸리는 갭 보완.
export const MAX_FIX_TASKS_PER_VERIFICATION = parseInt(process.env.CREWDECK_MAX_FIX_TASKS_PER_VERIFICATION ?? "5", 10);
export const BLOCKED_RETRY_DELAY_MS = parseInt(process.env.CREWDECK_BLOCKED_RETRY_DELAY_MS ?? "10000", 10); // 10s cooldown

/** 진행 중 태스크가 이 시간(분) 넘게 변화 없으면 정체 신호로 올린다. */
export const STALLED_TASK_MINUTES = parseInt(process.env.CREWDECK_STALLED_TASK_MINUTES ?? "60", 10);
