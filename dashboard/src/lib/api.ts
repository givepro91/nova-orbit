import i18n from "../i18n";
import { useToast } from "../stores/useToast";
import type {
  AgentProvider,
  AnomalyReport,
  GoalSpecLegacyContent,
  GoalSpecVersionSnapshot,
  ProjectGoalReportsResponse,
  ReportDetail,
  SpecFields,
  SteeringNote,
  TerminalActivity,
  TerminalBridgeActivity,
  TerminalDecision,
  TerminalReviewRequest,
  TerminalSession,
  Workspace,
} from "../../../shared/types";

const BASE = "/api";

// Auth — API key management
let apiKey: string | null = localStorage.getItem("crewdeck-api-key");

export function setApiKey(key: string): void {
  apiKey = key;
  localStorage.setItem("crewdeck-api-key", key);
}

export function getApiKey(): string | null {
  return apiKey;
}

export type GoalStatus = "running" | "failed" | "pending_approval" | "pr_open" | "completed";

export interface TerminalTaskStartResponse {
  task: Record<string, unknown>;
  terminal: TerminalSession | null;
  provider: AgentProvider;
  launchKey: string;
  launchState: "requested" | "continued";
}

export interface TerminalReviewResponse {
  review: TerminalReviewRequest;
  task: Record<string, unknown>;
  terminal: TerminalSession | null;
  replayed: boolean;
}

export interface TerminalReviewRunResponse {
  started: boolean;
  stale: boolean;
  review: TerminalReviewRequest;
  task: Record<string, unknown>;
  terminal: TerminalSession | null;
  nextReadyTask: Record<string, unknown> | null;
  hasNextReadyTask: boolean;
}

export interface SmartTeamCandidate {
  key: string;
  matchedAgentId: string | null;
  name: string;
  role: string;
  reason: string;
  systemPrompt: string;
  source: string;
  model: string | null;
  provider: AgentProvider | null;
  action: "add" | "keep" | "update" | "conflict";
  warnings: string[];
}

export interface SmartTeamPreview {
  projectId: string;
  goal: { id: string; title: string; description: string; hasPlan: boolean; taskCount: number };
  existingAgents: any[];
  candidates: SmartTeamCandidate[];
  preservedExisting: number;
  additions: number;
  updates: number;
  conflicts: number;
}

export interface GoalActivityEvent {
  type: string;
  message: string;
  created_at: string;
}

