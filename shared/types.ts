// Crewdeck — Shared Type Definitions

// ─── Project ───────────────────────────────────────────

export type ProjectSource = "new" | "local_import" | "github";
export type ProjectStatus = "active" | "archived" | "paused";
export type AutopilotMode = "off" | "goal" | "full";

export interface Project {
  id: string;
  name: string;
  mission: string;
  source: ProjectSource;
  workdir: string;
  github?: GitHubConfig;
  techStack?: TechStack;
  status: ProjectStatus;
  autopilot: AutopilotMode;
  createdAt: string;
  updatedAt: string;
}

// auto: 승인 시점에 base 직접 push 가능 여부를 판정 — 가능하면 반영(main_direct),
//       불가(권한없음/branch protection/네트워크)하면 PR 자동 폴백.
export type GitMode = "branch_only" | "pr" | "main_direct" | "local_only" | "auto";

/** goal squash 이후 실제로 벌어진 반영 형태 (squash_status='merged'와 별개 축). */
export type MergeOutcome = "applied" | "pr_open" | "local";

/** pr_open 이후 GitHub에서 조회한 실제 PR 상태. */
export type PrState = "open" | "merged" | "closed";

export interface GitHubConfig {
  repoUrl: string;
  branch: string;
  autoPush: boolean;
  prMode: boolean;
  /** Explicit git workflow mode. Takes precedence over autoPush/prMode when set. */
  gitMode?: GitMode;
}

export interface TechStack {
  languages: string[];
  frameworks: string[];
  buildTool?: string;
  testFramework?: string;
  packageManager?: string;
}

// ─── Workspace ─────────────────────────────────────────

export type WorkspaceKind = "goal" | "manual";
export type WorkspaceState = "pending" | "ready" | "error" | "archived";

