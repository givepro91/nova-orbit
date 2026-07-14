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

/** name suffix "· N팀"으로 소속 팀 판별. suffix 없으면 기본 "1팀" (원본 로스터). */
function teamOf(name: string): string {
  const m = /·\s*([^·]+?)팀\s*$/.exec(name ?? "");
  return m ? `${m[1].trim()}팀` : "1팀";
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
  onDuplicateTeam?: () => void;
}

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
          title={agent.name}
          className={`relative flex flex-col gap-1.5 px-3 py-2.5 rounded-xl border transition-all w-[188px] shrink-0 text-left cursor-grab active:cursor-grabbing outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            isDragOver
              ? "border-accent bg-accent/20 ring-2 ring-accent"
              : isSelected
              ? "border-accent bg-accent/10 shadow-md"
              : isWorking && getCtoPhase((agent as any).current_activity)
              ? "border-accent bg-accent/10 hover:border-accent"
              : isWorking
              ? "border-success bg-success-subtle hover:border-success"
              : "border-line bg-surface hover:border-line"
          }`}
        >
          <div className="flex items-start gap-2 w-full">
            <AgentAvatar name={agent.name} role={agent.role} size="sm" showBadge={true} />
            <div className="min-w-0 flex-1">
              <p className="text-[9px] uppercase tracking-wide text-faint leading-none mb-0.5 truncate">
                {agent.role}
              </p>
              <p className="text-xs font-semibold text-fg leading-tight line-clamp-2 break-words">
                {agent.name}
              </p>
            </div>
          </div>
          {(() => {
            const phase = getCtoPhase((agent as any).current_activity);
            const isCtoSupport = isWorking && phase;
            let badgeText: string;
            let badgeClass: string;
            let dot: string;
            if (isCtoSupport) {
              badgeText = t(phase === "architect" ? "statusArchitect" : phase === "decompose" ? "statusDecompose" : "statusSpecGen");
              badgeClass = "text-accent bg-accent/10";
              dot = "bg-accent animate-pulse";
            } else if (isWorking) {
              badgeText = t("statusWorking");
              badgeClass = "text-success bg-success-subtle font-semibold";
              dot = "bg-success animate-pulse";
            } else if (agent.status === "paused") {
              badgeText = t("statusPaused");
              badgeClass = "text-warning bg-warning-subtle";
              dot = "bg-warning";
            } else if (agent.status === "waiting_approval") {
              badgeText = t("statusWaitingApproval");
              badgeClass = "text-warning bg-warning-subtle";
              dot = "bg-warning";
            } else if (agent.status === "terminated") {
              badgeText = t("statusTerminated");
              badgeClass = "text-danger bg-danger-subtle";
              dot = "bg-danger";
            } else {
              badgeText = t("statusIdle");
              badgeClass = "text-muted bg-sunken";
              dot = "bg-faint";
            }
            return (
              <>
                <span className={`inline-flex items-center gap-1 self-start px-1.5 py-0.5 rounded-full text-[10px] ${badgeClass}`}>
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                  {badgeText}
                </span>
                {isWorking && (agent as any).current_activity && (
                  <p className={`text-[10px] leading-snug line-clamp-2 ${isCtoSupport ? "text-accent" : "text-accent"}`}>
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
            className="absolute top-0 right-0 w-5 h-5 bg-fg text-canvas rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:scale-110 z-10"
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
          <div className="w-px h-5 bg-line" />

          {/* Children — wrap 가능한 행. 팀이 커도 가로 스크롤 없이 여러 줄로 흐른다.
              단일-행 T-커넥터 대신 자식마다 짧은 세로 스텁을 둬 wrap에서도 안 깨진다. */}
          <div className="flex flex-wrap items-start justify-center gap-x-2 max-w-full">
            {children.map((child) => (
              <div key={child.id} className="flex flex-col items-center">
                <div className="w-px h-5 bg-line" />
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
        className="bg-surface border border-line rounded-xl shadow-xl w-[400px] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <AgentAvatar name={agent.name} role={agent.role} size="sm" />
          <div>
            <p className="text-sm font-medium text-fg">{agent.name}</p>
            <p className="text-[10px] text-faint capitalize">{agent.role}</p>
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
          className="w-full text-xs text-muted bg-sunken rounded-lg px-3 py-2 border border-line focus:outline-none focus:border-accent resize-none"
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] text-faint">Cmd+Enter</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1 text-xs text-muted hover:text-fg transition-colors"
            >
              {t("cancel")}
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !message.trim()}
              className="px-3 py-1 text-xs font-medium bg-fg text-canvas rounded-lg hover:bg-fg/90 disabled:opacity-40 transition-colors"
            >
              {sending ? t("promptRunning") : t("sendPrompt")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OrgChart({ agents, tasks, onAddAgent, onAgentDeleted, onAgentKilled, onDuplicateTeam }: OrgChartProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
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
  const detailAgent = agents.find((a) => a.id === detailAgentId) ?? null;

  // 팀 그룹핑 — cto(조정자)는 상단 단일, 나머지 워커는 name suffix 팀별로 묶는다.
  // 계층(parent_id)은 기능용(decompose 후보=ctoChildren)으로 유지하되, 조직도는
  // 팀 단위 박스로 표시해 1팀/2팀을 명확히 구분한다.
  const teamData = useMemo(() => {
    const cto = agents.find((a) => a.role === "cto") ?? null;
    const workers = agents.filter((a) => a.id !== cto?.id);
    const groups = new Map<string, Agent[]>();
    for (const a of workers) {
      const label = teamOf(a.name);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(a);
    }
    const teams = [...groups.entries()].sort(([a], [b]) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      if (!isNaN(na)) return -1;
      if (!isNaN(nb)) return 1;
      return a.localeCompare(b);
    });
    return { cto, teams };
  }, [agents]);

  const handleKill = () => {
    onAgentKilled();
    setDetailAgentId(null);
    setSelectedId(null);
  };
  const handleDeleted = () => {
    onAgentDeleted();
    setDetailAgentId(null);
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
          <p className="text-sm font-medium text-muted mb-1">
            {t("noAgentsOrgChart")}
          </p>
          <p className="text-xs text-faint mb-4 max-w-xs">
            {t("noAgentsOrgChartDesc")}
          </p>
          <button
            onClick={onAddAgent}
            className="text-xs px-4 py-2 bg-fg text-canvas rounded-lg hover:bg-fg/90 transition-colors font-medium mb-3"
          >
            {t("addAgent")}
          </button>
          <button
            onClick={() => setShowWorkflowGuide(true)}
            className="text-xs text-accent hover:underline"
          >
            {t("learnWorkflow")}
          </button>
        </div>
      </>
    );
  }

  const workingCount = agents.filter((a) => a.status === "working").length;
  const idleCount = agents.length - workingCount;

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
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-fg text-canvas text-xs font-medium rounded-lg shadow-lg animate-fade-in">
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

      {/* AgentDetail slide-over — 우측 패널의 "상세 열기"로 연다 (선택과 분리) */}
      {detailAgent && (
        <AgentDetail
          agent={detailAgent}
          agents={agents}
          tasks={tasks}
          onClose={() => setDetailAgentId(null)}
          onKill={handleKill}
          onDeleted={handleDeleted}
        />
      )}

      <div className="flex gap-6 items-start">
        {/* Org tree — left panel */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-6 gap-3">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <h2 className="text-sm font-semibold text-muted shrink-0">
                {t("orgChartTitle")}
              </h2>
              <span className="text-[11px] text-faint shrink-0">
                {t("agentCount", { count: agents.length })}
              </span>
              {/* 상태 요약 배지 — 한눈에 무엇이 실행 중인지 */}
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-success-subtle text-success font-medium shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                {t("statusWorking")} {workingCount}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-sunken text-muted shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-faint" />
                {t("statusIdle")} {idleCount}
              </span>
              <button
                onClick={() => setShowWorkflowGuide(true)}
                title={t("learnWorkflow")}
                className="w-5 h-5 rounded-full border border-line text-faint hover:border-accent hover:text-accent flex items-center justify-center transition-colors text-[10px] font-bold shrink-0"
              >
                ?
              </button>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {onDuplicateTeam && (
                <button
                  onClick={onDuplicateTeam}
                  title={t("duplicateTeamTip")}
                  className="text-xs px-3 py-1.5 border border-line text-muted rounded-lg hover:border-accent hover:text-accent transition-colors font-medium"
                >
                  {t("duplicateTeam")}
                </button>
              )}
              <button
                onClick={onAddAgent}
                className="text-xs px-3 py-1.5 bg-fg text-canvas rounded-lg hover:bg-fg/90 transition-colors font-medium"
              >
                {t("addAgent")}
              </button>
              {/* ··· 관리 메뉴 — 파괴적 행동(전체 삭제)은 주 버튼과 분리 */}
              <div className="relative">
                <button
                  onClick={() => setShowMenu((v) => !v)}
                  title={t("orgManage")}
                  className="w-8 h-8 flex items-center justify-center rounded-lg border border-line text-muted hover:bg-fg/5 transition-colors text-base leading-none"
                >
                  ⋯
                </button>
                {showMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                    <div className="absolute right-0 mt-1 w-52 z-50 bg-surface border border-line rounded-lg shadow-lg py-1">
                      <button
                        onClick={() => { setShowMenu(false); setShowDeleteAllConfirm(true); }}
                        className="w-full text-left px-3 py-2 text-xs text-danger hover:bg-danger-subtle transition-colors"
                      >
                        {t("orgDeleteAllScoped", { count: agents.length })}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Team-grouped org — cto 상단, 팀별 박스. 가로 스크롤 없이 팀이 wrap된다.
              카드는 기존 OrgNode를 리프(childrenMap={{}})로 재사용. */}
          <div className="pb-4 flex flex-col items-center">
            {teamData.cto && (
              <>
                <OrgNode
                  agent={teamData.cto}
                  agents={agents}
                  childrenMap={{}}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onQuickPrompt={setQuickPromptAgent}
                  onDrop={handleDrop}
                  dragOverId={dragOverId}
                  onDragOverChange={setDragOverId}
                  depth={0}
                  isLast={true}
                />
                {teamData.teams.length > 0 && <div className="w-px h-6 bg-line" />}
              </>
            )}
            <div className="flex flex-wrap gap-4 items-start justify-center w-full">
              {teamData.teams.map(([label, members]) => (
                <div
                  key={label}
                  className="border border-line rounded-2xl p-3 bg-fg/5"
                >
                  <div className="text-[11px] font-semibold text-muted mb-2 px-1">
                    {label} <span className="text-faint font-normal">· {members.length}</span>
                  </div>
                  <div className="flex flex-wrap gap-2 items-start justify-start max-w-[620px]">
                    {members.map((m) => (
                      <OrgNode
                        key={m.id}
                        agent={m}
                        agents={agents}
                        childrenMap={{}}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        onQuickPrompt={setQuickPromptAgent}
                        onDrop={handleDrop}
                        dragOverId={dragOverId}
                        onDragOverChange={setDragOverId}
                        depth={1}
                        isLast={true}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 우측 상세 패널 — 상시 표시. 카드 선택 시 요약 갱신, "상세 열기"로 전체 슬라이드오버. */}
        <div className="w-[220px] shrink-0 hidden lg:block">
          <div className="border border-line rounded-xl p-4 bg-fg/5">
            <p className="text-xs font-semibold text-muted mb-3">{t("orgDetailTitle")}</p>
            {selectedAgent ? (() => {
              const tok = tasks
                .filter((tk: any) => tk.assignee_id === selectedAgent.id)
                .reduce((s: number, tk: any) => s + (tk.token_usage ?? 0), 0);
              const working = selectedAgent.status === "working";
              const activity = (selectedAgent as any).current_activity;
              return (
                <>
                  <div className="flex items-start gap-2 mb-3">
                    <AgentAvatar name={selectedAgent.name} role={selectedAgent.role} size="sm" showBadge={true} />
                    <div className="min-w-0">
                      <p className="text-[9px] uppercase tracking-wide text-faint truncate">{selectedAgent.role}</p>
                      <p className="text-xs font-semibold text-fg leading-tight break-words">{selectedAgent.name}</p>
                    </div>
                  </div>
                  <div className="space-y-1.5 text-[11px]">
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full ${working ? "text-success bg-success-subtle font-semibold" : "text-muted bg-sunken"}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${working ? "bg-success animate-pulse" : "bg-faint"}`} />
                      {working ? t("statusWorking") : t("statusIdle")}
                    </span>
                    {working && activity && (
                      <p className="text-accent line-clamp-2 leading-snug">{parseActivity(activity, t)}</p>
                    )}
                    {tok > 0 && (
                      <p className="text-muted">{t("orgAgentTokens", { tokens: tok.toLocaleString() })}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setDetailAgentId(selectedAgent.id)}
                    className="mt-3 w-full text-[11px] px-2 py-1.5 bg-fg text-canvas rounded-lg hover:bg-fg/90 transition-colors font-medium"
                  >
                    {t("orgOpenDetail")}
                  </button>
                </>
              );
            })() : (
              <>
                <p className="text-[11px] text-muted leading-relaxed">{t("orgChartHint")}</p>
                <ul className="mt-3 space-y-1 text-[10px] text-muted">
                  <li>{t("orgDetailEx1")}</li>
                  <li>{t("orgDetailEx2")}</li>
                  <li>{t("orgDetailEx3")}</li>
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
