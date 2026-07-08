const BASE = "/api";

// Auth — API key management
let apiKey: string | null = localStorage.getItem("nova-orbit-api-key");

export function setApiKey(key: string): void {
  apiKey = key;
  localStorage.setItem("nova-orbit-api-key", key);
}

export function getApiKey(): string | null {
  return apiKey;
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
    localStorage.removeItem("nova-orbit-api-key");
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
      window.dispatchEvent(new CustomEvent("nova:server-status", { detail: { up: true } }));
    }
    if (!res.ok) {
      if (res.status === 401 && (await tryReauth())) {
        // 새 키 확보 — 전체 상태(WS 포함)를 깨끗하게 다시 세우기 위해 리로드
        window.location.reload();
        return new Promise<never>(() => {});
      }
      const body = await res.json().catch(() => ({ error: res.statusText }));
      const err = new Error(body.error ?? "Request failed");
      (err as any).status = res.status;
      (err as any).detail = body.detail;
      throw err;
    }
    return res.json();
  } catch (err: any) {
    // Network error = server is down
    if (err instanceof TypeError && err.message.includes("fetch")) {
      serverDown = true;
      window.dispatchEvent(new CustomEvent("nova:server-status", { detail: { up: false } }));
    }
    throw err;
  }
}

// Projects
export const api = {
  projects: {
    list: () => request<any[]>("/projects"),
    get: (id: string) => request<any>(`/projects/${id}`),
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
    suggestMission: (id: string) =>
      request<{ mission: string; reason: string }>(`/projects/${id}/suggest-mission`, { method: "POST" }),
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
      request<any[]>("/agents/suggest", { method: "POST", body: JSON.stringify({ mission, project_id: projectId, techStack, mode, refresh }) }),
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
    deleteAll: (projectId: string) => request<{ success: boolean; deleted: number }>(`/agents/bulk/${projectId}`, { method: "DELETE" }),
    stats: (id: string) =>
      request<{ taskCount: number; totalTokens: number; totalCostUsd: number }>(`/agents/${id}/stats`),
  },
  goals: {
    list: (projectId: string) => request<any[]>(`/goals?projectId=${projectId}`),
    create: (data: any) => request<any>("/goals", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: any) =>
      request<any>(`/goals/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: string) => request<any>(`/goals/${id}`, { method: "DELETE" }),
    getSpec: (goalId: string) => request<any>(`/goals/${goalId}/spec`),
    updateSpec: (goalId: string, data: any) =>
      request<any>(`/goals/${goalId}/spec`, { method: "PATCH", body: JSON.stringify(data) }),
    generateSpec: (goalId: string) =>
      request<any>(`/goals/${goalId}/generate-spec`, { method: "POST" }),
    refineSpec: (goalId: string, prompt: string) =>
      request<any>(`/goals/${goalId}/refine-spec`, { method: "POST", body: JSON.stringify({ prompt }) }),
    suggest: (projectId: string, count?: number) =>
      request<Array<{ title: string; description: string; priority: string; reason: string }>>("/goals/suggest", { method: "POST", body: JSON.stringify({ project_id: projectId, count }) }),
    squashPreview: (goalId: string) =>
      request<{ goalId: string; squashStatus: string; commitMessage: string; filesChanged: string[]; acceptanceScript: string | null }>(
        `/goals/${goalId}/squash-preview`,
      ),
    squashApprove: (goalId: string) =>
      request<{ success: boolean; sha?: string; prUrl?: string; error?: string }>(
        `/goals/${goalId}/squash-approve`, { method: "POST" }
      ),
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
