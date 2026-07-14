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
  pending_approval: "bg-warning-subtle text-warning",
  todo: "bg-sunken text-muted",
  in_progress: "bg-accent/10 text-accent",
  in_review: "bg-review-subtle text-review",
  done: "bg-success-subtle text-success",
  blocked: "bg-danger-subtle text-danger",
};

type ProviderName = "claude" | "codex";
type ProviderResolutionSource = "agent" | "project" | "global";

// 서버 serializeTask가 붙여주는 provider 해석 + failover 관측 트레이스 (shared/types ProviderTrace).
// 스토어 Task 타입엔 선언돼 있지 않으므로 옵셔널로 받고 런타임에 방어적으로 읽는다.
interface ProviderFailoverTrace {
  reasonCode: "rate_limit" | "session_exhausted" | "env_error" | null;
  userMessage: string | null;
  fromProvider: ProviderName | null;
  toProvider: ProviderName | null;
  redispatched: boolean;
  loopGuardBlocked: boolean;
  originalSessionId: string | null;
  redispatchedSessionId: string | null;
}

interface ProviderTrace {
  resolvedProvider: ProviderName | null;
  resolutionSource: ProviderResolutionSource | null;
  failover?: ProviderFailoverTrace;
}

const PROVIDER_SOURCE_LABEL_KEYS: Record<ProviderResolutionSource, string> = {
  agent: "providerSourceAgent",
  project: "providerSourceProject",
  global: "providerSourceGlobal",
};

