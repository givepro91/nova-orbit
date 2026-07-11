import { useTranslation } from "react-i18next";
import { ChatThread } from "./ChatThread";
import { ChatComposer } from "./ChatComposer";
import { InspectorTabs } from "./InspectorTabs";

/**
 * 풀 2-pane 워크스페이스 — 좌 대화(ChatThread+Composer, Phase 1·2 재사용) / 우 인스펙터(4탭).
 * 기존 TaskDetail 풀스크린 모달 관례(fixed inset-0 z-50, flex md:flex-row)를 따른다.
 */
export function SessionWorkspace({
  agentId,
  agentName,
  goalId,
  taskId,
  onClose,
}: {
  agentId: string;
  agentName?: string;
  goalId: string | null;
  taskId?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-bold text-gray-800 dark:text-gray-100 truncate">⤢ {agentName ?? t("wsTitle")}</span>
            <span className="text-xs text-gray-400 shrink-0">{t("wsSubtitle")}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("crewdeck:open-help"))}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm font-bold leading-none px-1"
              title={t("helpTitle")}
              aria-label={t("helpTitle")}
            >
              ?
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none"
              aria-label={t("close")}
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          <div className="flex flex-col md:w-1/2 md:border-r border-gray-100 dark:border-gray-700 min-h-0">
            <ChatThread agentId={agentId} />
            <ChatComposer agentId={agentId} taskId={taskId} />
          </div>
          <div className="md:w-1/2 min-h-0 flex flex-col">
            <InspectorTabs goalId={goalId} agentId={agentId} />
          </div>
        </div>
      </div>
    </div>
  );
}