export interface GoalStatusResponse {
  goal_id: string;
  status: GoalStatus;
  worktree_path: string | null;
  worktree_branch: string | null;
  evaluator_session_id: string | null;
  approval_required: boolean;
  activity_events: GoalActivityEvent[];
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

export type VerificationTimelineStatus = "passed" | "fixing" | "stopped" | "manual_approval";
export type VerificationRoundVerdict = "pass" | "fail" | "stopped" | "manual_approval";
export type VerificationIssueStatus = "open" | "resolved" | "regression";

export interface VerificationTimelineDimension {
  dimension: string;
  score: number;
  passed: boolean;
  rationale: string;
}

export interface VerificationTimelineIssue {
  issue_id: string;
  status: VerificationIssueStatus;
  dimension: string;
  severity: string;
  evidence: string;
  repro_command: string;
  expected_result: string;
  actual_result: string;
  fix_instruction: string;
  assignee_id: string | null;
  fix_task_id: string | null;
}

export interface VerificationTimelineRound {
  round: number;
  verification_id: string;
  task_id: string;
  task_title: string;
  verdict: VerificationRoundVerdict;
  reason: string | null;
  scope: string;
  severity: string;
  implementation_session_id: string;
  evaluator_session_id: string;
  fix_session_ids: string[];
  dimensions: VerificationTimelineDimension[];
  issues: VerificationTimelineIssue[];
  created_at: string;
}

export interface VerificationTimelineResponse {
  goal_id: string;
  status: VerificationTimelineStatus;
  reason: string;
  rounds: VerificationTimelineRound[];
}

// 대시보드 UI 언어 — AI 생성물(목표·팀 설계·mission 제안)을 이 언어로 만들도록 서버에 전달한다.
// LanguageToggle이 localStorage("crewdeck-lang")에 저장하는 값과 동일 소스(i18n과 일치).
function uiLang(): "ko" | "en" {
  const l = (localStorage.getItem("crewdeck-lang") || navigator.language || "en").toLowerCase();
  return l.startsWith("ko") ? "ko" : "en";
}

export interface WorkReport {
  before: string | null;
  changed: string | null;
  after: string | null;
  notes: string | null;
  summaryStatus: "pending" | "ready" | "failed";
  screenshots: { file: string; label: string; taskId?: string | null }[];
}

export async function initAuth(): Promise<void> {
  if (apiKey) return;
  const res = await fetch("/api/auth/key?init=true");
  if (res.ok) {
    const data = await res.json();
    setApiKey(data.key);
  }
}

// 401 복구 — localStorage의 키가 낡았을 때(데이터 디렉토리 교체·키 회전 등) 재발급을
// 페이지 로드당 1회만 시도한다. 서버 발급 마커(.key-issued)가 살아 있으면 403이라 실패하고,
// 그 경우 기존대로 Unauthorized를 던진다 (마커 리셋은 서버 쪽 수동 조치).
let reauthPromise: Promise<boolean> | null = null;
function tryReauth(): Promise<boolean> {
  reauthPromise ??= (async () => {
    apiKey = null;
    localStorage.removeItem("crewdeck-api-key");
    try {
      const res = await fetch("/api/auth/key?init=true");
      if (!res.ok) return false;
      setApiKey((await res.json()).key);
      return true;
    } catch {
      return false;
    }
  })();
  return reauthPromise;
}

// Global server status — components can check this
let serverDown = false;
export function isServerDown() { return serverDown; }

export class ApiError extends Error {
  status: number;
  code?: string;
  location?: string;
  detail?: unknown;
  /** 서버가 함께 내려준 오류 페이로드 원본 (예: spec_not_approved의 goalId·specStatus·currentDraftVersion). */
  data?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    code?: string,
    location?: string,
    detail?: unknown,
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.location = location;
    this.detail = detail;
    this.data = data;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    const res = await fetch(`${BASE}${path}`, {
      headers,
      ...options,
    });
    // Server responded — mark as up
    if (serverDown) {
      serverDown = false;
      window.dispatchEvent(new CustomEvent("crewdeck:server-status", { detail: { up: true } }));
    }
    if (!res.ok) {
      if (res.status === 401 && (await tryReauth())) {
        // 새 키 확보 — 전체 상태(WS 포함)를 깨끗하게 다시 세우기 위해 리로드
        window.location.reload();
        return new Promise<never>(() => {});
      }
      const body = await res.json().catch(() => ({ error: res.statusText }));
      const message = typeof body.message === "string"
        ? body.message
        : body.error ?? "Request failed";
      throw new ApiError(message, res.status, body.error, body.location, body.detail, body);
    }
    return res.json();
  } catch (err: any) {
    // Network error = server is down
    if (err instanceof TypeError && err.message.includes("fetch")) {
      serverDown = true;
      window.dispatchEvent(new CustomEvent("crewdeck:server-status", { detail: { up: false } }));
    }
    throw err;
  }
}

// mutation 공용 에러 게이트 — 실패를 조용히 삼키던 mutation 핸들러용.
// 실패 시 에러 토스트(서버 메시지는 detail)를 띄운 뒤 그대로 rethrow 한다.
// 성공 토스트는 붙이지 않는다(소음 — 실패만 알린다). 자체 에러 UI(다이얼로그·
// 전용 토스트·인라인 표시)를 가진 호출부는 이 래퍼 없이 기존 처리를 유지한다.
export async function guardMutation<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    useToast.getState().showToast(i18n.t("mutationFailed"), "error", detail);
    throw err;
  }
}

const specStatuses = new Set(["missing", "draft", "approved", "changes_pending"]);
const generationStatuses = new Set(["idle", "generating", "failed"]);

export interface GoalSpecState {
  goal_id: string;
  status: "missing" | "draft" | "approved" | "changes_pending";
  execution_spec_version_id: string | null;
  versions: GoalSpecVersionSnapshot[];
  /** Read-only legacy PRD, present only when `versions` is empty (pre-versioned goals). */
  legacy_spec: GoalSpecLegacyContent | null;
}

export interface GoalSpecGenerationState {
  generation_status: "idle" | "generating" | "failed";
  generation_error: string | null;
}