function providerEngineName(p: ProviderName | null): string {
  return p === "claude" ? "Claude" : p === "codex" ? "Codex" : "—";
}

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
  providerTrace?: ProviderTrace;
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
    pass: "bg-success-subtle text-success",
    conditional: "bg-warning-subtle text-warning",
    fail: "bg-danger-subtle text-danger",
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
      <div className={`relative w-full mx-4 bg-surface rounded-xl shadow-2xl border border-line overflow-hidden ${showLive ? "max-w-6xl h-[80vh] flex flex-col" : "max-w-3xl"}`}>
        {/* Header — 태스크 제목 + 상태 칩 (본문 제목 중복 제거, 밀도 향상) */}
        <div className="shrink-0 flex items-center gap-3 px-5 py-3.5 border-b border-line">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wider text-faint mb-0.5">
              {t("taskDetail")}
            </p>
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-sm font-semibold text-fg truncate">
                {task.title}
              </h2>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${STATUS_CHIP_CLASS[status] ?? "bg-sunken text-muted"}`}
              >
                {t(STATUS_LABEL_KEYS[status] ?? status)}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-xs text-faint hover:text-muted px-2 py-1 rounded hover:bg-fg/5"
          >
            {t("closeDetail")}
          </button>
        </div>

        {/* Body — showLive 시 좌(정보 스크롤)/우(터미널 고정) 2단, 모달 잔여 높이 전부 사용 */}
        <div className={showLive ? "flex flex-col md:flex-row flex-1 min-h-0" : ""}>
        <div className={`px-5 py-4 space-y-4 overflow-y-auto ${showLive ? "flex-1 min-w-0 max-h-[40vh] md:max-h-none" : "max-h-[82vh]"}`}>
          {/* Description — 제목은 헤더로 이동 */}
          {task.description && (
            <div className="text-sm text-muted bg-sunken rounded-lg p-4 whitespace-pre-wrap leading-relaxed border border-line-soft">
              {task.description}
            </div>
          )}

          {/* 마무리 요약 — 에이전트가 남긴 작업 결과 (완료 시) */}
          {task.result_summary && task.result_summary.trim() && (
            <div>
              <span className="text-[11px] font-medium text-faint uppercase tracking-wider block mb-1">
                {t("taskWrapUpLabel")}
              </span>
              <p className="text-sm text-muted whitespace-pre-wrap leading-relaxed">
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
              <div className="border border-accent/25 bg-accent/10 rounded-lg p-3">
                <h4 className="text-[10px] uppercase tracking-wider text-accent font-semibold mb-2">
                  {t("scopeAnchorTitle")}
                </h4>
                {targets.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[10px] text-muted mb-1">{t("scopeTargetFiles")}</p>
                    <ul className="space-y-0.5">
                      {targets.map((f, i) => (
                        <li key={i} className="text-xs font-mono text-muted">
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {hint && (
                  <div>
                    <p className="text-[10px] text-muted mb-1">{t("scopeStackHint")}</p>
                    <p className="text-xs text-muted">{hint}</p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Status + Agent row */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-faint">{t("taskStatus")}:</span>
              <select
                aria-label={t("taskStatus")}
                value={status}
                onChange={(e) => handleStatusChange(e.target.value)}
                className="text-xs text-muted bg-surface border border-line rounded px-2 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(STATUS_LABEL_KEYS[s])}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-xs text-faint">{t("assign")}:</span>
              <select
                aria-label={t("assign")}
                value={assigneeId}
                onChange={(e) => handleAssigneeChange(e.target.value)}
                className="text-xs text-muted bg-surface border border-line rounded px-2 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">— {t("promptAssignAgent")} —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>

            {task.providerTrace?.resolvedProvider && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-faint">{t("providerTraceTitle")}:</span>
                <span className="text-xs text-muted">
                  {providerEngineName(task.providerTrace.resolvedProvider)}
                </span>
                {task.providerTrace.resolutionSource && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sunken text-muted">
                    {t(PROVIDER_SOURCE_LABEL_KEYS[task.providerTrace.resolutionSource])}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Provider failover trace — 실행 엔진 자동 전환 관측 (사유·전/후 엔진·세션 링크) */}
          {(() => {
            const fo = task.providerTrace?.failover;
            if (!fo || (!fo.redispatched && !fo.loopGuardBlocked && !fo.reasonCode)) return null;
            const REASON_KEYS: Record<string, string> = {
              rate_limit: "failoverReasonRateLimit",
              session_exhausted: "failoverReasonSessionExhausted",
              env_error: "failoverReasonEnvError",
            };
            return (
              <div className="border border-warning/25 bg-warning-subtle rounded-lg p-3">
                <h4 className="text-[10px] uppercase tracking-wider text-warning font-semibold mb-2">
                  {t("failoverTraceTitle")}
                </h4>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-muted">
                    {providerEngineName(fo.fromProvider)} → {providerEngineName(fo.toProvider)}
                  </span>
                  {fo.reasonCode && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning-subtle text-warning">
                      {t(REASON_KEYS[fo.reasonCode] ?? fo.reasonCode)}
                    </span>
                  )}
                  {fo.loopGuardBlocked && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sunken text-muted">
                      {t("failoverLoopGuardBlocked")}
                    </span>
                  )}
                </div>
                {fo.userMessage && (
                  <p className="text-xs text-muted mb-2 leading-relaxed">{fo.userMessage}</p>
                )}
                <dl className="space-y-1.5">
                  <div>
                    <dt className="text-[10px] text-muted mb-0.5">{t("failoverOriginalSession")}</dt>
                    <dd className="text-[10px] font-mono text-muted break-all">
                      {fo.originalSessionId ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-muted mb-0.5">{t("failoverRedispatchedSession")}</dt>
                    <dd className="text-[10px] font-mono text-muted break-all">
                      {fo.redispatchedSessionId ?? "—"}
                    </dd>
                  </div>
                </dl>
              </div>
            );
          })()}

          {/* Approval Gate — pending_approval 상태일 때만 표시 */}
          {task.status === "pending_approval" && (
            <div className="border border-warning rounded-lg p-4 bg-warning-subtle space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-warning uppercase tracking-wide">
                  {t("approvalRequired")}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleApprove}
                  disabled={approving || rejecting}
                  className="flex-1 px-3 py-2 text-sm font-medium bg-success text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {approving ? t("approving") : t("approve")}
                </button>
                <button
                  onClick={() => setShowRejectInput((v) => !v)}
                  disabled={approving || rejecting}
                  className="flex-1 px-3 py-2 text-sm font-medium bg-danger text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
                    className="w-full text-sm px-3 py-2 border border-line rounded-lg bg-surface text-muted focus:outline-none focus:ring-2 focus:ring-danger resize-none"
                  />
                  <button
                    onClick={handleReject}
                    disabled={rejecting || approving}
                    className="w-full px-3 py-1.5 text-sm font-medium bg-danger text-white rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {rejecting ? t("rejecting") : t("rejectConfirm")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Verification results */}
          {!verification && (
            <div className="border border-dashed border-line rounded-lg p-4 text-center">
              <p className="text-xs text-faint">{t("noVerification")}</p>
            </div>
          )}
          {verification && (
            <div className="border border-line-soft rounded-lg p-3 bg-sunken space-y-3">
              <div className="flex items-center gap-2">
                {(() => {
                  // done + fail = 미해결 이슈를 최종 QA로 이월(호박색). blocked 등은 실제 실패(빨강).
                  const isCarried = status === "done" && verification.verdict === "fail";
                  const cls = isCarried
                    ? "bg-warning-subtle text-warning"
                    : (VERDICT_COLORS[verification.verdict] ?? "bg-sunken text-muted");
                  return (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}
                      title={isCarried ? t("carriedClickDetail") : ""}
                    >
                      {isCarried
                        ? t("verdictCarried")
                        : verification.verdict === "pass"
                          ? t("verdictPass")
                          : verification.verdict === "conditional"
                            ? t("verdictConditional")
                            : t("verdictFail")}
                    </span>
                  );
                })()}
                <span className="text-xs text-faint">{verification.scope}</span>
                <span className="text-xs text-faint ml-auto">
                  {new Date(verification.created_at).toLocaleString()}
                </span>
              </div>

              {/* Issues list — shows WHY the verification failed */}
              {verification.issues && verification.issues.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-faint uppercase mb-1.5">
                    {t("issues")} ({verification.issues.length})
                  </p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {verification.issues.map((issue, i) => (
                      <div
                        key={i}
                        className={`text-xs p-2 rounded border-l-2 ${
                          issue.severity === "critical"
                            ? "border-danger bg-danger-subtle"
                            : issue.severity === "high"
                              ? "border-warning bg-warning-subtle"
                              : "border-line bg-surface"
                        }`}
                      >
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`text-[10px] font-medium uppercase ${
                            issue.severity === "critical" ? "text-danger"
                              : issue.severity === "high" ? "text-warning"
                              : "text-muted"
                          }`}>
                            {issue.severity}
                          </span>
                          {issue.file && (
                            <span className="text-[10px] text-faint font-mono">
                              {issue.file}{issue.line ? `:${issue.line}` : ""}
                            </span>
                          )}
                        </div>
                        <p className="text-muted">{issue.message}</p>
                        {issue.suggestion && (
                          <p className="text-faint mt-0.5 italic">{issue.suggestion}</p>
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
          <div className="md:w-1/2 shrink-0 border-t md:border-t-0 md:border-l border-line p-3 flex min-h-[40vh] md:min-h-0">
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

