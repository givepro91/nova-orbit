import type { Database } from "better-sqlite3";
import { spawnSync } from "node:child_process";
import type { SessionManager } from "../agent/session.js";
import { parseStreamJson } from "../agent/adapters/stream-parser.js";
import { createLogger } from "../../utils/logger.js";
import { createNovaRulesEngine } from "../nova-rules/index.js";
import type { VerificationResult, VerificationScope, Verdict, Severity, Score, VerificationIssue } from "../../../shared/types.js";

const log = createLogger("quality-gate");

export interface QualityGateConfig {
  scope: VerificationScope;
  maxRetries: number;
}

const DEFAULT_CONFIG: QualityGateConfig = {
  scope: "standard",
  maxRetries: 1,
};

/**
 * Nova Quality Gate — Generator-Evaluator Separation
 *
 * Core principle: The agent that implements (Generator) and the agent that
 * verifies (Evaluator) are ALWAYS different sessions. This prevents the
 * "marking your own homework" anti-pattern.
 *
 * 5-Dimension Verification (ported from Nova):
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

      // Build evaluation prompt
      const evaluationPrompt = buildEvaluationPrompt(task, project, opts.scope, diffSummary);

      // Spawn independent Evaluator session (NOT the Generator session)
      // This is the core Generator-Evaluator separation.
      // Per-task sessionKey lets multiple verifications run concurrently on the
      // same evaluator agent without aborting each other (spawnAgent cleanup
      // only affects the same sessionKey).
      const evaluatorId = `evaluator-${taskId}`;

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
          "INSERT OR IGNORE INTO agents (project_id, name, role, system_prompt) VALUES (?, '[Nova] Evaluator', 'reviewer', ?)",
        ).run(task.project_id, "You are a code reviewer with an adversarial mindset. Find problems, don't pass them.");
        evaluatorAgent = db.prepare(
          "SELECT * FROM agents WHERE project_id = ? AND name = '[Nova] Evaluator' LIMIT 1",
        ).get(task.project_id) as any;
      }

      try {
        const evalWorkdir = config.workdir || project.workdir || (() => { throw new Error("Project has no workdir configured"); })();
        const session = sessionManager.spawnAgent(
          evaluatorAgent.id,
          evalWorkdir,
          evaluatorId,
        );

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

        const runResult = await session.send(evaluationPrompt);
        const parsed = parseStreamJson(runResult.stdout);
        // task_type을 전달하여 유형별 임계값 판정에 활용
        const taskType = (task.task_type ?? "code") as string;
        let result = parseVerificationResult(taskId, parsed.text, opts.scope, evaluatorId, taskType);

        // Retry once if parse failed (all dimensions score 0)
        const allZero = Object.values(result.dimensions).every((d) => d.value === 0);
        if (allZero && result.verdict === "fail") {
          log.info("Parse failed, retrying with explicit JSON reminder...");
          const retryPrompt = `이전 응답에서 JSON을 파싱하지 못했습니다. 반드시 \`\`\`json 블록으로만 응답하세요.\n\n${evaluationPrompt}`;
          const retryResult = await session.send(retryPrompt);
          const retryParsed = parseStreamJson(retryResult.stdout);
          result = parseVerificationResult(taskId, retryParsed.text, opts.scope, evaluatorId, taskType);

          // If still all zeros after retry — evaluator genuinely can't assess this task
          // (e.g., git merge/cleanup tasks with no code changes to review)
          // Treat as conditional pass rather than blocking the task
          const stillAllZero = Object.values(result.dimensions).every((d) => d.value === 0);
          if (stillAllZero && result.verdict === "fail") {
            log.warn(`Evaluator returned all-zero scores after retry for "${task.title}" — treating as conditional pass (likely non-code task)`);
            result.verdict = "conditional";
            result.severity = "auto-resolve";
            result.issues = [{
              id: "issue-parse-skip",
              severity: "info" as any,
              message: "Evaluator could not assess this task (no reviewable code changes). Auto-passed as conditional.",
            }];
          }
        }

        // Store result with RETURNING to avoid race-prone re-query
        const verRow = db.prepare(`
          INSERT INTO verifications (task_id, verdict, scope, dimensions, issues, severity, evaluator_session_id)
          VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
        `).get(
          taskId,
          result.verdict,
          result.scope,
          JSON.stringify(result.dimensions),
          JSON.stringify(result.issues),
          result.severity,
          evaluatorId,
        ) as { id: string };

        // Link verification to task
        db.prepare("UPDATE tasks SET verification_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(verRow.id, taskId);

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
 * Aligns with Nova §1: high-risk areas auto-escalate one level.
 */