export type TaskGraphExecutionState = "ready" | "blocked" | "active" | "complete";

export interface TaskGraphItem {
  id: string;
  goal_id: string;
  project_id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  status: string;
  priority: string;
  sort_order: number;
  depends_on: string[];
  blocked_by: string[];
  execution_state: TaskGraphExecutionState;
}

export interface TaskGraphResponse {
  goal: {
    id: string;
    project_id: string;
    title: string;
    description: string;
    priority: string;
    progress: number;
  };
  plan: {
    status: GoalSpecState["status"];
    version_id: string | null;
    version: number | null;
    scope: string;
    acceptance_criteria: string[];
    expected_tasks: string[];
    verification_methods: string[];
  } | null;
  tasks: TaskGraphItem[];
}

export interface TaskGraphEdit {
  id: string;
  title?: string;
  description?: string;
  assignee_id?: string | null;
  status?: string;
  sort_order?: number;
  depends_on?: string[];
}

export interface GoalListItem {
  id: string;
  project_id: string;
  title: string;
  description: string;
  references: string;
  priority: string;
  progress: number;
  goal_model: "legacy" | "goal_as_unit";
  squash_status: "none" | "pending_approval" | "approved" | "resolving" | "merged" | "blocked" | "triggering";
  squash_commit_sha: string | null;
  acceptance_script: string | null;
  qa_regression_task_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  has_spec: 0 | 1;
  execution_spec_version_id: string | null;
  spec_approval_required: 0 | 1;
  // Merge honesty: squash_status='merged'의 실제 반영 형태와 PR 추적 (legacy=null)
  merge_outcome: "applied" | "pr_open" | "local" | null;
  pr_url: string | null;
  pr_number: number | null;
  pr_state: "open" | "merged" | "closed" | null;
  pr_state_checked_at: string | null;
}

export function parseGoalSpecState(value: unknown): GoalSpecState {
  if (!value || typeof value !== "object") throw new Error("Invalid blueprint response");
  const state = value as Record<string, unknown>;
  const validVersion = (version: unknown) => {
    if (!version || typeof version !== "object") return false;
    const snapshot = version as Record<string, unknown>;
    return typeof snapshot.id === "string"
      && typeof snapshot.version === "number"
      && (snapshot.state === "draft" || snapshot.state === "approved")
      && typeof snapshot.scope === "string"
      && typeof snapshot.out_of_scope === "string"
      && Array.isArray(snapshot.acceptance_criteria) && snapshot.acceptance_criteria.every((item) => typeof item === "string")
      && Array.isArray(snapshot.expected_tasks) && snapshot.expected_tasks.every((item) => typeof item === "string")
      && Array.isArray(snapshot.verification_methods) && snapshot.verification_methods.every((item) => typeof item === "string")
      && typeof snapshot.created_at === "string"
      && (snapshot.approved_at === null || typeof snapshot.approved_at === "string");
  };
  const valid = typeof state.goal_id === "string"
    && specStatuses.has(String(state.status))
    && (state.execution_spec_version_id === null || typeof state.execution_spec_version_id === "string")
    && Array.isArray(state.versions)
    && state.versions.every(validVersion);
  if (!valid) throw new Error("Invalid blueprint response");
  return {
    goal_id: state.goal_id as string,
    status: state.status as GoalSpecState["status"],
    execution_spec_version_id: state.execution_spec_version_id as string | null,
    versions: (state.versions as Array<Record<string, unknown>>).map((snapshot) => ({
      id: snapshot.id as string,
      version: snapshot.version as number,
      state: snapshot.state as GoalSpecVersionSnapshot["state"],
      scope: snapshot.scope as string,
      out_of_scope: snapshot.out_of_scope as string,
      acceptance_criteria: [...snapshot.acceptance_criteria as string[]],
      expected_tasks: [...snapshot.expected_tasks as string[]],
      verification_methods: [...snapshot.verification_methods as string[]],
      created_at: snapshot.created_at as string,
      approved_at: snapshot.approved_at as string | null,
    })),
    // 서버가 GoalSpecLegacyContent 형태로 정제해 보낸다. 얕게 통과시키고 렌더에서 방어.
    legacy_spec: state.legacy_spec && typeof state.legacy_spec === "object"
      ? (state.legacy_spec as GoalSpecLegacyContent)
      : null,
  };
}

