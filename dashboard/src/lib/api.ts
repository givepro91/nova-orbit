import type {
  GoalSpecVersionSnapshot,
  ProjectGoalReportsResponse,
  ReportDetail,
  SpecFields,
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

const specStatuses = new Set(["missing", "draft", "approved", "changes_pending"]);
const generationStatuses = new Set(["idle", "generating", "failed"]);

export interface GoalSpecState {
  goal_id: string;
  status: "missing" | "draft" | "approved" | "changes_pending";
  execution_spec_version_id: string | null;
  versions: GoalSpecVersionSnapshot[];
}

export interface GoalSpecGenerationState {
  generation_status: "idle" | "generating" | "failed";
  generation_error: string | null;
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
    create: (data: any) => request<any>("/projects", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: any) =>
      request<any>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: string) => request<any>(`/projects/${id}`, { method: "DELETE" }),
    getCost: (id: string) =>
      request<{ costs: Array<{ agentId: string; agentName: string; totalTokens: number; totalCost: number }> }>(
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
      request<{ goalId: string; squashStatus: string; commitMessage: string; filesChanged: string[]; acceptanceScript: string | null; workReport: WorkReport | null }>(
        `/goals/${goalId}/squash-preview`,
      ),
    squashApprove: (goalId: string) =>
      request<{ success: boolean; sha?: string; prUrl?: string; error?: string; resolving?: boolean }>(
        `/goals/${goalId}/squash-approve`, { method: "POST" }
      ),
    refreshPrState: (goalId: string) =>
      request<{ success: boolean; prState: "open" | "merged" | "closed"; prStateCheckedAt: string }>(
        `/goals/${goalId}/pr-state/refresh`, { method: "POST" }
      ),
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
    sendChat: (agentId: string, message: string, opts?: { taskId?: string | null; steer?: boolean }) =>
      request<{ status: string; queued?: number }>(`/orchestration/agents/${agentId}/chat`, {
        method: "POST",
        body: JSON.stringify({ message, taskId: opts?.taskId ?? null, steer: opts?.steer ?? false }),
      }),
    abortChat: (agentId: string) =>
      request<{ status: string }>(`/orchestration/agents/${agentId}/chat/abort`, { method: "POST" }),
    restoreCheckpoint: (agentId: string, commit: string) =>
      request<{ status: string; turn: number }>(`/orchestration/agents/${agentId}/chat/restore`, {
        method: "POST",
        body: JSON.stringify({ commit }),
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
      request<{ approved: number }>(`/orchestration/${projectId}/tasks/approve-all`, { method: "POST" }),
  },
};