export function autoDetectScope(
  task: { title: string; description: string },
  changedFileCount?: number,
): VerificationScope {
  const text = `${task.title} ${task.description}`.toLowerCase();

  // Execution-verification tasks ALWAYS use full scope — they need Layer 3
  // to trigger the "you must actually run commands" rule.
  if (isExecutionVerificationTask(task.title, task.description)) return "full";

  // High-risk patterns always escalate (Nova §1: auth/DB/payment → one level up)
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
export const TOOL_STATE_PATHS = [".omc", ".playwright-mcp", ".cc-shots", ".nova-worktrees"];
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

function buildEvaluationPrompt(
  task: any,
  project: any,
  scope: VerificationScope,
  diff: DiffSummary,
): string {
  const novaRules = createNovaRulesEngine();
  const verificationProtocol = novaRules.getVerificationProtocol(scope);

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
      ? `**Expected target files** (the task says these should be modified):
${targetFiles.map((f) => `- \`${f}\``).join("\n")}

**REQUIRED CHECK**: cross-reference this list with the Git Diff above. If
ANY expected file is missing from the diff, OR if the diff contains files in
a completely different tree (e.g., expected \`web/src/app/page.tsx\` but
diff shows \`dashboard/app.js\`), return \`fail\` with a clear
"scope mismatch" issue message.`
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
    return `# Content Review — Quality Verification (Nova Protocol)

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
- \`issues\`: only list actual problems found, empty array if none
`;
  }

  if (taskType === "config") {
    // config: 2차원 검증 (Validity, Security)
    // 설정 파일 / 인프라 / CI — 코드 품질 체크 불필요
    return `# Config Review — Quality Verification (Nova Protocol)

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
- \`issues\`: only list actual problems found, empty array if none
`;
  }

  if (taskType === "review") {
    // review: 실행 결과 기반 pass/fail — LLM 추론 최소화
    // QA / smoke test / integration test 등 실행 결과를 직접 확인해야 하는 태스크
    return `# Execution Review — Quality Verification (Nova Protocol)

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
- \`issues\`: only list execution failures found
- \`knownGaps\`: commands you needed to run but couldn't execute
`;
  }

  // ── code (기본): 기존 5차원 검증 유지 ─────────────────────────────────
  return `# Code Review — Quality Verification (Nova Protocol)

Review the code changes for task: "${task.title}"
${task.description ? `\nTask description: ${task.description}` : ""}

${formatDiffSection(diff)}
${scopeAnchorSection}${entryPointGate}${contractGate}${executionGate}

## Verification Scope: ${scope.toUpperCase()}

${verificationProtocol || `Scope: ${scope} — Evaluate code quality, correctness, and safety.`}

## Evaluator Stance
"통과시키지 마라. 문제를 찾아라." — Do not rubber-stamp. Find problems.
Code existing is not the same as code working.

## Score each dimension 0-10:

1. **Functionality** — Does it do what the task asked for?
2. **Data Flow** — Input → Save → Load → Display complete?
3. **Design Alignment** — Does it follow existing codebase patterns?
4. **Craft** — Error handling, type safety, edge cases?
5. **Edge Cases** — Boundary values (0, negative, empty, max) safe?

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
  "dimensions": {
    "functionality": { "value": 8, "notes": "..." },
    "dataFlow": { "value": 7, "notes": "..." },
    "designAlignment": { "value": 8, "notes": "..." },
    "craft": { "value": 7, "notes": "..." },
    "edgeCases": { "value": 6, "notes": "..." }
  },
  "issues": [
    {
      "severity": "critical",
      "file": "path/to/file.py",
      "line": 42,
      "message": "Concrete description of the problem — what is wrong and why it breaks. REQUIRED. Never omit or leave blank. The auto-fix agent reads this verbatim.",
      "suggestion": "Concrete fix guidance — what code change resolves it. REQUIRED for critical/hard-block."
    }
  ],
  "knownGaps": []
}
\`\`\`

- \`verdict\`: "pass" | "conditional" | "fail"
- \`severity\`: "auto-resolve" (minor), "soft-block" (runtime risk), "hard-block" (security/data loss)
- \`issues\`: only list actual problems found, empty array if none.
  **CRITICAL: every issue MUST have a non-empty \`message\` field.** An issue
  without a message is useless — the auto-fix loop cannot act on it and the
  task will get stuck retrying. If you cannot describe the problem concretely,
  do not file the issue.
  **Write \`message\` and \`suggestion\` in Korean** (기술 용어·식별자·파일 경로는
  원문 유지) — these are shown directly to the user in the dashboard.
- \`knownGaps\`: areas that could not be verified (Layer 3 not executed, etc.)
`;
}