const requestGoalSpecState = (path: string, goalId: string, options?: RequestInit) =>
  request<unknown>(path, options).then((value) => {
    const spec = parseGoalSpecState(value);
    if (spec.goal_id !== goalId) throw new Error("Blueprint response goal_id mismatch");
    return spec;
  });

function parseGoalSpecGenerationState(value: unknown): GoalSpecGenerationState {
  if (!value || typeof value !== "object") throw new Error("Invalid blueprint generation response");
  const state = value as Record<string, unknown>;
  if (!generationStatuses.has(String(state.generation_status))
    || !(state.generation_error === null || typeof state.generation_error === "string")) {
    throw new Error("Invalid blueprint generation response");
  }
  return {
    generation_status: state.generation_status as GoalSpecGenerationState["generation_status"],
    generation_error: state.generation_error as string | null,
  };
}

// Projects
export const api = {
  projects: {
    list: () => request<any[]>("/projects"),
    activity: () =>
      request<Record<string, { state: "working" | "waiting"; activeCount: number; specPending: number }>>("/projects/activity"),
    get: (id: string) => request<any>(`/projects/${id}`),
    gitRemote: (id: string) =>
      request<{ hasOrigin: boolean; isGitHub: boolean; repo: string | null; remoteUrl: string | null }>(
        `/projects/${id}/git-remote`,
      ),
    pullRequests: (id: string) =>
      request<{ pullRequests: { number: number; title: string; url: string; isDraft: boolean; author: string; updatedAt: string }[] }>(
        `/projects/${id}/pull-requests`,
      ),
    create: (data: any) => request<any>("/projects", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: any) =>
      request<any>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: string) => request<any>(`/projects/${id}`, { method: "DELETE" }),
    getCost: (id: string) =>
      request<{ costs: Array<{ agentId: string; agentName: string; totalTokens: number; totalCost: number; estimatedCost: number }> }>(
        `/projects/${id}/cost`,
      ),
    listBranches: (id: string) =>
      request<{ branches: string[] }>(`/projects/${id}/branches`),
    mergeAllBranches: (id: string) =>
      request<{ status: string; agentId?: string; agentName?: string; branches?: string[]; error?: string }>(
        `/projects/${id}/branches/merge-all`, { method: "POST" },
      ),
    deleteAllBranches: (id: string) =>
      request<{ deleted: string[] }>(`/projects/${id}/branches`, { method: "DELETE" }),
    listDocs: (id: string) =>
      request<Array<{ path: string; name: string; dir: string }>>(`/projects/${id}/docs`),
    agentFiles: (id: string) =>
      request<Array<{ filename: string; content: string }>>(`/projects/${id}/agent-files`),
    // 발산 미션 방향 3~4개(옵션 모드). answer를 주면 interview 답변을 반영해 재생성(stateless 2-step).
    suggestMissionOptions: (id: string, answer?: string) =>
      request<{ options: Array<{ id: string; label: string; draft: string; rationale: string }> }>(
        `/projects/${id}/suggest-mission`,
        { method: "POST", body: JSON.stringify({ language: uiLang(), mode: "options", answer }) },
      ),
    // 하이브리드 1단계: 방향을 좁히는 질문 1개 + 선택 칩.
    suggestMissionQuestion: (id: string) =>
      request<{ question: { text: string; chips: string[] } }>(
        `/projects/${id}/suggest-mission`,
        { method: "POST", body: JSON.stringify({ language: uiLang(), mode: "question" }) },
      ),
    goalReports: (id: string) =>
      request<ProjectGoalReportsResponse>(`/projects/${id}/goal-reports`),
    anomalies: (id: string) =>
      request<AnomalyReport>(`/projects/${id}/anomalies`),
  },
  workspaces: {
    list: (projectId: string) => request<Workspace[]>(`/workspaces?projectId=${encodeURIComponent(projectId)}`),
    get: (id: string) => request<Workspace>(`/workspaces/${id}`),
    create: (data: { projectId: string; name: string; baseRef?: string }) =>
      request<Workspace>("/workspaces", { method: "POST", body: JSON.stringify(data) }),
    selectGoal: (id: string, goalId: string | null) =>
      request<Workspace>(`/workspaces/${id}/context`, {
        method: "PATCH",
        body: JSON.stringify({ goalId }),
      }),
    archive: (id: string, options: { confirmDirty?: boolean } = {}) =>
      request<Workspace>(`/workspaces/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmDirty: options.confirmDirty === true }),
      }),
    getDiff: (id: string) => request<{ diff: string; truncated: boolean }>(`/workspaces/${id}/diff`),
    getFiles: (id: string) => request<{ files: string[]; truncated: boolean }>(`/workspaces/${id}/files`),
  },
  terminalBridge: {
    events: (workspaceId: string, goalId?: string | null) => request<TerminalBridgeActivity[]>(
      `/terminal-bridge/events?workspaceId=${encodeURIComponent(workspaceId)}${goalId ? `&goalId=${encodeURIComponent(goalId)}` : ""}`,
    ),
  },
  terminalActivities: {
    list: (workspaceId: string, filters: {
      goalId?: string | null;
      taskId?: string | null;
      terminalSessionId?: string | null;
      limit?: number;
    } = {}) => {
      const params = new URLSearchParams({ workspaceId });
      if (filters.goalId) params.set("goalId", filters.goalId);
      if (filters.taskId) params.set("taskId", filters.taskId);
      if (filters.terminalSessionId) params.set("terminalSessionId", filters.terminalSessionId);
      if (filters.limit) params.set("limit", String(filters.limit));
      return request<{ items: TerminalActivity[]; nextCursor: string | null }>(`/terminal-activities?${params}`);
    },
  },
  terminals: {
    list: (workspaceId: string) =>
      request<TerminalSession[]>(`/terminals?workspaceId=${encodeURIComponent(workspaceId)}`),
    get: (id: string) => request<TerminalSession>(`/terminals/${id}`),
    create: (data: { workspaceId: string; cols?: number; rows?: number; forceNew?: boolean }) =>
      request<TerminalSession>("/terminals", { method: "POST", body: JSON.stringify(data) }),
    kill: (id: string) =>
      request<{ status: string; terminalId: string }>(`/terminals/${id}`, { method: "DELETE" }),
    dismiss: (id: string) =>
      request<{ status: string; terminalId: string }>(`/terminals/${id}/dismiss`, { method: "POST" }),
    bind: (id: string, data: { goalId?: string | null; agentId?: string | null; taskId?: string | null; provider?: AgentProvider | null }) =>
      request<TerminalSession>(`/terminals/${id}/binding`, { method: "PATCH", body: JSON.stringify(data) }),
    claimNext: (id: string, data: { goalId?: string | null; agentId?: string | null; taskId?: string | null; provider?: AgentProvider | null }) =>
      request<{ task: Record<string, unknown>; terminal: TerminalSession | null }>(`/terminals/${id}/claim-next`, { method: "POST", body: JSON.stringify(data) }),
    startNext: (id: string, data: { goalId?: string | null; agentId?: string | null; taskId?: string | null; provider?: AgentProvider | null }) =>
      request<TerminalTaskStartResponse>(`/terminals/${id}/start-next`, { method: "POST", body: JSON.stringify({ ...data, language: uiLang() }) }),
    decisions: (id: string, goalId?: string | null) =>
      request<TerminalDecision[]>(`/terminals/${id}/decisions${goalId ? `?goalId=${encodeURIComponent(goalId)}` : ""}`),
    recordDecision: (id: string, message: string) =>
      request<{ decision: TerminalDecision; task: Record<string, unknown> | null; terminal: TerminalSession | null }>(`/terminals/${id}/decisions`, { method: "POST", body: JSON.stringify({ message }) }),
    requestCompletion: (id: string, data: {
      summary: string;
      changedFiles?: string[];
      verificationCommands?: string[];
      scope?: "lite" | "standard" | "full";
      idempotencyKey?: string;
    }) => request<TerminalReviewResponse>(`/terminals/${id}/completion`, { method: "POST", body: JSON.stringify(data) }),
    reviews: (id: string) => request<TerminalReviewRequest[]>(`/terminals/${id}/reviews`),
    verifyReview: (id: string, reviewId: string, retry = false) =>
      request<TerminalReviewRunResponse>(`/terminals/${id}/reviews/${reviewId}/verify`, {
        method: "POST",
        body: JSON.stringify({ retry }),
      }),
  },
  agents: {
    list: (projectId: string) => request<any[]>(`/agents?projectId=${projectId}`),
    get: (id: string) => request<any>(`/agents/${id}`),
    presets: () => request<any[]>("/agents/presets"),
    teamPresets: () => request<any[]>("/agents/team-presets"),
    createTeam: (projectId: string, presetId: string) =>
      request<any>("/agents/create-team", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, preset_id: presetId }),
      }),
    suggest: (mission: string, projectId?: string, techStack?: any, mode?: "ai" | "quick", refresh?: boolean) =>
      request<any[]>("/agents/suggest", { method: "POST", body: JSON.stringify({ mission, project_id: projectId, techStack, mode, refresh, language: uiLang() }) }),
    designStatus: (projectId: string) =>
      request<{ running: boolean; ready: boolean }>(`/agents/design-status?projectId=${projectId}`),
    teamPreview: (projectId: string, goalId: string, refresh = false) =>
      request<SmartTeamPreview>("/agents/team-preview", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, goal_id: goalId, mode: "ai", refresh, language: uiLang() }),
      }),
    applyTeamPreview: (projectId: string, goalId: string, candidates: SmartTeamCandidate[]) =>
      request<{ goalId: string; preserved: number; created: any[]; updated: any[]; skipped: any[] }>("/agents/team-apply", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, goal_id: goalId, candidates }),
      }),
    suggestAndCreate: (projectId: string, mission: string, techStack?: any) =>
      request<any>("/agents/suggest-and-create", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, mission, techStack }),
      }),
    scanProject: (projectId: string) =>
      request<any>("/agents/scan-project", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId }),
      }),
    create: (data: any) => request<any>("/agents", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: any) =>
      request<any>(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: string) => request<any>(`/agents/${id}`, { method: "DELETE" }),
    clone: (id: string, name?: string) =>
      request<any>(`/agents/${id}/clone`, { method: "POST", body: JSON.stringify({ name }) }),
    duplicateTeam: (projectId: string, sourceAgentIds?: string[], label?: string) =>
      request<{ team: string; count: number; agents: any[] }>("/agents/duplicate-team", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, source_agent_ids: sourceAgentIds, label }),
      }),
    deleteAll: (projectId: string) => request<{ success: boolean; deleted: number }>(`/agents/bulk/${projectId}`, { method: "DELETE" }),
    stats: (id: string) =>
      request<{ taskCount: number; totalTokens: number; totalCostUsd: number }>(`/agents/${id}/stats`),
    activityLog: (id: string) =>
      request<{ lastEventAt: string | null; events: Array<{ ts: string; kind: string; detail: string; action?: string }> }>(
        `/agents/${id}/activity-log`,
      ),
  },
  goals: {
    list: (projectId: string) => request<GoalListItem[]>(`/goals?projectId=${projectId}`),
    create: (data: any) => request<any>("/goals", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: any) =>
      request<any>(`/goals/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: string) => request<any>(`/goals/${id}`, { method: "DELETE" }),
    getSpec: (goalId: string) => requestGoalSpecState(`/goals/${goalId}/spec`, goalId),
    getSpecGenerationState: (goalId: string) =>
      request<unknown>(`/goals/${goalId}/spec`).then(parseGoalSpecGenerationState),
    getStatus: (goalId: string) => request<GoalStatusResponse>(`/goals/${goalId}/status`),
    getVerificationTimeline: (goalId: string) =>
      request<VerificationTimelineResponse>(`/goals/${goalId}/verification-timeline`),
    getExecutionReport: (goalId: string) =>
      request<ReportDetail>(`/goals/${goalId}/execution-report`),
    getDiff: (goalId: string) =>
      request<{ diff: string; truncated: boolean }>(`/goals/${goalId}/diff`),
    getFiles: (goalId: string) =>
      request<{ files: string[]; truncated: boolean }>(`/goals/${goalId}/files`),
    saveSpec: (goalId: string, data: SpecFields) =>
      requestGoalSpecState(`/goals/${goalId}/spec`, goalId, { method: "POST", body: JSON.stringify(data) }),
    approveSpec: (goalId: string, versionId: string) =>
      requestGoalSpecState(`/goals/${goalId}/spec/approve`, goalId, {
        method: "POST",
        body: JSON.stringify({ version_id: versionId }),
      }),
    generateSpec: (goalId: string) =>
      request<any>(`/goals/${goalId}/generate-spec`, { method: "POST" }),
    refineSpec: (goalId: string, prompt: string) =>
      requestGoalSpecState(`/goals/${goalId}/refine-spec`, goalId, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      }),
    suggest: (projectId: string, count?: number, sourceMaterial?: string) =>
      request<Array<{ title: string; description: string; priority: string; reason: string }>>("/goals/suggest", { method: "POST", body: JSON.stringify({ project_id: projectId, count, language: uiLang(), ...(sourceMaterial ? { sourceMaterial } : {}) }) }),
    squashPreview: (goalId: string) =>
      request<{ goalId: string; squashStatus: string; commitMessage: string; filesChanged: string[]; acceptanceScript: string | null; workReport: WorkReport | null; skippedTasks?: Array<{ id: string; title: string; skip_reason?: string | null }> }>(
        `/goals/${goalId}/squash-preview`,
      ),
    squashApprove: (goalId: string, commitMessage?: string) =>
      request<{ success: boolean; sha?: string; prUrl?: string; error?: string; resolving?: boolean }>(
        `/goals/${goalId}/squash-approve`,
        { method: "POST", ...(commitMessage !== undefined ? { body: JSON.stringify({ commitMessage }) } : {}) },
      ),
    refreshPrState: (goalId: string) =>
      request<{ success: boolean; prState: "open" | "merged" | "closed"; prStateCheckedAt: string }>(
        `/goals/${goalId}/pr-state/refresh`, { method: "POST" }
      ),
    // 조향(steering) 큐 — 실행 중 세션을 죽이지 않고 다음 Generator 스텝에 반영할 메시지.
    submitSteering: (goalId: string, content: string) =>
      request<SteeringNote>(`/goals/${goalId}/steering`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    listSteering: (goalId: string) => request<SteeringNote[]>(`/goals/${goalId}/steering`),
    // 스크린샷 아티팩트 — <img>는 Bearer 헤더를 못 실으므로 인증 fetch → blob objectURL
    fetchArtifact: async (goalId: string, name: string): Promise<string> => {
      const res = await fetch(`${BASE}/goals/${goalId}/artifacts/${encodeURIComponent(name)}`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) throw new Error(`artifact ${res.status}`);
      return URL.createObjectURL(await res.blob());
    },
  },
  tasks: {
    list: (projectId: string) => request<any[]>(`/tasks?projectId=${projectId}`),
    listByGoal: (goalId: string) => request<any[]>(`/tasks?goalId=${goalId}`),
    create: (data: any) => request<any>("/tasks", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: any) =>
      request<any>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    getGraph: (goalId: string) => request<TaskGraphResponse>(`/tasks/graph/${goalId}`),
    updateGraph: (goalId: string, tasks: TaskGraphEdit[]) =>
      request<TaskGraphResponse>(`/tasks/graph/${goalId}`, {
        method: "PATCH",
        body: JSON.stringify({ tasks }),
      }),
    approve: (id: string) =>
      request<any>(`/tasks/${id}/approve`, { method: "POST" }),
    reject: (id: string, feedback?: string) =>
      request<any>(`/tasks/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ feedback }),
      }),
    bulkApprove: (projectId: string) =>
      request<{ approved: number }>("/tasks/bulk-approve", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      }),
  },
  sessions: {
    list: (params?: { status?: string; projectId?: string }) => {
      const q = new URLSearchParams();
      if (params?.status) q.set("status", params.status);
      if (params?.projectId) q.set("projectId", params.projectId);
      return request<any[]>(`/sessions?${q.toString()}`);
    },
    stats: (projectId?: string) => request<any>(`/sessions/stats${projectId ? `?projectId=${projectId}` : ""}`),
    kill: (id: string) => request<any>(`/sessions/${id}`, { method: "DELETE" }),
    cleanup: () => request<{ success: boolean; cleaned: number; checked: number }>("/sessions/cleanup", { method: "POST" }),
  },
  activities: {
    list: (projectId: string) => request<any[]>(`/activities?projectId=${projectId}`),
  },
  recovery: {
    incidents: () => request<{ incidents: RecoveryIncident[] }>("/recovery/incidents"),
  },
  verifications: {
    list: (projectId: string) => request<any[]>(`/verifications?projectId=${projectId}`),
    listByTask: (taskId: string) => request<any[]>(`/verifications?taskId=${taskId}`),
    createFixTask: (id: string) =>
      request<any>(`/verifications/${id}/create-fix-task`, { method: "POST" }),
    stats: (projectId: string) =>
      request<{ total: number; passed: number; conditional: number; failed: number; passRate: number | null; avgRetries: number | null }>(
        `/verifications/stats?projectId=${projectId}`,
      ),
  },
  orchestration: {
    executeTask: (taskId: string, scope = "standard") =>
      request<any>(`/orchestration/tasks/${taskId}/execute`, {
        method: "POST",
        body: JSON.stringify({ verificationScope: scope }),
      }),
    decomposeGoal: (goalId: string) =>
      request<any>(`/orchestration/goals/${goalId}/decompose`, { method: "POST" }),
    killAgent: (agentId: string) =>
      request<any>(`/orchestration/agents/${agentId}/kill`, { method: "POST" }),
    killAll: () =>
      request<any>("/orchestration/sessions/kill-all", { method: "POST" }),
    queueStatus: (projectId: string) =>
      request<{ running: boolean; paused: boolean; activeTasks: number; maxConcurrency: number; rateLimitRetries: number; nextRetryAt: string | null }>(
        `/orchestration/projects/${projectId}/queue-status`,
      ),
    startQueue: (projectId: string) =>
      request<any>(`/orchestration/projects/${projectId}/run-queue`, { method: "POST" }),
    stopQueue: (projectId: string) =>
      request<any>(`/orchestration/projects/${projectId}/stop-queue`, { method: "POST" }),
    resumeQueue: (projectId: string) =>
      request<any>(`/orchestration/projects/${projectId}/resume-queue`, { method: "POST" }),
    reassignAll: (projectId: string) =>
      request<{ status: string; count: number }>(`/orchestration/projects/${projectId}/reassign-all`, { method: "POST" }),
    pauseAgent: (agentId: string) =>
      request<any>(`/orchestration/agents/${agentId}/pause`, { method: "POST" }),
    resumeAgent: (agentId: string) =>
      request<any>(`/orchestration/agents/${agentId}/resume`, { method: "POST" }),
    verifyTask: (taskId: string, scope = "standard") =>
      request<any>(`/orchestration/tasks/${taskId}/verify`, {
        method: "POST",
        body: JSON.stringify({ scope }),
      }),
    sendPrompt: (agentId: string, message: string) =>
      request<{ status: string; agentId: string }>(`/orchestration/agents/${agentId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ message }),
      }),
    sendChat: (agentId: string, message: string, opts?: { taskId?: string | null; steer?: boolean; workspaceId?: string | null }) =>
      request<{ status: string; queued?: number }>(`/orchestration/agents/${agentId}/chat`, {
        method: "POST",
        body: JSON.stringify({ message, taskId: opts?.taskId ?? null, steer: opts?.steer ?? false, workspaceId: opts?.workspaceId ?? null }),
      }),
    abortChat: (agentId: string, workspaceId?: string | null) =>
      request<{ status: string }>(`/orchestration/agents/${agentId}/chat/abort`, {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspaceId ?? null }),
      }),
    restoreCheckpoint: (agentId: string, commit: string, workspaceId?: string | null) =>
      request<{ status: string; turn: number }>(`/orchestration/agents/${agentId}/chat/restore`, {
        method: "POST",
        body: JSON.stringify({ commit, workspaceId: workspaceId ?? null }),
      }),
    multiPrompt: (agentIds: string[], message: string, projectId: string) =>
      request<{ status: string; sessionId: string }>("/orchestration/multi-prompt", {
        method: "POST",
        body: JSON.stringify({ agentIds, message, projectId }),
      }),
    approveTask: (projectId: string, taskId: string) =>
      request<any>(`/orchestration/${projectId}/tasks/${taskId}/approve`, { method: "POST" }),
    rejectTask: (projectId: string, taskId: string, reason?: string) =>
      request<any>(`/orchestration/${projectId}/tasks/${taskId}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    approveAll: (projectId: string) =>
      request<{ approved: number; excluded: number }>(`/orchestration/${projectId}/tasks/approve-all`, { method: "POST" }),
  },
};
