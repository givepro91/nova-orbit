import { useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "./AgentAvatar";
import { AgentDetail } from "./AgentDetail";
import { ConfirmDialog } from "./ConfirmDialog";
import { AgentWorkflowGuide } from "./AgentWorkflowGuide";
import { api } from "../lib/api";

/** Parse activity key (e.g. "task:Build API" → { key: "activityTask", name: "Build API" }) */
export function parseActivity(raw: string | null | undefined, t: (k: string, opts?: any) => string): string | null {
  if (!raw) return null;
  const ACTIVITY_MAP: Record<string, string> = {
    "task": "activityTask",
    "fix": "activityFix",
    "review": "activityReview",
    "spec_gen": "activitySpecGen",
    "decompose": "activityDecompose",
    "architect": "activityArchitect",
    "goal_generation": "activityGoalGen",
    "branch_merge": "activityBranchMerge",
  };
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    const prefix = raw.slice(0, colonIdx);
    const name = raw.slice(colonIdx + 1);
    const key = ACTIVITY_MAP[prefix];
    if (key) return t(key, { name });
  }
  // No colon — try exact match
  const key = ACTIVITY_MAP[raw];
  if (key) return t(key);
  return raw; // fallback: show raw
}

/** CTO 보조 활동(설계/분할/기획서) 여부 — UX에서 "작업 중"과 구분 */
export type CtoPhase = "architect" | "decompose" | "spec_gen" | null;
export function getCtoPhase(activity: string | null | undefined): CtoPhase {
  if (!activity) return null;
  if (activity.startsWith("architect:")) return "architect";
  if (activity.startsWith("decompose:")) return "decompose";
  if (activity.startsWith("spec_gen:")) return "spec_gen";
  return null;
}

/** BFS로 agentId의 모든 하위 노드 ID 집합 반환 (순환 방지용) */
function getDescendantIds(agents: Agent[], agentId: string): Set<string> {
  const ids = new Set<string>();
  const queue = [agentId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const a of agents) {
      if (a.parent_id === current && !ids.has(a.id)) {
        ids.add(a.id);
        queue.push(a.id);
      }
    }
  }
  return ids;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
  parent_id: string | null;
  current_task_id: string | null;
  system_prompt?: string;
  session_id?: string;
  project_id: string;
}

interface OrgChartProps {
  agents: any[];
  tasks: any[];
  onAddAgent: () => void;
  onAgentDeleted: () => void;
  onAgentKilled: () => void;
}

const STATUS_DOT: Record<string, string> = {
  working: "bg-green-400 animate-pulse",
  paused: "bg-yellow-400",
  waiting_approval: "bg-yellow-400",
  terminated: "bg-red-400",
  idle: "bg-gray-300 dark:bg-gray-600",
};

const STATUS_LABEL: Record<string, string> = {
  working: "working",
  paused: "paused",
  waiting_approval: "waiting",
  terminated: "terminated",
  idle: "idle",
};


interface NodeProps {
  agent: Agent;
  agents: Agent[];
  childrenMap: Record<string, Agent[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onQuickPrompt: (agent: Agent) => void;
  onDrop: (draggedId: string, targetId: string) => void;
  dragOverId: string | null;
  onDragOverChange: (id: string | null) => void;
  depth: number;
  isLast: boolean;
}

function OrgNode({ agent, agents, childrenMap, selectedId, onSelect, onQuickPrompt, onDrop, dragOverId, onDragOverChange, depth }: NodeProps) {
  const { t } = useTranslation();
  const children = childrenMap[agent.id] ?? [];
  const isSelected = selectedId === agent.id;
  const isWorking = agent.status === "working";
  const isDragOver = dragOverId === agent.id;

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", agent.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOverChange(agent.id);
  };

  const handleDragLeave = () => {
    onDragOverChange(null);
  };

