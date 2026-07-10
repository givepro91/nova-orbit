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
  issues: VerificationIssue[];
  severity: Severity;
  evaluatorSessionId: string;
  createdAt: string;
}

export interface VerificationIssue {
  id: string;
  severity: "critical" | "high" | "warning" | "info";
  file?: string;
  line?: number;
  message: string;
  suggestion?: string;
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