function parseVerificationResult(
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
    createdAt: new Date().toISOString(),
  };

  try {
    // Extract JSON from the output
    const jsonMatch = rawOutput.match(/```json\s*([\s\S]*?)\s*```/) ??
                      rawOutput.match(/\{[\s\S]*"verdict"[\s\S]*\}/);

    if (!jsonMatch) {
      log.warn("Could not parse verification JSON, returning fail");
      return defaultResult;
    }

    const jsonStr = jsonMatch[1] ?? jsonMatch[0];
    const parsed = JSON.parse(jsonStr);

    const dimensions = {
      functionality: parsed.dimensions?.functionality ?? defaultScore,
      dataFlow: parsed.dimensions?.dataFlow ?? defaultScore,
      designAlignment: parsed.dimensions?.designAlignment ?? defaultScore,
      craft: parsed.dimensions?.craft ?? defaultScore,
      edgeCases: parsed.dimensions?.edgeCases ?? defaultScore,
    };

    // Trust the evaluator agent's verdict — do NOT override based on score averages.
    // The evaluator may FAIL a task with high dimension scores if it found a critical
    // issue (e.g., security vulnerability) that doesn't map neatly to any dimension.
    // Overriding FAIL→PASS based on avg score was a Critical bug (Nova gap analysis).
    const VALID_VERDICTS = new Set(["pass", "conditional", "fail"]);
    const rawVerdict = String(parsed.verdict ?? "fail").toLowerCase().trim();
    let verdict: Verdict = VALID_VERDICTS.has(rawVerdict) ? (rawVerdict as Verdict) : "fail";

    // ── task_type별 임계값 검사 ────────────────────────────────────────────
    // 에이전트가 반환한 verdict를 기반으로 하되, 유형별 최소 임계값 미달 시
    // fail로 강제 전환한다. pass→fail 방향만 허용 (fail→pass 금지).
    if (taskType === "content" && verdict === "pass") {
      // content: Completeness, Consistency, Clarity 평균 6.0+ 필요
      const completeness = (parsed.dimensions?.completeness?.value ?? 0) as number;
      const consistency = (parsed.dimensions?.consistency?.value ?? 0) as number;
      const clarity = (parsed.dimensions?.clarity?.value ?? 0) as number;
      const contentAvg = (completeness + consistency + clarity) / 3;
      if (contentAvg < 6.0) {
        verdict = "fail";
        log.info(`content task 임계값 미달 (avg=${contentAvg.toFixed(1)} < 6.0) → fail 전환`);
      }
    } else if (taskType === "config" && verdict === "pass") {
      // config: Validity ≥ 8.0 AND Security ≥ 8.0 필요
      const validity = (parsed.dimensions?.validity?.value ?? 0) as number;
      const security = (parsed.dimensions?.security?.value ?? 0) as number;
      if (validity < 8.0 || security < 8.0) {
        verdict = "fail";
        log.info(`config task 임계값 미달 (validity=${validity}, security=${security}) → fail 전환`);
      }
    }
    // review 타입은 에이전트의 실행 결과 verdict를 그대로 신뢰 (별도 임계값 없음)
    // code 타입은 에이전트의 verdict를 그대로 신뢰 (기존 동작 유지)

    // Resolve message across known field name variants. Different evaluator
    // runs have returned the payload under `message`, `description`, `detail`,
    // `text`, `issue`, or `title` — accept any of them so the auto-fix loop
    // receives a concrete problem statement instead of "No description".
    const pickMessage = (issue: any): string => {
      const candidates = [
        issue.message,
        issue.description,
        issue.detail,
        issue.text,
        issue.issue,
        issue.title,
        issue.reason,
        issue.problem,
      ];
      for (const c of candidates) {
        if (typeof c === "string" && c.trim()) return c;
      }
      return "No description";
    };

    const issues = (parsed.issues ?? []).map((issue: any, i: number) => ({
      id: `issue-${i}`,
      severity: issue.severity ?? "warning",
      file: issue.file,
      line: issue.line,
      message: pickMessage(issue),
      suggestion: issue.suggestion ?? issue.fix ?? issue.recommendation,
    }));

    // Also correct severity based on actual issues
    const hasCritical = issues.some((i: any) => i.severity === "critical");
    const severity: Severity = hasCritical ? "hard-block" : (parsed.severity ?? "auto-resolve");

    return {
      ...defaultResult,
      verdict,
      severity,
      dimensions,
      issues,
    };
  } catch (err) {
    log.warn("Failed to parse verification result", err);
    return defaultResult;
  }
}