  const handleDropOnNode = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDragOverChange(null);
    const draggedId = e.dataTransfer.getData("text/plain");
    if (draggedId && draggedId !== agent.id) {
      onDrop(draggedId, agent.id);
    }
  };

  return (
    <div className="flex flex-col items-center">
      {/* Node card — extra padding for the quick-prompt button */}
      <div className="relative group p-1">
        <button
          draggable
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDropOnNode}
          onClick={() => onSelect(agent.id)}
          className={`relative flex flex-col items-center gap-1 px-3 py-2 rounded-xl border transition-all w-[120px] shrink-0 text-center cursor-grab active:cursor-grabbing ${
            isDragOver
              ? "border-blue-500 bg-blue-100 dark:bg-blue-900/30 ring-2 ring-blue-300 dark:ring-blue-600 scale-105"
              : isSelected
              ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20 shadow-sm shadow-blue-200 dark:shadow-blue-900/40"
              : isWorking && getCtoPhase((agent as any).current_activity)
              ? "border-blue-300 dark:border-blue-700 bg-blue-50/60 dark:bg-blue-900/10 hover:border-blue-400"
              : isWorking
              ? "border-green-300 dark:border-green-700 bg-green-50/60 dark:bg-green-900/10 hover:border-green-400"
              : "border-gray-200 dark:border-gray-700 bg-white dark:bg-[#25253d] hover:border-gray-300 dark:hover:border-gray-600"
          }`}
        >
          <AgentAvatar name={agent.name} role={agent.role} size="sm" showBadge={true} />
          <span className="text-[11px] font-medium text-gray-800 dark:text-gray-200 leading-tight truncate w-full">
            {agent.name}
          </span>
          {(() => {
            const phase = getCtoPhase((agent as any).current_activity);
            const isCtoSupport = isWorking && phase;
            const dotClass = isCtoSupport
              ? "bg-blue-400 animate-pulse"
              : (STATUS_DOT[agent.status] ?? STATUS_DOT.idle);
            const labelText = isCtoSupport
              ? t(phase === "architect" ? "statusArchitect" : phase === "decompose" ? "statusDecompose" : "statusSpecGen")
              : (STATUS_LABEL[agent.status] ?? "idle");
            const labelClass = isCtoSupport
              ? "text-blue-500 dark:text-blue-400"
              : "text-gray-400 dark:text-gray-500";
            return (
              <>
                <div className="flex items-center gap-1 justify-center">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
                  <span className={`text-[9px] capitalize ${labelClass}`}>{labelText}</span>
                </div>
                {isWorking && (agent as any).current_activity && (
                  <p className={`text-[8px] truncate w-full px-1 leading-tight ${isCtoSupport ? "text-blue-400 dark:text-blue-300" : "text-indigo-500 dark:text-indigo-400"}`}>
                    {parseActivity((agent as any).current_activity, t)}
                  </p>
                )}
              </>
            );
          })()}
        </button>

        {/* Quick prompt button — inside padded container to avoid clipping */}
        {!isWorking && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onQuickPrompt(agent);
            }}
            title="Direct prompt"
            className="absolute top-0 right-0 w-5 h-5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:scale-110 z-10"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        )}
      </div>

      {/* Children */}
      {children.length > 0 && (
        <div className="flex flex-col items-center">
          {/* Vertical connector from parent */}
          <div className="w-px h-5 bg-gray-200 dark:bg-gray-700" />

          {/* Children — wrap 가능한 행. 팀이 커도 가로 스크롤 없이 여러 줄로 흐른다.
              단일-행 T-커넥터 대신 자식마다 짧은 세로 스텁을 둬 wrap에서도 안 깨진다. */}
          <div className="flex flex-wrap items-start justify-center gap-x-2 max-w-full">
            {children.map((child) => (
              <div key={child.id} className="flex flex-col items-center">
                <div className="w-px h-5 bg-gray-200 dark:bg-gray-700" />
                <OrgNode
                  agent={child}
                  agents={agents}
                  childrenMap={childrenMap}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onQuickPrompt={onQuickPrompt}
                  onDrop={onDrop}
                  dragOverId={dragOverId}
                  onDragOverChange={onDragOverChange}
                  depth={depth + 1}
                  isLast={false}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline quick prompt popover */
function QuickPromptPopover({
  agent,
  onClose,
  onSent,
}: {
  agent: Agent;
  onClose: () => void;
  onSent: () => void;
}) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(async () => {
    const msg = message.trim();
    if (!msg || sending) return;
    setSending(true);
    try {
      await api.orchestration.sendPrompt(agent.id, msg);
      onSent();
    } catch {
      // error
    } finally {
      setSending(false);
      onClose();
    }
  }, [message, sending, agent.id, onClose, onSent]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 dark:bg-black/40" onClick={onClose}>
      <div
        className="bg-white dark:bg-[#1e1e35] border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-[400px] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <AgentAvatar name={agent.name} role={agent.role} size="sm" />
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{agent.name}</p>
            <p className="text-[10px] text-gray-400 capitalize">{agent.role}</p>
          </div>
        </div>
        <textarea
          ref={textareaRef}
          autoFocus
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSend();
            }
            if (e.key === "Escape") onClose();
          }}
          placeholder={t("promptPlaceholder")}
          rows={3}
          className="w-full text-xs text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 border border-gray-200 dark:border-gray-700 focus:outline-none focus:border-blue-400 resize-none"
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] text-gray-400">Cmd+Enter</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !message.trim()}
              className="px-3 py-1 text-xs font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg hover:bg-gray-700 dark:hover:bg-gray-100 disabled:opacity-40 transition-colors"
            >
              {sending ? t("promptRunning") : t("sendPrompt")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OrgChart({ agents, tasks, onAddAgent, onAgentDeleted, onAgentKilled }: OrgChartProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [quickPromptAgent, setQuickPromptAgent] = useState<Agent | null>(null);
  const [showWorkflowGuide, setShowWorkflowGuide] = useState(false);

  // Drag & drop state
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{ draggedId: string; targetId: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const handleDrop = useCallback((draggedId: string, targetId: string) => {
    // 순환 참조 방지: target이 dragged의 하위 노드이면 차단
    const descendants = getDescendantIds(agents, draggedId);
    if (descendants.has(targetId)) {
      showToast(t("circularRefError"));
      return;
    }
    // 이미 같은 parent면 무시
    const dragged = agents.find((a) => a.id === draggedId);
    if (dragged?.parent_id === targetId) return;

    setPendingDrop({ draggedId, targetId });
  }, [agents, showToast, t]);

  const handleConfirmDrop = useCallback(async () => {
    if (!pendingDrop) return;
    const { draggedId, targetId } = pendingDrop;
    setPendingDrop(null);
    try {
      await api.agents.update(draggedId, { parent_id: targetId });
      const dragged = agents.find((a) => a.id === draggedId);
      const target = agents.find((a) => a.id === targetId);
      showToast(t("dragDropComplete", { dragged: dragged?.name ?? "", target: target?.name ?? "" }));
      onAgentDeleted(); // refresh
    } catch {
      showToast(t("dragDropFailed"));
    }
  }, [pendingDrop, agents, showToast, t, onAgentDeleted]);

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  // useMemo로 parentId → children[] 맵 1회 생성
  const childrenMap = useMemo(() => {
    return agents.reduce<Record<string, Agent[]>>((acc, a) => {
      const key = a.parent_id ?? "__root__";
      if (!acc[key]) acc[key] = [];
      acc[key].push(a);
      return acc;
    }, {});
  }, [agents]);

  // parent_id가 null인 루트 노드들
  const roots = childrenMap["__root__"] ?? [];

  const handleClose = () => setSelectedId(null);
  const handleKill = () => {
    onAgentKilled();
    setSelectedId(null);
  };
  const handleDeleted = () => {
    onAgentDeleted();
    setSelectedId(null);
  };

  const handleDeleteAll = async () => {
    setShowDeleteAllConfirm(false);
    if (agents.length === 0) return;
    const projectId = agents[0].project_id;
    await api.agents.deleteAll(projectId);
    onAgentDeleted();
  };

  if (agents.length === 0) {
    return (
      <>
        {showWorkflowGuide && <AgentWorkflowGuide onClose={() => setShowWorkflowGuide(false)} />}
        <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
          <div className="text-4xl mb-3 opacity-30">🤖</div>
          <p className="text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">
            {t("noAgentsOrgChart")}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-4 max-w-xs">
            {t("noAgentsOrgChartDesc")}
          </p>
          <button
            onClick={onAddAgent}
            className="text-xs px-4 py-2 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors font-medium mb-3"
          >
            {t("addAgent")}
          </button>
          <button
            onClick={() => setShowWorkflowGuide(true)}
            className="text-xs text-blue-500 dark:text-blue-400 hover:underline"
          >
            {t("learnWorkflow")}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Workflow guide modal */}
      {showWorkflowGuide && <AgentWorkflowGuide onClose={() => setShowWorkflowGuide(false)} />}

      {/* Confirm delete all */}
      {showDeleteAllConfirm && (
        <ConfirmDialog
          message={t("deleteAllAgentsConfirm", { count: agents.length })}
          onConfirm={handleDeleteAll}
          onCancel={() => setShowDeleteAllConfirm(false)}
        />
      )}

      {/* Drag & drop confirm dialog */}
      {pendingDrop && (() => {
        const dragged = agents.find((a) => a.id === pendingDrop.draggedId);
        const target = agents.find((a) => a.id === pendingDrop.targetId);
        return (
          <ConfirmDialog
            message={t("dragDropConfirm", { dragged: dragged?.name ?? "", target: target?.name ?? "" })}
            onConfirm={handleConfirmDrop}
            onCancel={() => setPendingDrop(null)}
          />
        );
      })()}

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-xs font-medium rounded-lg shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      {/* Quick prompt popover */}
      {quickPromptAgent && (
        <QuickPromptPopover
          agent={quickPromptAgent}
          onClose={() => setQuickPromptAgent(null)}
          onSent={() => setQuickPromptAgent(null)}
        />
      )}

      {/* AgentDetail slide-over */}
      {selectedAgent && (
        <AgentDetail
          agent={selectedAgent}
          agents={agents}
          tasks={tasks}
          onClose={handleClose}
          onKill={handleKill}
          onDeleted={handleDeleted}
        />
      )}

      <div className="flex gap-6 items-start">
        {/* Org tree — left panel */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                {t("orgChartTitle")}
              </h2>
              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                {t("agentCount", { count: agents.length })}
              </span>
              <button
                onClick={() => setShowWorkflowGuide(true)}
                title={t("learnWorkflow")}
                className="w-4 h-4 rounded-full border border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-500 dark:hover:text-blue-400 flex items-center justify-center transition-colors text-[9px] font-bold shrink-0"
              >
                ?
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDeleteAllConfirm(true)}
                className="text-[11px] px-2.5 py-1.5 text-red-500 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                {t("deleteAllAgents")}
              </button>
              <button
                onClick={onAddAgent}
                className="text-xs px-3 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-lg hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors font-medium"
              >
                {t("addAgent")}
              </button>
            </div>
          </div>

          {/* Tree — 가로 스크롤 없이 너비에 맞춰 wrap */}
          <div className="pb-4">
            <div className="flex flex-wrap gap-x-8 gap-y-8 items-start justify-center px-4">
              {roots.map((root) => (
                <OrgNode
                  key={root.id}
                  agent={root}
                  agents={agents}
                  childrenMap={childrenMap}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onQuickPrompt={setQuickPromptAgent}
                  onDrop={handleDrop}
                  dragOverId={dragOverId}
                  onDragOverChange={setDragOverId}
                  depth={0}
                  isLast={true}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Selected agent detail — right hint panel (lightweight, not the slide-over) */}
        {!selectedAgent && (
          <div className="w-[200px] shrink-0 hidden lg:block">
            <div className="border border-dashed border-gray-200 dark:border-gray-700 rounded-xl p-4 text-center">
              <p className="text-[11px] text-gray-400 dark:text-gray-500">
                {t("orgChartHint")}
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