export interface Workspace {
  id: string;
  projectId: string;
  goalId: string | null;
  activeGoalId: string | null;
  name: string;
  kind: WorkspaceKind;
  state: WorkspaceState;
  worktreePath: string | null;
  worktreeBranch: string | null;
  baseRef: string;
  setupStep: string | null;
  setupProgress: number;
  error: { code: string; message: string } | null;
  pathExists: boolean | null;
  dirty: boolean | null;
  sessionCount: number;
  activeSessionCount: number;
  terminalSessionCount: number;
  activeTerminalSessionCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export type TerminalSessionStatus = "active" | "exited" | "killed" | "interrupted" | "error";

export interface TerminalSession {
  id: string;
  tabNumber: number;
  workspaceId: string;
  projectId: string;
  shell: string;
  cwd: string;
  pid: number | null;
  cols: number;
  rows: number;
  status: TerminalSessionStatus;
  exitCode: number | null;
  output: string;
  startedAt: string;
  endedAt: string | null;
  backend: "pty" | "tmux";
  contextState: "connected" | "mismatch" | "unknown";
  goalId: string | null;
  goalTitle: string | null;
  agentId: string | null;
  agentName: string | null;
  agentRole: string | null;
  activeTaskId: string | null;
  activeTaskTitle: string | null;
  activeTaskStatus: TaskStatus | null;
  provider: AgentProvider | null;
}

export interface TerminalDecision {
  id: string;
  workspaceId: string;
  terminalSessionId: string;
  goalId: string | null;
  taskId: string | null;
  agentId: string | null;
  message: string;
  createdAt: string;
}

export type TerminalActivityKind =
  | "task_claimed"
  | "provider_launch_requested"
  | "provider_started"
  | "command_finished"
  | "file_changed"
  | "verification_run"
  | "blocked"
  | "decision_recorded"
  | "completion_requested"
  | "quality_gate_result";

export interface TerminalActivity {
  id: string;
  idempotencyKey: string;
  workspaceId: string;
  terminalSessionId: string;
  projectId: string;
  goalId: string | null;
  taskId: string | null;
  agentId: string | null;
  provider: AgentProvider | null;
  kind: TerminalActivityKind;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type TerminalReviewStatus =
  | "pending"
  | "running"
  | "passed"
  | "fix_required"
  | "conditional"
  | "error"
  | "timeout";

export interface TerminalReviewEvidence {
  summary: string;
  changedFiles: string[];
  verificationCommands: string[];
}

export interface TerminalReviewRequest {
  id: string;
  workspaceId: string;
  terminalSessionId: string;
  goalId: string;
  taskId: string;
  agentId: string | null;
  status: TerminalReviewStatus;
  scope: VerificationScope;
  evidence: TerminalReviewEvidence;
  attempt: number;
  verificationId: string | null;
  findings: VerificationIssue[];
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalBridgeTaskInput {
  title: string;
  description?: string;
  assigneeId?: string;
  assignee?: string;
}

export interface TerminalBridgeGoalInput {
  workspaceId: string;
  terminalSessionId: string;
  clientRequestId: string;
  title: string;
  description?: string;
  priority?: Priority;
  tasks?: TerminalBridgeTaskInput[];
}

export interface TerminalBridgeGoalResult {
  goal: Record<string, unknown>;
  tasks: Array<Record<string, unknown>>;
  workspaceId: string | null;
  replayed: boolean;
}

export interface TerminalBridgeEvidence {
  dirty: boolean | null;
  changedFiles: string[];
  diffStat: string;
}

export interface TerminalBridgeActivity {
  id: string;
  workspaceId: string;
  terminalSessionId: string | null;
  kind: "goal_created" | "task_created" | "task_updated";
  goalId: string | null;
  goalTitle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  status: TaskStatus | null;
  summary: string | null;
  evidence: TerminalBridgeEvidence | null;
  createdAt: string;
}

// ─── Agent ─────────────────────────────────────────────

export type AgentRole =
  | "coder"
  | "reviewer"
  | "marketer"
  | "designer"
  | "qa"
  | "custom";

export type SessionStatus =
  | "idle"
  | "working"
  | "waiting_approval"
  | "paused"
  | "terminated";

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  role: AgentRole;
  status: SessionStatus;
  systemPrompt: string;
  currentTaskId: string | null;
  createdAt: string;
}

export interface AgentConfig {
  name: string;
  role: AgentRole;
  systemPrompt: string;
  workdir: string;
  skillsDir?: string;
  sessionBehavior: "resume-or-new" | "new";
}

export type AgentProvider = "claude" | "codex";
export type ProviderResolutionSource = "agent" | "project" | "global";
export type ProviderFailoverReasonCode = "rate_limit" | "session_exhausted" | "env_error";

export interface ProviderFailoverTrace {
  reasonCode: ProviderFailoverReasonCode | null;
  userMessage: string | null;
  fromProvider: AgentProvider | null;
  toProvider: AgentProvider | null;
  redispatched: boolean;
  loopGuardBlocked: boolean;
  originalSessionId: string | null;
  redispatchedSessionId: string | null;
}

export interface ProviderTrace {
  resolvedProvider: AgentProvider;
  resolutionSource: ProviderResolutionSource;
  failover: ProviderFailoverTrace;
}

export type ProviderActivityResolutionSource = ProviderResolutionSource | "failover";

export interface ProviderResolvedEventPayload {
  projectId: string;
  taskId: string;
  agentId: string | null;
  taskTitle: string;
  resolvedProvider: AgentProvider;
  resolutionSource: ProviderResolutionSource;
  failoverOverride: boolean;
  userMessage: string;
}

export interface ProviderFailoverEventPayload {
  projectId: string;
  taskId: string;
  agentId: string | null;
  taskTitle: string;
  sessionId: string | null;
  reasonCode: ProviderFailoverReasonCode;
  userMessage: string;
  fromProvider: AgentProvider;
  toProvider: AgentProvider;
  redispatched: boolean;
  loopGuardBlocked: boolean;
}

export interface ProviderRedispatchEventPayload {
  projectId: string;
  taskId: string;
  agentId: string | null;
  taskTitle: string;
  reasonCode: ProviderFailoverReasonCode | null;
  fromProvider: AgentProvider | null;
  toProvider: AgentProvider;
  redispatched: boolean;
  originalSessionId: string | null;
  redispatchedSessionId: string | null;
  userMessage: string;
}

export interface ActivityLogEntry {
  id: number;
  project_id: string;
  projectId: string;
  agent_id: string | null;
  agentId: string | null;
  type: string;
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  createdAt: string;
}

export type RecoveryPhase = "implementation" | "verification" | "fix" | "approval";
export type RecoveryDecision = "resume" | "advance" | "wait_approval" | "blocked";

export interface RecoveryIncident {
  id: string;
  goal_id: string;
  phase: RecoveryPhase;
  decision: RecoveryDecision;
  reason: string;
  user_action: string | null;
  created_at: string;
}

// ─── Goal & Task ───────────────────────────────────────

export type Priority = "critical" | "high" | "medium" | "low";
export type TaskStatus =
  | "todo"
  | "pending_approval"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked";

/** 태스크 유형 — 유형별로 검증 기준이 달라진다 */
export type TaskType = "code" | "content" | "config" | "review";

export interface Goal {
  id: string;
  projectId: string;
  title: string;
  description: string;
  references: string[]; // file paths or URLs
  priority: Priority;
  progress: number; // 0-100
  createdAt: string;
}

// pr_open: goal 작업은 끝났으나 PR이 열린 채 머지 대기 — origin 실제 반영은 아직.
export type GoalE2EStatus = "running" | "failed" | "pending_approval" | "pr_open" | "completed";

export interface GoalE2EActivityEvent {
  type: string;
  message: string;
  created_at: string;
}

export interface GoalE2EStatusResponse {
  goal_id: string;
  status: GoalE2EStatus;
  worktree_path: string | null;
  worktree_branch: string | null;
  evaluator_session_id: string | null;
  approval_required: boolean;
  activity_events: GoalE2EActivityEvent[];
}

// ─── Goal Execution Report ─────────────────────────────────────

export type ReportFinalStatus = "running" | "completed" | "failed" | "interrupted";
export type ReportTelemetry = "complete" | "partial" | "none";
export type ReportHistoryKind = "failure" | "retry" | "failover" | "evaluation" | "fix";

export interface ReportProviderUsage {
  provider: AgentProvider;
  sessionCount: number;
  /** null means the provider did not report this metric. */
  tokens: number | null;
  /** null means the provider did not report this metric; it is never estimated. */
  costUsd: number | null;
}

export interface ReportSummary {
  goalId: string;
  title: string;
  finalStatus: ReportFinalStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  providers: ReportProviderUsage[];
  retryCount: number;
  failoverCount: number;
  evaluationCount: number;
  fixRoundCount: number;
  finalVerdict: Verdict | null;
  telemetry: ReportTelemetry;
}

export interface ReportHistoryEntry {
  kind: ReportHistoryKind;
  occurredAt: string;
  taskId: string | null;
  summary: string;
}

export interface ReportDetail extends ReportSummary {
  agentRoles: string[];
  history: ReportHistoryEntry[];
}

export interface ProjectGoalReportsResponse {
  reports: ReportSummary[];
}

export interface Task {
  id: string;
  goalId: string;
  projectId: string;
  title: string;
  description: string;
  assigneeId: string | null;
  parentTaskId: string | null;
  status: TaskStatus;
  verificationId: string | null;
  /** File paths the agent is expected to modify (scope anchor). */
  targetFiles: string[];
  /** Short stack/framework constraint, e.g. "Next.js 16 App Router". */
  stackHint: string;
  /** 태스크 유형 — 검증 기준 결정. 기본값 'code'. */
  taskType: TaskType;
  /** DAG 의존성 — 이 태스크 시작 전 완료되어야 하는 task ID 배열. 빈 배열이면 제약 없음. */
  dependsOn: string[];
  providerTrace: ProviderTrace;
  createdAt: string;
  updatedAt: string;
}

// ─── Agent Handoff ────────────────────────────────────

export const AGENT_HANDOFF_CONTRACT_VERSION = 1 as const;
export const AGENT_HANDOFF_STAGES = ["decompose", "implementation", "verification", "fix"] as const;

export type AgentHandoffContractVersion = typeof AGENT_HANDOFF_CONTRACT_VERSION;
export type AgentHandoffStage = (typeof AGENT_HANDOFF_STAGES)[number];

/** Provider-neutral result passed between orchestration stages. */
export interface AgentHandoff {
  version: AgentHandoffContractVersion;
  stage: AgentHandoffStage;
  changed_files: string[];
  decisions: string[];
  unresolved_risks: string[];
  reproduction_commands: string[];
}

// ─── Quality Gate ──────────────────────────────────────

export type VerificationScope = "lite" | "standard" | "full";
export type Severity = "auto-resolve" | "soft-block" | "hard-block";
export type Verdict = "pass" | "conditional" | "fail";
export type QualityGateDimension = "functionality" | "dataFlow" | "designAlignment" | "craft" | "edgeCases";
export type DimensionVerdict = "pass" | "fail" | "not_applicable";
export type IssueSeverity = "critical" | "high" | "warning" | "info";
export type FixRoundStatus = "pending" | "running" | "completed" | "failed";
export type IssueTaskRelation = "source" | "fix" | "carryover";
export type VerificationTerminationReason =
  | "passed"
  | "conditional"
  | "hard_blocked"
  | "auto_fix_disabled"
  | "fix_round_limit"
  | "escalated_to_goal_qa"
  | "evaluator_error";

export interface Score {
  value: number; // 0-10
  notes: string;
}

export interface VerificationResult {
  id: string;
  taskId: string;
  verdict: Verdict;
  scope: VerificationScope;
  dimensions: {
    functionality: Score;
    dataFlow: Score;
    designAlignment: Score;
    craft: Score;
    edgeCases: Score;
  };
  /** Strict evaluator output; absent only for evaluator/session failures. */
  dimensionJudgements?: Array<Omit<VerificationDimensionJudgement, "verificationId">>;
  issues: VerificationIssue[];
  severity: Severity;
  evaluatorSessionId: string;
  /** Omitted by legacy/intermediate verification payloads; null until terminal. */
  terminationReason?: VerificationTerminationReason | null;
  createdAt: string;
}

/** Legacy evaluator transport DTO. Normalized writes use QualityGateIssue. */
export interface VerificationIssue {
  id: string;
  severity: IssueSeverity;
  dimension?: QualityGateDimension;
  file?: string;
  line?: number;
  message: string;
  reproCommand?: string;
  expectedResult?: string;
  actualResult?: string;
  fixInstruction?: string;
  suggestion?: string;
}

export interface VerificationDimensionJudgement {
  verificationId: string;
  dimension: QualityGateDimension;
  verdict: DimensionVerdict;
  evidence: string;
}

export interface QualityGateIssue {
  id: string;
  verificationId: string;
  dimension: QualityGateDimension;
  severity: IssueSeverity;
  evidence: string;
  reproCommand: string;
  expectedResult: string;
  actualResult: string;
  fixInstruction: string;
  assigneeId: string;
}

export interface VerificationFixRound {
  id: string;
  taskId: string;
  sourceVerificationId: string;
  resultVerificationId: string | null;
  roundNumber: number;
  assigneeId: string | null;
  sessionId: string | null;
  status: FixRoundStatus;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface VerificationIssueTaskLink {
  issueId: string;
  taskId: string;
  relation: IssueTaskRelation;
}

// ─── Goal Spec (Structured Planning) ─────────────────────

export interface GoalSpec {
  id: string;
  goalId: string;
  prdSummary: {
    background: string;
    objective: string;
    scope: string;
    successMetrics: string[];
  };
  featureSpecs: Array<{
    name: string;
    description: string;
    requirements: string[];
    priority: "must" | "should" | "could";
  }>;
  userFlow: Array<{
    step: number;
    action: string;
    expected: string;
  }>;
  acceptanceCriteria: string[];
  techConsiderations: string[];
  generatedBy: "ai" | "manual";
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Versioned Goal Spec API snapshot (`/api/goals/:goalId/spec`). */
export interface GoalSpecVersionSnapshot {
  id: string;
  version: number;
  state: "draft" | "approved";
  scope: string;
  out_of_scope: string;
  acceptance_criteria: string[];
  expected_tasks: string[];
  verification_methods: string[];
  created_at: string;
  approved_at: string | null;
}

export interface SpecFields {
  scope: string;
  out_of_scope: string;
  acceptance_criteria: string[];
  expected_tasks: string[];
  verification_methods: string[];
}

/**
 * Legacy `goal_specs` PRD content, projected read-only when a goal predates the
 * versioned workflow (no `goal_spec_versions` rows). Fields mirror the old rich
 * columns; all optional because early rows vary in shape.
 */
export interface GoalSpecLegacyContent {
  prd_summary: {
    background?: string;
    objective?: string;
    scope?: string;
    success_metrics?: string[];
  };
  feature_specs: Array<{ name?: string; description?: string; requirements?: string[]; priority?: string }>;
  user_flow: Array<{ step?: number; action?: string; expected?: string }>;
  acceptance_criteria: string[];
  tech_considerations: string[];
  generated_by: string;
  created_at: string;
}

/** Common success response returned by Goal Spec GET, POST, and approve routes. */
export interface GoalSpecStateResponse {
  goal_id: string;
  status: "missing" | "draft" | "approved" | "changes_pending";
  generation_status: "idle" | "generating" | "failed";
  generation_error: string | null;
  execution_spec_version_id: string | null;
  versions: GoalSpecVersionSnapshot[];
  /** Present only when `versions` is empty but a legacy PRD exists (read-only). */
  legacy_spec?: GoalSpecLegacyContent | null;
}

// ─── WebSocket Events ──────────────────────────────────

export type WSEventType =
  | "agent:status"
  | "agent:output"
  // 활성 session의 stdout을 스트림 파서를 거쳐 라인 단위로 실시간 append (session_id 스코프).
  | "session:stream"
  | "task:updated"
  | "task:delegated"
  | "task:started"
  | "task:completed"
  | "task:usage"
  | "task:git"
  | "verification:result"
  | "project:updated"
  | "queue:paused"
  | "queue:resumed"
  | "queue:stopped"
  | "system:rate-limit"
  | "system:error"
  | "activity:created"
  // 실행 중 goal 조향(steering) 큐: 제출(pending 추가) / 주입(다음 Generator 스텝에 반영).
  | "steering:submitted"
  | "steering:injected"
  | "provider:resolved"
  | "provider:failover"
  | "provider:redispatched"
  | "autopilot:mode-changed"
  | "autopilot:full-completed";

export interface WSEvent {
  type: WSEventType;
  projectId: string;
  payload: unknown;
  timestamp: string;
}

// ─── Chat Events (Live Session) ────────────────────────

/**
 * 라이브 채팅 렌더용 구조화 이벤트. stream-json을 프론트에서 숨기는 계약.
 * ⚠ dashboard/src/types.ts 의 ChatEvent 미러와 동기 유지.
 */
export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; isError: boolean; content: string }
  | { kind: "todo"; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { kind: "result"; text: string }
  // 소환 시 "무엇을 주입했는지" 1회 broadcast (worktree·판정·최근출력·기획서 칩).
  | { kind: "context"; items: Array<{ label: string; detail?: string; tone: "pass" | "conditional" | "fail" | "neutral" }> }
  // 실행 중 큐에 쌓인 메시지 수 (Phase 4a — `[큐 N]` 칩).
  | { kind: "queue"; remaining: number }
  // 턴 경계 코드 체크포인트 목록 (Phase 4b — "코드만 되돌리기"). commit=복원 대상 스냅샷 SHA.
  | { kind: "checkpoint"; items: Array<{ commit: string; turn: number; at: string }> };

// ─── Steering (실행 중 goal 조향 큐) ───────────────────────

/**
 * 실행 중 goal 조향(steering) 노트의 API 표현 — goal_steering_notes 행을 camelCase로
 * 직렬화한 것. POST 응답과 GET 목록이 이 shape을 verbatim 소비한다. injected=false 이면
 * 아직 다음 Generator 스텝에 반영되지 않은 pending 노트, true 이면 반영 완료.
 */
export interface SteeringNote {
  id: string;
  goalId: string;
  content: string;
  injected: boolean;
  injectedAt: string | null;
  injectedStep: string | null;
  createdAt: string;
}
