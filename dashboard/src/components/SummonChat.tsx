import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "./AgentAvatar";
import { ChatThread } from "./ChatThread";
import { ChatComposer } from "./ChatComposer";

interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface SummonChatProps {
  agent: Agent;
  /** 소환된 태스크 — 있으면 작업 공간·판정·최근 출력이 주입된다. 일반 대화면 null. */
  taskId?: string | null;
  /** 워크스페이스(⤢) 진입 스코프 */
  goalId?: string | null;
  onClose: () => void;
  /** ⚙ — 관리(설정) 패널로 전환 */
  onOpenSettings: () => void;
  /** ↻ 다시 해결 — 소환된 fail 태스크(taskId)가 있을 때만. 정규 rework(재실행+자동 재검증)로 넘겨 실제 해결로 닫는다. */
  onRework?: () => void;
}

// 소환 = "대화로 손보기" 전용 중앙 모달. 에이전트 관리(모델·조직·삭제 등)는
// 여기 없고 ⚙로 분리(AgentDetail). 대화 스레드/입력은 기존 컴포넌트를 그대로 재사용한다.
export function SummonChat({ agent, taskId, goalId, onClose, onOpenSettings, onRework }: SummonChatProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);

  // Esc 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop — 실수 이탈로 대화가 유실되지 않도록 바깥 클릭으로는 닫지 않는다(×·Esc로만). */}
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50 z-40" />

      {/* Centered modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={cardRef}
          className="pointer-events-auto w-full max-w-2xl h-[80vh] max-h-[720px] bg-surface rounded-2xl border border-line shadow-2xl flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-5 py-3.5 border-b border-line shrink-0">
            <AgentAvatar name={agent.name} role={agent.role} size="lg" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-fg truncate">{agent.name}</h2>
              <p className="text-xs text-faint capitalize">{agent.role}</p>
            </div>
            {taskId && onRework && (
              <button
                onClick={onRework}
                title={t("reworkTitle")}
                className="shrink-0 px-2.5 py-1 text-xs font-medium text-on-accent bg-accent hover:bg-accent-hover rounded-lg transition-colors"
              >
                ↻ {t("reworkButton")}
              </button>
            )}
            <button
              onClick={onOpenSettings}
              title={t("agentSettings")}
              aria-label={t("agentSettings")}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-fg/5 text-faint transition-colors text-base"
            >
              ⚙
            </button>
            <button
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("crewdeck:open-workspace", {
                    detail: { agentId: agent.id, agentName: agent.name, goalId: goalId ?? null, taskId: taskId ?? null },
                  })
                )
              }
              title={t("wsOpen")}
              aria-label={t("wsOpen")}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-fg/5 text-faint transition-colors text-base"
            >
              ⤢
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-fg/5 text-faint transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* 대화 스레드(주입 칩·되돌리기 sticky 포함) + 입력 */}
          <ChatThread agentId={agent.id} />
          <ChatComposer agentId={agent.id} disabled={agent.status === "working"} taskId={taskId} />
        </div>
      </div>
    </>
  );
}
