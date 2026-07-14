import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { AgentTerminal } from "./AgentTerminal";
import { ConfirmDialog } from "./ConfirmDialog";
import { parseActivity, getCtoPhase } from "./OrgChart";
import { AgentAvatar } from "./AgentAvatar";

interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
  current_task_id: string | null;
  system_prompt?: string;
  session_id?: string;
  parent_id?: string | null;
  prompt_source?: string;
  resolved_prompt_source?: string;
  resolved_prompt_file?: string;
  needs_worktree?: number;
  model?: string | null;
  provider?: string | null;
}

interface Task {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  verification_id: string | null;
  goal_id?: string | null;
}

interface AgentDetailProps {
  agent: Agent;
  agents?: Agent[];
  tasks: Task[];
  onClose: () => void;
  onKill: () => void;
  onDeleted?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  idle: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  working: "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400 animate-pulse",
  waiting_approval: "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30 dark:text-yellow-400",
  paused: "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400",
  terminated: "bg-red-100 text-red-500 dark:bg-red-900/30 dark:text-red-400",
};

const PROMPT_SOURCE_COLORS: Record<string, string> = {
  project: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  custom: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  preset: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  fallback: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
};

// Selectable roles for the role change dropdown (excludes legacy: coder, designer, custom)
const SELECTABLE_ROLES = ["cto", "backend", "frontend", "ux", "qa", "reviewer", "marketer", "devops"];

// Role → default model (mirrors server ROLE_DEFAULT_MODEL)
const ROLE_DEFAULT_MODEL: Record<string, string> = {
  cto: "opus", pm: "opus",
  backend: "sonnet", frontend: "sonnet", devops: "sonnet",
  qa: "sonnet", reviewer: "sonnet", ux: "sonnet",
  marketer: "sonnet", coder: "sonnet", designer: "sonnet",
};

const MODEL_LABELS: Record<string, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

const ROLE_LABELS: Record<string, string> = {
  cto: "CTO",
  backend: "Backend",
  frontend: "Frontend",
  ux: "UX",
  qa: "QA",
  reviewer: "Reviewer",
  marketer: "Marketer",
  devops: "DevOps",
  // Legacy — display only, not selectable
  coder: "Coder",
  designer: "Designer",
  custom: "Custom",
};

