import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { LiveActivity } from "./LiveActivity";

const STATUSES = ["pending_approval", "todo", "in_progress", "in_review", "done", "blocked"];

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending_approval: "statusPendingApproval",
  todo: "statusTodo",
  in_progress: "statusInProgress",
  in_review: "statusInReview",
  done: "statusDone",
  blocked: "statusBlocked",
};

// 헤더 상태 칩 — status 값과 동기화되는 컬러 배지
const STATUS_CHIP_CLASS: Record<string, string> = {
  pending_approval: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  todo: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  in_review: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  done: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  blocked: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

interface Task {
  id: string;
  title: string;
  description?: string;
  status: string;
  project_id?: string;
  assignee_id: string | null;
  verification_id: string | null;
  target_files?: string | null; // JSON array string
  stack_hint?: string | null;
  result_summary?: string | null;
}

interface Agent {
  id: string;
  name: string;
}

interface Verification {
  id: string;
  verdict: string;
  scope: string;
  severity: string;
  dimensions: Record<string, { value: number; notes: string }>;
  issues: Array<{
    severity: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  }>;
  created_at: string;
}

interface TaskDetailProps {
  task: Task;
  agents: Agent[];
  onClose: () => void;
  onUpdate?: () => void;
}

export function TaskDetail({ task, agents, onClose, onUpdate }: TaskDetailProps) {
  const { t } = useTranslation();
  const [verification, setVerification] = useState<Verification | null>(null);
  const [status, setStatus] = useState(task.status);
  const [assigneeId, setAssigneeId] = useState<string>(task.assignee_id ?? "");
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Load verification data if task has one
  useEffect(() => {
    if (task.verification_id) {
      api.verifications.listByTask(task.id).then((list) => {
        if (list.length > 0) setVerification(list[0]);
      });
    }
  }, [task.id, task.verification_id]);

  // 검토 중엔 실제로 일하는 건 담당자가 아니라 검토자(Evaluator) 세션이다 —
  // 담당자 링만 보여주면 "N분째 활동 없음"으로 멈춘 듯 보인다. 이 태스크를
  // 잡고 있는 다른 에이전트의 active 세션을 찾아 라이브 페인을 전환한다.
  const [reviewer, setReviewer] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!(status === "in_progress" || status === "in_review")) {
      setReviewer(null);
      return;
    }
    let alive = true;
    const probe = () => {
      api.sessions
        .list({ status: "active", ...(task.project_id ? { projectId: task.project_id } : {}) })
        .then((list) => {
          if (!alive) return;
          const rev = (list as Array<{ agent_id: string; agent_name: string; current_task_id?: string | null }>).find(
            (s) => s.current_task_id === task.id && s.agent_id && s.agent_id !== assigneeId,
          );
          setReviewer(rev ? { id: rev.agent_id, name: rev.agent_name } : null);
        })
        .catch(() => { /* sessions unavailable — keep assignee feed */ });
    };
    probe();
    const timer = setInterval(probe, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [status, task.id, task.project_id, assigneeId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const handleStatusChange = async (newStatus: string) => {
    setStatus(newStatus);
    await api.tasks.update(task.id, { status: newStatus });
    onUpdate?.();
  };

  const handleAssigneeChange = async (newAgentId: string) => {
    setAssigneeId(newAgentId);
    await api.tasks.update(task.id, { assignee_id: newAgentId || null });
    onUpdate?.();
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      if (task.project_id) {
        await api.orchestration.approveTask(task.project_id, task.id);
      } else {
        await api.tasks.approve(task.id);
      }
      onUpdate?.();
      onClose();
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    setRejecting(true);
    try {
      if (task.project_id) {
        await api.orchestration.rejectTask(task.project_id, task.id, rejectReason || undefined);
      } else {
        await api.tasks.reject(task.id, rejectReason || undefined);
      }
      onUpdate?.();
      onClose();
    } finally {
      setRejecting(false);
    }
  };

  const VERDICT_COLORS: Record<string, string> = {
    pass: "bg-green-100 text-green-700",
    conditional: "bg-yellow-100 text-yellow-700",
    fail: "bg-red-100 text-red-700",
  };

  // 실행 중이면 좌(정보)/우(터미널) 분할 — 터미널이 상시 보이도록.
  // 검토자 세션이 있으면 그 에이전트의 활동을 보여준다 (없으면 담당자).
  const showLive = (status === "in_progress" || status === "in_review") && (!!assigneeId || !!reviewer);
  const liveAgentId = reviewer?.id ?? assigneeId;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      {/* 라이브 페인이 있으면 뷰포트를 최대로 사용 (여백 24px), 정보만 있으면 컴팩트 유지 */}
      <div className={`relative w-full mx-4 bg-white dark:bg-[#1e1e2e] rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden ${showLive ? "max-w-6xl h-[80vh] flex flex-col" : "max-w-3xl"}`}>
        {/* Header — 태스크 제목 + 상태 칩 (본문 제목 중복 제거, 밀도 향상) */}
        <div className="shrink-0 flex items-center gap-3 px-5 py-3.5 border-b border-gray-200 dark:border-gray-700">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-0.5">
              {t("taskDetail")}
            </p>
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                {task.title}
              </h2>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${STATUS_CHIP_CLASS[status] ?? "bg-gray-100 text-gray-600"}`}
              >
                {t(STATUS_LABEL_KEYS[status] ?? status)}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t("closeDetail")}
          </button>
        </div>

        {/* Body — showLive 시 좌(정보 스크롤)/우(터미널 고정) 2단, 모달 잔여 높이 전부 사용 */}
        <div className={showLive ? "flex flex-col md:flex-row flex-1 min-h-0" : ""}>
        <div className={`px-5 py-4 space-y-4 overflow-y-auto ${showLive ? "flex-1 min-w-0 max-h-[40vh] md:max-h-none" : "max-h-[82vh]"}`}>
          {/* Description — 제목은 헤더로 이동 */}
          {task.description && (
            <div className="text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-[#1a1a2e] rounded-lg p-4 whitespace-pre-wrap leading-relaxed border border-gray-100 dark:border-gray-700">
              {task.description}
            </div>
          )}

          {/* 마무리 요약 — 에이전트가 남긴 작업 결과 (완료 시) */}
          {task.result_summary && task.result_summary.trim() && (
            <div>
              <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                {t("taskWrapUpLabel")}
              </span>
              <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                {task.result_summary}
              </p>
            </div>
          )}

          {/* Scope anchor — target files + stack hint (P2) */}
          {(() => {
            let targets: string[] = [];
            try { targets = JSON.parse(task.target_files || "[]"); } catch { /* ignore */ }
            const hint = (task.stack_hint || "").trim();
            if (targets.length === 0 && !hint) return null;
            return (
              <div className="border border-blue-100 dark:border-blue-900/40 bg-blue-50/50 dark:bg-blue-900/10 rounded-lg p-3">
                <h4 className="text-[10px] uppercase tracking-wider text-blue-700 dark:text-blue-400 font-semibold mb-2">
                  {t("scopeAnchorTitle")}
                </h4>
                {targets.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-1">{t("scopeTargetFiles")}</p>
                    <ul className="space-y-0.5">
                      {targets.map((f, i) => (
                        <li key={i} className="text-xs font-mono text-gray-700 dark:text-gray-300">
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {hint && (
                  <div>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-1">{t("scopeStackHint")}</p>
                    <p className="text-xs text-gray-700 dark:text-gray-300">{hint}</p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Status + Agent row */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-400">{t("taskStatus")}:</span>
              <select
                aria-label={t("taskStatus")}
                value={status}
                onChange={(e) => handleStatusChange(e.target.value)}
                className="text-xs text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(STATUS_LABEL_KEYS[s])}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-400">{t("assign")}:</span>
              <select
                aria-label={t("assign")}
                value={assigneeId}
                onChange={(e) => handleAssigneeChange(e.target.value)}
                className="text-xs text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="">— {t("promptAssignAgent")} —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Approval Gate — pending_approval 상태일 때만 표시 */}
          {task.status === "pending_approval" && (
            <div className="border border-amber-200 dark:border-amber-800 rounded-lg p-4 bg-amber-50 dark:bg-amber-900/20 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                  {t("approvalRequired")}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleApprove}
                  disabled={approving || rejecting}
                  className="flex-1 px-3 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {approving ? t("approving") : t("approve")}
                </button>
                <button
                  onClick={() => setShowRejectInput((v) => !v)}
                  disabled={approving || rejecting}
                  className="flex-1 px-3 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t("reject")}
                </button>
              </div>
              {showRejectInput && (
                <div className="space-y-2">
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder={t("rejectFeedbackPlaceholder")}
                    rows={3}
                    className="w-full text-sm px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-red-400 resize-none"
                  />
                  <button
                    onClick={handleReject}
                    disabled={rejecting || approving}
                    className="w-full px-3 py-1.5 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {rejecting ? t("rejecting") : t("rejectConfirm")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Verification results */}
          {!verification && (
            <div className="border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-4 text-center">
              <p className="text-xs text-gray-400 dark:text-gray-500">{t("noVerification")}</p>
            </div>
          )}
          {verification && (
            <div className="border border-gray-100 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800/50 space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${VERDICT_COLORS[verification.verdict] ?? "bg-gray-100 text-gray-600"}`}
                >
                  {verification.verdict === "pass"
                    ? t("verdictPass")
                    : verification.verdict === "conditional"
                      ? t("verdictConditional")
                      : t("verdictFail")}
                </span>
                <span className="text-xs text-gray-400">{verification.scope}</span>
                <span className="text-xs text-gray-300 dark:text-gray-600 ml-auto">
                  {new Date(verification.created_at).toLocaleString()}
                </span>
              </div>

              {/* Issues list — shows WHY the verification failed */}
              {verification.issues && verification.issues.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-gray-400 uppercase mb-1.5">
                    {t("issues")} ({verification.issues.length})
                  </p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {verification.issues.map((issue, i) => (
                      <div
                        key={i}
                        className={`text-xs p-2 rounded border-l-2 ${
                          issue.severity === "critical"
                            ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                            : issue.severity === "high"
                              ? "border-orange-400 bg-orange-50 dark:bg-orange-900/20"
                              : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700/50"
                        }`}
                      >
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`text-[10px] font-medium uppercase ${
                            issue.severity === "critical" ? "text-red-600 dark:text-red-400"
                              : issue.severity === "high" ? "text-orange-600 dark:text-orange-400"
                              : "text-gray-500"
                          }`}>
                            {issue.severity}
                          </span>
                          {issue.file && (
                            <span className="text-[10px] text-gray-400 font-mono">
                              {issue.file}{issue.line ? `:${issue.line}` : ""}
                            </span>
                          )}
                        </div>
                        <p className="text-gray-700 dark:text-gray-300">{issue.message}</p>
                        {issue.suggestion && (
                          <p className="text-gray-400 dark:text-gray-500 mt-0.5 italic">{issue.suggestion}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {/* 우측 터미널 페인 — 실행 중일 때만. key=agentId → 대상 에이전트 변경 시 리마운트 */}
        {showLive && (
          <div className="md:w-1/2 shrink-0 border-t md:border-t-0 md:border-l border-gray-200 dark:border-gray-700 p-3 flex min-h-[40vh] md:min-h-0">
            <LiveActivity
              key={liveAgentId}
              agentId={liveAgentId}
              contextLabel={reviewer ? t("liveActorReviewer", { name: reviewer.name }) : undefined}
            />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

