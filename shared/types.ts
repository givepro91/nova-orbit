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

export type GitMode = "branch_only" | "pr" | "main_direct" | "local_only";

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

export type GoalE2EStatus = "running" | "failed" | "pending_approval" | "completed";

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

// ─── WebSocket Events ──────────────────────────────────

export type WSEventType =
  | "agent:status"
  | "agent:output"
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
  | { kind: "queue"; remaining: number };