export function AgentDetail({ agent, agents = [], tasks, onClose, onKill, onDeleted }: AgentDetailProps) {
  const { t } = useTranslation();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState(agent.system_prompt ?? "");
  const [isSavingPrompt, setIsSavingPrompt] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Role editing state
  const [isEditingRole, setIsEditingRole] = useState(false);
  const [editedName, setEditedName] = useState(agent.name);
  const [editedRole, setEditedRole] = useState(agent.role);
  const [isSavingRole, setIsSavingRole] = useState(false);

  // Parent change state
  const [isChangingParent, setIsChangingParent] = useState(false);
  const [selectedParentId, setSelectedParentId] = useState<string | null>(agent.parent_id ?? null);
  const [isSavingParent, setIsSavingParent] = useState(false);
  const [parentError, setParentError] = useState<string | null>(null);

  // Resolved prompt source state (loaded from GET /agents/:id on mount)
  const [resolvedSource, setResolvedSource] = useState<string | undefined>(agent.resolved_prompt_source);
  const [resolvedFile, setResolvedFile] = useState<string | undefined>(agent.resolved_prompt_file);
  const [isSwitchingSource, setIsSwitchingSource] = useState(false);

  const HISTORY_THRESHOLD = 10;
  const [showAllHistory, setShowAllHistory] = useState(false);

  const agentTasks = useMemo(
    () => tasks.filter((t) => t.assignee_id === agent.id),
    [tasks, agent.id]
  );
  const currentTask = tasks.find((t) => t.id === agent.current_task_id);
  const passCount = useMemo(
    () => agentTasks.filter((t) => t.verification_id !== null).length,
    [agentTasks]
  );
  const failCount = useMemo(
    () => agentTasks.filter((t) => t.status === "blocked" && t.verification_id === null).length,
    [agentTasks]
  );

  // Affected tasks count for delete warning
  const affectedTaskCount = tasks.filter(
    (t) => t.assignee_id === agent.id && t.status !== "done"
  ).length;

  // Close on outside click (skip when confirm dialogs are open)
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (showKillConfirm || showDeleteConfirm) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, showKillConfirm, showDeleteConfirm]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Sync edited values when agent changes
  useEffect(() => {
    setEditedName(agent.name);
    setEditedRole(agent.role);
    setEditedPrompt(agent.system_prompt ?? "");
    setSelectedParentId(agent.parent_id ?? null);
    setIsChangingParent(false);
    setParentError(null);
  }, [agent.id, agent.name, agent.role, agent.system_prompt, agent.parent_id]);

  // Load resolved prompt source from server (list API does not include resolved fields)
  useEffect(() => {
    let cancelled = false;
    api.agents.get(agent.id).then((data) => {
      if (cancelled) return;
      setResolvedSource(data.resolved_prompt_source);
      setResolvedFile(data.resolved_prompt_file);
    }).catch(() => {
      // Non-critical — silently ignore
    });
    return () => { cancelled = true; };
  }, [agent.id]);

  const handleKillConfirm = async () => {
    setShowKillConfirm(false);
    await api.orchestration.killAgent(agent.id);
    onKill();
  };

  const handleDeleteConfirm = async () => {
    setShowDeleteConfirm(false);
    await api.agents.delete(agent.id);
    onDeleted?.();
    onClose();
  };

  const handleSavePrompt = async () => {
    setIsSavingPrompt(true);
    try {
      await api.agents.update(agent.id, { system_prompt: editedPrompt });
      setIsEditingPrompt(false);
      // After saving, reload resolved source (server sets prompt_source to 'custom')
      const data = await api.agents.get(agent.id);
      setResolvedSource(data.resolved_prompt_source);
      setResolvedFile(data.resolved_prompt_file);
    } finally {
      setIsSavingPrompt(false);
    }
  };

  const handleSwitchToCustom = async () => {
    setIsSwitchingSource(true);
    try {
      await api.agents.update(agent.id, { prompt_source: "custom" });
      setResolvedSource("custom");
      setResolvedFile(undefined);
      setPromptExpanded(true);
      setIsEditingPrompt(true);
    } finally {
      setIsSwitchingSource(false);
    }
  };

  const handleRestoreProjectSync = async () => {
    setIsSwitchingSource(true);
    try {
      await api.agents.update(agent.id, { system_prompt: "", prompt_source: "auto" });
      const data = await api.agents.get(agent.id);
      setResolvedSource(data.resolved_prompt_source);
      setResolvedFile(data.resolved_prompt_file);
      setEditedPrompt("");
      setIsEditingPrompt(false);
    } finally {
      setIsSwitchingSource(false);
    }
  };

  const handleCancelPromptEdit = () => {
    setEditedPrompt(agent.system_prompt ?? "");
    setIsEditingPrompt(false);
  };

  const handleSaveRole = async () => {
    setIsSavingRole(true);
    try {
      const updates: any = {};
      if (editedName !== agent.name) updates.name = editedName;
      if (editedRole !== agent.role) updates.role = editedRole;
      if (Object.keys(updates).length > 0) {
        await api.agents.update(agent.id, updates);
      }
      setIsEditingRole(false);
    } finally {
      setIsSavingRole(false);
    }
  };

  // Collect all descendant IDs of this agent (to exclude from parent selector)
  const getDescendantIds = (): Set<string> => {
    const result = new Set<string>();
    const queue = [agent.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      agents.forEach((a) => {
        if (a.parent_id === current && !result.has(a.id)) {
          result.add(a.id);
          queue.push(a.id);
        }
      });
    }
    return result;
  };

  const handleSaveParent = async () => {
    setIsSavingParent(true);
    setParentError(null);
    try {
      await api.agents.update(agent.id, { parent_id: selectedParentId });
      setIsChangingParent(false);
    } catch (err: any) {
      setParentError(err.message ?? t("circularRefError"));
    } finally {
      setIsSavingParent(false);
    }
  };

  // Get subordinates for this agent
  const subordinates = agents.filter((a) => a.parent_id === agent.id);
  const parentAgent = agents.find((a) => a.id === agent.parent_id);

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/20 dark:bg-black/40 z-40" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed top-0 right-0 h-full w-[400px] bg-white dark:bg-[#1e1e35] border-l border-gray-200 dark:border-gray-700 z-50 flex flex-col shadow-xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-3">
            <AgentAvatar name={agent.name} role={agent.role} size="lg" />
            <div>
              {isEditingRole ? (
                <div className="space-y-1.5">
                  <input
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    className="text-sm font-semibold text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-0.5 w-full focus:outline-none focus:border-blue-400"
                  />
                  <select
                    value={editedRole}
                    onChange={(e) => setEditedRole(e.target.value)}
                    className="text-[11px] text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-0.5 w-full focus:outline-none focus:border-blue-400"
                  >
                    {SELECTABLE_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>
                    ))}
                  </select>
                  <div className="flex gap-1.5">
                    <button
                      onClick={handleSaveRole}
                      disabled={isSavingRole}
                      className="px-2 py-0.5 text-[10px] bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
                    >
                      {t("savePrompt")}
                    </button>
                    <button
                      onClick={() => {
                        setEditedName(agent.name);
                        setEditedRole(agent.role);
                        setIsEditingRole(false);
                      }}
                      className="px-2 py-0.5 text-[10px] text-gray-500 hover:text-gray-700 dark:text-gray-400"
                    >
                      {t("cancel")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {agent.name}
                  </h2>
                  <div className="flex items-center gap-1.5">
                    <p className="text-xs text-gray-400 dark:text-gray-500 capitalize">{agent.role}</p>
                    <button
                      onClick={() => setIsEditingRole(true)}
                      className="text-[10px] text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
                    >
                      {t("changeRole")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent("crewdeck:open-agent", { detail: { agentId: agent.id } }));
              onClose();
            }}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500 transition-colors text-sm"
            title={t("openChat")}
            aria-label={t("openChat")}
          >
            💬
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("crewdeck:open-help"))}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500 transition-colors text-sm font-bold"
            title={t("helpTitle")}
            aria-label={t("helpTitle")}
          >
            ?
          </button>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("crewdeck:open-workspace", {
              detail: { agentId: agent.id, agentName: agent.name, goalId: null, taskId: null },
            }))}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500 transition-colors text-base"
            title={t("wsOpen")}
            aria-label={t("wsOpen")}
          >
            ⤢
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500 transition-colors"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {/* Status + Session */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium mb-3">
              {t("agentDetailSessionInfo")}
            </h3>
            <div className="space-y-2">
              {(() => {
                const phase = getCtoPhase((agent as any).current_activity);
                const isCtoSupport = agent.status === "working" && phase;
                const statusBadgeClass = isCtoSupport
                  ? "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                  : (STATUS_COLORS[agent.status] ?? STATUS_COLORS.idle);
                const statusLabel = isCtoSupport
                  ? t(phase === "architect" ? "statusArchitect" : phase === "decompose" ? "statusDecompose" : "statusSpecGen")
                  : t({
                      idle: "statusIdle",
                      working: "statusWorking",
                      waiting_approval: "statusWaitingApproval",
                      paused: "statusPaused",
                      terminated: "statusTerminated",
                    }[agent.status] ?? "statusIdle");
                return (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 dark:text-gray-400">{t("agentDetailStatus")}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${statusBadgeClass}`}>
                      {statusLabel}
                    </span>
                  </div>
                );
              })()}
              {agent.session_id && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500 dark:text-gray-400">{t("agentDetailSessionId")}</span>
                  <span className="text-[10px] font-mono text-gray-400 dark:text-gray-500">
                    {agent.session_id.slice(0, 12)}...
                  </span>
                </div>
              )}
              {currentTask ? (
                <div className="flex items-start justify-between gap-3">
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    {getCtoPhase((agent as any).current_activity)
                      ? t("agentDetailDesignFor")
                      : t("agentDetailCurrentTask")}
                  </span>
                  <span className={`text-xs text-right ${getCtoPhase((agent as any).current_activity) ? "text-blue-600 dark:text-blue-400" : "text-gray-700 dark:text-gray-300"}`}>
                    {currentTask.title}
                  </span>
                </div>
              ) : (agent as any).current_activity ? (
                <div className="flex items-start justify-between gap-3">
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                    {getCtoPhase((agent as any).current_activity)
                      ? t("agentDetailDesignFor")
                      : t("agentDetailCurrentTask")}
                  </span>
                  <span className={`text-xs text-right ${getCtoPhase((agent as any).current_activity) ? "text-blue-600 dark:text-blue-400" : "text-indigo-600 dark:text-indigo-400"}`}>
                    {parseActivity((agent as any).current_activity, t)}
                  </span>
                </div>
              ) : null}
            </div>
          </section>

          {/* Org Context — parent + subordinates */}
          {(agents.length > 0 || subordinates.length > 0) && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium mb-3">
                {t("orgContext")}
              </h3>
              <div className="space-y-1.5">
                {/* Reports-to row with change button */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{t("reportsTo")}</span>
                  {isChangingParent ? (
                    <div className="flex items-center gap-1.5 flex-1 justify-end">
                      <select
                        value={selectedParentId ?? ""}
                        onChange={(e) => setSelectedParentId(e.target.value || null)}
                        className="text-[11px] text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-0.5 focus:outline-none focus:border-blue-400 max-w-[160px]"
                      >
                        <option value="">{t("noParentTopLevel")}</option>
                        {agents
                          .filter((a) => {
                            if (a.id === agent.id) return false;
                            if (getDescendantIds().has(a.id)) return false;
                            return true;
                          })
                          .map((a) => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                      </select>
                      <button
                        onClick={handleSaveParent}
                        disabled={isSavingParent}
                        className="px-2 py-0.5 text-[10px] bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
                      >
                        {t("savePrompt")}
                      </button>
                      <button
                        onClick={() => {
                          setIsChangingParent(false);
                          setSelectedParentId(agent.parent_id ?? null);
                          setParentError(null);
                        }}
                        className="text-[10px] text-gray-500 hover:text-gray-700 dark:text-gray-400"
                      >
                        {t("cancel")}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      {parentAgent ? (
                        <>
                          <AgentAvatar name={parentAgent.name} role={parentAgent.role} size="xs" />
                          <span className="text-xs text-gray-700 dark:text-gray-300">{parentAgent.name}</span>
                        </>
                      ) : (
                        <span className="text-xs text-gray-400 dark:text-gray-500">—</span>
                      )}
                      <button
                        onClick={() => setIsChangingParent(true)}
                        className="text-[10px] text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
                      >
                        {t("changeParent")}
                      </button>
                    </div>
                  )}
                </div>
                {parentError && (
                  <p className="text-[10px] text-red-500 dark:text-red-400">{parentError}</p>
                )}
                {subordinates.length > 0 && (
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{t("manages")}</span>
                    <div className="flex flex-wrap gap-1 justify-end">
                      {subordinates.map((s) => (
                        <span key={s.id} className="text-[10px] px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded">
                          {s.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Live Terminal — only while working */}
          {agent.status === "working" && (
            <AgentTerminal agentId={agent.id} />
          )}

          {/* Model Selection */}
          <section className="px-3 py-2.5 border border-gray-100 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800/50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">AI 모델</span>
              <select
                value={agent.model ?? ""}
                onChange={async (e) => {
                  const val = e.target.value || null;
                  await api.agents.update(agent.id, { model: val });
                  window.dispatchEvent(new CustomEvent("crewdeck:refresh"));
                }}
                className="text-xs bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="">기본 ({MODEL_LABELS[ROLE_DEFAULT_MODEL[agent.role] ?? "sonnet"] ?? "Sonnet"})</option>
                <option value="opus">Opus — 설계/기획 (고성능)</option>
                <option value="sonnet">Sonnet — 구현/리뷰 (균형)</option>
                <option value="haiku">Haiku — 단순 작업 (경제적)</option>
              </select>
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 leading-relaxed">
              {agent.model
                ? `${MODEL_LABELS[agent.model]} 모델을 사용합니다 (직접 설정).`
                : `역할 기본값: ${MODEL_LABELS[ROLE_DEFAULT_MODEL[agent.role] ?? "sonnet"]}. 변경하려면 위에서 선택하세요.`}
            </p>
          </section>

          {/* Execution Engine (Claude / Codex) */}
          <section className="px-3 py-2.5 border border-gray-100 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800/50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">실행 엔진</span>
              <select
                value={agent.provider ?? ""}
                onChange={async (e) => {
                  const val = e.target.value || null;
                  await api.agents.update(agent.id, { provider: val });
                  window.dispatchEvent(new CustomEvent("crewdeck:refresh"));
                }}
                className="text-xs bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-2 py-1 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="">자동 (프로젝트 기본)</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 leading-relaxed">
              {agent.provider
                ? `${agent.provider === "codex" ? "Codex" : "Claude"} 엔진으로 실행합니다. 한도·오류 시 다른 엔진으로 자동 전환됩니다.`
                : "프로젝트 기본 엔진을 상속합니다. 한도·오류 시 자동 전환(failover)됩니다. 변경은 다음 실행부터 적용돼요."}
            </p>
          </section>

          {/* Worktree Toggle */}
          <section className="px-3 py-2.5 border border-gray-100 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800/50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300">워크트리 격리</span>
              <button
                onClick={async () => {
                  const next = agent.needs_worktree ? 0 : 1;
                  await api.agents.update(agent.id, { needs_worktree: next });
                  window.dispatchEvent(new CustomEvent("crewdeck:refresh"));
                }}
                role="switch"
                aria-checked={!!agent.needs_worktree}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                  agent.needs_worktree ? "bg-blue-500" : "bg-gray-200 dark:bg-gray-600"
                }`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                  agent.needs_worktree ? "translate-x-4.5" : "translate-x-0.5"
                }`} />
              </button>
            </div>
            <div className="text-[10px] text-gray-400 dark:text-gray-500 leading-relaxed space-y-1">
              {agent.needs_worktree ? (
                <>
                  <p>ON — 별도 복사본에서 코드를 수정합니다. 다른 에이전트 작업과 충돌하지 않습니다.</p>
                  <p className="text-gray-300 dark:text-gray-600">ex) backend-dev, frontend-dev 등 코드를 작성하는 에이전트</p>
                </>
              ) : (
                <>
                  <p>OFF — 프로젝트 원본에서 직접 읽습니다. 다른 에이전트가 만든 파일도 바로 볼 수 있습니다.</p>
                  <p className="text-gray-300 dark:text-gray-600">ex) 코드 리뷰어, QA 등 파일을 읽기만 하는 에이전트</p>
                </>
              )}
            </div>
          </section>

          {/* System Prompt */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <button
                onClick={() => setPromptExpanded((v) => !v)}
                className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <span>{t("systemPrompt")}</span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`transition-transform ${promptExpanded ? "rotate-180" : ""}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              <div className="flex items-center gap-2">
                {/* Prompt source badge */}
                {resolvedSource && (
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                      PROMPT_SOURCE_COLORS[resolvedSource] ?? PROMPT_SOURCE_COLORS.fallback
                    }`}
                  >
                    {t(
                      resolvedSource === "project"
                        ? "promptSourceProject"
                        : resolvedSource === "custom"
                        ? "promptSourceCustom"
                        : resolvedSource === "preset"
                        ? "promptSourcePreset"
                        : "promptSourceFallback"
                    )}
                  </span>
                )}
                {!isEditingPrompt && resolvedSource !== "project" && (
                  <button
                    onClick={() => { setPromptExpanded(true); setIsEditingPrompt(true); }}
                    className="text-[10px] text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
                  >
                    {t("editPrompt")}
                  </button>
                )}
              </div>
            </div>

            {/* Source file path (project mode) */}
            {resolvedSource === "project" && resolvedFile && (
              <p className="text-[10px] text-gray-400 dark:text-gray-500 font-mono mb-2">
                {t("promptSourceFile", { file: resolvedFile })}
              </p>
            )}

            {promptExpanded && (
              <>
                {isEditingPrompt ? (
                  <div className="space-y-2">
                    <textarea
                      value={editedPrompt}
                      onChange={(e) => setEditedPrompt(e.target.value)}
                      rows={8}
                      className="w-full text-[11px] text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 rounded-lg p-3 font-mono leading-relaxed border border-blue-300 dark:border-blue-600 focus:outline-none focus:border-blue-400 resize-y"
                    />
                    <p className="text-[10px] text-gray-400 dark:text-gray-500 italic">
                      {t("promptHint")}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={handleSavePrompt}
                        disabled={isSavingPrompt}
                        className="px-3 py-1 text-[11px] bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 transition-colors"
                      >
                        {t("savePrompt")}
                      </button>
                      <button
                        onClick={handleCancelPromptEdit}
                        className="px-3 py-1 text-[11px] text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                      >
                        {t("cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <pre className="text-[11px] text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-lg p-3 whitespace-pre-wrap font-mono leading-relaxed border border-gray-100 dark:border-gray-700">
                    {editedPrompt || <span className="text-gray-300 dark:text-gray-600 italic">—</span>}
                  </pre>
                )}

                {/* Source-specific action buttons */}
                {!isEditingPrompt && resolvedSource === "project" && (
                  <button
                    onClick={handleSwitchToCustom}
                    disabled={isSwitchingSource}
                    className="mt-2 text-[10px] text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 disabled:opacity-50 transition-colors"
                  >
                    {t("switchToCustom")}
                  </button>
                )}
                {!isEditingPrompt && resolvedSource === "custom" && (
                  <button
                    onClick={handleRestoreProjectSync}
                    disabled={isSwitchingSource}
                    className="mt-2 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50 transition-colors"
                  >
                    {t("restoreProjectSync")}
                  </button>
                )}
                {!isEditingPrompt && (resolvedSource === "preset" || resolvedSource === "fallback") && (
                  <p className="mt-2 text-[10px] text-gray-400 dark:text-gray-500 italic">
                    {t("noProjectAgentFile")}
                  </p>
                )}
              </>
            )}
          </section>

          {/* Verification Stats */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium mb-3">
              {t("agentDetailVerificationStats")}
            </h3>
            <div className="flex gap-3">
              <div className="flex-1 bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-center border border-green-100 dark:border-green-800/30">
                <div className="text-xl font-bold text-green-600 dark:text-green-400">
                  {passCount}
                </div>
                <div className="text-[10px] text-green-500 dark:text-green-500 mt-0.5">{t("agentDetailVerified")}</div>
              </div>
              <div className="flex-1 bg-red-50 dark:bg-red-900/20 rounded-lg p-3 text-center border border-red-100 dark:border-red-800/30">
                <div className="text-xl font-bold text-red-500 dark:text-red-400">
                  {failCount}
                </div>
                <div className="text-[10px] text-red-400 dark:text-red-500 mt-0.5">{t("agentDetailBlocked")}</div>
              </div>
              <div className="flex-1 bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center border border-gray-100 dark:border-gray-700">
                <div className="text-xl font-bold text-gray-600 dark:text-gray-300">
                  {agentTasks.length}
                </div>
                <div className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">{t("agentDetailTotal")}</div>
              </div>
            </div>
          </section>

          {/* Task History */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 font-medium mb-3">
              {t("agentDetailTaskHistory")} ({agentTasks.length})
            </h3>
            {agentTasks.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-gray-500">{t("agentDetailNoTasks")}</p>
            ) : (
              <>
                <div className="space-y-1.5">
                  {(showAllHistory ? agentTasks : agentTasks.slice(0, HISTORY_THRESHOLD)).map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700"
                    >
                      <span className="text-xs text-gray-700 dark:text-gray-300 truncate flex-1 mr-2">
                        {task.title}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {task.verification_id && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded">
                            {t("verified")}
                          </span>
                        )}
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 capitalize">
                          {task.status.replace(/_/g, " ")}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                {agentTasks.length > HISTORY_THRESHOLD && (
                  <button
                    onClick={() => setShowAllHistory((v) => !v)}
                    className="mt-2 text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                  >
                    {showAllHistory
                      ? t("showLessDone")
                      : t("showMoreLogs", { count: agentTasks.length - HISTORY_THRESHOLD })}
                  </button>
                )}
              </>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 shrink-0 space-y-3">
          {/* Kill / Delete buttons */}
          <div className="space-y-2">
            {agent.status === "working" && (
              <button
                onClick={() => setShowKillConfirm(true)}
                className="w-full py-2 text-sm font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                {t("agentDetailKillSession")}
              </button>
            )}
            <button
              onClick={async () => {
                try {
                  await api.agents.clone(agent.id);
                  window.dispatchEvent(new CustomEvent("crewdeck:refresh"));
                } catch { /* ignore */ }
              }}
              className="w-full py-2 text-sm font-medium text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              {t("cloneAgent")}
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="w-full py-2 text-sm font-medium text-red-700 dark:text-red-500 border border-red-300 dark:border-red-700 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              {t("deleteAgent")}
            </button>
          </div>
        </div>
      </div>

      {/* ConfirmDialogs — must render AFTER panel so z-index stacks correctly */}
      {showKillConfirm && (
        <ConfirmDialog
          message={t("confirmKillAgent")}
          onConfirm={handleKillConfirm}
          onCancel={() => setShowKillConfirm(false)}
        />
      )}
      {showDeleteConfirm && (
        <ConfirmDialog
          message={
            affectedTaskCount > 0
              ? t("deleteAgentConfirmWithTasks", { count: affectedTaskCount })
              : t("deleteAgentConfirm")
          }
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </>
  );
}
